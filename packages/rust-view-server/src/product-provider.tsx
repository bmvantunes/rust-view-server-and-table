export type {CompleteSnapshot} from './complete-client';
import {CompleteClient, type CompleteSnapshot} from './complete-client';
import {identityHash,joinSchema,validateJoinQuery,type JoinHandle,type JoinSpec,type JoinWire,type JoinedSchema,type JoinResult,type JoinQueryCheck} from './join-schema';
export {defineJoin} from './join-schema';
import {validRowId} from './row-id.mjs';
import { defineCatalog, validateQuery as validateCatalogQuery, type BrowserCatalog, type Schema, queryFields, type TopicQuery, type QueryResult, type QueryCheck, type Aggregate, type RowsWithRowId, type FieldName } from "./topic-schema";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useId,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

export type TraceOperation = {context?:string;end(outcome?:string):void};
export type ClientTelemetry = {workerConfig?:{endpoint:string;sampleRatio?:number;maxSpansPerSecond?:number;deployment?:string};start(name:string,parent?:string,links?:string[]):TraceOperation|undefined};
export type OperationalHealthSnapshot = {version:1;instance:string;sequence:number;sampled_at_unix_ms:number;observed_at_ms:number;phase:string;startup_complete:boolean;ready:boolean;live:boolean;reason:string;authority_safe:boolean;sources:Array<{topic:string;source_id:string;dependencies:string[];policy:{max_sample_age_ms:number};partitions:Array<{partition:number;assigned:boolean;bootstrap_complete:boolean;fetched_next:string|null;durable_next:string|null;derived_next:string|null;serving_next:string|null;readable_end:string|null;readable_sample_ms:number|null;transaction_blocked:boolean|null}>}>;dependencies:Array<{id:string;resource_id:string;role:string;state:string;reason:string|null;attribution:string}>};
export type HealthObservation = {status:LiveQueryStatus;snapshot?:OperationalHealthSnapshot;error?:string};
export type ProductAcquisitionIdentity = number;

export type ProductResult = {
  result_kind?:"grouped_v1"|"global_v1"|"join_v1"|"join_grouped_v1"|"join_global_v1"; result_shape?:string;
  traceContext?: string;
  /** Transport receipt metadata, not React commit/paint; integers stay exact strings. */
  remote?: { sourceSequence: string; incarnation: string; connection: string; acquisition: number; requestId?: number; receivedNs: number; encodedBytes: number };
  keys?: string[];
  subscription: string;
  query_generation: number;
  sequence: number;
  start_rank: number;
  version: number;
  total_rows: number;
  rows: Array<Partial<ProductPayload>>;
};

export type ProductPayload = {
    id: string;
    category: string;
    label: { state: "missing" | "null" } | { state: "value"; value: string };
    quantity: string;
    amount: { coefficient: string; scale: number };
  };

export type ProductQuery = {
  projection?: readonly ProductField[];
  where_expr: unknown;
  direction: "ascending" | "descending";
  offset: number;
  limit: number;
};

/** Internal transport query. Schema identity participates in every desired intent. */
export type TopicRuntimeQuery = { semantic_profile?:"effect-4.2.8"; join?:JoinWire; topic:string; schema:string; global?:true;having?:unknown; select?:readonly string[]; group_by?:readonly string[]; aggregates?:Readonly<Record<string,{readonly aggFunc:"count";readonly field?:never}|{readonly aggFunc:"countDistinct"|"sum"|"avg"|"min"|"max";readonly field:string}>>; where?:unknown; order_by:readonly {field?:string;aggregate?:string;direction:'asc'|'desc'}[]; offset:number; limit:number };
type RuntimeQuery = ProductQuery | TopicRuntimeQuery;
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type LiveQueryStatus = "loading" | "ready" | "stale" | "closed" | "error";
type Listener = ((result: ProductResult) => void) & { onError?: (error: Error) => void; onStatus?: (status: LiveQueryStatus) => void };
export class SupersededReadError extends Error { readonly code = "read_superseded"; }
export class TransientConnectionError extends Error { readonly code = "transport_uncertain"; }

export type ProductCoreStats = {
  upsert_predicate_checks: number;
  delete_predicate_checks: number;
  query_seed_rows_scanned: number;
  final_close_rows_scanned: number;
  differential_input_insertions: number;
  differential_input_retractions: number;
  differential_output_updates_observed: number;
  consolidation_input_records: number;
  consolidated_deltas_emitted: number;
  shape_id_lookups: number;
  ranked_index_insertions: number;
  ranked_index_retractions: number;
  result_calls: number;
  result_rows_extracted: number;
  active_subscriptions: number;
  active_query_shapes: number;
  retained_rows: number;
  worker_results_built: number;
  worker_rows_serialized: number;
  worker_messages_published: number;
  worker_unaffected_subscriptions_skipped: number;
  worker_no_result_commands: number;
  directed_index_records_traversed: number;
  directed_index_records_cloned: number;
  directed_index_records_transferred: number;
  directed_indexes_constructed: number;
  wasm_result_rows_encoded: number;
  worker_ack_count: number;
  worker_result_message_count: number;
  worker_message_count: number;
  worker_ack_row_occurrences: number;
  worker_result_row_occurrences: number;
  worker_control_row_occurrences: number;
  worker_control_message_count: number;
  worker_results_coalesced: number;
};
type ApplyResponse = { type: "ack"; id: number; results: Record<string, ProductResult>; acquisitions: Record<string, number>; stats: ProductCoreStats; traceparent: string };
type WorkerMessage =
  | { type: "ready"; wasmSha256?: string; serverIncarnation?: string }
  | {type:"query_error";subscription:string;acquisition:number;error:string}
  | { type: "live"; results: Record<string, ProductResult>; acquisitions: Record<string, number> }
  | { type: "fatal"; error: string; recoverable?: boolean; code?: string }
  | { type: "health"; snapshot: OperationalHealthSnapshot }
  | { type: "health_unavailable" }
  | ApplyResponse
  | { type: "request_error"; id: number; error: string; currentAcquisition?: number; traceparent: string };

class CommandRejection extends Error {
  constructor(message: string, readonly currentAcquisition: number | undefined) { super(message); }
}

export type ProviderOptions = { mode: "local" } | {
  mode: "memory"; catalog: BrowserCatalog; sources: unknown; module: WebAssembly.Module; maxRows?: number; subscriptions?: number; retention?: Record<string, {maxRetentionMinutes?:number;maxRetentionMessages?:number;maxRetentionMessagesPerKey?:number}>; nowMs?:number;
} | {
  mode: "remote"; url: string; token: string;
  /** Must fit the server's advertised capability. Default preserves the remote demo cap. */
  subscriptions?: number;
  /** Immutable public schemas only; no source endpoints or credentials. */
  catalog?: BrowserCatalog;
  /** Opt in to selected-field patches when the server negotiates support. */
  fieldPatches?: boolean;
  /** Explicit successor-catalog reconnect; never mutates a mounted catalog. */
  schemaEvolution?: boolean;
  recovery?: { budgetMs?: number; maxAttempts?: number; initialDelayMs?: number; maxDelayMs?: number; healthyMs?: number };

};

