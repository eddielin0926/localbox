import { Writable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import type {
  ClientFailure,
  ClientResult,
  JsonObject,
  ProcessRecord,
  RequestMetadata,
  SandboxClient,
  SandboxRecord,
} from "../../src/runtime/index.js";
import { setSandboxClientFactory } from "../../src/vercel/client.js";
import {
  LocalboxError,
  PortNotExposedError,
  Sandbox,
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
} from "../../src/vercel/index.js";

const BACKEND = { backendId: "provider-boundary", backendType: "test" } as const;

function success<T extends JsonObject>(value: T): ClientResult<T> {
  return { ok: true, value };
}

function failure(
  request: RequestMetadata,
  category: ClientFailure["error"]["category"],
  code: string,
  resource: "sandbox" | "process" | "endpoint",
  resourceId: string,
): ClientFailure {
  return {
    ok: false,
    error: {
      category,
      code,
      message: `${resource} ${resourceId} failed`,
      retryable: false,
      requestId: request.requestId,
      backend: BACKEND,
      details: { type: "resource", resource, resourceId },
    },
  };
}

class BoundaryClient implements SandboxClient {
  readonly sandboxes = new Map<string, SandboxRecord>();
  readonly files = new Map<string, Buffer>();
  readonly processes = new Map<string, {
    record: ProcessRecord;
    chunks: readonly { stream: "stdout" | "stderr"; data: string }[];
    exitCode: number;
  }>();
  readonly operations: string[] = [];
  readonly signals: string[] = [];
  #processSequence = 0;

  async createSandbox(request: Parameters<SandboxClient["createSandbox"]>[0]) {
    this.operations.push("createSandbox");
    if (this.sandboxes.has(request.sandboxId)) {
      return failure(request, "already-exists", "LOCALBOX_SANDBOX_ALREADY_EXISTS", "sandbox", request.sandboxId);
    }
    const now = 1_800_000_000_000;
    const sandbox: SandboxRecord = {
      sandboxId: request.sandboxId,
      name: request.spec.name,
      status: "running",
      persistent: request.spec.persistent,
      bootSource: request.spec.bootSource.type === "runtime"
        ? { type: "image", image: `resolved:${request.spec.bootSource.runtime}` }
        : request.spec.bootSource,
      runtime: request.spec.bootSource.type === "runtime" ? request.spec.bootSource.runtime : null,
      backend: BACKEND,
      createdAt: now,
      updatedAt: now,
      statusUpdatedAt: now,
      expiresAt: now + request.spec.timeoutMs,
      timeoutMs: request.spec.timeoutMs,
      tags: request.spec.tags,
      ports: request.spec.ports,
      endpoints: request.spec.ports.map((port) => ({
        endpointId: `${request.sandboxId}:${port}`,
        sandboxId: request.sandboxId,
        port,
        protocol: "http" as const,
        url: `http://127.0.0.1:${40_000 + port}`,
        visibility: "loopback" as const,
        backend: BACKEND,
      })),
      resources: request.spec.resources,
      region: request.spec.region,
      failoverRegions: request.spec.failoverRegions,
    };
    this.sandboxes.set(request.sandboxId, sandbox);
    return success({ sandbox });
  }

  async getSandbox(request: Parameters<SandboxClient["getSandbox"]>[0]) {
    this.operations.push(request.resume ? "resumeSandbox" : "getSandbox");
    const sandbox = this.sandboxes.get(request.sandboxId);
    if (sandbox === undefined) {
      return failure(request, "not-found", "LOCALBOX_SANDBOX_NOT_FOUND", "sandbox", request.sandboxId);
    }
    if (request.resume && sandbox.status !== "running") {
      const resumed = { ...sandbox, status: "running" as const };
      this.sandboxes.set(request.sandboxId, resumed);
      return success({ sandbox: resumed });
    }
    return success({ sandbox });
  }

  async listSandboxes(request: Parameters<SandboxClient["listSandboxes"]>[0]) {
    this.operations.push("listSandboxes");
    const sandboxes = [...this.sandboxes.values()]
      .filter((sandbox) => request.namePrefix === null || sandbox.name.startsWith(request.namePrefix))
      .slice(0, request.limit);
    return success({ sandboxes, nextCursor: null });
  }

  async stopSandbox(request: Parameters<SandboxClient["stopSandbox"]>[0]) {
    this.operations.push("stopSandbox");
    const sandbox = this.sandboxes.get(request.sandboxId);
    if (sandbox === undefined) {
      return failure(request, "not-found", "LOCALBOX_SANDBOX_NOT_FOUND", "sandbox", request.sandboxId);
    }
    const stopped = { ...sandbox, status: "stopped" as const, endpoints: [] };
    this.sandboxes.set(request.sandboxId, stopped);
    return success({ sandbox: stopped });
  }

  async deleteSandbox(request: Parameters<SandboxClient["deleteSandbox"]>[0]) {
    this.operations.push("deleteSandbox");
    if (!this.sandboxes.delete(request.sandboxId)) {
      return failure(request, "not-found", "LOCALBOX_SANDBOX_NOT_FOUND", "sandbox", request.sandboxId);
    }
    return success({ sandboxId: request.sandboxId, deletedAt: 1_800_000_000_001 });
  }

  async extendSandboxDeadline(request: Parameters<SandboxClient["extendSandboxDeadline"]>[0]) {
    this.operations.push("extendSandboxDeadline");
    const sandbox = this.sandboxes.get(request.sandboxId);
    if (sandbox === undefined) {
      return failure(request, "not-found", "LOCALBOX_SANDBOX_NOT_FOUND", "sandbox", request.sandboxId);
    }
    const extended = {
      ...sandbox,
      expiresAt: (sandbox.expiresAt ?? 0) + request.additionalMilliseconds,
    };
    this.sandboxes.set(request.sandboxId, extended);
    return success({ sandbox: extended });
  }

  async startCommand(request: Parameters<SandboxClient["startCommand"]>[0]) {
    this.operations.push("startCommand");
    if (request.command.command === "boundary-failure") {
      return failure(request, "backend-failure", "BOUNDARY_COMMAND_FAILED", "process", "none");
    }
    this.#processSequence += 1;
    const processId = `process-${this.#processSequence}`;
    const record: ProcessRecord = {
      sandboxId: request.sandboxId,
      processId,
      status: "running",
      cwd: request.command.cwd,
      startedAt: 100,
      finishedAt: null,
      exitCode: null,
    };
    this.processes.set(processId, {
      record,
      chunks: [
        { stream: "stdout", data: "client stdout" },
        { stream: "stderr", data: "client stderr" },
      ],
      exitCode: 7,
    });
    return success({ process: record });
  }

  async waitForCommand(request: Parameters<SandboxClient["waitForCommand"]>[0]) {
    this.operations.push("waitForCommand");
    const process = this.processes.get(request.processId);
    if (process === undefined) {
      return failure(request, "not-found", "LOCALBOX_PROCESS_NOT_FOUND", "process", request.processId);
    }
    const record = {
      ...process.record,
      status: "exited" as const,
      finishedAt: 125,
      exitCode: process.exitCode,
    };
    return success({ result: { process: record, durationMs: 25, exitCode: process.exitCode } });
  }

  async signalProcess(request: Parameters<SandboxClient["signalProcess"]>[0]) {
    this.operations.push("signalProcess");
    this.signals.push(String(request.signal));
    const process = this.processes.get(request.processId);
    if (process === undefined) {
      return failure(request, "not-found", "LOCALBOX_PROCESS_NOT_FOUND", "process", request.processId);
    }
    return success({ process: process.record });
  }

  async readCommandOutput(request: Parameters<SandboxClient["readCommandOutput"]>[0]) {
    this.operations.push("readCommandOutput");
    const process = this.processes.get(request.processId);
    if (process === undefined) {
      return failure(request, "not-found", "LOCALBOX_PROCESS_NOT_FOUND", "process", request.processId);
    }
    return success({
      chunks: request.cursor === null ? process.chunks : [],
      nextCursor: null,
      complete: true,
      truncated: false,
    });
  }

  async readFile(request: Parameters<SandboxClient["readFile"]>[0]) {
    this.operations.push("readFile");
    const contents = this.files.get(`${request.sandboxId}:${request.path}`);
    if (contents === undefined) {
      return {
        ok: false as const,
        error: {
          category: "not-found" as const,
          code: "LOCALBOX_FILE_NOT_FOUND",
          message: "file not found",
          retryable: false,
          requestId: request.requestId,
          backend: BACKEND,
          details: {
            type: "file" as const,
            code: "ENOENT",
            syscall: "open",
            path: request.path,
          },
        },
      };
    }
    const page = contents.subarray(request.offset, request.offset + request.limitBytes);
    return success({
      path: request.path,
      content: { encoding: request.encoding, data: page.toString(request.encoding) },
      bytesRead: page.length,
      nextOffset: request.offset + page.length,
      endOfFile: request.offset + page.length >= contents.length,
    });
  }

  async writeFile(request: Parameters<SandboxClient["writeFile"]>[0]) {
    this.operations.push("writeFile");
    const contents = Buffer.from(request.content.data, request.content.encoding);
    this.files.set(`${request.sandboxId}:${request.path}`, contents);
    return success({ path: request.path, bytesWritten: contents.length });
  }

  async makeDirectory(request: Parameters<SandboxClient["makeDirectory"]>[0]) {
    this.operations.push("makeDirectory");
    return success({ path: request.path, created: true });
  }

  async runFilesystemOperation(request: Parameters<SandboxClient["runFilesystemOperation"]>[0]) {
    this.operations.push(`filesystem:${request.operation}`);
    return success({ value: null });
  }

  async getEndpoint(request: Parameters<SandboxClient["getEndpoint"]>[0]) {
    this.operations.push("getEndpoint");
    const sandbox = this.sandboxes.get(request.sandboxId);
    const endpoint = sandbox?.endpoints.find((candidate) => candidate.port === request.port);
    if (endpoint === undefined) {
      return failure(
        request,
        "not-found",
        "LOCALBOX_ENDPOINT_NOT_FOUND",
        "endpoint",
        `${request.sandboxId}:${request.port}`,
      );
    }
    return success({ endpoint });
  }
}

afterEach(() => {
  setSandboxClientFactory(null);
});

describe("Vercel compatibility through SandboxClient", () => {
  test("lifecycle, callbacks, persistence, listing, and errors stay behind the client boundary", async () => {
    const client = new BoundaryClient();
    setSandboxClientFactory(() => client);
    let created = 0;
    let resumed = 0;
    const sandbox = await Sandbox.getOrCreate({
      name: "boundary-lifecycle",
      runtime: "node24",
      onCreate: async (createdSandbox) => {
        created += 1;
        await createdSandbox.fs.writeFile("state.bin", Buffer.from([1, 2, 3]));
      },
    });
    expect(created).toBe(1);
    expect(sandbox.image).toBe("resolved:node24");
    await sandbox.stop();

    const resumedSandbox = await Sandbox.getOrCreate({
      name: sandbox.name,
      resume: true,
      onResume: async () => { resumed += 1; },
    });
    expect(resumed).toBe(1);
    expect(await resumedSandbox.fs.readFile("state.bin")).toEqual(Buffer.from([1, 2, 3]));
    expect((await Sandbox.list({ namePrefix: "boundary-" })).sandboxes).toHaveLength(1);

    await expect(Sandbox.create({ name: sandbox.name })).rejects.toBeInstanceOf(
      SandboxAlreadyExistsError,
    );
    await resumedSandbox.delete();
    await expect(Sandbox.get({ name: sandbox.name })).rejects.toBeInstanceOf(
      SandboxNotFoundError,
    );
    expect(client.operations).toEqual(expect.arrayContaining([
      "createSandbox",
      "stopSandbox",
      "resumeSandbox",
      "listSandboxes",
      "deleteSandbox",
    ]));
  });

  test("commands, callback streams, files, endpoints, timeouts, aborts, and failures are observable client values", async () => {
    const client = new BoundaryClient();
    setSandboxClientFactory(() => client);
    const sandbox = await Sandbox.create({
      name: "boundary-behavior",
      ports: [3000],
      timeout: 2_000,
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const command = await sandbox.runCommand({
      cmd: "node",
      stdout: new Writable({ write(chunk, _encoding, callback) { stdout.push(String(chunk)); callback(); } }),
      stderr: new Writable({ write(chunk, _encoding, callback) { stderr.push(String(chunk)); callback(); } }),
    });
    expect(command.exitCode).toBe(7);
    expect(await command.stdout()).toBe("client stdout");
    expect(await command.stderr()).toBe("client stderr");
    expect(stdout).toEqual(["client stdout"]);
    expect(stderr).toEqual(["client stderr"]);
    const replayed: string[] = [];
    for await (const chunk of command.logs()) replayed.push(chunk.data);
    expect(replayed.join("|")).toBe("client stdout|client stderr");

    await sandbox.fs.mkdir("data", { recursive: true });
    await sandbox.fs.writeFile("data/blob.bin", Buffer.from([0, 255, 1]));
    expect(await sandbox.fs.readFile("data/blob.bin")).toEqual(Buffer.from([0, 255, 1]));
    const stream = await sandbox.readFile({ path: "data/blob.bin" });
    const chunks: Buffer[] = [];
    if (stream !== null) for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 1]));

    expect(sandbox.domain(3000)).toBe("http://127.0.0.1:43000");
    expect(() => sandbox.domain(3001)).toThrow(PortNotExposedError);
    const initialExpiry = sandbox.expiresAt?.getTime() ?? 0;
    await sandbox.extendTimeout(500);
    expect(sandbox.expiresAt?.getTime()).toBe(initialExpiry + 500);

    const aborted = new AbortController();
    aborted.abort();
    await expect(sandbox.runCommand({ cmd: "node", signal: aborted.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(sandbox.runCommand("boundary-failure")).rejects.toBeInstanceOf(LocalboxError);
    expect(client.operations).toEqual(expect.arrayContaining([
      "startCommand",
      "readCommandOutput",
      "waitForCommand",
      "makeDirectory",
      "writeFile",
      "readFile",
      "extendSandboxDeadline",
    ]));
  });
});
