import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type Dockerode from "dockerode";
import { validateBootArtifact } from "../../runtime/artifacts.js";
import type {
  OciImageBootArtifact,
  RawCommand,
  SourceErrorStage,
} from "../../runtime/index.js";
import { startRawCommand, type StartRawCommandOptions } from "./command.js";
import {
  dockerStatus,
  ensureDocker,
  ensureImage,
  isConflict,
  isNotFound,
  rawExec,
  throwIfAborted,
  translateDockerError,
} from "./docker.js";
import {
  DockerBackendError,
  InvalidSandboxOptionsError,
  PortNotExposedError,
  SandboxAlreadyExistsError,
  SandboxDeletedError,
  SandboxNotFoundError,
  SandboxSourceError,
  UnsupportedImageError,
  UnsupportedSandboxCapabilityError,
} from "./errors.js";
import type {
  SandboxCreateOptions,
  SandboxGetOptions,
  SandboxGetOrCreateOptions,
  SandboxListItem,
  SandboxListOptions,
  SandboxListPage,
  SandboxListResult,
  SandboxSource,
  SandboxStatus,
} from "./types.js";

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

const GIT_ASKPASS = String.raw`#!/bin/sh
case "$1" in
  *sername*) printf '%s\n' "$LOCALBOX_GIT_USERNAME" ;;
  *) printf '%s\n' "$LOCALBOX_GIT_PASSWORD" ;;
esac
`;

const EXTRACT_TARBALL = String.raw`
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
const [url, workspace] = process.argv.slice(1);
const archive = "/tmp/localbox-source-" + process.pid + ".tar";
try {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error("Source download returned HTTP " + response.status);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { mode: 0o600 }));
  const listing = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(listing.stderr || "Could not inspect source archive");
  for (const entry of listing.stdout.split("\n").filter(Boolean)) {
    const normalized = posix.normalize(entry);
    if (posix.isAbsolute(entry) || normalized === ".." || normalized.startsWith("../")) {
      throw new Error("Source archive contains a path outside the workspace");
    }
  }
  const extracted = spawnSync("tar", ["-xf", archive, "-C", workspace], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr || "Could not extract source archive");
} finally {
  await rm(archive, { force: true });
}
`;

type MaterializableSource = Exclude<SandboxSource, { type: "snapshot" }>;

interface NormalizedCreateOptions {
  name: string;
  image: string;
  bootArtifact: OciImageBootArtifact;
  runtime?: string;
  ports: number[];
  timeout: number;
  env: Record<string, string>;
  tags: Record<string, string>;
  region?: string;
  failoverRegions: string[];
  persistent: boolean;
  networkMode: "bridge" | "none";
  disconnectNetworkAfterSource: boolean;
  source?: MaterializableSource;
  vcpus?: number;
  memoryBytes?: number;
  signal?: AbortSignal;
}

interface SandboxMetadata {
  name: string;
  image: string;
  bootArtifact: OciImageBootArtifact;
  runtime?: string;
  ports: number[];
  timeout: number;
  persistent: boolean;
  tags: Record<string, string>;
  region?: string;
  failoverRegions: string[];
  vcpus?: number;
  memoryBytes?: number;
  createdAt: Date;
}

interface SignalOptions {
  signal?: AbortSignal;
}

interface StopOptions extends SignalOptions {
  ephemeralStrategy?: "stop-then-remove" | "remove";
}


interface DockerPortBinding {
  HostIp?: string;
  HostPort?: string;
}

