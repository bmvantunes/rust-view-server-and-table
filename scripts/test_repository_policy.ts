import {test} from 'node:test';import assert from 'node:assert/strict';
import {violations} from './repository-policy.ts';
test('policy covers runtime, generators, tests and config while preserving generated output',()=>{
 assert.deepEqual(violations(['scripts/new.py','packages/table/src/new.jsx','packages/table/src/new.mjs','tests/integration/new.js','config/new.cjs','packages/table/src/fake.d.mts','scripts/okay.ts','packages/table/dist/index.mjs','fixtures/rowid-before/projector.mjs','fixtures/rowid-before/projector.d.mts']),['scripts/new.py','packages/table/src/new.jsx','packages/table/src/new.mjs','tests/integration/new.js','config/new.cjs','packages/table/src/fake.d.mts']);
 assert.deepEqual(violations(['packages/table/src/dist/hidden.js','scripts/vendor/hidden.py']),['packages/table/src/dist/hidden.js','scripts/vendor/hidden.py']);
});