export class BrowserProductProvider {
  private worker!: Worker;
  private completeClients=new Set<CompleteClient<Schema>>();
  watchComplete<const S extends Schema>(topic:string, schema:S, fingerprint:string, listener:(snapshot:CompleteSnapshot<S>)=>void):()=>void {
    if(this.terminalCause)throw this.terminalCause;
    if(this.options.mode!=="remote"||this.options.catalog?.[topic]?.fingerprint!==fingerprint)throw Error("Complete source requires matching remote catalog");
    if(schema.format<2)throw Error("Complete source requires authoritative rowId schema");
    if(this.completeClients.size)throw Error("One complete acquisition per provider");
    const client=new CompleteClient(topic,schema,fingerprint,m=>this.worker.postMessage(m),listener);
    // Schema is runtime-verified above; the erased collection is only lifecycle ownership.
    const owned=client as unknown as CompleteClient<Schema>;this.completeClients.add(owned);
    if(this.lifecycle==="ready")client.start();
    return()=>{this.completeClients.delete(owned);client.dispose();};
  }
  private attempt = 0;
  private retryCount = 0;
  private recoveryStarted?: number;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private budgetTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private terminalCode?: string;
  get connectionDiagnostics() { return { phase: this.lifecycle, attempt: this.attempt, retryCount: this.retryCount, terminalCode: this.terminalCode }; }
  private healthyTimer?: ReturnType<typeof setTimeout>;
  private readonly policy: Required<NonNullable<Extract<ProviderOptions, {mode: "remote"}>["recovery"]>>;
  private healthValue:HealthObservation={status:"loading"};
  private readonly healthListeners=new Set<()=>void>();
  private healthTimer?:ReturnType<typeof setTimeout>;
  readonly getHealthSnapshot=():HealthObservation=>this.healthValue;
  readonly subscribeHealth=(listener:()=>void):(()=>void)=>{
    if(this.terminalCause)return()=>{};
    const first=this.healthListeners.size===0;this.healthListeners.add(listener);
    if(first&&this.lifecycle==="ready"&&this.options.mode==="remote")this.worker.postMessage({type:"health_subscribe",enabled:true});
    if(this.options.mode!=="remote")this.setHealth({status:"error",error:"health_unavailable"});
    return()=>{this.healthListeners.delete(listener);if(!this.healthListeners.size){clearTimeout(this.healthTimer);if(this.lifecycle==="ready"&&this.options.mode==="remote")this.worker.postMessage({type:"health_subscribe",enabled:false});if(!this.terminalCause&&this.healthValue.snapshot)this.healthValue={...this.healthValue,status:"stale"};}};
  };
  private setHealth(value:HealthObservation):void{
    this.healthValue=value;const attempt=this.attempt;
    for(const listener of [...this.healthListeners]){if(this.attempt!==attempt||this.healthValue!==value)break;if(!this.healthListeners.has(listener))continue;try{listener();}catch(e){this.report("health",normalizeError(e));}}
  }
  private trace(name:string,parent?:string):TraceOperation|undefined{try{return this.telemetry?.start(name,parent);}catch{return;}}
  private readonly connectionListeners = new Set<() => void>();
  private connection: ConnectionStatus = "connecting";
  readonly recoveryEvents: Array<{ at: number; attempt: number; phase: string; code?: string; delayMs?: number }> = [];
  get connectionStatus(): ConnectionStatus { return this.connection; }
  readonly getConnectionStatus = (): ConnectionStatus => this.connection;
  readonly subscribeConnectionStatus = (listener: () => void): (() => void) => {
    this.connectionListeners.add(listener);
    return () => { this.connectionListeners.delete(listener); };
  };
  private phase(phase: string, code?: string, delayMs?: number): void {
    this.recoveryEvents.push({ at: performance.now(), attempt: this.attempt, phase, code, delayMs });
    if (this.recoveryEvents.length > 256) this.recoveryEvents.shift();
  }
  private setConnection(value: ConnectionStatus): void {
    if (value === this.connection) return;
    this.connection = value;
    for (const listener of [...this.connectionListeners]) {
      if (this.connection !== value) break;
      if (!this.connectionListeners.has(listener)) continue;
      try { listener(); } catch (error) { this.report("connection-status", normalizeError(error)); }
    }
  }
  private status(subscription: string, value: LiveQueryStatus): void {
    const entry = this.listeners.get(subscription);
    if (!entry || !entry.isActive() || entry.status === value) return;
    entry.status = value;
    try { entry.listener.onStatus?.(value); } catch (error) { this.report(subscription, normalizeError(error)); }
  }
  private newReadiness(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => undefined);
  }
  private startAttempt(): void {
    if (this.terminalCause) return;
    const attempt = ++this.attempt;
    this.lifecycle = "initializing";
    this.phase("connecting");
    if (this.options.mode === "remote") this.connectTimer = setTimeout(() => { if (this.attempt === attempt && this.lifecycle === "initializing") this.recover(new Error("connect/handshake deadline; pending completion uncertain"), "connect-timeout"); }, 10000);
    this.worker = this.options.mode === "remote"
      ? new Worker(new URL("./product.remote.worker.ts", import.meta.url), { type: "module" })
      : this.options.mode === "memory"
        ? new Worker(new URL("./generic.worker.ts", import.meta.url), { type: "module" })
        : new Worker(new URL("./product.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => { if (attempt === this.attempt) this.receive(event.data); };
    this.worker.onerror = (event) => { if (attempt === this.attempt) this.fail(new Error(event.message || "ProductCore Worker failed")); };
    this.worker.onmessageerror = () => { if (attempt === this.attempt) this.fail(new Error("ProductCore Worker message could not be decoded")); };
    if (this.options.mode === "remote") this.worker.postMessage({ type: "configure", options: this.options, telemetry: this.telemetry?.workerConfig });
    if (this.options.mode === "memory") {
      this.connectTimer = setTimeout(() => { if (this.lifecycle === "initializing") this.fail(new Error("memory engine initialization deadline")); }, 10000);
      this.worker.postMessage({ type: "configure", options: this.options });
    }
  }
  private recover(error: Error, code?: string): void {
    if (this.terminalCause || this.lifecycle === "retry-wait") return;
    if (this.options.mode !== "remote") { this.fail(error); return; }
    this.phase("attempt-lost", code);
    this.lifecycle = "retry-wait";
    const attempt = ++this.attempt; // Invalidate callbacks before rejecting anything or calling consumers.
    clearTimeout(this.healthyTimer); clearTimeout(this.connectTimer);
    for(const client of this.completeClients)client.lost();
    this.worker.terminate();
    clearTimeout(this.healthTimer);this.setHealth({...this.healthValue,status:this.healthValue.snapshot?"stale":"loading"});
    if (this.terminalCause || this.attempt !== attempt) return;
    this.acquisitions.clear(); this.freshness.clear(); this.completed.clear();
    const pending = [...this.pending.values(), ...this.dispatchQueue];
    this.pending.clear(); this.dispatchQueue.length = 0;
    const uncertain = new TransientConnectionError(error.message);
    this.readyReject(uncertain);
    for (const request of pending) request.reject(uncertain);
    // Rejection rollback can also notify consumers before the next readiness is allocated.
    if (this.terminalCause || this.attempt !== attempt) return;
    this.newReadiness();
    if (this.recoveryStarted === undefined) {
      this.recoveryStarted = performance.now();
      this.budgetTimer = setTimeout(() => this.fail(new Error("recovery budget exhausted; pending completion uncertain"), "recovery-budget"), this.policy.budgetMs);
    }
    if (++this.retryCount >= this.policy.maxAttempts) { this.fail(new Error("recovery attempts exhausted; pending completion uncertain"), "recovery-attempts"); return; }
    this.setConnection("connecting");
    for (const [sub, entry] of [...this.listeners]) {
      if (this.terminalCause) return;
      if (this.listeners.get(sub) === entry) this.status(sub, entry.display ? "stale" : "loading");
    }
    if (this.terminalCause || this.attempt !== attempt) return;
    const ceiling = Math.min(this.policy.maxDelayMs, this.policy.initialDelayMs * 2 ** Math.min(this.retryCount - 1, 20));
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    this.phase("retry-wait", code, delay);
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.startAttempt(); }, delay);
  }
  private acquire(subscription: string): void {
    const entry = this.listeners.get(subscription);
    if (!entry || this.terminalCause) return;
    const acquisition = this.nextAcquisition++;
    entry.acquisition = acquisition;
    const desired = entry.desired;
    entry.undispatchedRead = undefined;
    void this.submit({ command: "open", subscription, query: desired }, newTraceparent(), acquisition).catch((error: unknown) => {
      if (error instanceof TransientConnectionError || this.terminalCause || !entry.isActive() || this.listeners.get(subscription) !== entry || entry.acquisition !== acquisition) return;
      if (entry.confirmedDesired && entry.desired === desired && JSON.stringify(entry.confirmedDesired) !== JSON.stringify(desired)) {
        entry.desired = entry.confirmedDesired;
        this.acquire(subscription);
      }
      this.status(subscription, "error");
      if (this.listeners.get(subscription) === entry && entry.isActive()) this.notifyError(subscription, entry.listener, normalizeError(error), () => entry.isActive() && this.listeners.get(subscription) === entry);
    });
  }
  private readonly listeners = new Map<string, { acquisition: ProductAcquisitionIdentity; listener: Listener; release: () => void; isActive: () => boolean; desired: RuntimeQuery; readRevision: number; desiredOwner: number; undispatchedRead?: { desired: RuntimeQuery; display?: ProductResult; owner: number }; confirmedDesired?: RuntimeQuery; confirmedAttempt?: number; confirmedAcquisition?: number; confirmedRequestId?: number; display?: ProductResult; status: LiveQueryStatus }>();
  private readonly acquisitions = new Map<string, ProductAcquisitionIdentity>();
  private readonly pending = new Map<number, { resolve: (results: Record<string, ProductResult>) => void; reject: (error: Error) => void; traceparent: string }>();
  private readonly freshness = new Map<string, ProductResult>();
  // One latest completed candidate per registered subscription, never a result history.
  // A pending desired acquisition can suppress delivery without destroying rollback data.
  private readonly completed = new Map<string, { acquisition: ProductAcquisitionIdentity; result: ProductResult }>();
  private reporting = false;
  private submitted = 0;
  private readonly subscriptionLimit: number;
  private readonly commandLimit: number;
  private readonly commandWindow: number;
  private readonly dispatchQueue: Array<{ send: () => void; reject: (error: Error) => void }> = [];
  private draining = false;
  /** Bounded counters, useful for admission and cleanup diagnostics. */
  get admission() { return { subscriptions: this.listeners.size, outstanding: this.submitted,
    inFlight: this.pending.size, queued: this.dispatchQueue.length,
    subscriptionLimit: this.subscriptionLimit, commandLimit: this.commandLimit, commandWindow: this.commandWindow }; }
  private drain(): void {
    if (this.draining || this.terminalCause) return;
    this.draining = true;
    try { while (!this.terminalCause && this.pending.size < this.commandWindow && this.dispatchQueue.length) this.dispatchQueue.shift()!.send(); }
    finally { this.draining = false; }
  }
  private nextRequestId = 1;
  private nextAcquisition = 1;
  private terminalCause?: Error;
  lastWorkerTraceparent?: string;
  lastWorkerWasmSha256?: string;
  lastWorkerStats?: ProductCoreStats;
  /** Observable, non-recursive fallback, including exceptions thrown by the reporter itself. */
  readonly consumerErrors: Array<{ subscription: string; error: Error }> = [];
  onConsumerError?: (error: Error, subscription: string) => void;
  private lifecycle: "initializing" | "ready" | "retry-wait" | "failed" | "disposed" = "initializing";
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readyPromise!: Promise<void>;
  get ready(): Promise<void> { return this.readyPromise; }

  constructor(private readonly options: ProviderOptions = { mode: "local" }, private readonly telemetry?: ClientTelemetry) {
    this.options = structuredClone(options);
    if (this.options.mode !== "local" && this.options.catalog) this.options.catalog = defineCatalog(this.options.catalog); // Credential/endpoint scope is immutable for this logical lifetime.
    this.policy = { budgetMs: 30000, maxAttempts: 12, initialDelayMs: 150, maxDelayMs: 3000, healthyMs: 10000, ...(options.mode === "remote" ? options.recovery : {}) };
    if (Object.values(this.policy).some(value => !Number.isSafeInteger(value) || value < 1) || this.policy.maxDelayMs < this.policy.initialDelayMs) throw new Error("invalid recovery policy");
    const subscriptions = options.mode !== "local" ? options.subscriptions ?? 16 : Infinity;
    if (options.mode !== "local" && (!Number.isInteger(subscriptions) || subscriptions < 1 || subscriptions > 128)) throw new Error("remote subscription limit must be 1..128");
    this.subscriptionLimit = subscriptions;
    // Reserve bounded room for mount, StrictMode cleanup/remount, and navigation.
    this.commandLimit = options.mode !== "local" ? 4 * subscriptions + 32 : Infinity;
    this.commandWindow = options.mode !== "local" ? 4 : Infinity;
    this.newReadiness();
    this.startAttempt();
  }

  private receive(message: WorkerMessage): void {
    if([...this.completeClients].some(client=>client.receive(message)))return;
    if (this.terminalCause) return;
    if(message.type==="health_unavailable"){this.setHealth({...this.healthValue,status:"error",error:"health_unavailable"});return;}
    if(message.type==="health"){
      if(!this.healthListeners.size)return;
      const s=message.snapshot,prior=this.healthValue.snapshot;if(prior?.instance===s.instance&&prior.sequence>=s.sequence)return;
      clearTimeout(this.healthTimer);this.setHealth({status:"ready",snapshot:s});
      if(this.terminalCause||this.healthValue.snapshot!==s||!this.healthListeners.size)return;
      this.healthTimer=setTimeout(()=>{if(this.healthValue.snapshot===s)this.setHealth({status:"stale",snapshot:s});},5000);return;
    }
    if (message.type === "ready") {
      if (this.lifecycle === "initializing") {
        this.lastWorkerWasmSha256 = message.wasmSha256; this.lifecycle = "ready";
        clearTimeout(this.connectTimer); this.phase("handshake-ready"); this.readyResolve();for(const client of this.completeClients)client.start();
        this.setConnection("connected");
        if (this.terminalCause || this.lifecycle !== "ready") return;
        if(this.healthListeners.size&&this.options.mode==="remote")this.worker.postMessage({type:"health_subscribe",enabled:true});
        if (this.options.mode === "remote") {
          const attempt = this.attempt;
          this.healthyTimer = setTimeout(() => {
            if (!this.terminalCause && this.attempt === attempt && this.lifecycle === "ready") {
              this.retryCount = 0; this.recoveryStarted = undefined; clearTimeout(this.budgetTimer); this.phase("healthy");
            }
          }, this.policy.healthyMs);
        }
        // Initial registrations already wait on initial readiness. Later attempts
        // reconcile current intent, never a previous attempt's command log.
        if (this.attempt > 1) for (const sub of [...this.listeners.keys()]) { if (this.terminalCause) break; this.acquire(sub); }
      }
      return;
    }
    if (message.type === "fatal") { if (message.recoverable) this.recover(new Error(message.error), message.code); else this.fail(new Error(message.error), message.code ?? "protocol"); return; }
    if (message.type === "live") { this.publish(message.results, message.acquisitions); return; }
    if(message.type==='query_error'){
      const entry=this.listeners.get(message.subscription);
      if(entry&&entry.acquisition===message.acquisition){this.acquisitions.delete(message.subscription);this.completed.delete(message.subscription);this.freshness.delete(message.subscription);entry.confirmedDesired=undefined;entry.confirmedAcquisition=undefined;this.status(message.subscription,'error');this.notifyError(message.subscription,entry.listener,new Error(message.error),()=>this.listeners.get(message.subscription)===entry&&entry.acquisition===message.acquisition);}return;
    }
    // Unknown/obsolete variants cannot mutate freshness or consumer state.
    if (message.type !== "ack" && message.type !== "request_error") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    this.lastWorkerTraceparent = message.traceparent;
    if (message.traceparent !== pending.traceparent) {
      const error = new Error("W3C traceparent changed across Worker boundary");
      pending.reject(error); this.fail(error); return;
    }
    if (message.type === "request_error") { pending.reject(new CommandRejection(message.error, message.currentAcquisition)); this.drain(); return; }
    this.lastWorkerStats = message.stats;
    // Settlement is independent of user callbacks; the same objects are reused locally.
    pending.resolve(message.results);
    this.publish(message.results, message.acquisitions);
    this.drain();
  }

  private publish(results: Record<string, ProductResult>, acquisitions: Record<string, number>): void {
    for (const [subscription, next] of Object.entries(results)) {
      if (this.terminalCause) break; // a callback can reenter dispose/fail
      const acquisition = acquisitions[subscription];
      const entry = this.listeners.get(subscription);
      if (!entry || !this.acquisitions.has(subscription) || next.subscription !== subscription) continue;
      const candidate = this.completed.get(subscription);
      if (!candidate || acquisition > candidate.acquisition ||
        (acquisition === candidate.acquisition && isNewerResult(next, candidate.result))) {
        this.completed.set(subscription, { acquisition, result: next });
      }
      this.deliver(subscription, acquisition, next);
    }
  }

  /** @internal Capture the invocation's acquisition, not just the mutable registration. */
  deliveryGuard(subscription: string, listener: Listener, requireLiveBase = true): () => boolean {
    const entry = this.listeners.get(subscription);
    const acquisition = entry?.acquisition, desired = entry?.desired, attempt = this.attempt;
    return () => !!entry && this.listeners.get(subscription) === entry && entry.acquisition === acquisition && entry.desired === desired && attempt === this.attempt && (requireLiveBase ? this.ownsDelivery(subscription, listener) : !this.terminalCause && entry.isActive() && entry.listener === listener);
  }
  private ownsDelivery(subscription: string, listener: Listener): boolean {
    const entry = this.listeners.get(subscription);
    return !this.terminalCause && entry?.listener === listener && entry.isActive() &&
      this.acquisitions.get(subscription) === entry.acquisition;
  }
  private deliver(subscription: string, acquisition: number, next: ProductResult): void {
    const entry = this.listeners.get(subscription);
    if (!entry || entry.acquisition !== acquisition || !this.ownsDelivery(subscription, entry.listener)) return;
    if (this.options.mode !== "local" && (next.start_rank !== entry.desired.offset || next.rows.length > entry.desired.limit)) return;
    const prior = this.freshness.get(subscription);
    if (prior && !isNewerResult(next, prior)) return;
    const stillOwned = this.deliveryGuard(subscription, entry.listener);
    this.freshness.set(subscription, next);
    entry.display = next;
    this.status(subscription, "ready");
    if (!this.ownsDelivery(subscription, entry.listener) || this.listeners.get(subscription) !== entry || entry.acquisition !== acquisition) return;
    if (!stillOwned()) return;
    const deliverySpan=this.trace("hook_delivery",next.traceContext);
    try { entry.listener(deliverySpan?.context?{...next,traceContext:deliverySpan.context}:next); }
    catch (error) {
      if (stillOwned()) this.notifyError(subscription, entry.listener, normalizeError(error), stillOwned);
      else this.report(subscription, normalizeError(error));
    } finally {try{deliverySpan?.end();}catch{}}
  }

  private report(subscription: string, error: Error): void {
    this.consumerErrors.push({ subscription, error });
    if (this.reporting) return;
    this.reporting = true;
    try { this.onConsumerError?.(error, subscription); }
    catch (reportError) { this.consumerErrors.push({ subscription, error: normalizeError(reportError) }); }
    finally { this.reporting = false; }
  }
  private notifyError(subscription: string, listener: Listener, error: Error, stillOwned: () => boolean = () => true): void {
    this.report(subscription, error);
    if (!stillOwned()) return;
    try { listener.onError?.(error); }
    catch (callbackError) { this.report(subscription, normalizeError(callbackError)); }
  }
  private terminate(error: Error, state: "failed" | "disposed"): void {
    if (this.terminalCause) {
      if (state === "disposed" && this.lifecycle !== "disposed") {
        this.lifecycle = state;
        this.setHealth({...this.healthValue,status:"closed"});
      }
      return;
    }
    this.terminalCause = error;
    for(const client of this.completeClients){client.error(error.message);client.dispose();}this.completeClients.clear();
    clearTimeout(this.healthTimer);
    ++this.attempt;
    clearTimeout(this.retryTimer); clearTimeout(this.budgetTimer); clearTimeout(this.healthyTimer); clearTimeout(this.connectTimer);
    this.phase(state);
    this.lifecycle = state;
    const listeners = [...this.listeners.entries()];
    this.listeners.clear(); this.acquisitions.clear(); this.freshness.clear(); this.completed.clear();
    const pending = [...this.pending.values(), ...this.dispatchQueue]; this.pending.clear(); this.dispatchQueue.length = 0;
    this.readyReject(error);
    for (const request of pending) request.reject(error);
    this.worker.terminate();
    // Cleanup precedes notifications; nested disposal must dominate this transition too.
    this.setConnection("disconnected");
    this.setHealth({...this.healthValue,status:this.lifecycle==="disposed"?"closed":"error"});
    this.healthListeners.clear();
    // Keep an already-started terminal query notification batch coherent.
    const notificationState = this.lifecycle;
    // All delivery has been invalidated before any reentrant user callback.
    for (const [subscription, entry] of listeners) {
      if (!entry.isActive()) continue;
      try { entry.listener.onStatus?.(notificationState === "disposed" ? "closed" : "error"); } catch (cause) { this.report(subscription, normalizeError(cause)); }
      if (notificationState !== "disposed") this.notifyError(subscription, entry.listener, error, entry.isActive);
    }
    this.connectionListeners.clear();
  }
  private fail(error: Error, code = "terminal"): void { if (this.terminalCause) return; this.terminalCode = code; this.terminate(error, "failed"); }

  async apply(command: unknown, traceparent = newTraceparent()): Promise<Record<string, ProductResult>> {
    const operation=this.trace("query_intent");
    try{const value=await this.applyIntent(command,traceparent,operation?.context);try{operation?.end("ok");}catch{}return value;}
    catch(e){try{operation?.end(e instanceof SupersededReadError?"superseded":"error");}catch{}throw e;}
  }
  private async applyIntent(command:unknown,traceparent:string,traceContext?:string):Promise<Record<string,ProductResult>>{
    if (this.options.mode === "local") return this.submit(command, traceparent);
    const snapshot = structuredClone(command) as { command?: string; subscription?: string; query?: RuntimeQuery; offset?: number; limit?: number };
    const entry = snapshot.subscription ? this.listeners.get(snapshot.subscription) : undefined;
    const read = entry && (snapshot.command === "change_window" || snapshot.command === "change_query");
    if (read) {
      const desired = snapshot.command === "change_query" ? snapshot.query! : { ...entry.desired, offset: snapshot.offset!, limit: snapshot.limit! };
      validateDesired(desired, this.options.catalog);
      const revision = ++entry.readRevision, attempt = this.attempt;
      const ownsRead = () => !this.terminalCause && this.attempt === attempt &&
        this.listeners.get(snapshot.subscription!) === entry && entry.isActive() && entry.readRevision === revision;
      // A nested read must not roll back to the interrupted, never-dispatched
      // intent. Keep only its surviving predecessor, not a command history.
      const previous = entry.undispatchedRead?.desired ?? entry.desired;
      const previousDisplay = entry.undispatchedRead ? entry.undispatchedRead.display : entry.display;
      const previousOwner = entry.undispatchedRead?.owner ?? entry.desiredOwner;
      const candidate = structuredClone(desired);
      const changed = JSON.stringify(candidate) !== JSON.stringify(entry.desired);
      entry.desired = changed ? candidate : entry.desired;
      entry.desiredOwner = revision;
      entry.undispatchedRead = { desired: previous, display: previousDisplay, owner: previousOwner };
      if (changed) {
        entry.display = undefined;
        this.status(snapshot.subscription!, "loading");
        // External status/error callbacks may synchronously install newer intent.
        // A validated newer invocation owns the registration even when equivalent.
        if (!ownsRead()) throw this.terminalCause ?? (this.attempt !== attempt
          ? new TransientConnectionError("attempt ended during read notification")
          : new SupersededReadError("read superseded before dispatch"));
      }
      if (this.lifecycle !== "ready") {
        if (changed) { entry.display = undefined; this.status(snapshot.subscription!, "loading"); }
        return Promise.reject(new TransientConnectionError("read intent retained for recovery; original operation unavailable"));
      }
      entry.undispatchedRead = undefined;
      // A window inherits the whole desired query, including intent installed by
      // an interrupted callback. A partial command is safe only against an ACKed
      // domain in this attempt; allocating a queued replacement invalidates that
      // proof immediately. Unknown prerequisites become one full replacement.
      const { offset: _offset, limit: _limit, ...domain } = entry.desired;
      const { offset: _confirmedOffset, limit: _confirmedLimit, ...confirmedDomain } = entry.confirmedDesired ?? {};
      const partialEstablished = entry.confirmedAttempt === attempt &&
        entry.confirmedAcquisition === this.acquisitions.get(snapshot.subscription!) &&
        JSON.stringify(domain) === JSON.stringify(confirmedDomain);
      const dispatch = snapshot.command === "change_window" && !partialEstablished
        ? { command: "change_query", subscription: snapshot.subscription, query: structuredClone(entry.desired) }
        : snapshot;
      return this.submit(dispatch, traceparent, undefined, traceContext).catch(error => {
        if (!(error instanceof TransientConnectionError) && !this.terminalCause && this.attempt === attempt &&
          this.listeners.get(snapshot.subscription!) === entry && entry.isActive() && entry.desiredOwner === revision) {
          // An earlier queued/sent replacement may itself have been rejected.
          // Roll back to the actual admitted predecessor, not its optimistic intent.
          const admitted = entry.confirmedAttempt === attempt && entry.confirmedAcquisition === entry.acquisition
            ? entry.confirmedDesired : undefined;
          entry.desired = admitted ?? previous;
          entry.desiredOwner = admitted ? 0 : previousOwner;
          const rollbackRevision = entry.readRevision;
          const predecessor = this.completed.get(snapshot.subscription!);
          entry.display = admitted && predecessor?.acquisition === entry.acquisition ? predecessor.result
            : JSON.stringify(entry.desired) === JSON.stringify(previous) ? previousDisplay : undefined;
          this.status(snapshot.subscription!, entry.display ? "ready" : "error");
          const confirmed = this.completed.get(snapshot.subscription!);
          if (!this.terminalCause && this.attempt === attempt && this.listeners.get(snapshot.subscription!) === entry && entry.isActive() && entry.readRevision === rollbackRevision && confirmed) this.deliver(snapshot.subscription!, confirmed.acquisition, confirmed.result);
        }
        throw error;
      });
    }
    if (this.lifecycle !== "ready") return Promise.reject(this.terminalCause ?? new TransientConnectionError("remote operation unavailable; not replayed"));
    return this.submit(snapshot, traceparent, undefined, traceContext);
  }
  private async submit(command: unknown, traceparent: string, ownedAcquisition?: ProductAcquisitionIdentity, traceContext?:string): Promise<Record<string, ProductResult>> {
    // Registration release owns a reserved control slot. Ordinary admission can
    // fail without preventing cleanup or terminating unrelated healthy listeners.
    const cleanup = ownedAcquisition !== undefined && typeof command === "object" && command !== null &&
      (command as { command?: string }).command === "close";
    const capacity = this.commandLimit - (!cleanup && Number.isFinite(this.subscriptionLimit) ? this.subscriptionLimit : 0);
    if (this.submitted >= capacity) throw new Error("commands in flight budget exceeded");
    this.submitted += 1;
    const operation=this.trace("query_acquisition",traceContext);
    try { const value=await this.submitReserved(command, traceparent, ownedAcquisition,operation?.context??traceContext);try{operation?.end("ok");}catch{}return value; }
    catch(e){try{operation?.end("error");}catch{}throw e;}
    finally { this.submitted -= 1; }
  }
  private async submitReserved(command: unknown, traceparent: string, ownedAcquisition?: ProductAcquisitionIdentity, traceContext?:string): Promise<Record<string, ProductResult>> {
    if (this.terminalCause) throw this.terminalCause;
    const attempt = this.attempt;
    // This executes before the first await: clone errors allocate no request record.
    const snapshot = structuredClone(command);
    const cmd = snapshot as { command?: string; subscription?: string };
    const subscription = cmd?.subscription;
    const registration = typeof subscription === "string" ? this.listeners.get(subscription) : undefined;
    const replacing = cmd?.command === "open" || cmd?.command === "change_query";
    const previous = typeof subscription === "string" ? this.acquisitions.get(subscription) : undefined;
    const acquisition = ownedAcquisition ?? (replacing ? this.nextAcquisition++ : previous);
    if (replacing && typeof subscription === "string") {
      this.acquisitions.set(subscription, acquisition!);
      const entry = this.listeners.get(subscription);
      if (entry && ownedAcquisition === undefined) entry.acquisition = acquisition!;
    }
    const rollback = (error: Error) => {
      // Resolve ownership at the response/send-failure boundary, before another
      // envelope or callback can observe it. Promise catch timing is not a transaction.
      if (!this.terminalCause && attempt === this.attempt && replacing && typeof subscription === "string" && this.acquisitions.get(subscription) === acquisition) {
        const restored = error instanceof CommandRejection ? error.currentAcquisition : previous;
        if (restored !== undefined) this.acquisitions.set(subscription, restored);
        else this.acquisitions.delete(subscription);
        const entry = this.listeners.get(subscription);
        if (entry && ownedAcquisition === undefined && entry.acquisition === acquisition && restored !== undefined) entry.acquisition = restored;
        const candidate = this.completed.get(subscription);
        // A rejected read restores transport ownership before its promise catch
        // restores desired intent. Do not publish that predecessor under the
        // speculative query; the owning catch delivers it after rollback.
        const coherentIntent = this.options.mode === "local" || !entry ||
          JSON.stringify(entry.desired) === JSON.stringify(entry.confirmedDesired);
        if (candidate && candidate.acquisition === restored && coherentIntent) this.deliver(subscription, restored, candidate.result);
        if (restored === undefined) this.completed.delete(subscription);
      }
    };
    try { await this.ready; }
    catch (error) { const cause = normalizeError(error); rollback(cause); throw cause; }
    if (this.terminalCause) throw this.terminalCause;
    if (attempt !== this.attempt) throw new TransientConnectionError("attempt ended before send; completion uncertain");
    if (ownedAcquisition !== undefined && replacing && typeof subscription === "string") {
      const entry = this.listeners.get(subscription);
      if (!entry || entry.acquisition !== acquisition || !entry.isActive()) return {};
      (snapshot as { query: RuntimeQuery }).query = structuredClone(entry.desired);
    }
    const id = this.nextRequestId++;
    return new Promise<Record<string, ProductResult>>((resolve, reject) => {
      const rejectOwned = (error: Error) => { rollback(error); reject(error); };
      const resolveOwned = (results: Record<string, ProductResult>) => {
        // Direct close is transactional. Until its ACK, the still-live acquisition
        // remains deliverable. Release cancels immediately through its own path.
        if (cmd?.command === "close" && typeof subscription === "string" && this.acquisitions.get(subscription) === acquisition) {
          this.acquisitions.delete(subscription); this.freshness.delete(subscription); this.completed.delete(subscription);
        }
        const entry = typeof subscription === "string" ? this.listeners.get(subscription) : undefined;
        if (entry && entry === registration && attempt === this.attempt && id > (entry.confirmedRequestId ?? 0) && (replacing || cmd?.command === "change_window")) {
          const read = snapshot as { query?: RuntimeQuery; offset?: number; limit?: number };
          entry.confirmedDesired = replacing ? structuredClone(read.query!) : { ...entry.confirmedDesired ?? entry.desired, offset: read.offset!, limit: read.limit! };
          entry.confirmedAttempt = attempt; entry.confirmedAcquisition = acquisition; entry.confirmedRequestId = id;
        }
        resolve(results);
      };
      this.dispatchQueue.push({ reject: rejectOwned, send: () => {
        this.pending.set(id, { resolve: resolveOwned, reject: rejectOwned, traceparent });
        try { this.worker.postMessage({ type: "apply", id, command: snapshot, acquisition, previousAcquisition: previous, traceparent, traceContext }); }
        catch (error) { this.pending.delete(id); rejectOwned(normalizeError(error)); }
      }});
      this.drain();
    });
  }

  async open(subscription: string, query: RuntimeQuery): Promise<ProductResult> {
    const results = await this.apply({ command: "open", subscription, query });
    if (!Object.hasOwn(results, subscription)) throw new Error(`missing snapshot for ${subscription}`);
    return results[subscription];
  }

  watch(subscription: string, query: RuntimeQuery, listener: Listener): () => void {
    if (!this.listeners.has(subscription) && this.listeners.size >= this.subscriptionLimit) throw new Error("subscription budget exceeded");
    if (this.terminalCause) throw this.terminalCause;
    if (this.submitted >= this.commandLimit - (Number.isFinite(this.subscriptionLimit) ? this.subscriptionLimit : 0)) throw new Error("watch command budget exceeded");
    // Clone failure must not release an existing valid registration.
    const querySnapshot = structuredClone(query);
    if (this.options.mode !== "local") validateDesired(querySnapshot, this.options.catalog);
    else if ("topic" in querySnapshot) throw new Error("generic local-WASM schemas are unsupported");
    // Each registration owns an acquisition; replacement releases only its predecessor.
    this.listeners.get(subscription)?.release();
    const acquisition = this.nextAcquisition++;
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      if (this.listeners.get(subscription) !== registration) return;
      const owned = registration.acquisition;
      this.listeners.delete(subscription);
      if (this.acquisitions.get(subscription) === owned) {
        this.acquisitions.delete(subscription); this.freshness.delete(subscription);
      }
      this.completed.delete(subscription);
      // Cancellation only stops delivery. An already applied mutation is not rolled back.
      try { listener.onStatus?.("closed"); } catch (error) { this.report(subscription, normalizeError(error)); }
      if (this.options.mode === "remote" && this.lifecycle !== "ready") return;
      const closeCancelled = async () => {
        try { await this.submit({ command: "close", subscription }, newTraceparent(), owned); }
        catch (error) {
          // A cancelled speculative replacement may never have reached native state.
          // Retry once against the explicitly confirmed predecessor, only while no
          // local successor owns this subscription. Worker identity checks still apply.
          if (!this.terminalCause && error instanceof CommandRejection && error.currentAcquisition !== undefined &&
            error.currentAcquisition < owned && !this.acquisitions.has(subscription)) {
            await this.submit({ command: "close", subscription }, newTraceparent(), error.currentAcquisition);
          } else throw error;
        }
      };
      void closeCancelled().catch((error: unknown) => {
        if (this.terminalCause || error instanceof TransientConnectionError) return;
        // A confirmed missing or newer native acquisition cannot leak the released one.
        if (error instanceof CommandRejection && (error.currentAcquisition === undefined || error.currentAcquisition > owned)) return;
        const cause = new Error(`release cleanup failed; provider terminated: ${normalizeError(error).message}`);
        this.fail(cause); this.report(subscription, cause);
      });
    };
    const registration = { acquisition, listener, release, isActive: () => active, desired: querySnapshot, readRevision: 0, desiredOwner: 0, status: "loading" as LiveQueryStatus, display: undefined as ProductResult | undefined };
    this.listeners.set(subscription, registration);
    if (this.lifecycle !== "retry-wait" && (this.attempt === 1 || this.lifecycle === "ready")) this.acquire(subscription);
    return release;
  }

  dispose(): void { for(const client of this.completeClients)client.dispose();this.completeClients.clear(); this.terminalCode ??= "disposed"; this.terminate(this.terminalCause ?? new Error(Number.isFinite(this.subscriptionLimit) ? "provider is disposed; pending completion uncertain" : "provider is disposed"), "disposed"); }
  close(): void { this.dispose(); }
}
function normalizeError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

