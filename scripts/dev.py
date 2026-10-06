#!/usr/bin/env python3
"""Owned broker plus native Rust/web processes; interrupt to stop this run safely."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import kafka
from demo_config import ROOT, TOPICS, prepare
from seed import record
from control import Producer, serve


def broker(command, run_name, *args):
    subprocess.run([sys.executable, str(ROOT / 'scripts/kafka.py'), command, '--run', run_name, *args], check=True)


def stop(child):
    if child.poll() is not None:
        return
    # Every child receives its own process group. Never search/kill global processes.
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()


def main():
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=kafka.valid_run, default='dev')
    parser.add_argument('--kafka-port', type=int, default=19092)
    parser.add_argument('--control-port', type=int, default=3012)
    parser.add_argument('--rows', type=int, default=200000, help='initial identities per topic (default 200000)')
    parser.add_argument('--no-seed', action='store_true')
    parser.add_argument('--no-build', action='store_true')
    parser.add_argument('--no-web', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.rows <= 200000:
        parser.error('rows must be in 1..200000')
    if not args.no_build:
        subprocess.run([sys.executable, str(ROOT / 'scripts/rust.py'), 'build', '--locked', '--release',
                        '-p', 'view-server-app', '-p', 'product-source-ingestion', '--features', 'kafka-canonical',
                        '--bin', 'view_server', '--example', 'seed_producer'], check=True)
    broker('preflight', args.run)
    if not kafka.state_path(args.run).exists():
        broker('init', args.run, '--port', str(args.kafka_port))
    config_path, token, state = prepare(args.run)
    run_lock = (config_path.parent / 'dev.lock').open('a')
    try:
        fcntl.flock(run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('This run already has a native dev orchestrator; select a new run')
    seed_marker = config_path.parent / 'initial-seed.json'
    if not args.no_seed and seed_marker.exists():
        acknowledged = json.loads(seed_marker.read_text())['producerAcknowledgedDistinctIdentities']
        if any(acknowledged.get(topic) != args.rows for topic in TOPICS):
            raise RuntimeError('Existing initial seed size differs; use a fresh run for the requested dataset size')
    children = []
    producer = None
    control = None
    handles = []
    try:
        broker('up', args.run)
        result = kafka.compose(state, 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-topics.sh',
                               '--bootstrap-server', 'kafka:9092', '--list', capture_output=True)
        existing = set(result.stdout.splitlines())
        for topic in TOPICS:
            for name in (topic, topic + '-state'):
                if name not in existing:
                    broker('topic-create', args.run, '--topic', name, '--cleanup-policy', 'compact')
        stamp = time.time_ns()
        native_log = (config_path.parent / f'native-{stamp}.log').open('w')
        handles.append(native_log)
        service = subprocess.Popen([str(ROOT / 'target/release/view_server'), str(config_path)],
                                   env={**os.environ, 'V12_SESSION_TOKEN': token},
                                   stdout=native_log, stderr=subprocess.STDOUT, start_new_session=True)
        children.append(service)
        producer = Producer(config_path, config_path.parent)
        if seed_marker.exists() and not (config_path.parent / 'producer-receipts.ndjson').stat().st_size:
            raise RuntimeError('This historical demo seed has no editable receipt journal; select a fresh run')
        control = serve(producer, port=args.control_port, origin='http://127.0.0.1:3000', token=token, run=args.run)
        if not args.no_web:
            catalog = json.loads(config_path.read_text())['catalog']
            web_env = {**os.environ, 'VITE_RVS_URL': 'ws://127.0.0.1:3010/v15',
                       'VITE_RVS_TOKEN': token, 'VITE_RVS_CONTROL_URL': f'http://127.0.0.1:{args.control_port}',
                       'VITE_RVS_CONTROL_TOKEN': token, 'VITE_RVS_RUN': args.run, 'VITE_RVS_CATALOG': json.dumps(catalog)}
            children.append(subprocess.Popen(['vp', 'dev', '--host', '127.0.0.1', '--port', '3000', '--strictPort'],
                                            cwd=ROOT / 'apps/web', env=web_env, start_new_session=True))
        if not args.no_seed and not seed_marker.exists():
            if any(producer.rows[topic] for topic in TOPICS):
                raise RuntimeError('Unfinished initial seed exists; select a fresh run')
            for topic in TOPICS:
                for first in range(0, args.rows, 1000):
                    producer.publish([record(topic, i) for i in range(first, min(first + 1000, args.rows))])
                    print(json.dumps({'seedProgress': {topic: len(producer.rows[topic])}, 'targetPerTopic': args.rows}), flush=True)
            summary = {'producerAcknowledgedDistinctIdentities': {topic: len(producer.rows[topic]) for topic in TOPICS},
                       'sourceNext': producer.cuts, 'campaignSize': args.rows == 200000, 'applicationOrConsumerQualification': False}
            seed_marker.write_text(json.dumps(summary, indent=2) + '\n')
        print(json.dumps({'web': None if args.no_web else 'http://127.0.0.1:3000',
                          'serviceLog': str(native_log.name), 'run': args.run,
                          'note': 'Readiness and complete dataset status come from the native service and application.'}), flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(0.25)
        raise RuntimeError('A native service/web process stopped; inspect its retained logs')
    except KeyboardInterrupt:
        pass
    finally:
        for child in reversed(children):
            stop(child)
        if control:
            control.shutdown()
            control.server_close()
        if producer:
            producer.close()
        for handle in handles:
            handle.close()
        broker('down', args.run)
        run_lock.close()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
