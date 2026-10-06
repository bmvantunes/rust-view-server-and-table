"""Prepare demo configuration solely from repository-generated schemas and bindings."""
import copy
import json
from pathlib import Path
import secrets
import kafka

ROOT = Path(__file__).resolve().parents[1]
TOPICS = ('client_orders', 'server_orders')


def prepare(run_name, service_port=3010, health_port=3011, web_port=3000):
    state = kafka.read_state(run_name)
    generated = json.loads((ROOT / 'fixtures/proto-topics/catalog.json').read_text())
    bindings = json.loads((ROOT / 'fixtures/proto-topics/source-bindings.json').read_text())
    schema = next(t['schema'] for t in generated['topics'] if t['topic'] == 'orders')
    catalog = {'format': generated['format'], 'schemas': generated['schemas'],
               'topics': [{'topic': topic, 'schema': schema} for topic in TOPICS]}
    readiness = {'enter_offset_distance': 10, 'exit_offset_distance': 1000,
                 'max_sample_age_ms': 5000, 'enter_hold_ms': 1000, 'exit_hold_ms': 1000}
    sources = []
    for topic in TOPICS:
        sources.append({'topic': topic, 'schema': schema, 'brokers': state['bootstrapServers'],
                        'source_topic': topic, 'source_incarnation': state['clusterId'] + '-' + topic,
                        'group': topic + '-service', 'state_topic': topic + '-state', 'initialize_empty': True,
                        'partitions': [0, 1], 'key_descriptor': bindings['SimpleKey']['descriptor'],
                        'value_descriptor': bindings['Orders']['descriptor'], 'mapping': bindings['Orders']['mapping'],
                        'key_fields': bindings['SimpleKey']['key_fields'], 'identity': {'source_policy': 'compact',
                        'components': [{'source': 'key', 'field': 'id'}]}, 'readiness': copy.deepcopy(readiness),
                        'max_rows': 250000, 'retention': {'maxRetentionMessagesPerKey': 1}})
    config = {'bind': f'127.0.0.1:{service_port}', 'origin': f'http://127.0.0.1:{web_port}',
              'catalog': catalog, 'sources': sources, 'health': {'bind': f'127.0.0.1:{health_port}',
              'readiness': readiness, 'stdout': True, 'telemetry': {'enabled': True, 'otlp_endpoint': None}},
              'subscription_limits': {'per_client': 16, 'total': 64}, 'run_until_shutdown': True}
    directory = ROOT / '.local' / 'runs' / run_name / state['clusterId']
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'service.json'
    # Existing runs must recover the exact admitted source/catalog/config identity.
    if path.exists() and json.loads(path.read_text()) != config:
        raise RuntimeError('Run configuration changed; use a fresh run name or explicitly reset owned data')
    path.write_text(json.dumps(config, indent=2) + '\n')
    token_path = directory / 'session-token'
    if not token_path.exists():
        token_path.write_text(secrets.token_hex(32))
        token_path.chmod(0o600)
    return path, token_path.read_text(), state
