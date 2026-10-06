import { transformSync } from "@babel/core";
import compiler, {
  printHIR,
  printReactiveFunction,
  type Logger,
} from "babel-plugin-react-compiler";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vite-plus/test";

const cases = [
  "90071992547409931234567890n",
  "-90071992547409931234567890n",
  "0xffn + 0b10n + 0o7n + 1_000n",
  "(5n ** 3n) / 2n % 7n",
  "(8n >> 1n) | (1n << 4n)",
  "[1n == 1, 1n == '1', 1n === 1, 1n !== 1, 2n > 1.5, 0n ? 'yes' : 'no'].join('|')",
  "`value:${90071992547409931234567890n}`",
  "({ 90071992547409931234567890n: 'exact' })['90071992547409931234567890']",
  "({ [0x10000000000000001n]: 'exact' })['18446744073709551617']",
  "(() => { const key = 90071992547409931234567890n; return ({ [key]: 'exact' })[key]; })()",
  "1n + 1",
  "+1n",
  "1n / 0n",
  "1n ** -1n",
  "1n >>> 1n",
  "(() => { let value = 90071992547409931234567890n; const before = value++; const after = --value; return [before, after, typeof value].join('|'); })()",
  "(() => { const BigInt = () => 0; return [BigInt(), 90071992547409931234567890n].join('|'); })()",
];

test("public compiler diagnostics can print exact bigint intermediate values", () => {
  const descriptions: string[] = [];
  const logger: Logger = {
    logEvent() {},
    debugLogIRs(event) {
      if (event.kind === "hir") descriptions.push(printHIR(event.value.body));
      if (event.kind === "reactive") descriptions.push(printReactiveFunction(event.value));
    },
  };
  transformSync(
    "import {useState} from 'react'; export function useProbe() { const [value] = useState(90071992547409931234567890n); return [value, 1n]; }",
    {
      filename: "probe.js",
      configFile: false,
      babelrc: false,
      plugins: [
        [
          compiler,
          { compilationMode: "infer", panicThreshold: "all_errors", target: "19", logger },
        ],
      ],
    },
  );
  expect(descriptions.some((text) => text.includes("90071992547409931234567890n"))).toBe(true);
});

for (const expression of cases) {
  test(`compiled bigint agrees with native JavaScript: ${expression}`, async () => {
    await mkdir("test-results", { recursive: true });
    const directory = await mkdtemp(resolve("test-results/compiler-semantics-"));
    try {
      const result = transformSync(
        `import {useState} from 'react'; export function useProbe() { const [value] = useState(0); return [value, ${expression}]; }`,
        {
          filename: "probe.js",
          configFile: false,
          babelrc: false,
          plugins: [
            [compiler, { compilationMode: "infer", panicThreshold: "all_errors", target: "19" }],
          ],
        },
      );
      expect(result?.code).toContain("react/compiler-runtime");
      const output = resolve(directory, "probe.mjs");
      await writeFile(output, result!.code!);
      const compiled = await import(pathToFileURL(output).href);
      const native = new Function(`return [0, (${expression})];`);
      const evaluate = (probe: () => unknown) => {
        function View() {
          return String(probe());
        }
        try {
          return { html: renderToString(createElement(View)) };
        } catch (error) {
          return { error: error instanceof Error ? error.name : String(error) };
        }
      };
      expect(evaluate(compiled.useProbe)).toEqual(evaluate(() => native()));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
