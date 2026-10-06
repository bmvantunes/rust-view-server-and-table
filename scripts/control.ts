import { createHash, timingSafeEqual } from "node:crypto";
import {
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  createReadStream,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { join, dirname, extname } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  ROOT,
  OwnedLock,
  JsonLines,
  object,
  list,
  text,
  integer,
  canonical,
  spawnOwned,
  waitExit,
  stopOwned,
  exited,
  message,
} from "./common.ts";
import { TOPICS, topic, type Topic } from "./demo_config.ts";
import { record, tombstone } from "./seed.ts";
export class Conflict extends Error {}
export class Invalid extends Error {}
export type InputRecord = {
  topic: Topic;
  partition: number;
  ack: string;
  key: { id: string };
  row?: Record<string, unknown>;
  delete?: true;
};
export type Receipt = { topic: Topic; partition: number; ack: string; key: string; offset: number };
export type Expected = Record<
  Topic,
  { count: number; sha256: string; sourceNext: Record<string, number>; producerReceipts: number }
>;
export interface Transport {
  send(records: InputRecord[]): Promise<unknown>;
  close(): Promise<void>;
}
export interface Journal {
  append(value: unknown): void;
  close(): void;
}
class FileJournal implements Journal {
  readonly fd: number;
  constructor(path: string) {
    this.fd = openSync(path, "a+");
  }
  append(value: unknown) {
    const bytes = Buffer.from(
      JSON.stringify({ atMonotonic: performance.now() / 1000, ...object(value) }) + "\n",
    );
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw Error("Producer journal write made no progress");
      offset += written;
    }
    fsyncSync(this.fd);
  }
  close() {
    closeSync(this.fd);
  }
}
function input(value: unknown): InputRecord {
  const row = object(value);
  const partition = integer(row.partition);
  if (partition !== 0 && partition !== 1) throw new Invalid("Invalid partition");
  const base = {
    topic: topic(row.topic),
    partition,
    ack: text(row.ack),
    key: { id: text(object(row.key).id) },
  };
  if (row.delete === true) return { ...base, delete: true };
  return { ...base, row: object(row.row) };
}
function receipt(value: unknown): Receipt {
  const v = object(value);
  return {
    topic: topic(v.topic),
    partition: integer(v.partition),
    ack: text(v.ack),
    key: text(v.key),
    offset: integer(v.offset),
  };
}
class NativeTransport implements Transport {
  readonly child: ChildProcess;
  readonly reader: JsonLines;
  readonly errors: number;
  private signal?: AbortSignal;
  private interrupt = () => {
    this.child.kill("SIGTERM");
  };
  constructor(args: string[], errors: number, signal?: AbortSignal) {
    this.errors = errors;
    this.child = spawnOwned(args, { stdio: ["pipe", "pipe", errors] });
    this.child.stdin?.on("error", () => {});
    this.reader = new JsonLines(this.child);
    this.signal = signal;
    signal?.addEventListener("abort", this.interrupt, { once: true });
    if (signal?.aborted) this.interrupt();
  }
  async send(records: InputRecord[]) {
    if (!this.child.stdin?.writable) throw Error("Producer input closed");
    await new Promise<void>((resolve, reject) =>
      this.child.stdin!.write(JSON.stringify({ records }) + "\n", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    return this.reader.read();
  }
  async close() {
    try {
      if (!exited(this.child)) {
        this.child.stdin?.end();
        try {
          await waitExit(this.child, 20000);
        } catch {
          await stopOwned(this.child, 10000);
        }
      }
    } finally {
      this.signal?.removeEventListener("abort", this.interrupt);
      this.reader.close();
      closeSync(this.errors);
    }
  }
}
export class Producer {
  readonly config?: string;
  readonly rows: Record<Topic, Map<string, Record<string, unknown>>> = {
    client_orders: new Map(),
    server_orders: new Map(),
  };
  readonly cuts: Record<Topic, Record<string, number>> = {
    client_orders: { 0: 0, 1: 0 },
    server_orders: { 0: 0, 1: 0 },
  };
  readonly counts: Record<Topic, number> = { client_orders: 0, server_orders: 0 };
  failed = false;
  private tail: Promise<void> = Promise.resolve();
  private transport: Transport;
  private journal: Journal;
  private guard?: OwnedLock;
  private closed = false;
  private signal?: AbortSignal;
  private configuredProcess?: ChildProcess;
  get process() {
    return this.transport instanceof NativeTransport
      ? this.transport.child
      : this.configuredProcess;
  }
  constructor(
    transport: Transport,
    journal: Journal,
    options: {
      config?: string;
      guard?: OwnedLock;
      process?: ChildProcess;
      signal?: AbortSignal;
    } = {},
  ) {
    this.transport = transport;
    this.journal = journal;
    this.config = options.config;
    this.guard = options.guard;
    this.configuredProcess = options.process;
    this.signal = options.signal;
    this.guard?.child.once("exit", () => {
      if (!this.closed) {
        this.failed = true;
        if (this.process) void stopOwned(this.process);
      }
    });
  }
  static async open(
    config: string,
    directory: string,
    options: { producerArgs?: string[]; startupTimeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    let guard: OwnedLock | undefined,
      journal: FileJournal | undefined,
      transport: NativeTransport | undefined;
    try {
      options.signal?.throwIfAborted();
      guard = await OwnedLock.acquire(config.slice(0, -extname(config).length) + ".control.lock");
      options.signal?.throwIfAborted();
      journal = new FileJournal(join(directory, "producer-receipts.ndjson"));
      const deferred: Transport = {
        async send() {
          throw Error("Producer initialization incomplete");
        },
        async close() {},
      };
      const producer = new Producer(deferred, journal, { config, guard, signal: options.signal });
      let pending: InputRecord[] | undefined;
      const stream = createReadStream(join(directory, "producer-receipts.ndjson"));
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          options.signal?.throwIfAborted();
          guard.assertHeld();
          const entry = object(JSON.parse(line));
          if (entry.phase === "prepared") {
            if (pending)
              throw Error("Unresolved prior producer intent; cannot assert current editable state");
            pending = list(entry.records).map(input);
          } else if (entry.phase === "committed" && pending) {
            producer.apply(pending, list(entry.receipts).map(receipt));
            pending = undefined;
          } else throw Error("Producer journal shape is invalid");
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      if (pending) throw Error("Prior producer outcome is uncertain; select a fresh owned run");
      options.signal?.throwIfAborted();
      guard.assertHeld();
      transport = new NativeTransport(
        options.producerArgs ?? [join(ROOT, "target/release/examples/seed_producer"), config],
        openSync(join(directory, "producer.stderr.log"), "a"),
        options.signal,
      );
      producer.transport = transport;
      if (
        object(await transport.reader.read(options.startupTimeoutMs ?? 60000)).producer_ready !==
        true
      )
        throw Error("Producer initialization failed");
      options.signal?.throwIfAborted();
      guard.assertHeld();
      if (producer.failed) throw Error("Producer authority failed during initialization");
      return producer;
    } catch (error) {
      try {
        await transport?.close();
      } finally {
        try {
          journal?.close();
        } finally {
          await guard?.close();
        }
      }
      throw error;
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      this.signal?.throwIfAborted();
      this.guard?.assertHeld();
      if (this.failed) throw Error("Producer outcome is uncertain; writes are fenced");
      return await action();
    } finally {
      release();
    }
  }
  apply(records: InputRecord[], receipts: Receipt[]) {
    if (records.length !== receipts.length) throw Error("Producer receipt cardinality mismatch");
    for (let i = 0; i < records.length; i++) {
      const row = records[i],
        ack = receipts[i];
      if (
        ack.ack !== row.ack ||
        ack.topic !== row.topic ||
        ack.partition !== row.partition ||
        ack.offset < 0
      )
        throw Error("Receipt does not identify submitted record");
    }
    for (let i = 0; i < records.length; i++) {
      const row = records[i],
        ack = receipts[i];
      this.cuts[row.topic][row.partition] = Math.max(
        this.cuts[row.topic][row.partition],
        ack.offset + 1,
      );
      this.counts[row.topic]++;
      if (row.delete) this.rows[row.topic].delete(ack.key);
      else this.rows[row.topic].set(ack.key, object(row.row));
    }
  }
  private async publishUnlocked(records: InputRecord[]) {
    this.signal?.throwIfAborted();
    this.guard?.assertHeld();
    if (this.failed) throw Error("Producer outcome is uncertain; writes are fenced");
    if (
      records.length < 1 ||
      records.length > 1000 ||
      records.some((row) => !TOPICS.includes(row.topic))
    )
      throw new Invalid("Batch is outside owned topics or bounds");
    try {
      this.journal.append({ phase: "prepared", records });
      const value = object(await this.transport.send(records));
      this.signal?.throwIfAborted();
      this.guard?.assertHeld();
      if (this.failed) throw Error("Producer outcome is uncertain; writes are fenced");
      if (value.transaction_committed !== true)
        throw Error("Producer did not acknowledge an atomic Kafka commit");
      const receipts = list(value.receipts).map(receipt);
      this.apply(records, receipts);
      this.journal.append({ phase: "committed", receipts });
      return receipts;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  publish(records: InputRecord[]) {
    return this.exclusive(() => this.publishUnlocked(records));
  }
  expected(): Expected {
    const one = (topic: Topic) => {
      const rows = [...this.rows[topic]].sort((a, b) =>
        text(a[1].orderId) < text(b[1].orderId)
          ? -1
          : text(a[1].orderId) > text(b[1].orderId)
            ? 1
            : 0,
      );
      const contents = rows
        .map(([key, row]) => `${text(row.orderId)}\t${key}\t${canonical(row)}`)
        .join("\n");
      return {
        count: rows.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        sourceNext: { ...this.cuts[topic] },
        producerReceipts: this.counts[topic],
      };
    };
    return { client_orders: one("client_orders"), server_orders: one("server_orders") };
  }
  async save(value: unknown) {
    const payload = object(value);
    if (payload.topic !== "client_orders")
      throw new Invalid("Only the Client demonstration is editable");
    const changes = list(payload.changes);
    if (changes.length < 1 || changes.length > 100) throw new Invalid("Save requires1..100changes");
    return this.exclusive(async () => {
      const records: InputRecord[] = [],
        seen = new Set<string>();
      for (const value of changes) {
        const change = object(value),
          key = text(change.rowId),
          identity = text(change.orderId),
          before = object(change.expected),
          after = object(change.row);
        if (seen.has(key)) throw new Invalid("Duplicate identity");
        seen.add(key);
        if (before.orderId !== identity || after.orderId !== identity)
          throw new Invalid("Identity cannot change");
        const current = this.rows.client_orders.get(key);
        if (!current || canonical(current) !== canonical(before))
          throw new Conflict("The source row changed while this draft was open");
        if (!/^order-\d+$/.test(identity)) throw new Invalid("Invalid owned source identity");
        const index = Number(identity.slice(6));
        if (!Number.isSafeInteger(index) || index < 0 || index >= 200000)
          throw new Invalid("Invalid owned source identity");
        records.push({
          topic: "client_orders",
          partition: index % 2,
          ack: `save:${process.hrtime.bigint()}:${identity}`,
          key: { id: identity },
          row: after,
        });
      }
      return this.publishUnlocked(records);
    });
  }
  seed(rows: number, start: number, revision: number) {
    return this.exclusive(async () => {
      if (revision === 0 && TOPICS.some((topic) => this.rows[topic].size))
        throw new Invalid(
          "Initial seed already exists; use an explicit nonzero revision for updates",
        );
      for (const topic of TOPICS)
        for (let first = start; first < start + rows; first += 1000)
          await this.publishUnlocked(
            Array.from({ length: Math.min(1000, start + rows - first) }, (_, i) =>
              record(topic, first + i, revision),
            ),
          );
      return this.expected();
    });
  }
  reset() {
    return this.exclusive(async () => {
      let count = 0;
      for (const topic of TOPICS) {
        const rows = [...this.rows[topic].values()];
        for (let first = 0; first < rows.length; first += 1000) {
          const batch = rows
            .slice(first, first + 1000)
            .map((row) => tombstone(record(topic, Number(text(row.orderId).slice(6)))));
          await this.publishUnlocked(batch);
          count += batch.length;
        }
      }
      return count;
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    try {
      await this.transport.close();
    } finally {
      try {
        this.journal.close();
      } finally {
        await this.guard?.close();
      }
    }
  }
}
export type Control = { server: Server; port: number; close(): Promise<void> };
export async function serve(
  producer: Producer,
  { port, origin, token, run }: { port: number; origin: string; token: string; run: string },
): Promise<Control> {
  const active = new Set<Promise<void>>();
  const secret = Buffer.from(token);
  const reply = (req: IncomingMessage, res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed) return;
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "Content-Type": "application/json",
      Connection: "close",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      ...(req.headers.origin === origin
        ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
        : {}),
    });
    res.end(body);
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      if (req.headers.origin !== origin) {
        reply(req, res, 403, { error: "Origin denied" });
        return;
      }
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type, X-RVS-Token",
        Vary: "Origin",
      });
      res.end();
      return;
    }
    const supplied = Buffer.from(
      typeof req.headers["x-rvs-token"] === "string" ? req.headers["x-rvs-token"] : "",
    );
    if (
      req.headers.origin !== origin ||
      supplied.length !== secret.length ||
      !timingSafeEqual(supplied, secret)
    ) {
      reply(req, res, 403, { error: "Private demo authorization denied" });
      return;
    }
    try {
      if (req.method !== "POST") {
        reply(req, res, 405, { error: "POST required" });
        return;
      }
      const length = Number(req.headers["content-length"]);
      if (
        !Number.isSafeInteger(length) ||
        length <= 0 ||
        length > 1024 * 1024 ||
        req.headers["content-type"]?.split(";")[0] !== "application/json"
      )
        throw new Invalid("JSON request must be bounded to1MiB");
      req.setTimeout(10000, () => req.destroy(Error("Request body deadline exceeded")));
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > length) throw new Invalid("Body exceeds declared bound");
        chunks.push(buffer);
      }
      if (received !== length) throw new Invalid("Incomplete request body");
      req.setTimeout(0);
      let payload: Record<string, unknown>;
      try {
        payload = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        throw new Invalid("Malformed JSON object");
      }
      switch (req.url) {
        case "/save":
          await producer.save(payload);
          reply(req, res, 200, {});
          break;
        case "/seed": {
          const rows = integer(payload.rows),
            start = integer(payload.start ?? 0),
            revision = integer(payload.revision ?? 0);
          if (
            payload.run !== run ||
            rows < 1 ||
            rows > 200000 ||
            start < 0 ||
            start + rows > 200000 ||
            revision < 0 ||
            revision > 1000000000
          )
            throw new Invalid("Seed bounds or run identity are invalid");
          if (payload.campaign && (rows !== 200000 || start !== 0 || revision !== 0))
            throw new Invalid("Campaign requires exactly200000 initial rows per source");
          reply(req, res, 200, {
            acknowledged: await producer.seed(rows, start, revision),
            applicationOrConsumerQualification: false,
          });
          break;
        }
        case "/update":
        case "/delete": {
          const selected = topic(payload.topic),
            index = integer(payload.index),
            revision = integer(payload.revision ?? 1);
          if (index < 0 || index >= 200000 || revision < 0 || revision > 1000000000)
            throw new Invalid("Mutation is outside owned bounds");
          const row = record(selected, index, revision);
          reply(req, res, 200, {
            receipts: await producer.publish([req.url === "/delete" ? tombstone(row) : row]),
          });
          break;
        }
        case "/reset":
          if (payload.confirmRun !== run) throw new Invalid("Reset requires exact owned run name");
          reply(req, res, 200, { deletedAcknowledged: await producer.reset() });
          break;
        default:
          reply(req, res, 404, { error: "Unknown demo control" });
      }
    } catch (error) {
      reply(
        req,
        res,
        error instanceof Conflict
          ? 409
          : error instanceof Invalid || /Expected |outside owned topics/.test(message(error))
            ? 400
            : 503,
        { error: message(error) },
      );
    }
  };
  const server = createServer((req, res) => {
    const task = handler(req, res);
    active.add(task);
    void task.finally(() => active.delete(task));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing control address");
  if (producer.config)
    writeFileSync(
      join(dirname(producer.config), "control.json"),
      JSON.stringify({ url: `http://127.0.0.1:${address.port}`, origin, run }) + "\n",
    );
  return {
    server,
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(active);
    },
  };
}
