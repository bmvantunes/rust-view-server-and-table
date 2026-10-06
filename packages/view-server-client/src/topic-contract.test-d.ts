import {createTopicHooks} from './product-provider';
import {orders,positions} from './topic-examples';
import {int64,uint64,decimal,type Int64,type Decimal} from './topic-schema';
// Fingerprint placeholders are never executed; generated manifests use actual hashes.
const hooks=createTopicHooks({orders:{schema:orders,fingerprint:'0'.repeat(64)},positions:{schema:positions,fingerprint:'0'.repeat(64)}});
function contracts(){
 const a=hooks.useLiveQuery('orders',{select:['customer','price','note'],where:{op:'ge',field:'units',value:uint64('18446744073709551615')},orderBy:[{field:'price',direction:'desc'},{field:'customer',direction:'asc'}]});
 const customer:string=a.rows[0]!.customer;const price:Decimal=a.rows[0]!.price;const note:string|null|undefined=a.rows[0]!.note;
 // @ts-expect-error exact selected fields exclude key.
 a.rows[0]?.orderId;
 // @ts-expect-error unknown topic.
 hooks.useLiveQuery('missing',{select:['customer'],orderBy:[]});
 // @ts-expect-error positions field cannot be selected from orders.
 hooks.useLiveQuery('orders',{select:['symbol'],orderBy:[]});
 // @ts-expect-error nonempty selection required.
 hooks.useLiveQuery('orders',{select:[],orderBy:[]});
 // @ts-expect-error unsigned integer operand cannot be lossy Number.
 hooks.useLiveQuery('orders',{select:['orderId'],where:{op:'eq',field:'units',value:2},orderBy:[]});
 // @ts-expect-error plain text is not an admitted exact decimal operand.
 hooks.useLiveQuery('orders',{select:['price'],where:{op:'eq',field:'price',value:'1.2'},orderBy:[]});
 // @ts-expect-error boolean ordering predicates are not admitted.
 hooks.useLiveQuery('orders',{select:['open'],where:{op:'gt',field:'open',value:true},orderBy:[]});
 // @ts-expect-error null equality is not a supported operand; use is_null.
 hooks.useLiveQuery('orders',{select:['note'],where:{op:'eq',field:'note',value:null},orderBy:[]});
 const vp=hooks.useLiveQueryViewport('positions');vp.viewport.replace({window:{firstRow:1,lastRow:8},query:{select:['quantity','symbol'],where:{op:'lt',field:'quantity',value:int64('-9223372036854775808')},orderBy:[]},sink:{setRowCount(){},setRowData(rows){const q:Int64=rows[1]!.quantity;void q;
 // @ts-expect-error omitted risk field.
 rows[1]?.risk;
 }}});
 const whole=vp.useWholeResult({select:['risk'],orderBy:[]});const risk:number=whole.rows[0]!.risk;
 void [customer,price,note,risk,decimal('1.25')];
}
void contracts;
