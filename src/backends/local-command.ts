import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ProcessSignal,
  RawCommand,
  RawCommandEvent,
} from "../runtime/index.js";
import { PROCESS_SUPERVISOR_PROGRAM } from "./process/supervisor.js";

const SUPERVISOR_START_TIMEOUT_MS = 5_000;
const SUPERVISOR_STOP_TIMEOUT_MS = 2_500;

export interface LocalCommandLaunch {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly input: Buffer | null;
  readonly description: string;
  readonly failureCode: string;
}

interface SupervisorMessage {
  readonly type: string;
  readonly pid?: number;
  readonly stream?: "stdout" | "stderr";
  readonly data?: string;
  readonly code?: string;
  readonly message?: string;
  readonly exitCode?: number;
  readonly finishedAt?: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

class RawEventQueue implements AsyncIterable<RawCommandEvent> {
  readonly #events: RawCommandEvent[] = [];
  readonly #waiters: Deferred<IteratorResult<RawCommandEvent>>[] = [];
  #closed = false;

  push(event: RawCommandEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#events.push(event);
    else waiter.resolve({ done: false, value: event });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<RawCommandEvent> {
    return {
      next: () => {
        const event = this.#events.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        const waiter = Promise.withResolvers<IteratorResult<RawCommandEvent>>();
        this.#waiters.push(waiter);
        return waiter.promise;
      },
    };
  }
}

export class LocalRawCommand implements RawCommand {
  readonly startedAt = Date.now();
  readonly events: AsyncIterable<RawCommandEvent>;
  readonly #child: ChildProcess;
  readonly #queue = new RawEventQueue();
  readonly #target = Promise.withResolvers<number>();
  readonly #supervisorReady = Promise.withResolvers<void>();
  readonly #completion = Promise.withResolvers<void>();
  readonly #stdoutDecoder = new StringDecoder("utf8");
  readonly #stderrDecoder = new StringDecoder("utf8");
  readonly #onDisposed: () => void;
  readonly #description: string;
  readonly #failureCode: string;
  #targetPid: number | null = null;
  #settled = false;
  #disposed: Promise<void> | undefined;

