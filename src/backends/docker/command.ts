import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type Dockerode from "dockerode";
import {
  abortError,
  rawExec,
  throwIfAborted,
  translateDockerError,
} from "./docker.js";

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

const PORTABLE_SIGNALS = new Set<Exclude<Signal, number>>([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGKILL",
  "SIGTERM",
  "SIGCONT",
  "SIGSTOP",
]);

const COMMAND_WRAPPER = String.raw`
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
const pidPath = process.argv[1];
const command = process.argv[2];
const args = process.argv.slice(3);
const child = spawn(command, args, { stdio: "inherit" });
const spawned = once(child, "spawn");
const exited = once(child, "exit");
try {
  await spawned;
} catch (error) {
  await exited.catch(() => undefined);
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(127);
}
await fs.writeFile(pidPath, String(child.pid));
const [code, signal] = await exited;
await fs.rm(pidPath, { force: true });
if (signal) {
  process.kill(process.pid, signal);
} else {
  process.exit(code ?? 1);
}
`;

interface CommandState {
  docker: Dockerode;
  container: Dockerode.Container;
  exec: Dockerode.Exec;
  cmdId: string;
  pidPath: string;
  cwd: string;
  startedAt: number;
  chunks: CommandChunk[];
  followers: Set<() => void>;
  completion: Promise<CommandFinished>;
  resolveCompletion: (result: CommandFinished) => void;
  rejectCompletion: (error: unknown) => void;
  exitCode: number | null;
  durationMs: number | undefined;
  settled: boolean;
  finished: CommandFinished | undefined;
  instances: Set<Command>;
}

function collectOutput(state: CommandState, stream: CommandOutput): string {
  if (stream === "both") return state.chunks.map((chunk) => chunk.data).join("");
  return state.chunks
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.data)
    .join("");
}

function publish(state: CommandState, stream: "stdout" | "stderr", data: string): void {
  if (data.length === 0) return;
  state.chunks.push({ stream, data });
  for (const wake of state.followers) wake();
  state.followers.clear();
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
    return this.#state.cmdId;
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
    if (typeof signal !== "number" && !PORTABLE_SIGNALS.has(signal)) {
      throw new TypeError(`Unsupported signal \"${String(signal)}\".`);
    }
    throwIfAborted(options.abortSignal);
    const info = await this.#state.exec.inspect(
      options.abortSignal === undefined ? undefined : { abortSignal: options.abortSignal },
    );
    if (!info.Running) return;

    try {
      await rawExec(this.#state.docker, this.#state.container, {
        cmd: [
          "/bin/sh",
          "-c",
          'i=0; while [ ! -f \"$1\" ] && [ \"$i\" -lt 100 ]; do sleep 0.01; i=$((i + 1)); done; [ ! -f \"$1\" ] || kill -s \"$2\" \"$(cat \"$1\")\" 2>/dev/null || true',
          "--",
          this.#state.pidPath,
          typeof signal === "number" ? String(signal) : signal.slice(3),
        ],
        ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
      });
    } catch (error) {
      const current = await this.#state.exec.inspect().catch(() => undefined);
      if (current !== undefined && !current.Running) return;
      throw error;
    }
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
export interface StartCommandOptions {
  cmd: string[];
  cwd: string;
  env: string[];
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
}

async function pumpCommand(
  state: CommandState,
  stream: NodeJS.ReadWriteStream,
  stdoutTarget?: Writable,
  stderrTarget?: Writable,
): Promise<void> {
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const stdoutSink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stdoutTarget?.write(chunk);
      publish(state, "stdout", stdoutDecoder.write(chunk));
      callback();
    },
  });
  const stderrSink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stderrTarget?.write(chunk);
      publish(state, "stderr", stderrDecoder.write(chunk));
      callback();
    },
  });
  state.docker.modem.demuxStream(stream, stdoutSink, stderrSink);

  try {
    const ended = Promise.withResolvers<void>();
    let streamEnded = false;
    const finish = (): void => {
      if (streamEnded) return;
      streamEnded = true;
      cleanup();
      ended.resolve();
    };
    const fail = (error: Error): void => {
      if (streamEnded) return;
      streamEnded = true;
      cleanup();
      ended.reject(error);
    };
    const cleanup = (): void => {
      stream.off("end", finish);
      stream.off("close", finish);
      stream.off("error", fail);
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", fail);
    await ended.promise;

    publish(state, "stdout", stdoutDecoder.end());
    publish(state, "stderr", stderrDecoder.end());
    let info = await state.exec.inspect();
    while (info.Running) {
      await delay(10);
      info = await state.exec.inspect();
    }
    state.exitCode = info.ExitCode ?? 0;
    state.durationMs = Date.now() - state.startedAt;
    for (const instance of state.instances) instance.durationMs = state.durationMs;
    const finished = new CommandFinished(state as never);
    state.finished = finished;
    state.resolveCompletion(finished);
  } catch (error) {
    try {
      translateDockerError(error);
    } catch (translated) {
      state.rejectCompletion(translated);
    }
  } finally {
    state.settled = true;
    for (const wake of state.followers) wake();
    state.followers.clear();
  }
}

/** @internal */
export async function startCommand(
  docker: Dockerode,
  container: Dockerode.Container,
  options: StartCommandOptions,
): Promise<Command> {
  throwIfAborted(options.signal);
  const pidPath = `/tmp/localbox/command-${randomUUID()}.pid`;
  try {
    const exec = await container.exec({
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ["node", "--input-type=module", "-e", COMMAND_WRAPPER, pidPath, ...options.cmd],
      WorkingDir: options.cwd,
      Env: options.env,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    throwIfAborted(options.signal);
    const stream = await exec.start({
      Detach: false,
      Tty: false,
      hijack: true,
      stdin: false,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    const completion = Promise.withResolvers<CommandFinished>();
    const state: CommandState = {
      docker,
      container,
      exec,
      cmdId: exec.id,
      pidPath,
      cwd: options.cwd,
      startedAt: Date.now(),
      chunks: [],
      followers: new Set(),
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      rejectCompletion: completion.reject,
      exitCode: null,
      durationMs: undefined,
      settled: false,
      finished: undefined,
      instances: new Set(),
    };
    const command = new Command(state as never);
    void pumpCommand(state, stream, options.stdout, options.stderr);
    return command;
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    translateDockerError(error);
  }
}
