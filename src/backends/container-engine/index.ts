import Dockerode from "dockerode";
import { validateBootArtifact } from "../../runtime/artifacts.js";
import { FILESYSTEM_TRANSFER_CHUNK_BYTES } from "../../runtime/filesystem-bridge.js";
import { MANAGED_FILESYSTEM_PRIVILEGE_BRIDGE } from "../../runtime/internal-filesystem-bridge.js";
import { MANAGED_IMAGE_REGISTRY } from "../docker/managed-images.js";
import {
  DockerUnavailableError,
  ImagePullError,
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
  AvailabilityDiagnostic,
  BackendAvailability,
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
  EndpointRecord,
  GetEndpointResult,
  GetSandboxRequest,
  GetSandboxResult,
  JsonObject,
  ListSandboxesRequest,
  ListSandboxesResult,
  ProbeAvailabilityRequest,
  ProbeAvailabilityResult,
  RequestMetadata,
  SandboxBackend,
  SandboxCapabilities,
  SandboxRecord,
  StartRawCommandRequest,
  StartRawCommandResult,
  StopSandboxRequest,
  StopSandboxResult,
} from "../../runtime/index.js";
import { Sandbox as ContainerEngineSandbox } from "./sandbox.js";
import type {
  SandboxCreateOptions,
  SandboxListItem,
  SandboxSource,
} from "./types.js";

export const DOCKER_REFERENCE = Object.freeze({
  backendId: "local-docker",
  backendType: "docker",
}) satisfies BackendReference;

export const DOCKER_CAPABILITIES = Object.freeze({
  schemaVersion: 1,
  operations: {
    "command.start": {
      support: "native",
      constraints: null,
      diagnostic: "Docker exec starts commands inside the selected container.",
    },
    "command.detached": {
      support: "emulated",
      constraints: null,
      diagnostic: "EmbeddedSandboxClient retains detached command state in this Localbox process; it is not recoverable after a process restart.",
    },
    "endpoint.expose": {
      support: "native",
      constraints: { protocols: ["http"], visibilities: ["loopback"] },
      diagnostic: "Docker publishes declared TCP ports as HTTP endpoints bound to 127.0.0.1.",
    },
    "filesystem.mkdir": {
      support: "emulated",
      constraints: null,
      diagnostic: "Localbox implements directory creation through its managed filesystem command bridge.",
    },
    "filesystem.read": {
      support: "emulated",
      constraints: null,
      diagnostic: "Localbox implements bounded file reads through its managed filesystem command bridge.",
    },
    "filesystem.write": {
      support: "emulated",
      constraints: null,
      diagnostic: "Localbox implements staged file writes through its managed filesystem command bridge.",
    },
    "source.git": {
      support: "emulated",
      constraints: null,
      diagnostic: "Localbox clones Git sources into the workspace after the container starts.",
    },
    "source.tarball": {
      support: "emulated",
      constraints: null,
      diagnostic: "Localbox downloads and extracts tarball sources into the workspace after the container starts.",
    },
    "raw-command.input": {
      support: "native",
      constraints: { maxBytes: FILESYSTEM_TRANSFER_CHUNK_BYTES },
      diagnostic: `Docker exec accepts bounded stdin chunks up to ${FILESYSTEM_TRANSFER_CHUNK_BYTES} bytes.`,
    },
    "raw-command.managed-filesystem-owner": {
      support: "partial",
      constraints: { managedImagesOnly: true },
      diagnostic: "Root ownership changes are restricted to the fixed filesystem bridge in Localbox managed images; custom images cannot request them.",
    },
  },
  isolation: {
    support: "partial",
    constraints: {
      level: "shared-kernel-container",
      tenancies: ["trusted", "single-tenant"],
    },
    diagnostic: "Docker containers share the host kernel and are intended for trusted or single-tenant local development; use a VM-isolated backend for hostile multi-tenant workloads.",
  },
  artifacts: {
    support: "partial",
    constraints: { kinds: ["oci-image"] },
    diagnostic: "Docker accepts validated OCI image artifacts under its trusted or single-tenant workload boundary; artifact trust metadata describes provenance and does not strengthen container isolation.",
  },
  persistence: {
    support: "native",
    constraints: { scopes: ["sandbox-lifecycle", "backend-restart"] },
    diagnostic: "Persistent Docker containers retain their writable layer across stop/resume and Localbox process restart while Docker daemon data remains; host or daemon storage loss is not covered.",
  },
  recovery: {
    support: "partial",
    constraints: { scopes: ["sandbox"] },
    diagnostic: "Sandbox containers can be rediscovered from Docker labels, but in-flight commands, output buffers, waiters, and idempotency records cannot be recovered.",
  },
  networking: {
    support: "partial",
    constraints: {
      modes: ["allow-all", "deny-all"],
      portExposure: ["loopback"],
      customPolicies: false,
    },
    diagnostic: "Docker supports bridge networking or network-none isolation and loopback-only published ports; custom policies and non-loopback exposure are unsupported, and deny-all Git/tarball sources are disconnected only after materialization.",
  },
  resources: {
    support: "partial",
    constraints: {
      cpu: { minimumVcpus: 1, maximumVcpus: null, stepVcpus: 1 },
      memory: {
        minimumBytes: 2_147_483_648,
        maximumBytes: null,
        stepBytes: 2_147_483_648,
      },
      memoryBytesPerVcpu: 2_147_483_648,
      enforcement: "hard",
    },
    diagnostic: "Docker enforces integer NanoCPU quotas and a fixed 2 GiB memory limit per requested vCPU; independent memory limits and host-capacity guarantees are unavailable.",
  },
  terminals: {
    support: "unsupported",
    constraints: { modes: [] },
    diagnostic: "The Docker backend exposes non-interactive exec only; choose a backend with PTY support for interactive terminals.",
  },
  snapshots: {
    support: "unsupported",
    constraints: { operations: [] },
    diagnostic: "The Docker backend cannot create, restore, or clone snapshots; use an OCI image or source artifact instead.",
  },
} as const satisfies SandboxCapabilities);

