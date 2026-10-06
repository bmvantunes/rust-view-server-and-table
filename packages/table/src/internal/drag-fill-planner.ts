import type { BrunoTableCellRangeAxis } from "./cell-range-clipboard";

type BrunoTableNonEmptyCanonicalTexts = readonly [string, ...string[]];

type BrunoTableDragFillIdentitySpan = Readonly<{
  readonly firstIdentity: string;
  readonly lastIdentity: string;
  readonly length: number;
  readonly startIndex: number;
  readonly endIndex: number;
}>;

export type BrunoTableDragFillGesture = Readonly<{
  readonly axis: BrunoTableCellRangeAxis;
  readonly identities: readonly string[];
  readonly indexById: ReadonlyMap<string, number>;
  readonly sourceCanonicalTexts: BrunoTableNonEmptyCanonicalTexts;
  readonly source: BrunoTableDragFillIdentitySpan;
}>;

export type BrunoTableDragFillPreview = Readonly<{
  readonly axis: BrunoTableCellRangeAxis;
  readonly direction: "before" | "after";
  readonly targetIdentity: string;
  readonly source: BrunoTableDragFillIdentitySpan;
  readonly extension: BrunoTableDragFillIdentitySpan;
}>;

export type BrunoTableDragFillCandidate = Readonly<{
  readonly identity: string;
  readonly canonicalText: string;
}>;

export function resolveBrunoTableDragFillAxis({
  dragSlop,
  horizontalDisplacement,
  lockedAxis,
  sourceAxis,
  verticalDisplacement,
}: Readonly<{
  readonly dragSlop: number;
  readonly horizontalDisplacement: number;
  readonly lockedAxis?: BrunoTableCellRangeAxis;
  readonly sourceAxis?: BrunoTableCellRangeAxis;
  readonly verticalDisplacement: number;
}>): BrunoTableCellRangeAxis | undefined {
  if (lockedAxis !== undefined) return lockedAxis;
  const horizontal = Math.abs(horizontalDisplacement);
  const vertical = Math.abs(verticalDisplacement);
  if (Math.max(horizontal, vertical) <= dragSlop) return undefined;
  if (horizontal === vertical) return undefined;
  const dominantAxis = horizontal > vertical ? "horizontal" : "vertical";
  if (sourceAxis !== undefined && dominantAxis !== sourceAxis) return undefined;
  return dominantAxis;
}

/** Capture source evidence against one repository-owned immutable structure reference. */
export function captureBrunoTableDragFillGesture({
  axis,
  identities,
  indexById,
  sourceCanonicalTexts,
  sourceFirstIdentity,
  sourceLastIdentity,
}: Readonly<{
  readonly axis: BrunoTableCellRangeAxis;
  readonly identities: readonly string[];
  readonly indexById: ReadonlyMap<string, number>;
  readonly sourceCanonicalTexts: BrunoTableNonEmptyCanonicalTexts;
  readonly sourceFirstIdentity: string;
  readonly sourceLastIdentity: string;
}>): BrunoTableDragFillGesture | undefined {
  const firstSourceIndex = indexById.get(sourceFirstIdentity);
  const lastSourceIndex = indexById.get(sourceLastIdentity);
  if (
    firstSourceIndex === undefined ||
    lastSourceIndex === undefined ||
    identities[firstSourceIndex] !== sourceFirstIdentity ||
    identities[lastSourceIndex] !== sourceLastIdentity
  ) {
    return undefined;
  }
  const sourceStartIndex = Math.min(firstSourceIndex, lastSourceIndex);
  const sourceEndIndex = Math.max(firstSourceIndex, lastSourceIndex);
  const sourceLength = sourceEndIndex - sourceStartIndex + 1;
  if (sourceCanonicalTexts.length !== sourceLength) return undefined;
  for (let index = sourceStartIndex; index <= sourceEndIndex; index += 1) {
    const identity = identities[index];
    if (identity === undefined || indexById.get(identity) !== index) return undefined;
  }
  const source = freezeIdentitySpan(identities, sourceStartIndex, sourceEndIndex);
  if (source === undefined) return undefined;
  return Object.freeze({
    axis,
    identities,
    indexById,
    sourceCanonicalTexts: Object.freeze([
      ...sourceCanonicalTexts,
    ]) as BrunoTableNonEmptyCanonicalTexts,
    source,
  });
}

