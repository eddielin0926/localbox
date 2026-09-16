import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import Dockerode from "dockerode";
import {
  DockerUnavailableError,
  ImagePullError,
} from "../vercel/errors.js";

export const docker = new Dockerode();

let connected = false;

interface DockerError extends Error {
  statusCode?: number;
  status?: number;
  code?: string;
  reason?: string;
}

export function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

export function dockerStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const dockerError = error as DockerError;
  return dockerError.statusCode ?? dockerError.status;
}

export function isNotFound(error: unknown): boolean {
  return dockerStatus(error) === 404;
}

export function isConflict(error: unknown): boolean {
  return dockerStatus(error) === 409;
}

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as DockerError;
  return candidate.code === "ECONNREFUSED"
    || candidate.code === "ENOENT"
    || candidate.code === "EACCES"
    || candidate.code === "ENOTFOUND"
    || candidate.code === "ETIMEDOUT"
    || candidate.code === "ECONNRESET"
    || /connect|socket|daemon/i.test(candidate.message) && dockerStatus(error) === undefined;
}

export function translateDockerError(error: unknown): never {
  if (error instanceof DockerUnavailableError) throw error;
  if (isConnectionFailure(error)) throw new DockerUnavailableError(error);
  throw error;
}

export async function ensureDocker(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (connected) return;
  try {
    await docker.ping();
    throwIfAborted(signal);
    connected = true;
  } catch (error) {
    translateDockerError(error);
  }
}

export async function ensureImage(image: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  try {
    await docker.getImage(image).inspect();
    return;
  } catch (error) {
    if (!isNotFound(error)) translateDockerError(error);
  }

  try {
    const pull = Promise.withResolvers<NodeJS.ReadableStream>();
    docker.pull(image, { abortSignal: signal }, (error, pullStream) => {
      if (error) pull.reject(error);
      else if (pullStream === undefined) pull.reject(new Error(`Docker returned no pull stream for ${image}.`));
      else pull.resolve(pullStream);
    });
    const stream = await pull.promise;
    const progress = Promise.withResolvers<void>();
    docker.modem.followProgress(stream, (error: Error | null) => {
      if (error) progress.reject(error);
      else progress.resolve();
    });
    await progress.promise;
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (isConnectionFailure(error)) translateDockerError(error);
    throw new ImagePullError(image, error);
  }
}

export interface RawExecOptions {
  cmd: string[];
  cwd?: string;
  env?: string[];
  stdin?: Buffer | Uint8Array;
  signal?: AbortSignal;
}

export interface RawExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function inspectUntilFinished(exec: Dockerode.Exec): Promise<Dockerode.ExecInspectInfo> {
  for (;;) {
    const info = await exec.inspect();
    if (!info.Running) return info;
    await delay(10);
  }
}

export async function rawExec(
  container: Dockerode.Container,
  options: RawExecOptions,
): Promise<RawExecResult> {
  throwIfAborted(options.signal);
  try {
    const exec = await container.exec({
      AttachStdin: options.stdin !== undefined,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: options.cmd,
      ...(options.cwd === undefined ? {} : { WorkingDir: options.cwd }),
      ...(options.env === undefined ? {} : { Env: options.env }),
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    throwIfAborted(options.signal);

    const stream = await exec.start({
      Detach: false,
      Tty: false,
      hijack: true,
      stdin: options.stdin !== undefined,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutSink = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        stdout.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
        callback();
      },
    });
    const stderrSink = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        stderr.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
        callback();
      },
    });
    docker.modem.demuxStream(stream, stdoutSink, stderrSink);

    const completion = Promise.withResolvers<void>();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      completion.resolve();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      completion.reject(error);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      completion.reject(abortError());
    };
    const cleanup = (): void => {
      stream.off("end", finish);
      stream.off("close", finish);
      stream.off("error", fail);
      options.signal?.removeEventListener("abort", abort);
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", fail);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.stdin !== undefined) stream.end(options.stdin);
    await completion.promise;

    const info = await inspectUntilFinished(exec);
    return {
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode: info.ExitCode ?? 0,
    };
  } catch (error) {
    if (options.signal?.aborted || error instanceof DOMException && error.name === "AbortError") {
      throw abortError();
    }
    translateDockerError(error);
  }
}