export interface ContainerEngineDriver {
  readonly name: string;
  readonly reference: BackendReference;
  readonly capabilities: SandboxCapabilities;
  readonly client: Dockerode;
  readonly unavailableCode: string;
  readonly unavailableMessage: string;
  readonly failureCode: string;
  readonly ephemeralStopStrategy?: "stop-then-remove" | "remove";
  probeAvailability(
    request: ProbeAvailabilityRequest,
  ): Promise<ClientResult<ProbeAvailabilityResult>>;
  beforeOperation?(signal: AbortSignal | undefined): Promise<void>;
  beforeCreate?(
    request: CreateSandboxRequest,
    signal: AbortSignal | undefined,
  ): Promise<void>;
}


interface DeadlineScope {
  readonly signal: AbortSignal | undefined;
  readonly expired: () => boolean;
  readonly dispose: () => void;
}

function deadlineScope(request: RequestMetadata): DeadlineScope {
  if (request.deadline === null) {
    return { signal: undefined, expired: () => false, dispose: () => undefined };
  }
  const controller = new AbortController();
  let didExpire = false;
  const remaining = request.deadline.expiresAt - Date.now();
  if (remaining <= 0) {
    didExpire = true;
    controller.abort();
    return { signal: controller.signal, expired: () => didExpire, dispose: () => undefined };
  }
  const timer = setTimeout(() => {
    didExpire = true;
    controller.abort();
  }, remaining);
  timer.unref();
  return {
    signal: controller.signal,
    expired: () => didExpire,
    dispose: () => clearTimeout(timer),
  };
}

function success<T extends JsonObject>(value: T): ClientResult<T> {
  return { ok: true, value };
}

function failure(
  reference: BackendReference,
  requestId: string,
  category: ClientFailure["error"]["category"],
  code: string,
  message: string,
  details: ClientFailure["error"]["details"],
  retryable = false,
): ClientFailure {
  return {
    ok: false,
    error: {
      category,
      code,
      message,
      retryable,
      requestId,
      backend: reference,
      details,
    },
  };
}

