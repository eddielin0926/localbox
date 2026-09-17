import { randomUUID } from "node:crypto";
import type {
  ClientFailure,
  ClientResult,
  FileContent,
  FilesystemOperation,
  JsonObject,
  JsonValue,
  MakeDirectoryRequest,
  MakeDirectoryResult,
  RawCommandEvent,
  ReadFileRequest,
  ReadFileResult,
  RequestMetadata,
  RunFilesystemOperationRequest,
  RunFilesystemOperationResult,
  SandboxBackend,
  WriteFileRequest,
  WriteFileResult,
} from "./index.js";

export const FILESYSTEM_TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const FILESYSTEM_ARGUMENT_LIMIT_BYTES = 64 * 1024;
export const FILESYSTEM_RESULT_LIMIT_BYTES = 16 * 1024 * 1024;

const WORKSPACE = "/vercel/sandbox";
const ERROR_PREFIX = "LOCALBOX_FILESYSTEM_ERROR:";
const FILESYSTEM_READ_OPERATIONS: Readonly<Partial<Record<FilesystemOperation, true>>> = {
  readdir: true,
  stat: true,
  lstat: true,
  access: true,
  readlink: true,
  realpath: true,
};

const FILESYSTEM_PROGRAM = String.raw`
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
const operation = process.argv[1];
const args = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
const hostRoot = process.env.LOCALBOX_INTERNAL_FILESYSTEM_ROOT;
const virtualRoot = process.env.LOCALBOX_INTERNAL_FILESYSTEM_VIRTUAL_ROOT;
const mapped = typeof hostRoot === "string" && typeof virtualRoot === "string";
const normalizedHostRoot = mapped ? path.resolve(hostRoot) : null;
const normalizedVirtualRoot = mapped ? path.posix.resolve(virtualRoot) : null;
const realHostRoot = mapped ? await fsp.realpath(normalizedHostRoot) : null;
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
const reversePath = (value) => {
  if (!mapped || typeof value !== "string") return value;
  const normalized = path.resolve(value);
  const root = inside(normalizedHostRoot, normalized)
    ? normalizedHostRoot
    : inside(realHostRoot, normalized) ? realHostRoot : null;
  if (root === null) return value;
  const suffix = path.relative(root, normalized).split(path.sep).join("/");
  return suffix.length === 0 ? normalizedVirtualRoot : normalizedVirtualRoot + "/" + suffix;
};
const invalidPath = (value) => Object.assign(new Error("Filesystem path escapes " + normalizedVirtualRoot + "."), {
  code: "EACCES",
  syscall: operation,
  path: value,
});
const lexicalPath = (value) => {
  if (!mapped) return value;
  const virtual = path.posix.isAbsolute(value)
    ? path.posix.normalize(value)
    : path.posix.resolve(normalizedVirtualRoot, value);
  if (virtual !== normalizedVirtualRoot && !virtual.startsWith(normalizedVirtualRoot + "/")) {
    throw invalidPath(value);
  }
  const suffix = virtual === normalizedVirtualRoot ? "" : virtual.slice(normalizedVirtualRoot.length + 1);
  const host = path.resolve(normalizedHostRoot, ...suffix.split("/").filter(Boolean));
  if (!inside(normalizedHostRoot, host)) throw invalidPath(value);
  return host;
};
const safePath = async (value, { allowMissing = false, followFinal = true } = {}) => {
  const host = lexicalPath(value);
  if (!mapped) return host;
  const rootReal = realHostRoot;
  let probe = followFinal ? host : path.dirname(host);
  while (true) {
    try {
      const probeReal = await fsp.realpath(probe);
      if (!inside(rootReal, probeReal)) throw invalidPath(value);
      break;
    } catch (error) {
      if (!allowMissing || !error || typeof error !== "object" || error.code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe || !inside(normalizedHostRoot, parent)) throw invalidPath(value);
      probe = parent;
    }
  }
  return host;
};
const transferPath = async (id) => {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw invalidPath(id);
  if (!mapped) return "/tmp/localbox-filesystem-" + id;
  const directory = path.join(normalizedHostRoot, ".localbox-transfers");
  await fsp.mkdir(directory, { mode: 0o700 });
  return path.join(directory, id);
};
const readInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const json = (value) => process.stdout.write(JSON.stringify(value ?? null));
const type = (value) => value.isFile() ? "file"
  : value.isDirectory() ? "directory"
  : value.isBlockDevice() ? "block"
  : value.isCharacterDevice() ? "character"
  : value.isSymbolicLink() ? "symlink"
  : value.isFIFO() ? "fifo"
  : value.isSocket() ? "socket"
  : "unknown";
const stats = (value) => ({
  dev: value.dev, ino: value.ino, mode: value.mode, nlink: value.nlink,
  uid: value.uid, gid: value.gid, rdev: value.rdev, size: value.size,
  blksize: value.blksize, blocks: value.blocks, atimeMs: value.atimeMs,
  mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs,
  birthtimeMs: value.birthtimeMs, type: type(value),
});
const dirent = (value, parentPath) => ({ name: value.name, parentPath, type: type(value) });
try {
  switch (operation) {
    case "readFile": {
      const target = await safePath(args.path);
      const handle = await fsp.open(target, "r");
      try {
        const value = await handle.stat();
        const available = Math.max(0, value.size - args.offset);
        const buffer = Buffer.allocUnsafe(Math.min(args.limitBytes, available));
        const { bytesRead } = buffer.length === 0
          ? { bytesRead: 0 }
          : await handle.read(buffer, 0, buffer.length, args.offset);
        const page = buffer.subarray(0, bytesRead);
        json({
          content: page.toString(args.encoding),
          bytesRead,
          nextOffset: args.offset + bytesRead,
          endOfFile: args.offset + bytesRead >= value.size,
        });
      } finally {
        await handle.close();
      }
      break;
    }
    case "stageWrite": {
      await safePath(args.path, { allowMissing: true });
      const input = await readInput();
      const temporary = await transferPath(args.transferId);
      const handle = await fsp.open(temporary, args.offset === 0 ? "wx" : "r+");
      try {
        const value = await handle.stat();
        if (value.size !== args.offset) throw Object.assign(new Error("Filesystem transfer offset mismatch."), { code: "EINVAL", syscall: "write", path: args.path });
        await handle.write(input, 0, input.length, args.offset);
      } finally {
        await handle.close();
      }
      json({ bytesWritten: input.length });
      break;
    }
    case "commitWrite": {
      const temporary = await transferPath(args.transferId);
      const target = await safePath(args.path, { allowMissing: true });
      try {
        await pipeline(
          fs.createReadStream(temporary),
          fs.createWriteStream(target, {
            flags: args.append ? "a" : "w",
            ...(args.mode === null ? {} : { mode: args.mode }),
          }),
        );
      } finally {
        await fsp.rm(temporary, { force: true });
      }
      break;
    }
    case "cleanupTransfer": await fsp.rm(await transferPath(args.transferId), { force: true }); break;
    case "mkdir": json(await fsp.mkdir(await safePath(args.path, { allowMissing: true }), args.options)); break;
    case "readdir": {
      const entries = await fsp.readdir(await safePath(args.path), { withFileTypes: args.withFileTypes });
      json(args.withFileTypes ? entries.map((entry) => dirent(entry, args.path)) : entries);
      break;
    }
    case "stat": json(stats(await fsp.stat(await safePath(args.path)))); break;
    case "lstat": json(stats(await fsp.lstat(await safePath(args.path, { followFinal: false })))); break;
    case "unlink": await fsp.unlink(await safePath(args.path, { followFinal: false })); break;
    case "rm": await fsp.rm(await safePath(args.path, { allowMissing: args.options.force, followFinal: false }), args.options); break;
    case "rmdir": await fsp.rmdir(await safePath(args.path, { followFinal: false })); break;
    case "rename": await fsp.rename(
      await safePath(args.oldPath, { followFinal: false }),
      await safePath(args.newPath, { allowMissing: true, followFinal: false }),
    ); break;
    case "copyFile": await fsp.copyFile(
      await safePath(args.src),
      await safePath(args.dest, { allowMissing: true }),
    ); break;
    case "access": await fsp.access(await safePath(args.path)); break;
    case "chmod": await fsp.chmod(await safePath(args.path), args.mode); break;
    case "chown": await fsp.chown(await safePath(args.path), args.uid, args.gid); break;
    case "symlink": {
      const destination = await safePath(args.path, { allowMissing: true, followFinal: false });
      let target = args.target;
      if (mapped) {
        const destinationVirtual = path.posix.isAbsolute(args.path)
          ? path.posix.normalize(args.path)
          : path.posix.resolve(normalizedVirtualRoot, args.path);
        const targetVirtual = path.posix.isAbsolute(args.target)
          ? path.posix.normalize(args.target)
          : path.posix.resolve(path.posix.dirname(destinationVirtual), args.target);
        const targetHost = await safePath(targetVirtual, { allowMissing: true });
        target = path.posix.isAbsolute(args.target)
          ? targetHost
          : path.relative(path.dirname(destination), targetHost);
      }
      await fsp.symlink(target, destination);
      break;
    }
    case "readlink": {
      const linkPath = await safePath(args.path, { followFinal: false });
      const value = await fsp.readlink(linkPath);
      if (mapped) {
        const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(path.dirname(linkPath), value);
        if (!inside(normalizedHostRoot, resolved) && !inside(realHostRoot, resolved)) throw invalidPath(args.path);
      }
      json(path.isAbsolute(value) ? reversePath(value) : value);
      break;
    }
    case "realpath": json(reversePath(await fsp.realpath(await safePath(args.path)))); break;
    case "truncate": await fsp.truncate(await safePath(args.path), args.len); break;
    case "mkdtemp": json(reversePath(await fsp.mkdtemp(await safePath(args.prefix, { allowMissing: true })))); break;
    default: throw Object.assign(new Error("Unknown filesystem operation."), { code: "EINVAL" });
  }
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = mapped ? rawMessage.split(normalizedHostRoot).join(normalizedVirtualRoot) : rawMessage;
  process.stderr.write(${JSON.stringify(ERROR_PREFIX)} + JSON.stringify({
    message,
    code: error && typeof error === "object" && "code" in error ? error.code : null,
    syscall: error && typeof error === "object" && "syscall" in error ? error.syscall : null,
    path: error && typeof error === "object" && "path" in error ? reversePath(error.path) : null,
  }));
  process.exitCode = 1;
}
`;