function newTraceparent(): string {
  const randomHex = (length: number) => Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function isNewerResult(next: ProductResult, prior: ProductResult): boolean {
  return !(next.query_generation < prior.query_generation || next.version < prior.version ||
    (next.query_generation === prior.query_generation && next.sequence < prior.sequence) ||
    (next.query_generation === prior.query_generation && next.version === prior.version && next.sequence === prior.sequence));
}

const ProductContext = createContext<BrowserProductProvider | null>(null);

export function ProductProvider({
  provider,
  children,
}: PropsWithChildren<{ provider: BrowserProductProvider }>) {
  return <ProductContext.Provider value={provider}>{children}</ProductContext.Provider>;
}

export function useProductLiveQuery(subscription: string, query: ProductQuery) {
  return useProductQuery(subscription, query);
}

function useProductQuery(subscription: string, query: RuntimeQuery) {
  const provider = useContext(ProductContext);
  const queryKey = JSON.stringify(query);
  const stableQuery = useMemo(() => JSON.parse(queryKey) as RuntimeQuery, [queryKey]);
  // Render-local identity has no external effects. Abandoned renders cannot cancel work.
  const identity = useMemo(() => ({ provider, subscription, stableQuery }), [provider, subscription, stableQuery]);
  const [state, setState] = useState<{ identity: typeof identity; data?: ProductResult; error?: Error; status: LiveQueryStatus }>();
  useEffect(() => {
    if (!provider) throw new Error("ProductProvider is missing");
    let active = true;
    setState({ identity, status: "loading" });
    const listener: Listener = (data) => { if (active) setState({ identity, data, status: "ready" }); };
    listener.onStatus = (status) => { if (active) setState(previous => ({ identity, data: previous?.identity === identity ? previous.data : undefined, status })); };
    listener.onError = (error) => { if (active) setState(previous => ({ identity, data: previous?.identity === identity ? previous.data : undefined, error, status: "error" })); };
    let stop = () => {};
    try { stop = provider.watch(subscription, stableQuery, listener); }
    catch (error) { listener.onError(normalizeError(error)); }
    return () => { active = false; stop(); };
  }, [identity]);
  const current = state?.identity === identity ? state : undefined;
  return { data: current?.data, error: current?.error, status: current?.status ?? "loading", isLoading: (current?.status ?? "loading") === "loading" };
}

/** The product adapter mirrors the frozen React package's topic/query hook contract. */
export type ProductField = "id" | "category" | "label" | "quantity" | "amount";
export type ProductViewRow = ProductPayload;
export type ProductRawQuery = {
  readonly select: readonly [ProductField, ...ProductField[]];
  readonly where: readonly ({ readonly field: "category"; readonly type: "equals"; readonly filter: string })[];
  readonly orderBy: readonly [] | readonly [{ readonly field: "amount"; readonly direction: "asc" | "desc" }];
};
export type {RowsWithRowId} from "./topic-schema";
type SelectedRow<Query extends ProductRawQuery> = RowsWithRowId<Pick<ProductViewRow, Query["select"][number]>>;
export type ProductLiveQueryResult<Row> = {
  readonly observationTraceContext?:string;
  readonly rows: ReadonlyArray<Row>;
  readonly totalRows: number;
  readonly version: number;
  readonly status: LiveQueryStatus;
  readonly message?: string;
};

export function toProductQuery(query: ProductRawQuery, offset = 0, limit = 0xffff_ffff): ProductQuery {
  if (!query || !Array.isArray(query.select) || query.select.length === 0 || query.select.some((field) => !["id", "category", "label", "quantity", "amount"].includes(field))) {
    throw new Error("ProductCore requires a non-empty selection of supported product fields");
  }
  if (!Array.isArray(query.where) || query.where.some((condition) => condition.field !== "category" || condition.type !== "equals" || typeof condition.filter !== "string")) {
    throw new Error("ProductCore currently supports category equality filters only");
  }
  if (!Array.isArray(query.orderBy) || query.orderBy.length > 1 || query.orderBy.some((order) => order.field !== "amount" || !["asc", "desc"].includes(order.direction))) {
    throw new Error("ProductCore accepts at most one exact amount sort");
  }
  const conditions = query.where.map((condition) => ({ op: "condition", args: { field: "category_equals", condition: condition.filter } }));
  const predicate = conditions.length === 0 ? { op: "true" } : conditions.length === 1 ? conditions[0] : { op: "and", args: conditions };
  const firstOrder = query.orderBy[0];
  return {
    projection: query.select,
    where_expr: predicate,
    direction: firstOrder?.direction === "desc" ? "descending" : "ascending",
    offset,
    limit,
  };
}

function project<Row extends ProductField>(row: Partial<ProductViewRow>, fields: readonly Row[]): Pick<ProductViewRow, Row> {
  const selected: Partial<ProductViewRow> = {};
  for (const field of fields) {
    if (!Object.hasOwn(row, field)) throw new Error("Missing selected product field: " + field);
    selected[field] = row[field] as never;
  }
  return selected as Pick<ProductViewRow, Row>;
}

export function useLiveQuery<const Query extends ProductRawQuery>(
  topic: "products",
  query: Query,
): ProductLiveQueryResult<SelectedRow<Query>> {
  return useAdaptedQuery(topic,query,productAdapter);
}

export type ProductViewportWindow = { readonly firstRow: number; readonly lastRow: number };
export type ProductViewportSink<Row> = {
  setRowCount(count: number, keepRenderedRows?: boolean): void;
  setRowData(rowsByAbsoluteIndex: Readonly<Record<number, Row>>, rowKeysByIndex: Readonly<Record<number, string>>): void;
};
export type ProductViewportGeneration = {
  setWindow(window: ProductViewportWindow): void;
  release(): void;
};

type RawAdapter<Q> = { convert(query:Q,offset?:number,limit?:number):RuntimeQuery; project(row:Partial<ProductViewRow>,fields:readonly string[]):any; legacyId?:boolean; encodedId?:boolean; fields:readonly string[]; identity:string };
const productAdapter:RawAdapter<ProductRawQuery>={convert:toProductQuery,legacyId:true,project:(row,fields)=>project(row,fields as ProductField[]),fields:['id','category','label','quantity','amount'],identity:'products-v14'};
export function useLiveQueryViewport(topic: "products") {
  return useViewport(topic,productAdapter) as Omit<ReturnType<typeof useViewport<ProductRawQuery>>,'viewport'|'useWholeResult'|'completeRawSelect'> & {
    completeRawSelect:readonly ProductField[];
    viewport:{release():void;semanticKey(query:ProductRawQuery):string;replace<const Q extends ProductRawQuery>(input:{window:ProductViewportWindow;query:Q;sink:ProductViewportSink<SelectedRow<Q>>}):ProductViewportGeneration};
    useWholeResult<const Q extends ProductRawQuery>(query:Q):ProductLiveQueryResult<SelectedRow<Q>>;
  };
}
type ViewportChrome={totalRows:number;version:number;status:LiveQueryStatus;message?:string};
function createViewport<Q extends {readonly select?:readonly string[];readonly groupBy?:readonly string[];readonly aggregates?:Readonly<Record<string,unknown>>}>(provider:BrowserProductProvider|null,topic:string,hookId:string,adapter:RawAdapter<Q>,setChrome:(value:ViewportChrome)=>void){
 type Chrome=ViewportChrome;
 const loading:Chrome={totalRows:0,version:0,status:"loading"};

    let generation = 0;
    let activeStop: (() => void) | undefined;
    return {
      release() { generation += 1; activeStop?.(); activeStop = undefined; setChrome({ totalRows: 0, version: 0, status: "closed" }); },
      semanticKey(query: Q) { return JSON.stringify([topic,adapter.identity,query]); },
      replace<const Query extends Q>(input: {
        readonly window: ProductViewportWindow;
        readonly query: Query;
        readonly sink: ProductViewportSink<any>;
      }): ProductViewportGeneration {
        if (!provider) throw new Error("ProductProvider is missing");
        const querySnapshot = structuredClone(input.query);
        const projectResult=createPublicProjector(adapter);
        validateViewportWindow(input.window);
        const query = adapter.convert(querySnapshot, input.window.firstRow, input.window.lastRow - input.window.firstRow + 1);
        const current = ++generation;
        setChrome({ totalRows: 0, version: 0, status: "loading" });
        const previousStop = activeStop;
        activeStop = undefined;
        previousStop?.();
        const subscription = `viewport:${topic}:${hookId}:${current}`;
        const sendWindow = (window: ProductViewportWindow) => {
          if (!Number.isSafeInteger(window.firstRow) || !Number.isSafeInteger(window.lastRow) || window.firstRow < 0 || window.lastRow < window.firstRow) {
            throw new Error("invalid viewport window");
          }
          const ownsInvocation = provider.deliveryGuard(subscription, listener);
          void provider.apply({ command: "change_window", subscription, offset: window.firstRow, limit: window.lastRow - window.firstRow + 1 }).catch((error: unknown) => {
            if (!(error instanceof TransientConnectionError) && generation === current && !released && ownsInvocation()) setChrome({ totalRows: 0, version: 0, status: "error", message: error instanceof Error ? error.message : String(error) });
          });
        };
        const listener: Listener = (result) => {
          const ownsInvocation = provider.deliveryGuard(subscription, listener);
          const valid = () => generation === current && !released && ownsInvocation();
          if (!valid()) return;
          const rows: Record<number, any> = {};
          const keys: Record<number, string> = {};
          projectResult(result,queryFields(querySnapshot)).forEach((row,index)=>{
            const absoluteIndex=result.start_rank+index;
            rows[absoluteIndex]=row;keys[absoluteIndex]=row.rowId;
          });
          if (result.subscription !== subscription ||
            (result.start_rank > result.total_rows && result.rows.length !== 0) ||
            (result.start_rank <= result.total_rows && result.rows.length > result.total_rows - result.start_rank)) return;
          input.sink.setRowCount(result.total_rows);
          if (!valid()) return;
          input.sink.setRowData(rows, keys);
          if (!valid()) return;
          lastChrome = { totalRows: result.total_rows, version: result.version, status: "ready" };
          setChrome(lastChrome);
        };
        let requestedWindow = input.window;
        let lastChrome: Chrome = loading;
        listener.onStatus = (status) => { if (generation === current && !released) setChrome(status === "loading" ? { totalRows: 0, version: 0, status } : { ...lastChrome, status }); };
        listener.onError = (error) => { if (generation === current && !released && !(error instanceof TransientConnectionError)) setChrome({ ...lastChrome, status: "error", message: error.message }); };
        let released = false;
        let stop = () => {};
        try { stop = provider.watch(subscription, query, listener); }
        catch (error) { listener.onError(normalizeError(error)); }
        activeStop = stop;
        return {
          setWindow(window) {
            if (released || generation !== current) return;
            validateViewportWindow(window);
            const ownsInvocation = provider.deliveryGuard(subscription, listener, false);
            const changed = requestedWindow.firstRow !== window.firstRow || requestedWindow.lastRow !== window.lastRow;
            requestedWindow = window;
            if (changed && provider.connectionStatus !== "connected") input.sink.setRowData({}, {});
            if (released || generation !== current || !ownsInvocation()) return;
            sendWindow(window);
          },
          release() {
            if (released) return;
            released = true;
            if (generation === current) {
              setChrome({ ...lastChrome, status: "closed" });
              generation += 1;
              if (activeStop === stop) activeStop = undefined;
            }
            stop();
          },
        };
      },
    };

}
function createAdaptedWholeHook<Q extends {readonly select?:readonly string[];readonly groupBy?:readonly string[];readonly aggregates?:Readonly<Record<string,unknown>>}>(topic:string,adapter:RawAdapter<Q>){return function useWholeResult<const Query extends Q>(query:Query){return useAdaptedQuery(topic,query,adapter);};}
function useViewport<Q extends {readonly select?:readonly string[];readonly groupBy?:readonly string[];readonly aggregates?:Readonly<Record<string,unknown>>}>(topic:string, adapter:RawAdapter<Q>) {
  const provider = useContext(ProductContext);
  const hookId = useId();
  type Chrome = { totalRows: number; version: number; status: LiveQueryStatus; message?: string };
  const owner = useMemo(() => ({ provider, topic }), [provider, topic]);
  const loading: Chrome = { totalRows: 0, version: 0, status: "loading" };
  const [chromeState, setChromeState] = useState<{ owner: typeof owner; value: Chrome }>({ owner, value: loading });
  const setChrome = useMemo(() => (value: Chrome) => setChromeState({ owner, value }), [owner]);
  const chrome = chromeState.owner === owner ? chromeState.value : loading;
  const viewport = useMemo(() => createViewport(provider,topic,hookId,adapter,setChrome), [provider, topic, hookId, setChrome, adapter]);
  useEffect(() => () => viewport.release(), [viewport]);
  const completeRawSelect = adapter.fields;
  const useWholeResult = useMemo(()=>createAdaptedWholeHook(topic,adapter),[topic,adapter]);
  return { viewport, completeRawSelect, useWholeResult, ...chrome };
}

function validateViewportWindow(window: ProductViewportWindow): void {
  if (!Number.isSafeInteger(window.firstRow) || !Number.isSafeInteger(window.lastRow) || window.firstRow < 0 || window.lastRow < window.firstRow || window.lastRow >= 0xffff_ffff) throw new Error("invalid viewport window");
}

/** Shared authenticated transport state; creates no transport or query subscription. */
export function useConnectionStatus(): ConnectionStatus {
  const provider = useContext(ProductContext);
  if (!provider) throw new Error("ProductProvider is missing");
  return useSyncExternalStore(provider.subscribeConnectionStatus, provider.getConnectionStatus, provider.getConnectionStatus);
}
function validateDesired(query: RuntimeQuery, catalog?:BrowserCatalog): void {
  if (query && 'topic' in query) {
    const entry=catalog?.[query.topic];
    if(!entry||entry.fingerprint!==query.schema)throw new Error('unknown topic/schema');
    if(!Number.isSafeInteger(query.offset)||query.offset<0||query.offset>0xffff_ffff||!Number.isSafeInteger(query.limit)||query.limit<0||query.limit>0xffff_ffff)throw new Error('invalid desired query/window');
    validateCatalogQuery(query.join?joinSchema(catalog!,query.topic,query.join).schema:entry.schema,{...(query.semantic_profile?{semanticProfile:query.semantic_profile}:{}),...(Object.hasOwn(query,'select')?{select:query.select}:{}),...(Object.hasOwn(query,'group_by')?{groupBy:query.group_by}:{}),...(Object.hasOwn(query,'aggregates')?{aggregates:query.aggregates}:{}),...(Object.hasOwn(query,'global')?{global:query.global}:{}),...(Object.hasOwn(query,'having')?{having:query.having}:{}),...(query.where===undefined?{}:{where:query.where}),orderBy:query.order_by});return;
  }
  if(catalog)throw new Error('catalog connection requires topic/schema query');
  if (!query || !["ascending", "descending"].includes(query.direction) || !Number.isInteger(query.offset) || query.offset < 0 || query.offset > 0xffff_ffff || !Number.isInteger(query.limit) || query.limit < 0 || query.limit > 0xffff_ffff) throw new Error("invalid desired query/window");
  if (query.projection && (!query.projection.length || new Set(query.projection).size !== query.projection.length || query.projection.some(field => !["id", "category", "label", "quantity", "amount"].includes(field)))) throw new Error("invalid desired projection");
}

/** One negotiated diagnostics subscription per provider, independent of query acquisition. */
export function useViewServerHealthSummary(){
  const provider=useContext(ProductContext);if(!provider)throw new Error("ProductProvider is missing");
  const diagnostics=useSyncExternalStore(provider.subscribeHealth,provider.getHealthSnapshot,provider.getHealthSnapshot);
  const connection=useConnectionStatus();
  return useMemo(()=>({connection,status:diagnostics.status,runtime:diagnostics.snapshot?.phase,ready:diagnostics.snapshot?.ready,sampledAt:diagnostics.snapshot?.sampled_at_unix_ms,instance:diagnostics.snapshot?.instance,error:diagnostics.error}),[connection,diagnostics]);
}
export function useSourceHealth({topic}:{topic:string}){
  const provider=useContext(ProductContext);if(!provider)throw new Error("ProductProvider is missing");
  const diagnostics=useSyncExternalStore(provider.subscribeHealth,provider.getHealthSnapshot,provider.getHealthSnapshot);
  return useMemo(()=>({status:diagnostics.status,source:diagnostics.snapshot?.sources.find(s=>s.topic===topic),sampledAt:diagnostics.snapshot?.sampled_at_unix_ms,instance:diagnostics.snapshot?.instance,error:diagnostics.error??(diagnostics.snapshot&&!diagnostics.snapshot.sources.some(s=>s.topic===topic)?"topic_unavailable":undefined)}),[diagnostics,topic]);
}

/** Materialize at delivery/memo boundaries. Cache only the current bounded result. */
function createPublicProjector<Q>(adapter:RawAdapter<Q>){
  let previous=new Map<string,Record<string,unknown>>(),selection='';
  return (result:ProductResult,fields:readonly string[]):Array<Record<string,unknown>&{readonly rowId:string}>=>{
    const selected=JSON.stringify([fields,result.result_kind,result.result_shape,result.query_generation]);if(selection!==selected){previous.clear();selection=selected;}
    if(result.keys&&result.keys.length!==result.rows.length)throw Error('Stable identity length mismatch');
    const next=new Map<string,Record<string,unknown>>();
    const rows=result.rows.map((raw,index)=>{
      const id=result.keys?.[index]??(adapter.legacyId?raw.id:undefined);
      if(typeof id!=='string'||!id.length||new TextEncoder().encode(id).length>512||/[\u0000-\u001f\u007f-\u009f]/.test(id)||new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(id))!==id)throw Error('Missing or invalid stable row identity');
      if(result.result_kind==='join_v1'?!/^jid1:[0-9a-f]{64}$/.test(id):result.result_kind==='global_v1'||result.result_kind==='join_global_v1'?!/^global1:(?:[0-9a-f]{2})+$/.test(id):result.result_kind==='grouped_v1'||result.result_kind==='join_grouped_v1'?!/^gid1:(?:[0-9a-f]{2})+$/.test(id):adapter.encodedId&&!validRowId(id))throw Error('Malformed canonical rowId');
      if(next.has(id)||Object.hasOwn(raw,'rowId'))throw Error('Duplicate identity or payload rowId collision');
      const old=previous.get(id),source=raw as Record<string,unknown>;
      // Generic rows are scalar. Legacy structured exact values compare canonically.
      const equal=old&&[...new Set(fields.map(f=>f.split('.')[0]))].every(f=>Object.hasOwn(old,f)===Object.hasOwn(source,f)&&
        (Object.is(old[f],source[f])||(old[f]!==null&&typeof old[f]==='object'&&JSON.stringify(old[f])===JSON.stringify(source[f]))));
      const row=equal?old:adapter.project(raw,fields);
      if(!equal)Object.defineProperty(row,'rowId',{value:id,enumerable:true,writable:false,configurable:false});
      next.set(id,row);return row as Record<string,unknown>&{readonly rowId:string};
    });
    previous=next;return rows;
  };
}

