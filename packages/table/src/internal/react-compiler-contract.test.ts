import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAstAsync } from "vite";
import { describe, expect, test } from "vitest";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const approvedNoMemoBoundaries = Object.freeze([
  Object.freeze({
    file: "packages/table/src/internal/react-compiler-adapters.ts",
    functionName: "useBrunoTableServerFacetHookSource",
    rationale:
      "The Server source supplies a hook method through a stable source object. The bridge must read and commit that changing method explicitly so React Compiler cannot freeze the previous hook behind stable source identity.",
    removalFollowUp: "https://github.com/bmvantunes/shadcn-table/issues/96",
  }),
  Object.freeze({
    file: "packages/table/src/internal/server-facet.tsx",
    functionName: "useBrunoTableServerWholeResult",
    rationale:
      "The View Server integration invokes a consumer-owned hook discovered through an opaque source object. React Compiler cannot prove the reflective hook call's reactive dependencies without a source-owned declarative Adapter.",
    removalFollowUp: "https://github.com/bmvantunes/shadcn-table/issues/96",
  }),
] as const);

type DiscoveredBoundary = Readonly<{
  file: string;
  functionName: string;
  line: number;
}>;

const sourceDirectoryExclusions = new Set([".vite", "build", "coverage", "dist", "node_modules"]);

function collectSourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && !sourceDirectoryExclusions.has(entry.name)) {
      files.push(...collectSourceFiles(path));
    } else if (/\.[cm]?tsx?$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function isMissingSourceDirectoryError(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

type SyntaxNode = Readonly<
  Record<string, unknown> & {
    readonly type: string;
  }
>;

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
  );
}