interface BridgeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface FileErrorPayload {
  readonly message: string;
  readonly code: string | null;
  readonly syscall: string | null;
  readonly path: string | null;
}

class BridgeFailure {
  constructor(readonly failure: ClientFailure) {}
}

function success<T extends JsonObject>(value: T): ClientResult<T> {
  return { ok: true, value };
}

function failure(
  request: RequestMetadata,
  backend: SandboxBackend,
  category: ClientFailure["error"]["category"],
  code: string,
  message: string,
  details: ClientFailure["error"]["details"],
): ClientFailure {
  return {
    ok: false,
    error: {
      category,
      code,
      message,
      retryable: false,
      requestId: request.requestId,
      backend: backend.reference,
      details,
    },
  };
}

function invalid(request: RequestMetadata, backend: SandboxBackend, field: string, reason: string): ClientFailure {
  return failure(request, backend, "invalid-request", "LOCALBOX_INVALID_REQUEST", reason, {
    type: "invalid-request",
    field,
    reason,
  });
}

function unsupported(
  request: RequestMetadata,
  backend: SandboxBackend,
  capability: "filesystem.mkdir" | "filesystem.read" | "filesystem.write" | "raw-command.input" | "raw-command.managed-filesystem-owner",
): ClientFailure {
  return failure(
    request,
    backend,
    "failed-precondition",
    "LOCALBOX_UNSUPPORTED_CAPABILITY",
    `The backend does not support the required filesystem ${capability} capability.`,
    { type: "backend", operation: "filesystem" },
  );
}

