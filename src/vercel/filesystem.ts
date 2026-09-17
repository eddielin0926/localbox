import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { posix } from "node:path";
import type { SandboxClient } from "../runtime/index.js";
import { createCommand } from "./command.js";
import {
  mutationMetadata,
  requestMetadata,
  throwIfAborted,
  unwrap,
  withAbort,
} from "./client.js";

const WORKSPACE = "/vercel/sandbox";
const ERROR_PREFIX = "LOCALBOX_ERROR:";

const FILESYSTEM_BRIDGE = String.raw`
import * as fs from "node:fs/promises";
const op = process.argv[1];
const args = JSON.parse(process.argv[2]);
const input = () => Buffer.from(args.stdin ?? "", "base64");
const json = (value) => process.stdout.write(JSON.stringify(value ?? null));
const stats = (value) => ({
  dev: value.dev,
  ino: value.ino,
  mode: value.mode,
  nlink: value.nlink,
  uid: value.uid,
  gid: value.gid,
  rdev: value.rdev,
  size: value.size,
  blksize: value.blksize,
  blocks: value.blocks,
  atimeMs: value.atimeMs,
  mtimeMs: value.mtimeMs,
  ctimeMs: value.ctimeMs,
  birthtimeMs: value.birthtimeMs,
  type: value.isFile() ? "file"
    : value.isDirectory() ? "directory"
    : value.isBlockDevice() ? "block"
    : value.isCharacterDevice() ? "character"
    : value.isSymbolicLink() ? "symlink"
    : value.isFIFO() ? "fifo"
    : value.isSocket() ? "socket"
    : "unknown",
});
const dirent = (value, parentPath) => ({
  name: value.name,
  parentPath,
  type: value.isFile() ? "file"
    : value.isDirectory() ? "directory"
    : value.isBlockDevice() ? "block"
    : value.isCharacterDevice() ? "character"
    : value.isSymbolicLink() ? "symlink"
    : value.isFIFO() ? "fifo"
    : value.isSocket() ? "socket"
    : "unknown",
});
try {
  switch (op) {
    case "appendFile": await fs.appendFile(args.path, input(), args.options); break;
    case "readdir": {
      const entries = await fs.readdir(args.path, { withFileTypes: args.withFileTypes });
      json(args.withFileTypes ? entries.map((entry) => dirent(entry, args.path)) : entries);
      break;
    }
    case "stat": json(stats(await fs.stat(args.path))); break;
    case "lstat": json(stats(await fs.lstat(args.path))); break;
    case "unlink": await fs.unlink(args.path); break;
    case "rm": await fs.rm(args.path, args.options); break;
    case "rmdir": await fs.rmdir(args.path); break;
    case "rename": await fs.rename(args.oldPath, args.newPath); break;
    case "copyFile": await fs.copyFile(args.src, args.dest); break;
    case "chmod": await fs.chmod(args.path, args.mode); break;
    case "chown": await fs.chown(args.path, args.uid, args.gid); break;
    case "symlink": await fs.symlink(args.target, args.path); break;
    case "readlink": json(await fs.readlink(args.path)); break;
    case "realpath": json(await fs.realpath(args.path)); break;
    case "truncate": await fs.truncate(args.path, args.len); break;
    case "mkdtemp": json(await fs.mkdtemp(args.prefix)); break;
    case "access": await fs.access(args.path); break;
    default: throw new Error("Unknown filesystem operation");
  }
} catch (error) {
  process.stderr.write(${JSON.stringify(ERROR_PREFIX)} + JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    code: error?.code,
    syscall: error?.syscall,
    path: error?.path,
  }));
  process.exitCode = 1;
}
`;

interface NodeFileError extends Error {
  code?: string;
  syscall?: string;
  path?: string;
}

interface SerializedStats {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  type: SerializedFileType;
}

interface SerializedDirent {
  name: string;
  parentPath: string;
  type: SerializedFileType;
}

type SerializedFileType =
  | "file"
  | "directory"
  | "block"
  | "character"
  | "symlink"
  | "fifo"
  | "socket"
  | "unknown";

interface FileSystemState {
  readonly client: SandboxClient;
  readonly sandboxId: string;
  readonly ensureRunning: (signal?: AbortSignal) => Promise<void>;
}

