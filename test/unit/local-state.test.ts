import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  EmbeddedSandboxClient,
  LocalSandboxOwnershipError,
  LocalSandboxStateConflictError,
  LocalSandboxStateStore,
  resolveLocalStateRoot,
  sandboxNameDigest,
} from "../../src/runtime/index.js";
import type {
  BackendReference,
  ClientFailure,
  ClientResult,
  CreateSandboxRequest,
  CreateSandboxResult,
  DeleteSandboxResult,
  ExtendSandboxDeadlineResult,
  GetEndpointResult,
  GetSandboxResult,
  ListSandboxesResult,
  RequestMetadata,
  SandboxBackend,
  SandboxRecord,
  StartRawCommandResult,
  StopSandboxResult,
} from "../../src/runtime/index.js";
import { TEST_CAPABILITIES } from "../fixtures/runtime-capabilities.js";

const BACKEND = { backendId: "local-state-test", backendType: "memory" } as const;
const DEAD_OWNER = {
  pid: 2_147_483_647,
  processStartedAt: 1,
  processNonce: "d".repeat(64),
} as const;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "localbox-state-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function failure(
  request: RequestMetadata,
  category: ClientFailure["error"]["category"],
  code: string,
): ClientFailure {
  return {
    ok: false,
    error: {
      category,
      code,
      message: code,
      retryable: false,
      requestId: request.requestId,
      backend: BACKEND,
      details: { type: "resource", resource: "sandbox", resourceId: "sandbox" },
    },
  };
}

function sandboxRecord(name: string, status: SandboxRecord["status"] = "running"): SandboxRecord {
  const now = Date.now();
  return {
    sandboxId: name,
    name,
    status,
    persistent: true,
    bootSource: { type: "image", image: "localbox:test" },
    runtime: "node24",
    backend: BACKEND,
    createdAt: now - 1_000,
    updatedAt: now,
    statusUpdatedAt: now,
    expiresAt: now + 300_000,
    timeoutMs: 300_000,
    tags: { suite: "state" },
    ports: [3000],
    endpoints: [],
    resources: { vcpus: 1, memoryBytes: 2_147_483_648 },
    region: null,
    failoverRegions: [],
  };
}

function createRequest(
  name: string,
  requestId = `create:${name}`,
  sandboxId = name,
): CreateSandboxRequest {
  return {
    requestId,
    idempotencyKey: `key:${name}:${requestId}`,
    deadline: null,
    sandboxId,
    backend: null,
    requirements: [],
    spec: {
      name,
      bootSource: { type: "runtime", runtime: "node24" },
      source: null,
      persistent: true,
      timeoutMs: 300_000,
      environment: {},
      tags: { suite: "state" },
      ports: [3000],
      networkPolicy: "allow-all",
      resources: { vcpus: 1, memoryBytes: 2_147_483_648 },
      region: null,
      failoverRegions: [],
    },
  };
}

class MemoryBackend implements SandboxBackend {
  readonly reference = BACKEND;
  readonly capabilities = TEST_CAPABILITIES;
  readonly sandboxes: Map<string, SandboxRecord>;
  failNextCreate = false;

  constructor(sandboxes = new Map<string, SandboxRecord>()) {
    this.sandboxes = sandboxes;
  }

