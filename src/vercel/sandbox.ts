import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import * as localFs from "node:fs/promises";
import { dirname, resolve as resolveLocalPath } from "node:path";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough, Writable } from "node:stream";
import type Dockerode from "dockerode";
import { Command, type CommandRunOptions, CommandFinished, startCommand } from "./command.js";
import {
  abortError,
  docker,
  dockerStatus,
  ensureDocker,
  ensureImage,
  isConflict,
  isNotFound,
  rawExec,
  throwIfAborted,
  translateDockerError,
} from "../core/docker.js";
import {
  DockerUnavailableError,
  InvalidSandboxOptionsError,
  PortNotExposedError,
  SandboxAlreadyExistsError,
  SandboxDeletedError,
  SandboxNotFoundError,
  UnsupportedImageError,
} from "./errors.js";
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
  SandboxStatus,
  WriteFileSpec,
} from "./types.js";

const DEFAULT_IMAGE = "node:24-bookworm-slim";
const DEFAULT_TIMEOUT = 300_000;
const WORKSPACE = "/vercel/sandbox";
const LABEL_PREFIX = "dev.localbox";
const resumeContext = new AsyncLocalStorage<Sandbox>();

const WATCHDOG = String.raw`
import * as fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const timeout = Number(process.argv[1]);
const root = "/tmp/localbox";
const deadlinePath = root + "/deadline";
await fsp.mkdir("/vercel/sandbox", { recursive: true });
await fsp.mkdir(root, { recursive: true });
await fsp.writeFile(deadlinePath, String(Date.now() + timeout));
for (;;) {
  const deadline = Number(await fsp.readFile(deadlinePath, "utf8"));
  const remaining = deadline - Date.now();
  if (remaining <= 0) process.exit(0);
  await delay(Math.min(remaining, 100));
}
`;

const EXTEND_DEADLINE = String.raw`
import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const path = "/tmp/localbox/deadline";
const lock = path + ".lock";
for (;;) {
  try {
    await fs.mkdir(lock);
    break;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await delay(5);
  }
}
let next;
try {
  next = Number(await fs.readFile(path, "utf8")) + Number(process.argv[1]);
  const temporary = path + "." + process.pid;
  await fs.writeFile(temporary, String(next));
  await fs.rename(temporary, path);
} finally {
  await fs.rm(lock, { recursive: true, force: true });
}
process.stdout.write(String(next));
`;

interface NormalizedCreateOptions {
  name: string;
  image: string;
  ports: number[];
  timeout: number;
  env: Record<string, string>;
  persistent: boolean;
  signal?: AbortSignal;
}

interface SandboxMetadata {
  name: string;
  image: string;
  ports: number[];
  timeout: number;
  persistent: boolean;
  createdAt: Date;
}

interface SignalOptions {
  signal?: AbortSignal;
}

interface DownloadOptions extends SignalOptions {
  mkdirRecursive?: boolean;
}

interface DockerPortBinding {
  HostIp?: string;
  HostPort?: string;
}

export function dockerContainerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "sandbox";
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `localbox-${slug}-${hash}`;
}

function validateName(name: string): void {
  const length = name.trim().length;
  if (length < 1 || length > 128) {
    throw new InvalidSandboxOptionsError("Sandbox name must contain 1 to 128 non-whitespace characters.");
  }
}

