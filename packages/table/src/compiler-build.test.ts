import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { build as pack } from "vite-plus/pack";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import react from "@vitejs/plugin-react";
import { reactCompiler } from "../../../config/react-compiler";
const appPlugins = () => [reactCompiler(), ...react()];
const libraryPlugins = appPlugins;

for (const pipeline of ["application", "library"] as const) {
  test(`${pipeline} still rejects invalid conditional hooks under all_errors`, async () => {
    await mkdir("test-results", { recursive: true });
    const directory = await mkdtemp(resolve("test-results/compiler-errors-"));
    const entry = resolve(directory, "Invalid.tsx");
    await writeFile(
      entry,
      `import {useState} from 'react'; export function Invalid({enabled}: {enabled: boolean}) { if (enabled) useState(0); return <span />; }`,
    );
    try {
      const result =
        pipeline === "application"
          ? build({
              configFile: false,
              plugins: appPlugins(),
              build: { lib: { entry, formats: ["es"] }, write: false },
            })
          : pack({
              config: false,
              entry,
              outDir: resolve(directory, "dist"),
              dts: false,
              plugins: libraryPlugins(),
            });
      await expect(result).rejects.toThrow(/Hooks must always be called|conditionally/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test(`${pipeline} emits compiled exact bigint`, async () => {
    await mkdir("test-results", { recursive: true });
    const directory = await mkdtemp(resolve("test-results/compiler-"));
    const entry = resolve("src/internal/compiler-numeric-probe.tsx");
    const output = resolve(directory, "probe.mjs");
    try {
      if (pipeline === "application") {
        const result = await build({
          configFile: false,
          plugins: appPlugins(),
          build: {
            lib: { entry, formats: ["es"], fileName: () => "probe.mjs" },
            outDir: directory,
            minify: false,
            sourcemap: true,
            rolldownOptions: { external: [/^react(?:\/|$)/] },
          },
        });
        const chunks = (Array.isArray(result) ? result : [result]).flatMap((result) => {
          if (!("output" in result)) throw Error("Unexpected build watcher");
          return result.output;
        });
        const compiled = chunks.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
        if (compiled?.type !== "chunk") throw Error("Missing compiled entry");
        expect(
          compiled.map?.sourcesContent?.some((text) =>
            text?.includes("90071992547409931234567890n"),
          ),
        ).toBe(true);
      } else {
        await pack({
          config: false,
          entry: { probe: entry },
          outDir: directory,
          format: "esm",
          dts: false,
          sourcemap: true,
          plugins: libraryPlugins(),
          deps: { neverBundle: [/^react(?:\/|$)/] },
        });
      }
      const code = await readFile(output, "utf8");
      expect(code).toContain("react/compiler-runtime");
      const { NumericProbe } = await import(pathToFileURL(output).href);
      expect(renderToString(createElement(NumericProbe))).toContain(
        "90071992547409931234567890|-90071992547409931234567890|264|2000|true|true|true|42",
      );
      const map = JSON.parse(await readFile(`${output}.map`, "utf8")) as {
        sourcesContent: string[];
      };
      expect(
        map.sourcesContent.some((source) => source.includes("90071992547409931234567890n")),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