  async createSandbox(request: CreateSandboxRequest): Promise<ClientResult<CreateSandboxResult>> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return failure(request, "backend-failure", "TEST_CREATE_FAILED");
    }
    if ([...this.sandboxes.values()].some((sandbox) => sandbox.name === request.spec.name)) {
      return failure(request, "already-exists", "TEST_ALREADY_EXISTS");
    }
    const sandbox = { ...sandboxRecord(request.spec.name), sandboxId: request.sandboxId };
    this.sandboxes.set(request.sandboxId, sandbox);
    return { ok: true, value: { sandbox } };
  }

  async getSandbox(request: Parameters<SandboxBackend["getSandbox"]>[0]): Promise<ClientResult<GetSandboxResult>> {
    const current = this.sandboxes.get(request.sandboxId);
    if (current === undefined) return failure(request, "not-found", "TEST_NOT_FOUND");
    const sandbox = request.resume && current.status !== "running"
      ? { ...current, status: "running" as const, updatedAt: Date.now(), statusUpdatedAt: Date.now() }
      : current;
    this.sandboxes.set(request.sandboxId, sandbox);
    return { ok: true, value: { sandbox } };
  }

  async listSandboxes(): Promise<ClientResult<ListSandboxesResult>> {
    return { ok: true, value: { sandboxes: [...this.sandboxes.values()], nextCursor: null } };
  }

  async stopSandbox(request: Parameters<SandboxBackend["stopSandbox"]>[0]): Promise<ClientResult<StopSandboxResult>> {
    const current = this.sandboxes.get(request.sandboxId);
    if (current === undefined) return failure(request, "not-found", "TEST_NOT_FOUND");
    const sandbox = { ...current, status: "stopped" as const, updatedAt: Date.now(), statusUpdatedAt: Date.now() };
    this.sandboxes.set(request.sandboxId, sandbox);
    return { ok: true, value: { sandbox } };
  }

  async deleteSandbox(request: Parameters<SandboxBackend["deleteSandbox"]>[0]): Promise<ClientResult<DeleteSandboxResult>> {
    if (!this.sandboxes.delete(request.sandboxId)) return failure(request, "not-found", "TEST_NOT_FOUND");
    return { ok: true, value: { sandboxId: request.sandboxId, deletedAt: Date.now() } };
  }

  async extendSandboxDeadline(
    request: Parameters<SandboxBackend["extendSandboxDeadline"]>[0],
  ): Promise<ClientResult<ExtendSandboxDeadlineResult>> {
    const current = this.sandboxes.get(request.sandboxId);
    if (current === undefined) return failure(request, "not-found", "TEST_NOT_FOUND");
    const sandbox = {
      ...current,
      expiresAt: (current.expiresAt ?? Date.now()) + request.additionalMilliseconds,
      updatedAt: Date.now(),
    };
    this.sandboxes.set(request.sandboxId, sandbox);
    return { ok: true, value: { sandbox } };
  }

  startRawCommand(request: Parameters<SandboxBackend["startRawCommand"]>[0]): Promise<StartRawCommandResult> {
    return Promise.resolve(failure(request, "not-found", "TEST_NOT_FOUND"));
  }

  getEndpoint(request: Parameters<SandboxBackend["getEndpoint"]>[0]): Promise<ClientResult<GetEndpointResult>> {
    return Promise.resolve(failure(request, "not-found", "TEST_NOT_FOUND"));
  }
}

async function childResult(moduleUrl: string, stateRoot: string, barrier: string): Promise<string> {
  const source = `
    import { existsSync } from "node:fs";
    import { LocalSandboxStateConflictError, LocalSandboxStateStore } from ${JSON.stringify(moduleUrl)};
    const [stateRoot, barrier] = process.argv.slice(1);
    while (!existsSync(barrier)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const store = new LocalSandboxStateStore({ root: stateRoot });
    try {
      await store.acquire("cross-process", { backendId: "child", backendType: "memory" });
      process.stdout.write("won");
    } catch (error) {
      if (!(error instanceof LocalSandboxStateConflictError)) throw error;
      process.stdout.write("lost");
    }
  `;
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, stateRoot, barrier], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  child.once("error", reject);
  child.once("close", (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(`Claim child exited ${code}: ${stderr}`));
  });
  return promise;
}

describe("local state root", () => {
  test("uses an absolute XDG_STATE_HOME and ignores a relative value", () => {
    expect(resolveLocalStateRoot({
      environment: { XDG_STATE_HOME: "/state" },
      homedir: "/home/developer",
    })).toBe("/state/localbox");
    expect(resolveLocalStateRoot({
      root: "/explicit/localbox",
      environment: { XDG_STATE_HOME: "/ignored" },
      homedir: "/home/developer",
    })).toBe("/explicit/localbox");
    expect(resolveLocalStateRoot({
      environment: { XDG_STATE_HOME: "relative/state" },
      homedir: "/home/developer",
    })).toBe("/home/developer/.local/state/localbox");
    expect(resolveLocalStateRoot({ environment: {}, homedir: "/home/developer" }))
      .toBe("/home/developer/.local/state/localbox");
    expect(() => resolveLocalStateRoot({ root: "relative" })).toThrow(/absolute/);
  });
});

