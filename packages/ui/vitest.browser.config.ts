import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

import { reactCompiler } from "../../config/react-compiler";

export default defineConfig({
  plugins: [
    reactCompiler(),
    react({
      exclude: [/\/node_modules\//, /\.d\.[cm]?tsx?$/],
    }),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: ["vite-plus/test/browser", "vitest-browser-react"],
  },
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.tsx", "tests/**/*.browser.test.tsx"],
    setupFiles: ["./src/vitest.browser.setup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
