/** First-party authoring policy. Build output and frozen third-party oracles are not authored tooling. */
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT} from './rust.ts';
export const exclusions=[
 {pattern:/^(?:packages\/(?:table|ui|rust-view-server|view-server-client)\/(?:dist|\.vitest)|apps\/web\/(?:dist|\.output|\.tanstack)|target|node_modules|\.local)\//,reason:'Generated build output, dependency installation or local evidence'},
 {pattern:/^packages\/rust-view-server\/crates\/vendor\//,reason:'Retained third-party Rust/protobuf implementation and notices'},
 {pattern:/^fixtures\/rowid-before\/projector\.(?:mjs|d\.mts)$/,reason:'Frozen independent historical projection oracle; implementation hash checked separately'},
];
export function violations(files:readonly string[]):string[]{return files.filter(file=>/\.(?:py|js|jsx|mjs|cjs|d\.mts)$/.test(file)&&!exclusions.some(x=>x.pattern.test(file)));}
export function policy(){
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:ROOT,encoding:'utf8'}).split('\0').filter(file=>file&&existsSync(resolve(ROOT,file)));
 const rejected=violations(files);if(rejected.length)throw Error('First-party authoring must use checked TypeScript or Rust:\n'+rejected.join('\n'));
 const oracle='fixtures/rowid-before/projector.mjs';const digest=createHash('sha256').update(readFileSync(resolve(ROOT,oracle))).digest('hex');
 if(digest!=='63a41823077887f4670f9a8f01f1e78b3fda752f8d3eff6b2b60850ea3cfdada')throw Error('Frozen independent projection oracle changed');
 console.log(JSON.stringify({policy:'Rust/TypeScript first-party authoring',filesChecked:files.length,exclusions:exclusions.map(x=>x.reason),frozenOracleSha256:digest}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))policy();
