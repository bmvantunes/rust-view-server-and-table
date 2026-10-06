import { Children, Fragment, isValidElement, memo, useSyncExternalStore } from "react";

import type { NamedExoticComponent, ReactElement, ReactNode } from "react";

import { sameBrunoTableToolbarNode } from "./toolbar-node";

export function BrunoTableToolbar({ children }: { readonly children?: ReactNode }): ReactNode {
  if (!hasRenderableChildren(children)) return null;
  return (
    <div
      aria-label="Table controls"
      className="flex min-w-0 items-center gap-2 overflow-x-auto px-3.5 py-2"
      role="toolbar"
    >
      {children}
    </div>
  );
}

const ToolbarOutlet: NamedExoticComponent<
  Readonly<{ readonly reserveEndSpace: boolean; readonly toolbar: BrunoTableToolbarStore }>
> = memo(function ToolbarOutlet({
  reserveEndSpace,
  toolbar,
}: {
  readonly reserveEndSpace: boolean;
  readonly toolbar: BrunoTableToolbarStore;
}): ReactElement | null {
  const snapshot = useSyncExternalStore(
    toolbar.subscribe,
    toolbar.getSnapshot,
    toolbar.getSnapshot,
  );
  return snapshot.hasToolbar ? (
    <div aria-label="Table toolbar" className={reserveEndSpace ? "pe-28" : undefined} role="region">
      {snapshot.children}
    </div>
  ) : null;
});

const GridOwnedToolRail: NamedExoticComponent<Readonly<{ readonly controls: ReactNode }>> = memo(
  function GridOwnedToolRail({ controls }: { readonly controls: ReactNode }): ReactElement | null {
    if (controls === undefined || controls === null) return null;
    return (
      <aside
        aria-label="Grid tools"
        className="pointer-events-none absolute end-0 top-0 z-20 flex w-28 flex-col items-stretch gap-1 border-s bg-background/95 px-2 py-1"
      >
        <div className="pointer-events-auto">{controls}</div>
      </aside>
    );
  },
);

type BrunoTableToolbarSnapshot = Readonly<{
  readonly children: ReactNode;
  readonly hasToolbar: boolean;
}>;

export class BrunoTableToolbarStore {
  private readonly listeners = new Set<() => void>();
  private snapshot: BrunoTableToolbarSnapshot;

  public constructor(children: ReactNode) {
    this.snapshot = createToolbarSnapshot(children);
  }

  public readonly getSnapshot = (): BrunoTableToolbarSnapshot => this.snapshot;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly publish = (children: ReactNode): void => {
    if (sameBrunoTableToolbarNode(this.snapshot.children, children)) return;
    this.snapshot = createToolbarSnapshot(children);
    for (const listener of this.listeners) listener();
  };
}

function createToolbarSnapshot(children: ReactNode): BrunoTableToolbarSnapshot {
  return Object.freeze({ children, hasToolbar: hasRenderableChildren(children) });
}

function hasRenderableChildren(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement(child)) return true;
    if (child.type !== Fragment && child.type !== BrunoTableToolbar) return true;
    return hasRenderableChildren(
      (child as ReactElement<{ readonly children?: ReactNode }>).props.children,
    );
  });
}

export { GridOwnedToolRail, ToolbarOutlet };
