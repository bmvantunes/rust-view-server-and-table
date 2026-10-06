import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { ROOT, VERSION, selected } from "./rust.ts";
export { ROOT };
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Error("Expected JSON object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw Error("Expected string");
  return value;
}
export function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw Error("Expected safe integer");
  return value;
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("Expected array");
  return value;
}
export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
export function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const row = object(value);
  return (
    "{" +
    Object.keys(row)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(row[key]))
      .join(",") +
    "}"
  );
}
export const isMain = (url: string) =>
  process.argv[1] !== undefined && fileURLToPath(url) === process.argv[1];
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  check?: boolean;
  stdio?: StdioOptions;
  signal?: AbortSignal;
};
export type CommandResult = { code: number; stdout: string; stderr: string };
export function spawnOwned(args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const [executable, ...rest] = args;
  if (!executable) throw Error("Missing executable");
  return spawn(executable, rest, { cwd: ROOT, detached: true, ...options });
}
export function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
export function waitExit(child: ChildProcess, timeoutMs = 30000): Promise<number | null> {
  if (exited(child)) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      dispose();
      reject(Error("Owned process exit deadline exceeded"));
    }, timeoutMs);
    const finish = (code: number | null) => {
      dispose();
      resolve(code);
    };
    const fail = (error: Error) => {
      dispose();
      reject(error);
    };
    const dispose = () => {
      clearTimeout(timeout);
      child.off("exit", finish);
      child.off("error", fail);
    };
    child.once("exit", finish);
    child.once("error", fail);
  });
}
export async function stopOwned(child: ChildProcess, graceMs = 30000) {
  if (exited(child)) return;
  if (!child.pid) return;
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch (error) {
      if (object(error).code !== "ESRCH") throw error;
    }
  };
  kill("SIGTERM");
  try {
    await waitExit(child, graceMs);
  } catch {
    kill("SIGKILL");
    await waitExit(child, 10000);
  }
}
export async function command(
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted) throw Error("Command interrupted before spawn");
  const child = spawnOwned(args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(options.input);
  let aborted = false,
    cleanup: Promise<void> | undefined;
  const abort = () => {
    aborted = true;
    cleanup ??= stopOwned(child);
    void cleanup.catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, options.timeoutMs ?? 180000);
  let failure: unknown;
  try {
    const code = await waitExit(child, (options.timeoutMs ?? 180000) + 45000);
    if (aborted) throw Error(`Command interrupted or timed out: ${args[0]}`);
    const result = { code: code ?? 1, stdout, stderr };
    if (options.check !== false && result.code !== 0)
      throw Error(`Command failed (${result.code}): ${args.join(" ")}\n${stderr}`);
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (failure || aborted) {
      cleanup ??= stopOwned(child);
      try {
        await cleanup;
      } catch (error) {
        throw new AggregateError(
          failure ? [failure, error] : [error],
          "Command and owned cleanup failed",
        );
      }
    }
  }
}

export class JsonLines {
  private queue: unknown[] = [];
  private pending?: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private failure?: Error;
  private lines: ReturnType<typeof createInterface>;
  constructor(child: ChildProcess) {
    if (!child.stdout) throw Error("Child stdout is required");
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (this.pending) {
          const p = this.pending;
          this.pending = undefined;
          clearTimeout(p.timer);
          p.resolve(value);
        } else this.queue.push(value);
      } catch (error) {
        this.fail(Error(message(error)));
      }
    });
    this.lines.on("close", () => this.fail(Error("Producer exited before receipt")));
    child.on("error", (error) => this.fail(error));
  }
  private fail(error: Error) {
    this.failure = error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
  }
  read(timeoutMs = 60000): Promise<unknown> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) throw Error("Concurrent receipt read");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(Error("Producer receipt deadline exceeded"));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }
  close() {
    this.lines.close();
  }
}
export class OwnedLock {
  readonly child: ChildProcess;
  private reader: JsonLines;
  private closing = false;
  private lost = false;
  private constructor(child: ChildProcess, reader: JsonLines) {
    this.child = child;
    this.reader = reader;
    child.once("exit", () => {
      if (!this.closing) this.lost = true;
    });
  }
  static async acquire(path: string) {
    const rustc = selected("rustc");
    const source = join(ROOT, "scripts/lock.rs");
    const hash = createHash("sha256")
      .update(readFileSync(source))
      .update(VERSION)
      .update(rustc)
      .digest("hex");
    const binary = join(ROOT, ".local/tools", `lock-${hash}`);
    mkdirSync(dirname(binary), { recursive: true });
    if (!existsSync(binary)) {
      const temporary = binary + "." + randomUUID();
      await command([rustc, "--edition=2024", "-O", source, "-o", temporary], {
        timeoutMs: 120000,
      });
      renameSync(temporary, binary);
    }
    const child = spawnOwned([binary, path], { stdio: ["pipe", "pipe", "pipe"] });
    let error = "";
    child.stderr?.on("data", (data) => {
      error += String(data);
    });
    const reader = new JsonLines(child);
    try {
      if (object(await reader.read(10000)).locked !== true) throw Error("Lock readiness missing");
      return new OwnedLock(child, reader);
    } catch (cause) {
      try {
        await waitExit(child, 100);
      } catch {
        await stopOwned(child);
      }
      reader.close();
      throw Error(`Cannot acquire owned lock: ${error || message(cause)}`);
    }
  }
  assertHeld() {
    if (this.lost || exited(this.child)) throw Error("Owned lock guardian lost; writes are fenced");
  }
  async close() {
    this.closing = true;
    this.child.stdin?.end();
    try {
      await waitExit(this.child, 5000);
    } catch {
      await stopOwned(this.child, 1000);
    } finally {
      this.reader.close();
    }
  }
}

export async function settledStage<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const value = await action();
  signal.throwIfAborted();
  return value;
}