function normalizeCreateOptions(options: SandboxCreateOptions = {}): NormalizedCreateOptions {
  const name = options.name ?? `localbox-${randomUUID()}`;
  validateName(name);
  if (options.image !== undefined && options.runtime !== undefined) {
    throw new InvalidSandboxOptionsError("Choose either image or runtime, not both.");
  }
  if (options.runtime !== undefined && options.runtime !== "node24") {
    throw new InvalidSandboxOptionsError(`Unsupported runtime "${String(options.runtime)}". Use node24 or a custom image.`);
  }
  const image = options.image ?? DEFAULT_IMAGE;
  if (image.trim().length === 0) {
    throw new InvalidSandboxOptionsError("Sandbox image must not be empty.");
  }
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    throw new InvalidSandboxOptionsError("Sandbox timeout must be a positive finite integer in milliseconds.");
  }

  const ports = options.ports === undefined ? [] : [...options.ports];
  if (ports.length > 15) {
    throw new InvalidSandboxOptionsError("A sandbox can expose at most 15 ports.");
  }
  const uniquePorts = new Set(ports);
  if (uniquePorts.size !== ports.length) {
    throw new InvalidSandboxOptionsError("Sandbox ports must be unique.");
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new InvalidSandboxOptionsError(`Invalid TCP port ${String(port)}. Use an integer from 1 to 65535.`);
    }
  }

  const env = { ...options.env };
  for (const key of Object.keys(env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0") || key.startsWith("LOCALBOX_")) {
      throw new InvalidSandboxOptionsError(
        `Invalid environment key "${key}". Keys must be non-empty, omit = and NUL, and not use LOCALBOX_.`,
      );
    }
  }
  throwIfAborted(options.signal);
  return {
    name,
    image,
    ports,
    timeout,
    env,
    persistent: options.persistent ?? true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function metadataFromInspect(name: string, info: Dockerode.ContainerInspectInfo): SandboxMetadata {
  const labels = info.Config.Labels;
  if (labels[`${LABEL_PREFIX}.managed`] !== "true" || labels[`${LABEL_PREFIX}.name`] !== name) {
    throw new SandboxNotFoundError(name);
  }
  const timeout = Number(labels[`${LABEL_PREFIX}.timeout`]);
  const ports = JSON.parse(labels[`${LABEL_PREFIX}.ports`] ?? "[]") as number[];
  return {
    name,
    image: labels[`${LABEL_PREFIX}.image`] ?? info.Config.Image,
    ports,
    timeout,
    persistent: labels[`${LABEL_PREFIX}.persistent`] === "true",
    createdAt: new Date(labels[`${LABEL_PREFIX}.created`] ?? info.Created),
  };
}

function mapStatus(info: Dockerode.ContainerInspectInfo): SandboxStatus {
  if (info.State.Dead || info.State.OOMKilled || info.State.Error.length > 0) return "failed";
  switch (info.State.Status) {
    case "created":
    case "restarting":
      return "pending";
    case "running":
      return "running";
    case "removing":
      return "stopping";
    case "dead":
      return "failed";
    default:
      return "stopped";
  }
}

function portMapFromInspect(info: Dockerode.ContainerInspectInfo, declared: readonly number[]): Map<number, number> {
  const output = new Map<number, number>();
  for (const port of declared) {
    const key = `${port}/tcp`;
    const live = info.NetworkSettings.Ports?.[key]?.[0];
    const configured = (info.HostConfig.PortBindings?.[key] as DockerPortBinding[] | undefined)?.[0];
    const hostPort = live?.HostPort ?? configured?.HostPort;
    if (hostPort !== undefined && hostPort.length > 0) output.set(port, Number(hostPort));
  }
  return output;
}

function resolveContainerPath(path: string, cwd?: string): string {
  if (path.includes("\0") || cwd?.includes("\0")) throw new TypeError("File paths cannot contain NUL bytes.");
  if (posix.isAbsolute(path)) return path;
  return posix.resolve(cwd ?? WORKSPACE, path);
}

async function inspectNamedContainer(name: string, signal?: AbortSignal): Promise<{
  container: Dockerode.Container;
  info: Dockerode.ContainerInspectInfo;
}> {
  const container = docker.getContainer(dockerContainerName(name));
  try {
    const info = await container.inspect(signal === undefined ? undefined : { abortSignal: signal });
    metadataFromInspect(name, info);
    return { container, info };
  } catch (error) {
    if (isNotFound(error) || error instanceof SandboxNotFoundError) {
      throw new SandboxNotFoundError(name, error);
    }
    translateDockerError(error);
  }
}

function timestamp(value: string | undefined, fallback: number): number {
  if (value === undefined || value.startsWith("0001-")) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listItemFromInspect(info: Dockerode.ContainerInspectInfo): SandboxListItem {
  const metadata = metadataFromInspect(info.Config.Labels[`${LABEL_PREFIX}.name`] ?? "", info);
  const createdAt = metadata.createdAt.getTime();
  const statusUpdatedAt = timestamp(
    info.State.Running ? info.State.StartedAt : info.State.FinishedAt,
    createdAt,
  );
  const tagsValue = info.Config.Labels[`${LABEL_PREFIX}.tags`];
  const tags = tagsValue === undefined
    ? undefined
    : JSON.parse(tagsValue) as Record<string, string>;
  const nanoCpus = info.HostConfig.NanoCpus ?? 0;
  const memoryBytes = info.HostConfig.Memory ?? 0;
  return {
    name: metadata.name,
    persistent: metadata.persistent,
    createdAt,
    updatedAt: statusUpdatedAt,
    currentSessionId: info.Id,
    status: mapStatus(info),
    ...(nanoCpus > 0 ? { vcpus: nanoCpus / 1_000_000_000 } : {}),
    ...(memoryBytes > 0 ? { memory: memoryBytes / 1_048_576 } : {}),
    image: metadata.image,
    timeout: metadata.timeout,
    statusUpdatedAt,
    cwd: info.Config.WorkingDir,
    ...(tags === undefined ? {} : { tags }),
  };
}

function sandboxPaginator(
  items: SandboxListItem[],
  limit: number,
  start: number,
): SandboxListResult {
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
  readonly name: string;
  readonly persistent: boolean;
  readonly image: string;
  readonly ports: readonly number[];
  readonly timeout: number;
  readonly createdAt: Date;
  readonly fs: FileSystem;
  readonly #container: Dockerode.Container;
  readonly #onResume: ((sandbox: Sandbox) => Promise<void>) | undefined;
  #status: SandboxStatus;
  #expiresAt: Date | undefined;
  #portMap = new Map<number, number>();
  #deleted = false;
  #lifecycle: Promise<void> = Promise.resolve();
  #resumePromise: Promise<Dockerode.Container> | undefined;
  #extension: Promise<void> = Promise.resolve();

  private constructor(
    container: Dockerode.Container,
    metadata: SandboxMetadata,
    info: Dockerode.ContainerInspectInfo,
    onResume?: (sandbox: Sandbox) => Promise<void>,
  ) {
    this.#container = container;
    this.name = metadata.name;
    this.persistent = metadata.persistent;
    this.image = metadata.image;
    this.ports = Object.freeze([...metadata.ports]);
    this.timeout = metadata.timeout;
    this.createdAt = metadata.createdAt;
    this.#status = mapStatus(info);
    this.#portMap = portMapFromInspect(info, this.ports);
    this.#onResume = onResume;
    this.fs = createFileSystem(async () => this.#ensureRunning());
  }

  static async list(options: SandboxListOptions = {}): Promise<SandboxListResult> {
    throwIfAborted(options.signal);
    await ensureDocker(options.signal);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new InvalidSandboxOptionsError("Sandbox list limit must be a positive integer.");
    }
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isInteger(start) || start < 0) {
      throw new InvalidSandboxOptionsError("Sandbox list cursor is invalid.");
    }

    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_PREFIX}.managed=true`] },
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    const inspected = await Promise.all(containers.map(async (entry) => {
      try {
        return await docker.getContainer(entry.Id).inspect(
          options.signal === undefined ? undefined : { abortSignal: options.signal },
        );
      } catch (error) {
        if (isNotFound(error)) return undefined;
        translateDockerError(error);
      }
    }));
    const tagFilter = Object.entries(options.tags ?? {})[0];
    const items = inspected
      .filter((info): info is Dockerode.ContainerInspectInfo => info !== undefined)
      .map(listItemFromInspect)
      .filter((item) => options.namePrefix === undefined || item.name.startsWith(options.namePrefix))
      .filter((item) => tagFilter === undefined || item.tags?.[tagFilter[0]] === tagFilter[1]);
    const direction = options.sortOrder === "asc" ? 1 : -1;
    const sortBy = options.sortBy ?? "createdAt";
    items.sort((left, right) => {
      const leftValue = sortBy === "name" ? left.name : left[sortBy] ?? 0;
      const rightValue = sortBy === "name" ? right.name : right[sortBy] ?? 0;
      return leftValue < rightValue ? -direction : leftValue > rightValue ? direction : 0;
    });
    return sandboxPaginator(items, limit, start);
  }

  static async create(options: SandboxCreateOptions = {}): Promise<Sandbox> {
    return Sandbox.#create(options);
  }

  static async get(options: SandboxGetOptions): Promise<Sandbox> {
    validateName(options.name);
    throwIfAborted(options.signal);
    await ensureDocker(options.signal);
    const { container, info } = await inspectNamedContainer(options.name, options.signal);
    const sandbox = new Sandbox(container, metadataFromInspect(options.name, info), info, options.onResume);
    if (options.resume ?? false) await sandbox.#ensureRunning();
    return sandbox;
  }

  static async getOrCreate(options: SandboxGetOrCreateOptions): Promise<Sandbox> {
    if (options.name !== undefined) validateName(options.name);
    throwIfAborted(options.signal);
    if (options.name !== undefined) {
      try {
        const sandbox = await Sandbox.get({
          name: options.name,
          resume: false,
          ...(options.onResume === undefined ? {} : { onResume: options.onResume }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (options.resume ?? false) await sandbox.#ensureRunning();
        return sandbox;
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
    }

    try {
      return await Sandbox.#create(options, options.onCreate, options.onResume);
    } catch (error) {
      if (!(error instanceof SandboxAlreadyExistsError) || options.name === undefined) throw error;
      const sandbox = await Sandbox.get({
        name: options.name,
        resume: false,
        ...(options.onResume === undefined ? {} : { onResume: options.onResume }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (options.resume ?? false) await sandbox.#ensureRunning();
      return sandbox;
    }
  }

  static async #create(
    options: SandboxCreateOptions,
    onCreate?: (sandbox: Sandbox) => Promise<void>,
    onResume?: (sandbox: Sandbox) => Promise<void>,
  ): Promise<Sandbox> {
    const normalized = normalizeCreateOptions(options);
    await ensureDocker(normalized.signal);
    await ensureImage(normalized.image, normalized.signal);
    const createdAt = new Date();
    const exposedPorts = Object.fromEntries(normalized.ports.map((port) => [`${port}/tcp`, {}]));
    const portBindings = Object.fromEntries(
      normalized.ports.map((port) => [`${port}/tcp`, [{ HostIp: "127.0.0.1", HostPort: "" }]]),
    );

    let container: Dockerode.Container;
    try {
      container = await docker.createContainer({
        name: dockerContainerName(normalized.name),
        Image: normalized.image,
        Entrypoint: ["node"],
        Cmd: ["--input-type=module", "-e", WATCHDOG, String(normalized.timeout)],
        WorkingDir: WORKSPACE,
        Env: Object.entries(normalized.env).map(([key, value]) => `${key}=${value}`),
        Labels: {
          [`${LABEL_PREFIX}.managed`]: "true",
          [`${LABEL_PREFIX}.name`]: normalized.name,
          [`${LABEL_PREFIX}.persistent`]: String(normalized.persistent),
          [`${LABEL_PREFIX}.image`]: normalized.image,
          [`${LABEL_PREFIX}.timeout`]: String(normalized.timeout),
          [`${LABEL_PREFIX}.created`]: createdAt.toISOString(),
          [`${LABEL_PREFIX}.ports`]: JSON.stringify(normalized.ports),
        },
        ExposedPorts: exposedPorts,
        HostConfig: {
          AutoRemove: !normalized.persistent,
          NetworkMode: "bridge",
          PortBindings: portBindings,
          SecurityOpt: ["no-new-privileges"],
        },
        ...(normalized.signal === undefined ? {} : { abortSignal: normalized.signal }),
      });
    } catch (error) {
      if (isConflict(error)) throw new SandboxAlreadyExistsError(normalized.name, error);
      translateDockerError(error);
    }

    let sandbox: Sandbox | undefined;
    try {
      await container.start(normalized.signal === undefined ? undefined : { abortSignal: normalized.signal });
      await Sandbox.#waitUntilReady(container, normalized.image, normalized.signal);
      const info = await container.inspect();
      sandbox = new Sandbox(
        container,
        {
          name: normalized.name,
          image: normalized.image,
          ports: normalized.ports,
          timeout: normalized.timeout,
          persistent: normalized.persistent,
          createdAt,
        },
        info,
        onResume,
      );
      await sandbox.#refreshRunningDetails(info);
      if (onCreate !== undefined) await onCreate(sandbox);
      return sandbox;
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      if (normalized.signal?.aborted) throw error;
      if (error instanceof DockerUnavailableError) throw error;
      if (sandbox !== undefined && onCreate !== undefined) throw error;
      throw new UnsupportedImageError(normalized.image, error);
    }
  }

  static async #waitUntilReady(
    container: Dockerode.Container,
    image: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      try {
        const result = await rawExec(container, {
          cmd: ["/bin/sh", "-c", "test -f /tmp/localbox/deadline && command -v node >/dev/null"],
          ...(signal === undefined ? {} : { signal }),
        });
        if (result.exitCode === 0) return;
      } catch (error) {
        lastError = error;
      }
      await delay(25);
    }
    throw new UnsupportedImageError(image, lastError);
  }

  get status(): SandboxStatus {
    return this.#status;
  }

  get expiresAt(): Date | undefined {
    return this.#expiresAt === undefined ? undefined : new Date(this.#expiresAt);
  }

  async refresh(): Promise<SandboxStatus> {
    if (this.#deleted) return this.#status;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let info: Dockerode.ContainerInspectInfo;
      try {
        info = await this.#container.inspect();
      } catch (error) {
        if (isNotFound(error)) {
          if (!this.persistent && this.#status !== "running") {
            this.#status = "stopped";
            this.#expiresAt = undefined;
            return this.#status;
          }
          throw new SandboxNotFoundError(this.name, error);
        }
        translateDockerError(error);
      }
      this.#status = mapStatus(info);
      this.#portMap = portMapFromInspect(info, this.ports);
      if (this.#status !== "running") {
        this.#expiresAt = undefined;
        return this.#status;
      }
      try {
        await this.#refreshRunningDetails(info);
        return this.#status;
      } catch (error) {
        if (dockerStatus(error) !== 409 || attempt === 1) throw error;
      }
    }
    return this.#status;
  }

  domain(port: number): string {
    if (!this.ports.includes(port)) throw new PortNotExposedError(this.name, port);
    const hostPort = this.#portMap.get(port);
    if (hostPort === undefined) throw new PortNotExposedError(this.name, port);
    return `http://127.0.0.1:${hostPort}`;
  }

  async extendTimeout(duration: number, options: SignalOptions = {}): Promise<void> {
    if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration <= 0) {
      throw new InvalidSandboxOptionsError("Timeout extension must be a positive finite integer in milliseconds.");
    }
    throwIfAborted(options.signal);
    await this.#ensureRunning();
    const extension = this.#extension.then(async () => {
      const result = await rawExec(this.#container, {
        cmd: ["node", "--input-type=module", "-e", EXTEND_DEADLINE, String(duration)],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (result.exitCode !== 0) throw new Error(`Could not extend timeout for sandbox "${this.name}".`);
      this.#expiresAt = new Date(Number(result.stdout.toString("utf8")));
    });
    this.#extension = extension.then(() => undefined, () => undefined);
    await extension;
  }

  runCommand(cmd: string, args?: string[], options?: SignalOptions): Promise<CommandFinished>;
  runCommand(options: CommandRunOptions & { detached: true }): Promise<Command>;
  runCommand(options: CommandRunOptions & { detached?: false }): Promise<CommandFinished>;
  async runCommand(
    cmdOrOptions: string | CommandRunOptions,
    args: string[] = [],
    stringOptions: SignalOptions = {},
  ): Promise<Command | CommandFinished> {
    const options: CommandRunOptions = typeof cmdOrOptions === "string"
      ? { cmd: cmdOrOptions, args, ...stringOptions }
      : cmdOrOptions;
    throwIfAborted(options.signal);
    if (options.cmd.length === 0 || options.cmd.includes("\0")) {
      throw new TypeError("Command name must be non-empty and cannot contain NUL bytes.");
    }
    const cwd = resolveContainerPath(options.cwd ?? WORKSPACE);
    const container = await this.#ensureRunning();
    const info = await container.inspect();
    const environment = new Map<string, string>();
    for (const entry of info.Config.Env ?? []) {
      const separator = entry.indexOf("=");
      if (separator >= 0) environment.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
    for (const [key, value] of Object.entries(options.env ?? {})) environment.set(key, value);
    const command = await startCommand(container, {
      cmd: [options.cmd, ...(options.args ?? [])],
      cwd,
      env: [...environment].map(([key, value]) => `${key}=${value}`),
      ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
      ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (options.detached === true) return command;
    return command.wait(options.signal === undefined ? {} : { signal: options.signal });
  }

  async stop(options: SignalOptions = {}): Promise<void> {
    this.#assertUsable();
    throwIfAborted(options.signal);
    await this.#withLifecycle(async () => {
      let info: Dockerode.ContainerInspectInfo;
      try {
        info = await this.#container.inspect();
      } catch (error) {
        if (isNotFound(error) && !this.persistent) {
          this.#status = "stopped";
          this.#expiresAt = undefined;
          return;
        }
        if (isNotFound(error)) throw new SandboxNotFoundError(this.name, error);
        translateDockerError(error);
      }
      if (!info.State.Running) {
        this.#status = mapStatus(info);
        this.#expiresAt = undefined;
        return;
      }
      this.#status = "stopping";
      try {
        await this.#container.stop(options.signal === undefined ? undefined : { abortSignal: options.signal });
      } catch (error) {
        if (!isNotFound(error)) translateDockerError(error);
      }
      if (!this.persistent) {
        const removalDeadline = Date.now() + 5_000;
        while (Date.now() < removalDeadline) {
          throwIfAborted(options.signal);
          try {
            await this.#container.inspect();
          } catch (error) {
            if (isNotFound(error)) break;
            translateDockerError(error);
          }
          await delay(10);
        }
        try {
          await this.#container.remove({ force: true });
        } catch (error) {
          if (!isNotFound(error)) translateDockerError(error);
        }
      }
      this.#status = "stopped";
      this.#expiresAt = undefined;
    });
  }

  async delete(options: SignalOptions = {}): Promise<void> {
    if (this.#deleted) return;
    throwIfAborted(options.signal);
    await this.#withLifecycle(async () => {
      if (this.#deleted) return;
      try {
        await this.#container.remove({ force: true });
      } catch (error) {
        if (!isNotFound(error)) translateDockerError(error);
      }
      this.#deleted = true;
      this.#status = "stopped";
      this.#expiresAt = undefined;
      this.#portMap.clear();
    });
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
      await this.fs.writeFile(file.path, file.content, operationOptions);
      if (file.mode !== undefined) await this.fs.chmod(file.path, file.mode, operationOptions);
    }
  }

  async readFile(
    src: SandboxPath,
    options: SignalOptions = {},
  ): Promise<NodeJS.ReadableStream | null> {
    throwIfAborted(options.signal);
    const path = resolveContainerPath(src.path, src.cwd);
    if (!(await this.fs.exists(path, options.signal === undefined ? {} : { signal: options.signal }))) {
      return null;
    }
    const container = await this.#ensureRunning();
    const exec = await container.exec({
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: [
        "node",
        "--input-type=module",
        "-e",
        'import { createReadStream } from "node:fs"; createReadStream(process.argv[1]).pipe(process.stdout);',
        path,
      ],
      WorkingDir: WORKSPACE,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    const stream = await exec.start({
      Detach: false,
      Tty: false,
      hijack: true,
      stdin: false,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    const output = new PassThrough();
    const stderr: Buffer[] = [];
    const errorSink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stderr.push(Buffer.from(chunk));
        callback();
      },
    });
    docker.modem.demuxStream(stream, output, errorSink);

    let settled = false;
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", abort);
      stream.off("end", finish);
      stream.off("close", finish);
      stream.off("error", fail);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = abortError();
      stream.destroy(error);
      output.destroy(error);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      output.destroy(error);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void exec.inspect().then((info) => {
        if ((info.ExitCode ?? 0) === 0) {
          output.end();
          return;
        }
        const message = Buffer.concat(stderr).toString("utf8").trim();
        output.destroy(new Error(message.length > 0 ? message : `Could not read \"${path}\".`));
      }, (error: unknown) => {
        output.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", fail);
    return output;
  }

  async readFileToBuffer(
    src: SandboxPath,
    options: SignalOptions = {},
  ): Promise<Buffer | null> {
    try {
      return await this.fs.readFile(
        resolveContainerPath(src.path, src.cwd),
        options.signal === undefined ? {} : { signal: options.signal },
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
    let contents: Buffer;
    try {
      contents = await this.fs.readFile(
        resolveContainerPath(src.path, src.cwd),
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const destination = resolveLocalPath(dst.cwd ?? process.cwd(), dst.path);
    if (options.mkdirRecursive ?? false) await localFs.mkdir(dirname(destination), { recursive: true });
    await localFs.writeFile(destination, contents, options.signal === undefined ? undefined : { signal: options.signal });
    return destination;
  }

  #assertUsable(): void {
    if (this.#deleted) throw new SandboxDeletedError(this.name);
  }

  #withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#lifecycle.then(operation, operation);
    this.#lifecycle = run.then(() => undefined, () => undefined);
    return run;
  }

  async #ensureRunning(): Promise<Dockerode.Container> {
    this.#assertUsable();
    if (resumeContext.getStore() === this && this.#status === "running") return this.#container;
    if (this.#resumePromise !== undefined) return this.#resumePromise;

    const resume = this.#withLifecycle(async () => {
      this.#assertUsable();
      let info: Dockerode.ContainerInspectInfo;
      try {
        info = await this.#container.inspect();
      } catch (error) {
        if (isNotFound(error)) throw new SandboxNotFoundError(this.name, error);
        translateDockerError(error);
      }
      this.#status = mapStatus(info);
      if (info.State.Running) {
        await this.#refreshRunningDetails(info);
        return this.#container;
      }
      if (!this.persistent) throw new SandboxNotFoundError(this.name);

      this.#status = "pending";
      try {
        await this.#container.start();
      } catch (error) {
        if (dockerStatus(error) !== 304) translateDockerError(error);
      }
      await Sandbox.#waitUntilReady(this.#container, this.image);
      info = await this.#container.inspect();
      this.#status = "running";
      await this.#refreshRunningDetails(info);
      if (this.#onResume !== undefined) {
        try {
          await resumeContext.run(this, async () => this.#onResume?.(this));
        } catch (error) {
          await this.#container.stop().catch(() => undefined);
          this.#status = "stopped";
          this.#expiresAt = undefined;
          throw error;
        }
      }
      return this.#container;
    });
    this.#resumePromise = resume;
    void resume.finally(() => {
      if (this.#resumePromise === resume) this.#resumePromise = undefined;
    }).catch(() => undefined);
    return resume;
  }

  async #refreshRunningDetails(info: Dockerode.ContainerInspectInfo): Promise<void> {
    this.#portMap = portMapFromInspect(info, this.ports);
    const deadline = await rawExec(this.#container, {
      cmd: ["node", "-e", 'process.stdout.write(require("node:fs").readFileSync("/tmp/localbox/deadline", "utf8"))'],
    });
    if (deadline.exitCode === 0) this.#expiresAt = new Date(Number(deadline.stdout.toString("utf8")));
  }
}
