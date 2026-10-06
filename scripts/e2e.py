#!/usr/bin/env python3
"""Finite, owned two-topic browser campaign. Default is exactly 200000 per topic."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import time
import uuid
import kafka
from demo_config import ROOT, TOPICS, prepare
from dev import stop
from seed import record
from control import Producer, serve


def fingerprint():
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).split(b'\0')
    digest = hashlib.sha256()
    for raw in sorted(set(paths)):
        if not raw:
            continue
        path = ROOT / os.fsdecode(raw)
        if path.is_file():
            digest.update(raw + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--smoke', type=int, choices=[100], help='Explicit 100/topic development smoke; never full acceptance')
    parser.add_argument('--no-build', action='store_true', help='Reuse existing release native executables; web still rebuilt with isolated run configuration')
    parser.add_argument('--deadline', type=int, default=1800, help='Whole campaign deadline in seconds')
    args = parser.parse_args()
    rows = args.smoke or 200000
    name = 'e2e-' + uuid.uuid4().hex[:16]
    directory = ROOT / '.local/e2e' / name
    directory.mkdir(parents=True)
    started = time.monotonic()
    result = {'run': name, 'mode': 'smoke' if args.smoke else 'full-200000', 'rowsPerTopic': rows,
              'status': 'running', 'charterAcceptance': False, 'artifacts': str(directory.relative_to(ROOT))}
    children, handles = [], []
    producer = None
    control = None
    state = None

    def command(argv, **kwargs):
        subprocess.run(argv, cwd=kwargs.pop('cwd', ROOT), check=True, timeout=max(1, args.deadline - (time.monotonic() - started)), **kwargs)

    def broker(action, *extra):
        command([sys.executable, str(ROOT / 'scripts/kafka.py'), action, '--run', name, *extra])

    def spawn(argv, filename, **kwargs):
        log = (directory / filename).open('w')
        handles.append(log)
        child = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, **kwargs)
        children.append(child)
        return child

    def interrupted(_signum, _frame):
        raise RuntimeError('Campaign interrupted or deadline exceeded')

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(args.deadline)
    try:
        if not args.no_build:
            command([sys.executable, str(ROOT / 'scripts/rust.py'), 'build', '--locked', '--release',
                     '-p', 'view-server-app', '-p', 'product-source-ingestion', '--features', 'kafka-canonical',
                     '--bin', 'view_server', '--example', 'seed_producer'])
        ports = [free_port() for _ in range(5)]
        if len(set(ports)) != len(ports):
            raise RuntimeError('Port allocation collided; rerun')
        broker('preflight')
        broker('init', '--port', str(ports[0]))
        state = kafka.read_state(name)
        broker('up')
        for topic in TOPICS:
            for canonical in (topic, topic + '-state'):
                broker('topic-create', '--topic', canonical, '--cleanup-policy', 'compact')
        config, token, _ = prepare(name, service_port=ports[1], health_port=ports[2], web_port=ports[3])
        service_env = {**os.environ, 'V12_SESSION_TOKEN': token}
        service = spawn([str(ROOT / 'target/release/view_server'), str(config)], 'native-0.log', env=service_env, cwd=ROOT)
        producer = Producer(config, directory)
        concurrent = subprocess.run([str(ROOT / 'target/release/examples/seed_producer'), str(config)], input='', text=True, capture_output=True, timeout=10)
        if concurrent.returncode == 0 or 'live native writer' not in concurrent.stderr:
            raise RuntimeError('A concurrent native demo writer was not rejected by the config lock')
        result['concurrentWriterRejected'] = True
        control = serve(producer, port=ports[4], origin=f'http://127.0.0.1:{ports[3]}', token=token, run=name)
        for topic in TOPICS:
            for start in range(0, rows, 1000):
                producer.publish([record(topic, i) for i in range(start, min(start + 1000, rows))])
            if len(producer.rows[topic]) != rows:
                raise RuntimeError('Seed did not acknowledge the requested distinct identities')
            print(json.dumps({'seededDistinct': {topic: len(producer.rows[topic])}}), flush=True)
        result['initialReceipts'] = producer.expected()
        web_env = {**os.environ, 'VITE_RVS_URL': f'ws://127.0.0.1:{ports[1]}/v15', 'VITE_RVS_TOKEN': token,
                   'VITE_RVS_CONTROL_URL': f'http://127.0.0.1:{ports[4]}', 'VITE_RVS_CONTROL_TOKEN': token, 'VITE_RVS_RUN': name,
                   'VITE_RVS_CATALOG': json.dumps(json.loads(config.read_text())['catalog']), 'VITE_RVS_E2E': '1'}
        with (directory / 'web-build.log').open('w') as build_log:
            command(['vp', 'build'], cwd=ROOT / 'apps/web', env=web_env, stdout=build_log, stderr=subprocess.STDOUT)
        candidate = fingerprint()
        result['candidateSourceSha256'] = candidate
        spawn(['vp', 'preview', '--host', '127.0.0.1', '--port', str(ports[3]), '--strictPort'], 'web.log', cwd=ROOT / 'apps/web', env=web_env)
        browser = subprocess.Popen(['vp', 'exec', 'node', str(ROOT / 'tests/integration/e2e-browser.ts')], cwd=ROOT,
                                   env={**os.environ, 'E2E_URL': f'http://127.0.0.1:{ports[3]}', 'E2E_ROWS': str(rows),
                                        'E2E_DIRECTORY': str(directory), 'E2E_SMOKE': str(bool(args.smoke)).lower()},
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=(directory / 'browser.stderr.log').open('w'),
                                   text=True, bufsize=1, start_new_session=True)
        children.append(browser)
        serial = 0
        while browser.poll() is None:
            with selectors.DefaultSelector() as selector:
                selector.register(browser.stdout, selectors.EVENT_READ)
                if not selector.select(1):
                    if service.poll() is not None:
                        raise RuntimeError('Owned native service exited unexpectedly')
                    continue
            line = browser.stdout.readline()
            if not line:
                break
            request = json.loads(line)
            action = request['action']
            serial += 1
            if action == 'expected':
                response = producer.expected()
            elif action in ('update', 'delete', 'bootstrap-update'):
                topics = ('client_orders',) if action == 'bootstrap-update' else TOPICS
                records = [record(topic, request.get('index', 0), request.get('revision', 1000000)) for topic in topics]
                if action == 'delete':
                    for row in records:
                        row['delete'] = True
                        row.pop('row')
                response = {'receipts': producer.publish(records), 'expected': producer.expected()}
            elif action == 'restart':
                stop(service)
                service = spawn([str(ROOT / 'target/release/view_server'), str(config)], f'native-{serial}.log', env=service_env, cwd=ROOT)
                response = {'pid': service.pid}
            elif action == 'native-memory':
                response = {'pid': service.pid, 'rssKiB': int(subprocess.check_output(['ps', '-o', 'rss=', '-p', str(service.pid)]).strip())}
            else:
                raise RuntimeError(f'Unknown browser action: {action}')
            browser.stdin.write(json.dumps({'id': request['id'], 'result': response}) + '\n')
            browser.stdin.flush()
        if browser.wait(timeout=15) != 0:
            raise RuntimeError('Browser assertions failed; inspect browser.stderr.log and browser-samples.ndjson')
        result['browser'] = json.loads((directory / 'browser-result.json').read_text())
        result['candidateFrozen'] = fingerprint() == candidate
        if not result['candidateFrozen'] and not args.smoke:
            raise RuntimeError('Candidate source changed during the campaign; frozen acceptance invalid')
        result['finalReceipts'] = producer.expected()
        result['status'] = 'passed'
    except BaseException as error:
        result['status'] = 'failed'
        result['error'] = str(error)
        raise
    finally:
        signal.alarm(0)
        cleanup = []
        for child in reversed(children):
            try:
                stop(child)
                cleanup.append({'pid': child.pid, 'exitCode': child.returncode})
            except Exception as error:
                cleanup.append({'pid': child.pid, 'error': str(error)})
        if control:
            control.shutdown()
            control.server_close()
        if producer:
            producer.close()
        for handle in handles:
            handle.close()
        if state:
            try:
                subprocess.run([sys.executable, str(ROOT / 'scripts/kafka.py'), 'down', '--run', name], cwd=ROOT, check=True, timeout=120)
            except Exception as error:
                result['cleanupError'] = str(error)
                result['status'] = 'failed'
        result['ownedChildren'] = cleanup
        result['seconds'] = time.monotonic() - started
        (directory / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result), flush=True)
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        sys.exit(str(error))
