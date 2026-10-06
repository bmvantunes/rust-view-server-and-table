type BrunoTableGroupingFocusOwner = Readonly<{
  readonly prepareRemoval: (columnId: string) => () => void;
}>;

const owners = new WeakMap<object, BrunoTableGroupingFocusOwner>();

export function registerBrunoTableGroupingFocusOwner(
  runtime: object,
  owner: BrunoTableGroupingFocusOwner,
): () => void {
  owners.set(runtime, owner);
  return () => {
    if (owners.get(runtime) === owner) owners.delete(runtime);
  };
}

export function prepareBrunoTableGroupingRemovalFocus(
  runtime: object,
  columnId: string,
): () => void {
  return owners.get(runtime)?.prepareRemoval(columnId) ?? (() => undefined);
}
