import type { Dirent, Stats } from "node:fs";
import { posix } from "node:path";
import type {
  FilesystemOperation,
  JsonObject,
  SandboxClient,
} from "../../runtime/index.js";
import {
  mutationMetadata,
  requestMetadata,
  throwIfAborted,
  unwrap,
  withAbort,
} from "./client.js";

const WORKSPACE = "/vercel/sandbox";

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
        mode: normalized.mode ?? null,
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
      {
        path: resolveSandboxPath(path),
        recursive: options.recursive ?? false,
        force: options.force ?? false,
      },
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
    await this.#run(
      "chown",
      { path: resolveSandboxPath(path), uid, gid },
      undefined,
      options.signal,
    );
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
    operation: FilesystemOperation,
    arguments_: JsonObject,
    input?: Buffer,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    await this.#state.ensureRunning(signal);
    throwIfAborted(signal);
    const result = unwrap(await withAbort(this.#state.client.runFilesystemOperation({
      ...mutationMetadata(),
      sandboxId: this.#state.sandboxId,
      operation,
      arguments: arguments_,
      content: input === undefined
        ? null
        : { encoding: "base64", data: input.toString("base64") },
    }), signal));
    if (result.value === null) return Buffer.alloc(0);
    const encoded = JSON.stringify(result.value);
    if (encoded === undefined) throw new TypeError("Filesystem result is not JSON-compatible.");
    return Buffer.from(encoded);
  }
}

/** @internal */
export function createFileSystem(
  client: SandboxClient,
  sandboxId: string,
  ensureRunning: (signal?: AbortSignal) => Promise<void>,
): FileSystem {
  return new FileSystem({
    client,
    sandboxId,
    ensureRunning,
  } as never);
}
