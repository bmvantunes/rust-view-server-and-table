import { parseManifest, record, yamlStringMapping } from "./tooling-data.ts";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { command as ownedCommand } from "../../../scripts/common.ts";
import { transformSync } from "@babel/core";
import { compilerPlugin as compiler } from "../../../config/react-compiler.ts";
import { type ESTree, parseAstAsync, transformWithOxc } from "vite";

import { reactCompilerOptions } from "../../../config/react-compiler-options.ts";
import { assertInstalledHydration } from "./assert-installed-hydration.ts";
import { isolatedProcessEnvironment } from "../../../config/isolated-process-environment.ts";

let rejected = false;
try {
  transformSync(
    "import {useState} from 'react'; export function Invalid({enabled}) { if(enabled) useState(0); return enabled; }",
    {
      filename: "strict.js",
      configFile: false,
      babelrc: false,
      plugins: [[compiler, reactCompilerOptions]],
    },
  );
} catch (error) {
  if (!/Hooks must always be called|conditionally/.test(String(error))) throw error;
  rejected = true;
}
if (!rejected) throw Error("React Compiler conditional-hook failure must remain fatal");

type SyntaxNode = ESTree.Node;
type FunctionNode =
  | ESTree.ArrowFunctionExpression
  | (ESTree.Function & {
      type: "FunctionExpression" | "FunctionDeclaration";
      body: ESTree.FunctionBody;
    });
type BoundaryFixture = { source: string; lang?: "ts" | "tsx"; mode?: string };
type Visitor = (node: SyntaxNode, ancestors: readonly SyntaxNode[]) => void;
type RuntimeModule = { url: URL; source: string; ast: ESTree.Program; specifiers: string[] };

class UninspectableWildcardExportError extends Error {}
// Never weaken the global rule or infer keyboard ownership from a lookalike path.
const keyboardEvidenceModuleCapabilities = new Map([
  ["internal/hotkey-adapter.ts", "adapter"],
  ["internal/produced-text-evidence.ts", "produced-text-evidence"],
]);

function normalizeProductionModulePath(sourcePath: string) {
  return sourcePath.replaceAll("\\", "/").replace(/^\.\/+|\/+$/gu, "");
}

function keyboardBoundaryModeForPath(sourcePath: string) {
  return (
    keyboardEvidenceModuleCapabilities.get(normalizeProductionModulePath(sourcePath)) ??
    "production"
  );
}

for (const [sourcePath, expectedMode] of [
  ["internal/hotkey-adapter.ts", "adapter"],
  ["internal\\hotkey-adapter.ts", "adapter"],
  ["./internal/hotkey-adapter.ts", "adapter"],
  ["internal/produced-text-evidence.ts", "produced-text-evidence"],
  ["internal\\produced-text-evidence.ts", "produced-text-evidence"],
  ["internal/bruno-table-view.tsx", "production"],
  ["internal\\bruno-table-view.tsx", "production"],
  ["./internal/cell-edit-boundary.tsx", "production"],
  ["nested/internal/hotkey-adapter.ts", "production"],
  ["nested/internal/bruno-table-view.tsx", "production"],
  ["internal/cell-edit-boundary.tsx.backup", "production"],
  ["internal/hotkey-adapter.ts.backup", "production"],
]) {
  if (keyboardBoundaryModeForPath(sourcePath) !== expectedMode) {
    throw new Error(`The keyboard boundary misclassified normalized path ${sourcePath}.`);
  }
}

async function readProductionModules(directoryUrl: URL) {
  const directoryPath = fileURLToPath(directoryUrl);
  const entries = await readdir(directoryPath, { recursive: true });
  const sourcePaths = entries
    .map((entry) => ({
      absolutePath: join(directoryPath, entry),
      sourcePath: normalizeProductionModulePath(entry),
    }))
    .filter(
      ({ sourcePath }) =>
        /\.[cm]?tsx?$/u.test(sourcePath) &&
        !/(?:^|\/)[^/]+\.(?:bench|setup|test|test-d)\.[cm]?tsx?$/u.test(sourcePath) &&
        !/(?:^|\/)(?:commit-diagnostic-probes|compiler-smoke|test-diagnostic-build-contract)\.[cm]?tsx?$/u.test(
          sourcePath,
        ),
    );
  return Promise.all(
    sourcePaths.map(async ({ absolutePath, sourcePath }) => ({
      sourcePath,
      source: await readFile(absolutePath, "utf8"),
    })),
  );
}

async function readDeclarationClosure(entryUrl: URL) {
  const sources = new Map<string, string>();

  async function visit(sourceUrl: URL) {
    const sourcePath = fileURLToPath(sourceUrl);
    if (sources.has(sourcePath)) return;
    const source = await readFile(sourceUrl, "utf8");
    sources.set(sourcePath, source);
    const localImports = source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/gu);
    for (const match of localImports) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const runtimeUrl = new URL(specifier, sourceUrl);
      const declarationUrl = new URL(
        runtimeUrl.href.endsWith(".mjs")
          ? runtimeUrl.href.replace(/\.mjs$/u, ".d.mts")
          : runtimeUrl.href.endsWith(".js")
            ? runtimeUrl.href.replace(/\.js$/u, ".d.ts")
            : runtimeUrl.href,
      );
      if (existsSync(declarationUrl)) await visit(declarationUrl);
    }
  }

  await visit(entryUrl);
  return Object.freeze({
    entry: sources.get(fileURLToPath(entryUrl)) ?? "",
    declarations: [...sources.values()].join("\n"),
    sources: [...sources.values()],
  });
}

async function collectDeclarationModuleSpecifiers(sources: readonly string[]) {
  const specifiers = new Set<string>();
  for (const source of sources) {
    const ast = await parseAstAsync(source, { lang: "dts" });
    walkSyntaxTree(ast, (node) => {
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration"
      ) {
        const specifier = staticStringValue(node.source);
        if (specifier !== undefined) specifiers.add(specifier);
        return;
      }
      if (
        node.type === "ImportExpression" &&
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        specifiers.add(node.source.value);
        return;
      }
      if (
        node.type === "TSImportType" &&
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        specifiers.add(node.source.value);
      }
    });
  }
  return [...specifiers];
}

async function readRuntimeClosure(entryUrl: URL) {
  const modules = new Map<string, RuntimeModule>();
  async function visit(url: URL) {
    if (modules.has(url.href)) return;
    const source = await readFile(url, "utf8");
    const ast = await parseAstAsync(source);
    const specifiers = new Set<string>();
    walkSyntaxTree(ast, (node) => {
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ImportExpression"
      ) {
        const specifier = staticStringValue(node.source);
        if (specifier !== undefined) specifiers.add(specifier);
      }
    });
    // Record before recursion so shared chunks and cycles are visited once.
    modules.set(url.href, { url, source, ast, specifiers: [...specifiers] });
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) await visit(new URL(specifier, url));
    }
  }
  await visit(entryUrl);
  return [...modules.values()];
}

function publicRuntimeTargets(exports: unknown): string[] {
  if (typeof exports === "string") return /\.[cm]?js$/u.test(exports) ? [exports] : [];
  if (Array.isArray(exports)) return exports.flatMap(publicRuntimeTargets);
  if (exports === null || typeof exports !== "object") return [];
  return Object.entries(exports).flatMap(([condition, target]) =>
    condition === "types" ? [] : publicRuntimeTargets(target),
  );
}

async function collectAmbientDeclarationKinds(sources: readonly string[]) {
  const kinds = new Set<string>();
  for (const source of sources) {
    const ast = await parseAstAsync(source, { lang: "dts" });
    walkSyntaxTree(ast, (node) => {
      if (node.type !== "TSModuleDeclaration") return;
      if (node.kind === "global" || (node.id.type === "Identifier" && node.id.name === "global")) {
        kinds.add("global");
        return;
      }
      if (node.id.type === "Literal") {
        kinds.add("module");
      }
    });
  }
  return [...kinds];
}

const declarationBoundaryFixture = `
  import type { Imported } from "fixture/import";
  export type { Imported as Reexported } from "fixture/export";
  type ImportType = import("fixture/import-type").Imported;
  type TypeofImport = typeof import("fixture/typeof-import");
  declare module "fixture/ambient" { export type Marker = string; }
  declare global { interface BrunoTableFixtureGlobal {} }
`;
const declarationBoundaryFixtureSpecifiers = await collectDeclarationModuleSpecifiers([
  declarationBoundaryFixture,
]);
for (const expected of [
  "fixture/import",
  "fixture/export",
  "fixture/import-type",
  "fixture/typeof-import",
]) {
  if (!declarationBoundaryFixtureSpecifiers.includes(expected)) {
    throw new Error(`Declaration boundary fixture did not detect ${expected}.`);
  }
}
const declarationBoundaryFixtureAmbientKinds = await collectAmbientDeclarationKinds([
  declarationBoundaryFixture,
]);
for (const expected of ["module", "global"]) {
  if (!declarationBoundaryFixtureAmbientKinds.includes(expected)) {
    throw new Error(`Declaration boundary fixture did not detect ${expected} augmentation.`);
  }
}

for (const [specifier, expected] of [
  ["react", false],
  ["effect", true],
  ["effect/BigDecimal", true],
  ["@effect/atom-react", true],
  ["effect-view-server/react", true],
] as const) {
  if (isEffectModuleSpecifier(specifier) !== expected) {
    throw new Error(`The declaration dependency fixture misclassified ${specifier}.`);
  }
}

for (const [nodeModulesEntries, virtualStoreEntries, expected] of [
  [["@bruno", "react"], [], false],
  [["@effect"], [], true],
  [[], ["@effect+schema@4.0.0-rc.111"], true],
  [["effect-view-server"], [], true],
] as const) {
  if (installedGraphContainsEffect(nodeModulesEntries, virtualStoreEntries) !== expected) {
    throw new Error("The clean-consumer dependency-graph fixture misclassified Effect.");
  }
}

