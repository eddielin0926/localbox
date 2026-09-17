import { describe, expect, test } from "vitest";
import {
  FILESYSTEM_TRANSFER_CHUNK_BYTES,
  FilesystemBridge,
} from "../../src/runtime/filesystem-bridge.js";
import { EmbeddedSandboxClient } from "../../src/runtime/index.js";
import type {
  ClientFailure,
  RawCommand,
  RawCommandCapability,
  RawCommandEvent,
  RequestMetadata,
  SandboxBackend,
  StartRawCommandResult,
  StartRawCommandRequest,
} from "../../src/runtime/index.js";
import { createFileSystem } from "../../src/vercel/filesystem.js";

const REFERENCE = { backendId: "memory-filesystem", backendType: "test" } as const;
const ERROR_PREFIX = "LOCALBOX_FILESYSTEM_ERROR:";

function unavailable(request: RequestMetadata, operation: string): Promise<ClientFailure> {
  return Promise.resolve({
    ok: false,
    error: {
      category: "backend-unavailable",
      code: "TEST_UNAVAILABLE",
      message: `${operation} is unavailable.`,
      retryable: false,
      requestId: request.requestId,
      backend: REFERENCE,
      details: { type: "backend", operation },
    },
  });
}

function completed(events: readonly RawCommandEvent[]): RawCommand {
  return {
    startedAt: 1,
    events: (async function* () {
      yield* events;
    })(),
    async signal() {},
    async dispose() {},
  };
}

interface RecordedCommand {
  readonly operation: string;
  readonly arguments: Record<string, unknown>;
  readonly inputBytes: number;
  readonly privilege: StartRawCommandRequest["privilege"];
}

class MemoryFilesystemBackend implements SandboxBackend {
  readonly reference = REFERENCE;
  readonly capabilities = ["filesystem.read", "filesystem.write", "filesystem.mkdir"] as const;
  readonly rawCommandCapabilities: readonly RawCommandCapability[];
  readonly files = new Map<string, Buffer>();
  readonly transfers = new Map<string, Buffer>();
  readonly commands: RecordedCommand[] = [];

  constructor(rawCommandCapabilities: readonly RawCommandCapability[] = [
    "input",
    "managed-filesystem-owner",
  ]) {
    this.rawCommandCapabilities = rawCommandCapabilities;
  }

  createSandbox = (request: Parameters<SandboxBackend["createSandbox"]>[0]) => unavailable(request, "createSandbox");
  getSandbox = (request: Parameters<SandboxBackend["getSandbox"]>[0]) => unavailable(request, "getSandbox");
  listSandboxes = (request: Parameters<SandboxBackend["listSandboxes"]>[0]) => unavailable(request, "listSandboxes");
  stopSandbox = (request: Parameters<SandboxBackend["stopSandbox"]>[0]) => unavailable(request, "stopSandbox");
  deleteSandbox = (request: Parameters<SandboxBackend["deleteSandbox"]>[0]) => unavailable(request, "deleteSandbox");
  extendSandboxDeadline = (request: Parameters<SandboxBackend["extendSandboxDeadline"]>[0]) => unavailable(request, "extendSandboxDeadline");
  getEndpoint = (request: Parameters<SandboxBackend["getEndpoint"]>[0]) => unavailable(request, "getEndpoint");

