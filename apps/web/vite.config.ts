import { defineConfig } from "vite-plus";
import { reactCompiler, react as viteReact } from "../../config/react-compiler";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import tailwindcss from "@tailwindcss/vite";
import { lazyPlugins } from "vite-plus";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: lazyPlugins(() => [devtools(), tailwindcss(), tanstackStart(), reactCompiler(), viteReact()]),
});

export default config;