const [
  rootDeclarationSet,
  serverDeclarationSet,
  effectDeclarationSet,
  rootRuntimeSource,
  effectRuntime,
  compilerOutput,
  packageJsonSource,
  productionModules,
] = await Promise.all([
  readDeclarationClosure(new URL("../dist/index.d.mts", import.meta.url)),
  readDeclarationClosure(new URL("../dist/server.d.mts", import.meta.url)),
  readDeclarationClosure(new URL("../dist/effect.d.mts", import.meta.url)),
  readFile(new URL("../dist/index.mjs", import.meta.url), "utf8"),
  readFile(new URL("../dist/effect.mjs", import.meta.url), "utf8"),
  readFile(new URL("../dist/internal/compiler-smoke.mjs", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readProductionModules(new URL("../src/", import.meta.url)),
]);

const runtimeClosures = await Promise.all(
  [...new Set(publicRuntimeTargets(parseManifest(packageJsonSource).exports))].map((target) =>
    readRuntimeClosure(new URL(target, new URL("../", import.meta.url))),
  ),
);
const rootRuntimeModules = await readRuntimeClosure(new URL("../dist/index.mjs", import.meta.url));
const runtimeModules = [
  ...new Map(runtimeClosures.flat().map((module) => [module.url.href, module])).values(),
];
const completeRuntime = runtimeModules.map((module) => module.source).join("\n");
const rootRuntime = `${rootRuntimeSource}\n${rootRuntimeModules.map((module) => module.source).join("\n")}`;
const emittedModule = (suffix: string) => {
  const module = rootRuntimeModules.find(({ url }) => url.pathname.endsWith(suffix));
  if (module === undefined) throw new Error(`The emitted package omitted ${suffix}.`);
  return module;
};
for (const module of runtimeModules) {
  if (!/__BRUNO_TABLE_(?:DEVELOPMENT|TEST_DIAGNOSTICS)__/u.test(module.source)) continue;
  // Oxc resolves global references for us. Comparing identical transforms with
  // and without definitions avoids treating property names, strings, comments,
  // or locally bound identifiers as unresolved build globals.
  const [original, substituted] = await Promise.all([
    transformWithOxc(module.source, fileURLToPath(module.url)),
    transformWithOxc(module.source, fileURLToPath(module.url), {
      define: {
        __BRUNO_TABLE_DEVELOPMENT__: "false",
        __BRUNO_TABLE_TEST_DIAGNOSTICS__: "false",
      },
    }),
  ]);
  if (original.code !== substituted.code) {
    throw new Error(
      `The production package contains an unresolved build flag in ${module.url.href}.`,
    );
  }
}

const declarations = rootDeclarationSet.declarations;
const effectDeclarations = effectDeclarationSet.declarations;
const rootDeclarationModuleSpecifiers = await collectDeclarationModuleSpecifiers(
  rootDeclarationSet.sources,
);
const rootAmbientDeclarationKinds = await collectAmbientDeclarationKinds(
  rootDeclarationSet.sources,
);
const testDiagnosticSentinels = [
  "BRUNO_TABLE_COMMIT_PROBE_DIAGNOSTIC_V1",
  "BRUNO_TABLE_CELL_RANGE_FRAME_TIMING_DIAGNOSTIC_V1",
  "BRUNO_TABLE_GESTURE_TIMING_DIAGNOSTIC_V1",
  "BRUNO_TABLE_TEST_LISTENER_DIAGNOSTIC_V1",
];

if (!compilerOutput.includes("react/compiler-runtime")) {
  throw new Error("React Compiler did not transform the @bruno/table smoke fixture.");
}

const clientRowPipelineAst = emittedModule("/internal/client-row-pipeline.mjs").ast;
const viewRuntimeAst = emittedModule("/internal/bruno-table-view.mjs").ast;
const producedTextEvidenceAst = emittedModule("/internal/produced-text-evidence.mjs").ast;
const hotkeyAdapterAst = emittedModule("/internal/hotkey-adapter.mjs").ast;
const productionModuleAsts = await Promise.all(
  productionModules.map(async ({ sourcePath, source }) => ({
    sourcePath,
    ast: await parseAstAsync(source, { lang: sourcePath.endsWith("x") ? "tsx" : "ts" }),
  })),
);
const keyboardBoundaryRejectedSmokes = await Promise.all(
  [
    { source: `function raw(event: KeyboardEvent) { return event.target; }` },
    { source: `const handler: React.KeyboardEventHandler<HTMLInputElement> = () => undefined;` },
    ...[
      "onKeyDown",
      "onKeyUp",
      "onKeyPress",
      "onKeyDownCapture",
      "onKeyUpCapture",
      "onKeyPressCapture",
    ].map((handlerName) => ({
      source: `const reactHandler = <input ${handlerName}={(event) => event.key} />;`,
      lang: "tsx" as const,
    })),
    ...["keydown", "keyup", "keypress"].flatMap((eventType) => [
      { source: `window.addEventListener("${eventType}", () => undefined);` },
      { source: `window.removeEventListener("${eventType}", () => undefined);` },
      { source: `window.on${eventType} = () => undefined;` },
    ]),
    {
      source: `const listenerType = "keydown"; window.addEventListener(listenerType, () => undefined);`,
    },
    { source: "window.addEventListener(`keydown`, () => undefined);" },
    { source: "window[`onkeydown`] = (event) => event.key;" },
    { source: "const handler = { [`onKeyDown`]: (event) => event.key };" },
    { source: `const emittedHandler = { onKeyDown: () => undefined };`, mode: "emitted" },
    {
      source: `window.addEventListener("keydown", () => undefined);`,
      mode: "emitted",
    },
    {
      source: `window.removeEventListener("keyup", () => undefined);`,
      mode: "emitted",
    },
    { source: `window.onkeypress = () => undefined;`, mode: "emitted" },
    {
      source: `import { useHotkeys } from "@tanstack/react-hotkeys"; useHotkeys("Enter", (event) => event.key);`,
    },
    {
      source: `import { useHotkeys as useFeatureHotkeys } from "@tanstack/react-hotkeys"; useFeatureHotkeys("Enter", (event) => event.key);`,
    },
    {
      source: `import * as ReactHotkeys from "@tanstack/react-hotkeys"; ReactHotkeys.useHotkeys("Enter", (event) => event.key);`,
    },
    { source: `export { useHotkeys } from "@tanstack/react-hotkeys";` },
    { source: `export * from "@tanstack/react-hotkeys";` },
    { source: `const reactHotkeys = import("@tanstack/react-hotkeys");` },
    { source: "const reactHotkeys = import(`@tanstack/react-hotkeys`);" },
    { source: `import { createMultiHotkeyHandler } from "@tanstack/hotkeys";` },
    { source: `export { createMultiHotkeyHandler } from "@tanstack/hotkeys";` },
    { source: `export * from "@tanstack/hotkeys";` },
    { source: `const hotkeysCore = import("@tanstack/hotkeys");` },
    { source: "const hotkeysCore = import(`@tanstack/hotkeys`);" },
    {
      source: `import * as HotkeysCore from "@tanstack/hotkeys"; HotkeysCore.createMultiHotkeyHandler({});`,
      mode: "adapter",
    },
    {
      source: `const adapterHandler = <input onKeyDown={(event) => event.isComposing} />;`,
      lang: "tsx" as const,
      mode: "adapter",
    },
    {
      source: `const nativeEditor = <input onKeyDown={(e) => e.key} />;`,
      lang: "tsx" as const,
      mode: "native-evidence",
    },
    {
      source: `element.addEventListener("keydown", (ev) => ev.ctrlKey);`,
      mode: "native-evidence",
    },
    {
      source: `const handle = (event) => event.key; element.addEventListener("keydown", handle);`,
      mode: "native-evidence",
    },
    {
      source: `const handle = (ev) => ev.metaKey; const nativeEditor = <input onKeyDown={handle} />;`,
      lang: "tsx" as const,
      mode: "native-evidence",
    },
    {
      source: `import { useHotkeys } from "@tanstack/react-hotkeys"; useHotkeys("Enter", () => undefined);`,
      mode: "native-evidence",
    },
    {
      source: `element.addEventListener("keydown", () => undefined);`,
      mode: "produced-text-evidence",
    },
    {
      source: `import { useHotkeys } from "@tanstack/react-hotkeys"; useHotkeys("Enter", () => undefined);`,
      mode: "produced-text-evidence",
    },
    ...[
      "key",
      "code",
      "keyCode",
      "which",
      "charCode",
      "location",
      "repeat",
      "ctrlKey",
      "metaKey",
      "altKey",
      "shiftKey",
      "getModifierState",
    ].flatMap((property) =>
      ["adapter", "native-evidence", "produced-text-evidence"].flatMap((mode) => [
        {
          source: `function boundary(event: KeyboardEvent) { return event.${property}; }`,
          mode,
        },
        {
          source: `function boundary(event: KeyboardEvent) { return event["${property}"]; }`,
          mode,
        },
        {
          source: `function boundary({ ${property} }: KeyboardEvent) { return ${property}; }`,
          mode,
        },
      ]),
    ),
    {
      source: `function adapter(event: KeyboardEvent) { return event.getModifierState("Shift"); }`,
      mode: "adapter",
    },
    {
      source: `function pointer(event: MouseEvent | PointerEvent | WheelEvent) { return event.shiftKey || event.ctrlKey; }`,
    },
  ].map(async ({ source, lang = "ts", mode = "production" }: BoundaryFixture) => ({
    ast: await parseAstAsync(source, { lang }),
    mode,
  })),
);
const keyboardBoundaryAllowedSmokes = await Promise.all(
  [
    {
      source: `function domain(entry: { key: string }) { const { key } = entry; return entry.key === key; }`,
    },
    {
      source: `function adapter(event: KeyboardEvent) { return event.isComposing; }`,
      mode: "adapter",
    },
    {
      source: `import { useHotkeys } from "@tanstack/react-hotkeys"; useHotkeys("Enter", () => undefined);`,
      mode: "adapter",
    },
    ...[
      "onKeyDown",
      "onKeyUp",
      "onKeyPress",
      "onKeyDownCapture",
      "onKeyUpCapture",
      "onKeyPressCapture",
    ].map((handlerName) => ({
      source: `const nativeEditor = <input ${handlerName}={(event) => record(event.isComposing)} />;`,
      lang: "tsx" as const,
      mode: "native-evidence",
    })),
    {
      source: `element.addEventListener("keydown", (event) => record(event.isComposing));`,
      mode: "native-evidence",
    },
    {
      source: `element.addEventListener("compositionstart", () => undefined); element.addEventListener("beforeinput", (event: InputEvent) => record(event.inputType, event.data, event.isComposing)); element.addEventListener("compositionend", (event: CompositionEvent) => record(event.data));`,
      mode: "produced-text-evidence",
    },
    {
      source: `function command(event: BrunoTableHotkeyGesture) { if (event.target) event.preventDefault(); }`,
    },
  ].map(async ({ source, lang = "ts", mode = "production" }: BoundaryFixture) => ({
    ast: await parseAstAsync(source, { lang }),
    mode,
  })),
);
const emittedProducedTextInstallerSmoke = `
function installBrunoTableProducedTextEvidence(target) {
  const listener = () => undefined;
  target.addEventListener("compositionstart", listener);
  target.addEventListener("beforeinput", listener);
  target.addEventListener("compositionend", listener);
  return () => {
    target.removeEventListener("compositionstart", listener);
    target.removeEventListener("beforeinput", listener);
    target.removeEventListener("compositionend", listener);
  };
}`;
const emittedProducedTextEvidenceRejectedSmokes = await Promise.all(
  [
    {
      source: `${emittedProducedTextInstallerSmoke}\nfunction unsupported(target) { target.addEventListener("compositionupdate", () => undefined); }`,
      expected: "escaped the emitted produced-text installer",
    },
    {
      source: emittedProducedTextInstallerSmoke.replace(
        'target.addEventListener("compositionend", listener);',
        'target.addEventListener("compositionend", listener); target.addEventListener("compositionupdate", listener);',
      ),
      expected: "is an unsupported produced-text lifecycle",
    },
    {
      source: emittedProducedTextInstallerSmoke.replace(
        'target.removeEventListener("beforeinput", listener);',
        "",
      ),
      expected: "expected exactly one removeEventListener:beforeinput lifecycle",
    },
  ].map(async ({ source, expected }) => ({
    ast: await parseAstAsync(source, { lang: "js" }),
    expected,
  })),
);
const layoutEffectBinding = findImportedBinding(clientRowPipelineAst, "react", "useLayoutEffect");
const layoutEffectCallbacks =
  layoutEffectBinding === undefined
    ? []
    : collectEffectCallbacks(clientRowPipelineAst, layoutEffectBinding);

if (
  testDiagnosticSentinels.some((sentinel) => completeRuntime.includes(sentinel)) ||
  /\b(?:has|install|record)BrunoTable(?:Client(?:ColumnGesture|RowOrderPlanning|CellRender|RowRender|ViewRender|GridSurfaceRender|ColumnResizeFrame|ColumnReorderFrame|ColumnPreviewStyleWrite|HeaderRender|EditFooterRender|QuickFilterRender|ColumnFilterTriggerRender|ColumnFilterRender|QueryTransition)|GridCommand|ColumnCommandSubscription|ColumnFilterSubscription|ReviewCellSubscription|Toolbar(?:Subscription|Lifetime))/u.test(
    completeRuntime,
  ) ||
  /installTableScopedListener/u.test(completeRuntime)
) {
  throw new Error(
    "The production package contains test-only commit probes, listeners, or gesture timing diagnostics.",
  );
}

if (!layoutEffectCallbacks.some((callback) => syntaxTreeContains(callback, isRowAcceptanceCall))) {
  throw new Error("The production package lost required commit-phase row reconciliation effects.");
}
assertNonTabbableDomOwnership(viewRuntimeAst);

const domOwnershipSmoke = `
import { useEffect } from "react";
function NonTabbableCellContent() {
  useEffect(() => {
    const manager = createNonTabbableGridManager(grid);
    return manager.register(root);
  }, []);
  return jsx("span", { inert: true, "data-bruno-nontabbable-cell-content": "" });
}
function createNonTabbableGridManager(grid) {
  const observer = new MutationObserver(() => {});
  observer.observe(grid, { subtree: true });
  grid.addEventListener("focusin", trackFocusedCandidate);
  return { register: (root) => {
    reconcileRoot(root);
    root.removeAttribute("inert");
    return () => {
      roots.delete(root);
      observer.disconnect();
      grid.removeEventListener("focusin", trackFocusedCandidate);
      nonTabbableGridManagers.delete(grid);
    };
  } };
}`;
assertNonTabbableDomOwnership(await parseAstAsync(domOwnershipSmoke, { lang: "js" }));
assertNonTabbableDomOwnership(
  await parseAstAsync(
    domOwnershipSmoke.replace(
      "const manager = createNonTabbableGridManager(grid);",
      "let manager = nonTabbableGridManagers.get(grid); if (manager === undefined) { manager = createNonTabbableGridManager(grid); nonTabbableGridManagers.set(grid, manager); }",
    ),
    { lang: "js" },
  ),
);
for (const [before, after] of [
  [
    "const manager = createNonTabbableGridManager(grid);",
    "{ const manager = createNonTabbableGridManager(grid); } const manager = unrelatedManager;",
  ],
  [
    "const manager = createNonTabbableGridManager(grid);",
    "createNonTabbableGridManager(grid); const manager = unrelatedManager;",
  ],
  [
    "return manager.register(root);",
    "const ignored = () => { return manager.register(root); }; return () => {};",
  ],
  [
    "const manager = createNonTabbableGridManager(grid);",
    "const ignored = () => createNonTabbableGridManager(grid); const manager = unrelatedManager;",
  ],
  ["createNonTabbableGridManager(grid);", "unrelatedManager(grid);"],
  ["return manager.register(root);", "manager.register(root);"],
  ["return manager.register(root);", "return () => {};"],
  ["inert: true", "inert: false"],
  ['"data-bruno-nontabbable-cell-content": ""', '"data-bruno-unrelated-cell-content": ""'],
  ["reconcileRoot(root);", ""],
  ['root.removeAttribute("inert");', ""],
  ["const observer = new MutationObserver(() => {});", "const observer = unrelatedObserver;"],
  ["observer.observe(grid, { subtree: true });", ""],
  [
    'grid.addEventListener("focusin", trackFocusedCandidate);',
    'grid.addEventListener("focusin", unrelatedListener);',
  ],
  ["observer.disconnect();", ""],
  ["roots.delete(root);", ""],
  ['grid.removeEventListener("focusin", trackFocusedCandidate);', ""],
  [
    'grid.removeEventListener("focusin", trackFocusedCandidate);',
    'grid.removeEventListener("focusin", unrelatedListener);',
  ],
  ["nonTabbableGridManagers.delete(grid);", ""],
  [
    'reconcileRoot(root);\n    root.removeAttribute("inert");',
    'root.removeAttribute("inert");\n    reconcileRoot(root);',
  ],
  [
    'root.removeAttribute("inert");\n    return () => {\n      roots.delete(root);\n      observer.disconnect();\n      grid.removeEventListener("focusin", trackFocusedCandidate);\n      nonTabbableGridManagers.delete(grid);\n    };',
    'return () => {\n      roots.delete(root);\n      observer.disconnect();\n      grid.removeEventListener("focusin", trackFocusedCandidate);\n      nonTabbableGridManagers.delete(grid);\n    };\n    root.removeAttribute("inert");',
  ],
]) {
  const mutated = domOwnershipSmoke.replace(before, after);
  if (mutated === domOwnershipSmoke) throw new Error("DOM ownership smoke did not mutate.");
  let rejected = false;
  try {
    assertNonTabbableDomOwnership(await parseAstAsync(mutated, { lang: "js" }));
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`DOM ownership validator accepted removal of ${before}`);
}

if (/\bany\b/u.test(declarations)) {
  throw new Error("The @bruno/table public declarations contain an any type.");
}

if (/tanstack/iu.test(declarations)) {
  throw new Error("A TanStack implementation type leaked into the @bruno/table declarations.");
}

if (findImportedBinding(hotkeyAdapterAst, "@tanstack/react-hotkeys", "useHotkeys") === undefined) {
  throw new Error("The emitted package lost the shared React Hotkeys boundary.");
}

for (const module of runtimeModules) {
  assertKeyboardBoundary(module.ast, `emitted ${module.url.href}`, "emitted");
  assertEmittedProducedTextEvidence(module.ast, false);
}
assertEmittedProducedTextEvidence(producedTextEvidenceAst);
for (const { ast, expected } of emittedProducedTextEvidenceRejectedSmokes) {
  assertEmittedProducedTextEvidenceViolationDetected(ast, expected);
}
for (const { sourcePath, ast } of productionModuleAsts) {
  assertKeyboardBoundary(ast, sourcePath, keyboardBoundaryModeForPath(sourcePath));
}
for (const { ast, mode } of keyboardBoundaryRejectedSmokes) {
  assertKeyboardBoundaryViolationDetected(ast, mode);
}
for (const { ast, mode } of keyboardBoundaryAllowedSmokes) {
  assertKeyboardBoundary(ast, "keyboard boundary allowed smoke fixture", mode);
}

if (
  /BrunoTable(?:ToolbarController|ToolbarState|ToolbarRowStore|ToolbarCellStore)/u.test(
    declarations,
  )
) {
  throw new Error("The toolbar public declarations expose broad or row/cell-owned infrastructure.");
}

if (
  !/registerBrunoTableIdentity/u.test(rootRuntime) ||
  !/simultaneous use of tableId/u.test(rootRuntime) ||
  !/NODE_ENV/u.test(rootRuntime) ||
  !/globalThis\.process\?\.env\?\.NODE_ENV/u.test(rootRuntime) ||
  /(?<!\.)\bprocess\.env/u.test(rootRuntime)
) {
  throw new Error(
    "The package does not preserve browser-safe consumer-time development diagnostics.",
  );
}

if (
  rootDeclarationModuleSpecifiers.some((specifier) => isEffectModuleSpecifier(specifier)) ||
  /(?:from\s+|import\s*)["'](?:effect|effect-view-server)(?:\/|["'])/u.test(rootRuntime)
) {
  throw new Error(
    "The @bruno/table root entry imports the optional Effect/View Server integration.",
  );
}

if (!declarations.includes('"__effect-view-server/LiveQueryViewportBaseRow@v1"')) {
  throw new Error("The @bruno/table declaration bundle omitted the source-owned viewport witness.");
}
if (!declarations.includes('"__effect-view-server/LiveQueryViewportCompleteRawSelect@v1"')) {
  throw new Error(
    "The @bruno/table declaration bundle omitted the source-owned complete raw projection.",
  );
}

if (rootAmbientDeclarationKinds.length > 0) {
  throw new Error(
    `The @bruno/table root declaration closure contains ambient ${rootAmbientDeclarationKinds.join("/")} declarations.`,
  );
}

if (/@effect-view-server/u.test(effectRuntime) || /@effect-view-server/u.test(effectDeclarations)) {
  throw new Error("The optional Effect entry leaks a private effect-view-server package path.");
}

if (/(?:from\s+|import\s*)["']effect-view-server(?:\/|["'])/u.test(effectRuntime)) {
  throw new Error("The optional Effect entry leaves effect-view-server as a consumer dependency.");
}

if (
  /(?:from\s+|import\s*)["']effect["']/u.test(effectRuntime) ||
  /(?:from\s+|import\s*)["']effect\/Schema["']/u.test(effectRuntime)
) {
  throw new Error("The optional Effect entry imports the broad Effect or Schema entrypoint.");
}

const exportedNames = collectDeclarationExportNames(rootDeclarationSet.entry);

if (exportedNames.length === 0) {
  throw new Error("The @bruno/table declaration entry has no public exports.");
}

if (exportedNames.some((name) => !name?.startsWith("BrunoTable"))) {
  throw new Error("Every @bruno/table-owned public export must start with BrunoTable.");
}

const parserSmokeExports = collectDeclarationExportNames(`
export declare function BrunoTableDirect(): void;
export interface BrunoTableInterface {}
export type BrunoTableAlias = string;
export { BrunoTableInternal as BrunoTableRenamed, type BrunoTableNamedType };
export * as BrunoTableNamespace from "./namespace.js";
export type * as BrunoTableTypeNamespace from "./type-namespace.js";
`);

if (
  JSON.stringify(parserSmokeExports.toSorted((left, right) => left.localeCompare(right))) !==
  JSON.stringify(
    [
      "BrunoTableDirect",
      "BrunoTableInterface",
      "BrunoTableAlias",
      "BrunoTableRenamed",
      "BrunoTableNamedType",
      "BrunoTableNamespace",
      "BrunoTableTypeNamespace",
    ].toSorted((left, right) => left.localeCompare(right)),
  )
) {
  throw new Error("The declaration export validator failed its direct-export smoke check.");
}

try {
  collectDeclarationExportNames('export * from "./uninspectable.js";');
  throw new Error("The declaration export validator accepted an uninspectable wildcard export.");
} catch (error) {
  if (!(error instanceof UninspectableWildcardExportError)) {
    throw error;
  }
}

const packageJson = parseManifest(packageJsonSource);
const expectedRootExport = {
  types: "./dist/index.d.mts",
  import: "./dist/index.mjs",
  default: "./dist/index.mjs",
};
const expectedEffectExport = {
  types: "./dist/effect.d.mts",
  import: "./dist/effect.mjs",
  default: "./dist/effect.mjs",
};
const expectedServerExport = {
  types: "./dist/server.d.mts",
  import: "./dist/server.mjs",
  default: "./dist/server.mjs",
};

if (!hasExactStringRecord(packageJson.exports["."], expectedRootExport)) {
  throw new Error("The @bruno/table root export is invalid.");
}

if (!hasExactStringRecord(packageJson.exports["./effect"], expectedEffectExport)) {
  throw new Error("The @bruno/table/effect export is invalid.");
}

if (!hasExactStringRecord(packageJson.exports["./server"], expectedServerExport)) {
  throw new Error("The @bruno/table/server export is invalid.");
}

if (
  !hasExactStringRecord(
    {
      default: "./dist/index.mjs",
      types: "./dist/index.d.mts",
      import: "./dist/index.mjs",
    },
    expectedRootExport,
  ) ||
  hasExactStringRecord(
    { ...expectedRootExport, browser: "./dist/index.mjs" },
    expectedRootExport,
  ) ||
  hasExactStringRecord({ ...expectedRootExport, import: "./dist/other.mjs" }, expectedRootExport)
) {
  throw new Error("The root-export validator failed its exact order-independent smoke check.");
}

if (Object.keys(packageJson.exports).some((exportName) => exportName.includes("internal"))) {
  throw new Error("A private @bruno/table module was exported publicly.");
}

if (hasInternalExportTarget(packageJson.exports)) {
  throw new Error("A public @bruno/table export points at a private dist/internal module.");
}

if (
  !hasInternalExportTarget({
    "./aliased-private-module": {
      import: "./dist/internal/private.mjs",
    },
  })
) {
  throw new Error("The private export-target validator failed its nested-condition smoke check.");
}

if (
  JSON.stringify(packageJson.files) !==
  JSON.stringify([
    "dist/**/*.mjs",
    "dist/**/*.d.mts",
    "!dist/internal/compiler-smoke.mjs",
    "!dist/internal/compiler-smoke.d.mts",
    "USAGE.md",
    "RELEASE.md",
    "THIRD_PARTY_NOTICES.md",
  ])
) {
  throw new Error(
    "The @bruno/table package must package runtime/declaration chunks, excluding development fixtures.",
  );
}
if (packageJson.private !== true) throw new Error("Local table package must remain private");
if (process.argv.includes("--packed")) await assertPackedConsumers();

if (packageJson.dependencies?.["@tanstack/react-table"] !== "9.2.6") {
  throw new Error(
    "The private TanStack Table engine is not pinned to the audited stable v9.2.6 version.",
  );
}

if (packageJson.dependencies?.["@tanstack/react-hotkeys"] !== "0.13.0") {
  throw new Error(
    "The private React Hotkeys boundary is not pinned to the audited stable v0.13.0 version.",
  );
}

const installableDependencySections = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const declaresDirectDependency = (name: string) =>
  installableDependencySections.some((section) => Object.hasOwn(packageJson[section] ?? {}, name));

if (declaresDirectDependency("@tanstack/hotkeys")) {
  throw new Error("BrunoTable must not depend directly on TanStack Hotkeys core.");
}

if (packageJson.dependencies?.["@tanstack/react-pacer"] !== "0.24.1") {
  throw new Error(
    "The private React Pacer boundary is not pinned to the audited stable v0.24.1 version.",
  );
}

if (declaresDirectDependency("@tanstack/pacer")) {
  throw new Error("React-bound BrunoTable pacing must not depend directly on TanStack Pacer core.");
}

if (packageJson.devDependencies?.["effect-view-server"] !== "4.2.8") {
  throw new Error(
    "The View Server integration is not pinned to the audited public 4.2.8 contract.",
  );
}

if (
  !hasExactStringRecord(packageJson.inlinedDependencies, {
    "effect-view-server": "4.2.8",
  })
) {
  throw new Error("The audited View Server value semantics are not explicitly inlined.");
}

const publicModule = await import("@bruno/table");
const actualRuntimeExports = Object.keys(publicModule).toSorted((left, right) =>
  left.localeCompare(right),
);
const expectedRuntimeExports = [
  "BrunoTableActiveFilterCount",
  "BrunoTableActiveSortCount",
  "BrunoTableAggregateAlgebra",
  "BrunoTableBigIntColumn",
  "BrunoTableBooleanColumn",
  "BrunoTableClient",
  "BrunoTableComputedColumn",
  "BrunoTableFilterControl",
  "BrunoTableLoadedRowCount",
  "BrunoTableNumberColumn",
  "BrunoTableQuickFilter",
  "BrunoTableResultRowCount",
  "BrunoTableSelectColumn",
  "BrunoTableServer",
  "BrunoTableTextColumn",
  "BrunoTableToolbar",
  "BrunoTableToolbarSpacer",
].toSorted((left, right) => left.localeCompare(right));

if (JSON.stringify(actualRuntimeExports) !== JSON.stringify(expectedRuntimeExports)) {
  throw new Error("The @bruno/table runtime exports do not match the strict public surface.");
}

const effectModule = await import("@bruno/table/effect");
const actualEffectRuntimeExports = Object.keys(effectModule).toSorted((left, right) =>
  left.localeCompare(right),
);
const expectedEffectRuntimeExports = [
  "BrunoTableBigDecimalColumn",
  "BrunoTableBigDecimalValueType",
];

if (JSON.stringify(actualEffectRuntimeExports) !== JSON.stringify(expectedEffectRuntimeExports)) {
  throw new Error("The @bruno/table/effect runtime exports do not match the optional surface.");
}

const serverModule = await import("@bruno/table/server");
const actualServerRuntimeExports = Object.keys(serverModule).toSorted((left, right) =>
  left.localeCompare(right),
);
const expectedServerRuntimeExports = [
  "BrunoTableActiveFilterCount",
  "BrunoTableActiveSortCount",
  "BrunoTableAggregateAlgebra",
  "BrunoTableBigIntColumn",
  "BrunoTableBooleanColumn",
  "BrunoTableComputedColumn",
  "BrunoTableFilterControl",
  "BrunoTableLoadedRowCount",
  "BrunoTableNumberColumn",
  "BrunoTableQuickFilter",
  "BrunoTableResultRowCount",
  "BrunoTableSelectColumn",
  "BrunoTableServer",
  "BrunoTableTextColumn",
  "BrunoTableToolbar",
  "BrunoTableToolbarSpacer",
].toSorted((left, right) => left.localeCompare(right));

if (JSON.stringify(actualServerRuntimeExports) !== JSON.stringify(expectedServerRuntimeExports)) {
  throw new Error(
    "The @bruno/table/server runtime exports do not match the strict Server surface.",
  );
}

const serverExportedNames = collectDeclarationExportNames(serverDeclarationSet.entry);
for (const exportedName of [
  ...expectedServerRuntimeExports,
  "BrunoTableColumns",
  "BrunoTableServerProps",
  "BrunoTableServerSource",
]) {
  if (!serverExportedNames.includes(exportedName)) {
    throw new Error(`The @bruno/table/server declarations are missing ${exportedName}.`);
  }
}
for (const clientOnlyName of [
  "BrunoTableClient",
  "BrunoTableClientProps",
  "BrunoTableEditableCapability",
]) {
  if (serverExportedNames.includes(clientOnlyName)) {
    throw new Error(`The @bruno/table/server declarations must not expose ${clientOnlyName}.`);
  }
}

const effectExportedNames = collectDeclarationExportNames(effectDeclarationSet.entry);
if (
  JSON.stringify(effectExportedNames.toSorted((left, right) => left.localeCompare(right))) !==
  JSON.stringify(expectedEffectRuntimeExports.toSorted((left, right) => left.localeCompare(right)))
) {
  throw new Error("The @bruno/table/effect declaration exports do not match its runtime surface.");
}

function collectDeclarationExportNames(source: string) {
  if (/^\s*export\s+(?:type\s+)?\*\s+from\b/gmu.test(source)) {
    throw new UninspectableWildcardExportError(
      "The declaration entry contains a wildcard export whose names cannot be validated.",
    );
  }

  const names = [];

  for (const [, exportList] of source.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]*)\}/gmu)) {
    for (const exportedName of exportList.split(",")) {
      const name = exportedName
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u)
        .at(-1);

      if (name) {
        names.push(name);
      }
    }
  }

  for (const [, name] of source.matchAll(
    /^\s*export\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/gmu,
  )) {
    names.push(name);
  }

  for (const [, name] of source.matchAll(
    /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|enum|function|interface|namespace|type|const|let|var)\s+([A-Za-z_$][\w$]*)/gmu,
  )) {
    names.push(name);
  }

  if (/^\s*export\s+default\b/gmu.test(source)) {
    names.push("default");
  }

  return [...new Set(names)];
}

