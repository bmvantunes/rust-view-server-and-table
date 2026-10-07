import {defineConfig} from 'vite-plus';
import {playwright} from '@vitest/browser-playwright';
export default defineConfig({
  define:{__RVS_TEST_WASM_URL__:JSON.stringify(process.env.RVS_TEST_WASM_URL)??"undefined"},
  optimizeDeps:{include:['react/jsx-runtime','react/jsx-dev-runtime']},
  test:{include:['tests/*.browser.test.tsx','src/*.browser.test.tsx','src/*.browser.test.ts'],browser:{enabled:true,provider:playwright(),instances:[{browser:'chromium'}],headless:true}},
});
