#!/usr/bin/env python3
"""Compile a broken scratch engine and prove the real public React consumer fails."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,tempfile
SDK=Path(__file__).resolve().parents[1]
ROOT=SDK.parents[1]
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
inputs=[p for crate in ["core","wasm"] for p in (SDK/"crates"/crate).rglob("*") if p.is_file()]
before={str(p.relative_to(ROOT)):digest(p) for p in inputs}
(ROOT/".local").mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="engine-mutation-",dir=ROOT/".local") as temporary:
 scratch=Path(temporary)
 for crate in ["core","wasm"]:shutil.copytree(SDK/"crates"/crate,scratch/"crates"/crate)
 (scratch/"Cargo.toml").write_text('[workspace]\nresolver="3"\nmembers=["crates/core","crates/wasm"]\n')
 shutil.copyfile(ROOT/"Cargo.lock",scratch/"Cargo.lock")
 source=scratch/"crates/core/src/generic.rs"
 original=source.read_text();needle='staged.insert(key.clone(),None);'
 if original.count(needle)!=1:raise RuntimeError("mutation target changed; inspect rather than guessing")
 source.write_text(original.replace(needle,'/* intentional scratch defect: ignore valid deletes */'))
 subprocess.run(["python3",str(ROOT/"scripts/rust.py"),"build","--offline","--manifest-path",str(scratch/"Cargo.toml"),"-p","view-server-generic-wasm","--target","wasm32-unknown-unknown","--release"],env={**os.environ,"CARGO_TARGET_DIR":str(scratch/"target")},check=True)
 binary=scratch/"target/wasm32-unknown-unknown/release/view_server_generic_wasm.wasm"
 result=subprocess.run(["vp","test","run","--config","browser.config.ts","tests/memory.browser.test.tsx","-t","publishes before mount"],cwd=SDK,env={**os.environ,"RVS_TEST_WASM_URL":"/@fs"+str(binary)},text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (ROOT/".local/engine-mutation.log").write_text(result.stdout)
 # The targeted assertion must fail; compilation, module-load or timeout errors are not proof.
 if result.returncode==0 or "expected" not in result.stdout or "changed:0" not in result.stdout:
  raise RuntimeError("consumer did not report the expected retained-row deletion violation; inspect .local/engine-mutation.log")
 source.write_text(original)
 restored=source.read_text()==original
 if {str(p.relative_to(ROOT)):digest(p) for p in inputs}!=before:raise RuntimeError("owned production source changed during mutation qualification")
 receipt={"mutation":"ignore admitted deletes in generic Runtime.apply_committed", "consumer":"emitted SDK Provider with actual generic Worker/WASM; publishes before mount test", "consumerExitCode":result.returncode,"expectedFailureObserved":True,"scratchSourceRestored":restored,"productionSourceUnchanged":True,"mutatedWasmSha256":digest(binary)}
 (ROOT/".local/engine-mutation.json").write_text(json.dumps(receipt,indent=2)+"\n")
 print(json.dumps(receipt))
