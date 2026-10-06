#!/usr/bin/env python3
"""Finite, owned two-topic browser campaign. Default is exactly 200000 per topic."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import re
import signal
import socket
import subprocess
import sys
import time
import uuid
import urllib.request
import urllib.error
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


def native_caught_up(snapshot, expected, previous_instance=None):
    if previous_instance is not None and (not isinstance(snapshot.get('instance'), str) or not snapshot['instance'] or snapshot['instance'] == previous_instance):
        return False
    if not snapshot.get('ready') or not snapshot.get('authority_safe'):
        return False
    sources = {source['topic']: source for source in snapshot.get('sources', [])}
    for topic, wanted in expected.items():
        source = sources.get(topic)
        if not source:
            return False
        retention = source.get('retention', {})
        if retention.get('active_payload_rows') != wanted['count'] or not retention.get('safe') or retention.get('pending_due'):
            return False
        partitions = {str(partition['partition']): partition for partition in source.get('partitions', [])}
        wanted_cuts = {str(partition): cut for partition, cut in wanted['sourceNext'].items()}
        if partitions.keys() != wanted_cuts.keys():
            return False
        for partition, cut in wanted_cuts.items():
            actual = partitions[partition]
            if not actual.get('assigned') or not actual.get('bootstrap_complete'):
                return False
            try:
                if any(int(actual.get(field, '-1')) < cut for field in ('durable_next', 'derived_next', 'serving_next')):
                    return False
            except (TypeError, ValueError):
                return False
    return True


def wait_native_caught_up(url, token, expected, service, timeout, log_path, previous_instance=None):
    started = time.monotonic()
    deadline = started + timeout
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    with log_path.open('w') as log:
        while True:
            if service.poll() is not None:
                raise RuntimeError('Owned native service exited during catchup')
            try:
                with urllib.request.urlopen(request, timeout=2) as response:
                    snapshot = json.load(response)
                log.write(json.dumps({'seconds': time.monotonic() - started, 'health': snapshot}) + '\n')
                log.flush()
                if native_caught_up(snapshot, expected, previous_instance):
                    return {'seconds': time.monotonic() - started, 'health': snapshot}
            except (urllib.error.URLError, TimeoutError) as error:
                log.write(json.dumps({'seconds': time.monotonic() - started, 'error': str(error)}) + '\n')
                log.flush()
            if time.monotonic() >= deadline:
                raise RuntimeError(f'Native sources did not reach all acknowledged cuts and exact row counts within {timeout} seconds')
            time.sleep(0.5)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]



def validate_build_mode(smoke, no_build):
    if no_build and not smoke:
        raise ValueError('--no-build is only permitted for explicitly labelled development smoke runs')


def check_candidate(initial, current, smoke, phase):
    same = initial == current
    if not same and not smoke:
        raise RuntimeError(f'Candidate source changed {phase}; frozen acceptance invalid')
    return same


def perform_cleanup(actions):
    failures = []
    for name, action in actions:
        try:
            action()
        except BaseException as error:
            failures.append({'resource': name, 'error': str(error)})
    return failures


def finalize_acceptance(result, cleanup_failures):
    result['cleanupErrors'] = cleanup_failures
    if cleanup_failures:
        result['status'] = 'failed'
    result['fullCampaignAcceptance'] = (result['status'] == 'passed' and result['mode'] == 'full-200000'
                                        and result.get('candidateFrozen') is True and not cleanup_failures)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--smoke', type=int, choices=[100], help='Explicit 100/topic development smoke; never full acceptance')
    parser.add_argument('--no-build', action='store_true', help='Reuse existing release native executables; web still rebuilt with isolated run configuration')
    parser.add_argument('--deadline', type=int, default=1800, help='Whole campaign deadline in seconds')
    args = parser.parse_args()
    try:
        validate_build_mode(args.smoke, args.no_build)
    except ValueError as error:
        parser.error(str(error))
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
    candidate = fingerprint()
    result['candidateSourceSha256'] = candidate
    result['candidateFrozen'] = True

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
        unchanged = check_candidate(candidate, fingerprint(), args.smoke, 'during native build')
        result['candidateFrozen'] = result['candidateFrozen'] and unchanged
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
        with (directory / 'effective-kafka-config.log').open('w') as effective:
            effective.write(kafka.compose(state, 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-configs.sh', '--bootstrap-server', 'kafka:9092', '--entity-type', 'brokers', '--entity-name', '1', '--describe', '--all', capture_output=True).stdout)
            for topic in TOPICS:
                description = kafka.compose(state, 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'kafka:9092', '--topic', topic, '--describe', capture_output=True).stdout
                effective.write(description)
                if not re.search(r'PartitionCount:\s*2\b', description):
                    raise RuntimeError('Effective source topic partition count is not two')
                effective.write(kafka.compose(state, 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-configs.sh', '--bootstrap-server', 'kafka:9092', '--entity-type', 'topics', '--entity-name', topic, '--describe', '--all', capture_output=True).stdout)
        config, token, _ = prepare(name, service_port=ports[1], health_port=ports[2], web_port=ports[3])
        service_env = {**os.environ, 'V12_SESSION_TOKEN': token}
        service = spawn([str(ROOT / 'target/release/view_server'), str(config)], 'native-0.log', env=service_env, cwd=ROOT)
        result['nativeStartedMonotonic'] = time.monotonic()
        standalone = subprocess.run([str(ROOT / 'target/release/examples/seed_producer'), str(config)], input='', text=True, capture_output=True, timeout=10)
        if standalone.returncode == 0 or 'running control authority' not in standalone.stderr:
            raise RuntimeError('A native demo writer bypassed the required journal authority')
        result['standaloneWriterRejected'] = True
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
        result['seedCompletedMonotonic'] = time.monotonic()
        result['initialReceipts'] = producer.expected()
        catchup = wait_native_caught_up(f'http://127.0.0.1:{ports[2]}/health', token, result['initialReceipts'], service, 120, directory / 'initial-native-catchup.ndjson')
        result['nativeInitialCatchupSeconds'] = catchup['seconds']
        result['nativeInitialCatchupHealth'] = catchup['health']
        web_env = {**os.environ, 'VITE_RVS_URL': f'ws://127.0.0.1:{ports[1]}/v15', 'VITE_RVS_TOKEN': token,
                   'VITE_RVS_CONTROL_URL': f'http://127.0.0.1:{ports[4]}', 'VITE_RVS_CONTROL_TOKEN': token, 'VITE_RVS_RUN': name,
                   'VITE_RVS_CATALOG': json.dumps(json.loads(config.read_text())['catalog']), 'VITE_RVS_E2E': '1'}
        unchanged = check_candidate(candidate, fingerprint(), args.smoke, 'before web build')
        result['candidateFrozen'] = result['candidateFrozen'] and unchanged
        with (directory / 'web-build.log').open('w') as build_log:
            command(['vp', 'build'], cwd=ROOT / 'apps/web', env=web_env, stdout=build_log, stderr=subprocess.STDOUT)
        unchanged = check_candidate(candidate, fingerprint(), args.smoke, 'during web build')
        result['candidateFrozen'] = result['candidateFrozen'] and unchanged
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
            elif action == 'native-ready':
                previous_instance = request['previousInstance']
                if not isinstance(previous_instance, str) or not previous_instance:
                    raise RuntimeError('Native restart readiness requires the previous instance identity')
                response = wait_native_caught_up(f'http://127.0.0.1:{ports[2]}/health', token, producer.expected(), service, 240, directory / 'restart-native-catchup.ndjson', previous_instance)
                result['nativeRestartCatchupSeconds'] = response['seconds']
                result['nativeRestartCatchupHealth'] = response['health']
            elif action == 'native-memory':
                response = {'pid': service.pid, 'rssKiB': int(subprocess.check_output(['ps', '-o', 'rss=', '-p', str(service.pid)]).strip())}
            else:
                raise RuntimeError(f'Unknown browser action: {action}')
            browser.stdin.write(json.dumps({'id': request['id'], 'result': response}) + '\n')
            browser.stdin.flush()
        if browser.wait(timeout=15) != 0:
            raise RuntimeError('Browser assertions failed; inspect browser.stderr.log and browser-samples.ndjson')
        result['browser'] = json.loads((directory / 'browser-result.json').read_text())
        unchanged = check_candidate(candidate, fingerprint(), args.smoke, 'during browser campaign')
        result['candidateFrozen'] = result['candidateFrozen'] and unchanged
        result['finalReceipts'] = producer.expected()
        result['status'] = 'passed'
    except BaseException as error:
        result['status'] = 'failed'
        result['error'] = str(error)
        raise
    finally:
        signal.alarm(0)
        cleanup = []
        actions = []
        def stop_child(child):
            stop(child)
            cleanup.append({'pid': child.pid, 'exitCode': child.returncode})
            if child.poll() is None:
                raise RuntimeError('Owned child is still alive after shutdown')
        for child in reversed(children):
            actions.append((f'child-{child.pid}', lambda child=child: stop_child(child)))
        if control:
            actions.extend([('control-server-shutdown', control.shutdown), ('control-server-close', control.server_close)])
        if producer:
            def close_producer():
                producer.close()
                cleanup.append({'pid': producer.process.pid, 'exitCode': producer.process.returncode, 'role': 'persistent-producer'})
                if producer.process.poll() is None:
                    raise RuntimeError('Persistent producer remains alive after shutdown')
            actions.append(('persistent-producer', close_producer))
        for index, handle in enumerate(handles):
            actions.append((f'log-handle-{index}', handle.close))
        if state:
            actions.append(('owned-broker', lambda: subprocess.run([sys.executable, str(ROOT / 'scripts/kafka.py'), 'down', '--run', name], cwd=ROOT, check=True, timeout=120)))
        failures = perform_cleanup(actions)
        result['ownedChildren'] = cleanup
        finalize_acceptance(result, failures)
        result['seconds'] = time.monotonic() - started
        (directory / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result), flush=True)
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        sys.exit(str(error))