function translatedFailure(
  driver: ContainerEngineDriver,
  requestId: string,
  operation: string,
  error: unknown,
  expired: boolean,
): ClientFailure {
  const fail = (
    category: ClientFailure["error"]["category"],
    code: string,
    message: string,
    details: ClientFailure["error"]["details"],
    retryable = false,
  ): ClientFailure => failure(driver.reference, requestId, category, code, message, details, retryable);
  if (expired) {
    return fail(
      "deadline-exceeded",
      "LOCALBOX_DEADLINE_EXCEEDED",
      `The ${operation} operation exceeded its deadline.`,
      { type: "backend", operation },
      true,
    );
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return fail(
      "cancelled",
      "LOCALBOX_OPERATION_CANCELLED",
      `The ${operation} operation was cancelled.`,
      { type: "backend", operation },
    );
  }
  if (error instanceof DockerUnavailableError) {
    return fail(
      "backend-unavailable",
      driver.unavailableCode,
      driver.unavailableMessage,
      { type: "backend", operation },
      true,
    );
  }
  if (error instanceof SandboxAlreadyExistsError) {
    return fail(
      "already-exists",
      "LOCALBOX_SANDBOX_ALREADY_EXISTS",
      error.message,
      { type: "resource", resource: "sandbox", resourceId: error.sandboxName },
    );
  }
  if (error instanceof SandboxNotFoundError) {
    return fail(
      "not-found",
      "LOCALBOX_SANDBOX_NOT_FOUND",
      error.message,
      { type: "resource", resource: "sandbox", resourceId: error.sandboxName },
    );
  }
  if (error instanceof SandboxDeletedError) {
    return fail(
      "failed-precondition",
      "LOCALBOX_SANDBOX_DELETED",
      error.message,
      { type: "resource", resource: "sandbox", resourceId: error.sandboxName },
    );
  }
  if (error instanceof PortNotExposedError) {
    return fail(
      "not-found",
      "LOCALBOX_ENDPOINT_NOT_FOUND",
      error.message,
      { type: "resource", resource: "endpoint", resourceId: `${error.sandboxName}:${error.port}` },
    );
  }
  if (error instanceof SandboxSourceError) {
    return fail(
      "source-failure",
      "LOCALBOX_SOURCE_FAILURE",
      error.message,
      { type: "source", sourceType: error.sourceType },
    );
  }
  if (error instanceof ImagePullError) {
    return fail(
      "image-failure",
      "LOCALBOX_IMAGE_PULL_FAILED",
      `Could not pull image "${error.image}". Check the image name, registry access, and ${driver.name} credentials.`,
      { type: "backend", operation },
    );
  }
  if (error instanceof UnsupportedImageError) {
    return fail(
      "image-failure",
      "LOCALBOX_UNSUPPORTED_IMAGE",
      error.message,
      { type: "backend", operation },
    );
  }
  if (error instanceof InvalidSandboxOptionsError || error instanceof TypeError || error instanceof RangeError) {
    const message = error.message.replaceAll("Container-engine", driver.name);
    return fail(
      "invalid-request",
      "LOCALBOX_INVALID_REQUEST",
      message,
      { type: "invalid-request", field: null, reason: message },
    );
  }
  if (error instanceof UnsupportedSandboxCapabilityError) {
    return fail(
      "failed-precondition",
      "LOCALBOX_UNSUPPORTED_CAPABILITY",
      `Localbox's ${driver.name} backend does not support ${error.capability.replace("this container engine", `this ${driver.name} ${driver.name === "Docker" ? "daemon" : "service"}`)}. Remove that requirement or use a capable backend.`,
      { type: "backend", operation },
    );
  }
  const candidate = error as NodeJS.ErrnoException;
  if (candidate instanceof Error && candidate.code === "ENOENT") {
    return fail(
      "not-found",
      "LOCALBOX_FILE_NOT_FOUND",
      candidate.message,
      { type: "resource", resource: "sandbox", resourceId: "filesystem" },
    );
  }
  return fail(
    "backend-failure",
    driver.failureCode,
    `The ${driver.name} backend could not complete ${operation}.`,
    { type: "backend", operation },
  );
}

