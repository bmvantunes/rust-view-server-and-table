import {expect,test} from 'vite-plus/test';
import {defineSchema,resultShape,validateQuery,validateGroupedRow} from '@bruno/rust-view-server/schema';
import {compile,decodeRows} from '../../src/rust/translate.ts';
import * as BigDecimal from 'effect/BigDecimal';
import type {ProductResult} from '@bruno/rust-view-server/react';
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