  async startRawCommand(request: StartRawCommandRequest): Promise<StartRawCommandResult> {
    const operation = request.command.arguments[3] ?? "";
    const encoded = request.command.arguments[4] ?? "";
    const arguments_ = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
    const input = request.input === undefined
      ? Buffer.alloc(0)
      : Buffer.from(request.input.data, request.input.encoding);
    this.commands.push({
      operation,
      arguments: arguments_,
      inputBytes: input.length,
      privilege: request.privilege,
    });

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    if (operation === "stageWrite") {
      const transferId = String(arguments_.transferId);
      const existing = this.transfers.get(transferId) ?? Buffer.alloc(0);
      this.transfers.set(transferId, Buffer.concat([existing, input]));
      stdout = JSON.stringify({ bytesWritten: input.length });
    } else if (operation === "commitWrite") {
      const transferId = String(arguments_.transferId);
      const path = String(arguments_.path);
      const transferred = this.transfers.get(transferId) ?? Buffer.alloc(0);
      const previous = this.files.get(path) ?? Buffer.alloc(0);
      this.files.set(path, arguments_.append === true ? Buffer.concat([previous, transferred]) : transferred);
      this.transfers.delete(transferId);
    } else if (operation === "cleanupTransfer") {
      this.transfers.delete(String(arguments_.transferId));
    } else if (operation === "readFile") {
      const path = String(arguments_.path);
      const contents = this.files.get(path);
      if (contents === undefined) {
        exitCode = 1;
        stderr = ERROR_PREFIX + JSON.stringify({
          message: `ENOENT: no such file or directory, open '${path}'`,
          code: "ENOENT",
          syscall: "open",
          path,
        });
      } else {
        const offset = Number(arguments_.offset);
        const page = contents.subarray(offset, offset + Number(arguments_.limitBytes));
        stdout = JSON.stringify({
          content: page.toString(String(arguments_.encoding) as BufferEncoding),
          bytesRead: page.length,
          nextOffset: offset + page.length,
          endOfFile: offset + page.length >= contents.length,
        });
      }
    } else if (operation === "mkdir") {
      stdout = JSON.stringify(arguments_.path);
    } else if (operation === "stat" || operation === "lstat") {
      stdout = JSON.stringify({
        dev: 1,
        ino: 2,
        mode: 0o120777,
        nlink: 1,
        uid: 1000,
        gid: 1000,
        rdev: 0,
        size: 3,
        blksize: 4096,
        blocks: 1,
        atimeMs: 10,
        mtimeMs: 20,
        ctimeMs: 30,
        birthtimeMs: 40,
        type: operation === "lstat" ? "symlink" : "file",
      });
    } else if (operation === "readlink") {
      stdout = JSON.stringify("../target");
    }

    const events: RawCommandEvent[] = [];
    if (stdout.length > 0) events.push({ type: "stdout", data: stdout });
    if (stderr.length > 0) events.push({ type: "stderr", data: stderr });
    events.push({ type: "complete", exitCode, finishedAt: 2 });
    return { ok: true, command: completed(events) };
  }
}

function metadata(requestId: string) {
  return { requestId, idempotencyKey: requestId, deadline: null } as const;
}

