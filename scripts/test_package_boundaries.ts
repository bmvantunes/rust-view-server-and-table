import {test} from 'node:test';import assert from 'node:assert/strict';import {invalidImport} from './package-boundaries.ts';
test('consumer imports use public client exports, with no reverse edge or Rust source imports',()=>{
 for(const value of ['@bruno/rust-view-server','@bruno/rust-view-server/react','../../rust-view-server/crates/core','../view-server-client/src/schema.ts','@bruno/view-server-client/private'])assert(invalidImport('consumer',value,['.','./react','./schema']));
 for(const value of ['@bruno/view-server-client','@bruno/view-server-client/react','@bruno/view-server-client/schema'])assert.equal(invalidImport('consumer',value,['.','./react','./schema']),false);
 assert(invalidImport('client','@bruno/table',['.']));assert(invalidImport('client','@bruno/table/rust',['.']));
});
