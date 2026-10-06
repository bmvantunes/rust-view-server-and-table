import { defineConfig } from "vite";

export default defineConfig({
  // Bundle dependencies as a consumer would. Their conventional bare process
  // references are substituted; BrunoTable's optional globalThis probe remains
  // runtime-owned, including the process-free case.
  define: { "process.env.NODE_ENV": '"production"' },
  ssr: { noExternal: true },
  build: { ssr: "diagnostics.mjs", outDir: "diagnostics-dist" },
});
