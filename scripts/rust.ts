/** Select Cargo and every compiler/subcommand from the sole authored Rust pin. */
import {readFileSync} from 'node:fs';
import {dirname, delimiter, resolve} from 'node:path';
import {execFileSync, spawnSync, type StdioOptions} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const ROOT=resolve(import.meta.dirname,'..');
export function toolchainChannel(text:string):string {
 const section=text.match(/^\[toolchain\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
 const channel=section?.match(/^channel\s*=\s*"([^"]+)"\s*$/m)?.[1];
 if(!channel||!/^\d+\.\d+\.\d+$/.test(channel))throw Error('rust-toolchain.toml must pin an exact stable channel');
 return channel;
}
export const VERSION=toolchainChannel(readFileSync(resolve(ROOT,'rust-toolchain.toml'),'utf8'));
export function selected(tool:string):string {
 return execFileSync('rustup',['which','--toolchain',VERSION,tool],{encoding:'utf8'}).trim();
}
export function invocation(args:readonly string[],environment:NodeJS.ProcessEnv=process.env,select=selected){
 const cargo=select('cargo');
 const compiler=select('rustc'),docs=select('rustdoc');
 // Resolve these too: fail before execution when the pinned component is absent.
 select('cargo-clippy');select('clippy-driver');
 return {command:'rustup',args:['run',VERSION,cargo,...args],env:Object.assign({},environment,{RUSTC:compiler,RUSTDOC:docs,RVS_NODE:process.execPath,PATH:dirname(cargo)+delimiter+(environment.PATH??'')})};
}
export function rust(args:readonly string[],options:{env?:NodeJS.ProcessEnv;cwd?:string;stdio?:StdioOptions}={}):number {
 const call=invocation(args,options.env??process.env);
 const result=spawnSync(call.command,call.args,{cwd:options.cwd??ROOT,env:call.env,stdio:options.stdio??'inherit'});
 if(result.error)throw result.error;
 if(result.signal)throw Error(`Rust command terminated by ${result.signal}`);
 return result.status??1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=rust(process.argv.slice(2));