/** O(1) pointer-frame projection over the frozen gesture index. */
export function projectBrunoTableDragFillPreview({
  gesture,
  targetIdentity,
}: Readonly<{
  readonly gesture: BrunoTableDragFillGesture;
  readonly targetIdentity: string;
}>): BrunoTableDragFillPreview | undefined {
  const targetIndex = gesture.indexById.get(targetIdentity);
  if (
    targetIndex === undefined ||
    gesture.identities[targetIndex] !== targetIdentity ||
    (targetIndex >= gesture.source.startIndex && targetIndex <= gesture.source.endIndex)
  ) {
    return undefined;
  }
  const direction = targetIndex < gesture.source.startIndex ? "before" : "after";
  const extensionStartIndex = direction === "before" ? targetIndex : gesture.source.endIndex + 1;
  const extensionEndIndex = direction === "before" ? gesture.source.startIndex - 1 : targetIndex;
  const extension = freezeIdentitySpan(gesture.identities, extensionStartIndex, extensionEndIndex);
  if (extension === undefined) return undefined;
  return Object.freeze({
    axis: gesture.axis,
    direction,
    targetIdentity,
    source: gesture.source,
    extension,
  });
}

/** Release-only complete span revalidation and candidate materialization. */
export function materializeBrunoTableDragFillCandidates({
  gesture,
  identities,
  indexById,
  preview,
}: Readonly<{
  readonly gesture: BrunoTableDragFillGesture;
  readonly identities: readonly string[];
  readonly indexById: ReadonlyMap<string, number>;
  readonly preview: BrunoTableDragFillPreview;
}>): readonly [BrunoTableDragFillCandidate, ...BrunoTableDragFillCandidate[]] | undefined {
  if (preview.axis !== gesture.axis || preview.source !== gesture.source) return undefined;
  const affectedStartIndex = Math.min(gesture.source.startIndex, preview.extension.startIndex);
  const affectedEndIndex = Math.max(gesture.source.endIndex, preview.extension.endIndex);
  if (
    !hasCoherentIdentitySpan(
      gesture.identities,
      identities,
      indexById,
      affectedStartIndex,
      affectedEndIndex,
    )
  ) {
    return undefined;
  }
  const candidates: BrunoTableDragFillCandidate[] = [];
  for (let index = preview.extension.startIndex; index <= preview.extension.endIndex; index += 1) {
    const identity = gesture.identities[index];
    const sourceIndex = euclideanModulo(index - gesture.source.startIndex, gesture.source.length);
    const canonicalText = gesture.sourceCanonicalTexts[sourceIndex];
    if (identity === undefined || canonicalText === undefined) return undefined;
    candidates.push(Object.freeze({ identity, canonicalText }));
  }
  const [first, ...rest] = candidates;
  return first === undefined
    ? undefined
    : (Object.freeze([first, ...rest]) as readonly [
        BrunoTableDragFillCandidate,
        ...BrunoTableDragFillCandidate[],
      ]);
}

/** Revalidate only the source and current preview span against a new structure. */
export function isBrunoTableDragFillGestureCoherent({
  gesture,
  identities,
  indexById,
  preview,
}: Readonly<{
  readonly gesture: BrunoTableDragFillGesture;
  readonly identities: readonly string[];
  readonly indexById: ReadonlyMap<string, number>;
  readonly preview: BrunoTableDragFillPreview | undefined;
}>): boolean {
  const startIndex =
    preview === undefined
      ? gesture.source.startIndex
      : Math.min(gesture.source.startIndex, preview.extension.startIndex);
  const endIndex =
    preview === undefined
      ? gesture.source.endIndex
      : Math.max(gesture.source.endIndex, preview.extension.endIndex);
  return hasCoherentIdentitySpan(gesture.identities, identities, indexById, startIndex, endIndex);
}

function hasCoherentIdentitySpan(
  capturedIdentities: readonly string[],
  currentIdentities: readonly string[],
  currentIndexById: ReadonlyMap<string, number>,
  startIndex: number,
  endIndex: number,
): boolean {
  const capturedFirst = capturedIdentities[startIndex];
  const capturedLast = capturedIdentities[endIndex];
  if (capturedFirst === undefined || capturedLast === undefined) return false;
  const currentStartIndex = currentIndexById.get(capturedFirst);
  const currentEndIndex = currentIndexById.get(capturedLast);
  if (
    currentStartIndex === undefined ||
    currentEndIndex === undefined ||
    currentEndIndex - currentStartIndex !== endIndex - startIndex
  ) {
    return false;
  }
  for (let offset = 0; offset <= endIndex - startIndex; offset += 1) {
    const capturedIdentity = capturedIdentities[startIndex + offset];
    if (
      capturedIdentity === undefined ||
      currentIdentities[currentStartIndex + offset] !== capturedIdentity ||
      currentIndexById.get(capturedIdentity) !== currentStartIndex + offset
    ) {
      return false;
    }
  }
  return true;
}

function freezeIdentitySpan(
  identities: readonly string[],
  startIndex: number,
  endIndex: number,
): BrunoTableDragFillIdentitySpan | undefined {
  const firstIdentity = identities[startIndex];
  const lastIdentity = identities[endIndex];
  if (firstIdentity === undefined || lastIdentity === undefined || startIndex > endIndex) {
    return undefined;
  }
  return Object.freeze({
    firstIdentity,
    lastIdentity,
    length: endIndex - startIndex + 1,
    startIndex,
    endIndex,
  });
}

function euclideanModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
