# Selected toolchain and compiler qualification

Exact registry observations are retained in `registry-resolutions.json`; lockfiles record transitive resolution. Global and project-local Vite+ are both 1.0.0, installed using the official user-scoped installer. Node Current is26.10.0, pnpm12.9.1, stable Rust1.99.0 and native TypeScript7.0.2. The TypeScript package's `tsc` launcher dispatches the pinned Darwin ARM64 native binary; it is not a TS5 fallback.

Rust commands use `scripts/rust.py` through VP. That wrapper selects rustup's exact Cargo, rustc and rustdoc and runs within rustup's dynamic-library environment, avoiding an older Homebrew compiler earlier on PATH. Existing host toolchains remain installed. WASM builds target `wasm32-unknown-unknown` from current workspace source.

React/React DOM and types are19.3.0. The table migration uses the selected current TanStack Table9.2.6, Hotkeys0.13, Pacer0.24.1, Store0.11.2, Base UI1.8 and Tailwind4.3.3. The single lockfile is authoritative for full versions. Effect4.0.0-rc.111 and effect-view-server4.2.8 remain the pinned reference compatibility pair; choosing a v4 RC is explicitly permitted by the charter. The newer stable Effect version was inspected, but the reference pair remains coupled to the existing public table numeric/query contract. Its older exact React peer declaration requires behavioral qualification with the selected single React19.3 runtime.

## React Compiler exception

The inspected current Oxc React compiler0.153 still lowered large BigInt literals incorrectly to undefined. Babel compiler1.0.0 therefore remains the narrowly qualified compiler path. The repository patch fixes BigInt lowering, code generation and property keys. It is not a copied blanket disable. Compiler errors stay build failures.

Babel8.0.6 passed an isolated numeric probe but failed ordinary component compilation with the compiler's destructuring handling. Compatible Babel7.29.7 is pinned with @rolldown/plugin-babel0.2.4. Numeric regression tests cover large/negative literals, arithmetic, comparison, callbacks, object keys, state updates and both development and minified production browser output. The actual application also builds with this configuration.

A compiler limitation for try/finally inside a component callback is handled by keeping the asynchronous operation and its finally cleanup in a plain helper outside React. Memo dependencies in imported hooks were made consistent with their actual serialized inputs. These changes preserve behavior without disabling compilation.

## Validation limitations

The final strict source/emitted adapter and application type checks must finish before acceptance. Their latest expanded generic consumers exceeded development deadlines; this remains an implementation/qualification issue, not a passing result. See the task ledger for the final state.
