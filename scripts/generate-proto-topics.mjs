import {schemaId} from './schema-id.mjs';
import {hasExpansion,generateExpanded} from './generate-expanded-topics.mjs';
/** Build-time only. Uses pinned protobufjs parser + official descriptor encoder. */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const W=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(W,'package.json'));
const pb=require('protobufjs');const descriptor=require('protobufjs/ext/descriptor');
const sha=b=>createHash('sha256').update(b).digest('hex');
const kind={string:'string',bool:'boolean',double:'number',int64:'int64',uint64:'uint64'};
const name=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const bad=new Set(['rowId','__proto__','prototype','constructor']);
function checkName(n){if(!name.test(n)||bad.has(n))throw Error('reserved/invalid field or message name: '+n);}
const fieldOptions=new Set(['proto3_optional','(view.optional)','(view.nullable)','(view.decimal)','(view.null_for)']);
function fields(t){
 if(t.nestedArray.length||t.fieldsArray.length<1||t.fieldsArray.length>128)throw Error('unsupported nested/empty/oversized message '+t.name);
 const ids=new Set();for(const f of t.fieldsArray){checkName(f.name);if(ids.has(f.id))throw Error('duplicate tag');ids.add(f.id);
  if(f.map||f.repeated||!(f.type in kind)||f.resolvedType||f.options?.proto3_optional!==true||!f.partOf||f.partOf.fieldsArray.length!==1)throw Error('unsupported type or implicit/oneof presence: '+f.fullName);
  for(const k of Object.keys(f.options??{}))if(!fieldOptions.has(k))throw Error('unsupported field metadata '+k);
  for(const k of ['(view.optional)','(view.nullable)','(view.decimal)'])if(k in (f.options??{})&&typeof f.options[k]!=='boolean')throw Error('metadata must be boolean '+k);
  if(f.options?.['(view.decimal)']&&f.type!=='string')throw Error('decimal requires string');
 }
 return t.fieldsArray;
}
export async function generate({input=path.join(W,'proto/topics.proto'),out=W,check=false,compatibilityExamples=false}={}){
 const r=new pb.Root();const resolve=r.resolvePath;r.resolvePath=(origin,target)=>target==='google/protobuf/descriptor.proto'?require.resolve('protobufjs/google/protobuf/descriptor.proto'):resolve(origin,target);
 await r.load(input,{keepCase:true});r.resolveAll();
 if(hasExpansion(r))return generateExpanded({r,pb,descriptor,require,input,out,check,generator:fileURLToPath(import.meta.url)});
 const allowedInputs=new Set([path.resolve(input),path.resolve(path.dirname(input),'view-options.proto'),require.resolve('protobufjs/google/protobuf/descriptor.proto')]);
 if(r.files.some(f=>!allowedInputs.has(path.resolve(f))))throw Error('unsupported imported schema dependency');
 const ns=r.lookup('topics');if(!(ns instanceof pb.Namespace)||!ns.nestedArray.length||Object.keys(ns.options??{}).length)throw Error('topics namespace required');
 const rows={},keys={},bindings={};const inputs=[input,path.join(path.dirname(input),'view-options.proto')];
 for(const t of ns.nestedArray){
  if(!(t instanceof pb.Type))throw Error('unsupported enum/service/extension');checkName(t.name);
  for(const k of Object.keys(t.options??{}))if(!['(view.schema_id)','(view.legacy_key)'].includes(k))throw Error('unsupported message metadata '+k);
  const ff=fields(t);const id=t.options?.['(view.schema_id)'];
  const runtimeId=id===undefined?undefined:schemaId(id,2,t.fullName);
  // Compile only this supported scalar message into a dependency-free descriptor.
  // All custom metadata is consumed/validated here; no extension runtime is claimed.
  const msg=t.toDescriptor('proto3');delete msg.options;for(const f of msg.field)delete f.options;
  const set=descriptor.FileDescriptorSet.create({file:[{name:t.name+'.proto',package:'topics',syntax:'proto3',messageType:[msg]}]});
  const bytes=descriptor.FileDescriptorSet.encode(set).finish();
  const d={schema_id:100+Object.keys(bindings).length,message_index:0,descriptor_hex:Buffer.from(bytes).toString('hex')};
  if(id===undefined){
   if(ff.some(f=>Object.keys(f.options??{}).some(k=>!['proto3_optional','(view.decimal)'].includes(k))))throw Error('key cannot carry optional/null metadata');
   keys[t.name]=ff.map(f=>({name:f.name,tag:f.id,kind:f.options?.['(view.decimal)']?'decimal':kind[f.type]}));bindings[t.name]={descriptor:d,key_fields:keys[t.name]};continue;
  }
  checkName(id);const markers=new Map();for(const f of ff)if(f.options?.['(view.null_for)']!==undefined){const target=f.options['(view.null_for)'];if(typeof target!=='string'||f.type!=='bool'||markers.has(target)||Object.keys(f.options).some(k=>!['proto3_optional','(view.null_for)'].includes(k)))throw Error('invalid null marker');markers.set(target,f.id);}
  const business=ff.filter(f=>f.options?.['(view.null_for)']===undefined);
  const schemaFields=business.map(f=>({name:f.name,kind:f.options?.['(view.decimal)']?'decimal':kind[f.type],optional:f.options?.['(view.optional)']??false,nullable:f.options?.['(view.nullable)']??false}));
  for(const f of schemaFields)if(f.nullable!==markers.has(f.name))throw Error('nullable field requires exactly one marker: '+f.name);
  if([...markers.keys()].some(n=>!schemaFields.some(f=>f.name===n))||schemaFields.length>64)throw Error('unbound null marker/field bound');
  const key=t.options?.['(view.legacy_key)'];if(key!==undefined&&!schemaFields.some(f=>f.name===key&&f.kind==='string'&&!f.optional&&!f.nullable))throw Error('legacy key metadata invalid');
  if(rows[id])throw Error('duplicate schema id');
  rows[id]={schema:{format:2,id:runtimeId,version:2,key:'rowId',fields:schemaFields},legacy:key===undefined?undefined:{format:1,id:schemaId(id,1,t.fullName),version:1,key,fields:schemaFields}};
  bindings[t.name]={descriptor:d,mapping:business.map(f=>({field:f.name,tag:f.id,...(markers.has(f.name)?{null_tag:markers.get(f.name)}:{})}))};
 }
 // Operational names/identity/source endpoints are configured separately.
 const catalog=Object.fromEntries(Object.entries(rows).map(([n,v])=>[n,{schema:v.schema,fingerprint:sha(JSON.stringify(v.schema))}]));
 const manifest={format:1,schemas:Object.values(catalog).map(e=>e.schema),topics:Object.entries(catalog).map(([topic,e])=>({topic,schema:e.fingerprint}))};
 const header='// Generated from proto/topics.proto. Do not edit.\n';
 // Logical IDs and message names are exact quoted property keys, never bindings.
 // Fixed exports occupy disjoint registries; adding/reordering definitions cannot
 // retarget a reference. No lossy convenience aliases are emitted.
 const schemasTs=entries=>"export const schemas={"+entries.map(([n,v])=>`${JSON.stringify(n)}:defineSchema(${JSON.stringify(v)} as const)`).join(',')+"} as const;\n";
 const ts=header+"import {defineSchema,defineCatalog} from '../topic-schema.ts';\n"+schemasTs(Object.entries(rows).map(([n,v])=>[n,v.schema]))+`export const keyFields=${JSON.stringify(keys)} as const;\n`+`export const catalog=defineCatalog({${Object.entries(catalog).map(([n,e])=>`${JSON.stringify(n)}:{schema:schemas[${JSON.stringify(n)}],fingerprint:${JSON.stringify(e.fingerprint)}}`).join(',')}});\n`;
 const legacy=header+"import {defineSchema} from '../topic-schema.ts';\n"+schemasTs(Object.entries(rows).filter(([,v])=>v.legacy).map(([n,v])=>[n,v.legacy]));
 const outputs={'packages/rust-view-server/src/generated/topics.ts':ts,'fixtures/proto-topics/catalog.json':JSON.stringify(manifest,null,2)+'\n','fixtures/proto-topics/browser-catalog.json':JSON.stringify(catalog,null,2)+'\n','fixtures/proto-topics/source-bindings.json':JSON.stringify(bindings,null,2)+'\n'};
 // The historical demo fixtures are an explicit compatibility product.
 if(compatibilityExamples){
 for(const n of ['orders','positions','wide','comparison_products'])if(!rows[n]?.legacy)throw Error('compatibility examples require annotated demo schema: '+n);
 outputs['packages/rust-view-server/src/generated/legacy-topics.ts']=legacy;
 const legacyCatalog=Object.fromEntries(['orders','positions','wide'].map(n=>[n,{schema:rows[n].legacy,fingerprint:sha(JSON.stringify(rows[n].legacy))}]));
 outputs['fixtures/topics/catalog.json']=JSON.stringify({format:1,schemas:Object.values(legacyCatalog).map(e=>e.schema),topics:Object.entries(legacyCatalog).map(([topic,e])=>({topic,schema:e.fingerprint}))},null,2)+'\n';
 outputs['fixtures/topics/browser-catalog.json']=JSON.stringify(legacyCatalog,null,2)+'\n';
 const product={schema:rows.comparison_products.legacy,fingerprint:sha(JSON.stringify(rows.comparison_products.legacy))};
 outputs['fixtures/topics/products-catalog.json']=JSON.stringify({format:1,schemas:[product.schema],topics:[{topic:'products',schema:product.fingerprint}]},null,2)+'\n';outputs['fixtures/topics/products-browser-catalog.json']=JSON.stringify({products:product},null,2)+'\n';
 }
 const identity={generator:'protobufjs',version:require('protobufjs/package.json').version,license:'BSD-3-Clause',generator_sha256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),schema_id_validator_sha256:sha(fs.readFileSync(new URL('./schema-id.mjs',import.meta.url))),descriptor_options_sha256:sha(fs.readFileSync(require.resolve('protobufjs/google/protobuf/descriptor.proto'))),options:{keepCase:true,syntax:'proto3',flatScalarOnly:true,compatibilityExamples},inputs:Object.fromEntries(inputs.map(p=>[path.basename(p),sha(fs.readFileSync(p))])),outputs:Object.fromEntries(Object.entries(outputs).map(([p,v])=>[p,sha(v)]))};
 outputs['fixtures/proto-topics/GENERATION.json']=JSON.stringify(identity,null,2)+'\n';
 for(const [p,v]of Object.entries(outputs)){const dest=path.join(out,p);if(check){if(!fs.existsSync(dest)||fs.readFileSync(dest,'utf8')!==v)throw Error('stale generated output: '+p);}else{fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,v);}}
 return identity;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const i=process.argv.indexOf('--out'),p=process.argv.indexOf('--input');console.log(JSON.stringify(await generate({check:process.argv.includes('--check'),compatibilityExamples:process.argv.includes('--compatibility-examples'),...(i>=0?{out:path.resolve(process.argv[i+1])}:{}),...(p>=0?{input:path.resolve(process.argv[p+1])}:{})}),null,2));}