function hasInternalExportTarget(value: unknown) {
  if (typeof value === "string") {
    return /^\.\/dist\/internal(?:\/|$)/u.test(value);
  }

  if (Array.isArray(value)) {
    return value.some(hasInternalExportTarget);
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasInternalExportTarget);
  }

  return false;
}

function hasExactStringRecord(actual: unknown, expected: Record<string, string>) {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return false;
  }

  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);

  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every(
      (key) => Object.hasOwn(actual, key) && Reflect.get(actual, key) === expected[key],
    )
  );
}

function findImportedBinding(ast: ESTree.Program, source: string, importedName: string) {
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== source) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      const imported =
        specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : specifier.imported.value;
      if (imported === importedName) return specifier.local.name;
    }
  }
  return undefined;
}

function assertKeyboardBoundary(ast: SyntaxNode, label: string, mode: string) {
  let violation: string | undefined;
  walkSyntaxTree(ast, (node, ancestors) => {
    if (violation !== undefined) return;
    const parent = ancestors.at(-1);
    const handlerProperty = keyboardHandlerPropertyName(node);
    const allowsHandlerEvidence = mode === "native-evidence";
    if (!allowsHandlerEvidence && handlerProperty !== undefined) {
      violation = `${handlerProperty} keyboard handler`;
      return;
    }
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
      const listenerMethod = memberPropertyName(node.callee);
      if (listenerMethod === "addEventListener" || listenerMethod === "removeEventListener") {
        const eventType = staticStringValue(node.arguments[0]);
        if (eventType === undefined) {
          violation = `${listenerMethod} non-static listener event type`;
          return;
        }
        if (isKeyboardEventType(eventType) && mode !== "native-evidence") {
          violation = `${listenerMethod} keyboard listener`;
          return;
        }
        if (
          mode === "produced-text-evidence" &&
          !["compositionstart", "beforeinput", "compositionend"].includes(eventType)
        ) {
          violation = `${listenerMethod} unsupported produced-text listener`;
          return;
        }
      }
    }
    if (mode !== "adapter" && mode !== "emitted" && isReactHotkeysModuleReference(node)) {
      violation = "React Hotkeys module reference outside the approved Adapter boundary";
      return;
    }
    if (isTanStackHotkeysCoreModuleReference(node)) {
      violation = "TanStack Hotkeys core reference outside React Hotkeys";
      return;
    }
    if (
      mode === "production" &&
      ((node.type === "Identifier" &&
        ["KeyboardEvent", "ReactKeyboardEvent", "KeyboardEventHandler"].includes(node.name)) ||
        (node.type === "Literal" &&
          typeof node.value === "string" &&
          ["KeyboardEvent", "ReactKeyboardEvent", "KeyboardEventHandler"].includes(node.value)))
    ) {
      violation = "raw keyboard event type outside an approved evidence boundary";
      return;
    }
    if (
      (mode === "adapter" || mode === "native-evidence" || mode === "produced-text-evidence") &&
      ((node.type === "MemberExpression" &&
        isKeyboardInterpretationProperty(memberPropertyName(node))) ||
        (node.type === "Property" &&
          parent?.type === "ObjectPattern" &&
          isKeyboardInterpretationProperty(propertyName(node))))
    ) {
      violation = `manual keyboard ${String(
        node.type === "MemberExpression" ? memberPropertyName(node) : propertyName(node),
      )} interpretation inside an approved evidence boundary`;
      return;
    }
    if (
      mode === "production" &&
      ((node.type === "MemberExpression" && isRawModifierProperty(memberPropertyName(node))) ||
        (node.type === "Property" &&
          parent?.type === "ObjectPattern" &&
          isRawModifierProperty(propertyName(node))))
    ) {
      violation = `manual ${String(
        node.type === "MemberExpression" ? memberPropertyName(node) : propertyName(node),
      )} modifier interpretation outside the React Hotkeys Adapter`;
      return;
    }
  });
  if (violation !== undefined) {
    throw new Error(`${label} violates the BrunoTable keyboard boundary: ${String(violation)}.`);
  }
}

