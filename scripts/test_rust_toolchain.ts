import {test} from 'node:test';
import assert from 'node:assert/strict';
import {invocation,toolchainChannel,VERSION} from './rust.ts';
test('Cargo, compilers and clippy cannot resolve from an earlier host PATH',()=>{
 const seen:string[]=[];const call=invocation(['clippy','--version'],{PATH:'/old/homebrew/bin:/usr/bin',CARGO_TARGET_DIR:'/owned/target'},name=>{seen.push(name);return '/selected/toolchain/bin/'+name;});
 assert.deepEqual(call.args,['run',VERSION,'/selected/toolchain/bin/cargo','clippy','--version']);
 assert.deepEqual(seen,['cargo','rustc','rustdoc','cargo-clippy','clippy-driver']);
 assert.equal(call.env.RUSTC,'/selected/toolchain/bin/rustc');assert.equal(call.env.RUSTDOC,'/selected/toolchain/bin/rustdoc');assert.equal(call.env.PATH.split(':')[0],'/selected/toolchain/bin');assert.equal(call.env.CARGO_TARGET_DIR,'/owned/target');
});
test('only the exact toolchain channel is accepted',()=>{assert.equal(toolchainChannel('[toolchain]\nchannel = "1.99.0"\nprofile = "minimal"\n'),'1.99.0');for(const channel of ['stable','nightly','1.99'])assert.throws(()=>toolchainChannel(`[toolchain]\nchannel = "${channel}"\n`));});
