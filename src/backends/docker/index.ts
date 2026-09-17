import Dockerode from "dockerode";
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
  BackendReference,
  ClientFailure,
  ClientResult,
  CommandOutputChunk,
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
  MakeDirectoryRequest,
  MakeDirectoryResult,
  ProcessRecord,
  ReadCommandOutputRequest,
  ReadCommandOutputResult,
  ReadFileRequest,
  ReadFileResult,
  RequestMetadata,
  SandboxBackend,
  SandboxCapability,
  SandboxRecord,
  SignalProcessRequest,
  SignalProcessResult,
  StartCommandRequest,
  StartCommandResult,
  StopSandboxRequest,
  StopSandboxResult,
  WaitForCommandRequest,
  WaitForCommandResult,
  WriteFileRequest,
  WriteFileResult,
} from "../../runtime/index.js";
import { type Command, type CommandChunk } from "./command.js";
import { Sandbox as DockerSandbox } from "./sandbox.js";
import type {
  SandboxCreateOptions,
  SandboxListItem,
  SandboxSource,
} from "./types.js";

const REFERENCE = Object.freeze({
  backendId: "local-docker",
  backendType: "docker",
}) satisfies BackendReference;

const CAPABILITIES = Object.freeze([
  "command.start",
  "command.detached",
  "endpoint.expose",
  "filesystem.mkdir",
  "filesystem.read",
  "filesystem.write",
  "sandbox.network.allow-all",
  "sandbox.network.deny-all",
  "sandbox.persistence",
  "sandbox.resource-limits",
  "sandbox.source.git",
  "sandbox.source.tarball",
] satisfies SandboxCapability[]);

interface BackendProcess {
  readonly sandboxId: string;
  readonly processId: string;
  readonly command: Command;
  readonly cwd: string;
  readonly startedAt: number;
  readonly chunks: CommandChunk[];
  readonly outputLimitBytes: number;
  retainedBytes: number;
  truncated: boolean;
  complete: boolean;
  finishedAt: number | null;
  exitCode: number | null;
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
      backend: REFERENCE,
      details,
    },
  };
}

function translatedFailure(requestId: string, operation: string, error: unknown, expired: boolean): ClientFailure {
  if (expired) {
    return failure(
      requestId,
      "deadline-exceeded",
      "LOCALBOX_DEADLINE_EXCEEDED",
      `The ${operation} operation exceeded its deadline.`,
      { type: "backend", operation },
      true,
    );
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return failure(
      requestId,
      "cancelled",
      "LOCALBOX_OPERATION_CANCELLED",
      `The ${operation} operation was cancelled.`,
      { type: "backend", operation },
    );
  }
  if (error instanceof DockerUnavailableError) {
    return failure(
      requestId,
      "backend-unavailable",
      "LOCALBOX_DOCKER_UNAVAILABLE",
      error.message,
      { type: "backend", operation },
      true,
    );
  }
  if (error instanceof SandboxAlreadyExistsError) {
    return failure(
      requestId,
      "already-exists",
      "LOCALBOX_SANDBOX_ALREADY_EXISTS",
      error.message,
      { type: "resource", resource: "sandbox", resourceId: error.sandboxName },
    );
  }
  if (error instanceof SandboxNotFoundError) {
    return failure(
      requestId,
      "not-found",
      "LOCALBOX_SANDBOX_NOT_FOUND",
      error.message,
      { type: "resource", resource: "sandbox", resourceId: error.sandboxName },
    );
  }
  if (error instanceof SandboxDeletedError) {
    return failure(
      requestId,
      "failed-precondition",
      "LOCALBOX_SANDBOX_DELETED",
      error.message,
      { type: "resource", resource: "sandbox", resourceId: error.sandboxName },
    );
  }
  if (error instanceof PortNotExposedError) {
    return failure(
      requestId,
      "not-found",
      "LOCALBOX_ENDPOINT_NOT_FOUND",
      error.message,
      { type: "resource", resource: "endpoint", resourceId: `${error.sandboxName}:${error.port}` },
    );
  }
  if (error instanceof SandboxSourceError) {
    return failure(
      requestId,
      "source-failure",
      "LOCALBOX_SOURCE_FAILURE",
      error.message,
      { type: "source", sourceType: error.sourceType },
    );
  }
  if (error instanceof ImagePullError) {
    return failure(
      requestId,
      "image-failure",
      "LOCALBOX_IMAGE_PULL_FAILED",
      error.message,
      { type: "backend", operation },
    );
  }
  if (error instanceof UnsupportedImageError) {
    return failure(
      requestId,
      "image-failure",
      "LOCALBOX_UNSUPPORTED_IMAGE",
      error.message,
      { type: "backend", operation },
    );
  }
  if (error instanceof InvalidSandboxOptionsError || error instanceof TypeError || error instanceof RangeError) {
    return failure(
      requestId,
      "invalid-request",
      "LOCALBOX_INVALID_REQUEST",
      error.message,
      { type: "invalid-request", field: null, reason: error.message },
    );
  }
  if (error instanceof UnsupportedSandboxCapabilityError) {
    return failure(
      requestId,
      "failed-precondition",
      "LOCALBOX_UNSUPPORTED_CAPABILITY",
      error.message,
      { type: "backend", operation },
    );
  }
  const candidate = error as NodeJS.ErrnoException;
  if (candidate instanceof Error && candidate.code === "ENOENT") {
    return failure(
      requestId,
      "not-found",
      "LOCALBOX_FILE_NOT_FOUND",
      candidate.message,
      { type: "resource", resource: "sandbox", resourceId: "filesystem" },
    );
  }
  return failure(
    requestId,
    "backend-failure",
    "LOCALBOX_DOCKER_FAILURE",
    `The Docker backend could not complete ${operation}.`,
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
  const source = sourceOptions(spec.source);
  return {
    name: spec.name,
    ...(spec.bootSource.type === "runtime"
      ? { runtime: spec.bootSource.runtime }
      : { image: spec.bootSource.image }),
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
function endpointRecords(sandbox: DockerSandbox): EndpointRecord[] {
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
        backend: REFERENCE,
      });
    } catch (error) {
      if (!(error instanceof PortNotExposedError)) throw error;
    }
  }
  return endpoints;
}


