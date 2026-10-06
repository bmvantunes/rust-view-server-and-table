#!/usr/bin/env python3
"""Owned OrbStack Kafka lifecycle. No Docker dependency until a command is executed."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.local' / 'kafka'
COMPOSE = ROOT / 'infra' / 'kafka' / 'compose.yaml'
DOCKER = ['docker', '--context', 'orbstack']


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)


def capture(command):
    return run(command, capture_output=True).stdout.strip()


def valid_run(value):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', value):
        raise argparse.ArgumentTypeError('run must be 1–40 lowercase letters, digits or hyphens')
    return value


def state_path(name):
    return STATE / f'{valid_run(name)}.json'


def read_state(name):
    path = state_path(name)
    if not path.exists():
        raise RuntimeError(f'Unknown run {name}; initialize it first')
    state = json.loads(path.read_text())
    owner = json.loads((STATE / 'owner.json').read_text())['owner']
    if state['owner'] != owner or state['run'] != name:
        raise RuntimeError('Run ownership does not match this checkout')
    if state['project'] != f'rvs-{owner[:12]}-{name}':
        raise RuntimeError('Unexpected project name in run state')
    return state


def environment(state):
    return {**os.environ, 'RVS_KAFKA_OWNER': state['owner'], 'RVS_KAFKA_RUN': state['run'],
            'RVS_KAFKA_PORT': str(state['port']), 'RVS_KAFKA_CLUSTER_ID': state['clusterId']}


def compose(state, *args, **kwargs):
    return run(DOCKER + ['compose', '-p', state['project'], '-f', str(COMPOSE), *args],
               env=environment(state), **kwargs)


def assert_owned(state):
    """Check every project-labelled resource and the expected named resources."""
    project = state['project']
    queries = [
        ('container', DOCKER + ['ps', '-aq', '--filter', f'label=com.docker.compose.project={project}'], '.Config.Labels'),
        ('volume', DOCKER + ['volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={project}'], '.Labels'),
        ('network', DOCKER + ['network', 'ls', '-q', '--filter', f'label=com.docker.compose.project={project}'], '.Labels'),
    ]
    for kind, query, label_path in queries:
        identifiers = set(capture(query).split())
        # Detect a collision even if someone created the expected name without labels.
        name = {'container': f'{project}-kafka-1', 'volume': f'{project}_data',
                'network': f'{project}_default'}[kind]
        result = subprocess.run(DOCKER + [kind, 'inspect', name], text=True, capture_output=True)
        if result.returncode == 0:
            identifiers.add(name)
        for identifier in identifiers:
            labels = json.loads(capture(DOCKER + [kind, 'inspect', '--format',
                                                 '{{json ' + label_path + '}}', identifier])) or {}
            if labels.get('io.rvs.owner') != state['owner'] or labels.get('io.rvs.run') != state['run']:
                raise RuntimeError(f'Refusing foreign {kind}: {identifier}')


def initialize(name, port):
    STATE.mkdir(parents=True, exist_ok=True)
    owner_path = STATE / 'owner.json'
    try:
        with owner_path.open('x') as output:
            json.dump({'owner': uuid.uuid4().hex}, output)
    except FileExistsError:
        pass
    owner = json.loads(owner_path.read_text())['owner']
    if not re.fullmatch(r'[a-f0-9]{32}', owner):
        raise RuntimeError('Invalid checkout ownership token')
    state = {'owner': owner, 'run': name, 'port': port, 'project': f'rvs-{owner[:12]}-{name}',
             'clusterId': base64.urlsafe_b64encode(uuid.uuid4().bytes).decode().rstrip('='),
             'bootstrapServers': f'127.0.0.1:{port}'}
    # Never overwrite a run or silently reset its persistent cluster identity.
    with state_path(name).open('x') as output:
        json.dump(state, output, indent=2)
        output.write('\n')
    print(json.dumps(state))


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['preflight', 'init', 'up', 'down', 'restart', 'reset', 'status', 'describe', 'container-check', 'persistence-check', 'topic-create', 'topic-delete', 'env'])
    parser.add_argument('--run', type=valid_run, default='dev')
    parser.add_argument('--port', type=int, default=19092)
    parser.add_argument('--confirm-run', help='required for destructive reset; must match --run')
    parser.add_argument('--topic')
    parser.add_argument('--partitions', type=int, default=2)
    parser.add_argument('--cleanup-policy', choices=['delete', 'compact'], default='delete')
    args = parser.parse_args()
    if args.command in ('topic-create', 'topic-delete'):
        if not args.topic or not re.fullmatch(r'[A-Za-z0-9_-]{1,249}', args.topic):
            parser.error('topic requires 1–249 letters, digits, underscores or hyphens')
        if not 2 <= args.partitions <= 32:
            parser.error('partitions must be in 2..32')
    if not 1024 <= args.port <= 65535:
        parser.error('port must be in 1024..65535')
    if args.command == 'preflight':
        run(DOCKER + ['info'])
        run(DOCKER + ['compose', 'version'])
        return
    if args.command == 'init':
        initialize(args.run, args.port)
        return
    state = read_state(args.run)
    if args.command == 'env':
        print(json.dumps(state))
        return
    if args.command == 'reset' and args.confirm_run != args.run:
        parser.error('reset deletes this run’s Kafka data; pass --confirm-run matching --run')
    assert_owned(state)
    if args.command == 'up':
        compose(state, 'up', '-d', '--wait', '--wait-timeout', '150')
    elif args.command == 'down':
        compose(state, 'down', '--timeout', '45')  # Preserve volumes and cluster identity.
    elif args.command == 'restart':
        compose(state, 'restart', '--timeout', '45', 'kafka')
        compose(state, 'up', '-d', '--wait', '--wait-timeout', '150')
    elif args.command == 'reset':
        compose(state, 'down', '--volumes', '--timeout', '45')
        state_path(args.run).unlink()
        print('Owned data removed. Initialize a new run before starting Kafka.')
    elif args.command in ('topic-create', 'topic-delete'):
        options = ['--create', '--partitions', str(args.partitions), '--replication-factor', '1',
                   '--config', f'cleanup.policy={args.cleanup_policy}', '--config',
                   'retention.ms=' + ('-1' if args.cleanup_policy == 'compact' else '604800000')] if args.command == 'topic-create' else ['--delete']
        compose(state, 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-topics.sh',
                '--bootstrap-server', 'kafka:9092', '--topic', args.topic, *options)
    elif args.command == 'status':
        compose(state, 'ps', '--all')
    elif args.command == 'describe':
        compose(state, 'exec', '-T', 'kafka', '/opt/kafka/bin/kafka-configs.sh',
                '--bootstrap-server', 'kafka:9092', '--entity-type', 'brokers', '--entity-name', '1', '--describe', '--all')
    elif args.command in ('container-check', 'persistence-check'):
        container_check(state, recreate=args.command == 'persistence-check')


def container_check(state, recreate=False):
    def tool(name, *args, **kwargs):
        return compose(state, 'exec', '-T', 'kafka', f'/opt/kafka/bin/{name}.sh',
                       '--bootstrap-server', 'kafka:9092', *args, **kwargs)
    topic = 'infra_probe_' + uuid.uuid4().hex
    expected = 'container-probe-' + uuid.uuid4().hex
    tool('kafka-broker-api-versions')
    tool('kafka-topics', '--create', '--topic', topic, '--partitions', '2', '--replication-factor', '1',
         '--config', 'retention.ms=3600000')
    try:
        tool('kafka-console-producer', '--topic', topic, '--producer-property', 'acks=all', input=expected + '\n')
        if recreate:
            compose(state, 'down', '--timeout', '45')
            compose(state, 'up', '-d', '--wait', '--wait-timeout', '150')
        result = tool('kafka-console-consumer', '--topic', topic, '--from-beginning', '--max-messages', '1',
                      '--timeout-ms', '15000', '--isolation-level', 'read_committed', capture_output=True)
        if result.stdout.strip() != expected:
            raise RuntimeError(f'Unexpected container-side consume result: {result.stdout!r}')
        print(json.dumps({'containerMetadataProduceConsume': 'passed', 'topic': topic, 'value': expected, 'persistedAcrossRecreate': recreate}))
    finally:
        tool('kafka-topics', '--delete', '--topic', topic)


if __name__ == '__main__':
    try:
        cli()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f'Kafka lifecycle failed: {error}', file=sys.stderr)
        sys.exit(1)
