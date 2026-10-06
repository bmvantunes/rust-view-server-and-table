import fs from 'node:fs';import path from 'node:path';
import {topics} from '../proto/topic-config.ts';
const W=path.resolve(import.meta.dirname,'..');
export function sources(brokers,prefix,includeThird=false){
 const bindings=JSON.parse(fs.readFileSync(W+'/fixtures/proto-topics/source-bindings.json','utf8'));
 const catalog=JSON.parse(fs.readFileSync(W+'/fixtures/proto-topics/browser-catalog.json','utf8'));
 const configured={...topics,...(includeThird?{wide:{message:'Wide',keyMessage:'SimpleKey',identity:{source_policy:'compact,delete',components:[{source:'key',field:'id'}]}}}:{})};
 return Object.entries(configured).map(([topic,c])=>({topic,schema:catalog[topic].fingerprint,brokers,source_topic:prefix+'-'+topic,source_incarnation:prefix+'-'+topic+'-lifetime',group:prefix+'-'+topic+'-owner',state_topic:prefix+'-'+topic+'-canonical-rowid-v2',initialize_empty:true,partitions:[0,1],key_descriptor:bindings[c.keyMessage].descriptor,value_descriptor:bindings[c.message].descriptor,key_tag:1,key_fields:bindings[c.keyMessage].key_fields,mapping:bindings[c.message].mapping,identity:c.identity,readiness:{enter_offset_distance:2,exit_offset_distance:5,max_sample_age_ms:3000,enter_hold_ms:100,exit_hold_ms:100},max_rows:100000}));
}
if(process.argv[1]===new URL(import.meta.url).pathname){const[output,brokers,prefix]=process.argv.slice(2);fs.writeFileSync(output,JSON.stringify(sources(brokers,prefix,true),null,2)+'\n');}
