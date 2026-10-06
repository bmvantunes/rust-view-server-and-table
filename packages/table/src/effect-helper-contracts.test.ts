import * as BigDecimal from "effect/BigDecimal";
import { expect, test } from "vite-plus/test";

import { BrunoTableBigDecimalColumn, BrunoTableBigDecimalValueType } from "./effect";
import type { BrunoTableColumns } from "./index";

test("optional BigDecimal helper keeps exact codecs and numeric defaults", () => {
  const columns = [
    BrunoTableBigDecimalColumn({
      columnId: "COL_ID_AMOUNT",
      field: "amount",
      headerName: "Amount",
    }),
  ] satisfies BrunoTableColumns<{ amount: BigDecimal.BigDecimal }>;
  expect(columns[0]).toMatchObject({
    columnId: "COL_ID_AMOUNT",
    headerName: "Amount",
    valueType: BrunoTableBigDecimalValueType,
    cellAlign: "end",
    editorLayout: "inline",
    width: 140,
  });
  const codec = columns[0]!.valueType;
  const amount = BigDecimal.make(900719925474099312345n, 3);
  expect(codec.formatCanonicalText(amount)).toBe("900719925474099312.345");
  expect(codec.equivalent(amount, BigDecimal.make(9007199254740993123450n, 4))).toBe(true);
  const persisted = JSON.parse(JSON.stringify(codec.encodePersisted(amount)));
  const decoded = codec.decodePersisted(persisted);
  expect(decoded._tag).toBe("Success");
  if (decoded._tag !== "Success") throw new Error(decoded.message);
  expect(BigDecimal.format(decoded.value)).toBe("900719925474099312.345");
  expect(codec.parseCanonicalText(" ")._tag).toBe("Failure");
  expect(codec.decodeRuntime(1.25)._tag).toBe("Failure");
  expect(codec.decodeRuntime(null)._tag).toBe("Failure");
  expect(codec.decodeRuntime(undefined)._tag).toBe("Failure");
  expect(codec.decodePersisted({ ...persisted, version: 2 })._tag).toBe("Failure");
});