  constructor(launch: LocalCommandLaunch, onDisposed: () => void) {
    this.events = this.#queue;
    this.#onDisposed = onDisposed;
    this.#description = launch.description;
    this.#failureCode = launch.failureCode;
    this.#child = spawn(
      process.execPath,
      ["--input-type=module", "-e", PROCESS_SUPERVISOR_PROGRAM, String(process.pid)],
      {
        env: process.env,
        shell: false,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    this.#child.on("message", (value: unknown) => this.#onMessage(value));
    this.#child.once("error", (error) => {
      this.#supervisorReady.reject(error);
      this.#target.reject(error);
      this.#backendFailure(this.#failureCode, `${this.#description} supervisor failed to start.`, true);
    });
    this.#child.once("exit", () => {
      if (!this.#settled) {
        this.#backendFailure(this.#failureCode, `${this.#description} supervisor exited before command completion.`, true);
      }
      this.#completion.resolve();
    });
    void this.#target.promise.catch(() => undefined);
    this.#supervisorReady.promise.then(() => {
      this.#child.send({
        type: "start",
        command: {
          command: launch.command,
          arguments: [...launch.arguments],
          cwd: launch.cwd,
          environment: launch.environment,
        },
        input: launch.input === null ? null : launch.input.toString("base64"),
      }, (error) => {
        if (error !== null) {
          this.#backendFailure(this.#failureCode, `${this.#description} supervisor could not receive its command.`, true);
        }
      });
    }).catch(() => undefined);
  }

  async waitUntilStarted(signal?: AbortSignal): Promise<void> {
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => timeout.reject(new Error(`${this.#description} supervisor did not become ready.`)), SUPERVISOR_START_TIMEOUT_MS);
    timer.unref();
    const aborted = Promise.withResolvers<never>();
    const abort = (): void => aborted.reject(new DOMException("The operation was cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await Promise.race([this.#supervisorReady.promise, timeout.promise, aborted.promise]);
      await Promise.race([this.#target.promise, this.#completion.promise, timeout.promise, aborted.promise]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async signal(signal: ProcessSignal, abortSignal?: AbortSignal): Promise<void> {
    if (this.#settled) return;
    const aborted = Promise.withResolvers<never>();
    const abort = (): void => aborted.reject(new DOMException("Signal delivery was cancelled.", "AbortError"));
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) abort();
    try {
      const pid = await Promise.race([this.#target.promise, this.#completion.promise.then(() => null), aborted.promise]);
      if (pid === null || this.#settled) return;
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (!isErrno(error, "ESRCH")) throw error;
      }
    } finally {
      abortSignal?.removeEventListener("abort", abort);
    }
  }

  dispose(): Promise<void> {
    this.#disposed ??= this.#dispose();
    return this.#disposed;
  }

  async #dispose(): Promise<void> {
    if (!this.#settled) {
      if (this.#child.connected) this.#child.send({ type: "terminate" });
      if (this.#targetPid !== null) {
        try {
          process.kill(-this.#targetPid, "SIGTERM");
        } catch (error) {
          if (!isErrno(error, "ESRCH")) throw error;
        }
      }
      const stopped = await Promise.race([
        this.#completion.promise.then(() => true),
        delay(SUPERVISOR_STOP_TIMEOUT_MS, false, { ref: false }),
      ]);
      if (!stopped && this.#targetPid !== null) {
        try {
          process.kill(-this.#targetPid, "SIGKILL");
        } catch (error) {
          if (!isErrno(error, "ESRCH")) throw error;
        }
      }
      if (!this.#child.killed) this.#child.kill("SIGKILL");
    }
    this.#queue.close();
    this.#onDisposed();
  }

  #onMessage(value: unknown): void {
    if (!isSupervisorMessage(value)) return;
    if (value.type === "supervisor-ready") {
      this.#supervisorReady.resolve();
      return;
    }
    if (value.type === "ready" && value.pid !== undefined) {
      this.#targetPid = value.pid;
      this.#target.resolve(value.pid);
      return;
    }
    if (value.type === "output" && value.stream !== undefined && value.data !== undefined) {
      const decoder = value.stream === "stdout" ? this.#stdoutDecoder : this.#stderrDecoder;
      const data = decoder.write(Buffer.from(value.data, "base64"));
      if (data.length > 0) this.#queue.push({ type: value.stream, data });
      return;
    }
    if (value.type === "spawn-error") {
      const code = value.code ?? "UNKNOWN";
      this.#queue.push({ type: "stderr", data: `Failed to spawn ${this.#description} (${code}).\n` });
      return;
    }
    if (value.type === "complete" && value.exitCode !== undefined && value.finishedAt !== undefined) {
      const stdout = this.#stdoutDecoder.end();
      const stderr = this.#stderrDecoder.end();
      if (stdout.length > 0) this.#queue.push({ type: "stdout", data: stdout });
      if (stderr.length > 0) this.#queue.push({ type: "stderr", data: stderr });
      this.#settled = true;
      this.#queue.push({ type: "complete", exitCode: value.exitCode, finishedAt: value.finishedAt });
      this.#queue.close();
      this.#completion.resolve();
      this.#onDisposed();
    }
  }

  #backendFailure(code: string, message: string, retryable: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#queue.push({ type: "backend-failure", code, message, retryable });
    this.#queue.close();
    this.#completion.resolve();
    this.#onDisposed();
  }
}

function isSupervisorMessage(value: unknown): value is SupervisorMessage {
  if (value === null || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return false;
  const message = value as Record<string, unknown>;
  return (message.pid === undefined || Number.isSafeInteger(message.pid)) &&
    (message.stream === undefined || message.stream === "stdout" || message.stream === "stderr") &&
    (message.data === undefined || typeof message.data === "string") &&
    (message.code === undefined || typeof message.code === "string") &&
    (message.message === undefined || typeof message.message === "string") &&
    (message.exitCode === undefined || Number.isFinite(message.exitCode)) &&
    (message.finishedAt === undefined || Number.isFinite(message.finishedAt));
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
