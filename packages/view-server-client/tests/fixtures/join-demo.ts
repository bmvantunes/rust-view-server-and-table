// Preserved generated-schema contract setup, extracted from the pinned join demo.
import {createTopicHooks,defineJoin} from '../../src/product-provider';
import {catalog as generatedCatalog} from '../../src/generated/expanded-topics';
// The generated catalog is the only business schema authority in this example.
export const demoCatalog = {shit: generatedCatalog.shit, nested_positions: generatedCatalog.nested_positions};
export const hooks = createTopicHooks(demoCatalog);
export const joined = defineJoin(demoCatalog, {
  left: {topic: 'shit', as: 'l'}, right: {topic: 'nested_positions', as: 'r'},
  kind: 'left', cardinality: 'many_to_one', on: {left: 'oo.name', right: 'details.name'},
  limits: {maxLeftRowsPerKey: 4, maxOutputRows: 1000},
});
const inner = defineJoin(demoCatalog, {...joined.joinDefinition, kind: 'inner'});
export const selected = {
  select: ['l.label', 'l.oo.name', 'l.oo.status', 'l.oo.price', 'r.details.name', 'r.details.status', 'r.details.price'],
  orderBy: [{field: 'l.label', direction: 'asc'}],
} as const;