function assertEmittedProducedTextEvidence(ast: ESTree.Program, requireInstaller = true) {
  const installer = ast.body.find(
    (statement) =>
      statement.type === "FunctionDeclaration" &&
      statement.id?.name === "installBrunoTableProducedTextEvidence",
  );
  if (installer === undefined && requireInstaller) {
    throw new Error("The emitted package lost the produced-text evidence installer.");
  }
  const lifecycleTypes = new Set([
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "beforeinput",
  ]);
  const allowedTypes = new Set(["compositionstart", "beforeinput", "compositionend"]);
  const lifecycleCounts = new Map<string, number>();
  let violation = "";
  walkSyntaxTree(ast, (node, ancestors) => {
    if (violation.length > 0 || node.type !== "CallExpression") return;
    if (node.callee.type !== "MemberExpression") return;
    const listenerMethod = memberPropertyName(node.callee);
    if (listenerMethod !== "addEventListener" && listenerMethod !== "removeEventListener") return;
    const eventType = staticStringValue(node.arguments[0]);
    if (eventType === undefined || !lifecycleTypes.has(eventType)) return;
    if (installer === undefined || !ancestors.includes(installer)) {
      violation = `${listenerMethod}(${eventType}) escaped the emitted produced-text installer`;
      return;
    }
    if (!allowedTypes.has(eventType)) {
      violation = `${listenerMethod}(${eventType}) is an unsupported produced-text lifecycle`;
      return;
    }
    const key = `${listenerMethod}:${eventType}`;
    lifecycleCounts.set(key, (lifecycleCounts.get(key) ?? 0) + 1);
  });
  if (violation.length > 0) throw new Error(`Emitted produced-text evidence: ${violation}.`);
  if (installer === undefined) return;
  for (const listenerMethod of ["addEventListener", "removeEventListener"]) {
    for (const eventType of allowedTypes) {
      const key = `${listenerMethod}:${eventType}`;
      if (lifecycleCounts.get(key) !== 1) {
        throw new Error(`Emitted produced-text evidence expected exactly one ${key} lifecycle.`);
      }
    }
  }
  assertKeyboardBoundary(
    installer,
    "emitted produced-text evidence installer",
    "produced-text-evidence",
  );
}

