import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir as platformHomedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateBootArtifact, validateSandboxFrontendMetadata } from "./artifacts.js";
import type { BackendReference, SandboxRecord } from "./index.js";

const STATE_SCHEMA_VERSION = 2 as const;
const LEGACY_STATE_SCHEMA_VERSION = 1 as const;
const STATE_FILE = "state.json";
const OPERATION_LOCK = ".operation";
const LOCK_OWNER_FILE = "owner.json";
const INTERRUPTED_LOCK_GRACE_MS = 5_000;
const MAX_STATE_BYTES = 1_048_576;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TEMP_PATTERN = /^\.state\.[a-f0-9]{64}\.tmp$/;

export interface LocalStateRootOptions {
  readonly root?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homedir?: string;
}

export interface LocalStateOwner {
  readonly pid: number;
  readonly processStartedAt: number;
  readonly processNonce: string;
}

interface OwnershipFields {
  readonly name: string;
  readonly backend: BackendReference;
  readonly token: string;
  readonly owner: LocalStateOwner;
  readonly claimedAt: number;
  readonly updatedAt: number;
}

export interface LocalSandboxClaimRecord extends OwnershipFields {
  readonly schemaVersion: 2;
  readonly kind: "claim";
}

export interface LocalSandboxActiveRecord extends OwnershipFields {
  readonly schemaVersion: 2;
  readonly kind: "active";
  readonly activatedAt: number;
  readonly sandbox: SandboxRecord;
}

export type LocalSandboxStateRecord = LocalSandboxClaimRecord | LocalSandboxActiveRecord;

export interface LocalSandboxClaim {
  readonly name: string;
  readonly digest: string;
  readonly backend: BackendReference;
  readonly token: string;
  readonly owner: LocalStateOwner;
  readonly claimedAt: number;
}

export type LocalSandboxStateInspection =
  | { readonly status: "missing" }
  | { readonly status: "empty"; readonly directoryModifiedAt: number }
  | { readonly status: "corrupt"; readonly directoryModifiedAt: number; readonly reason: string }
  | { readonly status: "record"; readonly directoryModifiedAt: number; readonly record: LocalSandboxStateRecord };

export interface LocalSandboxStateStoreOptions extends LocalStateRootOptions {
  readonly now?: () => number;
  readonly owner?: LocalStateOwner;
}

export class LocalSandboxStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class LocalSandboxStateConflictError extends LocalSandboxStateError {}
export class LocalSandboxStateCorruptionError extends LocalSandboxStateError {}
export class LocalSandboxOwnershipError extends LocalSandboxStateError {}

/**
 * Resolve Localbox's private state root. Relative XDG_STATE_HOME values are
 * ignored as required by the XDG Base Directory specification.
 */
export function resolveLocalStateRoot(options: LocalStateRootOptions = {}): string {
  if (options.root !== undefined) {
    if (!isAbsolute(options.root)) {
      throw new TypeError("The Localbox state root override must be an absolute path.");
    }
    return options.root;
  }
  const environment = options.environment ?? process.env;
  const xdgStateHome = environment.XDG_STATE_HOME;
  if (xdgStateHome !== undefined && isAbsolute(xdgStateHome)) {
    return join(xdgStateHome, "localbox");
  }
  const home = options.homedir ?? platformHomedir();
  if (!isAbsolute(home)) {
    throw new TypeError("The platform home directory must be an absolute path.");
  }
  return join(home, ".local", "state", "localbox");
}

