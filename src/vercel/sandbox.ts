import { randomUUID } from "node:crypto";
import * as localFs from "node:fs/promises";
import { dirname, resolve as resolveLocalPath } from "node:path";
import { posix } from "node:path";
import { Readable } from "node:stream";
import type {
  BootArtifact,
  ClientResult,
  SandboxClient,
  SandboxFrontendMetadata,
  SandboxRecord,
  SandboxRequirement,
  SandboxSource as RuntimeSandboxSource,
  StartCommandResult,
} from "../runtime/index.js";
import { Command, type CommandRunOptions, CommandFinished, createCommand } from "./command.js";
import {
  createSandboxClient,
  mutationMetadata,
  requestMetadata,
  throwIfAborted,
  unwrap,
  withAbort,
} from "./client.js";
import {
  InvalidSandboxOptionsError,
  PortNotExposedError,
  SandboxAlreadyExistsError,
  SandboxDeletedError,
  SandboxNotFoundError,
  UnsupportedSandboxCapabilityError,
} from "./errors.js";
import { resolveVercelBootArtifact } from "./boot-artifact.js";
import { createFileSystem, FileSystem } from "./filesystem.js";
import type {
  SandboxCreateOptions,
  SandboxGetOptions,
  SandboxGetOrCreateOptions,
  SandboxListItem,
  SandboxListOptions,
  SandboxListPage,
  SandboxListResult,
  SandboxPath,
  SandboxSource,
  SandboxStatus,
  WriteFileSpec,
} from "./types.js";

const DEFAULT_TIMEOUT = 300_000;
const WORKSPACE = "/vercel/sandbox";
const SUPPORTED_IMPLEMENTATIONS = ["native", "emulated", "partial"] as const;

interface SignalOptions {
  signal?: AbortSignal;
}

interface DownloadOptions extends SignalOptions {
  mkdirRecursive?: boolean;
}

interface FrontendCreateSpec {
  readonly name: string;
  readonly bootArtifact: BootArtifact;
  readonly frontendMetadata: SandboxFrontendMetadata;
  readonly source: RuntimeSandboxSource | null;
  readonly persistent: boolean;
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly ports: readonly number[];
  readonly networkPolicy: "allow-all" | "deny-all";
  readonly resources: { readonly vcpus: number | null; readonly memoryBytes: number | null };
  readonly region: string | null;
  readonly failoverRegions: readonly string[];
  readonly requirements: readonly SandboxRequirement[];
}

function validateOptionalText(value: string | undefined, field: string): void {
  if (value !== undefined && (value.trim().length === 0 || value.includes("\0"))) {
    throw new InvalidSandboxOptionsError(`${field} must not be empty or contain NUL.`);
  }
}

function runtimeSource(source: SandboxSource | undefined): RuntimeSandboxSource | null {
  if (source === undefined) return null;
  if (source.type === "snapshot") throw new UnsupportedSandboxCapabilityError("snapshot sources");
  if (source.type === "tarball") {
    validateOptionalText(source.url, "Tarball source URL");
    return { type: "tarball", url: source.url };
  }
  validateOptionalText(source.url, "Git source URL");
  validateOptionalText(source.revision, "Git source revision");
  if (source.depth !== undefined && (!Number.isInteger(source.depth) || source.depth < 1)) {
    throw new InvalidSandboxOptionsError("Git source depth must be a positive integer.");
  }
  if ("username" in source) {
    validateOptionalText(source.username, "Git source username");
    if (source.password.includes("\0")) {
      throw new InvalidSandboxOptionsError("Git source password must not contain NUL.");
    }
  }
  return {
    type: "git",
    url: source.url,
    revision: source.revision ?? null,
    depth: source.depth ?? null,
    credentials: "username" in source
      ? { username: source.username, password: source.password }
      : null,
  };
}

