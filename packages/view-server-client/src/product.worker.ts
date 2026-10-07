type Exports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  product_core_new(): number;
  product_core_alloc(length: number): number;
  product_core_dealloc(pointer: number, length: number): void;
  product_core_apply(handle: number, pointer: number, length: number): number;
  product_core_result(handle: number, pointer: number, length: number): number;
  product_core_stats(handle: number): number;
  product_core_dirty_ids(handle: number): number;
  product_core_output_ptr(handle: number): number;
  product_core_output_len(handle: number): number;
  product_core_error_ptr(handle: number): number;
  product_core_error_len(handle: number): number;
  product_core_free(handle: number): void;
};
type WorkerRequest = { id: number; type: "apply"; command: unknown; traceparent: string; acquisition?: number; previousAcquisition?: number } | { type: "dispose" };
type CoreStats = Record<string, number>;
const workerScope = self as unknown as { onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null; postMessage(message: unknown): void };
let exports: Exports | undefined;
let handle = 0;
let disposed = false;
const subscriptions = new Map<string, number>();
const workerStats = { worker_results_built: 0, worker_rows_serialized: 0, worker_messages_published: 0, worker_unaffected_subscriptions_skipped: 0, worker_no_result_commands: 0, worker_ack_count: 0, worker_result_message_count: 0, worker_message_count: 0, worker_ack_row_occurrences: 0, worker_result_row_occurrences: 0, worker_control_row_occurrences: 0, worker_control_message_count: 0, worker_results_coalesced: 0 };
let queue = Promise.resolve();

function postControl(message: unknown): void {
  workerScope.postMessage(message);
  workerStats.worker_message_count += 1; workerStats.worker_control_message_count += 1;
}
function decode(pointer: number, length: number): string {
  if (!pointer) throw new Error("WASM returned a null byte pointer");
  return new TextDecoder().decode(new Uint8Array(exports!.memory.buffer, pointer, length));
}
function output(): string { return decode(exports!.product_core_output_ptr(handle), exports!.product_core_output_len(handle)); }
function withInput<T>(text: string, action: (pointer: number, length: number) => T): T {
  const bytes = new TextEncoder().encode(text); if (bytes.length === 0) return action(0, 0); const pointer = exports!.product_core_alloc(bytes.length);
  if (!pointer) throw new Error("WASM input allocation failed");
  new Uint8Array(exports!.memory.buffer, pointer, bytes.length).set(bytes);
  try { return action(pointer, bytes.length); } finally { exports!.product_core_dealloc(pointer, bytes.length); }
}
function errorText(): string { return decode(exports!.product_core_error_ptr(handle), exports!.product_core_error_len(handle)); }
function readResult(subscription: string): Record<string, unknown> {
  const status = withInput(subscription, (pointer, length) => exports!.product_core_result(handle, pointer, length));
  if (status !== 0) throw new Error(errorText());
  return JSON.parse(output()) as Record<string, unknown>;
}
function jsonExport(name: "product_core_stats" | "product_core_dirty_ids"): unknown {
  const status = exports![name](handle); if (status !== 0) throw new Error(errorText()); return JSON.parse(output()) as unknown;
}
function stats(): CoreStats { return { ...(jsonExport("product_core_stats") as CoreStats), ...workerStats }; }
async function initialize(): Promise<void> {
  const response = await fetch(new URL("./product_core.wasm",import.meta.url)); if (!response.ok) throw new Error(`WASM fetch failed: ${response.status}`);
  const bytes = await response.arrayBuffer();
  const wasmSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  const instance = await WebAssembly.instantiate(bytes, {}); exports = instance.instance.exports as Exports;
  handle = exports.product_core_new(); if (!handle) throw new Error("WASM failed to create ProductCore");
  if (!disposed) postControl({ type: "ready", wasmSha256 }); else { exports.product_core_free(handle); handle = 0; }
}
void initialize().catch((error: unknown) => { if (!disposed) postControl({ type: "fatal", error: String(error) }); });
workerScope.onmessage = (event) => {
  if (event.data.type === "dispose") { disposed = true; if (handle) exports?.product_core_free(handle); handle = 0; subscriptions.clear(); return; }
  const request = event.data as Extract<WorkerRequest, { type: "apply" }>;
  queue = queue.then(() => {
    if (disposed || !exports || !handle) throw new Error("provider is disposed or not initialized");
    if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/.test(request.traceparent)) throw new Error("invalid W3C traceparent");
    const command = request.command as { command?: string; subscription?: string };
    if (command.command === "close" && subscriptions.get(command.subscription!) !== request.acquisition) {
      throw new Error("obsolete or missing acquisition for close");
    }
    if (command.command === "change_window" && subscriptions.get(command.subscription!) !== request.acquisition) {
      throw new Error("obsolete or missing acquisition for navigation");
    }
    const status = withInput(JSON.stringify(request.command, (key, value) => key === "projection" ? undefined : value), (pointer, length) => exports!.product_core_apply(handle, pointer, length));
    if (status !== 0) {
      const cause = errorText();
      if (cause.includes("terminal") || cause.includes("internal failure")) {
        disposed = true; postControl({ type: "fatal", error: cause }); return;
      }
      throw new Error(cause);
    }
    // From here mutation is committed. Extraction/publication failure is terminal,
    // with an explicit uncertain-delivery cause; it is not a rejected/rolled-back mutation.
    try {
      if ((command.command === "open" || command.command === "change_query") && typeof command.subscription === "string") subscriptions.set(command.subscription, request.acquisition!);
      if (command.command === "close" && typeof command.subscription === "string") subscriptions.delete(command.subscription);
      const dirty = new Set(jsonExport("product_core_dirty_ids") as string[]);
      if (command.command === "change_query" && typeof command.subscription === "string") dirty.add(command.subscription);
      const selected = [...subscriptions.keys()].filter((subscription) => dirty.has(subscription));
      workerStats.worker_unaffected_subscriptions_skipped += subscriptions.size - selected.length;
      if (selected.length === 0) workerStats.worker_no_result_commands += 1;
      const results: Record<string, Record<string, unknown>> = Object.create(null);
      const acquisitions: Record<string, number> = Object.create(null);
      let rows = 0;
      for (const subscription of selected) {
        const value = readResult(subscription); results[subscription] = value;
        acquisitions[subscription] = subscriptions.get(subscription)!;
        workerStats.worker_results_built += 1;
        const count = Array.isArray(value.rows) ? value.rows.length : 0;
        workerStats.worker_rows_serialized += count; rows += count;
      }
      const currentStats = { ...stats(),
        worker_ack_count: workerStats.worker_ack_count + 1,
        worker_message_count: workerStats.worker_message_count + 1,
        worker_ack_row_occurrences: workerStats.worker_ack_row_occurrences + rows,
        worker_messages_published: workerStats.worker_messages_published + selected.length,
      };
      if (!disposed) {
        workerScope.postMessage({ type: "ack", id: request.id, results, acquisitions, stats: currentStats, traceparent: request.traceparent });
        workerStats.worker_ack_count += 1; workerStats.worker_message_count += 1;
        workerStats.worker_ack_row_occurrences += rows;
        workerStats.worker_messages_published += selected.length;
      }
    } catch (error) {
      disposed = true;
      postControl({ type: "fatal", error: `Command applied; result extraction/publication failed (no rollback): ${String(error)}` });
    }
  }).catch((error: unknown) => { if (!disposed) postControl({ type: "request_error", id: request.id, error: String(error), currentAcquisition: subscriptions.get((request.command as { subscription?: string })?.subscription ?? ""), traceparent: request.traceparent }); });
};
