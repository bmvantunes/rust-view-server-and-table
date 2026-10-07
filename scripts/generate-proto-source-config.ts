import fs from 'node:fs';import path from 'node:path';
import {topics} from '../proto/topic-config.ts';
const W=path.resolve(import.meta.dirname,'..');
function isRecord(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function record(value:unknown):Record<string,unknown>{if(!isRecord(value))throw Error('generated JSON object required');return value;}
export function sources(brokers:string,prefix:string,includeThird=false){
 const bindings=record(JSON.parse(fs.readFileSync(W+'/fixtures/proto-topics/source-bindings.json','utf8')));
 const catalog=record(JSON.parse(fs.readFileSync(W+'/fixtures/proto-topics/browser-catalog.json','utf8')));
 const configured={...topics,...(includeThird?{wide:{message:'Wide',keyMessage:'SimpleKey',identity:{source_policy:'compact,delete',components:[{source:'key',field:'id'}]}}}:{})};
 return Object.entries(configured).map(([topic,c])=>{const key=record(bindings[c.keyMessage]),value=record(bindings[c.message]),entry=record(catalog[topic]);if(typeof entry.fingerprint!=='string'||!Array.isArray(key.key_fields)||!Array.isArray(value.mapping))throw Error('generated binding shape');return {topic,schema:entry.fingerprint,brokers,source_topic:prefix+'-'+topic,source_incarnation:prefix+'-'+topic+'-lifetime',group:prefix+'-'+topic+'-owner',state_topic:prefix+'-'+topic+'-canonical-rowid-v2',initialize_empty:true,partitions:[0,1],key_descriptor:record(key.descriptor),value_descriptor:record(value.descriptor),key_tag:1,key_fields:key.key_fields,mapping:value.mapping,identity:c.identity,readiness:{enter_offset_distance:2,exit_offset_distance:5,max_sample_age_ms:3000,enter_hold_ms:100,exit_hold_ms:100},max_rows:100000};});
}
if(process.argv[1]===new URL(import.meta.url).pathname){const[output,brokers,prefix]=process.argv.slice(2);if(!output||!brokers||!prefix)throw Error('Expected output, brokers and prefix');fs.writeFileSync(output,JSON.stringify(sources(brokers,prefix,true),null,2)+'\n');}
