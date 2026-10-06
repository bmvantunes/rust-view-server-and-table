import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, object, text, readJson, isMain, message } from "./common.ts";
import { TOPICS, type Topic } from "./demo_config.ts";
import { kafka, type Kafka } from "./kafka.ts";
import { catalog } from "../packages/view-server-client/src/generated/demo-catalog.ts";
import { uint64, decimal, type Row } from "../packages/view-server-client/src/topic-schema.ts";
export type Orders = Row<typeof catalog.client_orders.schema>;
export type SeedRecord = { topic: Topic; partition: number; ack: string; key: { id: string } } & (
  | { row: Orders; delete?: never }
  | { delete: true; row?: never }
);
export function record(topic: Topic, index: number, revision = 0): SeedRecord & { row: Orders } {
  const identity = `order-${String(index).padStart(6, "0")}`,
    marker = topic === "client_orders" ? 0 : 1000000,
    customer = index % 2048;
  const row: Orders = {
    orderId: identity,
    customer: `${["Café", "東京", "Straße", "😀"][customer % 4]}-${String(customer).padStart(4, "0")}`,
    open: index % 2 === 0,
    units: uint64(String(9007199254740993n + BigInt(marker + index + revision))),
    price: decimal(
      `${marker + (index % 10000)}.${String(index % 100).padStart(2, "0")}123456789012345678`,
    ),
  };
  if (index % 4 === 1) row.note = null;
  else if (index % 4 === 2) row.note = "";
  else if (index % 4 === 3) row.note = `${topic} café e\u0301 日本語 revision=${revision}`;
  return {
    topic,
    partition: index % 2,
    ack: `${topic}:${index}:${revision}`,
    key: { id: identity },
    row,
  };
}
export function tombstone(row: SeedRecord): SeedRecord {
  return { topic: row.topic, partition: row.partition, ack: row.ack, key: row.key, delete: true };
}
export async function seed(
  run: string,
  rows: number,
  campaign = false,
  start = 0,
  revision = 0,
  { root = ROOT, owner = kafka }: { root?: string; owner?: Kafka } = {},
) {
  const state = owner.readState(run),
    directory = join(root, ".local/runs", run, state.clusterId),
    infoPath = join(directory, "control.json");
  if (!existsSync(infoPath))
    throw Error("Start this owned run with scripts/dev.ts before using seed controls");
  const info = object(readJson(infoPath));
  const url = new URL(text(info.url));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || info.run !== run)
    throw Error("Invalid local writer authority");
  const response = await fetch(new URL("/seed", url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: text(info.origin),
      "X-RVS-Token": readFileSync(join(directory, "session-token"), "utf8"),
    },
    body: JSON.stringify({ run, rows, start, revision, campaign }),
    signal: AbortSignal.timeout(600000),
  });
  const value: unknown = await response.json();
  if (response.status !== 200)
    throw Error(text(object(value).error ?? "Owned seed request failed"));
  return value;
}
if (isMain(import.meta.url)) {
  const { values: v } = parseArgs({
    options: {
      run: { type: "string", default: "dev" },
      rows: { type: "string", default: "200000" },
      campaign: { type: "boolean", default: false },
      start: { type: "string", default: "0" },
      revision: { type: "string", default: "0" },
    },
  });
  const rows = Number(v.rows),
    start = Number(v.start),
    revision = Number(v.revision);
  if (
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > 200000 ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw Error("rows must be1..200000; start/revision nonnegative");
  seed(v.run, rows, v.campaign, start, revision)
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      console.error(message(error));
      process.exitCode = 1;
    });
}