function useAdaptedQuery<Q extends {readonly select?:readonly string[];readonly groupBy?:readonly string[];readonly aggregates?:Readonly<Record<string,unknown>>}>(topic:string,query:Q,adapter:RawAdapter<Q>):ProductLiveQueryResult<any>{
  const id=useId();const converted=adapter.convert(query);
  const {data,error,status}=useProductQuery(`${topic}:${adapter.identity}:consumer:${id}`,converted);
  const selection=JSON.stringify(queryFields(query));
  const projectResult=useMemo(()=>createPublicProjector(adapter),[adapter]);
  const rows=useMemo(()=>data?projectResult(data,JSON.parse(selection)):[],[data,selection,projectResult]);
  const incomplete=data!==undefined&&data.total_rows!==data.rows.length;
  return {rows,totalRows:data?.total_rows??0,version:data?.version??0,status:error||incomplete?'error':status,message:error?.message??(incomplete?'result limit did not contain the full result':undefined),...(data?.traceContext?{observationTraceContext:data.traceContext}:{})};
}
/** Public hook contracts stay named in emitted declarations to bound type expansion. */
export interface CatalogViewport<S extends Schema> extends ViewportChrome {
  completeRawSelect:readonly FieldName<S>[];
  viewport:{
    release():void;
    semanticKey(query:TopicQuery<S>):string;
    replace<const Q extends TopicQuery<S>>(input:{window:ProductViewportWindow;query:Q&QueryCheck<Q,S>;sink:ProductViewportSink<QueryResult<S,Q>>}):ProductViewportGeneration;
  };
  useWholeResult<const Q extends TopicQuery<S>>(query:Q&QueryCheck<Q,S>):ProductLiveQueryResult<QueryResult<S,Q>>;
}
export interface JoinedCatalogViewport<C extends BrowserCatalog,D extends JoinSpec<C>> extends ViewportChrome {
  completeRawSelect:readonly FieldName<JoinedSchema<C,D>>[];
  viewport:{
    release():void;
    semanticKey(query:TopicQuery<JoinedSchema<C,D>>):string;
    replace<const Q extends TopicQuery<JoinedSchema<C,D>>>(input:{window:ProductViewportWindow;query:Q&JoinQueryCheck<C,D,Q>;sink:ProductViewportSink<JoinResult<C,D,Q>>}):ProductViewportGeneration;
  };
  useWholeResult<const Q extends TopicQuery<JoinedSchema<C,D>>>(query:Q&JoinQueryCheck<C,D,Q>):ProductLiveQueryResult<JoinResult<C,D,Q>>;
}
export interface TopicHooks<C extends BrowserCatalog> {
  catalog:C;
  useLiveQuery<const T extends keyof C&string,const Q extends TopicQuery<C[T]['schema']>>(topic:T,query:Q&QueryCheck<Q,C[T]['schema']>):ProductLiveQueryResult<QueryResult<C[T]['schema'],Q>>;
  useLiveQuery<const D extends JoinSpec<C>,const Q extends TopicQuery<JoinedSchema<C,D>>>(topic:JoinHandle<C,D>,query:Q&JoinQueryCheck<C,D,Q>):ProductLiveQueryResult<JoinResult<C,D,Q>>;
  useLiveQueryViewport<const T extends keyof C&string>(topic:T):CatalogViewport<C[T]['schema']>;
  useLiveQueryViewport<const D extends JoinSpec<C>>(topic:JoinHandle<C,D>):JoinedCatalogViewport<C,D>;
}

