#!/usr/bin/env python3
"""Build the shared generic engine and copy only the just-selected output."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from rust import ROOT, VERSION, selected
p=argparse.ArgumentParser();p.add_argument('--clean',action='store_true');args=p.parse_args()
(ROOT/'.local').mkdir(exist_ok=True)
outputs={'view_server_generic_wasm':'generic_engine.wasm','rust_differential_product_core':'product_core.wasm'}
for name in outputs.values():
 output=ROOT/'packages/rust-view-server/src'/name
 if output.exists(): output.unlink()
temporary=tempfile.TemporaryDirectory(prefix='wasm-clean-',dir=ROOT/'.local') if args.clean else None
target=Path(temporary.name) if temporary else ROOT/'target'
try:
 subprocess.run(['python3',str(ROOT/'scripts/rust.py'),'build','--locked','-p','view-server-generic-wasm','-p','rust-differential-product-core','--target','wasm32-unknown-unknown','--release'],env={**os.environ,'CARGO_TARGET_DIR':str(target)},check=True)
 artifacts={}
 for crate,name in outputs.items():
  binary=target/'wasm32-unknown-unknown/release'/f'{crate}.wasm'
  data=binary.read_bytes();output=ROOT/'packages/rust-view-server/src'/name;output.write_bytes(data)
  artifacts[name]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
 data=(ROOT/'packages/rust-view-server/src/generic_engine.wasm').read_bytes()
 files=sorted((ROOT/'packages/rust-view-server/crates/core/src').rglob('*.rs'))+sorted((ROOT/'packages/rust-view-server/crates/wasm/src').rglob('*.rs'))+[ROOT/'Cargo.toml',ROOT/'Cargo.lock',ROOT/'rust-toolchain.toml',ROOT/'scripts/rust.py',ROOT/'scripts/build-wasm.py',ROOT/'packages/rust-view-server/crates/core/Cargo.toml',ROOT/'packages/rust-view-server/crates/wasm/Cargo.toml']
 receipt={'compiler':subprocess.check_output([selected('rustc'),'--version'],text=True).strip(),'toolchain':VERSION,'cleanArtifactDirectory':args.clean,'artifacts':artifacts,'sha256':hashlib.sha256(data).hexdigest(),'sourceSha256':{str(f.relative_to(ROOT)):hashlib.sha256(f.read_bytes()).hexdigest() for f in files}}
 (ROOT/'.local/wasm-build.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'artifacts':artifacts,'clean':args.clean}))
finally:
 if temporary: temporary.cleanup()
