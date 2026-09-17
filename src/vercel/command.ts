import { setTimeout as delay } from "node:timers/promises";
import type { Writable } from "node:stream";
import type {
  CommandOutputChunk,
  ProcessRecord,
  ReadCommandOutputResult,
  SandboxClient,
} from "../runtime/index.js";
import {
  abortError,
  mutationMetadata,
  requestMetadata,
  throwIfAborted,
  unwrap,
} from "./client.js";

export type CommandOutput = "stdout" | "stderr" | "both";

export interface CommandChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface CommandOptions {
  signal?: AbortSignal;
}

export interface CommandRunOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
}

export type CommandLogIterator = AsyncGenerator<CommandChunk, void, void> & Disposable & {
  close(): void;
};

export type Signal =
  | "SIGHUP"
  | "SIGINT"
  | "SIGQUIT"
  | "SIGKILL"
  | "SIGTERM"
  | "SIGCONT"
  | "SIGSTOP"
  | number;

const PORTABLE_SIGNALS: Record<Exclude<Signal, number>, true> = {
  SIGHUP: true,
  SIGINT: true,
  SIGQUIT: true,
  SIGKILL: true,
  SIGTERM: true,
  SIGCONT: true,
  SIGSTOP: true,
};

interface CommandState {
  readonly client: SandboxClient;
  readonly sandboxId: string;
  readonly processId: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly chunks: CommandChunk[];
  readonly followers: Set<() => void>;
  readonly instances: Set<Command>;
  readonly completion: Promise<CommandFinished>;
  readonly resolveCompletion: (result: CommandFinished) => void;
  readonly rejectCompletion: (error: unknown) => void;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  exitCode: number | null;
  durationMs: number | undefined;
  settled: boolean;
  finished: CommandFinished | undefined;
}

function collectOutput(state: CommandState, stream: CommandOutput): string {
  if (stream === "both") return state.chunks.map((chunk) => chunk.data).join("");
  return state.chunks
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.data)
    .join("");
}

function publish(state: CommandState, chunk: CommandOutputChunk): void {
  if (chunk.data.length === 0) return;
  const frontendChunk = { stream: chunk.stream, data: chunk.data };
  state.chunks.push(frontendChunk);
  if (chunk.stream === "stdout") state.stdout?.write(chunk.data);
  else state.stderr?.write(chunk.data);
  for (const wake of state.followers) wake();
  state.followers.clear();
}

async function pumpCommand(state: CommandState): Promise<void> {
  let cursor: string | null = null;
  try {
    for (;;) {
      const page: ReadCommandOutputResult = unwrap(await state.client.readCommandOutput({
        ...requestMetadata(),
        sandboxId: state.sandboxId,
        processId: state.processId,
        stream: "both",
        cursor,
        limitBytes: 64 * 1024,
      }));
      for (const chunk of page.chunks) publish(state, chunk);
      cursor = page.nextCursor;
      if (page.complete) break;
      await delay(page.chunks.length === 0 ? 10 : 0);
    }
    const waited = unwrap(await state.client.waitForCommand({
      ...requestMetadata(),
      sandboxId: state.sandboxId,
      processId: state.processId,
    }));
    state.exitCode = waited.result.exitCode;
    state.durationMs = waited.result.durationMs;
    for (const instance of state.instances) instance.durationMs = state.durationMs;
    const finished = new CommandFinished(state as never);
    state.finished = finished;
    state.resolveCompletion(finished);
  } catch (error) {
    state.rejectCompletion(error);
  } finally {
    state.settled = true;
    for (const wake of state.followers) wake();
    state.followers.clear();
  }
}

