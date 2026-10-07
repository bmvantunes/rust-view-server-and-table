import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { END, START, plan, readWorkspaces, synchronize, updateBlock } from "./index.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "tailwind-sources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, value: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const pkg = (path: string, name: string, rest: Record<string, unknown> = {}) =>
    put(path + "/package.json", JSON.stringify({ name, ...rest }));
  put(
    "pnpm-workspace.yaml",
    'packages:\n  - "packages/*"\n  - apps/*\n  - apps/apps/*\n  - "!packages/excluded"\n',
  );
  pkg("packages/ui", "@test/design", { exports: { ".": "./dist/index.mjs" } });
  return { root, put, pkg, read: (path: string) => readFileSync(join(root, path), "utf8") };
}

const directives = (text: string) =>
  [...text.matchAll(/^@source "([^"]+)";/gm)].map((match) => match[1]);

test("transitive and diamond dependencies generate stylesheet-relative paths without unrelated packages", (t) => {
  const f = fixture(t);
  f.pkg("packages/table", "table", {
    dependencies: { "@test/design": "workspace:*", sdk: "workspace:*" },
    exports: { ".": "./dist/index.mjs" },
  });
  f.pkg("packages/layout", "layout", { peerDependencies: { "@test/design": ">=0.0.0" } });
  f.pkg("packages/sdk", "sdk");
  f.pkg("apps/apps/web", "web", { dependencies: { table: "workspace:*", layout: "workspace:*" } });
  f.put(
    "apps/apps/web/src/styles/globals.css",
    '@import "tailwindcss";\n@source inline("hidden");\nbody { color: red; }\n',
  );
  const first = synchronize(f.root, false);
  const web = first.inventory.find((pkg) => pkg.name === "web");
  assert(web);
  assert.equal(web.ui, "transitive");
  assert.deepEqual(web.sources, ["@test/design", "layout", "table", "web"]);
  const css = f.read("apps/apps/web/src/styles/globals.css");
  assert.deepEqual(directives(css), [
    "..",
    "../../../../../packages/layout/src",
    "../../../../../packages/table/dist",
    "../../../../../packages/table/src",
    "../../../../../packages/ui/dist",
    "../../../../../packages/ui/src",
  ]);
  assert(css.includes('@source inline("hidden");\nbody { color: red; }'));
  assert.equal(synchronize(f.root, true).changes.length, 0);
});

test("all dependency fields, aliases, directory links, and cycles resolve without duplication", (t) => {
  const f = fixture(t);
  f.pkg("packages/a", "a", {
    optionalDependencies: { theme: "workspace:@test/design@*" },
    dependencies: { b: "workspace:*" },
  });
  f.pkg("packages/b", "b", { devDependencies: { a: "workspace:*", renamed: "workspace:../ui" } });
  f.put("packages/a/src/globals.css", "@import 'tailwindcss';\n");
  const result = plan(f.root);
  assert.deepEqual(result.inventory.find((pkg) => pkg.name === "a")?.sources, [
    "@test/design",
    "a",
    "b",
  ]);
  assert.equal(result.changes.length, 1);
  assert.equal(
    directives(result.changes[0]!.after).filter((path) => path.endsWith("ui/src")).length,
    1,
  );
});

test("workspace globs, exclusions and names are authoritative; ignored fixtures do not leak", (t) => {
  const f = fixture(t);
  f.pkg("packages/excluded", "excluded", { dependencies: { missing: "workspace:*" } });
  f.pkg("packages/ui/node_modules/other", "other");
  f.pkg("packages/ui/scripts/fixtures/consumer", "consumer");
  f.put("packages/ui/src/styles/globals.css", "@import 'tailwindcss';\n");
  f.put("packages/ui/scripts/fixtures/consumer/globals.css", "@import 'tailwindcss';\n");
  assert.deepEqual(
    readWorkspaces(f.root).map((pkg) => pkg.name),
    ["@test/design"],
  );
  assert.equal(plan(f.root).changes.length, 1);
});