/** Bind public hook inference to the same immutable portable catalog sent to the Worker. */
export function createTopicHooks<const C extends BrowserCatalog>(input:C):TopicHooks<C>{
  const catalog=defineCatalog(input);
  const adapters=new Map<string,RawAdapter<TopicQuery<Schema>>>();
  for(const [topic,entry]of Object.entries(catalog))adapters.set(topic,{
    identity:entry.fingerprint,encodedId:entry.schema.format>=2,fields:entry.schema.fields.map(f=>f.name),
    convert(query,offset=0,limit=0xffff_ffff){validateCatalogQuery(entry.schema,query);return {topic,schema:entry.fingerprint,...(query.semanticProfile?{semantic_profile:query.semanticProfile}:{}),...(query.global?{global:true as const,aggregates:query.aggregates}:'groupBy' in query&&query.groupBy?{group_by:query.groupBy,aggregates:query.aggregates}:{select:query.select}),...(query.where===undefined?{}:{where:query.where}),...(query.having===undefined?{}:{having:query.having}),order_by:query.orderBy,offset,limit};},
    project(row,fields){const selected:Record<string,unknown>={};for(const name of new Set(fields.map(f=>f.split('.')[0])))if(Object.hasOwn(row,name))selected[name]=structuredClone((row as Record<string,unknown>)[name]);return selected;},
  });
  const joinAdapters=new WeakMap<JoinHandle,RawAdapter<TopicQuery<Schema>>>();
  function adapter(target:string|JoinHandle){
    if(typeof target==='string'){const a=adapters.get(target);if(!a)throw new Error('unknown topic');return a;}
    for(const [topic,entry]of Object.entries(target.sourceCatalog))if(catalog[topic]?.fingerprint!==entry.fingerprint)throw Error('join catalog mismatch');
    let a=joinAdapters.get(target);if(!a){a={identity:identityHash(target.signature).slice(0,24),encodedId:true,fields:target.schema.fields.map(f=>f.name),convert(query,offset=0,limit=0xffff_ffff){validateJoinQuery(target,query);return {topic:target.topic,schema:target.fingerprint,join:target.wire,...(query.semanticProfile?{semantic_profile:query.semanticProfile}:{}),...(query.global?{global:true as const,aggregates:query.aggregates}:query.groupBy?{group_by:query.groupBy,aggregates:query.aggregates}:{select:query.select}),...(query.where===undefined?{}:{where:query.where}),...(query.having===undefined?{}:{having:query.having}),order_by:query.orderBy,offset,limit};},project(row,fields){const out:Record<string,unknown>={};for(const root of new Set(fields.map(f=>f.split('.')[0])))if(Object.hasOwn(row,root))out[root]=structuredClone((row as Record<string,unknown>)[root]);return out;}};joinAdapters.set(target,a);}return a;
  }
  function useCatalogQuery<const T extends keyof C&string,const Q extends TopicQuery<C[T]['schema']>>(topic:T,query:Q&QueryCheck<Q,C[T]['schema']>):ProductLiveQueryResult<QueryResult<C[T]['schema'],Q>>;
  function useCatalogQuery<const D extends JoinSpec<C>,const Q extends TopicQuery<JoinedSchema<C,D>>>(topic:JoinHandle<C,D>,query:Q&JoinQueryCheck<C,D,Q>):ProductLiveQueryResult<JoinResult<C,D,Q>>;
  function useCatalogQuery(topic:string|JoinHandle,query:TopicQuery<Schema>){return useAdaptedQuery(typeof topic==='string'?topic:topic.topic,query,adapter(topic));}
  function useCatalogViewport<const T extends keyof C&string>(topic:T ):CatalogViewport<C[T]['schema']>;
  function useCatalogViewport<const D extends JoinSpec<C>>(topic:JoinHandle<C,D> ):JoinedCatalogViewport<C,D>;
  function useCatalogViewport(topic:string|JoinHandle):object{return useViewport(typeof topic==='string'?topic:topic.topic,adapter(topic));}
  return {catalog,useLiveQuery:useCatalogQuery,useLiveQueryViewport:useCatalogViewport};
}
