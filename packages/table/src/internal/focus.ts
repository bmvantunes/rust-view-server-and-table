import { useDebouncer } from "@tanstack/react-pacer";
import { useCallback, useLayoutEffect } from "react";

/** Temporarily yields the grid tab stop until native sequential focus traversal completes. */
export function useBrunoTableGridTabStopHandoff(): (grid: HTMLElement) => void {
  const restore = useCallback((grid: HTMLElement): void => {
    if (grid.isConnected) grid.tabIndex = 0;
  }, []);
  const restoration = useDebouncer(restore, { wait: 0 });
  useLayoutEffect(() => () => restoration.cancel(), [restoration]);
  return useCallback(
    (grid: HTMLElement): void => {
      grid.tabIndex = -1;
      restoration.maybeExecute(grid);
    },
    [restoration],
  );
}