export interface FileReadOptions {
  encoding?: BufferEncoding | null;
  signal?: AbortSignal;
}

export interface FileWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  signal?: AbortSignal;
}

export type FileAppendOptions = FileWriteOptions;

export interface FileMkdirOptions {
  recursive?: boolean;
  mode?: number;
  signal?: AbortSignal;
}

export interface FileReaddirOptions {
  withFileTypes?: boolean;
  signal?: AbortSignal;
}

export interface FileRemoveOptions {
  recursive?: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

export interface FileOperationOptions {
  signal?: AbortSignal;
}

export type FileRenameOptions = FileOperationOptions;
export type FileCopyOptions = FileOperationOptions;
export type FileChmodOptions = FileOperationOptions;
export type FileAccessOptions = FileOperationOptions;

export function resolveSandboxPath(path: string): string {
  if (path.includes("\0")) throw new TypeError("File paths cannot contain NUL bytes.");
  return posix.isAbsolute(path) ? path : posix.resolve(WORKSPACE, path);
}

function fileError(stderr: Buffer): NodeFileError {
  const text = stderr.toString("utf8");
  const marker = text.indexOf(ERROR_PREFIX);
  if (marker === -1) return new Error("The filesystem operation failed inside the sandbox.");
  const payload = JSON.parse(text.slice(marker + ERROR_PREFIX.length)) as {
    message: string;
    code?: string;
    syscall?: string;
    path?: string;
  };
  const error = new Error(payload.message) as NodeFileError;
  if (payload.code !== undefined) error.code = payload.code;
  if (payload.syscall !== undefined) error.syscall = payload.syscall;
  if (payload.path !== undefined) error.path = payload.path;
  return error;
}

function assertEncoding(encoding: string): asserts encoding is BufferEncoding {
  if (!Buffer.isEncoding(encoding)) throw new TypeError(`Unsupported encoding "${encoding}".`);
}

function statsFromPayload(payload: SerializedStats): Stats {
  const matches = (type: SerializedFileType): boolean => payload.type === type;
  return {
    ...payload,
    atime: new Date(payload.atimeMs),
    mtime: new Date(payload.mtimeMs),
    ctime: new Date(payload.ctimeMs),
    birthtime: new Date(payload.birthtimeMs),
    isFile: () => matches("file"),
    isDirectory: () => matches("directory"),
    isBlockDevice: () => matches("block"),
    isCharacterDevice: () => matches("character"),
    isSymbolicLink: () => matches("symlink"),
    isFIFO: () => matches("fifo"),
    isSocket: () => matches("socket"),
  } as Stats;
}

function direntFromPayload(payload: SerializedDirent): Dirent {
  const matches = (type: SerializedFileType): boolean => payload.type === type;
  return {
    name: payload.name,
    parentPath: payload.parentPath,
    path: payload.parentPath,
    isFile: () => matches("file"),
    isDirectory: () => matches("directory"),
    isBlockDevice: () => matches("block"),
    isCharacterDevice: () => matches("character"),
    isSymbolicLink: () => matches("symlink"),
    isFIFO: () => matches("fifo"),
    isSocket: () => matches("socket"),
  } as Dirent;
}

export class FileSystem {
  readonly #state: FileSystemState;

  constructor(internalFactory: never) {
    this.#state = internalFactory as FileSystemState;
  }