async function awaitCompletion(
  state: CommandState,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<CommandFinished> {
  throwIfAborted(signal);
  if (signal === undefined) return state.completion;
  const deferred = Promise.withResolvers<CommandFinished>();
  const abort = (): void => {
    onAbort?.();
    deferred.reject(abortError());
  };
  signal.addEventListener("abort", abort, { once: true });
  void state.completion.then(deferred.resolve, deferred.reject).finally(() => {
    signal.removeEventListener("abort", abort);
  });
  return deferred.promise;
}

export class Command {
  readonly #state: CommandState;
  durationMs?: number;

  constructor(internalFactory: never) {
    this.#state = internalFactory as CommandState;
    this.#state.instances.add(this);
    if (this.#state.durationMs !== undefined) this.durationMs = this.#state.durationMs;
  }

  get cmdId(): string {
    return this.#state.processId;
  }

  get cwd(): string {
    return this.#state.cwd;
  }

  get startedAt(): number {
    return this.#state.startedAt;
  }

  get exitCode(): number | null {
    return this.#state.exitCode;
  }

  logs(options: CommandOptions = {}): CommandLogIterator {
    const iterator = this.#iterateLogs(options);
    return Object.assign(iterator, {
      close(): void {
        void iterator.return(undefined);
      },
      [Symbol.dispose](): void {
        void iterator.return(undefined);
      },
    });
  }

  async wait(options: CommandOptions = {}): Promise<CommandFinished> {
    if (this.#state.finished !== undefined) return this.#state.finished;
    return awaitCompletion(this.#state, options.signal, () => {
      void this.kill("SIGTERM").catch(() => undefined);
    });
  }

  async output(stream: CommandOutput = "both", options: CommandOptions = {}): Promise<string> {
    await awaitCompletion(this.#state, options.signal);
    return collectOutput(this.#state, stream);
  }

  async stdout(options: CommandOptions = {}): Promise<string> {
    return this.output("stdout", options);
  }

  async stderr(options: CommandOptions = {}): Promise<string> {
    return this.output("stderr", options);
  }

  async kill(
    signal: Signal = "SIGTERM",
    options: { abortSignal?: AbortSignal } = {},
  ): Promise<void> {
    if (typeof signal !== "number" && PORTABLE_SIGNALS[signal] !== true) {
      throw new TypeError(`Unsupported signal \"${String(signal)}\".`);
    }
    throwIfAborted(options.abortSignal);
    unwrap(await this.#state.client.signalProcess({
      ...mutationMetadata(),
      sandboxId: this.#state.sandboxId,
      processId: this.#state.processId,
      signal,
    }));
  }

  async *#iterateLogs(options: CommandOptions): AsyncGenerator<CommandChunk, void, void> {
    let cursor = 0;
    for (;;) {
      throwIfAborted(options.signal);
      while (cursor < this.#state.chunks.length) {
        const chunk = this.#state.chunks[cursor];
        cursor += 1;
        if (chunk !== undefined) yield { ...chunk };
      }
      if (this.#state.settled) return;

      const deferred = Promise.withResolvers<void>();
      const wake = (): void => deferred.resolve();
      const abort = (): void => deferred.reject(abortError());
      this.#state.followers.add(wake);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        await deferred.promise;
      } finally {
        this.#state.followers.delete(wake);
        options.signal?.removeEventListener("abort", abort);
      }
    }
  }
}

export class CommandFinished extends Command {
  constructor(internalFactory: never) {
    super(internalFactory);
  }

  override get exitCode(): number {
    return super.exitCode ?? 0;
  }

  override async wait(): Promise<CommandFinished> {
    return this;
  }
}

/** @internal */
export function createCommand(
  client: SandboxClient,
  sandboxId: string,
  process: ProcessRecord,
  stdout?: Writable,
  stderr?: Writable,
): Command {
  const completion = Promise.withResolvers<CommandFinished>();
  const state: CommandState = {
    client,
    sandboxId,
    processId: process.processId,
    cwd: process.cwd,
    startedAt: process.startedAt,
    chunks: [],
    followers: new Set(),
    instances: new Set(),
    completion: completion.promise,
    resolveCompletion: completion.resolve,
    rejectCompletion: completion.reject,
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
    exitCode: process.exitCode,
    durationMs: undefined,
    settled: false,
    finished: undefined,
  };
  const command = new Command(state as never);
  void pumpCommand(state);
  return command;
}
