// Compile-only examples using the same generated schemas and public hooks as the page.
import {hooks, joined, selected} from '../tests/fixtures/join-demo';
import type {Decimal, EnumValue} from './topic-schema';
function selectedContract() {
  const result = hooks.useLiveQuery(joined, selected);
  for (const row of result.rows) {
    const status: EnumValue<'example.common.Status'> | undefined = row.l.oo?.status;
    const exact: Decimal | null | undefined = row.r?.details?.price;
    // @ts-expect-error stable identities are readonly
    row.rowId = 'replacement';
    // @ts-expect-error omitted fields do not appear just because the source has them
    row.l.oo?.note;
    // @ts-expect-error a LEFT result may have a null right root
    row.r.details;
    // @ts-expect-error enum domains remain exact
    const wrongDomain: EnumValue<'other.Status'> | undefined = row.l.oo?.status;
    void [status, exact, wrongDomain];
  }
  const view = hooks.useLiveQueryViewport(joined);
  const helper = view.useWholeResult(selected);
  const helperEnum: EnumValue<'example.common.Status'> | undefined = helper.rows[0]?.r?.details?.status;
  view.viewport.replace({query: selected, window: {firstRow: 0, lastRow: 1}, sink: {
    setRowCount() {}, setRowData(rows) {
      if (!rows[0]) return;
      const exact: Decimal | null | undefined = rows[0].l.oo?.price;
      // @ts-expect-error viewport sink identities are readonly too
      rows[0].rowId = 'replacement';
      // @ts-expect-error the sink has the same exact selected fields
      rows[0].r?.details?.quantity;
      void exact;
    },
  }});
  void helperEnum;
}
void selectedContract;