export function containerEngineContainerName(name: string): string {
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

function validateOptionalText(value: string | undefined, field: string): void {
  if (value !== undefined && (value.trim().length === 0 || value.includes("\0"))) {
    throw new InvalidSandboxOptionsError(`${field} must not be empty or contain NUL.`);
  }
}

function normalizeSource(source: SandboxSource | undefined): MaterializableSource | undefined {
  if (source === undefined) return undefined;
  if (source.type === "snapshot") {
    throw new UnsupportedSandboxCapabilityError("snapshot sources");
  }
  if (source.type === "git") {
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
    return source;
  }
  if (source.type === "tarball") {
    validateOptionalText(source.url, "Tarball source URL");
    return source;
  }
  throw new InvalidSandboxOptionsError("Sandbox source type is invalid.");
}
function normalizeCreateOptions(options: SandboxCreateOptions): NormalizedCreateOptions {
  const name = options.name ?? `localbox-${randomUUID()}`;
  validateName(name);
  const validation = validateBootArtifact(options.bootArtifact);
  if (!validation.ok || validation.artifact.kind !== "oci-image") {
    throw new InvalidSandboxOptionsError("Container-engine sandbox boot artifact must be a valid OCI image.");
  }
  const bootArtifact = validation.artifact;
  const image = bootArtifact.locator.reference;
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
  for (const [key, value] of Object.entries(env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0") || key.startsWith("LOCALBOX_")) {
      throw new InvalidSandboxOptionsError(
        `Invalid environment key "${key}". Keys must be non-empty, omit = and NUL, and not use LOCALBOX_.`,
      );
    }
    if (value.includes("\0")) {
      throw new InvalidSandboxOptionsError(`Environment value for "${key}" must not contain NUL.`);
    }
  }

  const tags = { ...options.tags };
  if (Object.keys(tags).length > 5) {
    throw new InvalidSandboxOptionsError("A sandbox can have at most 5 tags.");
  }
  for (const [key, value] of Object.entries(tags)) {
    if (key.trim().length === 0 || key.includes("\0") || value.includes("\0")) {
      throw new InvalidSandboxOptionsError("Sandbox tag keys must be non-empty and tag values must omit NUL.");
    }
  }

  const region = options.region;
  validateOptionalText(region, "Sandbox region");
  const failoverRegions = options.failoverRegions === undefined ? [] : [...options.failoverRegions];
  for (const failoverRegion of failoverRegions) validateOptionalText(failoverRegion, "Sandbox failover region");
  if (new Set(failoverRegions).size !== failoverRegions.length) {
    throw new InvalidSandboxOptionsError("Sandbox failover regions must be unique.");
  }
  if (region !== undefined && failoverRegions.includes(region)) {
    throw new InvalidSandboxOptionsError("Sandbox failover regions must not include the primary region.");
  }

  if (options.mounts !== undefined && Object.keys(options.mounts).length > 0) {
    throw new UnsupportedSandboxCapabilityError("drive mounts");
  }
  if (options.snapshotExpiration !== undefined || options.keepLastSnapshots !== undefined) {
    throw new UnsupportedSandboxCapabilityError("snapshot retention");
  }
  if (typeof options.networkPolicy === "object") {
    throw new UnsupportedSandboxCapabilityError("custom network policies");
  }

  const vcpus = options.resources?.vcpus;
  if (vcpus !== undefined && (!Number.isFinite(vcpus) || !Number.isInteger(vcpus) || vcpus <= 0)) {
    throw new InvalidSandboxOptionsError("Sandbox vCPUs must be a positive finite integer.");
  }
  const source = normalizeSource(options.source);
  const denyNetwork = options.networkPolicy === "deny-all";
  if (denyNetwork && ports.length > 0) {
    throw new UnsupportedSandboxCapabilityError("simultaneous deny-all networking and exposed ports");
  }
  throwIfAborted(options.signal);
  return {
    name,
    image,
    bootArtifact,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ports,
    timeout,
    env,
    tags,
    ...(region === undefined ? {} : { region }),
    failoverRegions,
    persistent: options.persistent ?? true,
    networkMode: denyNetwork && source === undefined ? "none" : "bridge",
    disconnectNetworkAfterSource: denyNetwork && source !== undefined,
    ...(source === undefined ? {} : { source }),
    ...(vcpus === undefined
      ? {}
      : {
          vcpus,
          memoryBytes: vcpus * 2_048 * 1_048_576,
        }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

async function runSourceCommand(
  docker: Dockerode,
  container: Dockerode.Container,
  sourceType: "git" | "tarball",
  options: {
    stage: SourceErrorStage;
    redactions: readonly string[];
    cmd: string[];
    env?: string[];
    stdin?: Buffer;
    user?: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  try {
    const result = await rawExec(docker, container, options);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      const cause = new Error(stderr || `Source command exited with ${result.exitCode}.`);
      throw new SandboxSourceError(sourceType, options.stage, cause, {
        exitCode: result.exitCode,
        redactions: options.redactions,
      });
    }
  } catch (error) {
    if (error instanceof SandboxSourceError) throw error;
    throw new SandboxSourceError(sourceType, options.stage, error, {
      redactions: options.redactions,
    });
  }
}

async function clearWorkspace(
  docker: Dockerode,
  container: Dockerode.Container,
  sourceType: "git" | "tarball",
  user: string | undefined,
  redactions: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  await runSourceCommand(docker, container, sourceType, {
    stage: "clear-workspace",
    redactions,
    cmd: [
      "/bin/sh",
      "-c",
      `find ${WORKSPACE} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
    ],
    ...(user === undefined ? {} : { user }),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function materializeGitSource(
  docker: Dockerode,
  container: Dockerode.Container,
  source: Extract<MaterializableSource, { type: "git" }>,
  user: string | undefined,
  redactions: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const authenticated = "username" in source;
  const askpassPath = "/tmp/localbox-git-askpass";
  const env = [
    "GIT_TERMINAL_PROMPT=0",
    ...(authenticated
      ? [
          `GIT_ASKPASS=${askpassPath}`,
          "GIT_ASKPASS_REQUIRE=force",
          `LOCALBOX_GIT_USERNAME=${source.username}`,
          `LOCALBOX_GIT_PASSWORD=${source.password}`,
        ]
      : []),
  ];
  try {
    if (authenticated) {
      await runSourceCommand(docker, container, "git", {
        stage: "prepare-authentication",
        redactions,
        cmd: ["/bin/sh", "-c", `cat > ${askpassPath} && chmod 0700 ${askpassPath}`],
        stdin: Buffer.from(GIT_ASKPASS),
        ...(user === undefined ? {} : { user }),
        ...(signal === undefined ? {} : { signal }),
      });
    }
    if (source.revision === undefined) {
      await runSourceCommand(docker, container, "git", {
        stage: "clone",
        redactions,
        cmd: [
          "git",
          "clone",
          ...(source.depth === undefined ? [] : [`--depth=${source.depth}`]),
          "--",
          source.url,
          WORKSPACE,
        ],
        env,
        ...(user === undefined ? {} : { user }),
        ...(signal === undefined ? {} : { signal }),
      });
      return;
    }

    await runSourceCommand(docker, container, "git", {
      stage: "initialize",
      redactions,
      cmd: ["git", "-C", WORKSPACE, "init"],
      env,
      ...(user === undefined ? {} : { user }),
      ...(signal === undefined ? {} : { signal }),
    });
    await runSourceCommand(docker, container, "git", {
      stage: "configure-remote",
      redactions,
      cmd: ["git", "-C", WORKSPACE, "remote", "add", "origin", source.url],
      env,
      ...(user === undefined ? {} : { user }),
      ...(signal === undefined ? {} : { signal }),
    });
    await runSourceCommand(docker, container, "git", {
      stage: "fetch",
      redactions,
      cmd: [
        "git",
        "-C",
        WORKSPACE,
        "fetch",
        "--no-tags",
        ...(source.depth === undefined ? [] : [`--depth=${source.depth}`]),
        "origin",
        source.revision,
      ],
      env,
      ...(user === undefined ? {} : { user }),
      ...(signal === undefined ? {} : { signal }),
    });
    await runSourceCommand(docker, container, "git", {
      stage: "checkout",
      redactions,
      cmd: ["git", "-C", WORKSPACE, "checkout", "--detach", "FETCH_HEAD"],
      env,
      ...(user === undefined ? {} : { user }),
      ...(signal === undefined ? {} : { signal }),
    });
  } finally {
    if (authenticated) {
      await rawExec(docker, container, {
        cmd: ["rm", "-f", askpassPath],
        ...(user === undefined ? {} : { user }),
        ...(signal === undefined ? {} : { signal }),
      }).catch(() => undefined);
    }
  }
}

async function materializeSource(
  docker: Dockerode,
  container: Dockerode.Container,
  source: MaterializableSource,
  signal?: AbortSignal,
): Promise<void> {
  const redactions = "username" in source
    ? [source.url, source.username, source.password]
    : [source.url];
  const info = await container.inspect(
    signal === undefined ? undefined : { abortSignal: signal },
  ).catch((error: unknown) => {
    throw new SandboxSourceError(source.type, "inspect-container", error, { redactions });
  });
  const configuredUser = info.Config.User ?? "";
  const user = configuredUser.length === 0 ? undefined : configuredUser;
  await clearWorkspace(docker, container, source.type, user, redactions, signal);
  if (source.type === "git") {
    await materializeGitSource(docker, container, source, user, redactions, signal);
    return;
  }
  await runSourceCommand(docker, container, "tarball", {
    stage: "extract",
    redactions,
    cmd: ["node", "--input-type=module", "-e", EXTRACT_TARBALL, source.url, WORKSPACE],
    ...(user === undefined ? {} : { user }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function bootArtifactFromLabels(
  labels: Readonly<Record<string, string>>,
  image: string,
): OciImageBootArtifact {
  const serialized = labels[`${LABEL_PREFIX}.bootArtifact`];
  if (serialized === undefined) {
    const digestMatch = image.match(/@sha256:([a-f0-9]{64})$/);
    return {
      kind: "oci-image",
      locator: { type: "oci-reference", reference: image },
      digest: digestMatch === null
        ? null
        : { algorithm: "sha256", value: digestMatch[1]! },
      trust: "untrusted",
      mutability: digestMatch === null ? "mutable" : "immutable",
      platform: null,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new InvalidSandboxOptionsError("Container-engine sandbox boot artifact metadata is corrupt.");
  }
  const validation = validateBootArtifact(value);
  if (
    !validation.ok ||
    validation.artifact.kind !== "oci-image" ||
    validation.artifact.locator.reference !== image
  ) {
    throw new InvalidSandboxOptionsError("Container-engine sandbox boot artifact metadata is invalid.");
  }
  return validation.artifact;
}

function metadataFromInspect(name: string, info: Dockerode.ContainerInspectInfo): SandboxMetadata {
  const labels = info.Config.Labels;
  if (labels[`${LABEL_PREFIX}.managed`] !== "true" || labels[`${LABEL_PREFIX}.name`] !== name) {
    throw new SandboxNotFoundError(name);
  }
  const timeout = Number(labels[`${LABEL_PREFIX}.timeout`]);
  const ports = JSON.parse(labels[`${LABEL_PREFIX}.ports`] ?? "[]") as number[];
  const tags = JSON.parse(labels[`${LABEL_PREFIX}.tags`] ?? "{}") as Record<string, string>;
  const failoverRegions = JSON.parse(labels[`${LABEL_PREFIX}.failoverRegions`] ?? "[]") as string[];
  const nanoCpus = info.HostConfig.NanoCpus ?? 0;
  const memoryBytes = info.HostConfig.Memory ?? 0;
  const image = labels[`${LABEL_PREFIX}.image`] ?? info.Config.Image;
  return {
    name,
    image,
    bootArtifact: bootArtifactFromLabels(labels, image),
    ...(labels[`${LABEL_PREFIX}.runtime`] === undefined
      ? {}
      : { runtime: labels[`${LABEL_PREFIX}.runtime`] }),
    ports,
    timeout,
    persistent: labels[`${LABEL_PREFIX}.persistent`] === "true",
    tags,
    ...(labels[`${LABEL_PREFIX}.region`] === undefined
      ? {}
      : { region: labels[`${LABEL_PREFIX}.region`] }),
    failoverRegions,
    ...(nanoCpus > 0 ? { vcpus: nanoCpus / 1_000_000_000 } : {}),
    ...(memoryBytes > 0 ? { memoryBytes } : {}),
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

async function inspectNamedContainer(docker: Dockerode, name: string, signal?: AbortSignal): Promise<{
  container: Dockerode.Container;
  info: Dockerode.ContainerInspectInfo;
}> {
  const container = docker.getContainer(containerEngineContainerName(name));
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
  const tags = Object.keys(metadata.tags).length === 0 ? undefined : metadata.tags;
  const nanoCpus = info.HostConfig.NanoCpus ?? 0;
  const memoryBytes = info.HostConfig.Memory ?? 0;
  const endpoints = [...portMapFromInspect(info, metadata.ports)].map(([port, hostPort]) => ({
    port,
    url: `http://127.0.0.1:${hostPort}`,
  }));
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
    bootArtifact: metadata.bootArtifact,
    ...(metadata.runtime === undefined ? {} : { runtime: metadata.runtime }),
    ports: [...metadata.ports],
    endpoints,
    ...(metadata.region === undefined ? {} : { region: metadata.region }),
    failoverRegions: [...metadata.failoverRegions],
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
  readonly bootArtifact: OciImageBootArtifact;
  readonly runtime: string | undefined;
  readonly ports: readonly number[];
  readonly timeout: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly region: string;
  readonly failoverRegions: readonly string[];
  readonly vcpus: number | undefined;
  readonly memory: number | undefined;
  readonly createdAt: Date;
  readonly #docker: Dockerode;
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
    docker: Dockerode,
    container: Dockerode.Container,
    metadata: SandboxMetadata,
    info: Dockerode.ContainerInspectInfo,
    onResume?: (sandbox: Sandbox) => Promise<void>,
  ) {
    this.#docker = docker;
    this.#container = container;
    this.name = metadata.name;
    this.persistent = metadata.persistent;
    this.image = metadata.image;
    this.bootArtifact = metadata.bootArtifact;
    this.runtime = metadata.runtime;
    this.ports = Object.freeze([...metadata.ports]);
    this.timeout = metadata.timeout;
    this.tags = Object.freeze({ ...metadata.tags });
    this.region = metadata.region ?? "local";
    this.failoverRegions = Object.freeze([...metadata.failoverRegions]);
    this.vcpus = metadata.vcpus;
    this.memory = metadata.memoryBytes === undefined ? undefined : metadata.memoryBytes / 1_048_576;
    this.createdAt = metadata.createdAt;
    this.#status = mapStatus(info);
    this.#portMap = portMapFromInspect(info, this.ports);
    this.#onResume = onResume;
  }

  static async list(docker: Dockerode, options: SandboxListOptions = {}): Promise<SandboxListResult> {
    throwIfAborted(options.signal);
    await ensureDocker(docker, options.signal);
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
    const tagFilters = Object.entries(options.tags ?? {});
    const items = inspected
      .filter((info): info is Dockerode.ContainerInspectInfo => info !== undefined)
      .map(listItemFromInspect)
      .filter((item) => options.namePrefix === undefined || item.name.startsWith(options.namePrefix))
      .filter((item) => tagFilters.every(([key, value]) => item.tags?.[key] === value));
    const direction = options.sortOrder === "asc" ? 1 : -1;
    const sortBy = options.sortBy ?? "createdAt";
    items.sort((left, right) => {
      const leftValue = sortBy === "name" ? left.name : left[sortBy] ?? 0;
      const rightValue = sortBy === "name" ? right.name : right[sortBy] ?? 0;
      return leftValue < rightValue ? -direction : leftValue > rightValue ? direction : 0;
    });
    return sandboxPaginator(items, limit, start);
  }

  static async create(docker: Dockerode, options: SandboxCreateOptions): Promise<Sandbox> {
    return Sandbox.#create(docker, options, undefined, options.onResume);
  }

  static async get(docker: Dockerode, options: SandboxGetOptions): Promise<Sandbox> {
    validateName(options.name);
    throwIfAborted(options.signal);
    await ensureDocker(docker, options.signal);
    const { container, info } = await inspectNamedContainer(docker, options.name, options.signal);
    const sandbox = new Sandbox(docker, container, metadataFromInspect(options.name, info), info, options.onResume);
    if (options.resume ?? false) await sandbox.#ensureRunning();
    return sandbox;
  }

  static async getOrCreate(docker: Dockerode, options: SandboxGetOrCreateOptions): Promise<Sandbox> {
    if (options.name !== undefined) validateName(options.name);
    throwIfAborted(options.signal);
    if (options.name !== undefined) {
      try {
        const sandbox = await Sandbox.get(docker, {
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
      return await Sandbox.#create(docker, options, options.onCreate, options.onResume);
    } catch (error) {
      if (!(error instanceof SandboxAlreadyExistsError) || options.name === undefined) throw error;
      const sandbox = await Sandbox.get(docker, {
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
    docker: Dockerode,
    options: SandboxCreateOptions,
    onCreate?: (sandbox: Sandbox) => Promise<void>,
    onResume?: (sandbox: Sandbox) => Promise<void>,
  ): Promise<Sandbox> {
    const normalized = normalizeCreateOptions(options);
    await ensureDocker(docker, normalized.signal);
    await ensureImage(docker, normalized.image, normalized.signal);
    const createdAt = new Date();
    const exposedPorts = Object.fromEntries(normalized.ports.map((port) => [`${port}/tcp`, {}]));
    const portBindings = Object.fromEntries(
      normalized.ports.map((port) => [`${port}/tcp`, [{ HostIp: "127.0.0.1", HostPort: "" }]]),
    );

    let container: Dockerode.Container;
    try {
      container = await docker.createContainer({
        name: containerEngineContainerName(normalized.name),
        Image: normalized.image,
        Entrypoint: ["node"],
        Cmd: ["--input-type=module", "-e", WATCHDOG, String(normalized.timeout)],
        WorkingDir: "/vercel",
        Env: Object.entries(normalized.env).map(([key, value]) => `${key}=${value}`),
        Labels: {
          [`${LABEL_PREFIX}.managed`]: "true",
          [`${LABEL_PREFIX}.name`]: normalized.name,
          [`${LABEL_PREFIX}.persistent`]: String(normalized.persistent),
          [`${LABEL_PREFIX}.image`]: normalized.image,
          [`${LABEL_PREFIX}.bootArtifact`]: JSON.stringify(normalized.bootArtifact),
          [`${LABEL_PREFIX}.timeout`]: String(normalized.timeout),
          [`${LABEL_PREFIX}.created`]: createdAt.toISOString(),
          [`${LABEL_PREFIX}.ports`]: JSON.stringify(normalized.ports),
          [`${LABEL_PREFIX}.tags`]: JSON.stringify(normalized.tags),
          [`${LABEL_PREFIX}.failoverRegions`]: JSON.stringify(normalized.failoverRegions),
          ...(normalized.runtime === undefined
            ? {}
            : { [`${LABEL_PREFIX}.runtime`]: normalized.runtime }),
          ...(normalized.region === undefined
            ? {}
            : { [`${LABEL_PREFIX}.region`]: normalized.region }),
        },
        ExposedPorts: exposedPorts,
        HostConfig: {
          AutoRemove: !normalized.persistent,
          NetworkMode: normalized.networkMode,
          PortBindings: portBindings,
          SecurityOpt: ["no-new-privileges"],
          ...(normalized.vcpus === undefined
            ? {}
            : {
                NanoCpus: normalized.vcpus * 1_000_000_000,
                Memory: normalized.vcpus * 2_048 * 1_048_576,
              }),
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
      await Sandbox.#waitUntilReady(docker, container, normalized.image, normalized.signal);
      if (normalized.source !== undefined) {
        await materializeSource(docker, container, normalized.source, normalized.signal);
      }
      if (normalized.disconnectNetworkAfterSource) {
        try {
          const attached = await container.inspect();
          const networks = Object.entries(attached.NetworkSettings.Networks ?? {});
          await Promise.all(networks.map(async ([networkName, network]) => {
            const networkId = typeof network.NetworkID === "string" &&
                network.NetworkID.length > 0
              ? network.NetworkID
              : networkName;
            if (networkId.length === 0) {
              throw new Error("The attached network has no stable engine identifier.");
            }
            await docker.getNetwork(networkId).disconnect({
              Container: container.id,
              Force: true,
            });
          }));
        } catch {
          throw new UnsupportedSandboxCapabilityError(
            "deny-all network isolation on this container engine",
          );
        }
      }
      const info = await container.inspect();
      sandbox = new Sandbox(
        docker,
        container,
        metadataFromInspect(normalized.name, info),
        info,
        onResume,
      );
      await sandbox.#refreshRunningDetails(info);
      if (onCreate !== undefined) await onCreate(sandbox);
      return sandbox;
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      if (normalized.signal?.aborted) throw error;
      if (error instanceof DockerBackendError || sandbox !== undefined) throw error;
      throw new UnsupportedImageError(normalized.image, error);
    }
  }

  static async #waitUntilReady(
    docker: Dockerode,
    container: Dockerode.Container,
    image: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      try {
        const result = await rawExec(docker, container, {
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
      const result = await rawExec(this.#docker, this.#container, {
        cmd: ["node", "--input-type=module", "-e", EXTEND_DEADLINE, String(duration)],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (result.exitCode !== 0) throw new Error(`Could not extend timeout for sandbox "${this.name}".`);
      this.#expiresAt = new Date(Number(result.stdout.toString("utf8")));
    });
    this.#extension = extension.then(() => undefined, () => undefined);
    await extension;
  }

  async startRawCommand(options: StartRawCommandOptions): Promise<RawCommand> {
    throwIfAborted(options.signal);
    if (options.cmd.length === 0 || options.cmd[0]?.length === 0 || options.cmd[0]?.includes("\0")) {
      throw new TypeError("Command name must be non-empty and cannot contain NUL bytes.");
    }
    const cwd = resolveContainerPath(options.cwd);
    const container = await this.#ensureRunning();
    const info = await container.inspect();
    const environment = new Map<string, string>();
    for (const entry of info.Config.Env ?? []) {
      const separator = entry.indexOf("=");
      if (separator >= 0) environment.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
    for (const entry of options.env) {
      const separator = entry.indexOf("=");
      if (separator >= 0) environment.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
    return startRawCommand(this.#docker, container, {
      cmd: options.cmd,
      cwd,
      env: [...environment].map(([key, value]) => `${key}=${value}`),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.execSessionNotFound === undefined
        ? {}
        : { execSessionNotFound: options.execSessionNotFound }),
    });
  }

  async stop(options: StopOptions = {}): Promise<void> {
    this.#assertUsable();
    throwIfAborted(options.signal);
    await this.#withLifecycle(async () => {
      if (!this.persistent && options.ephemeralStrategy === "remove") {
        this.#status = "stopping";
        try {
          await this.#container.remove({ force: true });
        } catch (error) {
          if (!isNotFound(error)) translateDockerError(error);
        }
        this.#status = "stopped";
        this.#expiresAt = undefined;
        return;
      }
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
      await Sandbox.#waitUntilReady(this.#docker, this.#container, this.image);
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
    const deadline = await rawExec(this.#docker, this.#container, {
      cmd: ["node", "-e", 'process.stdout.write(require("node:fs").readFileSync("/tmp/localbox/deadline", "utf8"))'],
    });
    if (deadline.exitCode === 0) this.#expiresAt = new Date(Number(deadline.stdout.toString("utf8")));
  }
}