function sandboxRecord(sandbox: DockerSandbox, now = Date.now()): SandboxRecord {
  return {
    sandboxId: sandbox.name,
    name: sandbox.name,
    status: sandbox.status,
    persistent: sandbox.persistent,
    bootSource: { type: "image", image: sandbox.image },
    runtime: sandbox.runtime ?? null,
    backend: REFERENCE,
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
    endpoints: endpointRecords(sandbox),
    region: sandbox.region === "local" ? null : sandbox.region,
    failoverRegions: [...sandbox.failoverRegions],
  };
}

function listRecord(item: SandboxListItem): SandboxRecord {
  return {
    sandboxId: item.name,
    name: item.name,
    status: item.status,
    persistent: item.persistent,
    bootSource: { type: "image", image: item.image },
    runtime: item.runtime ?? null,
    backend: REFERENCE,
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
      backend: REFERENCE,
    })),
    resources: {
      vcpus: item.vcpus ?? null,
      memoryBytes: item.memory === undefined ? null : item.memory * 1_048_576,
    },
    region: item.region ?? null,
    failoverRegions: [...item.failoverRegions],
  };
}

function processRecord(state: BackendProcess): ProcessRecord {
  return {
    sandboxId: state.sandboxId,
    processId: state.processId,
    status: state.finishedAt === null ? "running" : "exited",
    cwd: state.cwd,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    exitCode: state.exitCode,
  };
}

function processKey(sandboxId: string, processId: string): string {
  return `${sandboxId}\0${processId}`;
}

function parseOutputCursor(cursor: string | null): { index: number; offset: number } {
  if (cursor === null) return { index: 0, offset: 0 };
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (match === null) throw new InvalidSandboxOptionsError("Command output cursor is invalid.");
  const index = Number(match[1]);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset)) {
    throw new InvalidSandboxOptionsError("Command output cursor is invalid.");
  }
  return { index, offset };
}

export class DockerBackend implements SandboxBackend {
  readonly reference = REFERENCE;
  readonly capabilities = CAPABILITIES;
  readonly #docker: Dockerode;
  readonly #processes = new Map<string, BackendProcess>();

  constructor() {
    this.#docker = new Dockerode();
  }

  async #run<T extends JsonObject>(
    request: RequestMetadata,
    operation: string,
    work: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<ClientResult<T>> {
    const scope = deadlineScope(request);
    try {
      if (scope.expired()) throw new DOMException("The operation timed out", "AbortError");
      return success(await work(scope.signal));
    } catch (error) {
      return translatedFailure(request.requestId, operation, error, scope.expired());
    } finally {
      scope.dispose();
    }
  }

