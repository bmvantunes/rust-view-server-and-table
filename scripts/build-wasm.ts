/** Build current source and copy only the selected artifacts, with a source receipt. */
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ROOT,VERSION,selected,rust} from './rust.ts';
const clean=process.argv.includes('--clean');
if(process.argv.slice(2).some(arg=>arg!=='--clean'))throw Error('Expected only --clean');
const outputs={'view_server_generic_wasm':'generic_engine.wasm','rust_differential_product_core':'product_core.wasm'};
const destination=join(ROOT,'artifacts/wasm');
mkdirSync(join(ROOT,'.local'),{recursive:true});mkdirSync(destination,{recursive:true});
for(const name of Object.values(outputs))rmSync(join(destination,name),{force:true});
const target=clean?mkdtempSync(join(ROOT,'.local/wasm-clean-')):join(ROOT,'target');
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
function sources(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(join(dir,entry.name)):entry.name.endsWith('.rs')?[join(dir,entry.name)]:[]).sort();}
try {
 const status=rust(['build','--locked','-p','view-server-generic-wasm','-p','rust-differential-product-core','--target','wasm32-unknown-unknown','--release'],{env:{...process.env,CARGO_TARGET_DIR:target}});
 if(status!==0)throw Error(`WASM build exited ${status}`);
 const artifacts:Record<string,{sha256:string;bytes:number}>={};
 for(const [crate,name]of Object.entries(outputs)){const data=readFileSync(join(target,'wasm32-unknown-unknown/release',crate+'.wasm'));writeFileSync(join(destination,name),data);artifacts[name]={sha256:sha(data),bytes:data.length};}
 const files=[...sources(join(ROOT,'packages/rust-view-server/crates/core/src')),...sources(join(ROOT,'packages/rust-view-server/crates/wasm/src')),...['Cargo.toml','Cargo.lock','rust-toolchain.toml','scripts/rust.ts','scripts/build-wasm.ts','packages/rust-view-server/crates/core/Cargo.toml','packages/rust-view-server/crates/wasm/Cargo.toml'].map(file=>join(ROOT,file))];
 const receipt={compiler:execFileSync(selected('rustc'),['--version'],{encoding:'utf8'}).trim(),toolchain:VERSION,cleanArtifactDirectory:clean,artifacts,sha256:artifacts['generic_engine.wasm'].sha256,sourceSha256:Object.fromEntries(files.map(file=>[relative(ROOT,file),sha(readFileSync(file))]))};
 writeFileSync(join(ROOT,'.local/wasm-build.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({artifacts,clean}));
}finally{if(clean)rmSync(target,{recursive:true,force:true});}
