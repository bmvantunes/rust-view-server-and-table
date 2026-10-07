import {expect,test} from 'vite-plus/test';
import {defineSchema,resultShape,validateQuery,validateGroupedRow,requiresTextPredicate} from '@bruno/view-server-client/schema';
import {compile,decodeRows} from '../../src/rust/translate.ts';
import * as BigDecimal from 'effect/BigDecimal';
import type {ProductResult} from '@bruno/view-server-client/react';
const schema=defineSchema({format:2,id:'profile_test',version:2,key:'rowId',fields:[{name:'group',kind:'string',optional:false,nullable:false},{name:'number',kind:'number',optional:false,nullable:false},{name:'optional',kind:'number',optional:true,nullable:false},{name:'nullable',kind:'number',optional:true,nullable:true},{name:'text',kind:'string',optional:true,nullable:true}]} as const);
const fingerprint='a'.repeat(64);
test('profile identity is explicit, leaves native descriptor unchanged and validates text flags',()=>{
 const native={select:['number'],orderBy:[]} as const;const profiled={...native,semanticProfile:'effect-4.2.8'} as const;
 const grouped={groupBy:['group'],aggregates:{n:{aggFunc:'count'}},orderBy:[]} as const;expect(resultShape('profile',fingerprint,{...grouped,semanticProfile:'effect-4.2.8'})).not.toBe(resultShape('profile',fingerprint,grouped));
 expect(()=>validateQuery(schema,{...native,where:{op:'text',field:'text',value:'é',match_kind:'eq'}})).toThrow();
 expect(()=>validateQuery(schema,{...profiled,where:{op:'text',field:'text',value:'é',match_kind:'eq',case_sensitive:true}})).not.toThrow();
 expect(()=>validateQuery(schema,{...profiled,where:{op:'text',field:'text',value:'é',match_kind:'eq',case_sensitive:1}})).toThrow();
});
test('profile admits optional nonnullable numeric sums but rejects nullable numeric domains',()=>{
 const base={semanticProfile:'effect-4.2.8',groupBy:['group'],orderBy:[]} as const;
 expect(()=>validateQuery(schema,{...base,aggregates:{total:{aggFunc:'sum',field:'optional'}}})).not.toThrow();
 expect(()=>validateQuery(schema,{...base,aggregates:{total:{aggFunc:'sum',field:'nullable'}}})).toThrow();
});
test('SDK validates bounded profile Text IN while keeping text capability detection source-owned',()=>{
 const values=Array.from({length:4096},(_,index)=>`facet-${index}`);const query={semanticProfile:'effect-4.2.8',select:['text'],where:{op:'text_in',field:'text',values,case_sensitive:true,accent_sensitive:true},orderBy:[]} as const;
 expect(()=>validateQuery(schema,query)).not.toThrow();expect(requiresTextPredicate(query.where)).toBe(true);
 expect(()=>validateQuery(schema,{...query,where:{...query.where,values:[...values,'overflow']}})).toThrow();
 expect(()=>validateQuery(schema,{...query,where:{...query.where,case_sensitive:1}})).toThrow();
});
test('SDK enforces the native UTF-8 framed query identity byte bound around 4096-value sets',()=>{
 const values=Array.from({length:4096},(_,index)=>`facet-${String(index).padStart(4,'0')}`);const topic='profile',fingerprint='f'.repeat(64);const query={semanticProfile:'effect-4.2.8',select:['text'],where:{op:'text_in',field:'text',values},orderBy:[]} as const;
 const withPadding=(count:number)=>({...query,where:{...query.where,values:values.map(value=>`${value}${'界'.repeat(count)}`)}});
 let low=0,high=10;while(low<high){const middle=Math.ceil((low+high)/2);try{validateQuery(schema,withPadding(middle),{topic,fingerprint});low=middle;}catch{high=middle-1;}}
 expect(()=>validateQuery(schema,withPadding(low),{topic,fingerprint})).not.toThrow();
 expect(()=>validateQuery(schema,withPadding(low+1),{topic,fingerprint})).toThrow('query byte bound');
 expect(()=>validateQuery(schema,query,{topic,fingerprint})).not.toThrow();
 const numbers=Array.from({length:4096},(_,index)=>index);
 expect(()=>validateQuery(schema,{semanticProfile:'effect-4.2.8',select:['number'],where:{op:'in',field:'number',values:numbers},orderBy:[]},{topic,fingerprint})).not.toThrow();
 expect(()=>validateQuery(schema,{semanticProfile:'effect-4.2.8',select:['number'],where:{op:'in',field:'number',values:[0.1,1e20,1e-7,-0,1.8446744073709552e19]},orderBy:[]},{topic,fingerprint})).not.toThrow();
});
test('exact profile Number aggregate and subnormal average decode as BigDecimal, missing min owns undefined',()=>{
 const query={groupBy:['group'],aggregates:{total:{aggFunc:'sum',field:'number'},mean:{aggFunc:'avg',field:'number'},minimum:{aggFunc:'min',field:'text'}},where:[],orderBy:[]} as const;
 const compiled=compile(schema,'profile',fingerprint,query);const tiny='0.'+'0'.repeat(323)+'5';
 const row=Object.fromEntries([['group','g'],...compiled.aliases.filter(a=>a.public!=='minimum').map(a=>[a.native,a.public==='mean'?tiny:'0.3'])]);
 const result:ProductResult={subscription:'x',query_generation:1,sequence:1,start_rank:0,version:1,total_rows:1,rows:[row],keys:['gid1:test']};
 const decoded=decodeRows<typeof schema,typeof query>(schema,compiled,result)[0]!;
 expect(BigDecimal.format(decoded.total)).toBe('0.3');expect(decoded.mean.value).toBe(5n);expect(decoded.mean.scale).toBe(324);expect(Object.hasOwn(decoded,'minimum')).toBe(true);expect(decoded.minimum).toBeUndefined();
 const native={groupBy:['group'],aggregates:{mean:{aggFunc:'avg',field:'number'}},orderBy:[]} as const;
 expect(()=>validateGroupedRow(schema,native,{group:'g',mean:tiny},['group','mean'])).toThrow();
});
