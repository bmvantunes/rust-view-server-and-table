import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

import { react, reactCompiler } from "../../config/react-compiler";

export default defineConfig({
  plugins: [
    reactCompiler(),
    react({
      exclude: [/\/node_modules\//, /\.d\.[cm]?tsx?$/],
    }),
  ],
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: {
    include: [
      "@bruno/shadcn/direction",
      "@bruno/shadcn/switch",
      "@bruno/shadcn/toast",
      "@bruno/shadcn/alert-dialog",
      "react",
      "react/jsx-runtime",
      "react-dom/client",
      "react-dom/server.browser",
      "vite-plus/test/browser",
      "vitest-browser-react",
    ],
  },
  test: {
    name: "table-emitted-browser",
    include: ["tests/emitted-browser/**/*.browser.test.tsx"],
    setupFiles: ["./src/vitest.browser.setup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ contextOptions: { locale: "de-DE" } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
