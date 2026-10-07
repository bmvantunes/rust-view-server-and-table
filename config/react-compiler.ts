import { createRequire } from "node:module";
import type { PluginItem } from "@babel/core";
import type { Plugin } from "vite-plus";
import { reactCompilerOptions } from "./react-compiler-options.ts";

// These pinned packages work with Babel 7 but their optional declaration graph
// refers to Babel 8 and Zod 4 names. Keep the boundary limited to APIs actually
// used here instead of disabling declaration checking for the application.
const require = createRequire(import.meta.url);
function loadCallable<T extends (...args: never[]) => unknown>(specifier: string, name: string): T {
  const loaded: unknown = require(specifier);
  if (loaded === null || (typeof loaded !== "object" && typeof loaded !== "function")) {
    throw new TypeError(`${specifier} did not export a module`);
  }
  const candidate: unknown = Reflect.get(loaded, name);
  if (typeof candidate !== "function") throw new TypeError(`${specifier}.${name} is not callable`);
  // The pinned upstream call signature is narrowed to the options this project uses.
  return candidate as T;
}
type CompilerOptions = typeof reactCompilerOptions;
type CompilerPreset = { preset: PluginItem; rolldown: { filter?: { code?: RegExp } } };
const babel = loadCallable<
  (options: { include: RegExp; exclude: RegExp[]; presets: CompilerPreset[] }) => Promise<Plugin>
>("@rolldown/plugin-babel", "default");
export const react = loadCallable<
  (options?: {
    include?: RegExp;
    exclude?: RegExp | RegExp[];
    jsxRuntime?: "classic" | "automatic";
  }) => Plugin[]
>("@vitejs/plugin-react", "default");
const reactCompilerPreset = loadCallable<(options: CompilerOptions) => CompilerPreset>(
  "@vitejs/plugin-react",
  "reactCompilerPreset",
);
export const compilerPlugin: PluginItem = require.resolve("babel-plugin-react-compiler");

// Run before JSX lowering so React Compiler receives original component source.
export function reactCompiler(): Promise<Plugin> {
  return babel({
    include: /\.[jt]sx?$/,
    exclude: [/\/node_modules\//, /\.d\.[cm]?tsx?$/],
    presets: [reactCompilerPreset(reactCompilerOptions)],
  });
}
