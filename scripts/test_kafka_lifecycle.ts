import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kafka } from "./kafka.ts";
import type { CommandResult } from "./common.ts";
const ok: CommandResult = { code: 0, stdout: "", stderr: "" };
function fixture(t: test.TestContext, run?: ConstructorParameters<typeof Kafka>[1]) {
  const directory = mkdtempSync(join(tmpdir(), "rvs-kafka-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = new Kafka(
    directory,
    run ??
      (async () => {
        throw Error("Docker contacted");
      }),
  );
  const state = owner.initialize("test", 19092);
  return { owner, state };
}
test("initialize and env never contact Docker and do not replace state", async (t) => {
  const { owner, state } = fixture(t);
  assert.deepEqual(await owner.cli(["env", "--run", "test"]), state);
  await owner.cli(["init", "--run", "other", "--port", "19093"]);
  await assert.rejects(owner.cli(["init", "--run", "test"]), /EEXIST/);
  assert.deepEqual(owner.readState("test"), state);
});
test("shutdown checks all ownership labels and preserves volume/state", async (t) => {
  const calls: string[][] = [];
  const { owner, state } = fixture(t, async (args) => {
    calls.push([...args]);
    if (args.includes("inspect")) return { ...ok, code: 1 };
    return ok;
  });
  await owner.cli(["down", "--run", "test"]);
  const down = calls.find((args) => args.includes("down"));
  assert(down);
  assert.deepEqual(down.slice(-3), ["down", "--timeout", "45"]);
  assert(!down.includes("--volumes"));
  assert.deepEqual(owner.readState("test"), state);
  assert(calls.some((args) => args.includes("volume") && args.includes("inspect")));
});
test("reset requires exact confirmation before contacting Docker", async (t) => {
  const { owner, state } = fixture(t);
  await assert.rejects(
    owner.cli(["reset", "--run", "test", "--confirm-run", "other"]),
    /confirm-run/,
  );
  assert.deepEqual(owner.readState("test"), state);
});
test("foreign unlabelled named volume is refused", async (t) => {
  const { owner, state } = fixture(t, async (args) =>
    args.includes("--format")
      ? { ...ok, stdout: "{}" }
      : args[3] === "volume" && args.includes("inspect")
        ? ok
        : args.includes("inspect")
          ? { ...ok, code: 1 }
          : ok,
  );
  await assert.rejects(owner.assertOwned(state), /Refusing foreign volume/);
});
test("failed teardown does not erase reset ownership state", async (t) => {
  const { owner, state } = fixture(t, async (args) => {
    if (args.includes("down")) throw Error("engine down");
    return args.includes("inspect") ? { ...ok, code: 1 } : ok;
  });
  await assert.rejects(
    owner.cli(["reset", "--run", "test", "--confirm-run", "test"]),
    /engine down/,
  );
  assert.deepEqual(owner.readState("test"), state);
});
test("run state cannot select another project", (t) => {
  const { owner, state } = fixture(t);
  writeFileSync(owner.statePath("test"), JSON.stringify({ ...state, project: "unrelated" }));
  assert.throws(() => owner.readState("test"), /Unexpected project/);
});
