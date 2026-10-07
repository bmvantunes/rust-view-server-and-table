import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generate} from './generate-proto-topics.ts';
import {ROOT} from './rust.ts';
for(const mode of ['flat','expanded'] as const)test(`TypeScript ${mode} generation matches independent checked-in catalog bytes`,async()=>{
 const out=mkdtempSync(join(tmpdir(),'rvs-generator-'));
 try {const input=join(ROOT,mode==='flat'?'proto/topics.proto':'fixtures/evolution/new/topics.proto');await generate({input,out});
 for(const name of ['catalog.json','browser-catalog.json','source-bindings.json']){const relative=`fixtures/${mode==='flat'?'proto':'expanded'}-topics/${name}`;const expected=join(ROOT,mode==='flat'?relative:'fixtures/evolution/new/'+relative);assert.equal(readFileSync(join(out,relative),'utf8'),readFileSync(expected,'utf8'));}
 }finally{rmSync(out,{recursive:true,force:true});}
});
test('generation rejects non-string decimal annotations and invalid schema names before output',async()=>{
 const out=mkdtempSync(join(tmpdir(),'rvs-generator-invalid-'));
 try{copyFileSync(join(ROOT,'proto/view-options.proto'),join(out,'view-options.proto'));const original=readFileSync(join(ROOT,'proto/topics.proto'),'utf8');
 for(const source of [original.replace('optional string price = 5','optional double price = 5'),original.replace('(view.schema_id) = "orders"','(view.schema_id) = "constructor"')]){writeFileSync(join(out,'topics.proto'),source);await assert.rejects(generate({input:join(out,'topics.proto'),out}));}
 }finally{rmSync(out,{recursive:true,force:true});}
});