function sourceOptions(source: CreateSandboxRequest["spec"]["source"]): SandboxSource | undefined {
  if (source === null) return undefined;
  if (source.type === "tarball") return { type: "tarball", url: source.url };
  return source.credentials === null
    ? {
        type: "git",
        url: source.url,
        ...(source.revision === null ? {} : { revision: source.revision }),
        ...(source.depth === null ? {} : { depth: source.depth }),
      }
    : {
        type: "git",
        url: source.url,
        ...(source.revision === null ? {} : { revision: source.revision }),
        ...(source.depth === null ? {} : { depth: source.depth }),
        username: source.credentials.username,
        password: source.credentials.password,
      };
}

function createOptions(request: CreateSandboxRequest, signal: AbortSignal | undefined): SandboxCreateOptions {
  const spec = request.spec;
  const validation = validateBootArtifact(spec.bootArtifact);
  if (!validation.ok) {
    throw new InvalidSandboxOptionsError(`${validation.field}: ${validation.reason}`);
  }
  if (validation.artifact.kind !== "oci-image") {
    throw new UnsupportedSandboxCapabilityError(
      `boot artifact kind ${validation.artifact.kind}`,
    );
  }
  const source = sourceOptions(spec.source);
  return {
    name: spec.name,
    bootArtifact: validation.artifact,
    ...(spec.frontendMetadata?.runtime === null || spec.frontendMetadata === null
      ? {}
      : { runtime: spec.frontendMetadata.runtime }),
    ...(source === undefined ? {} : { source }),
    persistent: spec.persistent,
    timeout: spec.timeoutMs,
    env: { ...spec.environment },
    tags: { ...spec.tags },
    ports: [...spec.ports],
    networkPolicy: spec.networkPolicy,
    ...(spec.resources.vcpus === null ? {} : { resources: { vcpus: spec.resources.vcpus } }),
    ...(spec.region === null ? {} : { region: spec.region }),
    failoverRegions: [...spec.failoverRegions],
    ...(signal === undefined ? {} : { signal }),
  };
}
function endpointRecords(
  sandbox: ContainerEngineSandbox,
  reference: BackendReference,
): EndpointRecord[] {
  const endpoints: EndpointRecord[] = [];
  for (const port of sandbox.ports) {
    try {
      endpoints.push({
        endpointId: `${sandbox.name}:${port}`,
        sandboxId: sandbox.name,
        port,
        protocol: "http",
        url: sandbox.domain(port),
        visibility: "loopback",
        backend: reference,
      });
    } catch (error) {
      if (!(error instanceof PortNotExposedError)) throw error;
    }
  }
  return endpoints;
}

function sandboxRecord(
  sandbox: ContainerEngineSandbox,
  reference: BackendReference,
  now = Date.now(),
): SandboxRecord {
  return {
    sandboxId: sandbox.name,
    name: sandbox.name,
    status: sandbox.status,
    persistent: sandbox.persistent,
    bootArtifact: sandbox.bootArtifact,
    frontendMetadata: {
      type: "vercel",
      image: sandbox.image,
      runtime: sandbox.runtime ?? null,
    },
    backend: reference,
    createdAt: sandbox.createdAt.getTime(),
    updatedAt: now,
    statusUpdatedAt: now,
    expiresAt: sandbox.expiresAt?.getTime() ?? null,
    timeoutMs: sandbox.timeout,
    tags: { ...sandbox.tags },
    ports: [...sandbox.ports],
    resources: {
      vcpus: sandbox.vcpus ?? null,
      memoryBytes: sandbox.memory === undefined ? null : sandbox.memory * 1_048_576,
    },
    endpoints: endpointRecords(sandbox, reference),
    region: sandbox.region === "local" ? null : sandbox.region,
    failoverRegions: [...sandbox.failoverRegions],
  };
}

