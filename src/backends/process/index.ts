import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { FILESYSTEM_TRANSFER_CHUNK_BYTES } from "../../runtime/filesystem-bridge.js";
import { negotiateSandboxRequirements } from "../../runtime/capabilities.js";
import type {
  BackendReference,
  ClientFailure,
  ClientResult,
  CreateSandboxRequest,
  CreateSandboxResult,
  DeleteSandboxRequest,
  DeleteSandboxResult,
  ExtendSandboxDeadlineRequest,
  ExtendSandboxDeadlineResult,
  GetEndpointRequest,
  GetEndpointResult,
  GetSandboxRequest,
  GetSandboxResult,
  JsonObject,
  ListSandboxesRequest,
  ListSandboxesResult,
  ProcessSignal,
  RawCommand,
  RawCommandEvent,
  RequestMetadata,
  SandboxBackend,
  SandboxCapabilities,
  SandboxRecord,
  StartRawCommandRequest,
  StartRawCommandResult,
  StopSandboxRequest,
  StopSandboxResult,
} from "../../runtime/index.js";
import { PROCESS_SUPERVISOR_PROGRAM } from "./supervisor.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DESCRIPTOR_FILE = "sandbox.json";
const DESCRIPTOR_SCHEMA_VERSION = 1;
const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const LOCK_STALE_GRACE_MS = 5_000;
const LOCK_POLL_MS = 20;
const SUPERVISOR_START_TIMEOUT_MS = 5_000;
const SUPERVISOR_STOP_TIMEOUT_MS = 2_500;
const VIRTUAL_WORKSPACE = "/vercel/sandbox";
const PROCESS_RUNTIME = "host";

const PROCESS_CAPABILITIES = Object.freeze({
  schemaVersion: 1,
  operations: {
    "command.start": {
      support: "native",
      constraints: null,
      diagnostic: "Commands execute directly as trusted host processes with argv boundaries preserved; no container, namespace, or VM boundary is provided.",
    },
    "command.detached": {
      support: "emulated",
      constraints: null,
      diagnostic: "EmbeddedSandboxClient retains detached command state while a Node supervisor owns process-group cleanup; commands are not recoverable after Localbox restarts.",
    },
    "endpoint.expose": {
      support: "unsupported",
      constraints: { protocols: [], visibilities: [] },
      diagnostic: "Host processes share host networking without namespace isolation or port remapping; endpoint exposure is not represented by this backend.",
    },
    "filesystem.mkdir": {
      support: "emulated",
      constraints: null,
      diagnostic: "The neutral filesystem bridge maps /vercel/sandbox into the backend's private host workspace and rejects escapes.",
    },
    "filesystem.read": {
      support: "emulated",
      constraints: null,
      diagnostic: "The neutral filesystem bridge performs bounded reads inside the private host workspace and rejects symlink escapes.",
    },
    "filesystem.write": {
      support: "emulated",
      constraints: null,
      diagnostic: "The neutral filesystem bridge stages writes inside the private host workspace and rejects symlink escapes.",
    },
    "source.git": {
      support: "unsupported",
      constraints: null,
      diagnostic: "The process backend does not clone Git sources; create a no-source host workspace instead.",
    },
    "source.tarball": {
      support: "unsupported",
      constraints: null,
      diagnostic: "The process backend does not download or extract tarballs; create a no-source host workspace instead.",
    },
    "raw-command.input": {
      support: "native",
      constraints: { maxBytes: FILESYSTEM_TRANSFER_CHUNK_BYTES },
      diagnostic: `The host supervisor accepts one bounded stdin payload up to ${FILESYSTEM_TRANSFER_CHUNK_BYTES} bytes.`,
    },
    "raw-command.managed-filesystem-owner": {
      support: "unsupported",
      constraints: { managedImagesOnly: true },
      diagnostic: "Host commands never receive managed root privileges; ownership changes require an isolated managed-image backend.",
    },
  },
  isolation: {
    support: "partial",
    constraints: { level: "process", tenancies: ["trusted"] },
    diagnostic: "A host process and private directory are bookkeeping boundaries only, not security isolation; hostile or multi-tenant workloads are prohibited.",
  },
  artifacts: {
    support: "partial",
    constraints: { kinds: ["runtime"] },
    diagnostic: "Only the runtime selector 'host' is accepted; OCI images and source, directory, disk-image, and snapshot artifacts are rejected.",
  },
  persistence: {
    support: "native",
    constraints: { scopes: ["sandbox-lifecycle", "backend-restart"] },
    diagnostic: "Workspace contents and sandbox lifecycle descriptors persist below the configured backend root across stop/resume and backend reconstruction.",
  },
  recovery: {
    support: "partial",
    constraints: { scopes: ["sandbox"] },
    diagnostic: "Sandbox metadata and workspace contents are recoverable; running commands, output, waiters, and idempotency state are intentionally not recovered.",
  },
  networking: {
    support: "partial",
    constraints: { modes: ["allow-all"], portExposure: [], customPolicies: false },
    diagnostic: "Commands use unrestricted host networking; deny-all, custom policy, network namespaces, and endpoint remapping are unavailable.",
  },
  resources: {
    support: "unsupported",
    constraints: {
      cpu: { minimumVcpus: 1, maximumVcpus: null, stepVcpus: 1 },
      memory: { minimumBytes: 1, maximumBytes: null, stepBytes: 1 },
      memoryBytesPerVcpu: null,
      enforcement: "best-effort",
    },
    diagnostic: "The process backend does not enforce CPU or memory limits; use a container, namespace, or VM backend when resource enforcement is required.",
  },
  terminals: {
    support: "unsupported",
    constraints: { modes: [] },
    diagnostic: "The process backend exposes non-interactive exec only and does not allocate a PTY.",
  },
  snapshots: {
    support: "unsupported",
    constraints: { operations: [] },
    diagnostic: "The process backend does not create, restore, or clone snapshots.",
  },
} as const satisfies SandboxCapabilities);