test("check is read-only and dependency removal removes stale managed paths", (t) => {
  const f = fixture(t);
  f.pkg("apps/web", "web", { dependencies: { "@test/design": "workspace:*" } });
  const path = "apps/web/src/globals.css";
  const original = '@source "./custom";\nbody { color: red; }\n';
  f.put(path, original);
  assert.equal(synchronize(f.root, true).changes.length, 1);
  assert.equal(f.read(path), original);
  synchronize(f.root, false);
  assert(f.read(path).includes("packages/ui/src"));
  f.pkg("apps/web", "web");
  assert.equal(synchronize(f.root, true).changes.length, 1);
  synchronize(f.root, false);
  assert(!f.read(path).includes(START));
  assert(f.read(path).startsWith(original));
  assert.equal(synchronize(f.root, true).changes.length, 0);
});

test("adding a dependency updates an existing block without changing manual directives", (t) => {
  const f = fixture(t);
  f.pkg("apps/web", "web", { dependencies: { "@test/design": "workspace:*" } });
  f.put("apps/web/src/styles.css", '@import "@test/design/styles.css";\n@source not "./legacy";\n');
  synchronize(f.root, false);
  f.pkg("packages/table", "table", { peerDependencies: { "@test/design": "*" } });
  f.pkg("apps/web", "web", { dependencies: { table: "workspace:*" } });
  const change = synchronize(f.root, true).changes[0]!;
  assert(change.after.includes('@source "../../../packages/table/src";'));
  assert(change.after.includes('@source not "./legacy";'));
  assert.equal(change.after.split(START).length, 2);
});

test("invalid markers reject the entire update before writing earlier valid files", (t) => {
  const f = fixture(t);
  f.put("packages/ui/src/globals.css", "@import 'tailwindcss';\n");
  f.put("packages/ui/src/z/globals.css", START + "\n");
  assert.throws(() => synchronize(f.root, false), /Malformed/);
  assert.equal(f.read("packages/ui/src/globals.css"), "@import 'tailwindcss';\n");
  assert.throws(() => updateBlock(`${END}\n${START}`, []), /Malformed/);
  assert.throws(() => updateBlock(`${START}${END}${START}${END}`, []), /duplicate/);
});

test("duplicate identity and unresolved workspace dependencies fail loudly", (t) => {
  const f = fixture(t);
  f.pkg("packages/a", "@test/design");
  assert.throws(() => plan(f.root), /Duplicate/);
  f.pkg("packages/a", "a", { dependencies: { missing: "workspace:*" } });
  assert.throws(() => plan(f.root), /unresolved workspace dependency/);
  f.pkg("packages/a", "a", { dependencies: { bad: 5 } });
  assert.throws(() => plan(f.root), /version must be a string/);
});

test("CRLF and custom inline/exclusion directives survive idempotent generation", () => {
  const css = `@source inline("flex");\r\n${START}\r\n@source "stale";\r\n${END}\r\n@source not "./legacy";\r\n`;
  const next = updateBlock(css, ["../ui/src"]);
  assert(next.includes('@source "../ui/src";\r\n'));
  assert(next.endsWith('@source not "./legacy";\r\n'));
  assert.equal(updateBlock(next, ["../ui/src"]), next);
});

test("CLI check fails on drift without writing, fixes explicitly, then passes", async (t) => {
  const f = fixture(t);
  const { spawnSync } = await import("node:child_process");
  const { symlinkSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { dirname } = await import("node:path");
  const require = createRequire(import.meta.url);
  f.put("package.json", '{"type":"module"}');
  f.put(
    "tools/tailwind-sources/index.ts",
    readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
  );
  mkdirSync(join(f.root, "node_modules"));
  symlinkSync(
    dirname(require.resolve("yaml/package.json")),
    join(f.root, "node_modules/yaml"),
    "dir",
  );
  const css = "packages/ui/src/globals.css";
  f.put(css, '@import "tailwindcss";\n');
  const invoke = (...args: string[]) =>
    spawnSync(process.execPath, [join(f.root, "tools/tailwind-sources/index.ts"), ...args], {
      cwd: f.root,
      encoding: "utf8",
    });
  const before = f.read(css);
  const stale = invoke("--check");
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /vp run css:sources/);
  assert.equal(f.read(css), before);
  assert.equal(invoke().status, 0);
  assert.equal(invoke("--check").status, 0);
  assert.equal(invoke("--unknown").status, 1);
});