function normalizeCreateOptions(options: SandboxCreateOptions = {}): FrontendCreateSpec {
  if (options.mounts !== undefined && Object.keys(options.mounts).length > 0) {
    throw new UnsupportedSandboxCapabilityError("drive mounts");
  }
  if (options.snapshotExpiration !== undefined || options.keepLastSnapshots !== undefined) {
    throw new UnsupportedSandboxCapabilityError("snapshot retention");
  }
  if (typeof options.networkPolicy === "object") {
    throw new UnsupportedSandboxCapabilityError("custom network policies");
  }
  throwIfAborted(options.signal);

  const boot = resolveVercelBootArtifact({
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.image === undefined ? {} : { image: options.image }),
  });
  if (!boot.ok) throw new InvalidSandboxOptionsError(boot.message);
  const source = runtimeSource(options.source);
  const persistent = options.persistent ?? true;
  const networkPolicy = options.networkPolicy ?? "allow-all";
  const ports = [...(options.ports ?? [])];
  if (networkPolicy === "deny-all" && ports.length > 0) {
    throw new UnsupportedSandboxCapabilityError("simultaneous deny-all networking and exposed ports");
  }
  const vcpus = options.resources?.vcpus ?? null;
  const artifactKinds = ["oci-image"] as const;
  const requirements: SandboxRequirement[] = [
    { type: "operation", operation: "command.start", acceptableSupport: SUPPORTED_IMPLEMENTATIONS },
    { type: "operation", operation: "command.detached", acceptableSupport: SUPPORTED_IMPLEMENTATIONS },
    { type: "operation", operation: "filesystem.mkdir", acceptableSupport: SUPPORTED_IMPLEMENTATIONS },
    { type: "operation", operation: "filesystem.read", acceptableSupport: SUPPORTED_IMPLEMENTATIONS },
    { type: "operation", operation: "filesystem.write", acceptableSupport: SUPPORTED_IMPLEMENTATIONS },
    ...(ports.length === 0
      ? []
      : [{ type: "operation" as const, operation: "endpoint.expose" as const, acceptableSupport: SUPPORTED_IMPLEMENTATIONS }]),
    ...(source === null
      ? []
      : [{ type: "operation" as const, operation: `source.${source.type}` as const, acceptableSupport: SUPPORTED_IMPLEMENTATIONS }]),
    { type: "artifacts", kinds: artifactKinds, acceptableSupport: SUPPORTED_IMPLEMENTATIONS },
    ...(persistent
      ? [{ type: "persistence" as const, scope: "sandbox-lifecycle" as const, acceptableSupport: SUPPORTED_IMPLEMENTATIONS }]
      : []),
    {
      type: "networking",
      mode: networkPolicy,
      portExposure: ports.length === 0 ? null : "loopback",
      customPolicy: false,
      acceptableSupport: SUPPORTED_IMPLEMENTATIONS,
    },
    ...(vcpus === null
      ? []
      : [{
          type: "resources" as const,
          vcpus,
          memoryBytes: vcpus * 2_048 * 1_048_576,
          enforcement: "hard" as const,
          acceptableSupport: SUPPORTED_IMPLEMENTATIONS,
        }]),
  ];

  return {
    name: options.name ?? `localbox-${randomUUID()}`,
    bootArtifact: boot.artifact,
    frontendMetadata: boot.metadata,
    source,
    persistent,
    timeoutMs: options.timeout ?? DEFAULT_TIMEOUT,
    environment: { ...options.env },
    tags: { ...options.tags },
    ports,
    networkPolicy,
    resources: {
      vcpus,
      memoryBytes: vcpus === null ? null : vcpus * 2_048 * 1_048_576,
    },
    region: options.region ?? null,
    failoverRegions: [...(options.failoverRegions ?? [])],
    requirements,
  };
}

function resolveContainerPath(path: string, cwd?: string): string {
  if (path.includes("\0") || cwd?.includes("\0")) throw new TypeError("File paths cannot contain NUL bytes.");
  if (posix.isAbsolute(path)) return path;
  return posix.resolve(cwd ?? WORKSPACE, path);
}

function listItem(record: SandboxRecord): SandboxListItem {
  return {
    name: record.name,
    persistent: record.persistent,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    currentSessionId: record.sandboxId,
    status: record.status,
    ...(record.resources.vcpus === null ? {} : { vcpus: record.resources.vcpus }),
    ...(record.resources.memoryBytes === null
      ? {}
      : { memory: record.resources.memoryBytes / 1_048_576 }),
    image: record.frontendMetadata?.image ??
      (record.bootArtifact.kind === "oci-image" ? record.bootArtifact.locator.reference : ""),
    timeout: record.timeoutMs,
    statusUpdatedAt: record.statusUpdatedAt,
    cwd: WORKSPACE,
    ...(Object.keys(record.tags).length === 0 ? {} : { tags: { ...record.tags } }),
  };
}