interface ProcessDescriptor {
  readonly schemaVersion: 1;
  readonly backendId: string;
  readonly sandboxId: string;
  readonly name: string;
  readonly status: "running" | "stopped";
  readonly persistent: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly statusUpdatedAt: number;
  readonly expiresAt: number | null;
  readonly timeoutMs: number;
  readonly tags: Readonly<Record<string, string>>;
}

interface ProcessBackendOptions {
  /** Absolute directory containing private process-backend instances. */
  readonly root: string;
  /** Stable identity used to allow multiple independent instances below one root. */
  readonly instanceId: string;
}

interface SupervisorMessage {
  readonly type: string;
  readonly pid?: number;
  readonly stream?: "stdout" | "stderr";
  readonly data?: string;
  readonly code?: string;
  readonly message?: string;
  readonly exitCode?: number;
  readonly finishedAt?: number;
}

class BackendOperationError extends Error {
  constructor(
    readonly category: ClientFailure["error"]["category"],
    readonly code: string,
    message: string,
    readonly details: ClientFailure["error"]["details"],
    readonly retryable = false,
  ) {
    super(message);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

class RawEventQueue implements AsyncIterable<RawCommandEvent> {
  readonly #events: RawCommandEvent[] = [];
  readonly #waiters: Deferred<IteratorResult<RawCommandEvent>>[] = [];
  #closed = false;

  push(event: RawCommandEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#events.push(event);
    else waiter.resolve({ done: false, value: event });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<RawCommandEvent> {
    return {
      next: () => {
        const event = this.#events.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        const waiter = Promise.withResolvers<IteratorResult<RawCommandEvent>>();
        this.#waiters.push(waiter);
        return waiter.promise;
      },
    };
  }
}

class ProcessRawCommand implements RawCommand {
  readonly startedAt = Date.now();
  readonly events: AsyncIterable<RawCommandEvent>;
  readonly #child: ChildProcess;
  readonly #queue = new RawEventQueue();
  readonly #target = Promise.withResolvers<number>();
  readonly #supervisorReady = Promise.withResolvers<void>();
  readonly #completion = Promise.withResolvers<void>();
  readonly #stdoutDecoder = new StringDecoder("utf8");
  readonly #stderrDecoder = new StringDecoder("utf8");
  readonly #onDisposed: () => void;
  #targetPid: number | null = null;
  #settled = false;
  #disposed: Promise<void> | undefined;

  constructor(
    command: StartRawCommandRequest["command"],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    input: Buffer | null,
    onDisposed: () => void,
  ) {
    this.events = this.#queue;
    this.#onDisposed = onDisposed;
    this.#child = spawn(
      process.execPath,
      ["--input-type=module", "-e", PROCESS_SUPERVISOR_PROGRAM, String(process.pid)],
      {
        env: process.env,
        shell: false,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    this.#child.on("message", (value: unknown) => this.#onMessage(value));
    this.#child.once("error", (error) => {
      this.#supervisorReady.reject(error);
      this.#target.reject(error);
      this.#backendFailure("LOCALBOX_PROCESS_SUPERVISOR_FAILURE", "The host process supervisor failed to start.", true);
    });
    this.#child.once("exit", () => {
      if (!this.#settled) {
        this.#backendFailure("LOCALBOX_PROCESS_SUPERVISOR_EXITED", "The host process supervisor exited before command completion.", true);
      }
      this.#completion.resolve();
    });
    void this.#target.promise.catch(() => undefined);
    this.#supervisorReady.promise.then(() => {
      this.#child.send({
        type: "start",
        command: {
          command: command.command,
          arguments: [...command.arguments],
          cwd,
          environment,
        },
        input: input === null ? null : input.toString("base64"),
      }, (error) => {
        if (error !== null) {
          this.#backendFailure(
            "LOCALBOX_PROCESS_SUPERVISOR_FAILURE",
            "The host process supervisor could not receive its command.",
            true,
          );
        }
      });
    }).catch(() => undefined);
  }

  async waitUntilStarted(signal?: AbortSignal): Promise<void> {
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => timeout.reject(new Error("The host process supervisor did not become ready.")), SUPERVISOR_START_TIMEOUT_MS);
    timer.unref();
    const aborted = Promise.withResolvers<never>();
    const abort = (): void => aborted.reject(new DOMException("The operation was cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await Promise.race([this.#supervisorReady.promise, timeout.promise, aborted.promise]);
      await Promise.race([
        this.#target.promise,
        this.#completion.promise,
        timeout.promise,
        aborted.promise,
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async signal(signal: ProcessSignal, abortSignal?: AbortSignal): Promise<void> {
    if (this.#settled) return;
    const aborted = Promise.withResolvers<never>();
    const abort = (): void => aborted.reject(new DOMException("Signal delivery was cancelled.", "AbortError"));
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) abort();
    try {
      const pid = await Promise.race([this.#target.promise, this.#completion.promise.then(() => null), aborted.promise]);
      if (pid === null || this.#settled) return;
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (!isErrno(error, "ESRCH")) throw error;
      }
    } finally {
      abortSignal?.removeEventListener("abort", abort);
    }
  }

  dispose(): Promise<void> {
    this.#disposed ??= this.#dispose();
    return this.#disposed;
  }

  async #dispose(): Promise<void> {
    if (!this.#settled) {
      if (this.#child.connected) this.#child.send({ type: "terminate" });
      if (this.#targetPid !== null) {
        try {
          process.kill(-this.#targetPid, "SIGTERM");
        } catch (error) {
          if (!isErrno(error, "ESRCH")) throw error;
        }
      }
      const stopped = await Promise.race([
        this.#completion.promise.then(() => true),
        delay(SUPERVISOR_STOP_TIMEOUT_MS, false, { ref: false }),
      ]);
      if (!stopped && this.#targetPid !== null) {
        try {
          process.kill(-this.#targetPid, "SIGKILL");
        } catch (error) {
          if (!isErrno(error, "ESRCH")) throw error;
        }
      }
      if (!this.#child.killed) this.#child.kill("SIGKILL");
    }
    this.#queue.close();
    this.#onDisposed();
  }

  #onMessage(value: unknown): void {
    if (!isSupervisorMessage(value)) return;
    if (value.type === "supervisor-ready") {
      this.#supervisorReady.resolve();
      return;
    }
    if (value.type === "ready" && value.pid !== undefined) {
      this.#targetPid = value.pid;
      this.#target.resolve(value.pid);
      return;
    }
    if (value.type === "output" && value.stream !== undefined && value.data !== undefined) {
      const decoder = value.stream === "stdout" ? this.#stdoutDecoder : this.#stderrDecoder;
      const data = decoder.write(Buffer.from(value.data, "base64"));
      if (data.length > 0) this.#queue.push({ type: value.stream, data });
      return;
    }
    if (value.type === "spawn-error") {
      const code = value.code ?? "UNKNOWN";
      this.#queue.push({ type: "stderr", data: `Failed to spawn host command (${code}).\n` });
      return;
    }
    if (value.type === "complete" && value.exitCode !== undefined && value.finishedAt !== undefined) {
      const stdout = this.#stdoutDecoder.end();
      const stderr = this.#stderrDecoder.end();
      if (stdout.length > 0) this.#queue.push({ type: "stdout", data: stdout });
      if (stderr.length > 0) this.#queue.push({ type: "stderr", data: stderr });
      this.#settled = true;
      this.#queue.push({ type: "complete", exitCode: value.exitCode, finishedAt: value.finishedAt });
      this.#queue.close();
      this.#completion.resolve();
      this.#onDisposed();
    }
  }

  #backendFailure(code: string, message: string, retryable: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#queue.push({ type: "backend-failure", code, message, retryable });
    this.#queue.close();
    this.#completion.resolve();
    this.#onDisposed();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function isSupervisorMessage(value: unknown): value is SupervisorMessage {
  if (value === null || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return false;
  const message = value as Record<string, unknown>;
  return (message.pid === undefined || Number.isSafeInteger(message.pid)) &&
    (message.stream === undefined || message.stream === "stdout" || message.stream === "stderr") &&
    (message.data === undefined || typeof message.data === "string") &&
    (message.code === undefined || typeof message.code === "string") &&
    (message.message === undefined || typeof message.message === "string") &&
    (message.exitCode === undefined || Number.isFinite(message.exitCode)) &&
    (message.finishedAt === undefined || Number.isFinite(message.finishedAt));
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

function parseDescriptor(value: unknown, backendId: string, expectedSandboxId?: string): ProcessDescriptor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid process sandbox descriptor.");
  const descriptor = value as Record<string, unknown>;
  const keys = [
    "schemaVersion", "backendId", "sandboxId", "name", "status", "persistent", "createdAt", "updatedAt",
    "statusUpdatedAt", "expiresAt", "timeoutMs", "tags",
  ];
  if (Object.keys(descriptor).length !== keys.length || !keys.every((key) => Object.hasOwn(descriptor, key)) ||
      descriptor.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION || descriptor.backendId !== backendId ||
      typeof descriptor.sandboxId !== "string" || descriptor.sandboxId.length === 0 ||
      descriptor.name !== descriptor.sandboxId ||
      (expectedSandboxId !== undefined && descriptor.sandboxId !== expectedSandboxId) ||
      (descriptor.status !== "running" && descriptor.status !== "stopped") ||
      typeof descriptor.persistent !== "boolean" || !isTimestamp(descriptor.createdAt) ||
      !isTimestamp(descriptor.updatedAt) || !isTimestamp(descriptor.statusUpdatedAt) ||
      (descriptor.expiresAt !== null && !isTimestamp(descriptor.expiresAt)) ||
      !Number.isSafeInteger(descriptor.timeoutMs) || (descriptor.timeoutMs as number) < 1 ||
      !isStringRecord(descriptor.tags)) {
    throw new Error("Invalid process sandbox descriptor.");
  }
  return descriptor as unknown as ProcessDescriptor;
}

function descriptorRecord(descriptor: ProcessDescriptor, backend: BackendReference): SandboxRecord {
  return {
    sandboxId: descriptor.sandboxId,
    name: descriptor.name,
    status: descriptor.status,
    persistent: descriptor.persistent,
    bootSource: { type: "runtime", runtime: PROCESS_RUNTIME },
    runtime: PROCESS_RUNTIME,
    backend,
    createdAt: descriptor.createdAt,
    updatedAt: descriptor.updatedAt,
    statusUpdatedAt: descriptor.statusUpdatedAt,
    expiresAt: descriptor.expiresAt,
    timeoutMs: descriptor.timeoutMs,
    tags: { ...descriptor.tags },
    ports: [],
    endpoints: [],
    resources: { vcpus: null, memoryBytes: null },
    region: null,
    failoverRegions: [],
  };
}

function success<T extends JsonObject>(value: T): ClientResult<T> {
  return { ok: true, value };
}

export class ProcessBackend implements SandboxBackend {
  readonly reference: BackendReference;
  readonly capabilities = PROCESS_CAPABILITIES;
  readonly root: string;
  readonly instanceId: string;
  readonly #instanceRoot: string;
  readonly #sandboxesRoot: string;
  #initialization: Promise<void> | undefined;
  readonly #commands = new Map<string, Set<ProcessRawCommand>>();
  readonly #environments = new Map<string, Readonly<Record<string, string>>>();
  readonly #deadlineTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: ProcessBackendOptions) {
    if (process.platform === "win32") {
      throw new TypeError("ProcessBackend requires POSIX process-group semantics and is not supported on Windows.");
    }
    if (!isAbsolute(options.root)) throw new TypeError("The process backend root must be an absolute path.");
    const instanceId = options.instanceId;
    if (instanceId.length === 0 || instanceId.includes("\0")) {
      throw new TypeError("The process backend instance ID must be a non-empty string without NUL bytes.");
    }
    this.root = resolve(options.root);
    this.instanceId = instanceId;
    const identity = hash(`${this.root}\0${instanceId}`);
    this.reference = Object.freeze({ backendId: `local-process-${identity}`, backendType: "process" });
    this.#instanceRoot = join(this.root, "instances", identity);
    this.#sandboxesRoot = join(this.#instanceRoot, "sandboxes");
  }

  createSandbox(request: CreateSandboxRequest): Promise<ClientResult<CreateSandboxResult>> {
    return this.#run(request, "createSandbox", async () => {
      this.#validateCreate(request);
      await this.#ensureInitialized();
      return this.#withLock(request.sandboxId, request, async () => {
        const sandboxPath = this.#sandboxPath(request.sandboxId);
        if (await exists(sandboxPath)) {
          throw new BackendOperationError("already-exists", "LOCALBOX_SANDBOX_ALREADY_EXISTS", `Sandbox '${request.sandboxId}' already exists.`, {
            type: "resource", resource: "sandbox", resourceId: request.sandboxId,
          });
        }
        const now = Date.now();
        const descriptor: ProcessDescriptor = {
          schemaVersion: 1,
          backendId: this.reference.backendId,
          sandboxId: request.sandboxId,
          name: request.spec.name,
          status: "running",
          persistent: request.spec.persistent,
          createdAt: now,
          updatedAt: now,
          statusUpdatedAt: now,
          expiresAt: now + request.spec.timeoutMs,
          timeoutMs: request.spec.timeoutMs,
          tags: { ...request.spec.tags },
        };
        const staging = join(this.#sandboxesRoot, `.${hash(request.sandboxId)}.create.${randomUUID()}`);
        try {
          await mkdir(join(staging, "workspace"), { recursive: true, mode: DIRECTORY_MODE });
          await chmod(staging, DIRECTORY_MODE);
          await chmod(join(staging, "workspace"), DIRECTORY_MODE);
          await this.#writeDescriptor(staging, descriptor);
          await rename(staging, sandboxPath);
          await syncDirectory(this.#sandboxesRoot);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) {
            throw new BackendOperationError("already-exists", "LOCALBOX_SANDBOX_ALREADY_EXISTS", `Sandbox '${request.sandboxId}' already exists.`, {
              type: "resource", resource: "sandbox", resourceId: request.sandboxId,
            });
          }
          throw error;
        }
        this.#environments.set(request.sandboxId, { ...request.spec.environment });
        this.#scheduleDeadline(descriptor);
        return { sandbox: descriptorRecord(descriptor, this.reference) };
      });
    });
  }

  getSandbox(request: GetSandboxRequest): Promise<ClientResult<GetSandboxResult>> {
    return this.#run(request, "getSandbox", async () => {
      await this.#ensureInitialized();
      return this.#withLock(request.sandboxId, request, async () => {
        let descriptor = await this.#readDescriptor(request.sandboxId);
        descriptor = await this.#reconcileExpiredLocked(descriptor);
        if (request.resume && descriptor.status === "stopped") {
          const now = Date.now();
          descriptor = { ...descriptor, status: "running", updatedAt: now, statusUpdatedAt: now, expiresAt: now + descriptor.timeoutMs };
          await this.#writeDescriptor(this.#sandboxPath(request.sandboxId), descriptor);
        }
        this.#scheduleDeadline(descriptor);
        return { sandbox: descriptorRecord(descriptor, this.reference) };
      });
    });
  }

  listSandboxes(request: ListSandboxesRequest): Promise<ClientResult<ListSandboxesResult>> {
    return this.#run(request, "listSandboxes", async () => {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw this.#invalid("limit", "Sandbox list limit must be a positive integer.");
      }
      const start = request.cursor === null ? 0 : Number(request.cursor);
      if (!Number.isSafeInteger(start) || start < 0) throw this.#invalid("cursor", "Sandbox list cursor is invalid.");
      await this.#ensureInitialized();
      const entries = await readdir(this.#sandboxesRoot, { withFileTypes: true });
      const records: SandboxRecord[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        try {
          const descriptor = await this.#withLockByDigest(entry.name, request, async () => {
            const current = await this.#readDescriptorAt(join(this.#sandboxesRoot, entry.name));
            return this.#reconcileExpiredLocked(current);
          });
          const record = descriptorRecord(descriptor, this.reference);
          if (request.namePrefix !== null && !record.name.startsWith(request.namePrefix)) continue;
          if (request.statuses.length > 0 && !request.statuses.includes(record.status)) continue;
          if (!Object.entries(request.tags).every(([key, value]) => record.tags[key] === value)) continue;
          records.push(record);
        } catch (error) {
          if (error instanceof BackendOperationError && error.category === "not-found") continue;
          throw error;
        }
      }
      const order = request.sortOrder === "asc" ? 1 : -1;
      records.sort((left, right) => {
        if (request.sortBy === "name") return left.name.localeCompare(right.name) * order;
        const leftValue = request.sortBy === "createdAt" ? left.createdAt : left.statusUpdatedAt;
        const rightValue = request.sortBy === "createdAt" ? right.createdAt : right.statusUpdatedAt;
        if (leftValue === rightValue) return left.sandboxId.localeCompare(right.sandboxId) * order;
        return (leftValue - rightValue) * order;
      });
      const sandboxes = records.slice(start, start + request.limit);
      const next = start + sandboxes.length;
      return { sandboxes, nextCursor: next < records.length ? String(next) : null };
    });
  }

  stopSandbox(request: StopSandboxRequest): Promise<ClientResult<StopSandboxResult>> {
    return this.#run(request, "stopSandbox", async () => {
      await this.#ensureInitialized();
      return this.#withLock(request.sandboxId, request, async () => {
        const descriptor = await this.#readDescriptor(request.sandboxId);
        await this.#terminateSandbox(request.sandboxId);
        this.#clearDeadline(request.sandboxId);
        if (!descriptor.persistent) {
          const now = Date.now();
          const stopped: ProcessDescriptor = {
            ...descriptor,
            status: "stopped",
            updatedAt: now,
            statusUpdatedAt: now,
          };
          await this.#removeSandboxLocked(request.sandboxId);
          return { sandbox: descriptorRecord(stopped, this.reference) };
        }
        if (descriptor.status === "stopped") return { sandbox: descriptorRecord(descriptor, this.reference) };
        const now = Date.now();
        const stopped: ProcessDescriptor = { ...descriptor, status: "stopped", updatedAt: now, statusUpdatedAt: now };
        await this.#writeDescriptor(this.#sandboxPath(request.sandboxId), stopped);
        return { sandbox: descriptorRecord(stopped, this.reference) };
      });
    });
  }

  deleteSandbox(request: DeleteSandboxRequest): Promise<ClientResult<DeleteSandboxResult>> {
    return this.#run(request, "deleteSandbox", async () => {
      await this.#ensureInitialized();
      return this.#withLock(request.sandboxId, request, async () => {
        await this.#readDescriptor(request.sandboxId);
        await this.#terminateSandbox(request.sandboxId);
        await this.#removeSandboxLocked(request.sandboxId);
        return { sandboxId: request.sandboxId, deletedAt: Date.now() };
      });
    });
  }

  extendSandboxDeadline(request: ExtendSandboxDeadlineRequest): Promise<ClientResult<ExtendSandboxDeadlineResult>> {
    return this.#run(request, "extendSandboxDeadline", async () => {
      if (!Number.isSafeInteger(request.additionalMilliseconds) || request.additionalMilliseconds < 1) {
        throw this.#invalid("additionalMilliseconds", "Deadline extensions must be positive integer milliseconds.");
      }
      await this.#ensureInitialized();
      return this.#withLock(request.sandboxId, request, async () => {
        let descriptor = await this.#readDescriptor(request.sandboxId);
        descriptor = await this.#reconcileExpiredLocked(descriptor);
        const base = descriptor.expiresAt ?? Date.now();
        const expiresAt = base + request.additionalMilliseconds;
        if (!Number.isSafeInteger(expiresAt)) throw this.#invalid("additionalMilliseconds", "The extended sandbox deadline is out of range.");
        const now = Date.now();
        const extended: ProcessDescriptor = { ...descriptor, expiresAt, updatedAt: now };
        await this.#writeDescriptor(this.#sandboxPath(request.sandboxId), extended);
        this.#scheduleDeadline(extended);
        return { sandbox: descriptorRecord(extended, this.reference) };
      });
    });
  }

  async startRawCommand(request: StartRawCommandRequest, signal?: AbortSignal): Promise<StartRawCommandResult> {
    try {
      if (request.deadline !== null && request.deadline.expiresAt <= Date.now()) {
        throw new BackendOperationError("deadline-exceeded", "LOCALBOX_DEADLINE_EXCEEDED", "The startCommand operation exceeded its deadline.", { type: "backend", operation: "startCommand" }, true);
      }
      if (signal?.aborted) throw new DOMException("The operation was cancelled.", "AbortError");
      if (request.privilege !== undefined) {
        throw new BackendOperationError("failed-precondition", "LOCALBOX_UNSUPPORTED_CAPABILITY", "The process backend does not support privileged raw commands.", { type: "backend", operation: "startCommand" });
      }
      if (request.command.user !== undefined) {
        throw this.#invalid("command.user", "The process backend does not support alternate command users.");
      }
      const input = request.input === undefined ? null : Buffer.from(request.input.data, request.input.encoding);
      if (input !== null && input.length > FILESYSTEM_TRANSFER_CHUNK_BYTES) {
        throw this.#invalid("input", `Raw command input cannot exceed ${FILESYSTEM_TRANSFER_CHUNK_BYTES} bytes.`);
      }
      await this.#ensureInitialized();
      const descriptor = await this.#withLock(request.sandboxId, request, async () => {
        const current = await this.#readDescriptor(request.sandboxId);
        return this.#reconcileExpiredLocked(current);
      });
      if (descriptor.status !== "running") {
        throw new BackendOperationError("failed-precondition", "LOCALBOX_SANDBOX_STOPPED", `Sandbox '${request.sandboxId}' is stopped.`, {
          type: "resource", resource: "sandbox", resourceId: request.sandboxId,
        });
      }
      const cwd = await this.#mapCommandCwd(request.sandboxId, request.command.cwd);
      const environment: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
      Object.assign(environment, this.#environments.get(request.sandboxId) ?? {}, request.command.environment);
      for (const [key, value] of Object.entries(environment)) {
        if (key.length === 0 || key.includes("=") || key.includes("\0") || value.includes("\0")) {
          throw this.#invalid("command.environment", "Command environment names and values must be valid process environment strings.");
        }
      }
      let raw: ProcessRawCommand;
      raw = new ProcessRawCommand(request.command, cwd, environment, input, () => {
        const commands = this.#commands.get(request.sandboxId);
        commands?.delete(raw);
        if (commands?.size === 0) this.#commands.delete(request.sandboxId);
      });
      const commands = this.#commands.get(request.sandboxId) ?? new Set<ProcessRawCommand>();
      commands.add(raw);
      this.#commands.set(request.sandboxId, commands);
      try {
        await raw.waitUntilStarted(signal);
      } catch (error) {
        await raw.dispose().catch(() => undefined);
        throw error;
      }
      return { ok: true, command: raw };
    } catch (error) {
      return this.#failure(request, "startCommand", error);
    }
  }

  getEndpoint(request: GetEndpointRequest): Promise<ClientResult<GetEndpointResult>> {
    return Promise.resolve(this.#failure(request, "getEndpoint", new BackendOperationError(
      "failed-precondition",
      "LOCALBOX_UNSUPPORTED_CAPABILITY",
      "The process backend does not expose or remap ports.",
      { type: "backend", operation: "getEndpoint" },
    )));
  }

  async filesystemWorkspace(sandboxId: string): Promise<{ readonly root: string; readonly virtualRoot: string }> {
    await this.#ensureInitialized();
    await this.#readDescriptor(sandboxId);
    return { root: await this.#workspacePath(sandboxId), virtualRoot: VIRTUAL_WORKSPACE };
  }

  #ensureInitialized(): Promise<void> {
    this.#initialization ??= this.#initialize();
    return this.#initialization;
  }

  async #initialize(): Promise<void> {
    await ensureDirectoryPath(this.#sandboxesRoot);
    if (await realpath(this.root) !== this.root) {
      throw new TypeError("The process backend root must not traverse symbolic links.");
    }
    const directories = [
      this.root,
      join(this.root, "instances"),
      this.#instanceRoot,
      this.#sandboxesRoot,
    ];
    for (const directory of directories) {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError("ProcessBackend state directories must not be symbolic links.");
      }
      await chmod(directory, DIRECTORY_MODE);
    }
  }

  #validateCreate(request: CreateSandboxRequest): void {
    const issues = negotiateSandboxRequirements(this.capabilities, request.requirements);
    if (issues.length > 0) {
      const unsupported = issues.some((issue) => issue.kind === "unsupported" || issue.kind === "constraint");
      throw new BackendOperationError(
        unsupported ? "unsupported-requirement" : "invalid-request",
        unsupported ? "LOCALBOX_UNSUPPORTED_REQUIREMENT" : "LOCALBOX_INVALID_REQUEST",
        "The process backend cannot satisfy the requested sandbox capabilities.",
        { type: "requirement-negotiation", issues },
      );
    }
    if (request.sandboxId !== request.spec.name) throw this.#invalid("sandboxId", "sandboxId must match spec.name.");
    if (request.backend !== null && (request.backend.backendId !== this.reference.backendId || request.backend.backendType !== this.reference.backendType)) {
      throw this.#invalid("backend", "The requested backend reference does not match this process backend instance.");
    }
    if (request.spec.bootSource.type !== "runtime" || request.spec.bootSource.runtime !== PROCESS_RUNTIME) {
      throw this.#invalid("spec.bootSource", "ProcessBackend accepts only { type: 'runtime', runtime: 'host' }.");
    }
    if (request.spec.source !== null) throw this.#invalid("spec.source", "ProcessBackend does not materialize Git or tarball sources.");
    if (request.spec.networkPolicy !== "allow-all") throw this.#invalid("spec.networkPolicy", "ProcessBackend supports only allow-all host networking.");
    if (request.spec.resources.vcpus !== null || request.spec.resources.memoryBytes !== null) {
      throw this.#invalid("spec.resources", "ProcessBackend does not enforce CPU or memory limits.");
    }
    if (request.spec.ports.length > 0) throw this.#invalid("spec.ports", "ProcessBackend does not expose or remap ports.");
    if (request.spec.region !== null || request.spec.failoverRegions.length > 0) {
      throw this.#invalid("spec.region", "ProcessBackend does not support regions or failover regions.");
    }
    if (!Number.isSafeInteger(request.spec.timeoutMs) || request.spec.timeoutMs < 1) {
      throw this.#invalid("spec.timeoutMs", "Sandbox timeout must be a positive integer in milliseconds.");
    }
    if (!isStringRecord(request.spec.environment) || !isStringRecord(request.spec.tags)) {
      throw this.#invalid("spec", "Sandbox environment and tags must contain only string values.");
    }
  }

  async #run<T extends JsonObject>(
    request: RequestMetadata,
    operation: string,
    work: () => Promise<T>,
  ): Promise<ClientResult<T>> {
    try {
      this.#assertRequestDeadline(request, operation);
      return success(await work());
    } catch (error) {
      return this.#failure(request, operation, error);
    }
  }

  #failure(request: RequestMetadata, operation: string, error: unknown): ClientFailure {
    let translated: BackendOperationError;
    if (error instanceof BackendOperationError) translated = error;
    else if (error instanceof DOMException && error.name === "AbortError") {
      translated = new BackendOperationError("cancelled", "LOCALBOX_OPERATION_CANCELLED", `The ${operation} operation was cancelled.`, { type: "backend", operation });
    } else {
      translated = new BackendOperationError("backend-failure", "LOCALBOX_PROCESS_BACKEND_FAILURE", `The process backend could not complete ${operation}.`, { type: "backend", operation });
    }
    return {
      ok: false,
      error: {
        category: translated.category,
        code: translated.code,
        message: translated.message,
        retryable: translated.retryable,
        requestId: request.requestId,
        backend: this.reference,
        details: translated.details,
      },
    };
  }

  #invalid(field: string, reason: string): BackendOperationError {
    return new BackendOperationError("invalid-request", "LOCALBOX_INVALID_REQUEST", reason, { type: "invalid-request", field, reason });
  }

  #assertRequestDeadline(request: RequestMetadata, operation: string): void {
    if (request.deadline !== null && request.deadline.expiresAt <= Date.now()) {
      throw new BackendOperationError("deadline-exceeded", "LOCALBOX_DEADLINE_EXCEEDED", `The ${operation} operation exceeded its deadline.`, { type: "backend", operation }, true);
    }
  }

  #sandboxPath(sandboxId: string): string {
    return join(this.#sandboxesRoot, hash(sandboxId));
  }

  async #readDescriptor(sandboxId: string): Promise<ProcessDescriptor> {
    return this.#readDescriptorAt(this.#sandboxPath(sandboxId), sandboxId);
  }

  async #readDescriptorAt(directory: string, expectedSandboxId?: string): Promise<ProcessDescriptor> {
    try {
      const directoryMetadata = await lstat(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new Error("Invalid process sandbox directory.");
      }
      const descriptorPath = join(directory, DESCRIPTOR_FILE);
      const metadata = await lstat(descriptorPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DESCRIPTOR_BYTES) {
        throw new Error("Invalid process sandbox descriptor.");
      }
      return parseDescriptor(JSON.parse(await readFile(descriptorPath, "utf8")), this.reference.backendId, expectedSandboxId);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new BackendOperationError("not-found", "LOCALBOX_SANDBOX_NOT_FOUND", "The process sandbox was not found.", {
          type: "resource", resource: "sandbox", resourceId: expectedSandboxId ?? "unknown",
        });
      }
      throw error;
    }
  }

  async #writeDescriptor(directory: string, descriptor: ProcessDescriptor): Promise<void> {
    const temporary = join(directory, `.sandbox.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(directory, DESCRIPTOR_FILE));
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #withLock<T>(sandboxId: string, request: RequestMetadata | null, work: () => Promise<T>): Promise<T> {
    return this.#withLockByDigest(hash(sandboxId), request, work);
  }

  async #withLockByDigest<T>(digest: string, request: RequestMetadata | null, work: () => Promise<T>): Promise<T> {
    const lock = join(this.#sandboxesRoot, `.${digest}.operation`);
    while (true) {
      if (request !== null) this.#assertRequestDeadline(request, "sandboxMutation");
      let acquired = false;
      try {
        await mkdir(lock, { mode: DIRECTORY_MODE });
        acquired = true;
        const handle = await open(join(lock, "owner"), "wx", FILE_MODE);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (acquired) {
          await rm(lock, { recursive: true, force: true });
          throw error;
        }
        if (!isErrno(error, "EEXIST")) throw error;
        await this.#reclaimStaleLock(lock);
        await delay(LOCK_POLL_MS, undefined, { ref: false });
      }
    }
    try {
      return await work();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async #reclaimStaleLock(lock: string): Promise<void> {
    try {
      const owner = JSON.parse(await readFile(join(lock, "owner"), "utf8")) as { pid?: unknown };
      if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) {
        try {
          process.kill(owner.pid as number, 0);
          return;
        } catch (error) {
          if (!isErrno(error, "ESRCH")) return;
        }
      }
      await rm(lock, { recursive: true, force: true });
    } catch {
      try {
        const metadata = await stat(lock);
        if (Date.now() - metadata.mtimeMs >= LOCK_STALE_GRACE_MS) await rm(lock, { recursive: true, force: true });
      } catch {
        // A concurrent owner may have released or repaired the lock.
      }
    }
  }

  async #reconcileExpiredLocked(descriptor: ProcessDescriptor): Promise<ProcessDescriptor> {
    if (descriptor.status !== "running" || descriptor.expiresAt === null || descriptor.expiresAt > Date.now()) return descriptor;
    await this.#terminateSandbox(descriptor.sandboxId);
    this.#clearDeadline(descriptor.sandboxId);
    if (!descriptor.persistent) {
      await this.#removeSandboxLocked(descriptor.sandboxId);
      throw new BackendOperationError("not-found", "LOCALBOX_SANDBOX_NOT_FOUND", `Sandbox '${descriptor.sandboxId}' expired and was removed.`, {
        type: "resource", resource: "sandbox", resourceId: descriptor.sandboxId,
      });
    }
    const now = Date.now();
    const stopped: ProcessDescriptor = { ...descriptor, status: "stopped", updatedAt: now, statusUpdatedAt: now };
    await this.#writeDescriptor(this.#sandboxPath(descriptor.sandboxId), stopped);
    return stopped;
  }

  #scheduleDeadline(descriptor: ProcessDescriptor): void {
    this.#clearDeadline(descriptor.sandboxId);
    if (descriptor.status !== "running" || descriptor.expiresAt === null) return;
    const timer = setTimeout(() => void this.#expire(descriptor.sandboxId), Math.max(0, descriptor.expiresAt - Date.now()));
    timer.unref();
    this.#deadlineTimers.set(descriptor.sandboxId, timer);
  }

  #clearDeadline(sandboxId: string): void {
    const timer = this.#deadlineTimers.get(sandboxId);
    if (timer !== undefined) clearTimeout(timer);
    this.#deadlineTimers.delete(sandboxId);
  }

  async #expire(sandboxId: string): Promise<void> {
    try {
      await this.#withLock(sandboxId, null, async () => {
        const descriptor = await this.#readDescriptor(sandboxId);
        const reconciled = await this.#reconcileExpiredLocked(descriptor);
        this.#scheduleDeadline(reconciled);
      });
    } catch {
      // A concurrent stop/delete or corrupt descriptor is authoritative; later reads reconcile again.
    }
  }

  async #terminateSandbox(sandboxId: string): Promise<void> {
    const commands = [...(this.#commands.get(sandboxId) ?? [])];
    await Promise.all(commands.map((command) => command.dispose().catch(() => undefined)));
    this.#commands.delete(sandboxId);
  }

  async #removeSandboxLocked(sandboxId: string): Promise<void> {
    this.#clearDeadline(sandboxId);
    this.#environments.delete(sandboxId);
    await rm(this.#sandboxPath(sandboxId), { recursive: true, force: true });
    await syncDirectory(this.#sandboxesRoot);
  }

  async #workspacePath(sandboxId: string): Promise<string> {
    const workspace = join(this.#sandboxPath(sandboxId), "workspace");
    const metadata = await lstat(workspace);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Invalid process sandbox workspace.");
    }
    return workspace;
  }

  async #mapCommandCwd(sandboxId: string, cwd: string): Promise<string> {
    if (cwd.includes("\0") || !posix.isAbsolute(cwd)) throw this.#invalid("command.cwd", "Command cwd must be an absolute virtual workspace path.");
    const normalized = posix.normalize(cwd);
    if (normalized !== VIRTUAL_WORKSPACE && !normalized.startsWith(`${VIRTUAL_WORKSPACE}/`)) {
      throw this.#invalid("command.cwd", "Command cwd must remain within /vercel/sandbox.");
    }
    const workspace = await this.#workspacePath(sandboxId);
    const suffix = normalized === VIRTUAL_WORKSPACE ? "" : normalized.slice(VIRTUAL_WORKSPACE.length + 1);
    const mapped = join(workspace, ...suffix.split("/").filter((part) => part.length > 0));
    let workspaceReal: string;
    let mappedReal: string;
    try {
      [workspaceReal, mappedReal] = await Promise.all([realpath(workspace), realpath(mapped)]);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
        throw this.#invalid("command.cwd", "Command cwd must name an existing directory inside the workspace.");
      }
      throw error;
    }
    if (mappedReal !== workspaceReal && !mappedReal.startsWith(`${workspaceReal}${sep}`)) {
      throw this.#invalid("command.cwd", "Command cwd resolves outside the sandbox workspace.");
    }
    if (!(await stat(mappedReal)).isDirectory()) throw this.#invalid("command.cwd", "Command cwd must be a directory.");
    return mappedReal;
  }
}

async function ensureDirectoryPath(target: string): Promise<void> {
  let current: string = sep;
  for (const segment of resolve(target).split(sep).filter((part) => part.length > 0)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError("ProcessBackend state paths must contain only real directories.");
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: DIRECTORY_MODE });
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
      }
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError("ProcessBackend state paths must contain only real directories.");
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isErrno(error, "EINVAL") && !isErrno(error, "ENOTSUP") && !isErrno(error, "EISDIR")) throw error;
  } finally {
    await handle?.close();
  }
}

export type { ProcessBackendOptions };
export { PROCESS_CAPABILITIES, PROCESS_RUNTIME, VIRTUAL_WORKSPACE as PROCESS_VIRTUAL_WORKSPACE };
