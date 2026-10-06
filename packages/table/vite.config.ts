import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite-plus";

import { reactCompiler } from "../../config/react-compiler";
import { BrunoTableProductionDefines } from "./config/production-defines.js";

const reactWithCompiler = () => [
  reactCompiler(),
  ...react({
    exclude: [/\/node_modules\//, /\.d\.[cm]?tsx?$/],
  }),
];

const config: UserConfig = defineConfig({
  define: {
    __BRUNO_TABLE_DEVELOPMENT__: "true",
    __BRUNO_TABLE_TEST_DIAGNOSTICS__: "true",
  },
  plugins: [...reactWithCompiler()],
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/rust/**/*.test.ts"],
    benchmark: {
      include: ["src/**/*.bench.ts"],
      reporters: ["default", "./scripts/benchmark-completeness.ts"],
    },
  },
  pack: {
    unbundle: true,
    outputOptions: {
      banner: (chunk) => (chunk.name === "index" || chunk.name === "server" ? '"use client";' : ""),
    },
    entry: {
      index: "src/index.ts",
      server: "src/server.ts",
      effect: "src/effect.ts",
      rust: "src/rust.ts",
      "internal/compiler-smoke": "src/internal/compiler-smoke.tsx",
    },
    dts: {
      tsgo: {},
    },
    deps: {
      onlyBundle: ["effect-view-server"],
    },
    exports: {
      exclude: ["internal/**"],
      customExports(packageExports) {
        const rootExport = packageExports["."];
        const effectExport = packageExports["./effect"];
        const rustExport = packageExports["./rust"];
        const serverExport = packageExports["./server"];

        if (typeof rootExport !== "string" || !rootExport.endsWith(".mjs")) {
          throw new TypeError("Expected vp pack to generate the @bruno/table root export.");
        }
        if (typeof effectExport !== "string" || !effectExport.endsWith(".mjs")) {
          throw new TypeError("Expected vp pack to generate the @bruno/table/effect export.");
        }
        if (typeof serverExport !== "string" || !serverExport.endsWith(".mjs")) {
          throw new TypeError("Expected vp pack to generate the @bruno/table/server export.");
        }

        return {
          ".": {
            types: rootExport.replace(/\.mjs$/, ".d.mts"),
            import: rootExport,
            default: rootExport,
          },
          "./effect": {
            types: effectExport.replace(/\.mjs$/, ".d.mts"),
            import: effectExport,
            default: effectExport,
          },
          "./server": {
            types: serverExport.replace(/\.mjs$/, ".d.mts"),
            import: serverExport,
            default: serverExport,
          },
          "./rust": typeof rustExport === "string" ? { types: rustExport.replace(/\.mjs$/, ".d.mts"), import: rustExport, default: rustExport } : rustExport,
          "./package.json": "./package.json",
        };
      },
    },
    plugins: [BrunoTableProductionDefines(), ...reactWithCompiler()],
  },
  lint: {
    ignorePatterns: ["tests/emitted-consumer/**"],
    plugins: ["typescript", "react"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "react/react-compiler": ["error", { reportAllBailouts: true }],
    },
  },
});

export default config;
