import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    unbundle: true,
    entry: {
      index: "src/index.ts", schema: "src/schema.ts", react: "src/react.ts", testing: "src/testing.tsx",
      "generated/topics": "src/generated/topics.ts",
      "generated/expanded-topics": "src/generated/expanded-topics.ts",
      "generated/source-metadata": "src/generated/source-metadata.ts",
      "generated/demo-catalog": "src/generated/demo-catalog.ts",
    },
    dts: { tsgo: {} },
    plugins: [{ name: "view-server-worker-asset-urls", renderChunk(code) {
      return code.replace(/(product\.remote|generic|product)\.worker\.ts/g, "$1.worker.mjs");
    } }],
    exports: { customExports(exports) {
      return Object.fromEntries(Object.entries(exports).map(([key,value])=> {
        if(key==="./package.json")return [key,value];
        if(typeof value!=="string"||!value.endsWith(".mjs")) throw Error(`Unexpected package export ${key}`);
        return [key,{types:value.replace(/\.mjs$/, ".d.mts"),import:value,default:value}];
      }));
    } },
  },
});