export function sandboxNameDigest(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function processOwner(now: number): LocalStateOwner {
  return {
    pid: process.pid,
    processStartedAt: Math.max(0, Math.floor(now - process.uptime() * 1_000)),
    processNonce: randomToken(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isBackendReference(value: unknown): value is BackendReference {
  return isPlainObject(value) && hasOnlyKeys(value, ["backendId", "backendType"]) &&
    typeof value.backendId === "string" && value.backendId.length > 0 &&
    typeof value.backendType === "string" && value.backendType.length > 0;
}

function sameBackend(left: BackendReference, right: BackendReference): boolean {
  return left.backendId === right.backendId && left.backendType === right.backendType;
}

function isJsonCompatible(value: unknown): boolean {
  const pending: [unknown, boolean][] = [[value, false]];
  const ancestors = new Set<object>();
  while (pending.length > 0) {
    const [current, exiting] = pending.pop()!;
    if (exiting) {
      ancestors.delete(current as object);
      continue;
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object" || ancestors.has(current)) return false;
    ancestors.add(current);
    pending.push([current, true]);
    if (Array.isArray(current)) {
      for (const entry of current) pending.push([entry, false]);
      continue;
    }
    if (!isPlainObject(current)) return false;
    for (const entry of Object.values(current)) pending.push([entry, false]);
  }
  return true;
}

function isSandboxRecord(value: unknown): value is SandboxRecord {
  if (!isPlainObject(value) || !isJsonCompatible(value) || !hasOnlyKeys(value, [
    "sandboxId", "name", "status", "persistent", "bootArtifact", "frontendMetadata", "backend",
    "createdAt", "updatedAt", "statusUpdatedAt", "expiresAt", "timeoutMs", "tags",
    "ports", "endpoints", "resources", "region", "failoverRegions",
  ])) return false;
  const artifactValidation = validateBootArtifact(value.bootArtifact);
  if (!artifactValidation.ok) return false;
  const statuses = ["pending", "running", "stopping", "stopped", "failed"];
  if (typeof value.sandboxId !== "string" || typeof value.name !== "string" ||
      typeof value.status !== "string" || !statuses.includes(value.status) ||
      typeof value.persistent !== "boolean" || !isBackendReference(value.backend) ||
      !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) ||
      !isTimestamp(value.statusUpdatedAt) || !isNullableTimestamp(value.expiresAt) ||
      !isTimestamp(value.timeoutMs) || !isStringRecord(value.tags) ||
      !Array.isArray(value.ports) || !value.ports.every((port) => Number.isSafeInteger(port)) ||
      !Array.isArray(value.failoverRegions) || !value.failoverRegions.every((region) => typeof region === "string") ||
      !(value.region === null || typeof value.region === "string")) return false;
  if (!validateSandboxFrontendMetadata(
    value.frontendMetadata,
    artifactValidation.artifact,
  ).ok) return false;
  const resources = value.resources;
  if (!isPlainObject(resources) || !hasOnlyKeys(resources, ["vcpus", "memoryBytes"]) ||
      !(resources.vcpus === null || typeof resources.vcpus === "number" && Number.isFinite(resources.vcpus)) ||
      !(resources.memoryBytes === null || typeof resources.memoryBytes === "number" && Number.isFinite(resources.memoryBytes))) return false;
  if (!Array.isArray(value.endpoints) || !value.endpoints.every((endpoint) => {
    if (!isPlainObject(endpoint) || !hasOnlyKeys(endpoint, [
      "endpointId", "sandboxId", "port", "protocol", "url", "visibility", "backend",
    ])) return false;
    return typeof endpoint.endpointId === "string" && typeof endpoint.sandboxId === "string" &&
      Number.isSafeInteger(endpoint.port) && (endpoint.protocol === "http" || endpoint.protocol === "https") &&
      typeof endpoint.url === "string" && ["loopback", "private", "public"].includes(endpoint.visibility as string) &&
      isBackendReference(endpoint.backend);
  })) return false;
  return true;
}

function migrateLegacySandboxRecord(value: unknown): SandboxRecord | null {
  if (!isPlainObject(value) || !isJsonCompatible(value) || !hasOnlyKeys(value, [
    "sandboxId", "name", "status", "persistent", "bootSource", "runtime", "backend",
    "createdAt", "updatedAt", "statusUpdatedAt", "expiresAt", "timeoutMs", "tags",
    "ports", "endpoints", "resources", "region", "failoverRegions",
  ])) return null;
  if (value.runtime !== null && typeof value.runtime !== "string") return null;
  const bootSource = value.bootSource;
  if (!isPlainObject(bootSource)) return null;
  let bootArtifact: SandboxRecord["bootArtifact"];
  let frontendMetadata: SandboxRecord["frontendMetadata"] = null;
  if (
    hasOnlyKeys(bootSource, ["type", "runtime"]) &&
    bootSource.type === "runtime" &&
    bootSource.runtime === "host" &&
    value.runtime === "host"
  ) {
    bootArtifact = {
      kind: "host",
      locator: { type: "host", selector: "current" },
      trust: "trusted",
      mutability: "mutable",
    };
  } else if (
    hasOnlyKeys(bootSource, ["type", "image"]) &&
    bootSource.type === "image" &&
    typeof bootSource.image === "string"
  ) {
    const digestMatch = bootSource.image.match(/@sha256:([a-f0-9]{64})$/);
    bootArtifact = {
      kind: "oci-image",
      locator: { type: "oci-reference", reference: bootSource.image },
      digest: digestMatch === null
        ? null
        : { algorithm: "sha256", value: digestMatch[1]! },
      trust: "untrusted",
      mutability: digestMatch === null ? "mutable" : "immutable",
      platform: null,
    };
    if (
      isBackendReference(value.backend) &&
      value.backend.backendType === "docker" &&
      (value.runtime === null || typeof value.runtime === "string")
    ) {
      frontendMetadata = {
        type: "vercel",
        image: bootSource.image,
        runtime: value.runtime,
      };
    }
  } else {
    return null;
  }
  const {
    bootSource: _bootSource,
    runtime: _runtime,
    ...common
  } = value;
  const migrated = { ...common, bootArtifact, frontendMetadata };
  return isSandboxRecord(migrated) ? migrated : null;
}

function isOwner(value: unknown): value is LocalStateOwner {
  return isPlainObject(value) && hasOnlyKeys(value, ["pid", "processStartedAt", "processNonce"]) &&
    Number.isSafeInteger(value.pid) && (value.pid as number) > 0 &&
    isTimestamp(value.processStartedAt) &&
    typeof value.processNonce === "string" && TOKEN_PATTERN.test(value.processNonce);
}

function parseState(value: unknown): LocalSandboxStateRecord | null {
  if (!isPlainObject(value) ||
      (value.schemaVersion !== STATE_SCHEMA_VERSION &&
        value.schemaVersion !== LEGACY_STATE_SCHEMA_VERSION) ||
      (value.kind !== "claim" && value.kind !== "active")) return null;
  const ownershipKeys = [
    "schemaVersion", "kind", "name", "backend", "token", "owner", "claimedAt", "updatedAt",
  ];
  const expected = value.kind === "claim" ? ownershipKeys : [...ownershipKeys, "activatedAt", "sandbox"];
  if (!hasOnlyKeys(value, expected) || typeof value.name !== "string" || value.name.length === 0 ||
      value.name.includes("\0") || !isBackendReference(value.backend) ||
      typeof value.token !== "string" || !TOKEN_PATTERN.test(value.token) ||
      !isOwner(value.owner) || !isTimestamp(value.claimedAt) || !isTimestamp(value.updatedAt) ||
      value.updatedAt < value.claimedAt) return null;
  const common = { ...value, schemaVersion: STATE_SCHEMA_VERSION };
  if (value.kind === "claim") return common as unknown as LocalSandboxClaimRecord;
  if (!isTimestamp(value.activatedAt) || value.activatedAt < value.claimedAt) return null;
  const sandbox = value.schemaVersion === LEGACY_STATE_SCHEMA_VERSION
    ? migrateLegacySandboxRecord(value.sandbox)
    : isSandboxRecord(value.sandbox) ? value.sandbox : null;
  if (sandbox === null || sandbox.name !== value.name ||
      !sameBackend(value.backend, sandbox.backend)) return null;
  return { ...common, sandbox } as unknown as LocalSandboxActiveRecord;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function ignoreUnsupportedDirectorySync(error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EACCES") {
    throw error;
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    ignoreUnsupportedDirectorySync(error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeLockOwnerSync(directory: string, owner: LocalStateOwner): void {
  const path = join(directory, LOCK_OWNER_FILE);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", FILE_MODE);
    fchmodSync(descriptor, FILE_MODE);
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function encodeState(record: LocalSandboxStateRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function writeStateSync(directory: string, record: LocalSandboxStateRecord): void {
  const temporary = join(directory, `.state.${randomToken()}.tmp`);
  const destination = join(directory, STATE_FILE);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", FILE_MODE);
    fchmodSync(descriptor, FILE_MODE);
    writeFileSync(descriptor, encodeState(record), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function writeState(directory: string, record: LocalSandboxStateRecord): Promise<void> {
  const temporary = join(directory, `.state.${randomToken()}.tmp`);
  const destination = join(directory, STATE_FILE);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.chmod(FILE_MODE);
    await handle.writeFile(encodeState(record), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    let parent: FileHandle | undefined;
    try {
      parent = await open(directory, "r");
      await parent.sync();
    } catch (error) {
      ignoreUnsupportedDirectorySync(error);
    } finally {
      await parent?.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readState(directory: string): Promise<
  | { readonly status: "empty" }
  | { readonly status: "corrupt"; readonly reason: string }
  | { readonly status: "record"; readonly record: LocalSandboxStateRecord }
> {
  const path = join(directory, STATE_FILE);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (isMissing(error)) return { status: "empty" };
    throw error;
  }
  if (!info.isFile() || info.size > MAX_STATE_BYTES) {
    return { status: "corrupt", reason: "The canonical state entry is not a bounded regular file." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { status: "corrupt", reason: "The canonical state entry is not valid JSON." };
  }
  const record = parseState(parsed);
  return record === null
    ? { status: "corrupt", reason: "The canonical state entry does not match schema version 1." }
    : { status: "record", record };
}

export function isLocalStateOwnerAlive(owner: LocalStateOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class LocalSandboxStateStore {
  readonly root: string;
  readonly #sandboxes: string;
  readonly #now: () => number;
  readonly #owner: LocalStateOwner;
  #ready: Promise<void> | undefined;

  constructor(options: LocalSandboxStateStoreOptions = {}) {
    this.root = resolveLocalStateRoot(options);
    this.#sandboxes = join(this.root, "sandboxes");
    this.#now = options.now ?? Date.now;
    this.#owner = options.owner ?? processOwner(this.#now());
    if (!isOwner(this.#owner)) throw new TypeError("The local state owner metadata is invalid.");
  }

  async acquire(name: string, backend: BackendReference): Promise<LocalSandboxClaim> {
    if (name.length === 0 || name.includes("\0")) throw new TypeError("Sandbox names must be non-empty and cannot contain NUL.");
    if (!isBackendReference(backend)) throw new TypeError("The backend reference is invalid.");
    await this.#ensureReady();
    const digest = sandboxNameDigest(name);
    const directory = join(this.#sandboxes, digest);
    const claimedAt = this.#now();
    const record: LocalSandboxClaimRecord = {
      schemaVersion: STATE_SCHEMA_VERSION,
      kind: "claim",
      name,
      backend: { backendId: backend.backendId, backendType: backend.backendType },
      token: randomToken(),
      owner: { ...this.#owner },
      claimedAt,
      updatedAt: claimedAt,
    };
    try {
      mkdirSync(directory, { mode: DIRECTORY_MODE });
      chmodSync(directory, DIRECTORY_MODE);
    } catch (error) {
      if (isExists(error)) throw new LocalSandboxStateConflictError(`Sandbox name "${name}" is already owned.`);
      throw error;
    }
    try {
      writeStateSync(directory, record);
      syncDirectory(this.#sandboxes);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return this.#claim(record, digest);
  }

  async inspect(name: string): Promise<LocalSandboxStateInspection> {
    await this.#ensureReady();
    const digest = sandboxNameDigest(name);
    const directory = join(this.#sandboxes, digest);
    let info;
    try {
      info = await stat(directory);
    } catch (error) {
      if (isMissing(error)) return { status: "missing" };
      throw error;
    }
    if (!info.isDirectory() || !DIGEST_PATTERN.test(digest)) {
      return { status: "corrupt", directoryModifiedAt: info.mtimeMs, reason: "The ownership entry is not a directory." };
    }
    await chmod(directory, DIRECTORY_MODE);
    return this.#withLock(directory, async () => {
      await this.#cleanTemporaryFiles(directory);
      const current = await readState(directory);
      if (current.status === "empty") return { status: "empty", directoryModifiedAt: info.mtimeMs };
      if (current.status === "corrupt") return { ...current, directoryModifiedAt: info.mtimeMs };
      if (current.record.name !== name || sandboxNameDigest(current.record.name) !== digest) {
        return {
          status: "corrupt",
          directoryModifiedAt: info.mtimeMs,
          reason: "The ownership entry does not match its sandbox-name digest.",
        };
      }
      return { status: "record", directoryModifiedAt: info.mtimeMs, record: current.record };
    });
  }

  async read(name: string): Promise<LocalSandboxStateRecord | null> {
    const inspected = await this.inspect(name);
    if (inspected.status === "missing") return null;
    if (inspected.status === "record") return inspected.record;
    throw new LocalSandboxStateCorruptionError(
      inspected.status === "empty" ? "The ownership entry has no canonical state file." : inspected.reason,
    );
  }

  async findActiveBySandboxId(
    sandboxId: string,
    backend: BackendReference,
  ): Promise<LocalSandboxActiveRecord | null> {
    await this.#ensureReady();
    let found: LocalSandboxActiveRecord | undefined;
    const entries = await readdir(this.#sandboxes, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !DIGEST_PATTERN.test(entry.name)) continue;
      const directory = join(this.#sandboxes, entry.name);
      await chmod(directory, DIRECTORY_MODE);
      const current = await this.#withLock(directory, async () => {
        await this.#cleanTemporaryFiles(directory);
        return readState(directory);
      });
      if (
        current.status !== "record" ||
        current.record.kind !== "active" ||
        current.record.sandbox.sandboxId !== sandboxId ||
        !sameBackend(current.record.backend, backend) ||
        sandboxNameDigest(current.record.name) !== entry.name
      ) {
        continue;
      }
      if (found !== undefined) {
        throw new LocalSandboxStateCorruptionError(
          `Multiple active records refer to sandbox ID "${sandboxId}".`,
        );
      }
      found = current.record;
    }
    return found ?? null;
  }

  async commit(claim: LocalSandboxClaim, sandbox: SandboxRecord): Promise<LocalSandboxActiveRecord> {
    return this.#writeActive(claim, sandbox, true);
  }

  async update(claim: LocalSandboxClaim, sandbox: SandboxRecord): Promise<LocalSandboxActiveRecord> {
    return this.#writeActive(claim, sandbox, false);
  }

  async release(claim: LocalSandboxClaim): Promise<void> {
    await this.#ensureReady();
    const directory = this.#claimDirectory(claim);
    let moved: string | undefined;
    await this.#withLock(directory, async () => {
      const current = await readState(directory);
      if (current.status !== "record" || current.record.name !== claim.name || current.record.token !== claim.token) {
        throw new LocalSandboxOwnershipError(`Ownership of sandbox name "${claim.name}" changed before release.`);
      }
      moved = join(this.#sandboxes, `.released.${claim.digest}.${randomToken()}`);
      await rename(directory, moved);
      syncDirectory(this.#sandboxes);
    }, true);
    if (moved !== undefined) await rm(moved, { recursive: true, force: true });
  }

  async reclaimInvalid(name: string): Promise<void> {
    await this.#ensureReady();
    const digest = sandboxNameDigest(name);
    const directory = join(this.#sandboxes, digest);
    let moved: string | undefined;
    await this.#withLock(directory, async () => {
      const current = await readState(directory);
      if (current.status === "record") {
        throw new LocalSandboxOwnershipError(`Valid ownership of sandbox name "${name}" cannot be reclaimed as corrupt.`);
      }
      moved = join(this.#sandboxes, `.reclaimed.${digest}.${randomToken()}`);
      await rename(directory, moved);
      syncDirectory(this.#sandboxes);
    }, true);
    if (moved !== undefined) await rm(moved, { recursive: true, force: true });
  }

  async repair(name: string, backend: BackendReference, sandbox: SandboxRecord): Promise<LocalSandboxClaim> {
    await this.#ensureReady();
    const digest = sandboxNameDigest(name);
    const directory = join(this.#sandboxes, digest);
    const claimedAt = this.#now();
    const claimRecord: LocalSandboxClaimRecord = {
      schemaVersion: STATE_SCHEMA_VERSION,
      kind: "claim",
      name,
      backend: { backendId: backend.backendId, backendType: backend.backendType },
      token: randomToken(),
      owner: { ...this.#owner },
      claimedAt,
      updatedAt: claimedAt,
    };
    await this.#withLock(directory, async () => {
      const current = await readState(directory);
      if (current.status === "record") {
        throw new LocalSandboxOwnershipError(`Valid ownership of sandbox name "${name}" cannot be replaced during repair.`);
      }
      await this.#cleanTemporaryFiles(directory);
      await writeState(directory, this.#activeRecord(claimRecord, sandbox, claimedAt));
    });
    return this.#claim(claimRecord, digest);
  }

  async #writeActive(
    claim: LocalSandboxClaim,
    sandbox: SandboxRecord,
    committing: boolean,
  ): Promise<LocalSandboxActiveRecord> {
    if (!isSandboxRecord(sandbox) || sandbox.name !== claim.name || !sameBackend(sandbox.backend, claim.backend)) {
      throw new TypeError("The sandbox record does not match the ownership claim.");
    }
    await this.#ensureReady();
    const directory = this.#claimDirectory(claim);
    return this.#withLock(directory, async () => {
      await this.#cleanTemporaryFiles(directory);
      const current = await readState(directory);
      if (current.status !== "record" || current.record.name !== claim.name || current.record.token !== claim.token) {
        throw new LocalSandboxOwnershipError(`Ownership of sandbox name "${claim.name}" changed before update.`);
      }
      if (committing && current.record.kind !== "claim") {
        throw new LocalSandboxOwnershipError(`Sandbox name "${claim.name}" was already committed.`);
      }
      const activatedAt = current.record.kind === "active" ? current.record.activatedAt : this.#now();
      const active = this.#activeRecord(current.record, sandbox, activatedAt);
      await writeState(directory, active);
      return active;
    });
  }

  #activeRecord(
    ownership: LocalSandboxStateRecord,
    sandbox: SandboxRecord,
    activatedAt: number,
  ): LocalSandboxActiveRecord {
    if (!isSandboxRecord(sandbox) || sandbox.name !== ownership.name || !sameBackend(sandbox.backend, ownership.backend)) {
      throw new TypeError("The sandbox record does not match the ownership entry.");
    }
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      kind: "active",
      name: ownership.name,
      backend: { ...ownership.backend },
      token: ownership.token,
      owner: { ...ownership.owner },
      claimedAt: ownership.claimedAt,
      updatedAt: this.#now(),
      activatedAt,
      sandbox,
    };
  }

  #claim(record: LocalSandboxStateRecord, digest = sandboxNameDigest(record.name)): LocalSandboxClaim {
    return {
      name: record.name,
      digest,
      backend: { ...record.backend },
      token: record.token,
      owner: { ...record.owner },
      claimedAt: record.claimedAt,
    };
  }

  #claimDirectory(claim: LocalSandboxClaim): string {
    if (claim.digest !== sandboxNameDigest(claim.name) || !DIGEST_PATTERN.test(claim.digest) ||
        !TOKEN_PATTERN.test(claim.token) || !isBackendReference(claim.backend) || !isOwner(claim.owner)) {
      throw new TypeError("The local sandbox claim is invalid.");
    }
    return join(this.#sandboxes, claim.digest);
  }

  async #ensureReady(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(this.root, DIRECTORY_MODE);
      await mkdir(this.#sandboxes, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(this.#sandboxes, DIRECTORY_MODE);
    })();
    try {
      await this.#ready;
    } catch (error) {
      this.#ready = undefined;
      throw error;
    }
  }

  async #withLock<Result>(
    directory: string,
    operation: () => Promise<Result>,
    directoryMayMove = false,
  ): Promise<Result> {
    const lock = join(directory, OPERATION_LOCK);
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await mkdir(lock, { mode: DIRECTORY_MODE });
      } catch (error) {
        if (isMissing(error)) throw new LocalSandboxOwnershipError("The sandbox ownership entry no longer exists.");
        if (!isExists(error)) throw error;
        if (!await this.#recoverStaleLock(lock)) await delay(5);
        continue;
      }
      try {
        await chmod(lock, DIRECTORY_MODE);
        writeLockOwnerSync(lock, this.#owner);
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      acquired = true;
      break;
    }
    if (!acquired) throw new LocalSandboxOwnershipError("The sandbox ownership entry is busy.");
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true }).catch((error) => {
        if (!directoryMayMove) throw error;
      });
    }
  }

  async #recoverStaleLock(lock: string): Promise<boolean> {
    let info;
    try {
      info = await stat(lock);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    let owner: LocalStateOwner | undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(lock, LOCK_OWNER_FILE), "utf8"));
      if (isOwner(parsed)) owner = parsed;
    } catch {
      // An interrupted lock write is reclaimable only after its grace period.
    }
    if (owner !== undefined && isLocalStateOwnerAlive(owner)) return false;
    if (owner === undefined && Date.now() - info.mtimeMs < INTERRUPTED_LOCK_GRACE_MS) return false;

    const stale = `${lock}.stale.${randomToken()}`;
    try {
      await rename(lock, stale);
    } catch (error) {
      if (isMissing(error)) return true;
      return false;
    }
    await rm(stale, { recursive: true, force: true });
    return true;
  }

  async #cleanTemporaryFiles(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && TEMP_PATTERN.test(entry.name))
      .map((entry) => unlink(join(directory, entry.name)).catch(() => undefined)));
  }
}