function assertEmittedProducedTextEvidenceViolationDetected(ast: ESTree.Program, expected: string) {
  try {
    assertEmittedProducedTextEvidence(ast);
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) return;
    throw error;
  }
  throw new Error(`The emitted produced-text evidence accepted ${expected}.`);
}

function assertKeyboardBoundaryViolationDetected(ast: ESTree.Program, mode: string) {
  try {
    assertKeyboardBoundary(ast, "keyboard boundary rejection smoke fixture", mode);
  } catch (error) {
    if (error instanceof Error && error.message.includes("BrunoTable keyboard boundary")) {
      return;
    }
    throw error;
  }
  throw new Error("The BrunoTable keyboard boundary accepted a forbidden production shape.");
}

function keyboardHandlerPropertyName(node: SyntaxNode) {
  if (
    node.type === "JSXAttribute" &&
    node.name?.type === "JSXIdentifier" &&
    [
      "onKeyDown",
      "onKeyUp",
      "onKeyPress",
      "onKeyDownCapture",
      "onKeyUpCapture",
      "onKeyPressCapture",
    ].includes(node.name.name)
  ) {
    return node.name.name;
  }
  const name =
    node.type === "Property"
      ? propertyName(node)
      : node.type === "MemberExpression"
        ? memberPropertyName(node)
        : undefined;
  return [
    "onKeyDown",
    "onKeyUp",
    "onKeyPress",
    "onKeyDownCapture",
    "onKeyUpCapture",
    "onKeyPressCapture",
    "onkeydown",
    "onkeyup",
    "onkeypress",
  ].includes(name ?? "")
    ? name
    : undefined;
}