function cancelled(request: RequestMetadata, backend: SandboxBackend): ClientFailure {
  const expired = request.deadline !== null && request.deadline.expiresAt <= Date.now();
  return failure(
    request,
    backend,
    expired ? "deadline-exceeded" : "cancelled",
    expired ? "LOCALBOX_DEADLINE_EXCEEDED" : "LOCALBOX_OPERATION_CANCELLED",
    expired ? "The filesystem operation exceeded its deadline." : "The filesystem operation was cancelled.",
    { type: "backend", operation: "filesystem" },
  );
}

function backendFailure(request: RequestMetadata, backend: SandboxBackend): ClientFailure {
  return failure(
    request,
    backend,
    "backend-failure",
    "LOCALBOX_BACKEND_FAILURE",
    "The backend failed to complete the filesystem operation.",
    { type: "backend", operation: "filesystem" },
  );
}

function fileFailure(request: RequestMetadata, backend: SandboxBackend, payload: FileErrorPayload): ClientFailure {
  return failure(
    request,
    backend,
    payload.code === "ENOENT" ? "not-found" : "backend-failure",
    payload.code === "ENOENT" ? "LOCALBOX_FILE_NOT_FOUND" : "LOCALBOX_FILESYSTEM_FAILURE",
    payload.message,
    {
      type: "file",
      code: payload.code,
      syscall: payload.syscall,
      path: payload.path,
    },
  );
}