function listRecord(item: SandboxListItem, reference: BackendReference): SandboxRecord {
  return {
    sandboxId: item.name,
    name: item.name,
    status: item.status,
    persistent: item.persistent,
    bootArtifact: item.bootArtifact,
    frontendMetadata: {
      type: "vercel",
      image: item.image,
      runtime: item.runtime ?? null,
    },
    backend: reference,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    statusUpdatedAt: item.statusUpdatedAt,
    expiresAt: null,
    timeoutMs: item.timeout,
    tags: { ...item.tags },
    ports: [...item.ports],
    endpoints: item.endpoints.map(({ port, url }) => ({
      endpointId: `${item.name}:${port}`,
      sandboxId: item.name,
      port,
      protocol: "http",
      url,
      visibility: "loopback",
      backend: reference,
    })),
    resources: {
      vcpus: item.vcpus ?? null,
      memoryBytes: item.memory === undefined ? null : item.memory * 1_048_576,
    },
    region: item.region ?? null,
    failoverRegions: [...item.failoverRegions],
  };
}


export class ContainerEngineBackend implements SandboxBackend {
  readonly reference: BackendReference;
  readonly capabilities: SandboxCapabilities;
  readonly #driver: ContainerEngineDriver;
  readonly #client: Dockerode;

  constructor(driver: ContainerEngineDriver) {
    this.#driver = driver;
    this.reference = driver.reference;
    this.capabilities = driver.capabilities;
    this.#client = driver.client;
  }

  probeAvailability(
    request: ProbeAvailabilityRequest,
  ): Promise<ClientResult<ProbeAvailabilityResult>> {
    return this.#driver.probeAvailability(request);
  }

