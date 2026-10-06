// Generated from proto/topics.proto. Do not edit.
import {defineSchema,defineCatalog} from '../../../src/topic-schema.ts';
export const schemas={"balances":defineSchema({"format":2,"id":"balances_v2","version":2,"key":"rowId","fields":[{"name":"quantity","kind":"int64","optional":false,"nullable":false},{"name":"risk","kind":"number","optional":false,"nullable":false}]} as const)} as const;
export const keyFields={"BalanceKey":[{"name":"tenant","tag":1,"kind":"string"},{"name":"account","tag":2,"kind":"uint64"}]} as const;
export const catalog=defineCatalog({"balances":{schema:schemas["balances"],fingerprint:"d193759d5ba6570bae080f5c2f321da52f78d72f2c649fd782d46cb7b00d515c"}});
