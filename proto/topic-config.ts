// Operational bindings reference generated fields; no field types are authored here.
import {schemas,keyFields} from '../packages/view-server-client/src/generated/topics.ts';
import {deleteRowId,compactRowId} from '../packages/view-server-client/src/row-id-selector.ts';
export const topics={
 orders:{message:'Orders',keyMessage:'OrdersKey',identity:deleteRowId(keyFields["OrdersKey"],schemas["orders"],[{source:'key',field:'tenant'},{source:'key',field:'desk'},{source:'value',field:'orderId'}])},
 positions:{message:'Positions',keyMessage:'PositionsKey',identity:compactRowId(keyFields["PositionsKey"],[{source:'key',field:'tenant'},{source:'key',field:'desk'},{source:'key',field:'account'},{source:'key',field:'partitionKey'}])},
} as const;
