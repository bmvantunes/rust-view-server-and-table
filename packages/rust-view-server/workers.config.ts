import {defineConfig} from "vite-plus";
export default defineConfig({
  build: {
    emptyOutDir:false,
    lib: {
      entry: {"generic.worker":"src/generic.worker.ts", "product.remote.worker":"src/product.remote.worker.ts", "product.worker":"src/product.worker.ts"},
      formats:["es"], fileName:(_format,name)=>`${name}.mjs`,
    },
    sourcemap:true,
  },
});
