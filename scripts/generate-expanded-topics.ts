import {pb,descriptor,require,options,flag,packageVersion,type DescriptorMessage,type GeneratedSchema,type FieldDefinition,type ScalarKind,type DescriptorBinding,type Mapping,type KeyField} from './protobuf-descriptor.ts';
import {schemaId} from './schema-id.ts';
/** Version 3: bounded descriptor graphs. Loaded only by the authoritative generator. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
const scalar:Record<string,ScalarKind>={string:'string',bool:'boolean',double:'number',int64:'int64',uint64:'uint64'};
const valid=(n:unknown):n is string=>typeof n==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(n)&&!['rowId','constructor','prototype','__proto__'].includes(n);
const fq=(t:pb.ReflectionObject)=>t.fullName.slice(1);
const sorted=<T>(o:Readonly<Record<string,T>>)=>Object.fromEntries(Object.entries(o).sort(([a],[b])=>a<b?-1:a>b?1:0));
export function hasExpansion(root:pb.Root){return all(root).some(t=>options(t)['(view.expanded)']===true);}
function all(root:pb.ReflectionObject):pb.ReflectionObject[]{return (root instanceof pb.Namespace?root.nestedArray:[]).flatMap(t=>[t,...all(t)]);}
export function generateExpanded({r,input,out,check,generator}:{r:pb.Root;pb:typeof pb;descriptor:typeof descriptor;require:NodeJS.Require;input:string;out:string;check:boolean;generator:string}){
 const types=all(r).filter((t):t is pb.Type=>t instanceof pb.Type&&!t.fullName.startsWith('.google.')).sort((a,b)=>fq(a)<fq(b)?-1:1);
 const enums=all(r).filter((t):t is pb.Enum=>t instanceof pb.Enum&&!t.fullName.startsWith('.google.')).sort((a,b)=>fq(a)<fq(b)?-1:1);
 for(const t of [...types,...enums])if(fq(t).length>512||fq(t).split('.').length>8||!fq(t).split('.').every(valid))throw Error('fully qualified name bound/reserved component');
 if(types.length+enums.length>64||r.files.length>18)throw Error('descriptor graph/file bound');
 const local=fs.realpathSync(path.dirname(path.resolve(input)));
 const inputs=r.files.filter(f=>!f.includes('google/protobuf/descriptor.proto'));
 for(const f of inputs){if(path.basename(f)!=='view-options.proto'&&!/syntax\s*=\s*["']proto3["']/.test(fs.readFileSync(f,'utf8')))throw Error('expanded schemas require proto3');}
 if(inputs.length>16||inputs.some(f=>path.relative(local,fs.realpathSync(f)).startsWith('..')))throw Error('imports must be supplied inside local input directory');
 if(all(r).some(t=>t instanceof pb.Service))throw Error('services unsupported');
 for(const t of types){if(!valid(t.name)||Object.keys(options(t)).some(k=>!['(view.schema_id)','(view.expanded)'].includes(k)))throw Error('invalid message metadata/name '+fq(t));
  if(options(t)['(view.expanded)']!==undefined&&typeof options(t)['(view.expanded)']!=='boolean')throw Error('expanded metadata must be boolean');
  if(t.fieldsArray.length<1||t.fieldsArray.length>128)throw Error('empty/oversized message');
  for(const f of t.fieldsArray){if(!valid(f.name)||f.map||f.repeated||f.partOf&&(options(f).proto3_optional!==true||f.partOf.fieldsArray.length!==1))throw Error('unsupported field/name/oneof '+f.fullName);
   if(Object.keys(options(f)).some(k=>!['proto3_optional','(view.optional)','(view.nullable)','(view.decimal)','(view.null_for)','(view.required)'].includes(k)))throw Error('unsupported field metadata');
   for(const k of ['(view.optional)','(view.nullable)','(view.decimal)','(view.required)'])if(k in(options(f))&&typeof options(f)[k]!=='boolean')throw Error('boolean metadata required');
   if(!(f.resolvedType instanceof pb.Type)&&!(f.resolvedType instanceof pb.Enum)&&!(f.type in scalar))throw Error('unsupported scalar '+f.type);
  }
 }
 const enumDefs:Record<string,Record<string,number>>={};for(const e of enums){if(!valid(e.name)||Object.keys(options(e)).some(k=>k!=='allow_alias')||Object.keys(e.values).length<1||Object.keys(e.values).length>256||Object.keys(e.values).some(n=>!valid(n))||Object.values(e.values)[0]!==0||Object.values(e.values).some(n=>!Number.isInteger(n)||n<-2147483648||n>2147483647))throw Error('invalid enum '+fq(e));enumDefs[fq(e)]=sorted(e.values);}
 function graph(t:pb.Type){const fields:FieldDefinition[]=[],parents:{path:string;message:string;required:boolean}[]=[],leaves:{path:string;presence:string;required:boolean;enum_domain?:string}[]=[],domains:Record<string,Record<string,number>>={};
  function walk(t:pb.Type,prefix:string,stack:pb.Type[],optional:boolean){if(stack.includes(t)||stack.length>=8)throw Error('cycle/depth bound '+fq(t));const chain=[...stack,t];
   const markers=new Map<string,pb.Field>();for(const f of t.fieldsArray)if(options(f)['(view.null_for)']!==undefined){const target=options(f)['(view.null_for)'];if(typeof target!=='string'||f.type!=='bool'||options(f).proto3_optional!==true||markers.has(target)||Object.keys(options(f)).some(k=>!['proto3_optional','(view.null_for)'].includes(k)))throw Error('invalid null marker');markers.set(target,f);}
   for(const f of t.fieldsArray){if(options(f)['(view.null_for)']!==undefined)continue;const name=prefix+f.name,o=options(f);if(name.length>512)throw Error('path bound');
    if(f.resolvedType instanceof pb.Type){if(Object.keys(o).some(k=>!['proto3_optional','(view.required)'].includes(k)))throw Error('message presence metadata');const required=flag(f,'(view.required)');parents.push({path:name,message:fq(f.resolvedType),required});walk(f.resolvedType,name+'.',chain,optional||!required);continue;}
    if('(view.required)'in o)throw Error('required metadata only on parent');
    const implicit=o.proto3_optional!==true;const required=!flag(f,'(view.optional)');const nullable=flag(f,'(view.nullable)');
    const decimal=o['(view.decimal)']??false;if(decimal&&f.type!=='string'||implicit&&(!required||nullable||decimal))throw Error('implicit/decimal presence conflict');
    if(nullable!==markers.has(f.name))throw Error('nullable field needs marker');markers.delete(f.name);
    const domain=f.resolvedType instanceof pb.Enum?fq(f.resolvedType):undefined;
    fields.push({name,kind:domain?'enum':decimal?'decimal':scalar[f.type],optional:optional||!required,nullable});leaves.push({path:name,presence:implicit?'implicit':'explicit',required,...(domain?{enum_domain:domain}:{})});if(domain)domains[domain]=enumDefs[domain];
   }if(markers.size)throw Error('unbound null marker');
  }walk(t,'',[],false);if(fields.length>64||parents.length>64||!fields.length)throw Error('expanded leaf/parent bounds');return {fields,expansion:{message:fq(t),parents,leaves,enums:sorted(domains)}};
 }
 // Validate all graphs, including unused locally supplied definitions.
 for(const t of types)graph(t);
 const set=r.toDescriptor('proto3');set.file=set.file.filter(f=>f.package!=='view'&&!f.package?.startsWith('google.')).sort((a,b)=>(a.package??'')<(b.package??'')?-1:1);
 function strip(m:DescriptorMessage,prefix?:string){const type=r.lookupType(prefix?prefix+'.'+m.name:m.name);delete m.options;for(const f of m.field??[]){delete f.options;const resolved=type.fields[f.name].resolvedType;if(resolved)f.typeName=resolved.fullName;}for(const n of m.nestedType??[])strip(n,fq(type));}
 for(const f of set.file){delete f.options;f.name=(f.package||'root').replaceAll('.','_')+'.proto';for(const m of f.messageType)strip(m,f.package);}
 const bytes=descriptor.FileDescriptorSet.encode(set).finish();if(bytes.length>65536)throw Error('descriptor bytes');
 type ExpandedSchema=GeneratedSchema&{expansion:ReturnType<typeof graph>['expansion']};
 const bindings:Record<string,{descriptor:DescriptorBinding;schema:ExpandedSchema;mapping:Mapping[];key_fields:KeyField[]}>={},rows:Record<string,ExpandedSchema>={};
 for(const [i,t]of types.entries()){const g=graph(t),id=options(t)['(view.schema_id)'];const d={schema_id:100+i,message_index:0,descriptor_hex:Buffer.from(bytes).toString('hex'),message_name:fq(t)};
  const schema={format:3,id:id===undefined?'identity_key_v3':schemaId(id,3,fq(t)),version:3,key:'rowId',...g};
  const mapping=g.fields.map(f=>{let type=t,leaf:pb.Field|undefined;for(const part of f.name.split('.')){leaf=type.fields[part];if(leaf.resolvedType instanceof pb.Type)type=leaf.resolvedType;}if(!leaf)throw Error('missing descriptor leaf');const finalLeaf=leaf;const marker=type.fieldsArray.find(m=>options(m)['(view.null_for)']===finalLeaf.name);return {field:f.name,tag:leaf.id,...(marker?{null_tag:marker.id}:{})};});
  const key_fields=g.fields.map((f,i)=>({name:f.name,tag:mapping[i].tag,kind:f.kind}));
  bindings[fq(t)]={descriptor:d,schema,mapping,key_fields};
  if(id!==undefined){if(typeof id!=='string')throw Error('schema ID string required');if(Object.hasOwn(rows,id)||options(t)['(view.expanded)']!==true)throw Error('expanded root ID/admission');rows[id]=schema;}
 }
 const catalog=Object.fromEntries(Object.entries(rows).map(([k,schema])=>[k,{schema,fingerprint:sha(JSON.stringify(schema))}]));
 const outputs:Record<string,string>={
  'packages/view-server-client/src/generated/expanded-topics.ts':`// Generated from supplied proto graph. Do not edit.\nimport {defineSchema,defineCatalog,enumValue} from '../topic-schema.ts';\nexport const schemas={${Object.entries(rows).map(([k,s])=>`${JSON.stringify(k)}:defineSchema(${JSON.stringify(s)} as const)`).join(',')}} as const;\nexport const enums={${Object.entries(sorted(enumDefs)).map(([d,vs])=>`${JSON.stringify(d)}:{${Object.entries(vs).map(([label,code])=>`${JSON.stringify(label)}:enumValue(${JSON.stringify(d)},${code})`).join(',')}}`).join(',')}} as const;\nexport const catalog=defineCatalog({${Object.entries(catalog).map(([k,e])=>`${JSON.stringify(k)}:{schema:schemas[${JSON.stringify(k)}],fingerprint:${JSON.stringify(e.fingerprint)}}`).join(',')}});\n`,
  'fixtures/expanded-topics/catalog.json':JSON.stringify({format:1,schemas:Object.values(rows),topics:Object.entries(catalog).map(([topic,e])=>({topic,schema:e.fingerprint}))},null,2)+'\n',
  'fixtures/expanded-topics/browser-catalog.json':JSON.stringify(catalog,null,2)+'\n',
  'fixtures/expanded-topics/source-bindings.json':JSON.stringify(bindings,null,2)+'\n'
 };
 const identity={generator:'protobufjs',version:packageVersion(),generator_sha256:sha(fs.readFileSync(generator)),extension_sha256:sha(fs.readFileSync(new URL(import.meta.url))),descriptor_extension_sha256:sha(fs.readFileSync(new URL('./protobuf-descriptor.ts',import.meta.url))),schema_id_validator_sha256:sha(fs.readFileSync(new URL('./schema-id.ts',import.meta.url))),inputs:Object.fromEntries(inputs.map(f=>[path.relative(local,f),sha(fs.readFileSync(f))])),outputs:Object.fromEntries(Object.entries(outputs).map(([p,v])=>[p,sha(v)]))};outputs['fixtures/expanded-topics/GENERATION.json']=JSON.stringify(identity,null,2)+'\n';
 for(const [p,v]of Object.entries(outputs)){const dest=path.join(out,p);if(check){if(!fs.existsSync(dest)||fs.readFileSync(dest,'utf8')!==v)throw Error('stale generated '+p);}else{fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,v);}}
 return identity;
}
