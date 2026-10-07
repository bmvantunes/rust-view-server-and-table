import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { build } from "vite";

import { react, reactCompiler } from "../../../config/react-compiler.ts";

const consumerCases = [
  { name: "server-root", entry: "server-root-entry.tsx", specifier: "@bruno/table" },
  { name: "server-subpath", entry: "server-subpath-entry.tsx", specifier: "@bruno/table/server" },
  { name: "read-only-client", entry: "read-only-client-entry.tsx", specifier: "@bruno/table" },
  { name: "editable-client", entry: "editable-client-entry.tsx", specifier: "@bruno/table" },
];

const editableRuntimeMarkers = [
  "Conflict Review",
  "Blocked Changes Review",
  "Edit Mode",
  "Reset Review",
  "Save operation details",
  "Confirm paste",
  "bruno-table-editable-traversal",
];
const clientOnlyEditModuleNames = new Set([
  "cell-edit",
  "cell-edit-boundary",
  "cell-edit-geometry",
  "cell-edit-traversal",
  "cell-paste",
  "cell-paste-chrome",
  "client-edit-capability",
  "client-edit-source",
  "drag-fill",
  "drag-fill-chrome",
  "drag-fill-planner",
  "edit-chrome",
  "edit-memory",
  "save-operations",
]);
// cell-edit-evidence is intentionally allowed: it only brands edit-review source rows in a WeakSet.
const consumerRoot = await mkdtemp(join(tmpdir(), "bruno-table-emitted-consumers-"));
const packageRoot = new URL("../", import.meta.url);

function sourceFor({ name, specifier }: { name: string; specifier: string }) {
  if (name.startsWith("server-")) {
    return `import { BrunoTableServer } from ${JSON.stringify(specifier)};\n\nconsole.log(BrunoTableServer);\n`;
  }
  return `import { createElement } from "react";\nimport { BrunoTableClient } from ${JSON.stringify(specifier)};\n\nconsole.log(createElement(BrunoTableClient, { editable: ${name === "editable-client" ? "true" : "false"} }));\n`;
}

async function buildConsumer({
  name,
  entry,
  specifier,
}: {
  name: string;
  entry: string;
  specifier: string;
}) {
  const outputDirectory = join(consumerRoot, `dist-${name}`);
  const entryPath = join(consumerRoot, entry);
  const renderedModules = new Map<string, number>();
  await writeFile(entryPath, sourceFor({ name, specifier }));
  await build({
    root: consumerRoot,
    configFile: false,
    mode: "production",
    plugins: [
      reactCompiler(),
      ...react(),
      {
        name: "bruno-emitted-consumer-module-report",
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== "chunk") continue;
            for (const [id, module] of Object.entries(output.modules)) {
              assert.ok(
                typeof module.renderedLength === "number" &&
                  Number.isFinite(module.renderedLength) &&
                  module.renderedLength >= 0,
                `The production bundler must report a renderedLength for ${id}.`,
              );
              renderedModules.set(
                id,
                Math.max(renderedModules.get(id) ?? 0, module.renderedLength),
              );
            }
          }
        },
      },
    ],
    resolve: {
      alias: [
        {
          find: "@bruno/table/server",
          replacement: fileURLToPath(new URL("dist/server.mjs", packageRoot)),
        },
        {
          find: "@bruno/table",
          replacement: fileURLToPath(new URL("dist/index.mjs", packageRoot)),
        },
      ],
    },
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      minify: "oxc",
      reportCompressedSize: false,
      rollupOptions: {
        input: entryPath,
        external: (id) => /^(?:react|react-dom|@bruno\/shadcn)(?:\/.*)?$/u.test(id),
      },
    },
  });

  const assetDirectory = join(outputDirectory, "assets");
  const jsFiles = (await readdir(assetDirectory)).filter((file) => file.endsWith(".js"));
  assert.ok(jsFiles.length > 0, `Expected emitted JavaScript for ${name}.`);
  const code = (
    await Promise.all(jsFiles.map((file) => readFile(join(assetDirectory, file), "utf8")))
  ).join("\n");
  const rawBytes = Buffer.byteLength(code);
  return Object.freeze({
    name,
    code,
    rawBytes,
    gzipBytes: gzipSync(code).byteLength,
    renderedModuleIds: Object.freeze(
      [...renderedModules].filter(([, renderedLength]) => renderedLength > 0).map(([id]) => id),
    ),
  });
}

function findClientOnlyEditModules(bundle: Awaited<ReturnType<typeof buildConsumer>>) {
  return bundle.renderedModuleIds.filter((id) => {
    const normalizedId = id.replaceAll("\\", "/");
    const moduleName = normalizedId.match(/\/dist\/internal\/([^/]+)\.mjs(?:[?#].*)?$/u)?.[1];
    return moduleName !== undefined && clientOnlyEditModuleNames.has(moduleName);
  });
}

function renderedClientOnlyEditModuleNames(bundle: Awaited<ReturnType<typeof buildConsumer>>) {
  return findClientOnlyEditModules(bundle)
    .map((id) => id.replaceAll("\\", "/"))
    .map((id) => id.match(/\/dist\/internal\/([^/]+)\.mjs(?:[?#].*)?$/u)?.[1])
    .filter((moduleName) => moduleName !== undefined);
}

try {
  const bundles: Awaited<ReturnType<typeof buildConsumer>>[] = [];
  for (const consumerCase of consumerCases) bundles.push(await buildConsumer(consumerCase));
  const byName = new Map(bundles.map((bundle) => [bundle.name, bundle]));

  await test("emitted consumers isolate Server runtime while Client consumers retain editing", (t) => {
    const serverRoot = byName.get("server-root");
    const serverSubpath = byName.get("server-subpath");
    const readOnlyClient = byName.get("read-only-client");
    const editableClient = byName.get("editable-client");
    assert.ok(serverRoot && serverSubpath && readOnlyClient && editableClient);

    for (const server of [serverRoot, serverSubpath]) {
      assert.deepEqual(
        findClientOnlyEditModules(server),
        [],
        `${server.name} must not render Client-only edit, paste, fill, or review modules.`,
      );
    }

    const clientEditModules = ["cell-edit", "cell-paste", "drag-fill", "edit-chrome"];
    for (const client of [readOnlyClient, editableClient]) {
      const renderedModuleNames = renderedClientOnlyEditModuleNames(client);
      for (const moduleName of clientEditModules) {
        assert.ok(
          renderedModuleNames.includes(moduleName),
          `${client.name} must render Client edit module ${moduleName}; reported modules: ${renderedModuleNames.join(", ")}`,
        );
      }
    }

    for (const marker of editableRuntimeMarkers) {
      for (const server of [serverRoot, serverSubpath]) {
        assert.equal(
          server.code.includes(marker),
          false,
          `${server.name} must exclude editable runtime marker ${JSON.stringify(marker)}.`,
        );
      }
      assert.equal(
        readOnlyClient.code.includes(marker),
        true,
        `Read-only Client must keep ${marker}.`,
      );
      assert.equal(
        editableClient.code.includes(marker),
        true,
        `Editable Client must keep ${marker}.`,
      );
    }

    for (const bundle of bundles) {
      t.diagnostic(
        `${bundle.name}: ${bundle.rawBytes.toLocaleString()} raw / ${bundle.gzipBytes.toLocaleString()} gzip bytes`,
      );
    }
  });
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}