  async #run<T extends JsonObject>(
    request: RequestMetadata,
    operation: string,
    work: (signal: AbortSignal | undefined) => Promise<T>,
    prepare = true,
  ): Promise<ClientResult<T>> {
    const scope = deadlineScope(request);
    try {
      if (scope.expired()) throw new DOMException("The operation timed out", "AbortError");
      if (prepare) await this.#driver.beforeOperation?.(scope.signal);
      return success(await work(scope.signal));
    } catch (error) {
      return translatedFailure(this.#driver, request.requestId, operation, error, scope.expired());
    } finally {
      scope.dispose();
    }
  }

  createSandbox(request: CreateSandboxRequest): Promise<ClientResult<CreateSandboxResult>> {
    return this.#run(request, "createSandbox", async (signal) => {
      await this.#driver.beforeCreate?.(request, signal);
      await this.#driver.beforeOperation?.(signal);
      const sandbox = await ContainerEngineSandbox.create(this.#client, createOptions(request, signal));
      return { sandbox: sandboxRecord(sandbox, this.reference) };
    }, false);
  }

  getSandbox(request: GetSandboxRequest): Promise<ClientResult<GetSandboxResult>> {
    return this.#run(request, "getSandbox", async (signal) => {
      const sandbox = await ContainerEngineSandbox.get(this.#client, {
        name: request.sandboxId,
        resume: request.resume,
        ...(signal === undefined ? {} : { signal }),
      });
      return { sandbox: sandboxRecord(sandbox, this.reference) };
    });
  }

  listSandboxes(request: ListSandboxesRequest): Promise<ClientResult<ListSandboxesResult>> {
    return this.#run(request, "listSandboxes", async (signal) => {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new InvalidSandboxOptionsError("Sandbox list limit must be a positive integer.");
      }
      const start = request.cursor === null ? 0 : Number(request.cursor);
      if (!Number.isSafeInteger(start) || start < 0) {
        throw new InvalidSandboxOptionsError("Sandbox list cursor is invalid.");
      }
      const listed = await ContainerEngineSandbox.list(this.#client, {
        ...(request.namePrefix === null ? {} : { namePrefix: request.namePrefix }),
        tags: { ...request.tags },
        sortBy: request.sortBy,
        sortOrder: request.sortOrder,
        limit: 1_000_000,
        ...(signal === undefined ? {} : { signal }),
      });
      const statuses = new Set(request.statuses);
      const records = (await listed.toArray())
        .filter((item) => statuses.size === 0 || statuses.has(item.status))
        .map((item) => listRecord(item, this.reference));
      const sandboxes = records.slice(start, start + request.limit);
      const next = start + sandboxes.length;
      return {
        sandboxes,
        nextCursor: next < records.length ? String(next) : null,
      };
    });
  }

  stopSandbox(request: StopSandboxRequest): Promise<ClientResult<StopSandboxResult>> {
    return this.#run(request, "stopSandbox", async (signal) => {
      const sandbox = await ContainerEngineSandbox.get(this.#client, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      await sandbox.stop({
        ...(signal === undefined ? {} : { signal }),
        ...(this.#driver.ephemeralStopStrategy === undefined
          ? {}
          : { ephemeralStrategy: this.#driver.ephemeralStopStrategy }),
      });
      return { sandbox: sandboxRecord(sandbox, this.reference) };
    });
  }

  deleteSandbox(request: DeleteSandboxRequest): Promise<ClientResult<DeleteSandboxResult>> {
    return this.#run(request, "deleteSandbox", async (signal) => {
      const sandbox = await ContainerEngineSandbox.get(this.#client, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      await sandbox.delete(signal === undefined ? {} : { signal });
      return { sandboxId: request.sandboxId, deletedAt: Date.now() };
    });
  }

  extendSandboxDeadline(
    request: ExtendSandboxDeadlineRequest,
  ): Promise<ClientResult<ExtendSandboxDeadlineResult>> {
    return this.#run(request, "extendSandboxDeadline", async (signal) => {
      const sandbox = await ContainerEngineSandbox.get(this.#client, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      await sandbox.extendTimeout(
        request.additionalMilliseconds,
        signal === undefined ? {} : { signal },
      );
      return { sandbox: sandboxRecord(sandbox, this.reference) };
    });
  }

  async startRawCommand(
    request: StartRawCommandRequest,
    signal?: AbortSignal,
  ): Promise<StartRawCommandResult> {
    try {
      await this.#driver.beforeOperation?.(signal);
      const sandbox = await ContainerEngineSandbox.get(this.#client, {
        name: request.sandboxId,
        ...(signal === undefined ? {} : { signal }),
      });
      const privileged = request.privilege === "managed-filesystem-owner";
      if (
        request.privilege !== undefined &&
        request.privilege !== "managed-filesystem-owner"
      ) {
        throw new UnsupportedSandboxCapabilityError("unknown raw command privilege");
      }
      if (request.command.user === "0") {
        throw new UnsupportedSandboxCapabilityError("arbitrary root command execution");
      }
      if (privileged && !sandbox.image.startsWith(`${MANAGED_IMAGE_REGISTRY}:`)) {
        throw new UnsupportedSandboxCapabilityError(
          "privileged filesystem operations for custom images",
        );
      }
      const input = request.input === undefined
        ? undefined
        : Buffer.from(request.input.data, request.input.encoding);
      if (input !== undefined && input.length > FILESYSTEM_TRANSFER_CHUNK_BYTES) {
        throw new RangeError("Raw command input exceeds the filesystem transfer bound.");
      }
      const command = await sandbox.startRawCommand({
        cmd: [
          privileged
            ? MANAGED_FILESYSTEM_PRIVILEGE_BRIDGE.nodePath
            : request.command.command,
          ...request.command.arguments,
        ],
        cwd: request.command.cwd,
        env: Object.entries(request.command.environment).map(
          ([key, value]) => `${key}=${value}`,
        ),
        ...(privileged ? { user: "0" } : request.command.user === undefined
          ? {}
          : { user: request.command.user }),
        ...(input === undefined ? {} : { stdin: input }),
        ...(signal === undefined ? {} : { signal }),
      });
      return { ok: true, command };
    } catch (error) {
      const expired = request.deadline !== null && request.deadline.expiresAt <= Date.now();
      return translatedFailure(this.#driver, request.requestId, "startCommand", error, expired);
    }
  }


  getEndpoint(request: GetEndpointRequest): Promise<ClientResult<GetEndpointResult>> {
    return this.#run(request, "getEndpoint", async (signal) => {
      const sandbox = await ContainerEngineSandbox.get(this.#client, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      const url = sandbox.domain(request.port);
      return {
        endpoint: {
          endpointId: `${request.sandboxId}:${request.port}`,
          sandboxId: request.sandboxId,
          port: request.port,
          protocol: "http",
          url,
          visibility: "loopback",
          backend: this.reference,
        },
      };
    });
  }
}

