import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, object, list, text, readJson, canonical } from "./common.ts";
import { kafka, type Kafka } from "./kafka.ts";
export { ROOT };
export const TOPICS = ["client_orders", "server_orders"] as const;
export type Topic = (typeof TOPICS)[number];
export function topic(value: unknown): Topic {
  if (value === "client_orders" || value === "server_orders") return value;
  throw Error("Mutation is outside owned topics");
}
export function prepare(
  run: string,
  {
    servicePort = 3010,
    healthPort = 3011,
    webPort = 3000,
    owner = kafka,
    root = ROOT,
  }: {
    servicePort?: number;
    healthPort?: number;
    webPort?: number;
    owner?: Kafka;
    root?: string;
  } = {},
) {
  const state = owner.readState(run);
  const generated = object(readJson(join(root, "fixtures/proto-topics/catalog.json"))),
    bindings = object(readJson(join(root, "fixtures/proto-topics/source-bindings.json")));
  const schema = object(
    list(generated.topics).find((value) => object(value).topic === "orders"),
  ).schema;
  const catalog = {
    format: generated.format,
    schemas: generated.schemas,
    topics: TOPICS.map((topic) => ({ topic, schema })),
  };
  const readiness = {
    enter_offset_distance: 10,
    exit_offset_distance: 1000,
    max_sample_age_ms: 5000,
    enter_hold_ms: 1000,
    exit_hold_ms: 1000,
  };
  const key = object(bindings.SimpleKey),
    value = object(bindings.Orders);
  const sources = TOPICS.map((topic) => ({
    topic,
    schema,
    brokers: state.bootstrapServers,
    source_topic: topic,
    source_incarnation: state.clusterId + "-" + topic,
    group: topic + "-service",
    state_topic: topic + "-state",
    initialize_empty: true,
    partitions: [0, 1],
    key_descriptor: key.descriptor,
    value_descriptor: value.descriptor,
    mapping: value.mapping,
    key_fields: key.key_fields,
    identity: { source_policy: "compact", components: [{ source: "key", field: "id" }] },
    readiness,
    max_rows: 250000,
    retention: { maxRetentionMessagesPerKey: 1 },
  }));
  const config = {
    bind: `127.0.0.1:${servicePort}`,
    origin: `http://127.0.0.1:${webPort}`,
    catalog,
    sources,
    health: {
      bind: `127.0.0.1:${healthPort}`,
      readiness,
      stdout: true,
      telemetry: { enabled: true, otlp_endpoint: null },
    },
    subscription_limits: { per_client: 16, total: 64 },
    run_until_shutdown: true,
  };
  const directory = join(root, ".local/runs", run, state.clusterId);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "service.json");
  if (existsSync(path) && canonical(readJson(path)) !== canonical(config))
    throw Error("Run configuration changed; use a fresh run name or explicitly reset owned data");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  const tokenPath = join(directory, "session-token");
  if (!existsSync(tokenPath))
    writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  return { path, token: readFileSync(tokenPath, "utf8"), state, config };
}