function contentBuffer(content: FileContent): Buffer {
  return Buffer.from(content.data, content.encoding);
}

function assertPath(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  if (value.includes("\0")) throw new TypeError("File paths cannot contain NUL bytes.");
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean.`);
}

function assertInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${field} must be an integer greater than or equal to ${minimum}.`);
  }
}

function assertMode(value: unknown, field: string): asserts value is number | null {
  if (value === null) return;
  assertInteger(value, field);
}

function encodeArguments(arguments_: JsonObject): string {
  const json = JSON.stringify(arguments_);
  if (json === undefined) throw new TypeError("Filesystem arguments are not JSON-compatible.");
  if (Buffer.byteLength(json) > FILESYSTEM_ARGUMENT_LIMIT_BYTES) {
    throw new RangeError("Filesystem operation arguments exceed the transfer limit.");
  }
  return Buffer.from(json).toString("base64");
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}
function parseFileError(stderr: string): FileErrorPayload | null {
  const marker = stderr.indexOf(ERROR_PREFIX);
  if (marker < 0) return null;
  try {
    const value = JSON.parse(stderr.slice(marker + ERROR_PREFIX.length)) as Partial<FileErrorPayload>;
    if (typeof value.message !== "string") return null;
    return {
      message: value.message,
      code: typeof value.code === "string" ? value.code : null,
      syscall: typeof value.syscall === "string" ? value.syscall : null,
      path: typeof value.path === "string" ? value.path : null,
    };
  } catch {
    return null;
  }
}

function operationArguments(request: RunFilesystemOperationRequest): JsonObject {
  const args = request.arguments as Record<string, unknown>;
  switch (request.operation) {
    case "appendFile":
      assertPath(args.path, "path");
      assertMode(args.mode, "mode");
      if (request.content === null) throw new TypeError("appendFile requires content.");
      return { path: args.path, mode: args.mode };
    case "readdir":
      assertPath(args.path, "path");
      assertBoolean(args.withFileTypes, "withFileTypes");
      return { path: args.path, withFileTypes: args.withFileTypes };
    case "rm":
      assertPath(args.path, "path");
      assertBoolean(args.recursive, "recursive");
      assertBoolean(args.force, "force");
      return { path: args.path, options: { recursive: args.recursive, force: args.force } };
    case "rename":
      assertPath(args.oldPath, "oldPath");
      assertPath(args.newPath, "newPath");
      return { oldPath: args.oldPath, newPath: args.newPath };
    case "copyFile":
      assertPath(args.src, "src");
      assertPath(args.dest, "dest");
      return { src: args.src, dest: args.dest };
    case "chmod":
      assertPath(args.path, "path");
      if (typeof args.mode !== "number" && typeof args.mode !== "string") {
        throw new TypeError("mode must be a number or string.");
      }
      return { path: args.path, mode: args.mode };
    case "chown":
      assertPath(args.path, "path");
      assertInteger(args.uid, "uid");
      assertInteger(args.gid, "gid");
      return { path: args.path, uid: args.uid, gid: args.gid };
    case "symlink":
      assertPath(args.target, "target");
      assertPath(args.path, "path");
      return { target: args.target, path: args.path };
    case "truncate":
      assertPath(args.path, "path");
      assertInteger(args.len, "len");
      return { path: args.path, len: args.len };
    case "mkdtemp":
      assertPath(args.prefix, "prefix");
      return { prefix: args.prefix };
    case "stat":
    case "lstat":
    case "unlink":
    case "rmdir":
    case "access":
    case "readlink":
    case "realpath":
      assertPath(args.path, "path");
      return { path: args.path };
  }
}

export class FilesystemBridge {
  readonly #backend: SandboxBackend;

  constructor(backend: SandboxBackend) {
    this.#backend = backend;
  }