async function probeDockerAvailability(
  client: Dockerode,
  request: ProbeAvailabilityRequest,
): Promise<ClientResult<ProbeAvailabilityResult>> {
  const remaining = request.deadline === null
    ? null
    : request.deadline.expiresAt - Date.now();
  if (remaining !== null && remaining <= 0) {
    return failure(
      DOCKER_REFERENCE,
      request.requestId,
      "deadline-exceeded",
      "LOCALBOX_DEADLINE_EXCEEDED",
      "The probeAvailability operation exceeded its deadline.",
      { type: "backend", operation: "probeAvailability" },
      true,
    );
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const versionRequest = client.version();
    const timeout = Promise.withResolvers<never>();
    if (remaining !== null) {
      timer = setTimeout(() => {
        timeout.reject(new DOMException("The operation timed out", "AbortError"));
      }, remaining);
      timer.unref();
    }
    const version = remaining === null
      ? await versionRequest
      : await Promise.race([versionRequest, timeout.promise]);
    const availability: BackendAvailability = {
      schemaVersion: 1,
      backend: DOCKER_REFERENCE,
      status: "available",
      checkedAt: Date.now(),
      diagnostics: [{
        code: "DOCKER_DAEMON_AVAILABLE",
        severity: "info",
        message: "The Docker daemon answered the version API.",
        action: "No action is required.",
        details: {
          type: "docker-daemon",
          reason: "available",
          apiVersion: typeof version.ApiVersion === "string" ? version.ApiVersion : null,
        },
      }],
    };
    return success({ availability });
  } catch (error) {
    if (request.deadline !== null && request.deadline.expiresAt <= Date.now()) {
      return failure(
        DOCKER_REFERENCE,
        request.requestId,
        "deadline-exceeded",
        "LOCALBOX_DEADLINE_EXCEEDED",
        "The probeAvailability operation exceeded its deadline.",
        { type: "backend", operation: "probeAvailability" },
        true,
      );
    }
    const code = (error as NodeJS.ErrnoException).code;
    const diagnostic: AvailabilityDiagnostic = code === "ENOENT"
      ? {
        code: "DOCKER_SOCKET_NOT_FOUND",
        severity: "error",
        message: "The configured Docker endpoint does not exist.",
        action: "Start Docker Desktop or the Docker service, then verify the selected Docker context and socket.",
        details: { type: "docker-daemon", reason: "not-found", apiVersion: null },
      }
      : code === "EACCES" || code === "EPERM"
      ? {
        code: "DOCKER_SOCKET_PERMISSION_DENIED",
        severity: "error",
        message: "The Docker endpoint is present but the current user cannot access it.",
        action: "Grant the current user access to the Docker socket or select a Docker context it can use.",
        details: { type: "docker-daemon", reason: "permission-denied", apiVersion: null },
      }
      : {
        code: "DOCKER_DAEMON_UNREACHABLE",
        severity: "error",
        message: "The Docker daemon did not answer the version API.",
        action: "Start the Docker daemon and verify the active Docker context and endpoint configuration.",
        details: { type: "docker-daemon", reason: "unreachable", apiVersion: null },
      };
    return success({
      availability: {
        schemaVersion: 1,
        backend: DOCKER_REFERENCE,
        status: "unavailable",
        checkedAt: Date.now(),
        diagnostics: [diagnostic],
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export class DockerBackend extends ContainerEngineBackend {
  declare readonly capabilities: typeof DOCKER_CAPABILITIES;
  constructor() {
    const client = new Dockerode();
    super({
      name: "Docker",
      reference: DOCKER_REFERENCE,
      capabilities: DOCKER_CAPABILITIES,
      client,
      unavailableCode: "LOCALBOX_DOCKER_UNAVAILABLE",
      unavailableMessage: "Cannot connect to Docker. Start Docker and retry.",
      failureCode: "LOCALBOX_DOCKER_FAILURE",
      probeAvailability: (request) => probeDockerAvailability(client, request),
    });
  }
}

