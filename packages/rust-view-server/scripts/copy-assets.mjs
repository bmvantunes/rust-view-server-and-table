import {copyFile} from "node:fs/promises";
for(const name of ["generic_engine.wasm","product_core.wasm"])await copyFile(new URL(`../src/${name}`,import.meta.url),new URL(`../dist/${name}`,import.meta.url));