function syntaxChildren(node: SyntaxNode): readonly SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isSyntaxNode(child)) children.push(child);
    } else if (isSyntaxNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function isFunctionNode(node: SyntaxNode): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

function identifierName(value: unknown): string | undefined {
  return isSyntaxNode(value) && value.type === "Identifier" && typeof value["name"] === "string"
    ? value["name"]
    : undefined;
}

function functionBindingName(
  node: SyntaxNode,
  ancestors: readonly SyntaxNode[],
): string | undefined {
  const ownName = identifierName(node["id"]);
  if (ownName !== undefined) return ownName;
  const parent = ancestors.at(-1);
  if (parent?.type === "VariableDeclarator" && parent["init"] === node) {
    return identifierName(parent["id"]);
  }
  if (
    (parent?.type === "Property" || parent?.type === "MethodDefinition") &&
    parent["value"] === node
  ) {
    return identifierName(parent["key"]);
  }
  return undefined;
}

async function discoverNoMemoBoundariesFromSource(
  source: string,
  file: string,
): Promise<readonly DiscoveredBoundary[]> {
  const ast = (await parseAstAsync(source, {
    lang: file.endsWith("x") ? "tsx" : "ts",
  })) as unknown as SyntaxNode;
  const boundaries: DiscoveredBoundary[] = [];

  const visit = (node: SyntaxNode, ancestors: readonly SyntaxNode[]): void => {
    if (isFunctionNode(node)) {
      const body = node["body"];
      const statements = isSyntaxNode(body) && Array.isArray(body["body"]) ? body["body"] : [];
      for (const statement of statements) {
        if (!isSyntaxNode(statement) || statement["directive"] !== "use no memo") continue;
        const start = typeof statement["start"] === "number" ? statement["start"] : 0;
        boundaries.push(
          Object.freeze({
            file,
            functionName: functionBindingName(node, ancestors) ?? "<unknown>",
            line: source.slice(0, start).split("\n").length,
          }),
        );
      }
    }
    const nextAncestors = [...ancestors, node];
    for (const child of syntaxChildren(node)) visit(child, nextAncestors);
  };
  visit(ast, []);
  return boundaries;
}

async function discoverNoMemoBoundaries(): Promise<readonly DiscoveredBoundary[]> {
  const boundaries: DiscoveredBoundary[] = [];
  for (const packageName of readdirSync(resolve(workspaceRoot, "packages"))) {
    const sourceDirectory = resolve(workspaceRoot, "packages", packageName, "src");
    let sourceFiles: readonly string[];
    try {
      sourceFiles = collectSourceFiles(sourceDirectory);
    } catch (error) {
      if (!isMissingSourceDirectoryError(error)) throw error;
      continue;
    }
    for (const sourceFile of sourceFiles) {
      const source = readFileSync(sourceFile, "utf8");
      boundaries.push(
        ...(await discoverNoMemoBoundariesFromSource(source, relative(workspaceRoot, sourceFile))),
      );
    }
  }
  return boundaries.sort((left, right) =>
    `${left.file}:${left.functionName}`.localeCompare(`${right.file}:${right.functionName}`),
  );
}

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("React Compiler entry-point and escape-hatch contract", () => {
  test("distinguishes a missing source directory from unexpected traversal failures", () => {
    expect(isMissingSourceDirectoryError({ code: "ENOENT" })).toBe(true);
    expect(isMissingSourceDirectoryError({ code: "EACCES" })).toBe(false);
    expect(isMissingSourceDirectoryError(new Error("unreadable source"))).toBe(false);
  });

  test("attributes no-memo directives to their lexical function owner", async () => {
    const source = [
      "function approvedBoundary() {",
      "  return undefined;",
      "}",
      "const unexpectedBoundary = () => {",
      '  "use no memo";',
      "};",
      "",
    ].join("\n");

    expect(await discoverNoMemoBoundariesFromSource(source, "fixture.ts")).toEqual([
      {
        file: "fixture.ts",
        functionName: "unexpectedBoundary",
        line: 5,
      },
    ]);
  });

  test("rejects every unapproved use no memo directive", async () => {
    const expected = approvedNoMemoBoundaries
      .map(({ file, functionName }) => ({ file, functionName }))
      .sort((left, right) =>
        `${left.file}:${left.functionName}`.localeCompare(`${right.file}:${right.functionName}`),
      );
    const discovered = (await discoverNoMemoBoundaries()).map(({ file, functionName }) => ({
      file,
      functionName,
    }));

    expect(discovered).toEqual(expected);
    expect(approvedNoMemoBoundaries.every(({ rationale }) => rationale.length >= 120)).toBe(true);

    const removalFollowUps = approvedNoMemoBoundaries.map(({ removalFollowUp }) => removalFollowUp);
    expect(removalFollowUps).toEqual([
      "https://github.com/bmvantunes/shadcn-table/issues/96",
      "https://github.com/bmvantunes/shadcn-table/issues/96",
    ]);
    expect(
      removalFollowUps.every((removalFollowUp) =>
        /^https:\/\/github\.com\/bmvantunes\/shadcn-table\/issues\/[1-9]\d*$/u.test(
          removalFollowUp,
        ),
      ),
    ).toBe(true);
  });

  test("enables React Compiler in every package React build and Browser entry-point config", async () => {
    const configFiles = collectSourceFiles(resolve(workspaceRoot, "packages"))
      .map((path) => relative(workspaceRoot, path))
      .filter((path) =>
        /packages\/(?:table|ui)\/(?:vite|vitest[^/]*browser[^/]*)\.config\.ts$/u.test(path),
      )
      .sort();

    expect(configFiles).toEqual([
      "packages/table/vite.config.ts",
      "packages/table/vitest.browser.config.ts",
      "packages/table/vitest.emitted-browser.config.ts",
      "packages/table/vitest.performance-browser.config.ts",
      "packages/ui/vite.config.ts",
      "packages/ui/vitest.browser.config.ts",
    ]);

    for (const configFile of configFiles) {
      const source = readWorkspaceFile(configFile);
      const configuredReactPlugins = source.match(/\breact\(\s*\{/gu)?.length ?? 0;
      const compilerOptions = source.match(/\breactCompiler\(\)/gu)?.length ?? 0;

      const ast = await parseAstAsync(source, { lang: "ts" });
      const importsSharedCompiler = ast.body.some(
        (statement) =>
          statement.type === "ImportDeclaration" &&
          statement.importKind !== "type" &&
          ["../../config/react-compiler", "../../config/react-compiler.ts"].includes(
            statement.source.value,
          ) &&
          statement.specifiers.some(
            (specifier) =>
              specifier.type === "ImportSpecifier" &&
              specifier.importKind !== "type" &&
              specifier.imported.type === "Identifier" &&
              specifier.imported.name === "reactCompiler" &&
              specifier.local.name === "reactCompiler",
          ),
      );
      expect(
        importsSharedCompiler,
        `${configFile} must import the shared strict compiler policy`,
      ).toBe(true);
      expect(source, `${configFile} must not register an uncompiled React plugin`).not.toMatch(
        /\breact\(\s*\)/u,
      );
      expect(configuredReactPlugins, `${configFile} must configure at least one React plugin`).toBe(
        1,
      );
      expect(
        compilerOptions,
        `${configFile} must apply the shared compiler policy to every React plugin factory`,
      ).toBe(configuredReactPlugins);
    }

    for (const buildConfig of ["packages/ui/vite.config.ts", "packages/table/vite.config.ts"]) {
      const source = readWorkspaceFile(buildConfig);
      expect(
        source.match(/reactWithCompiler\(\)/gu)?.length,
        `${buildConfig} must compile both the source/Test and library-pack pipelines`,
      ).toBe(2);
      expect(source, `${buildConfig} must keep the compiler in the pack pipeline`).toMatch(
        /pack:\s*\{[\s\S]*?plugins:\s*\[[^\]]*\.\.\.reactWithCompiler\(\)[^\]]*\]/u,
      );
    }
  });
});
