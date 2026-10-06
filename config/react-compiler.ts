import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";

// Run before JSX lowering so React Compiler receives original component source.
export function reactCompiler(): ReturnType<typeof babel> {
  return babel({
    include: /\.[jt]sx?$/,
    exclude: [/\/node_modules\//, /\.d\.[cm]?tsx?$/],
    presets: [
      reactCompilerPreset({ compilationMode: "infer", panicThreshold: "all_errors", target: "19" }),
    ],
  });
}
