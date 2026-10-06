import { defineConfig } from "vite-plus";

const task = (command: string, dependsOn: string[] = []) => ({ command, dependsOn, cache: false as const });
export default defineConfig({
  defaultPackage: "./apps/web",
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
  run: {
    cache: false,
    tasks: {
      generate: task("node scripts/generate.mjs"),
      "check:rust": task("python3 scripts/rust.py clippy --workspace --all-targets --features product-source-ingestion/kafka-canonical"),
      "test:rust": task("python3 scripts/rust.py test --workspace --lib"),
      "test:infra": task("python3 -m unittest discover -s scripts -p 'test_*.py'"),
      "build:wasm": task("python3 scripts/build-wasm.py"),
      "build:native": task("python3 scripts/rust.py build --release -p view-server-app --features product-source-ingestion/kafka-canonical"),
      check: task("vp run @bruno/table#test:types:source && vp run @bruno/table#test:types:rust", ["generate", "check:rust"]),
      "build:sdk": task("vp -C packages/rust-view-server run build:package", ["build:wasm"]),
      "test:e2e": task("python3 scripts/e2e.py"),
      verify: task("vp run generate && vp run build && vp run check && vp run test && vp run test:e2e"),
      "test:provider": task("vp -C packages/rust-view-server exec tsc --noEmit -p tsconfig.browser.json && vp -C packages/rust-view-server test run --config browser.config.ts", ["build:sdk"]),
      "test:sdk": task("vp test run packages/rust-view-server/src/complete-client.test.ts"),
      test: task("vp run @bruno/table#test --run", ["generate", "test:rust", "test:infra", "test:sdk", "test:provider"]),
      build: task("vp run @bruno/shadcn#build && vp run @bruno/table#build && vp run @bruno/web#build", ["generate", "build:sdk", "build:native"]),
      dev: task("python3 scripts/dev.py"),
      seed: task("python3 scripts/seed.py"),
      "kafka:init": task("python3 scripts/kafka.py init"),
      "kafka:up": task("python3 scripts/kafka.py up"),
      "kafka:down": task("python3 scripts/kafka.py down"),
      "kafka:status": task("python3 scripts/kafka.py status"),
      "kafka:reset": task("python3 scripts/kafka.py reset"),
      "kafka:probe": task("python3 scripts/rust.py run -p product-source-ingestion --features kafka-canonical --example orbstack_probe"),
    },
  },
});