describe("neutral filesystem bridge", () => {
  test("round-trips large binary data through bounded stdin chunks instead of argv", async () => {
    const backend = new MemoryFilesystemBackend();
    const client = new EmbeddedSandboxClient(backend);
    const filesystem = createFileSystem(client, "sandbox", async () => undefined);
    const contents = Buffer.alloc(FILESYSTEM_TRANSFER_CHUNK_BYTES + 7, 0xa5);

    await filesystem.writeFile("large.bin", contents, { mode: 0o640 });
    expect(await filesystem.readFile("large.bin")).toEqual(contents);

    const staged = backend.commands.filter((command) => command.operation === "stageWrite");
    expect(staged.map((command) => command.inputBytes)).toEqual([
      FILESYSTEM_TRANSFER_CHUNK_BYTES,
      7,
    ]);
    expect(staged.every((command) => command.inputBytes <= FILESYSTEM_TRANSFER_CHUNK_BYTES)).toBe(true);
    expect(backend.commands.every((command) =>
      !Object.hasOwn(command.arguments, "data") &&
      !Object.hasOwn(command.arguments, "stdin")
    )).toBe(true);
    expect(backend.commands.find((command) => command.operation === "commitWrite")?.arguments).toMatchObject({
      path: "/vercel/sandbox/large.bin",
      mode: 0o640,
      append: false,
    });
    const reads = backend.commands.filter((command) => command.operation === "readFile");
    expect(reads.map((command) => command.arguments.offset)).toEqual([
      0,
      FILESYSTEM_TRANSFER_CHUNK_BYTES,
    ]);
    expect(reads.every((command) =>
      command.arguments.limitBytes === FILESYSTEM_TRANSFER_CHUNK_BYTES
    )).toBe(true);
  });

  test("encodes semantic operations once and preserves metadata and managed ownership privilege", async () => {
    const backend = new MemoryFilesystemBackend();
    const client = new EmbeddedSandboxClient(backend);
    const filesystem = createFileSystem(client, "sandbox", async () => undefined);

    await filesystem.symlink("../target", "link");
    const metadata = await filesystem.lstat("link");
    await filesystem.chown("link", 123, 456);

    expect(metadata.isSymbolicLink()).toBe(true);
    expect(metadata.uid).toBe(1000);
    expect(backend.commands.find((command) => command.operation === "symlink")?.arguments).toEqual({
      target: "../target",
      path: "/vercel/sandbox/link",
    });
    expect(backend.commands.find((command) => command.operation === "chown")).toMatchObject({
      arguments: { path: "/vercel/sandbox/link", uid: 123, gid: 456 },
      privilege: "managed-filesystem-owner",
    });
  });

  test("preserves missing-file code, syscall, and path at the Node adapter boundary", async () => {
    const backend = new MemoryFilesystemBackend();
    const filesystem = createFileSystem(
      new EmbeddedSandboxClient(backend),
      "sandbox",
      async () => undefined,
    );

    await expect(filesystem.readFile("missing")).rejects.toMatchObject({
      code: "ENOENT",
      syscall: "open",
      path: "/vercel/sandbox/missing",
    });
  });

  test("rejects paths and unsupported transfer or privilege capabilities before starting", async () => {
    const backend = new MemoryFilesystemBackend([]);
    const bridge = new FilesystemBridge(backend);

    const invalidPath = await bridge.writeFile({
      ...metadata("nul"),
      sandboxId: "sandbox",
      path: "bad\0path",
      content: { encoding: "base64", data: "AA==" },
      mode: null,
    });
    const unsupportedTransfer = await bridge.writeFile({
      ...metadata("transfer"),
      sandboxId: "sandbox",
      path: "/file",
      content: { encoding: "base64", data: "AA==" },
      mode: null,
    });
    const unsupportedPrivilege = await bridge.run({
      ...metadata("privilege"),
      sandboxId: "sandbox",
      operation: "chown",
      arguments: { path: "/file", uid: 1, gid: 1 },
      content: null,
    });

    expect(invalidPath).toMatchObject({ ok: false, error: { category: "invalid-request" } });
    expect(unsupportedTransfer).toMatchObject({ ok: false, error: { code: "LOCALBOX_UNSUPPORTED_CAPABILITY" } });
    expect(unsupportedPrivilege).toMatchObject({ ok: false, error: { code: "LOCALBOX_UNSUPPORTED_CAPABILITY" } });
    expect(backend.commands).toHaveLength(0);
    expect(backend.files.size).toBe(0);
  });

  test("does not start when already aborted and cleans staged data when aborted during transfer", async () => {
    const beforeBackend = new MemoryFilesystemBackend();
    const beforeBridge = new FilesystemBridge(beforeBackend);
    const before = new AbortController();
    before.abort();
    const beforeResult = await beforeBridge.writeFile({
      ...metadata("before"),
      sandboxId: "sandbox",
      path: "/file",
      content: { encoding: "base64", data: "AA==" },
      mode: null,
    }, before.signal);
    expect(beforeResult).toMatchObject({ ok: false, error: { category: "cancelled" } });
    expect(beforeBackend.commands).toHaveLength(0);

    const duringBackend = new MemoryFilesystemBackend();
    const originalStart = duringBackend.startRawCommand.bind(duringBackend);
    const during = new AbortController();
    let stages = 0;
    duringBackend.startRawCommand = async (request) => {
      if (request.command.arguments[3] === "stageWrite" && stages++ === 1) {
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        queueMicrotask(() => during.abort());
        return {
          ok: true,
          command: {
            startedAt: 1,
            events: (async function* () {
              await released;
              yield { type: "complete", exitCode: 137, finishedAt: 2 } as const;
            })(),
            async signal() { release(); },
            async dispose() { release(); },
          },
        };
      }
      return originalStart(request);
    };
    const duringBridge = new FilesystemBridge(duringBackend);
    const payload = Buffer.alloc(FILESYSTEM_TRANSFER_CHUNK_BYTES + 1, 7);
    const duringResult = await duringBridge.writeFile({
      ...metadata("during"),
      sandboxId: "sandbox",
      path: "/file",
      content: { encoding: "base64", data: payload.toString("base64") },
      mode: null,
    }, during.signal);

    expect(duringResult).toMatchObject({ ok: false, error: { category: "cancelled" } });
    expect(duringBackend.files.has("/file")).toBe(false);
    expect(duringBackend.transfers.size).toBe(0);
    expect(duringBackend.commands.some((command) => command.operation === "commitWrite")).toBe(false);
  });
});
