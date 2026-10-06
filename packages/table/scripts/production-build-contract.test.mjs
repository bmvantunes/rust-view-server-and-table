import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "vite";
import { BrunoTableProductionDefines } from "../config/production-defines.js";

await test("production library definitions replace only global flag references", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const result = await build({
      configFile: false,
      plugins: [BrunoTableProductionDefines()],
      build: {
        lib: {
          entry: fileURLToPath(
            new URL("./fixtures/production-defines/src/entry.js", import.meta.url),
          ),
          formats: ["es"],
        },
        minify: false,
        write: false,
      },
    });
    const chunks = (Array.isArray(result) ? result : [result]).flatMap((output) => output.output);
    const entry = chunks.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
    assert.ok(entry, "The library build must emit its public fixture entry");
    const { evidence } = await import(
      `data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`
    );
    assert.deepEqual(evidence, {
      development: false,
      testDiagnostics: false,
      literal: "__BRUNO_TABLE_DEVELOPMENT__ __BRUNO_TABLE_TEST_DIAGNOSTICS__",
      larger: "larger identifier",
      property: "property name",
      shadow: "local binding",
    });
    assert.match(entry.code, /Diagnostic spelling in a comment: __BRUNO_TABLE_DEVELOPMENT__/u);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
