// Generated from supplied proto graph. Do not edit.
import {defineSchema,defineCatalog,enumValue} from '../topic-schema.ts';
export const schemas={"evolved":defineSchema({"format":3,"id":"evolved_v3","version":3,"key":"rowId","fields":[{"name":"label","kind":"string","optional":false,"nullable":false},{"name":"detail.name","kind":"string","optional":true,"nullable":false},{"name":"detail.note","kind":"string","optional":true,"nullable":false}],"expansion":{"message":"evolution.Row","parents":[{"path":"detail","message":"evolution.Detail","required":false}],"leaves":[{"path":"label","presence":"explicit","required":true},{"path":"detail.name","presence":"explicit","required":true},{"path":"detail.note","presence":"explicit","required":false}],"enums":{}}} as const)} as const;
export const enums={} as const;
export const catalog=defineCatalog({"evolved":{schema:schemas["evolved"],fingerprint:"1515ab7d95118d262c5ef2f70c041d26296b115e1d631e865492cba294c2d007"}});