function isKeyboardInterpretationProperty(name: string | undefined) {
  return [
    "key",
    "code",
    "keyCode",
    "which",
    "charCode",
    "location",
    "repeat",
    "ctrlKey",
    "metaKey",
    "altKey",
    "shiftKey",
    "getModifierState",
  ].includes(name ?? "");
}

function isRawModifierProperty(name: string | undefined) {
  return ["ctrlKey", "metaKey", "altKey", "shiftKey", "getModifierState"].includes(name ?? "");
}

function staticStringValue(node: SyntaxNode | null | undefined) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return undefined;
}

function isKeyboardEventType(value: string | undefined) {
  return value === "keydown" || value === "keyup" || value === "keypress";
}

function isReactHotkeysModuleReference(node: SyntaxNode) {
  if (
    (node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration") &&
    staticStringValue(node.source) === "@tanstack/react-hotkeys"
  ) {
    return true;
  }
  return (
    node.type === "ImportExpression" && staticStringValue(node.source) === "@tanstack/react-hotkeys"
  );
}

function isTanStackHotkeysCoreModuleReference(node: SyntaxNode) {
  if (
    (node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration") &&
    staticStringValue(node.source) === "@tanstack/hotkeys"
  ) {
    return true;
  }
  return node.type === "ImportExpression" && staticStringValue(node.source) === "@tanstack/hotkeys";
}

function propertyName(property: SyntaxNode) {
  if (property.type !== "Property") return undefined;
  const key = property.key;
  if (key?.type === "Identifier" && !property.computed) return key.name;
  return staticStringValue(key);
}

function collectEffectCallbacks(ast: ESTree.Program | FunctionNode, layoutEffectBinding: string) {
  const callbacks: FunctionNode[] = [];
  walkSyntaxTree(ast, (node, ancestors) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "Identifier" ||
      node.callee.name !== layoutEffectBinding
    ) {
      return;
    }
    const callback = node.arguments[0];
    if (isFunctionNode(callback)) {
      callbacks.push(callback);
      return;
    }
    if (callback?.type !== "Identifier") return;
    const owner = ancestors.findLast(isFunctionNode) ?? ast;
    callbacks.push(...findAssignedFunctions(owner, callback.name));
  });
  return callbacks;
}

function findAssignedFunctions(owner: ESTree.Program | FunctionNode, bindingName: string) {
  const functions: FunctionNode[] = [];
  if (owner.type === "Program") {
    for (const statement of owner.body) {
      if (
        statement.type === "FunctionDeclaration" &&
        isFunctionNode(statement) &&
        statement.id?.name === bindingName
      ) {
        functions.push(statement);
      }
    }
  }
  walkOwnerScope(owner.type === "Program" ? owner : owner.body, (node) => {
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier" &&
      node.left.name === bindingName &&
      isFunctionNode(node.right)
    ) {
      functions.push(node.right);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === bindingName &&
      isFunctionNode(node.init)
    ) {
      functions.push(node.init);
    }
  });
  return functions;
}

function walkOwnerScope(node: SyntaxNode, visit: (node: SyntaxNode) => void) {
  visit(node);
  for (const child of syntaxChildren(node)) {
    if (isFunctionNode(child)) continue;
    walkOwnerScope(child, visit);
  }
}

function syntaxTreeContains(node: SyntaxNode, predicate: (node: SyntaxNode) => boolean) {
  let matched = false;
  walkSyntaxTree(node, (candidate) => {
    if (predicate(candidate)) matched = true;
  });
  return matched;
}

function walkSyntaxTree(
  node: SyntaxNode | null | undefined,
  visit: Visitor,
  ancestors: readonly SyntaxNode[] = [],
) {
  if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
  visit(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const child of syntaxChildren(node)) walkSyntaxTree(child, visit, nextAncestors);
}

// Values originate exclusively from the parser's typed AST. Reflection visits child
// nodes without treating ordinary metadata objects as syntax.
function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    value !== null && typeof value === "object" && "type" in value && typeof value.type === "string"
  );
}
function syntaxChildren(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isSyntaxNode(child)) children.push(child);
    } else if (isSyntaxNode(value)) children.push(value);
  }
  return children;
}

function isFunctionNode(node: SyntaxNode | null | undefined): node is FunctionNode {
  return (
    node?.type === "ArrowFunctionExpression" ||
    (node?.type === "FunctionExpression" && node.body !== null) ||
    (node?.type === "FunctionDeclaration" && node.body !== null)
  );
}

function memberPropertyName(member: ESTree.MemberExpression) {
  if (member.property.type === "Identifier" && !member.computed) return member.property.name;
  return staticStringValue(member.property);
}

function isRowAcceptanceCall(node: SyntaxNode) {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    memberPropertyName(node.callee) === "acceptRows"
  );
}

function isMutationObserverConstruction(node: SyntaxNode) {
  return (
    node.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "MutationObserver"
  );
}

function isInertBoundaryRemovalCall(node: SyntaxNode) {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    memberPropertyName(node.callee) === "removeAttribute" &&
    node.arguments[0]?.type === "Literal" &&
    node.arguments[0].value === "inert"
  );
}

function assertNonTabbableDomOwnership(ast: ESTree.Program) {
  const fail = () => {
    throw new Error("The production package lost shared non-tabbable DOM ownership lifecycle.");
  };
  const component = ast.body.find(
    (node): node is ESTree.Function & { type: "FunctionDeclaration"; body: ESTree.FunctionBody } =>
      isFunctionNode(node) &&
      node.type === "FunctionDeclaration" &&
      node.id?.name === "NonTabbableCellContent",
  );
  const manager = ast.body.find(
    (node): node is ESTree.Function & { type: "FunctionDeclaration"; body: ESTree.FunctionBody } =>
      isFunctionNode(node) &&
      node.type === "FunctionDeclaration" &&
      node.id?.name === "createNonTabbableGridManager",
  );
  const effect = findImportedBinding(ast, "react", "useEffect");
  if (component === undefined || manager === undefined || effect === undefined) return fail();
  const memberCall = (
    node: SyntaxNode | null | undefined,
    owner: string,
    method: string,
    firstArgument?: string,
    secondArgument?: string,
  ) =>
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === owner &&
    memberPropertyName(node.callee) === method &&
    (firstArgument === undefined ||
      (node.arguments[0]?.type === "Identifier" && node.arguments[0].name === firstArgument) ||
      staticStringValue(node.arguments[0]) === firstArgument) &&
    (secondArgument === undefined ||
      (node.arguments[1]?.type === "Identifier" && node.arguments[1].name === secondArgument));
  const factoryCall = (node: SyntaxNode) =>
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "createNonTabbableGridManager";
  if (
    !collectEffectCallbacks(component, effect).some((callback) => {
      let bindsFactoryResult = false;
      let returnsRegistration = false;
      let managerDeclarations = 0;
      const hasOwnerDeclaration =
        callback.body.type === "BlockStatement" &&
        callback.body.body.some(
          (statement) =>
            statement.type === "VariableDeclaration" &&
            statement.declarations.some(
              (declaration) =>
                declaration.id.type === "Identifier" && declaration.id.name === "manager",
            ),
        );
      walkOwnerScope(callback.body, (node) => {
        if (
          node.type === "VariableDeclarator" &&
          node.id.type === "Identifier" &&
          node.id.name === "manager"
        ) {
          managerDeclarations += 1;
        }
        if (
          (node.type === "VariableDeclarator" &&
            node.id.type === "Identifier" &&
            node.id.name === "manager" &&
            node.init !== null &&
            factoryCall(node.init)) ||
          (node.type === "AssignmentExpression" &&
            node.operator === "=" &&
            node.left.type === "Identifier" &&
            node.left.name === "manager" &&
            factoryCall(node.right))
        ) {
          bindsFactoryResult = true;
        }
        if (
          node.type === "ReturnStatement" &&
          memberCall(node.argument, "manager", "register", "root")
        ) {
          returnsRegistration = true;
        }
      });
      return (
        hasOwnerDeclaration &&
        managerDeclarations === 1 &&
        bindsFactoryResult &&
        returnsRegistration
      );
    })
  )
    return fail();
  if (
    !syntaxTreeContains(
      component,
      (node) =>
        node.type === "ObjectExpression" &&
        node.properties.some(
          (property) =>
            propertyName(property) === "inert" &&
            property.type === "Property" &&
            property.value.type === "Literal" &&
            property.value.value === true,
        ) &&
        node.properties.some(
          (property) => propertyName(property) === "data-bruno-nontabbable-cell-content",
        ),
    )
  )
    return fail();
  if (
    !syntaxTreeContains(manager, isMutationObserverConstruction) ||
    !syntaxTreeContains(manager, (node) => memberCall(node, "observer", "observe", "grid")) ||
    !syntaxTreeContains(manager, (node) =>
      memberCall(node, "grid", "addEventListener", "focusin", "trackFocusedCandidate"),
    )
  )
    return fail();
  let registration: FunctionNode | undefined;
  walkSyntaxTree(manager, (node) => {
    if (
      node.type === "Property" &&
      propertyName(node) === "register" &&
      isFunctionNode(node.value)
    ) {
      registration = node.value;
    }
  });
  if (registration?.body.type !== "BlockStatement") return fail();
  const statements = registration.body.body;
  const reconcileIndex = statements.findIndex(
    (node) =>
      node.type === "ExpressionStatement" &&
      node.expression.type === "CallExpression" &&
      node.expression.callee.type === "Identifier" &&
      node.expression.callee.name === "reconcileRoot" &&
      node.expression.arguments[0]?.type === "Identifier" &&
      node.expression.arguments[0].name === "root",
  );
  const inertIndex = statements.findIndex(
    (node) => node.type === "ExpressionStatement" && isInertBoundaryRemovalCall(node.expression),
  );
  const cleanupIndex = statements.findIndex(
    (node) => node.type === "ReturnStatement" && isFunctionNode(node.argument),
  );
  const cleanupStatement = statements[cleanupIndex];
  const cleanup =
    cleanupStatement?.type === "ReturnStatement" && isFunctionNode(cleanupStatement.argument)
      ? cleanupStatement.argument
      : undefined;
  if (
    reconcileIndex < 0 ||
    inertIndex <= reconcileIndex ||
    cleanupIndex <= inertIndex ||
    cleanup === undefined
  )
    return fail();
  for (const [owner, method, argument, secondArgument] of [
    ["roots", "delete", "root"],
    ["observer", "disconnect"],
    ["grid", "removeEventListener", "focusin", "trackFocusedCandidate"],
    ["nonTabbableGridManagers", "delete", "grid"],
  ]) {
    if (
      !syntaxTreeContains(cleanup, (node) =>
        memberCall(node, owner, method, argument, secondArgument),
      )
    )
      return fail();
  }
}