function sandboxPaginator(items: SandboxListItem[], limit: number, start: number): SandboxListResult {
  const pageAt = (offset: number): SandboxListPage => {
    const sandboxes = items.slice(offset, offset + limit);
    const nextOffset = offset + sandboxes.length;
    return {
      sandboxes,
      pagination: {
        count: sandboxes.length,
        next: nextOffset < items.length ? String(nextOffset) : null,
      },
    };
  };
  const first = pageAt(start);
  return {
    ...first,
    async *[Symbol.asyncIterator]() {
      for (const item of items.slice(start)) yield item;
    },
    async *pages() {
      for (let offset = start; offset < items.length; offset += limit) yield pageAt(offset);
    },
    async toArray() {
      return items.slice(start);
    },
  };
}

export class Sandbox {
  readonly #client: SandboxClient;
  readonly #onResume: ((sandbox: Sandbox) => Promise<void>) | undefined;
  #record: SandboxRecord;
  #deleted = false;
  #resumePromise: Promise<void> | undefined;
  readonly fs: FileSystem;

  private constructor(
    client: SandboxClient,
    record: SandboxRecord,
    onResume?: (sandbox: Sandbox) => Promise<void>,
  ) {
    this.#client = client;
    this.#record = record;
    this.#onResume = onResume;
    this.fs = createFileSystem(
      client,
      record.sandboxId,
      async (signal) => this.#ensureRunning(signal),
    );
  }

  get name(): string {
    return this.#record.name;
  }

  get persistent(): boolean {
    return this.#record.persistent;
  }

  get image(): string {
    return this.#record.frontendMetadata?.image ??
      (this.#record.bootArtifact.kind === "oci-image"
        ? this.#record.bootArtifact.locator.reference
        : "");
  }

  get runtime(): string | undefined {
    return this.#record.frontendMetadata?.runtime ?? undefined;
  }

  get ports(): readonly number[] {
    return this.#record.ports;
  }

  get timeout(): number {
    return this.#record.timeoutMs;
  }

  get tags(): Readonly<Record<string, string>> {
    return this.#record.tags;
  }

  get region(): string {
    return this.#record.region ?? "local";
  }

  get failoverRegions(): readonly string[] {
    return this.#record.failoverRegions;
  }

  get vcpus(): number | undefined {
    return this.#record.resources.vcpus ?? undefined;
  }

  get memory(): number | undefined {
    return this.#record.resources.memoryBytes === null
      ? undefined
      : this.#record.resources.memoryBytes / 1_048_576;
  }

