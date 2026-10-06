import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import {
  Producer,
  Conflict,
  serve,
  type InputRecord,
  type Receipt,
  type Journal,
  type Transport,
} from "../../scripts/control.ts";
import { record, seed } from "../../scripts/seed.ts";
import { OwnedLock, waitExit, object, command, sleep } from "../../scripts/common.ts";
import { Kafka } from "../../scripts/kafka.ts";
class MemoryJournal implements Journal {
  entries: unknown[] = [];
  closed = false;
  append(value: unknown) {
    this.entries.push(value);
  }
  close() {
    this.closed = true;
  }
}
function fixture() {
  const journal = new MemoryJournal();
  const batches: InputRecord[][] = [];
  let offset = 100;
  const transport: Transport = {
    async send(records) {
      batches.push(records);
      return {
        transaction_committed: true,
        receipts: records.map((row) => ({
          topic: row.topic,
          ack: row.ack,
          partition: row.partition,
          offset: offset++,
          key: "key-" + Number(row.key.id.slice(6)),
        })),
      };
    },
    async close() {},
  };
  const producer = new Producer(transport, journal);
  for (const index of [0, 1])
    producer.rows.client_orders.set("key-" + index, record("client_orders", index).row);
  return { producer, journal, batches, transport };
}
function change(producer: Producer, index: number) {
  const before = producer.rows.client_orders.get("key-" + index);
  assert(before);
  const row: Record<string, unknown> = { ...before, customer: "edited" };
  return { rowId: "key-" + index, orderId: before.orderId, expected: { ...before }, row };
}
function temporary(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "rvs-control-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test("expected snapshot freezes source cuts independently of later receipts", () => {
  const { producer } = fixture(),
    before = producer.expected(),
    row = record("client_orders", 0, 1);
  producer.apply(
    [row],
    [{ topic: row.topic, ack: row.ack, partition: 0, offset: 7, key: "key-0" }],
  );
  assert.equal(before.client_orders.sourceNext[0], 0);
  assert.equal(producer.expected().client_orders.sourceNext[0], 8);
  assert.notEqual(before.client_orders.sha256, producer.expected().client_orders.sha256);
});
test("all CAS comparisons precede publishing any member of batch", async () => {
  const { producer, batches } = fixture();
  const changes = [change(producer, 0), change(producer, 1)];
  changes[1].expected.units = "17";
  await assert.rejects(producer.save({ topic: "client_orders", changes }), Conflict);
  assert.equal(batches.length, 0);
});
test("save retains generated identity partition and exact values", async () => {
  const { producer, batches } = fixture();
  await producer.save({ topic: "client_orders", changes: [change(producer, 1)] });
  const emitted = batches[0][0];
  assert.deepEqual(emitted.key, { id: "order-000001" });
  assert.equal(emitted.partition, 1);
  assert.equal(emitted.row?.units, "9007199254740994");
  assert.equal(emitted.row?.price, "1.01123456789012345678");
  assert.equal(emitted.row?.note, null);
});
test("identity edits and duplicate changes are rejected before send", async () => {
  for (const mode of ["identity", "duplicate"]) {
    const { producer, batches } = fixture(),
      value = change(producer, 0);
    const values = [value];
    if (mode === "identity") value.row.orderId = "order-000005";
    else values.push(value);
    await assert.rejects(producer.save({ topic: "client_orders", changes: values }));
    assert.equal(batches.length, 0);
  }
});
test("ambiguous commit fences future writes and retains prepared intent", async () => {
  const { producer, journal, transport } = fixture();
  let sent = 0;
  transport.send = async () => {
    sent++;
    throw Error("receipt lost");
  };
  await assert.rejects(producer.publish([record("client_orders", 0)]), /receipt lost/);
  assert(producer.failed);
  await assert.rejects(producer.publish([record("client_orders", 1)]), /fenced/);
  assert.equal(sent, 1);
  assert.deepEqual(
    journal.entries.map((value) => object(value).phase),
    ["prepared"],
  );
});
test("actual OS lock excludes another process and releases on EOF", async (t) => {
  const path = join(temporary(t), "writer.lock"),
    first = await OwnedLock.acquire(path);
  try {
    await assert.rejects(OwnedLock.acquire(path), /live journal writer/);
    first.assertHeld();
  } finally {
    await first.close();
  }
  const next = await OwnedLock.acquire(path);
  await next.close();
});
test("guardian loss during receipt await cannot append committed evidence", async (t) => {
  const guard = await OwnedLock.acquire(join(temporary(t), "writer.lock")),
    journal = new MemoryJournal();
  let resolve!: (value: unknown) => void;
  const transport: Transport = {
    send: () =>
      new Promise((done) => {
        resolve = done;
      }),
    async close() {},
  };
  const producer = new Producer(transport, journal, { guard });
  const row = record("client_orders", 0);
  const pending = producer.publish([row]);
  await sleep(0);
  guard.child.kill("SIGKILL");
  await waitExit(guard.child);
  resolve({
    transaction_committed: true,
    receipts: [{ topic: row.topic, ack: row.ack, partition: 0, offset: 1, key: "key-0" }],
  });
  await assert.rejects(pending, /guardian lost|fenced/);
  assert.equal(producer.rows.client_orders.size, 0);
  assert.deepEqual(
    journal.entries.map((value) => object(value).phase),
    ["prepared"],
  );
  await producer.close();
});
async function httpFixture(t: test.TestContext) {
  const f = fixture(),
    control = await serve(f.producer, {
      port: 0,
      origin: "http://127.0.0.1:31337",
      token: "test-secret",
      run: "test-owned",
    });
  t.after(() => control.close());
  const send = (
    value: unknown,
    {
      origin = "http://127.0.0.1:31337",
      token = "test-secret",
      path = "/save",
      length,
    }: { origin?: string; token?: string; path?: string; length?: number } = {},
  ) =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify(value);
      const req = request(
        {
          hostname: "127.0.0.1",
          port: control.port,
          path,
          method: "POST",
          headers: {
            Origin: origin,
            "X-RVS-Token": token,
            "Content-Type": "application/json",
            "Content-Length": length ?? Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  return { ...f, control, send };
}
test("bad origin/token never reaches write authority", async (t) => {
  const { producer, send, batches } = await httpFixture(t),
    payload = { topic: "client_orders", changes: [change(producer, 0)] };
  assert.equal(await send(payload, { origin: "https://unowned.invalid" }), 403);
  assert.equal(await send(payload, { token: "wrong" }), 403);
  assert.equal(batches.length, 0);
});
test("oversized payload and unowned topics rejected", async (t) => {
  const { send, batches } = await httpFixture(t);
  assert.equal(await send({}, { length: 1024 * 1024 + 1 }), 400);
  assert.equal(await send({ topic: "other", index: 0 }, { path: "/update" }), 400);
  assert.equal(batches.length, 0);
});
test("conflict returns409 and reset requires exact namespace", async (t) => {
  const { producer, send, batches } = await httpFixture(t),
    value = change(producer, 0);
  value.expected.customer = "stale";
  assert.equal(await send({ topic: "client_orders", changes: [value] }), 409);
  assert.equal(await send({ confirmRun: "other" }, { path: "/reset" }), 400);
  assert.equal(batches.length, 0);
});
test("supported seed CLI uses same authority so stale save conflicts", async (t) => {
  const { producer, send, control } = await httpFixture(t),
    old = change(producer, 0),
    root = temporary(t),
    owner = new Kafka(join(root, ".local/kafka"));
  const state = owner.initialize("test-owned", 19092),
    directory = join(root, ".local/runs/test-owned", state.clusterId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "control.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${control.port}`,
      origin: "http://127.0.0.1:31337",
      run: "test-owned",
    }),
  );
  writeFileSync(join(directory, "session-token"), "test-secret");
  await seed("test-owned", 1, false, 0, 2, { root, owner });
  assert.equal(await send({ topic: "client_orders", changes: [old] }), 409);
  assert.equal(await send({ topic: "client_orders", changes: [change(producer, 0)] }), 200);
});
test("HTTP success waits for committed producer acknowledgement", async (t) => {
  const { producer, send, transport } = await httpFixture(t);
  const original = transport.send;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.send = async (rows) => {
    await gate;
    return original(rows);
  };
  let finished = false;
  const result = send({ topic: "client_orders", changes: [change(producer, 0)] }).then((code) => {
    finished = true;
    return code;
  });
  await sleep(25);
  assert.equal(finished, false);
  release();
  assert.equal(await result, 200);
});
test("startup timeout closes owned child and releases real advisory lock", async (t) => {
  const directory = temporary(t),
    config = join(directory, "service.json");
  writeFileSync(config, "{}");
  await assert.rejects(
    Producer.open(config, directory, {
      producerArgs: [
        process.execPath,
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
      ],
      startupTimeoutMs: 25,
    }),
    /receipt deadline/,
  );
  const lock = await OwnedLock.acquire(join(directory, "service.control.lock"));
  await lock.close();
});
test("uncertain replay fails before starting producer and releases handles", async (t) => {
  const directory = temporary(t),
    config = join(directory, "service.json"),
    marker = join(directory, "spawned");
  writeFileSync(config, "{}");
  writeFileSync(
    join(directory, "producer-receipts.ndjson"),
    JSON.stringify({ phase: "prepared", records: [record("client_orders", 0)] }) + "\n",
  );
  await assert.rejects(
    Producer.open(config, directory, {
      producerArgs: [
        process.execPath,
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`,
      ],
    }),
    /uncertain/,
  );
  assert.throws(() => readFileSync(marker), /ENOENT/);
  const lock = await OwnedLock.acquire(join(directory, "service.control.lock"));
  await lock.close();
});

test("streaming replay applies committed batches without rewriting journal", async (t) => {
  const directory = temporary(t),
    config = join(directory, "service.json"),
    path = join(directory, "producer-receipts.ndjson");
  writeFileSync(config, "{}");
  const entries: unknown[] = [];
  for (let revision = 0; revision < 250; revision++) {
    const row = record("client_orders", 0, revision);
    entries.push(
      { phase: "prepared", records: [row] },
      {
        phase: "committed",
        receipts: [
          { topic: row.topic, ack: row.ack, partition: 0, offset: revision, key: "key-0" },
        ],
      },
    );
  }
  const journal = entries.map((value) => JSON.stringify(value)).join("\n") + "\n";
  writeFileSync(path, journal);
  const producer = await Producer.open(config, directory, {
    producerArgs: [
      process.execPath,
      "-e",
      `console.log(JSON.stringify({producer_ready:true}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0))`,
    ],
  });
  try {
    assert.equal(producer.rows.client_orders.size, 1);
    assert.equal(
      producer.rows.client_orders.get("key-0")?.units,
      record("client_orders", 0, 249).row.units,
    );
    assert.equal(producer.expected().client_orders.sourceNext[0], 250);
    assert.equal(producer.expected().client_orders.producerReceipts, 250);
    assert.equal(readFileSync(path, "utf8"), journal);
  } finally {
    await producer.close();
  }
});
test("abort during producer startup releases child and lock before rejection", async (t) => {
  const directory = temporary(t),
    config = join(directory, "service.json"),
    abort = new AbortController();
  writeFileSync(config, "{}");
  const started = Producer.open(config, directory, {
    producerArgs: [
      process.execPath,
      "-e",
      `process.stdin.resume();process.stdin.on('end',()=>process.exit(0))`,
    ],
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(started);
  const next = await OwnedLock.acquire(join(directory, "service.control.lock"));
  await next.close();
});