  createSandbox(request: CreateSandboxRequest): Promise<ClientResult<CreateSandboxResult>> {
    return this.#run(request, "createSandbox", async (signal) => {
      const sandbox = await DockerSandbox.create(this.#docker, createOptions(request, signal));
      return { sandbox: sandboxRecord(sandbox) };
    });
  }

  getSandbox(request: GetSandboxRequest): Promise<ClientResult<GetSandboxResult>> {
    return this.#run(request, "getSandbox", async (signal) => {
      const sandbox = await DockerSandbox.get(this.#docker, {
        name: request.sandboxId,
        resume: request.resume,
        ...(signal === undefined ? {} : { signal }),
      });
      return { sandbox: sandboxRecord(sandbox) };
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
      const listed = await DockerSandbox.list(this.#docker, {
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
        .map(listRecord);
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
      const sandbox = await DockerSandbox.get(this.#docker, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      await sandbox.stop(signal === undefined ? {} : { signal });
      return { sandbox: sandboxRecord(sandbox) };
    });
  }

  deleteSandbox(request: DeleteSandboxRequest): Promise<ClientResult<DeleteSandboxResult>> {
    return this.#run(request, "deleteSandbox", async (signal) => {
      const sandbox = await DockerSandbox.get(this.#docker, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      await sandbox.delete(signal === undefined ? {} : { signal });
      return { sandboxId: request.sandboxId, deletedAt: Date.now() };
    });
  }

  extendSandboxDeadline(
    request: ExtendSandboxDeadlineRequest,
  ): Promise<ClientResult<ExtendSandboxDeadlineResult>> {
    return this.#run(request, "extendSandboxDeadline", async (signal) => {
      const sandbox = await DockerSandbox.get(this.#docker, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      await sandbox.extendTimeout(
        request.additionalMilliseconds,
        signal === undefined ? {} : { signal },
      );
      return { sandbox: sandboxRecord(sandbox) };
    });
  }

  startCommand(request: StartCommandRequest): Promise<ClientResult<StartCommandResult>> {
    return this.#run(request, "startCommand", async (signal) => {
      if (!Number.isSafeInteger(request.outputLimitBytes) || request.outputLimitBytes < 1) {
        throw new InvalidSandboxOptionsError("Command output limit must be a positive integer.");
      }
      const sandbox = await DockerSandbox.get(this.#docker, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      const command = await sandbox.runCommand({
        cmd: request.command.command,
        args: [...request.command.arguments],
        cwd: request.command.cwd,
        env: { ...request.command.environment },
        detached: true,
        ...(signal === undefined ? {} : { signal }),
      });
      const state: BackendProcess = {
        sandboxId: request.sandboxId,
        processId: request.processId,
        command,
        cwd: request.command.cwd,
        startedAt: command.startedAt,
        chunks: [],
        outputLimitBytes: request.outputLimitBytes,
        retainedBytes: 0,
        truncated: false,
        complete: false,
        finishedAt: null,
        exitCode: null,
      };
      this.#processes.set(processKey(request.sandboxId, request.processId), state);
      void (async () => {
        try {
          for await (const chunk of command.logs()) {
            const bytes = Buffer.from(chunk.data);
            const available = state.outputLimitBytes - state.retainedBytes;
            if (bytes.length > available) state.truncated = true;
            if (available <= 0) continue;
            const retained = bytes.subarray(0, available);
            state.chunks.push({ stream: chunk.stream, data: retained.toString("utf8") });
            state.retainedBytes += retained.length;
          }
        } finally {
          state.complete = true;
        }
      })().catch(() => undefined);
      void command.wait().then((finished) => {
        state.finishedAt = state.startedAt + (finished.durationMs ?? 0);
        state.exitCode = finished.exitCode;
      }).catch(() => {
        state.complete = true;
      });
      return { process: processRecord(state) };
    });
  }

  waitForCommand(request: WaitForCommandRequest): Promise<ClientResult<WaitForCommandResult>> {
    return this.#run(request, "waitForCommand", async (signal) => {
      const state = this.#processes.get(processKey(request.sandboxId, request.processId));
      if (state === undefined) throw new SandboxNotFoundError(request.sandboxId);
      const finished = await state.command.wait(signal === undefined ? {} : { signal });
      state.finishedAt = state.startedAt + (finished.durationMs ?? 0);
      state.exitCode = finished.exitCode;
      return {
        result: {
          process: processRecord(state),
          durationMs: finished.durationMs ?? 0,
          exitCode: finished.exitCode,
        },
      };
    });
  }

  signalProcess(request: SignalProcessRequest): Promise<ClientResult<SignalProcessResult>> {
    return this.#run(request, "signalProcess", async (signal) => {
      const state = this.#processes.get(processKey(request.sandboxId, request.processId));
      if (state === undefined) throw new SandboxNotFoundError(request.sandboxId);
      await state.command.kill(request.signal, signal === undefined ? {} : { abortSignal: signal });
      return { process: processRecord(state) };
    });
  }

  readCommandOutput(request: ReadCommandOutputRequest): Promise<ClientResult<ReadCommandOutputResult>> {
    return this.#run(request, "readCommandOutput", async () => {
      const state = this.#processes.get(processKey(request.sandboxId, request.processId));
      if (state === undefined) throw new SandboxNotFoundError(request.sandboxId);
      if (!Number.isSafeInteger(request.limitBytes) || request.limitBytes < 1) {
        throw new InvalidSandboxOptionsError("Command output limit must be a positive integer.");
      }
      let { index, offset } = parseOutputCursor(request.cursor);
      let remaining = request.limitBytes;
      const chunks: CommandOutputChunk[] = [];
      while (index < state.chunks.length && remaining > 0) {
        const chunk = state.chunks[index];
        if (chunk === undefined) break;
        const bytes = Buffer.from(chunk.data);
        if (offset >= bytes.length) {
          index += 1;
          offset = 0;
          continue;
        }
        if (request.stream !== "both" && request.stream !== chunk.stream) {
          index += 1;
          offset = 0;
          continue;
        }
        const length = Math.min(remaining, bytes.length - offset);
        chunks.push({ stream: chunk.stream, data: bytes.subarray(offset, offset + length).toString("utf8") });
        remaining -= length;
        offset += length;
        if (offset >= bytes.length) {
          index += 1;
          offset = 0;
        }
      }
      const caughtUp = index >= state.chunks.length;
      return {
        chunks,
        nextCursor: state.complete && caughtUp ? null : `${index}:${offset}`,
        complete: state.complete && caughtUp,
        truncated: state.truncated,
      };
    });
  }

  readFile(request: ReadFileRequest): Promise<ClientResult<ReadFileResult>> {
    return this.#run(request, "readFile", async (signal) => {
      if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
        throw new InvalidSandboxOptionsError("File offset must be a non-negative integer.");
      }
      if (!Number.isSafeInteger(request.limitBytes) || request.limitBytes < 1) {
        throw new InvalidSandboxOptionsError("File read limit must be a positive integer.");
      }
      const sandbox = await DockerSandbox.get(this.#docker, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      const contents = await sandbox.fs.readFile(
        request.path,
        signal === undefined ? null : { encoding: null, signal },
      );
      const page = contents.subarray(request.offset, request.offset + request.limitBytes);
      const nextOffset = request.offset + page.length;
      return {
        path: request.path,
        content: {
          encoding: request.encoding,
          data: request.encoding === "base64" ? page.toString("base64") : page.toString("utf8"),
        },
        bytesRead: page.length,
        nextOffset,
        endOfFile: nextOffset >= contents.length,
      };
    });
  }

  writeFile(request: WriteFileRequest): Promise<ClientResult<WriteFileResult>> {
    return this.#run(request, "writeFile", async (signal) => {
      const sandbox = await DockerSandbox.get(this.#docker, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      const contents = Buffer.from(request.content.data, request.content.encoding);
      await sandbox.fs.writeFile(request.path, contents, {
        ...(request.mode === null ? {} : { mode: request.mode }),
        ...(signal === undefined ? {} : { signal }),
      });
      return { path: request.path, bytesWritten: contents.length };
    });
  }

  makeDirectory(request: MakeDirectoryRequest): Promise<ClientResult<MakeDirectoryResult>> {
    return this.#run(request, "makeDirectory", async (signal) => {
      const sandbox = await DockerSandbox.get(this.#docker, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      const created = await sandbox.fs.mkdir(request.path, {
        recursive: request.recursive,
        ...(request.mode === null ? {} : { mode: request.mode }),
        ...(signal === undefined ? {} : { signal }),
      });
      return { path: request.path, created: created !== undefined };
    });
  }

  getEndpoint(request: GetEndpointRequest): Promise<ClientResult<GetEndpointResult>> {
    return this.#run(request, "getEndpoint", async (signal) => {
      const sandbox = await DockerSandbox.get(this.#docker, { name: request.sandboxId, ...(signal === undefined ? {} : { signal }) });
      const url = sandbox.domain(request.port);
      return {
        endpoint: {
          endpointId: `${request.sandboxId}:${request.port}`,
          sandboxId: request.sandboxId,
          port: request.port,
          protocol: "http",
          url,
          visibility: "loopback",
          backend: REFERENCE,
        },
      };
    });
  }
}

export {
  MANAGED_IMAGES,
  MANAGED_IMAGE_REGISTRY,
  MANAGED_IMAGE_UPSTREAM_COMMIT,
} from "./managed-images.js";
