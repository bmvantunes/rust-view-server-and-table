import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

import { reactCompiler } from "../../config/react-compiler";
import { shadcnSourceAliases } from "../../config/shadcn-source-aliases.js";

export default defineConfig({
  define: {
    __BRUNO_TABLE_DEVELOPMENT__: "true",
    __BRUNO_TABLE_TEST_DIAGNOSTICS__: "true",
  },
  plugins: [
    reactCompiler(),
    react({
      exclude: [/\/node_modules\//, /\.d\.[cm]?tsx?$/],
    }),
    tailwindcss(),
  ],
  resolve: { alias: shadcnSourceAliases, dedupe: ["react", "react-dom"] },
  optimizeDeps: {
    include: [
      "@bruno/shadcn/direction",
      "@bruno/shadcn/switch",
      "@effect/atom-react",
      "@tanstack/react-hotkeys",
      "effect",
      "effect-view-server/config",
      "effect-view-server/react",
      "effect-view-server/react/testing",
      "effect-view-server/source-adapter",
      "react",
      "react-dom/client",
      "react-dom/server",
      "vite-plus/test/browser",
      "vitest-browser-react",
    ],
  },
  test: {
    name: "table-browser",
    include: ["src/**/*.browser.test.tsx"],
    exclude: [
      "src/**/*.performance.browser.test.tsx",
      "src/drag-fill-performance.browser.test.tsx",
    ],
    benchmark: {
      include: ["src/**/*.browser.bench.tsx"],
      reporters: ["default", "./scripts/benchmark-completeness.ts"],
    },
    setupFiles: ["./src/vitest.browser.setup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
