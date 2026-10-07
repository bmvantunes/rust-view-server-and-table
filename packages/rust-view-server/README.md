# Rust view-server implementation

This private workspace task adapter owns the existing core, runtime, admission, wire and WASM crates under `crates/`. Cargo owns their dependencies and native tests. The root Cargo workspace and `rust-toolchain.toml` are authoritative.

The TypeScript SDK, Workers, Provider and browser tests live in `../view-server-client`, package name `@bruno/view-server-client`. This Rust package has no runtime npm exports.

Use root VP commands. The Rust WASM build writes artifacts to `artifacts/wasm`; the explicit client staging task checks hashes and binding exports before packaging. Native Cargo compilation uses already-generated schema fixtures and does not require SDK/table builds.
