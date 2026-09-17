import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type Dockerode from "dockerode";
import type {
  ProcessSignal,
  RawCommand,
  RawCommandEvent,
} from "../../runtime/index.js";
import {
  abortError,
  rawExec,
  throwIfAborted,
  translateDockerError,
} from "./docker.js";

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

/** @internal */
export interface StartRawCommandOptions {
  cmd: string[];
  cwd: string;
  env: string[];
  user?: string;
  signal?: AbortSignal;
}

class DockerRawCommand implements RawCommand {
  readonly startedAt: number;
  readonly events: AsyncIterable<RawCommandEvent>;
  readonly #docker: Dockerode;
  readonly #container: Dockerode.Container;
  readonly #exec: Dockerode.Exec;
  readonly #pidPath: string;
  readonly #queuedEvents: RawCommandEvent[] = [];
  readonly #followers = new Set<() => void>();
  #closed = false;
  #closeStream: (() => void) | undefined;

  constructor(
    docker: Dockerode,
    container: Dockerode.Container,
    exec: Dockerode.Exec,
    pidPath: string,
    stream: NodeJS.ReadWriteStream,
  ) {
    this.#docker = docker;
    this.#container = container;
    this.#exec = exec;
    this.#pidPath = pidPath;
    this.startedAt = Date.now();
    this.events = this.#iterateEvents();
    void this.#pump(stream);
  }

  async signal(signal: ProcessSignal, abortSignal?: AbortSignal): Promise<void> {
    throwIfAborted(abortSignal);
    const info = await this.#exec.inspect(
      abortSignal === undefined ? undefined : { abortSignal },
    );
    if (!info.Running) return;

    try {
      await rawExec(this.#docker, this.#container, {
        cmd: [
          "/bin/sh",
          "-c",
          'i=0; while [ ! -f "$1" ] && [ "$i" -lt 100 ]; do sleep 0.01; i=$((i + 1)); done; [ ! -f "$1" ] || kill -s "$2" "$(cat "$1")" 2>/dev/null || true',
          "--",
          this.#pidPath,
          typeof signal === "number" ? String(signal) : signal.slice(3),
        ],
        ...(abortSignal === undefined ? {} : { signal: abortSignal }),
      });
    } catch (error) {
      const current = await this.#exec.inspect().catch(() => undefined);
      if (current !== undefined && !current.Running) return;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queuedEvents.length = 0;
    this.#closeStream?.();
    for (const wake of this.#followers) wake();
    this.#followers.clear();
  }

  #publish(event: RawCommandEvent): void {
    if (this.#closed) return;
    this.#queuedEvents.push(event);
    for (const wake of this.#followers) wake();
    this.#followers.clear();
  }

  #finish(event: Extract<RawCommandEvent, { type: "complete" | "backend-failure" }>): void {
    if (this.#closed) return;
    this.#publish(event);
    this.#closed = true;
    for (const wake of this.#followers) wake();
    this.#followers.clear();
  }

  async *#iterateEvents(): AsyncGenerator<RawCommandEvent, void, void> {
    for (;;) {
      while (this.#queuedEvents.length > 0) {
        const event = this.#queuedEvents.shift();
        if (event !== undefined) yield event;
      }
      if (this.#closed) return;
      const deferred = Promise.withResolvers<void>();
      const wake = (): void => deferred.resolve();
      this.#followers.add(wake);
      try {
        if (this.#queuedEvents.length === 0 && !this.#closed) {
          await deferred.promise;
        }
      } finally {
        this.#followers.delete(wake);
      }
    }
  }

  async #pump(stream: NodeJS.ReadWriteStream): Promise<void> {
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const stdoutSink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const data = stdoutDecoder.write(chunk);
        if (data.length > 0) this.#publish({ type: "stdout", data });
        callback();
      },
    });
    const stderrSink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const data = stderrDecoder.write(chunk);
        if (data.length > 0) this.#publish({ type: "stderr", data });
        callback();
      },
    });
    this.#docker.modem.demuxStream(stream, stdoutSink, stderrSink);

    try {
      const ended = Promise.withResolvers<void>();
      let streamEnded = false;
      const cleanup = (): void => {
        stream.off("end", finish);
        stream.off("close", finish);
        stream.off("error", fail);
        this.#closeStream = undefined;
      };
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
      this.#closeStream = finish;
      stream.once("end", finish);
      stream.once("close", finish);
      stream.once("error", fail);
      await ended.promise;

      const stdout = stdoutDecoder.end();
      const stderr = stderrDecoder.end();
      if (stdout.length > 0) this.#publish({ type: "stdout", data: stdout });
      if (stderr.length > 0) this.#publish({ type: "stderr", data: stderr });
      let info = await this.#exec.inspect();
      while (info.Running) {
        await delay(10);
        info = await this.#exec.inspect();
      }
      this.#finish({
        type: "complete",
        exitCode: info.ExitCode ?? 0,
        finishedAt: Date.now(),
      });
    } catch (error) {
      let translated: unknown = error;
      try {
        translateDockerError(error);
      } catch (candidate) {
        translated = candidate;
      }
      this.#finish({
        type: "backend-failure",
        code: "LOCALBOX_DOCKER_COMMAND_FAILURE",
        message: translated instanceof Error
          ? translated.message
          : "The Docker command failed.",
        retryable: false,
      });
    } finally {
      this.#closeStream?.();
    }
  }
}

/** @internal */
export async function startRawCommand(
  docker: Dockerode,
  container: Dockerode.Container,
  options: StartRawCommandOptions,
): Promise<RawCommand> {
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
      ...(options.user === undefined ? {} : { User: options.user }),
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
    return new DockerRawCommand(docker, container, exec, pidPath, stream);
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    translateDockerError(error);
  }
}