async function assertPackedConsumers() {
  const packRoot = await mkdtemp(join(tmpdir(), "bruno-table-pack-"));
  const controller = new AbortController();
  const signal = controller.signal;
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    await runCommand(
      signal,
      "vp",
      ["pm", "pack", "--pack-destination", packRoot],
      packageRoot,
      "package tarball",
    );
    const shadcnRoot = join(packageRoot, "../ui");
    await runCommand(
      signal,
      "vp",
      ["pm", "pack", "--pack-destination", packRoot],
      shadcnRoot,
      "shadcn package tarball",
    );
    await runCommand(
      signal,
      "vp",
      ["pm", "pack", "--pack-destination", packRoot],
      join(packageRoot, "../view-server-client"),
      "SDK package tarball",
    );
    const tarballNames = (await readdir(packRoot)).filter((fileName) => fileName.endsWith(".tgz"));
    if (tarballNames.length !== 3) {
      throw new Error(
        `pnpm pack produced ${tarballNames.length} tarballs; expected exactly three (${tarballNames.join(", ") || "none"}).`,
      );
    }
    const tableTarballName = tarballNames.find((fileName) => fileName.startsWith("bruno-table-"));
    const shadcnTarballName = tarballNames.find((fileName) => fileName.startsWith("bruno-shadcn-"));
    if (!tableTarballName || !shadcnTarballName) {
      throw new Error(
        `Packed tarballs did not contain the expected table and shadcn packages (${tarballNames.join(", ")}).`,
      );
    }
    const tarball = join(packRoot, tableTarballName);
    const shadcnTarball = join(packRoot, shadcnTarballName);

    const sdkTarballName = tarballNames.find((name) =>
      name.startsWith("bruno-view-server-client-"),
    );
    if (!sdkTarballName) throw new Error("Missing SDK tarball");
    const sdkTarball = join(packRoot, sdkTarballName);
    await assertPackedRootConsumer(tarball, shadcnTarball, sdkTarball, signal);
    await assertPackedEffectConsumer(tarball, shadcnTarball, sdkTarball, signal);
  } finally {
    try {
      await rm(packRoot, { recursive: true, force: true });
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
  signal.throwIfAborted();
}

async function assertPackedRootConsumer(
  tarball: string,
  shadcnTarball: string,
  sdkTarball: string,
  signal: AbortSignal,
) {
  const consumerRoot = await createPackedConsumer(
    "bruno-table-root-consumer-",
    tarball,
    shadcnTarball,
    false,
    sdkTarball,
    signal,
  );
  try {
    await writeFile(
      join(consumerRoot, "index.tsx"),
      `import { BrunoTableClient, BrunoTableQuickFilter, BrunoTableTextColumn, BrunoTableToolbar } from "@bruno/table";
import type { BrunoTableColumns } from "@bruno/table";

type Row = { readonly symbol: string; readonly revision: bigint };
const columns = [
  BrunoTableTextColumn({
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    isEditable: true,
  }),
] satisfies BrunoTableColumns<Row>;
void columns;
const source = { rows: [] as readonly Row[], totalRows: 0, version: 1, status: "ready" as const };
const quickFilterFields = ["symbol"] as const;
const rendered = (
  <BrunoTableClient
    tableId="TABLE_ID_PACKED"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_SYMBOL", direction: "asc" }]}
    getRowId={(row) => row.symbol}
    quickFilterFields={quickFilterFields}
    clientSource={source}
  >
    <BrunoTableToolbar>
      <BrunoTableQuickFilter />
    </BrunoTableToolbar>
  </BrunoTableClient>
);
void rendered;
const missingOrder = (
  // @ts-expect-error Packed JSX Client usage requires initialOrderBy.
  <BrunoTableClient
    tableId="TABLE_ID_PACKED_MISSING_ORDER"
    columns={columns}
    getRowId={(row) => row.symbol}
    clientSource={source}
  />
);
void missingOrder;
const emptyOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_PACKED_EMPTY_ORDER"
    columns={columns}
    // @ts-expect-error Packed JSX Client usage rejects an empty initialOrderBy.
    initialOrderBy={[]}
    getRowId={(row) => row.symbol}
    clientSource={source}
  />
);
void emptyOrder;
const invalidOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_PACKED_INVALID_ORDER"
    columns={columns}
    initialOrderBy={[
      // @ts-expect-error Packed JSX preserves exact sortable Column Identity inference.
      { columnId: "COL_ID_UNKNOWN", direction: "asc" },
    ]}
    getRowId={(row) => row.symbol}
    clientSource={source}
  />
);
void invalidOrder;
const readOnlyWithEditOperation = (
  <BrunoTableClient
    tableId="TABLE_ID_PACKED_READ_ONLY"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_SYMBOL", direction: "asc" }]}
    getRowId={(row) => row.symbol}
    clientSource={source}
    editable={false}
    // @ts-expect-error Packed read-only JSX Client usage rejects getRowVersion.
    getRowVersion={(row: Row) => row.revision}
    // @ts-expect-error Packed read-only JSX Client usage rejects onSaveEdits.
    onSaveEdits={() => Promise.resolve()}
  />
);
void readOnlyWithEditOperation;
const toolbar = BrunoTableToolbar({ children: "Filters" });
void toolbar;
`,
    );
    await writeFile(
      join(consumerRoot, "runtime.ts"),
      'export {};\nawait import("@bruno/table");\n',
    );
    await writeFile(
      join(consumerRoot, "style-entry.ts"),
      'import "./bruno-table.css";\nimport { BrunoTableClient } from "@bruno/table";\nconsole.log(BrunoTableClient);\n',
    );
    await writeFile(
      join(consumerRoot, "bruno-table.css"),
      '@import "@bruno/shadcn/styles.css";\n@source "./node_modules/@bruno/table/dist";\n',
    );
    await writeFile(
      join(consumerRoot, "vite.config.ts"),
      'import tailwindcss from "@tailwindcss/vite";\nimport { defineConfig } from "vite";\nexport default defineConfig(({ mode }) => ({ plugins: [tailwindcss()], define: { "process.env.NODE_ENV": JSON.stringify(mode === "diagnostics" ? "development" : "production") } }));\n',
    );
    await writeFile(
      join(consumerRoot, "index.html"),
      '<!doctype html><html><body><script type="module" src="/style-entry.ts"></script></body></html>\n',
    );

    await assertInstalledGraphExcludesEffect(consumerRoot);
    const usage = await readFile(new URL("../USAGE.md", import.meta.url), "utf8");
    const examples = [...usage.matchAll(/```tsx\n([\s\S]*?)```/gu)];
    for (const [index, example] of examples.entries()) {
      if (
        example[1].startsWith("import ") &&
        !example[1].includes('"@bruno/table/rust"')
      ) {
        await writeFile(join(consumerRoot, `documentation-${index}.tsx`), example[1]);
      }
    }
    await runTypeScriptConsumer(signal, consumerRoot, "Effect-free @bruno/table root consumer");
    await runCommand(
      signal,
      process.execPath,
      ["runtime.ts"],
      consumerRoot,
      "Effect-free root runtime",
    );
    await cp(
      new URL("./fixtures/packed-consumer/diagnostics.ts", import.meta.url),
      join(consumerRoot, "diagnostics.ts"),
    );
    await cp(
      new URL("./fixtures/packed-consumer/diagnostics.config.ts", import.meta.url),
      join(consumerRoot, "diagnostics.config.ts"),
    );
    await runCommand(
      signal,
      "vp",
      ["build", "--config", "diagnostics.config.ts"],
      consumerRoot,
      "Installed diagnostic environment build",
    );
    await runCommand(
      signal,
      process.execPath,
      ["diagnostics-dist/diagnostics.js"],
      consumerRoot,
      "Installed diagnostic environments",
    );
    await runCommand(signal, "vp", ["build"], consumerRoot, "Styled packed Vite consumer");
    const assetRoot = join(consumerRoot, "dist", "assets");
    await assertBundledIdentityDiagnostics(assetRoot, false);
    const cssAssets = (await readdir(assetRoot)).filter((fileName) => fileName.endsWith(".css"));
    if (cssAssets.length === 0) {
      throw new Error("The styled packed Vite consumer emitted no CSS asset.");
    }
    const css = await Promise.all(
      cssAssets.map((fileName) => readFile(join(assetRoot, fileName), "utf8")),
    );
    if (!css.some((asset) => asset.includes("data-bruno-table"))) {
      throw new Error("The styled packed Vite consumer omitted BrunoTable utility styles.");
    }
    await runCommand(
      signal,
      "vp",
      ["build", "--mode", "diagnostics", "--outDir", "dist-diagnostics"],
      consumerRoot,
      "Development-diagnostic packed Vite consumer",
      { NODE_ENV: "development" },
    );
    await assertBundledIdentityDiagnostics(join(consumerRoot, "dist-diagnostics", "assets"), true);
    await assertInstalledHydration(consumerRoot, signal);
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
}

async function assertBundledIdentityDiagnostics(assetRoot: string, expected: boolean) {
  const javascriptAssets = (await readdir(assetRoot)).filter((fileName) =>
    fileName.endsWith(".js"),
  );
  const javascript = (
    await Promise.all(
      javascriptAssets.map((fileName) => readFile(join(assetRoot, fileName), "utf8")),
    )
  ).join("\n");
  const present = javascript.includes("simultaneous use of tableId");
  if (present !== expected) {
    throw new Error(
      expected
        ? "The development packed consumer removed Table Identity diagnostics."
        : "The production packed consumer retained Table Identity diagnostics.",
    );
  }
}

async function assertPackedEffectConsumer(
  tarball: string,
  shadcnTarball: string,
  sdkTarball: string,
  signal: AbortSignal,
) {
  const consumerRoot = await createPackedConsumer(
    "bruno-table-effect-consumer-",
    tarball,
    shadcnTarball,
    true,
    sdkTarball,
    signal,
  );
  try {
    await writeFile(
      join(consumerRoot, "index.ts"),
      `import * as BigDecimal from "effect/BigDecimal";
import { BrunoTableBigDecimalColumn } from "@bruno/table/effect";
import type { BrunoTableColumns } from "@bruno/table";

type Row = { readonly price: BigDecimal.BigDecimal };
const columns = [
  BrunoTableBigDecimalColumn({
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    aggFunc: "sum",
    aggregateValueFormatter: ({ value }) => BigDecimal.format(value),
  }),
] satisfies BrunoTableColumns<Row>;
void columns;
`,
    );
    const usage = await readFile(new URL("../USAGE.md", import.meta.url), "utf8");
    const rustExamples = [...usage.matchAll(/```tsx\n([\s\S]*?)```/gu)].filter(
      (example) =>
        example[1].startsWith("import ") && example[1].includes('"@bruno/table/rust"'),
    );
    if (rustExamples.length === 0) {
      throw new Error("The packed Effect consumer must compile the documented Rust integration.");
    }
    for (const [index, example] of rustExamples.entries()) {
      await writeFile(join(consumerRoot, `documentation-rust-${index}.tsx`), example[1]);
    }
    await writeFile(
      join(consumerRoot, "runtime.ts"),
      `import assert from "node:assert/strict";
import * as BigDecimal from "effect/BigDecimal";
import { BrunoTableBigDecimalValueType } from "@bruno/table/effect";

const large = BigDecimal.fromStringUnsafe("-9007199254740993123456789.0000000000000000001");
assert.equal(
  BrunoTableBigDecimalValueType.formatCanonicalText(large),
  "-9.0071992547409931234567890000000000000000001e+24",
);
const fractional = BrunoTableBigDecimalValueType.parseCanonicalText("-0.000000000000000000125");
assert.equal(fractional._tag, "Success");
const onePointFive = BigDecimal.fromStringUnsafe("1.5");
const differentlyScaled = BigDecimal.make(1500n, 3);
assert.equal(BrunoTableBigDecimalValueType.equivalent(onePointFive, differentlyScaled), true);
assert.equal(BrunoTableBigDecimalValueType.compare(large, onePointFive), -1);
assert.equal(BrunoTableBigDecimalValueType.parseCanonicalText("not-a-decimal")._tag, "Failure");
assert.equal(BrunoTableBigDecimalValueType.decodeRuntime({ value: 15n, scale: 1 })._tag, "Failure");

const foreignPrototype: object = Object.create(null, {
  "~effect/BigDecimal": { value: "~effect/BigDecimal" },
});
const foreign: unknown = Object.create(foreignPrototype, {
  value: { value: 150n, enumerable: true },
  scale: { value: 2, enumerable: true },
});
const admitted = BrunoTableBigDecimalValueType.decodeRuntime(foreign);
assert.equal(admitted._tag, "Success");
if (admitted._tag === "Success") {
  assert.notEqual(admitted.value, foreign);
  assert.equal(Object.isFrozen(admitted.value), true);
  assert.equal(BigDecimal.format(admitted.value), "1.5");
}
`,
    );

    await runTypeScriptConsumer(signal, consumerRoot, "packed @bruno/table/effect consumer");
    await runCommand(
      signal,
      process.execPath,
      ["runtime.ts"],
      consumerRoot,
      "packed BigDecimal runtime",
    );
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
}

async function createPackedConsumer(
  prefix: string,
  tarball: string,
  shadcnTarball: string,
  includeEffect: boolean,
  sdkTarball: string,
  signal: AbortSignal,
) {
  const consumerRoot = await mkdtemp(join(tmpdir(), prefix));
  try {
    await cp(
      new URL("../../../patches/babel-plugin-react-compiler@1.0.0.patch", import.meta.url),
      join(consumerRoot, "compiler.patch"),
    );
    const rootManifest = record(
      JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")),
    );
    const devEngines = record(rootManifest.devEngines);
    const packageManager = record(devEngines.packageManager);
    const engines = record(rootManifest.engines);
    if (
      packageManager.name !== "pnpm" ||
      typeof packageManager.version !== "string" ||
      typeof engines.node !== "string"
    ) {
      throw new Error("Packed consumer requires the repository's pinned pnpm and Node toolchain");
    }
    await writeFile(
      join(consumerRoot, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        devEngines,
        engines,
        dependencies: {
          "@bruno/table": `file:${tarball}`,
          "@bruno/shadcn": `file:${shadcnTarball}`,
          "@bruno/view-server-client": `file:${sdkTarball}`,
          "@types/react": "19.3.0",
          "@types/react-dom": "19.3.0",
          typescript: "7.0.2",
          ...(includeEffect
            ? {}
            : {
                "@tailwindcss/vite": "4.3.3",
                tailwindcss: "4.3.3",
                vite: "npm:@voidzero-dev/vite-plus-core@1.0.0",
                "vite-plus": "1.0.0",
                "@vitejs/plugin-react": "6.1.2",
                "@babel/core": "7.29.7",
                "@rolldown/plugin-babel": "0.2.4",
                "babel-plugin-react-compiler": "1.0.0",
                "@vitest/browser-playwright": "5.0.1",
                playwright: "1.63.0",
              }),
          ...(includeEffect
            ? {
                effect: "4.0.0-rc.111",
                "effect-view-server": "4.2.8",
                "@effect/atom-react": "4.0.0-rc.111",
                "@types/node": "26.6.4",
              }
            : {}),
          react: "19.3.0",
          "react-dom": "19.3.0",
        },
      }),
    );
    // The selected pnpm reads patches and overrides from the workspace configuration.
    // Every private dependency must resolve to the archive under test, including
    // transitive table dependencies; no unpublished package may hit the registry.
    await writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      [
        "packages: []",
        yamlStringMapping("overrides", {
          "@bruno/table": `file:${tarball}`,
          "@bruno/shadcn": `file:${shadcnTarball}`,
          "@bruno/view-server-client": `file:${sdkTarball}`,
          ...(includeEffect ? {} : { "vite@*": "npm:@voidzero-dev/vite-plus-core@1.0.0" }),
        }),
        yamlStringMapping(
          "patchedDependencies",
          includeEffect ? {} : { "babel-plugin-react-compiler@1.0.0": "compiler.patch" },
        ),
        ...(includeEffect
          ? []
          : [
              "peerDependencyRules:",
              "  allowAny:",
              "    - vite",
              "  allowedVersions:",
              '    vite: "*"',
            ]),
        "",
      ].join("\n"),
    );
    await writeFile(
      join(consumerRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          lib: ["esnext", "dom"],
          types: includeEffect ? ["node"] : [],
          skipLibCheck: false,
        },
        include: [
          "runtime.ts",
          "index.ts",
          "index.tsx",
          "documentation-*.tsx",
          "contracts-*.ts",
          "contracts-*.tsx",
        ],
      }),
    );
    await runCommand(
      signal,
      "vp",
      ["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"],
      consumerRoot,
      "packed consumer install",
    );
    if (includeEffect) {
      for (const [source, destination] of [
        ["emitted-consumer/index.ts", "contracts-server.ts"],
        ["emitted-consumer/jsx.tsx", "contracts-jsx.tsx"],
        ["emitted-effect-consumer/index.ts", "contracts-effect.ts"],
      ]) {
        await cp(new URL(`../tests/${source}`, import.meta.url), join(consumerRoot, destination));
      }
    }
    return consumerRoot;
  } catch (error) {
    await rm(consumerRoot, { recursive: true, force: true });
    throw error;
  }
}

