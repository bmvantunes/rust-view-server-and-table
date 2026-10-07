/** Enforce the authored Rust/client split and the public, acyclic runtime graph. */
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT} from './rust.ts';
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('manifest object required');return Object.fromEntries(Object.entries(value));}
function manifest(path:string){return object(JSON.parse(readFileSync(join(ROOT,path,'package.json'),'utf8')));}
function dependencies(value:unknown):Record<string,string>{if(value===undefined)return {};const record=object(value);return Object.fromEntries(Object.entries(record).map(([key,value])=>{if(typeof value!=='string')throw Error('dependency version must be string');return [key,value];}));}
function files(root:string):string[]{return readdirSync(root,{withFileTypes:true}).filter(entry=>!['node_modules','dist','target'].includes(entry.name)).flatMap(entry=>entry.isDirectory()?files(join(root,entry.name)):[join(root,entry.name)]);}
export function invalidImport(owner:'client'|'consumer',specifier:string,allowedExports:readonly string[]):boolean {
 if(specifier==='@bruno/rust-view-server'||specifier.startsWith('@bruno/rust-view-server/'))return true;
 if(owner==='client'&&(specifier==='@bruno/table'||specifier.startsWith('@bruno/table/')))return true;
 if(/(?:^|\/)rust-view-server\/(?:crates|src)(?:\/|$)/.test(specifier)||specifier.includes('/view-server-client/src/'))return true;
 if(specifier==='@bruno/view-server-client'||specifier.startsWith('@bruno/view-server-client/'))return !allowedExports.includes(specifier.replace('@bruno/view-server-client','.'));
 return false;
}
export function checkBoundaries(){
 const rust=manifest('packages/rust-view-server'),client=manifest('packages/view-server-client'),table=manifest('packages/table'),server=manifest('apps/server'),web=manifest('apps/web');
 if(rust.name!=='@bruno/rust-view-server'||rust.private!==true||['exports','main','module','types'].some(key=>key in rust))throw Error('Rust adapter must be private with no runtime npm exports');
 if(client.name!=='@bruno/view-server-client'||client.private!==true)throw Error('Client package identity');
 if(['preinstall','install','postinstall','prepare'].some(key=>key in object(client.scripts??{})))throw Error('Client installation must not invoke build tools');
 const runtime=dependencies(client.dependencies),development=dependencies(client.devDependencies);
 if('@bruno/rust-view-server'in runtime||'@bruno/table'in runtime||'@bruno/table'in development)throw Error('Client runtime may not depend on Rust adapter or table');
 if(development['@bruno/rust-view-server']!=='workspace:*')throw Error('Explicit Rust build dependency missing');
 if(dependencies(table.dependencies)['@bruno/view-server-client']!=='workspace:*'||'@bruno/rust-view-server'in dependencies(table.dependencies))throw Error('Table must depend on public client package');
 if(dependencies(server.dependencies)['@bruno/rust-view-server']!=='workspace:*'||'@bruno/view-server-client'in dependencies(server.dependencies))throw Error('Server adapter must depend only on Rust implementation');
 if(dependencies(web.dependencies)['@bruno/view-server-client']!=='workspace:*')throw Error('Web must consume client package');
 const nativeFiles=files(join(ROOT,'packages/rust-view-server')).filter(path=>/\.[cm]?tsx?$/.test(path));if(nativeFiles.length)throw Error('Authored TypeScript remains in Rust package: '+nativeFiles.join(', '));
 if(existsSync(join(ROOT,'packages/rust-view-server/src')))throw Error('Obsolete SDK source directory remains');
 const allowedExports=Object.keys(object(client.exports));
 for(const [owner,dir]of [['client','packages/view-server-client/src'],['consumer','packages/table/src'],['consumer','apps/web/src']] as const){for(const file of files(join(ROOT,dir)).filter(path=>/\.[cm]?tsx?$/.test(path))){const source=readFileSync(file,'utf8');for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g))if(invalidImport(owner,match[1],allowedExports))throw Error(`Prohibited package import in ${file}: ${match[1]}`);}}
 const graph=new Map([rust,client,table,server,web,manifest('packages/ui')].map(pkg=>[String(pkg.name),Object.keys({...dependencies(pkg.dependencies),...dependencies(pkg.devDependencies)})]));
 const visit=(name:string,path:string[])=>{if(path.includes(name))throw Error('Workspace dependency cycle: '+[...path,name].join(' -> '));for(const dependency of graph.get(name)??[])if(graph.has(dependency))visit(dependency,[...path,name]);};for(const name of graph.keys())visit(name,[]);
 console.log(JSON.stringify({status:'passed',rustRuntimeExports:false,clientRustDependency:'development/build only',workspaceGraph:Object.fromEntries([...graph].map(([name,deps])=>[name,deps.filter(dep=>graph.has(dep))]))}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))checkBoundaries();
