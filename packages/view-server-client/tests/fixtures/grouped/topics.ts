// Generated from proto/topics.proto. Do not edit.
import {defineSchema,defineCatalog} from '../../../src/topic-schema.ts';
export const schemas={"grouped_fixture":defineSchema({"format":2,"id":"grouped_fixture_v2","version":2,"key":"rowId","fields":[{"name":"group","kind":"string","optional":true,"nullable":true},{"name":"number","kind":"number","optional":true,"nullable":true},{"name":"signed","kind":"int64","optional":true,"nullable":true},{"name":"unsigned","kind":"uint64","optional":true,"nullable":true},{"name":"decimal","kind":"decimal","optional":true,"nullable":true},{"name":"boolean","kind":"boolean","optional":true,"nullable":true}]} as const)} as const;
export const keyFields={"GroupedKey":[{"name":"key","tag":1,"kind":"string"}]} as const;
export const catalog=defineCatalog({"grouped_fixture":{schema:schemas["grouped_fixture"],fingerprint:"70d0d8a2a52d630a6617714bc6403f2a3f865df736710a060950e92070e8bba9"}});