  readFile(path: string, options?: { encoding?: null; signal?: AbortSignal } | null): Promise<Buffer>;
  readFile(path: string, options: { encoding: BufferEncoding; signal?: AbortSignal } | BufferEncoding): Promise<string>;
  async readFile(
    path: string,
    options?: FileReadOptions | BufferEncoding | null,
  ): Promise<Buffer | string> {
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (encoding !== null && encoding !== undefined) assertEncoding(encoding);
    const signal = typeof options === "object" && options !== null ? options.signal : undefined;
    await this.#state.ensureRunning(signal);
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const page = unwrap(await withAbort(this.#state.client.readFile({
        ...requestMetadata(),
        sandboxId: this.#state.sandboxId,
        path: resolveSandboxPath(path),
        offset,
        limitBytes: 1024 * 1024,
        encoding: "base64",
      }), signal));
      chunks.push(Buffer.from(page.content.data, "base64"));
      if (page.endOfFile) break;
      offset = page.nextOffset;
    }
    const output = Buffer.concat(chunks);
    return encoding === null || encoding === undefined ? output : output.toString(encoding);
  }

  async writeFile(
    path: string,
    data: string | Buffer | Uint8Array,
    options: FileWriteOptions | BufferEncoding = {},
  ): Promise<void> {
    const normalized = typeof options === "string" ? { encoding: options } : options;
    await this.#state.ensureRunning(normalized.signal);
    if (normalized.encoding !== undefined) assertEncoding(normalized.encoding);
    const contents = typeof data === "string"
      ? Buffer.from(data, normalized.encoding ?? "utf8")
      : Buffer.from(data);
    unwrap(await withAbort(this.#state.client.writeFile({
      ...mutationMetadata(),
      sandboxId: this.#state.sandboxId,
      path: resolveSandboxPath(path),
      content: { encoding: "base64", data: contents.toString("base64") },
      mode: normalized.mode ?? null,
    }), normalized.signal));
  }

  async appendFile(
    path: string,
    data: string | Buffer | Uint8Array,
    options: FileAppendOptions | BufferEncoding = {},
  ): Promise<void> {
    const normalized = typeof options === "string" ? { encoding: options } : options;
    if (normalized.encoding !== undefined) assertEncoding(normalized.encoding);
    const contents = typeof data === "string"
      ? Buffer.from(data, normalized.encoding ?? "utf8")
      : Buffer.from(data);
    await this.#run(
      "appendFile",
      {
        path: resolveSandboxPath(path),
        options: normalized.mode === undefined ? {} : { mode: normalized.mode },
      },
      contents,
      normalized.signal,
    );
  }

  async mkdir(path: string, options: FileMkdirOptions | number = {}): Promise<string | undefined> {
    const normalized = typeof options === "number" ? { mode: options } : options;
    await this.#state.ensureRunning(normalized.signal);
    const resolved = resolveSandboxPath(path);
    const result = unwrap(await withAbort(this.#state.client.makeDirectory({
      ...mutationMetadata(),
      sandboxId: this.#state.sandboxId,
      path: resolved,
      recursive: normalized.recursive ?? false,
      mode: normalized.mode ?? null,
    }), normalized.signal));
    return result.created ? resolved : undefined;
  }

  readdir(path: string, options?: FileReaddirOptions & { withFileTypes?: false }): Promise<string[]>;
  readdir(path: string, options: FileReaddirOptions & { withFileTypes: true }): Promise<Dirent[]>;
  async readdir(path: string, options: FileReaddirOptions = {}): Promise<string[] | Dirent[]> {
    const output = await this.#run(
      "readdir",
      { path: resolveSandboxPath(path), withFileTypes: options.withFileTypes ?? false },
      undefined,
      options.signal,
    );
    if (options.withFileTypes === true) {
      return (JSON.parse(output.toString("utf8")) as SerializedDirent[]).map(direntFromPayload);
    }
    return JSON.parse(output.toString("utf8")) as string[];
  }

  async stat(path: string, options: FileOperationOptions = {}): Promise<Stats> {
    const output = await this.#run("stat", { path: resolveSandboxPath(path) }, undefined, options.signal);
    return statsFromPayload(JSON.parse(output.toString("utf8")) as SerializedStats);
  }

  async lstat(path: string, options: FileOperationOptions = {}): Promise<Stats> {
    const output = await this.#run("lstat", { path: resolveSandboxPath(path) }, undefined, options.signal);
    return statsFromPayload(JSON.parse(output.toString("utf8")) as SerializedStats);
  }

  async unlink(path: string, options: FileOperationOptions = {}): Promise<void> {
    await this.#run("unlink", { path: resolveSandboxPath(path) }, undefined, options.signal);
  }

  async rm(path: string, options: FileRemoveOptions = {}): Promise<void> {
    await this.#run(
      "rm",
      { path: resolveSandboxPath(path), options: { recursive: options.recursive ?? false, force: options.force ?? false } },
      undefined,
      options.signal,
    );
  }

  async rmdir(path: string, options: FileOperationOptions = {}): Promise<void> {
    await this.#run("rmdir", { path: resolveSandboxPath(path) }, undefined, options.signal);
  }

  async rename(oldPath: string, newPath: string, options: FileRenameOptions = {}): Promise<void> {
    await this.#run(
      "rename",
      { oldPath: resolveSandboxPath(oldPath), newPath: resolveSandboxPath(newPath) },
      undefined,
      options.signal,
    );
  }

  async copyFile(src: string, dest: string, options: FileCopyOptions = {}): Promise<void> {
    await this.#run(
      "copyFile",
      { src: resolveSandboxPath(src), dest: resolveSandboxPath(dest) },
      undefined,
      options.signal,
    );
  }

  async access(path: string, options: FileAccessOptions = {}): Promise<void> {
    await this.#run("access", { path: resolveSandboxPath(path) }, undefined, options.signal);
  }

  async exists(path: string, options: FileAccessOptions = {}): Promise<boolean> {
    try {
      await this.access(path, options);
      return true;
    } catch (error) {
      if (error instanceof Error && (error as NodeFileError).code === "ENOENT") return false;
      throw error;
    }
  }

  async chmod(path: string, mode: number | string, options: FileChmodOptions = {}): Promise<void> {
    await this.#run("chmod", { path: resolveSandboxPath(path), mode }, undefined, options.signal);
  }

  async chown(
    path: string,
    uid: number,
    gid: number,
    options: FileOperationOptions = {},
  ): Promise<void> {
    await this.#run("chown", { path: resolveSandboxPath(path), uid, gid }, undefined, options.signal);
  }

  async symlink(
    target: string,
    path: string,
    options: FileOperationOptions = {},
  ): Promise<void> {
    if (target.includes("\0")) throw new TypeError("File paths cannot contain NUL bytes.");
    await this.#run("symlink", { target, path: resolveSandboxPath(path) }, undefined, options.signal);
  }

  async readlink(path: string, options: FileOperationOptions = {}): Promise<string> {
    const output = await this.#run("readlink", { path: resolveSandboxPath(path) }, undefined, options.signal);
    return JSON.parse(output.toString("utf8")) as string;
  }

  async realpath(path: string, options: FileOperationOptions = {}): Promise<string> {
    const output = await this.#run("realpath", { path: resolveSandboxPath(path) }, undefined, options.signal);
    return JSON.parse(output.toString("utf8")) as string;
  }

  async truncate(path: string, len = 0, options: FileOperationOptions = {}): Promise<void> {
    await this.#run("truncate", { path: resolveSandboxPath(path), len }, undefined, options.signal);
  }

  async mkdtemp(prefix: string, options: FileOperationOptions = {}): Promise<string> {
    const output = await this.#run(
      "mkdtemp",
      { prefix: resolveSandboxPath(prefix) },
      undefined,
      options.signal,
    );
    return JSON.parse(output.toString("utf8")) as string;
  }

  async #run(
    operation: string,
    args: Record<string, unknown>,
    stdin?: Buffer,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    await this.#state.ensureRunning(signal);
    throwIfAborted(signal);
    const processId = randomUUID();
    const nodeArguments = [
      "--input-type=module",
      "-e",
      FILESYSTEM_BRIDGE,
      operation,
      JSON.stringify({
        ...args,
        ...(stdin === undefined ? {} : { stdin: stdin.toString("base64") }),
      }),
    ];
    const started = unwrap(await withAbort(this.#state.client.startCommand({
      ...mutationMetadata(),
      sandboxId: this.#state.sandboxId,
      processId,
      command: {
        command: operation === "chown" ? "/usr/bin/sudo" : "node",
        arguments: operation === "chown" ? ["node", ...nodeArguments] : nodeArguments,
        cwd: WORKSPACE,
        environment: {},
      },
      outputLimitBytes: 16 * 1024 * 1024,
    }), signal));
    const command = createCommand(this.#state.client, this.#state.sandboxId, started.process);
    const finished = await command.wait(signal === undefined ? {} : { signal });
    const stdout = Buffer.from(await finished.stdout());
    if (finished.exitCode !== 0) throw fileError(Buffer.from(await finished.stderr()));
    return stdout;
  }
}

/** @internal */
export function createFileSystem(
  client: SandboxClient,
  sandboxId: string,
  ensureRunning: (signal?: AbortSignal) => Promise<void>,
): FileSystem {
  return new FileSystem({ client, sandboxId, ensureRunning } as never);
}
