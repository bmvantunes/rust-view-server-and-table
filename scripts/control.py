#!/usr/bin/env python3
"""Private loopback demo writes. Source commits are acknowledged by the native producer."""
import hashlib
import fcntl
import hmac
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from demo_config import ROOT, TOPICS
from seed import read_line, record


class Conflict(Exception):
    pass


class Producer:
    def __init__(self, config, directory):
        self.lock = threading.RLock()
        self.config = Path(config)
        self.owner_lock = self.errors = self.receipts = self.process = None
        try:
            self.owner_lock = self.config.with_suffix('.control.lock').open('a')
            try:
                fcntl.flock(self.owner_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.owner_lock.close()
                raise RuntimeError('This run already has a live journal writer authority')
            self.errors = (directory / 'producer.stderr.log').open('a')
            self.receipts = (directory / 'producer-receipts.ndjson').open('a+')
            self.rows = {topic: {} for topic in TOPICS}
            self.cuts = {topic: {0: 0, 1: 0} for topic in TOPICS}
            self.counts = {topic: 0 for topic in TOPICS}
            pending = None
            self.receipts.seek(0)
            for line in self.receipts:
                entry = json.loads(line)
                if entry['phase'] == 'prepared':
                    if pending is not None:
                        raise RuntimeError('Unresolved prior producer intent; cannot assert current editable state')
                    pending = entry['records']
                elif entry['phase'] == 'committed' and pending is not None:
                    self._apply(pending, entry['receipts'])
                    pending = None
                else:
                    raise RuntimeError('Producer journal shape is invalid')
            if pending is not None:
                raise RuntimeError('Prior producer outcome is uncertain; select a fresh owned run')
            self.receipts.seek(0, 2)
            self.process = subprocess.Popen([str(ROOT / 'target/release/examples/seed_producer'), str(config)],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors,
                                           text=True, bufsize=1, start_new_session=True)
            self.failed = False
            if read_line(self.process).get('producer_ready') is not True:
                raise RuntimeError('Producer initialization failed')
        except BaseException:
            self.close()
            raise

    def _journal(self, entry):
        self.receipts.write(json.dumps({'atMonotonic': time.monotonic(), **entry}, ensure_ascii=False) + '\n')
        self.receipts.flush()
        os.fsync(self.receipts.fileno())

    def _apply(self, records, receipts):
        if len(receipts) != len(records):
            raise RuntimeError('Producer receipt cardinality mismatch')
        for row, receipt in zip(records, receipts):
            topic, partition = row['topic'], row['partition']
            if receipt['ack'] != row['ack'] or receipt['topic'] != topic or receipt['partition'] != partition:
                raise RuntimeError('Receipt does not identify submitted record')
            self.cuts[topic][partition] = max(self.cuts[topic][partition], receipt['offset'] + 1)
            self.counts[topic] += 1
            if row.get('delete'):
                self.rows[topic].pop(receipt['key'], None)
            else:
                self.rows[topic][receipt['key']] = row['row']

    def publish(self, records):
        with self.lock:
            if self.failed:
                raise RuntimeError('Producer outcome is uncertain; writes are fenced')
            if not 1 <= len(records) <= 1000 or any(row['topic'] not in TOPICS for row in records):
                raise ValueError('Batch is outside owned topics or bounds')
            self._journal({'phase': 'prepared', 'records': records})
            try:
                self.process.stdin.write(json.dumps({'records': records}, ensure_ascii=False) + '\n')
                self.process.stdin.flush()
                result = read_line(self.process)
                if result.get('transaction_committed') is not True:
                    raise RuntimeError('Producer did not acknowledge an atomic Kafka commit')
                receipts = result.get('receipts', [])
                self._apply(records, receipts)
                self._journal({'phase': 'committed', 'receipts': receipts})
                return receipts
            except BaseException:
                self.failed = True
                raise

    def expected(self):
        with self.lock:
            result = {}
            for topic, rows in self.rows.items():
                canonical = '\n'.join(f"{row['orderId']}\t{key}\t{json.dumps(row, sort_keys=True, separators=(',', ':'), ensure_ascii=False)}" for key, row in sorted(rows.items(), key=lambda item: item[1]['orderId']))
                result[topic] = {'count': len(rows), 'sha256': hashlib.sha256(canonical.encode()).hexdigest(),
                                 'sourceNext': dict(self.cuts[topic]), 'producerReceipts': self.counts[topic]}
            return result

    def close(self):
        try:
            if self.process is not None and self.process.poll() is None:
                try:
                    self.process.stdin.close()
                    self.process.wait(timeout=20)
                except (subprocess.TimeoutExpired, BrokenPipeError):
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        self.process.wait()
        finally:
            for handle in (self.receipts, self.errors, self.owner_lock):
                if handle is not None:
                    handle.close()

    def save(self, payload):
        if payload.get('topic') != 'client_orders':
            raise ValueError('Only the Client demonstration is editable')
        changes = payload.get('changes')
        if not isinstance(changes, list) or not 1 <= len(changes) <= 100:
            raise ValueError('Save requires 1..100 changes')
        records, seen = [], set()
        with self.lock:
            for change in changes:
                key, identity = change['rowId'], change['orderId']
                before, after = change['expected'], change['row']
                if key in seen or not isinstance(before, dict) or not isinstance(after, dict):
                    raise ValueError('Duplicate identity or invalid row')
                seen.add(key)
                if before.get('orderId') != identity or after.get('orderId') != identity:
                    raise ValueError('Identity cannot change')
                if json.dumps(self.rows['client_orders'].get(key), sort_keys=True) != json.dumps(before, sort_keys=True):
                    raise Conflict('The source row changed while this draft was open')
                if not isinstance(identity, str) or not identity.startswith('order-') or not identity[6:].isdigit():
                    raise ValueError('Invalid owned source identity')
                index = int(identity[6:])
                records.append({'topic': 'client_orders', 'partition': index % 2, 'ack': f'save:{time.time_ns()}:{identity}',
                                'key': {'id': identity}, 'row': after})
            return self.publish(records)


def serve(producer, *, port, origin, token, run):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def authorized(self):
            return self.headers.get('Origin') == origin and hmac.compare_digest(self.headers.get('X-RVS-Token', ''), token)

        def reply(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            if self.headers.get('Origin') == origin:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            if self.headers.get('Origin') != origin:
                self.reply(403, {'error': 'Origin denied'})
                return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'POST')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-RVS-Token')
            self.send_header('Vary', 'Origin')
            self.end_headers()

        def do_POST(self):
            if not self.authorized():
                self.reply(403, {'error': 'Private demo authorization denied'})
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 1024 * 1024 or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise ValueError('JSON request must be bounded to 1 MiB')
                self.connection.settimeout(10)
                payload = json.loads(self.rfile.read(length))
                if self.path == '/save':
                    producer.save(payload)
                    self.reply(200, {})
                elif self.path == '/seed':
                    rows, start, revision = payload.get('rows'), payload.get('start', 0), payload.get('revision', 0)
                    if payload.get('run') != run or any(type(v) is not int for v in (rows, start, revision)) or not 1 <= rows <= 200000 or start < 0 or start + rows > 200000 or not 0 <= revision <= 1000000000:
                        raise ValueError('Seed bounds or run identity are invalid')
                    if payload.get('campaign') and (rows, start, revision) != (200000, 0, 0):
                        raise ValueError('Campaign requires exactly 200000 initial rows per source')
                    with producer.lock:
                        if revision == 0 and any(producer.rows[topic] for topic in TOPICS):
                            raise ValueError('Initial seed already exists; use an explicit nonzero revision for updates')
                        for topic in TOPICS:
                            for first in range(start, start + rows, 1000):
                                producer.publish([record(topic, i, revision) for i in range(first, min(first + 1000, start + rows))])
                    self.reply(200, {'acknowledged': producer.expected(), 'applicationOrConsumerQualification': False})
                elif self.path in ('/update', '/delete'):
                    topic, index = payload.get('topic'), payload.get('index')
                    if topic not in TOPICS or type(index) is not int or not 0 <= index < 200000:
                        raise ValueError('Mutation is outside owned topic/identity bounds')
                    revision = payload.get('revision', 1)
                    if type(revision) is not int or not 0 <= revision <= 1000000000:
                        raise ValueError('Invalid revision')
                    row = record(topic, index, revision)
                    if self.path == '/delete':
                        row['delete'] = True
                        row.pop('row')
                    receipts = producer.publish([row])
                    self.reply(200, {'receipts': receipts})
                elif self.path == '/reset':
                    if payload.get('confirmRun') != run:
                        raise ValueError('Reset requires the exact owned run name')
                    count = 0
                    with producer.lock:
                        for topic in TOPICS:
                            records = []
                            for current in list(producer.rows[topic].values()):
                                index = int(current['orderId'][6:])
                                row = record(topic, index)
                                row['delete'] = True
                                row.pop('row')
                                records.append(row)
                                if len(records) == 1000:
                                    producer.publish(records)
                                    count += len(records)
                                    records = []
                            if records:
                                producer.publish(records)
                                count += len(records)
                    self.reply(200, {'deletedAcknowledged': count})
                else:
                    self.reply(404, {'error': 'Unknown demo control'})
            except Conflict as error:
                self.reply(409, {'error': str(error)})
            except (ValueError, KeyError, TypeError) as error:
                self.reply(400, {'error': str(error)})
            except Exception as error:
                self.reply(503, {'error': str(error)})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = False
    thread = threading.Thread(target=server.serve_forever, name='owned-demo-control', daemon=True)
    if hasattr(producer, 'config'):
        (producer.config.parent / 'control.json').write_text(json.dumps({'url': f'http://127.0.0.1:{server.server_address[1]}', 'origin': origin, 'run': run}) + '\n')
    thread.start()
    return server