describe("LocalSandboxStateStore", () => {
  test("uses safe digests and private directory and file permissions", async () => {
    const name = "../../sensitive/name with spaces";
    const store = new LocalSandboxStateStore({ root });
    const claim = await store.acquire(name, BACKEND);
    await store.commit(claim, sandboxRecord(name));

    expect(claim.digest).toBe(sandboxNameDigest(name));
    expect(claim.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(claim.digest).not.toContain(name);
    const claimDirectory = join(root, "sandboxes", claim.digest);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "sandboxes"))).mode & 0o777).toBe(0o700);
    expect((await stat(claimDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(claimDirectory, "state.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(claimDirectory, "state.json"), "utf8")).toContain(name);
  });

  test("allows exactly one same-process claimant", async () => {
    const first = new LocalSandboxStateStore({ root });
    const second = new LocalSandboxStateStore({ root });
    const results = await Promise.allSettled([
      first.acquire("one-name", BACKEND),
      second.acquire("one-name", BACKEND),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(LocalSandboxStateConflictError) });
  });

  test("allows exactly one real child process to claim a name", async () => {
    const source = await readFile(new URL("../../src/runtime/local-state.ts", import.meta.url), "utf8");
    const output = transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText;
    const modulePath = join(root, "local-state.mjs");
    const stateRoot = join(root, "child-state");
    const barrier = join(root, "start");
    await writeFile(modulePath, output, { mode: 0o600 });
    const moduleUrl = pathToFileURL(modulePath).href;
    const first = childResult(moduleUrl, stateRoot, barrier);
    const second = childResult(moduleUrl, stateRoot, barrier);
    await writeFile(barrier, "go", { mode: 0o600 });
    expect((await Promise.all([first, second])).sort()).toEqual(["lost", "won"]);
  });

  test("fails closed when a token does not match", async () => {
    const store = new LocalSandboxStateStore({ root });
    const claim = await store.acquire("token", BACKEND);
    await expect(store.release({ ...claim, token: "0".repeat(64) }))
      .rejects.toBeInstanceOf(LocalSandboxOwnershipError);
    expect(await store.read("token")).toMatchObject({ kind: "claim", token: claim.token });
  });

  test("atomically replaces active records without exposing partial JSON", async () => {
    const store = new LocalSandboxStateStore({ root });
    const claim = await store.acquire("atomic", BACKEND);
    await store.commit(claim, sandboxRecord("atomic", "running"));
    const update = store.update(claim, sandboxRecord("atomic", "stopped"));
    const reads = await Promise.all(Array.from({ length: 20 }, () => store.read("atomic")));
    await update;
    for (const record of reads) {
      expect(record).toMatchObject({ kind: "active", sandbox: { name: "atomic" } });
      if (record?.kind === "active") expect(["running", "stopped"]).toContain(record.sandbox.status);
    }
    expect(await store.read("atomic")).toMatchObject({ kind: "active", sandbox: { status: "stopped" } });
  });

  test("ignores interrupted temporary files and repairs corrupt canonical state", async () => {
    const store = new LocalSandboxStateStore({ root });
    const claim = await store.acquire("recovery", BACKEND);
    await store.commit(claim, sandboxRecord("recovery"));
    const claimDirectory = join(root, "sandboxes", claim.digest);
    const temporary = join(claimDirectory, `.state.${"a".repeat(64)}.tmp`);
    await writeFile(temporary, "{partial", { mode: 0o600 });

    expect(await store.read("recovery")).toMatchObject({ kind: "active" });
    await expect(access(temporary)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(join(claimDirectory, "state.json"), "{corrupt", { mode: 0o600 });
    expect(await store.inspect("recovery")).toMatchObject({ status: "corrupt" });
    await store.repair("recovery", BACKEND, sandboxRecord("recovery", "stopped"));
    expect(await store.read("recovery")).toMatchObject({
      kind: "active",
      sandbox: { status: "stopped" },
    });
  });

  test("reclaims an interrupted empty ownership directory explicitly", async () => {
    const store = new LocalSandboxStateStore({ root });
    await store.inspect("initialize");
    const directory = join(root, "sandboxes", sandboxNameDigest("empty"));
    await mkdir(directory, { mode: 0o700 });
    const old = new Date(Date.now() - 60_000);
    await utimes(directory, old, old);
    expect(await store.inspect("empty")).toMatchObject({ status: "empty" });
    await store.reclaimInvalid("empty");
    expect(await store.inspect("empty")).toEqual({ status: "missing" });
  });
});

describe("EmbeddedSandboxClient durable ownership", () => {
  test("releases only its claim after failed creation", async () => {
    const backend = new MemoryBackend();
    backend.failNextCreate = true;
    const client = new EmbeddedSandboxClient(backend, { stateRoot: root });
    expect(await client.createSandbox(createRequest("failed"))).toMatchObject({
      ok: false,
      error: { code: "TEST_CREATE_FAILED" },
    });
    const replacement = await new LocalSandboxStateStore({ root }).acquire("failed", BACKEND);
    expect(replacement.name).toBe("failed");
  });

  test("refreshes lifecycle metadata and releases ownership after deletion", async () => {
    const backend = new MemoryBackend();
    const client = new EmbeddedSandboxClient(backend, { stateRoot: root });
    const store = new LocalSandboxStateStore({ root });
    expect((await client.createSandbox(createRequest("lifecycle"))).ok).toBe(true);
    expect(await store.read("lifecycle")).toMatchObject({ kind: "active", sandbox: { status: "running" } });

    await client.stopSandbox({
      requestId: "stop",
      idempotencyKey: "stop-key",
      deadline: null,
      sandboxId: "lifecycle",
    });
    expect(await store.read("lifecycle")).toMatchObject({ sandbox: { status: "stopped" } });

    await client.getSandbox({
      requestId: "resume",
      idempotencyKey: "resume-key",
      deadline: null,
      sandboxId: "lifecycle",
      resume: true,
    });
    expect(await store.read("lifecycle")).toMatchObject({ sandbox: { status: "running" } });

    const before = await store.read("lifecycle");
    await client.extendSandboxDeadline({
      requestId: "extend",
      idempotencyKey: "extend-key",
      deadline: null,
      sandboxId: "lifecycle",
      additionalMilliseconds: 10_000,
    });
    const after = await store.read("lifecycle");
    expect(after?.kind === "active" && before?.kind === "active" && after.sandbox.expiresAt! > before.sandbox.expiresAt!).toBe(true);

    await client.deleteSandbox({
      requestId: "delete",
      idempotencyKey: "delete-key",
      deadline: null,
      sandboxId: "lifecycle",
    });
    expect(await store.read("lifecycle")).toBeNull();
  });

  test("releases name ownership when the backend sandbox ID differs from its name", async () => {
    const backend = new MemoryBackend();
    const client = new EmbeddedSandboxClient(backend, { stateRoot: root });
    expect((await client.createSandbox(createRequest(
      "display-name",
      "create-opaque",
      "opaque-backend-id",
    ))).ok).toBe(true);
    await client.deleteSandbox({
      requestId: "delete-opaque",
      idempotencyKey: "delete-opaque-key",
      deadline: null,
      sandboxId: "opaque-backend-id",
    });
    expect(await new LocalSandboxStateStore({ root }).read("display-name")).toBeNull();
  });

  test("reclaims a dead creator only after the backend confirms absence", async () => {
    const abandoned = new LocalSandboxStateStore({ root, owner: DEAD_OWNER });
    await abandoned.acquire("stale", BACKEND);
    const backend = new MemoryBackend();
    const client = new EmbeddedSandboxClient(backend, { stateRoot: root });
    expect((await client.createSandbox(createRequest("stale"))).ok).toBe(true);
    expect(await new LocalSandboxStateStore({ root }).read("stale")).toMatchObject({
      kind: "active",
      sandbox: { name: "stale" },
    });
  });

  test("preserves and repairs a live pre-metadata resource on colliding create", async () => {
    const live = sandboxRecord("legacy");
    const backend = new MemoryBackend(new Map([[live.sandboxId, live]]));
    const client = new EmbeddedSandboxClient(backend, { stateRoot: root });
    const result = await client.createSandbox(createRequest("legacy"));
    expect(result).toMatchObject({ ok: false, error: { category: "already-exists" } });
    expect(await new LocalSandboxStateStore({ root }).read("legacy")).toMatchObject({
      kind: "active",
      sandbox: { sandboxId: "legacy", status: "running" },
    });

    const digest = sandboxNameDigest("corrupt-live");
    const corruptLive = sandboxRecord("corrupt-live");
    backend.sandboxes.set("corrupt-live", corruptLive);
    const corruptDirectory = join(root, "sandboxes", digest);
    await mkdir(corruptDirectory, { mode: 0o700 });
    await writeFile(join(corruptDirectory, "state.json"), "not-json", { mode: 0o600 });
    const conflict = await client.createSandbox(createRequest("corrupt-live"));
    expect(conflict).toMatchObject({ ok: false, error: { category: "already-exists" } });
    expect(await new LocalSandboxStateStore({ root }).read("corrupt-live")).toMatchObject({
      kind: "active",
      sandbox: { sandboxId: "corrupt-live" },
    });
  });

  test("discovers and adopts a live resource without metadata through get and list", async () => {
    const live = sandboxRecord("discoverable");
    const backend = new MemoryBackend(new Map([[live.sandboxId, live]]));
    const client = new EmbeddedSandboxClient(backend, { stateRoot: root });
    expect((await client.getSandbox({
      requestId: "get-live",
      idempotencyKey: "get-live-key",
      deadline: null,
      sandboxId: "discoverable",
      resume: false,
    })).ok).toBe(true);
    expect((await client.listSandboxes({
      requestId: "list-live",
      deadline: null,
      namePrefix: null,
      tags: {},
      statuses: [],
      sortBy: "name",
      sortOrder: "asc",
      limit: 100,
      cursor: null,
    })).ok).toBe(true);
    expect(await new LocalSandboxStateStore({ root }).read("discoverable")).toMatchObject({
      kind: "active",
      sandbox: { sandboxId: "discoverable" },
    });
  });
});