  async readFile(request: ReadFileRequest, signal?: AbortSignal): Promise<ClientResult<ReadFileResult>> {
    try {
      assertPath(request.path, "path");
      assertInteger(request.offset, "offset");
      assertInteger(request.limitBytes, "limitBytes", 1);
      if (request.limitBytes > FILESYSTEM_TRANSFER_CHUNK_BYTES) {
        throw new RangeError(`File read limit cannot exceed ${FILESYSTEM_TRANSFER_CHUNK_BYTES} bytes.`);
      }
      if (request.encoding !== "base64" && request.encoding !== "utf8") {
        throw new TypeError("encoding must be base64 or utf8.");
      }
      if (this.#backend.capabilities.operations["filesystem.read"].support === "unsupported") {
        return unsupported(request, this.#backend, "filesystem.read");
      }
      const result = await this.#command(request, "readFile", {
        path: request.path,
        offset: request.offset,
        limitBytes: request.limitBytes,
        encoding: request.encoding,
      }, null, signal);
      const payload = parseJson(result.stdout) as Record<string, JsonValue>;
      return success({
        path: request.path,
        content: { encoding: request.encoding, data: String(payload.content) },
        bytesRead: Number(payload.bytesRead),
        nextOffset: Number(payload.nextOffset),
        endOfFile: Boolean(payload.endOfFile),
      });
    } catch (error) {
      return this.#caught(request, error);
    }
  }

  async writeFile(request: WriteFileRequest, signal?: AbortSignal): Promise<ClientResult<WriteFileResult>> {
    try {
      assertPath(request.path, "path");
      assertMode(request.mode, "mode");
      if (this.#backend.capabilities.operations["filesystem.write"].support === "unsupported") {
        return unsupported(request, this.#backend, "filesystem.write");
      }
      const contents = contentBuffer(request.content);
      await this.#transferWrite(request, request.path, contents, request.mode, false, signal);
      return success({ path: request.path, bytesWritten: contents.length });
    } catch (error) {
      return this.#caught(request, error);
    }
  }

  async makeDirectory(
    request: MakeDirectoryRequest,
    signal?: AbortSignal,
  ): Promise<ClientResult<MakeDirectoryResult>> {
    try {
      assertPath(request.path, "path");
      assertBoolean(request.recursive, "recursive");
      assertMode(request.mode, "mode");
      if (this.#backend.capabilities.operations["filesystem.mkdir"].support === "unsupported") {
        return unsupported(request, this.#backend, "filesystem.mkdir");
      }
      const result = await this.#command(request, "mkdir", {
        path: request.path,
        options: {
          recursive: request.recursive,
          ...(request.mode === null ? {} : { mode: request.mode }),
        },
      }, null, signal);
      return success({ path: request.path, created: parseJson(result.stdout) !== null });
    } catch (error) {
      return this.#caught(request, error);
    }
  }

  async run(
    request: RunFilesystemOperationRequest,
    signal?: AbortSignal,
  ): Promise<ClientResult<RunFilesystemOperationResult>> {
    try {
      const args = operationArguments(request);
      const requiredCapability = Object.hasOwn(FILESYSTEM_READ_OPERATIONS, request.operation)
        ? "filesystem.read"
        : "filesystem.write";
      if (this.#backend.capabilities.operations[requiredCapability].support === "unsupported") {
        return unsupported(request, this.#backend, requiredCapability);
      }
      if (request.operation === "appendFile") {
        const content = contentBuffer(request.content!);
        await this.#transferWrite(
          request,
          args.path as string,
          content,
          args.mode as number | null,
          true,
          signal,
        );
        return success({ value: null });
      }
      if (request.content !== null) throw new TypeError(`${request.operation} does not accept content.`);
      const privilege = request.operation === "chown" ? "managed-filesystem-owner" : null;
      if (
        privilege !== null &&
        this.#backend.capabilities.operations["raw-command.managed-filesystem-owner"].support === "unsupported"
      ) {
        return unsupported(request, this.#backend, "raw-command.managed-filesystem-owner");
      }
      const result = await this.#command(request, request.operation, args, null, signal, privilege);
      return success({ value: result.stdout.length === 0 ? null : parseJson(result.stdout) });
    } catch (error) {
      return this.#caught(request, error);
    }
  }

  async #transferWrite(
    request: RequestMetadata & { readonly sandboxId: string },
    path: string,
    contents: Buffer,
    mode: number | null,
    append: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const input = this.#backend.capabilities.operations["raw-command.input"];
    if (
      input.support === "unsupported" ||
      input.constraints.maxBytes < FILESYSTEM_TRANSFER_CHUNK_BYTES
    ) {
      throw new BridgeFailure(unsupported(request, this.#backend, "raw-command.input"));
    }
    if (signal?.aborted) {
      throw new BridgeFailure(cancelled(request, this.#backend));
    }
    const transferId = randomUUID();
    let offset = 0;
    try {
      do {
        const chunk = contents.subarray(offset, offset + FILESYSTEM_TRANSFER_CHUNK_BYTES);
        await this.#command(request, "stageWrite", { path, transferId, offset }, {
          encoding: "base64",
          data: chunk.toString("base64"),
        }, signal);
        offset += chunk.length;
      } while (offset < contents.length);
      await this.#command(request, "commitWrite", { path, transferId, mode, append }, null, signal);
    } catch (error) {
      await this.#command(request, "cleanupTransfer", { transferId }, null, undefined).catch(() => undefined);
      throw error;
    }
  }

  async #command(
    request: RequestMetadata & { readonly sandboxId: string },
    operation: FilesystemOperation | "readFile" | "mkdir" | "stageWrite" | "commitWrite" | "cleanupTransfer",
    arguments_: JsonObject,
    input: FileContent | null,
    signal?: AbortSignal,
    privilege: "managed-filesystem-owner" | null = null,
  ): Promise<BridgeCommandResult> {
    if (signal?.aborted) throw new BridgeFailure(cancelled(request, this.#backend));
    const workspace = await this.#backend.filesystemWorkspace?.(request.sandboxId);
    const environment = workspace === undefined
      ? {}
      : {
          LOCALBOX_INTERNAL_FILESYSTEM_ROOT: workspace.root,
          LOCALBOX_INTERNAL_FILESYSTEM_VIRTUAL_ROOT: workspace.virtualRoot,
        };
    const started = await this.#backend.startRawCommand({
      requestId: request.requestId,
      deadline: request.deadline,
      sandboxId: request.sandboxId,
      command: {
        command: "node",
        arguments: ["--input-type=module", "-e", FILESYSTEM_PROGRAM, operation, encodeArguments(arguments_)],
        cwd: WORKSPACE,
        environment,
      },
      ...(input === null ? {} : { input }),
      ...(privilege === null ? {} : { privilege }),
    }, signal);
    if (!started.ok) throw new BridgeFailure(started);

    const raw = started.command;
    let aborting: Promise<void> | undefined;
    const abort = (): void => {
      aborting ??= raw.signal("SIGKILL").catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let stdout = "";
    let stderr = "";
    let completion: Extract<RawCommandEvent, { type: "complete" | "backend-failure" }> | undefined;
    try {
      for await (const event of raw.events) {
        if (event.type === "stdout") stdout += event.data;
        else if (event.type === "stderr") stderr += event.data;
        else completion = event;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > FILESYSTEM_RESULT_LIMIT_BYTES) {
          await raw.signal("SIGKILL").catch(() => undefined);
          throw new Error("Filesystem operation output exceeded the result limit.");
        }
      }
      if (aborting !== undefined) await aborting;
    } finally {
      signal?.removeEventListener("abort", abort);
      await raw.dispose().catch(() => undefined);
    }
    if (signal?.aborted) throw new BridgeFailure(cancelled(request, this.#backend));
    if (completion?.type === "backend-failure") throw new Error(completion.message);
    if (completion?.type !== "complete") throw new Error("Filesystem command ended without a result.");
    if (completion.exitCode !== 0) {
      const parsed = parseFileError(stderr);
      if (parsed !== null) throw new BridgeFailure(fileFailure(request, this.#backend, parsed));
      throw new Error("Filesystem command failed without a valid error envelope.");
    }
    return { stdout, stderr };
  }

  #caught<T extends JsonObject>(request: RequestMetadata, error: unknown): ClientResult<T> {
    if (error instanceof BridgeFailure) return error.failure;
    if (error instanceof TypeError || error instanceof RangeError) {
      return invalid(request, this.#backend, "filesystem", error.message);
    }
    return backendFailure(request, this.#backend);
  }
}
