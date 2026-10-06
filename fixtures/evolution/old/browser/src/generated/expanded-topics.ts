// Generated from supplied proto graph. Do not edit.
import {defineSchema,defineCatalog,enumValue} from '../topic-schema.ts';
export const schemas={"evolved":defineSchema({"format":3,"id":"evolved_v3","version":3,"key":"rowId","fields":[{"name":"label","kind":"string","optional":false,"nullable":false},{"name":"detail.name","kind":"string","optional":true,"nullable":false}],"expansion":{"message":"evolution.Row","parents":[{"path":"detail","message":"evolution.Detail","required":false}],"leaves":[{"path":"label","presence":"explicit","required":true},{"path":"detail.name","presence":"explicit","required":true}],"enums":{}}} as const)} as const;
export const enums={} as const;
export const catalog=defineCatalog({"evolved":{schema:schemas["evolved"],fingerprint:"47d1278f87d356dfde17e98d4c06757556aa375c6bfeb600aa03fcfce5691213"}});
