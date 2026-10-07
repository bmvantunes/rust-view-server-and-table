import {createQueryClient} from '@bruno/view-server-client/react';
import type {BrowserProductProvider} from '@bruno/view-server-client/react';
import {catalog} from '@bruno/view-server-client/generated/demo-catalog';
import {uint64} from '@bruno/view-server-client/schema';
export function queryCases(provider:BrowserProductProvider){
 const client=createQueryClient(provider,catalog);
 return (name:string)=>{
  switch(name){
   case 'match-none':return client.query('server_orders',{semanticProfile:'effect-4.2.8',select:['orderId'],where:{op:'and',clauses:[{op:'eq',field:'open',value:true},{op:'eq',field:'open',value:false}]},orderBy:[]});
   case 'numeric-range':return client.query('server_orders',{semanticProfile:'effect-4.2.8',select:['orderId','units'],where:{op:'and',clauses:[{op:'ge',field:'units',value:uint64('9007199255741003')},{op:'le',field:'units',value:uint64('9007199255741012')}]},orderBy:[{field:'units',direction:'asc'}]});
   case 'multi-sort':return client.query('server_orders',{semanticProfile:'effect-4.2.8',groupBy:['open','customer'],aggregates:{count:{aggFunc:'count'}},orderBy:[{field:'open',direction:'asc'},{field:'customer',direction:'desc'}]});
   case 'groups':return client.query('server_orders',{semanticProfile:'effect-4.2.8',groupBy:['open'],aggregates:{count:{aggFunc:'count'},units:{aggFunc:'sum',field:'units'},price:{aggFunc:'avg',field:'price'}},orderBy:[{field:'open',direction:'asc'}]});
   case 'facets':return client.query('server_orders',{semanticProfile:'effect-4.2.8',groupBy:['customer'],aggregates:{count:{aggFunc:'count'}},orderBy:[{field:'customer',direction:'asc'}]});
   default:throw Error('Unknown qualification query');
  }
 };
}