async function assertInstalledGraphExcludesEffect(consumerRoot: string) {
  const nodeModules = join(consumerRoot, "node_modules");
  const nodeModulesEntries = existsSync(nodeModules) ? await readdir(nodeModules) : [];
  const virtualStore = join(consumerRoot, "node_modules", ".pnpm");
  const virtualStoreEntries = existsSync(virtualStore) ? await readdir(virtualStore) : [];
  if (installedGraphContainsEffect(nodeModulesEntries, virtualStoreEntries)) {
    throw new Error("The clean root consumer dependency graph contains Effect or View Server.");
  }
}

function installedGraphContainsEffect(
  nodeModulesEntries: readonly string[],
  virtualStoreEntries: readonly string[],
) {
  return (
    nodeModulesEntries.some((entry) => /^(?:@effect|effect|effect-view-server)$/u.test(entry)) ||
    virtualStoreEntries.some((entry) => /^(?:@effect\+|effect@|effect-view-server@)/u.test(entry))
  );
}

function isEffectModuleSpecifier(specifier: string) {
  return (
    specifier === "effect" ||
    specifier.startsWith("effect/") ||
    specifier.startsWith("@effect/") ||
    specifier === "effect-view-server" ||
    specifier.startsWith("effect-view-server/")
  );
}

async function runTypeScriptConsumer(signal: AbortSignal, consumerRoot: string, label: string) {
  await runCommand(
    signal,
    "vp",
    ["exec", "tsc", "--project", "tsconfig.json"],
    consumerRoot,
    label,
  );
}

async function runCommand(
  signal: AbortSignal,
  command: string,
  parameters: string[],
  cwd: string,
  label: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  const result = await ownedCommand([command, ...parameters], {
    cwd,
    env: { ...isolatedProcessEnvironment(cwd), ...extraEnvironment },
    signal,
    timeoutMs: 180000,
    check: false,
  });
  if (result.code !== 0) {
    throw new Error(`${label} failed.\n${result.stdout}${result.stderr}`);
  }
}
