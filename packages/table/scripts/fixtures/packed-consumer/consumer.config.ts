import { react, reactCompiler } from "../../../../../config/react-compiler.ts";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  plugins: [
    ...(process.env["BRUNO_COMPILER_NEGATIVE_CONTROL"] === "1" ? [] : [reactCompiler()]),
    react(),
    {
      name: "assert-consumer-compiler-transform",
      enforce: "post",
      transform(code, id) {
        if (
          this.environment.config.consumer !== "server" &&
          id.endsWith("/App.tsx") &&
          !code.includes("react/compiler-runtime")
        ) {
          throw new Error("Installed consumer App did not pass through React Compiler");
        }
      },
    },
    tailwindcss(),
  ],
  test: {
    include: ["hydration.browser.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
