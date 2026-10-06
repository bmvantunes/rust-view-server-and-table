import { describe, expect, it } from "vitest";

import {
  captureBrunoTableDragFillGesture,
  materializeBrunoTableDragFillCandidates,
  projectBrunoTableDragFillPreview,
  resolveBrunoTableDragFillAxis,
} from "./drag-fill-planner";

const orderedColumnIds = Object.freeze([
  "COL_ID_A",
  "COL_ID_B",
  "COL_ID_C",
  "COL_ID_D",
  "COL_ID_E",
  "COL_ID_F",
]);
const columnIndexById = new Map(
  orderedColumnIds.map((columnId, index) => [columnId, index] as const),
);

describe("BrunoTable Drag Fill planner", () => {
  const capture = (
    input: Omit<Parameters<typeof captureBrunoTableDragFillGesture>[0], "identities" | "indexById">,
  ) =>
    captureBrunoTableDragFillGesture({
      ...input,
      identities: orderedColumnIds,
      indexById: columnIndexById,
    });

  const project = (
    gesture: NonNullable<ReturnType<typeof captureBrunoTableDragFillGesture>>,
    targetIdentity: string,
  ) => projectBrunoTableDragFillPreview({ gesture, targetIdentity });

  const materialize = (
    gesture: NonNullable<ReturnType<typeof captureBrunoTableDragFillGesture>>,
    targetIdentity: string,
  ) => {
    const preview = project(gesture, targetIdentity);
    return preview === undefined
      ? undefined
      : materializeBrunoTableDragFillCandidates({
          gesture,
          preview,
          identities: orderedColumnIds,
          indexById: columnIndexById,
        });
  };

  it("stays armed inside drag slop and while dominant displacement is tied", () => {
    expect(
      resolveBrunoTableDragFillAxis({
        dragSlop: 4,
        horizontalDisplacement: 4,
        verticalDisplacement: 1,
      }),
    ).toBeUndefined();
    expect(
      resolveBrunoTableDragFillAxis({
        dragSlop: 4,
        horizontalDisplacement: 7,
        verticalDisplacement: -7,
      }),
    ).toBeUndefined();
  });

  it("locks the dominant axis and preserves it across later diagonal movement", () => {
    const acquired = resolveBrunoTableDragFillAxis({
      dragSlop: 4,
      horizontalDisplacement: -9,
      verticalDisplacement: 6,
    });

    expect(acquired).toBe("horizontal");
    if (acquired === undefined) throw new Error("Expected Drag Fill to acquire an axis.");
    expect(
      resolveBrunoTableDragFillAxis({
        dragSlop: 4,
        horizontalDisplacement: 3,
        lockedAxis: acquired,
        verticalDisplacement: 30,
      }),
    ).toBe("horizontal");
  });

  it("acquires a multi-cell source axis only from dominant parallel movement", () => {
    expect(
      resolveBrunoTableDragFillAxis({
        dragSlop: 4,
        horizontalDisplacement: 2,
        sourceAxis: "horizontal",
        verticalDisplacement: 9,
      }),
    ).toBeUndefined();
    expect(
      resolveBrunoTableDragFillAxis({
        dragSlop: 4,
        horizontalDisplacement: 9,
        sourceAxis: "horizontal",
        verticalDisplacement: 2,
      }),
    ).toBe("horizontal");
    expect(
      resolveBrunoTableDragFillAxis({
        dragSlop: 4,
        horizontalDisplacement: 9,
        sourceAxis: "horizontal",
        verticalDisplacement: 9,
      }),
    ).toBeUndefined();
    expect(
      resolveBrunoTableDragFillAxis({
        dragSlop: 4,
        horizontalDisplacement: 3,
        sourceAxis: "vertical",
        verticalDisplacement: 4,
      }),
    ).toBeUndefined();
  });

  it("plans the exact extension after a source span and repeats its sequence", () => {
    const gesture = capture({
      axis: "horizontal",
      sourceCanonicalTexts: ["alpha", "beta"],
      sourceFirstIdentity: "COL_ID_B",
      sourceLastIdentity: "COL_ID_C",
    });
    const preview = gesture === undefined ? undefined : project(gesture, "COL_ID_F");

    expect(preview).toMatchObject({
      axis: "horizontal",
      direction: "after",
      source: {
        firstIdentity: "COL_ID_B",
        lastIdentity: "COL_ID_C",
        length: 2,
      },
      extension: {
        firstIdentity: "COL_ID_D",
        lastIdentity: "COL_ID_F",
        length: 3,
      },
    });
    expect(gesture === undefined ? undefined : materialize(gesture, "COL_ID_F")).toEqual([
      { canonicalText: "alpha", identity: "COL_ID_D" },
      { canonicalText: "beta", identity: "COL_ID_E" },
      { canonicalText: "alpha", identity: "COL_ID_F" },
    ]);
  });

  it("keeps Euclidean sequence phase for a non-aligned reverse extension", () => {
    const gesture = capture({
      axis: "horizontal",
      sourceCanonicalTexts: ["alpha", "beta", "gamma"],
      sourceFirstIdentity: "COL_ID_D",
      sourceLastIdentity: "COL_ID_F",
    });
    const preview = gesture === undefined ? undefined : project(gesture, "COL_ID_B");

    expect(preview).toMatchObject({
      direction: "before",
      extension: {
        firstIdentity: "COL_ID_B",
        lastIdentity: "COL_ID_C",
        length: 2,
      },
    });
    expect(gesture === undefined ? undefined : materialize(gesture, "COL_ID_B")).toEqual([
      { canonicalText: "beta", identity: "COL_ID_B" },
      { canonicalText: "gamma", identity: "COL_ID_C" },
    ]);

    const longerIdentities = Object.freeze([...orderedColumnIds, "COL_ID_G"]);
    const longerIndexById = new Map(
      longerIdentities.map((columnId, index) => [columnId, index] as const),
    );
    const shiftedGesture = captureBrunoTableDragFillGesture({
      axis: "horizontal",
      identities: longerIdentities,
      indexById: longerIndexById,
      sourceCanonicalTexts: ["alpha", "beta", "gamma"],
      sourceFirstIdentity: "COL_ID_E",
      sourceLastIdentity: "COL_ID_G",
    });
    const shiftedPreview =
      shiftedGesture === undefined
        ? undefined
        : projectBrunoTableDragFillPreview({
            gesture: shiftedGesture,
            targetIdentity: "COL_ID_A",
          });

    expect(
      shiftedGesture === undefined || shiftedPreview === undefined
        ? undefined
        : materializeBrunoTableDragFillCandidates({
            gesture: shiftedGesture,
            preview: shiftedPreview,
            identities: longerIdentities,
            indexById: longerIndexById,
          }),
    ).toEqual([
      { canonicalText: "gamma", identity: "COL_ID_A" },
      { canonicalText: "alpha", identity: "COL_ID_B" },
      { canonicalText: "beta", identity: "COL_ID_C" },
      { canonicalText: "gamma", identity: "COL_ID_D" },
    ]);
  });

  it("repeats one immutable source cell across the complete extension", () => {
    const sourceCanonicalTexts: [string] = ["stable"];
    const gesture = capture({
      axis: "vertical",
      sourceCanonicalTexts,
      sourceFirstIdentity: "COL_ID_C",
      sourceLastIdentity: "COL_ID_C",
    });
    sourceCanonicalTexts[0] = "changed after capture";

    expect(gesture === undefined ? undefined : materialize(gesture, "COL_ID_F")).toEqual([
      { canonicalText: "stable", identity: "COL_ID_D" },
      { canonicalText: "stable", identity: "COL_ID_E" },
      { canonicalText: "stable", identity: "COL_ID_F" },
    ]);
    expect(gesture === undefined ? undefined : Object.isFrozen(gesture.sourceCanonicalTexts)).toBe(
      true,
    );
  });

  it("retains one immutable identity structure and keeps frame projection O(1)", () => {
    const identities = Object.freeze([...orderedColumnIds]);
    let indexReads = 0;
    const instrumentedIndex = new Proxy(columnIndexById, {
      get(target, property, receiver) {
        if (property === "get") {
          return (identity: string) => {
            indexReads += 1;
            return target.get(identity);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const gesture = captureBrunoTableDragFillGesture({
      axis: "horizontal",
      identities,
      indexById: instrumentedIndex,
      sourceCanonicalTexts: ["stable"],
      sourceFirstIdentity: "COL_ID_C",
      sourceLastIdentity: "COL_ID_C",
    });
    indexReads = 0;
    const preview = gesture === undefined ? undefined : project(gesture, "COL_ID_F");
    expect(preview?.extension.length).toBe(3);
    expect(indexReads).toBe(1);
    expect(gesture?.identities).toBe(identities);
    expect(gesture === undefined ? undefined : Object.isFrozen(gesture.identities)).toBe(true);
  });

  it("retains immutable structure references while capturing only the source span", () => {
    const logicalIdentities = Object.freeze(
      Array.from({ length: 100_000 }, (_unused, index) => `ROW_ID_${String(index)}`),
    );
    let identityReads = 0;
    const identities = new Proxy(logicalIdentities, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) identityReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const indexById = new Map(
      logicalIdentities.map((identity, index) => [identity, index] as const),
    );

    const gesture = captureBrunoTableDragFillGesture({
      axis: "vertical",
      identities,
      indexById,
      sourceCanonicalTexts: ["alpha", "beta", "gamma"],
      sourceFirstIdentity: "ROW_ID_50000",
      sourceLastIdentity: "ROW_ID_50002",
    });

    expect(gesture).toBeDefined();
    expect(gesture?.identities).toBe(identities);
    expect(identityReads).toBeLessThanOrEqual(8);
  });

  it("rejects an incomplete span only during release materialization", () => {
    const identities = [
      "COL_ID_A",
      "COL_ID_B",
      undefined,
      "COL_ID_D",
    ] as unknown as readonly string[];
    const indexById = new Map([
      ["COL_ID_A", 0],
      ["COL_ID_B", 1],
      ["COL_ID_D", 3],
    ]);

    const gesture = captureBrunoTableDragFillGesture({
      axis: "horizontal",
      identities: orderedColumnIds,
      indexById: columnIndexById,
      sourceCanonicalTexts: ["stable"],
      sourceFirstIdentity: "COL_ID_A",
      sourceLastIdentity: "COL_ID_A",
    });
    const preview = gesture === undefined ? undefined : project(gesture, "COL_ID_D");

    expect(preview).toBeDefined();
    expect(
      gesture === undefined || preview === undefined
        ? undefined
        : materializeBrunoTableDragFillCandidates({
            gesture,
            preview,
            identities,
            indexById,
          }),
    ).toBeUndefined();
  });

  it("rejects a same-length interior identity move during release materialization", () => {
    const identities = Object.freeze([
      "COL_ID_A",
      "COL_ID_C",
      "COL_ID_B",
      "COL_ID_D",
      "COL_ID_E",
      "COL_ID_F",
    ]);
    const indexById = new Map(identities.map((columnId, index) => [columnId, index] as const));
    const gesture = captureBrunoTableDragFillGesture({
      axis: "horizontal",
      identities: orderedColumnIds,
      indexById: columnIndexById,
      sourceCanonicalTexts: ["stable"],
      sourceFirstIdentity: "COL_ID_A",
      sourceLastIdentity: "COL_ID_A",
    });
    const preview = gesture === undefined ? undefined : project(gesture, "COL_ID_D");

    expect(preview).toBeDefined();
    expect(
      gesture === undefined || preview === undefined
        ? undefined
        : materializeBrunoTableDragFillCandidates({
            gesture,
            preview,
            identities,
            indexById,
          }),
    ).toBeUndefined();
  });

  it("preserves an exact affected span when identities are appended outside it", () => {
    const gesture = captureBrunoTableDragFillGesture({
      axis: "horizontal",
      identities: orderedColumnIds,
      indexById: columnIndexById,
      sourceCanonicalTexts: ["stable"],
      sourceFirstIdentity: "COL_ID_A",
      sourceLastIdentity: "COL_ID_A",
    });
    const preview = gesture === undefined ? undefined : project(gesture, "COL_ID_D");
    const identities = Object.freeze([...orderedColumnIds, "COL_ID_G"]);
    const indexById = new Map(identities.map((columnId, index) => [columnId, index] as const));

    expect(
      gesture === undefined || preview === undefined
        ? undefined
        : materializeBrunoTableDragFillCandidates({ gesture, preview, identities, indexById }),
    ).toEqual([
      { identity: "COL_ID_B", canonicalText: "stable" },
      { identity: "COL_ID_C", canonicalText: "stable" },
      { identity: "COL_ID_D", canonicalText: "stable" },
    ]);
  });

  it("preserves an exact affected span after a uniform index shift", () => {
    const gesture = captureBrunoTableDragFillGesture({
      axis: "horizontal",
      identities: orderedColumnIds,
      indexById: columnIndexById,
      sourceCanonicalTexts: ["stable"],
      sourceFirstIdentity: "COL_ID_B",
      sourceLastIdentity: "COL_ID_B",
    });
    const preview = gesture === undefined ? undefined : project(gesture, "COL_ID_D");
    const identities = Object.freeze(["COL_ID_PREPENDED", ...orderedColumnIds]);
    const indexById = new Map(identities.map((columnId, index) => [columnId, index] as const));

    expect(
      gesture === undefined || preview === undefined
        ? undefined
        : materializeBrunoTableDragFillCandidates({ gesture, preview, identities, indexById }),
    ).toEqual([
      { identity: "COL_ID_C", canonicalText: "stable" },
      { identity: "COL_ID_D", canonicalText: "stable" },
    ]);
  });

  it("returns no preview inside the source or capture for inconsistent source evidence", () => {
    const gesture = capture({
      axis: "horizontal",
      sourceCanonicalTexts: ["alpha", "beta"],
      sourceFirstIdentity: "COL_ID_B",
      sourceLastIdentity: "COL_ID_C",
    });
    expect(
      gesture === undefined
        ? undefined
        : projectBrunoTableDragFillPreview({ gesture, targetIdentity: "COL_ID_C" }),
    ).toBeUndefined();
    expect(
      capture({
        axis: "horizontal",
        sourceCanonicalTexts: ["only one"],
        sourceFirstIdentity: "COL_ID_B",
        sourceLastIdentity: "COL_ID_C",
      }),
    ).toBeUndefined();
  });
});