  get createdAt(): Date {
    return new Date(this.#record.createdAt);
  }

  get status(): SandboxStatus {
    return this.#record.status;
  }

  get expiresAt(): Date | undefined {
    return this.#record.expiresAt === null ? undefined : new Date(this.#record.expiresAt);
  }

  static async list(options: SandboxListOptions = {}): Promise<SandboxListResult> {
    throwIfAborted(options.signal);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new InvalidSandboxOptionsError("Sandbox list limit must be a positive integer.");
    }
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) {
      throw new InvalidSandboxOptionsError("Sandbox list cursor is invalid.");
    }
    const client = createSandboxClient();
    const result = unwrap(await withAbort(client.listSandboxes({
      ...requestMetadata(),
      namePrefix: options.namePrefix ?? null,
      tags: { ...options.tags },
      statuses: [],
      sortBy: options.sortBy ?? "createdAt",
      sortOrder: options.sortOrder ?? "desc",
      limit: 1_000_000,
      cursor: null,
    }), options.signal));
    return sandboxPaginator(result.sandboxes.map(listItem), limit, start);
  }

  static async create(options: SandboxCreateOptions = {}): Promise<Sandbox> {
    const normalized = normalizeCreateOptions(options);
    const client = createSandboxClient();
    const operation = client.createSandbox({
      ...mutationMetadata(),
      sandboxId: normalized.name,
      backend: null,
      requirements: normalized.requirements,
      spec: {
        name: normalized.name,
        bootArtifact: normalized.bootArtifact,
        frontendMetadata: normalized.frontendMetadata,
        source: normalized.source,
        persistent: normalized.persistent,
        timeoutMs: normalized.timeoutMs,
        environment: normalized.environment,
        tags: normalized.tags,
        ports: normalized.ports,
        networkPolicy: normalized.networkPolicy,
        resources: normalized.resources,
        region: normalized.region,
        failoverRegions: normalized.failoverRegions,
      },
    });
    try {
      const result = unwrap(await withAbort(operation, options.signal));
      return new Sandbox(client, result.sandbox, options.onResume);
    } catch (error) {
      if (options.signal?.aborted) {
        void operation.then(async (result) => {
          if (!result.ok) return;
          await client.deleteSandbox({
            ...mutationMetadata(),
            sandboxId: result.value.sandbox.sandboxId,
          });
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  static async get(options: SandboxGetOptions): Promise<Sandbox> {
    throwIfAborted(options.signal);
    const client = createSandboxClient();
    const initial = unwrap(await withAbort(client.getSandbox({
      ...mutationMetadata(),
      sandboxId: options.name,
      resume: false,
    }), options.signal));
    const sandbox = new Sandbox(client, initial.sandbox, options.onResume);
    if ((options.resume ?? false) && initial.sandbox.status !== "running") {
      const resumed = unwrap(await withAbort(client.getSandbox({
        ...mutationMetadata(),
        sandboxId: options.name,
        resume: true,
      }), options.signal));
      sandbox.#record = resumed.sandbox;
      if (options.onResume !== undefined) {
        try {
          await options.onResume(sandbox);
        } catch (error) {
          await sandbox.stop().catch(() => undefined);
          throw error;
        }
      }
    }
    return sandbox;
  }

  static async getOrCreate(options: SandboxGetOrCreateOptions): Promise<Sandbox> {
    throwIfAborted(options.signal);
    if (options.name !== undefined) {
      try {
        return await Sandbox.get({
          name: options.name,
          ...(options.resume === undefined ? {} : { resume: options.resume }),
          ...(options.onResume === undefined ? {} : { onResume: options.onResume }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
    }
    try {
      const sandbox = await Sandbox.create(options);
      if (options.onCreate !== undefined) {
        try {
          await options.onCreate(sandbox);
        } catch (error) {
          await sandbox.delete().catch(() => undefined);
          throw error;
        }
      }
      return sandbox;
    } catch (error) {
      if (!(error instanceof SandboxAlreadyExistsError) || options.name === undefined) throw error;
      return Sandbox.get({
        name: options.name,
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        ...(options.onResume === undefined ? {} : { onResume: options.onResume }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
  }

  async refresh(): Promise<SandboxStatus> {
    if (this.#deleted) return this.#record.status;
    try {
      const result = unwrap(await this.#client.getSandbox({
        ...mutationMetadata(),
        sandboxId: this.#record.sandboxId,
        resume: false,
      }));
      this.#record = result.sandbox;
    } catch (error) {
      if (error instanceof SandboxNotFoundError && !this.persistent && this.status !== "running") {
        this.#record = { ...this.#record, status: "stopped", expiresAt: null, endpoints: [] };
      } else {
        throw error;
      }
    }
    return this.#record.status;
  }

  domain(port: number): string {
    const endpoint = this.#record.endpoints.find((candidate) => candidate.port === port);
    if (endpoint === undefined) throw new PortNotExposedError(this.name, port);
    return endpoint.url;
  }

  async extendTimeout(duration: number, options: SignalOptions = {}): Promise<void> {
    if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration <= 0) {
      throw new InvalidSandboxOptionsError("Timeout extension must be a positive finite integer in milliseconds.");
    }
    this.#assertUsable();
    await this.#ensureRunning(options.signal);
    const result = unwrap(await withAbort(this.#client.extendSandboxDeadline({
      ...mutationMetadata(),
      sandboxId: this.#record.sandboxId,
      additionalMilliseconds: duration,
    }), options.signal));
    this.#record = result.sandbox;
  }

  runCommand(cmd: string, args?: string[], options?: SignalOptions): Promise<CommandFinished>;
  runCommand(options: CommandRunOptions & { detached: true }): Promise<Command>;
  runCommand(options: CommandRunOptions & { detached?: false }): Promise<CommandFinished>;
  async runCommand(
    cmdOrOptions: string | CommandRunOptions,
    args: string[] = [],
    stringOptions: SignalOptions = {},
  ): Promise<Command | CommandFinished> {
    this.#assertUsable();
    const options: CommandRunOptions = typeof cmdOrOptions === "string"
      ? { cmd: cmdOrOptions, args, ...stringOptions }
      : cmdOrOptions;
    throwIfAborted(options.signal);
    if (options.cmd.length === 0 || options.cmd.includes("\0")) {
      throw new TypeError("Command name must be non-empty and cannot contain NUL bytes.");
    }
    const cwd = resolveContainerPath(options.cwd ?? WORKSPACE);
    await this.#ensureRunning(options.signal);
    const startOperation = this.#client.startCommand({
      ...mutationMetadata(),
      sandboxId: this.#record.sandboxId,
      command: {
        command: options.cmd,
        arguments: [...(options.args ?? [])],
        cwd,
        environment: { ...options.env },
      },
      outputLimitBytes: 16 * 1024 * 1024,
    });
    let startResult: ClientResult<StartCommandResult>;
    try {
      startResult = await withAbort(startOperation, options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        void startOperation.then(async (result) => {
          if (!result.ok) return;
          await this.#client.signalProcess({
            ...mutationMetadata(),
            sandboxId: this.#record.sandboxId,
            processId: result.value.process.processId,
            signal: "SIGTERM",
          });
        }).catch(() => undefined);
      }
      throw error;
    }
    const started = unwrap(startResult);
    const command = createCommand(
      this.#client,
      this.#record.sandboxId,
      started.process,
      options.stdout,
      options.stderr,
    );
    if (options.detached === true) return command;
    return command.wait(options.signal === undefined ? {} : { signal: options.signal });
  }

  async stop(options: SignalOptions = {}): Promise<void> {
    throwIfAborted(options.signal);
    this.#assertUsable();
    try {
      const result = unwrap(await withAbort(this.#client.stopSandbox({
        ...mutationMetadata(),
        sandboxId: this.#record.sandboxId,
      }), options.signal));
      this.#record = result.sandbox;
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError) || this.persistent) throw error;
      this.#record = { ...this.#record, status: "stopped", expiresAt: null, endpoints: [] };
    }
  }

  async delete(options: SignalOptions = {}): Promise<void> {
    throwIfAborted(options.signal);
    if (this.#deleted) return;
    try {
      unwrap(await withAbort(this.#client.deleteSandbox({
        ...mutationMetadata(),
        sandboxId: this.#record.sandboxId,
      }), options.signal));
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }
    this.#deleted = true;
    this.#record = { ...this.#record, status: "stopped", expiresAt: null, endpoints: [] };
  }

  async mkDir(path: string, options: SignalOptions = {}): Promise<void> {
    await this.fs.mkdir(path, {
      recursive: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async writeFiles(files: WriteFileSpec[], options: SignalOptions = {}): Promise<void> {
    for (const file of files) {
      const operationOptions = options.signal === undefined ? {} : { signal: options.signal };
      await this.fs.writeFile(file.path, file.content, {
        ...operationOptions,
        ...(file.mode === undefined ? {} : { mode: file.mode }),
      });
    }
  }

  async readFile(src: SandboxPath, options: SignalOptions = {}): Promise<NodeJS.ReadableStream | null> {
    throwIfAborted(options.signal);
    const path = resolveContainerPath(src.path, src.cwd);
    try {
      const contents = await this.fs.readFile(
        path,
        options.signal === undefined ? null : { encoding: null, signal: options.signal },
      );
      return Readable.from(contents);
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readFileToBuffer(src: SandboxPath, options: SignalOptions = {}): Promise<Buffer | null> {
    try {
      return await this.fs.readFile(
        resolveContainerPath(src.path, src.cwd),
        options.signal === undefined ? null : { encoding: null, signal: options.signal },
      );
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async downloadFile(
    src: SandboxPath,
    dst: SandboxPath,
    options: DownloadOptions = {},
  ): Promise<string | null> {
    throwIfAborted(options.signal);
    const contents = await this.readFileToBuffer(src, options);
    if (contents === null) return null;
    const destination = resolveLocalPath(dst.cwd ?? process.cwd(), dst.path);
    if (options.mkdirRecursive ?? false) await localFs.mkdir(dirname(destination), { recursive: true });
    await localFs.writeFile(
      destination,
      contents,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    return destination;
  }

  async #ensureRunning(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.#assertUsable();
    if (this.#resumePromise !== undefined) {
      if (this.#record.status === "running") return;
      return this.#resumePromise;
    }
    const resume = (async () => {
      const observed = unwrap(await withAbort(this.#client.getSandbox({
        ...mutationMetadata(),
        sandboxId: this.#record.sandboxId,
        resume: false,
      }), signal));
      this.#record = observed.sandbox;
      if (observed.sandbox.status === "running") return;
      const resumed = unwrap(await withAbort(this.#client.getSandbox({
        ...mutationMetadata(),
        sandboxId: this.#record.sandboxId,
        resume: true,
      }), signal));
      this.#record = resumed.sandbox;
      if (this.#onResume !== undefined) {
        try {
          await this.#onResume(this);
        } catch (error) {
          await this.stop().catch(() => undefined);
          throw error;
        }
      }
    })();
    this.#resumePromise = resume;
    try {
      await resume;
    } finally {
      if (this.#resumePromise === resume) this.#resumePromise = undefined;
    }
  }

  #assertUsable(): void {
    if (this.#deleted) throw new SandboxDeletedError(this.name);
  }
}
