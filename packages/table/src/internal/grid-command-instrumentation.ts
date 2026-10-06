import type { BrunoTableGridCommand } from "./column-management";
import { installTableScopedListener } from "./listener-registry";

type GridCommandListener = (command: BrunoTableGridCommand) => void;

const listenersByTableId = new Map<string, Set<GridCommandListener>>();
let listenerCount = 0;

export function recordBrunoTableGridCommand(tableId: string, command: BrunoTableGridCommand): void {
  if (listenerCount === 0) return;
  const listeners = listenersByTableId.get(tableId);
  if (listeners === undefined) return;
  for (const listener of listeners) {
    try {
      listener(command);
    } catch {
      // Diagnostics are observational and must never alter command behavior.
    }
  }
}

export function installBrunoTableGridCommandListener(
  tableId: string,
  listener: GridCommandListener,
): () => void {
  return installTableScopedListener(
    listenersByTableId,
    tableId,
    listener,
    () => {
      listenerCount += 1;
    },
    () => {
      listenerCount -= 1;
    },
  );
}
