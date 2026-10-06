#!/usr/bin/env python3
"""Deterministic two-topic seed using one persistent batched native producer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time
from demo_config import ROOT, TOPICS, prepare


def record(topic, index, revision=0):
    identity = f'order-{index:06d}'
    marker = 0 if topic == 'client_orders' else 1000000
    customer = index % 2048
    prefix = ('Café', '東京', 'Straße', '😀')[customer % 4]
    row = {'orderId': identity, 'customer': f'{prefix}-{customer:04d}', 'open': index % 2 == 0,
           'units': str(9007199254740993 + marker + index + revision),
           'price': f'{marker + index % 10000}.{index % 100:02d}123456789012345678'}
    if index % 4 == 1:
        row['note'] = None
    elif index % 4 == 2:
        row['note'] = ''
    elif index % 4 == 3:
        row['note'] = f'{topic} café e\u0301 日本語 revision={revision}'
    return {'topic': topic, 'partition': index % 2, 'ack': f'{topic}:{index}:{revision}',
            'key': {'id': identity}, 'row': row}


def read_line(process, timeout=60):
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout):
            raise RuntimeError('Producer receipt deadline exceeded')
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(f'Producer exited before receipt (status {process.poll()})')
    return json.loads(line)


def seed(run_name, rows, campaign=False, start=0, revision=0):
    """All supported demo writes pass through the running journal authority."""
    import http.client
    import urllib.parse
    import kafka
    state = kafka.read_state(run_name)
    directory = ROOT / '.local' / 'runs' / run_name / state['clusterId']
    info_path = directory / 'control.json'
    if not info_path.exists():
        raise RuntimeError('Start this owned run with scripts/dev.py before using seed controls')
    info = json.loads(info_path.read_text())
    url = urllib.parse.urlsplit(info['url'])
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or info.get('run') != run_name:
        raise RuntimeError('Invalid local writer authority')
    token = (directory / 'session-token').read_text()
    connection = http.client.HTTPConnection('127.0.0.1', url.port, timeout=600)
    try:
        body = {'run': run_name, 'rows': rows, 'start': start, 'revision': revision, 'campaign': campaign}
        connection.request('POST', '/seed', json.dumps(body), {'Content-Type': 'application/json',
                           'Origin': info['origin'], 'X-RVS-Token': token})
        response = connection.getresponse()
        value = json.loads(response.read())
        if response.status != 200:
            raise RuntimeError(value.get('error', 'Owned seed request failed'))
        print(json.dumps(value), flush=True)
        return value
    finally:
        connection.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', default='dev')
    parser.add_argument('--rows', type=int, default=200000)
    parser.add_argument('--campaign', action='store_true')
    parser.add_argument('--start', type=int, default=0)
    parser.add_argument('--revision', type=int, default=0)
    args = parser.parse_args()
    if not 1 <= args.rows <= 200000 or args.start < 0 or args.revision < 0:
        parser.error('rows must be 1..200000; start/revision nonnegative')
    try:
        seed(args.run, args.rows, args.campaign, args.start, args.revision)
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
