import { randomUUID } from "node:crypto";
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
  GetEndpointResult,
  GetSandboxRequest,
  GetSandboxResult,
  ErrorCategory,
  JsonObject,
  ListSandboxesRequest,
  ListSandboxesResult,
  MakeDirectoryRequest,
  MakeDirectoryResult,
  ProcessRecord,
  ProcessSignal,
  RawCommand,
  RawCommandEvent,
  ReadCommandOutputRequest,
  ReadCommandOutputResult,
  ReadFileRequest,
  ReadFileResult,
  RequestMetadata,
  SandboxBackend,
  SandboxCapability,
  SandboxClient,
  SandboxErrorDetails,
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
} from "./index.js";

const ERROR_CATEGORIES: Record<ErrorCategory, true> = {
  "invalid-request": true,
  "unsupported-requirement": true,
  "already-exists": true,
  "not-found": true,
  "failed-precondition": true,
  "deadline-exceeded": true,
  cancelled: true,
  "backend-unavailable": true,
  "backend-failure": true,
  "source-failure": true,
  "image-failure": true,
  internal: true,
};

const ERROR_DETAIL_TYPES: Record<SandboxErrorDetails["type"], true> = {
  "invalid-request": true,
  "unsupported-requirements": true,
  resource: true,
  backend: true,
  source: true,
  none: true,
};

const SANDBOX_CAPABILITIES: Record<SandboxCapability, true> = {
  "command.start": true,
  "command.detached": true,
  "endpoint.expose": true,
  "filesystem.mkdir": true,
  "filesystem.read": true,
  "filesystem.write": true,
  "sandbox.network.allow-all": true,
  "sandbox.network.deny-all": true,
  "sandbox.persistence": true,
  "sandbox.resource-limits": true,
  "sandbox.source.git": true,
  "sandbox.source.tarball": true,
};

type BackendOperation = Exclude<
  keyof SandboxClient,
  "startCommand" | "waitForCommand" | "signalProcess" | "readCommandOutput"
>;
type OperationRequest<Operation extends BackendOperation> = Parameters<SandboxBackend[Operation]>[0];
type OperationResult<Operation extends BackendOperation> = Awaited<
  ReturnType<SandboxBackend[Operation]>
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isJsonCompatible(value: unknown): boolean {
  const pending: [value: unknown, exiting: boolean][] = [[value, false]];
  const ancestors = new Set<object>();

  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const [current, exiting] = entry;
    if (exiting) {
      ancestors.delete(current as object);
      continue;
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object") return false;
    if (ancestors.has(current)) return false;
    ancestors.add(current);
    pending.push([current, true]);

    if (Array.isArray(current)) {
      const keys = Reflect.ownKeys(current);
      if (
        keys.length !== current.length + 1 ||
        keys.some((key) => typeof key !== "string")
      ) {
        return false;
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          return false;
        }
        pending.push([descriptor.value, false]);
      }
      continue;
    }

    if (!isPlainObject(current)) return false;
    const keys = Reflect.ownKeys(current);
    if (keys.some((key) => typeof key !== "string")) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return false;
      }
      pending.push([descriptor.value, false]);
    }
  }

  return true;
}

function isBackendReference(value: unknown): value is BackendReference {
  return (
    isPlainObject(value) &&
    typeof value.backendId === "string" &&
    typeof value.backendType === "string"
  );
}

function isErrorDetails(value: unknown): value is SandboxErrorDetails {
  if (
    !isPlainObject(value) ||
    typeof value.type !== "string" ||
    !Object.hasOwn(ERROR_DETAIL_TYPES, value.type)
  ) {
    return false;
  }

  switch (value.type) {
    case "invalid-request":
      return (
        (value.field === null || typeof value.field === "string") &&
        typeof value.reason === "string"
      );
    case "unsupported-requirements":
      return (
        Array.isArray(value.requirements) &&
        value.requirements.every(
          (item) =>
            isPlainObject(item) &&
            typeof item.reason === "string" &&
            isPlainObject(item.requirement) &&
            typeof item.requirement.capability === "string" &&
            Object.hasOwn(SANDBOX_CAPABILITIES, item.requirement.capability) &&
            (item.requirement.parameters === null ||
              isPlainObject(item.requirement.parameters)),
        )
      );
    case "resource":
      return (
        (value.resource === "sandbox" ||
          value.resource === "process" ||
          value.resource === "endpoint") &&
        typeof value.resourceId === "string"
      );
    case "backend":
      return typeof value.operation === "string";
    case "source":
      return value.sourceType === "git" || value.sourceType === "tarball";
    case "none":
      return true;
    default:
      return false;
  }
}

function isContractFailure(value: unknown, requestId: string): value is ClientFailure {
  if (!isJsonCompatible(value) || !isPlainObject(value) || value.ok !== false) return false;
  const error = value.error;
  if (!isPlainObject(error)) return false;
  return (
    typeof error.category === "string" &&
    Object.hasOwn(ERROR_CATEGORIES, error.category) &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean" &&
    error.requestId === requestId &&
    (error.backend === null || isBackendReference(error.backend)) &&
    isErrorDetails(error.details)
  );
}

function isContractResult(value: unknown, requestId: string): value is ClientResult<JsonObject> {
  if (!isJsonCompatible(value) || !isPlainObject(value)) return false;
  if (value.ok === false) return isContractFailure(value, requestId);
  return value.ok === true && isPlainObject(value.value);
}

function backendFailure(
  requestId: string,
  backend: BackendReference,
  operation: string,
): ClientFailure {
  return {
    ok: false,
    error: {
      category: "backend-failure",
      code: "LOCALBOX_BACKEND_FAILURE",
      message: "The backend failed to complete the operation.",
      retryable: false,
      requestId,
      backend,
      details: { type: "backend", operation },
    },
  };
}

function backendMismatch(
  request: CreateSandboxRequest,
  backend: BackendReference,
): ClientFailure {
  return {
    ok: false,
    error: {
      category: "invalid-request",
      code: "LOCALBOX_BACKEND_MISMATCH",
      message: "The requested backend does not match the configured backend.",
      retryable: false,
      requestId: request.requestId,
      backend,
      details: {
        type: "invalid-request",
        field: "backend",
        reason: `Requested ${request.backend?.backendType}/${request.backend?.backendId}; configured ${backend.backendType}/${backend.backendId}.`,
      },
    },
  };
}

function unsupportedRequirements(
  request: CreateSandboxRequest,
  backend: BackendReference,
  capabilities: ReadonlySet<SandboxCapability>,
): ClientFailure | null {
  const requirements = request.requirements
    .filter((requirement) => !capabilities.has(requirement.capability))
    .map((requirement) => ({
      requirement,
      reason: `Backend ${backend.backendType}/${backend.backendId} does not advertise ${requirement.capability}.`,
    }));
  if (requirements.length === 0) return null;

  return {
    ok: false,
    error: {
      category: "unsupported-requirement",
      code: "LOCALBOX_UNSUPPORTED_REQUIREMENT",
      message: "The selected backend cannot satisfy all sandbox requirements.",
      retryable: false,
      requestId: request.requestId,
      backend,
      details: { type: "unsupported-requirements", requirements },
    },
  };
}

type ProcessFailure = Extract<RawCommandEvent, { type: "backend-failure" }> | {
  readonly type: "deleted";
};

type ProcessOutcome =
  | {
    readonly type: "complete";
    readonly exitCode: number;
    readonly finishedAt: number;
  }
  | ProcessFailure;

interface RuntimeProcess {
  readonly sandboxId: string;
  readonly processId: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly raw: RawCommand;
  readonly outputLimitBytes: number;
  readonly chunks: CommandOutputChunk[];
  readonly followers: Set<() => void>;
  readonly completion: Promise<ProcessOutcome>;
  readonly resolveCompletion: (outcome: ProcessOutcome) => void;
  readonly signals: Map<ProcessSignal, Promise<void>>;
  retainedBytes: number;
  truncated: boolean;
  version: number;
  outcome: ProcessOutcome | undefined;
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
  let expired = false;
  const remaining = request.deadline.expiresAt - Date.now();
  if (remaining <= 0) {
    expired = true;
    controller.abort();
    return { signal: controller.signal, expired: () => expired, dispose: () => undefined };
  }
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, remaining);
  timer.unref();
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose: () => clearTimeout(timer),
  };
}

function processKey(sandboxId: string, processId: string): string {
  return `${sandboxId}\0${processId}`;
}

function success<T extends JsonObject>(value: T): ClientResult<T> {
  return { ok: true, value };
}

function processFailure(
  request: RequestMetadata,
  backend: BackendReference,
  code: string,
  message: string,
  category: ErrorCategory,
  operation: string,
): ClientFailure {
  return {
    ok: false,
    error: {
      category,
      code,
      message,
      retryable: false,
      requestId: request.requestId,
      backend,
      details: { type: "backend", operation },
    },
  };
}

function invalidRequest(
  request: RequestMetadata,
  backend: BackendReference,
  field: string,
  reason: string,
): ClientFailure {
  return {
    ok: false,
    error: {
      category: "invalid-request",
      code: "LOCALBOX_INVALID_REQUEST",
      message: reason,
      retryable: false,
      requestId: request.requestId,
      backend,
      details: { type: "invalid-request", field, reason },
    },
  };
}

function missingProcess(
  request: RequestMetadata & { sandboxId: string; processId: string },
  backend: BackendReference,
): ClientFailure {
  return {
    ok: false,
    error: {
      category: "not-found",
      code: "LOCALBOX_PROCESS_NOT_FOUND",
      message: `Process "${request.processId}" was not found.`,
      retryable: false,
      requestId: request.requestId,
      backend,
      details: {
        type: "resource",
        resource: "process",
        resourceId: request.processId,
      },
    },
  };
}

function record(state: RuntimeProcess): ProcessRecord {
  const outcome = state.outcome;
  return {
    sandboxId: state.sandboxId,
    processId: state.processId,
    status: outcome?.type === "complete" ? "exited" : "running",
    cwd: state.cwd,
    startedAt: state.startedAt,
    finishedAt: outcome?.type === "complete" ? outcome.finishedAt : null,
    exitCode: outcome?.type === "complete" ? outcome.exitCode : null,
  };
}

function wakeFollowers(state: RuntimeProcess): void {
  state.version += 1;
  for (const wake of state.followers) wake();
  state.followers.clear();
}

function settleProcess(state: RuntimeProcess, outcome: ProcessOutcome): void {
  if (state.outcome !== undefined) return;
  state.outcome = outcome;
  state.resolveCompletion(outcome);
  wakeFollowers(state);
}

function isRawCommandEvent(value: unknown): value is RawCommandEvent {
  if (!isJsonCompatible(value) || !isPlainObject(value) || typeof value.type !== "string") {
    return false;
  }
  switch (value.type) {
    case "stdout":
    case "stderr":
      return typeof value.data === "string";
    case "complete":
      return (
        typeof value.exitCode === "number" &&
        Number.isFinite(value.exitCode) &&
        typeof value.finishedAt === "number" &&
        Number.isFinite(value.finishedAt)
      );
    case "backend-failure":
      return (
        typeof value.code === "string" &&
        typeof value.message === "string" &&
        typeof value.retryable === "boolean"
      );
    default:
      return false;
  }
}

function retainOutput(
  state: RuntimeProcess,
  event: Extract<RawCommandEvent, { type: "stdout" | "stderr" }>,
): void {
  if (event.data.length === 0) return;
  const bytes = Buffer.from(event.data);
  const available = state.outputLimitBytes - state.retainedBytes;
  if (bytes.length > available) state.truncated = true;
  if (available > 0) {
    const retained = bytes.subarray(0, available);
    state.chunks.push({ stream: event.type, data: retained.toString("utf8") });
    state.retainedBytes += retained.length;
  }
  wakeFollowers(state);
}

async function consumeRawCommand(state: RuntimeProcess): Promise<void> {
  try {
    for await (const event of state.raw.events) {
      if (!isRawCommandEvent(event)) {
        settleProcess(state, {
          type: "backend-failure",
          code: "LOCALBOX_BACKEND_FAILURE",
          message: "The backend emitted an invalid command event.",
          retryable: false,
        });
        return;
      }
      if (event.type === "stdout" || event.type === "stderr") {
        retainOutput(state, event);
        continue;
      }
      settleProcess(state, event);
      return;
    }
    settleProcess(state, {
      type: "backend-failure",
      code: "LOCALBOX_BACKEND_FAILURE",
      message: "The backend command event stream ended before completion.",
      retryable: false,
    });
  } catch {
    settleProcess(state, {
      type: "backend-failure",
      code: "LOCALBOX_BACKEND_FAILURE",
      message: "The backend command event stream failed.",
      retryable: false,
    });
  } finally {
    await state.raw.dispose().catch(() => undefined);
  }
}

function outcomeFailure(
  request: RequestMetadata,
  backend: BackendReference,
  outcome: ProcessFailure,
): ClientFailure {
  if (outcome.type === "deleted") {
    return processFailure(
      request,
      backend,
      "LOCALBOX_OPERATION_CANCELLED",
      "The command was cancelled because its sandbox was deleted.",
      "cancelled",
      "waitForCommand",
    );
  }
  return {
    ok: false,
    error: {
      category: "backend-failure",
      code: outcome.code,
      message: outcome.message,
      retryable: outcome.retryable,
      requestId: request.requestId,
      backend,
      details: { type: "backend", operation: "command" },
    },
  };
}

function parseOutputCursor(cursor: string | null): { index: number; offset: number } | null {
  if (cursor === null) return { index: 0, offset: 0 };
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (match === null) return null;
  const index = Number(match[1]);
  const offset = Number(match[2]);
  return Number.isSafeInteger(index) && Number.isSafeInteger(offset)
    ? { index, offset }
    : null;
}

function outputPage(
  state: RuntimeProcess,
  request: ReadCommandOutputRequest,
  cursor: { index: number; offset: number },
): ReadCommandOutputResult {
  let { index, offset } = cursor;
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
    chunks.push({
      stream: chunk.stream,
      data: bytes.subarray(offset, offset + length).toString("utf8"),
    });
    remaining -= length;
    offset += length;
    if (offset >= bytes.length) {
      index += 1;
      offset = 0;
    }
  }
  const caughtUp = index >= state.chunks.length;
  const complete = state.outcome !== undefined && caughtUp;
  return {
    chunks,
    nextCursor: complete ? null : `${index}:${offset}`,
    complete,
    truncated: state.truncated,
  };
}

async function awaitProcessChange(
  state: RuntimeProcess,
  version: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (state.version !== version) return;
  const deferred = Promise.withResolvers<void>();
  const wake = (): void => deferred.resolve();
  const abort = (): void => deferred.reject(new DOMException("The operation timed out", "AbortError"));
  state.followers.add(wake);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (state.version !== version) return;
    await deferred.promise;
  } finally {
    state.followers.delete(wake);
    signal?.removeEventListener("abort", abort);
  }
}
/** In-process client bound permanently to one explicitly supplied backend. */
export class EmbeddedSandboxClient implements SandboxClient {
  readonly backend: SandboxBackend;
  readonly backendReference: BackendReference;
  readonly #capabilities: ReadonlySet<SandboxCapability>;
  readonly #processes = new Map<string, RuntimeProcess>();

  constructor(backend: SandboxBackend) {
    if (!isBackendReference(backend.reference)) {
      throw new TypeError("EmbeddedSandboxClient requires a valid backend reference.");
    }
    this.backend = backend;
    this.backendReference = Object.freeze({
      backendId: backend.reference.backendId,
      backendType: backend.reference.backendType,
    });
    this.#capabilities = new Set(backend.capabilities);
  }

  async createSandbox(request: CreateSandboxRequest): Promise<ClientResult<CreateSandboxResult>> {
    const selected = this.backendReference;
    if (
      request.backend !== null &&
      (request.backend.backendId !== selected.backendId ||
        request.backend.backendType !== selected.backendType)
    ) {
      return backendMismatch(request, selected);
    }

    const unsupported = unsupportedRequirements(request, selected, this.#capabilities);
    if (unsupported !== null) return unsupported;
    return this.#invoke("createSandbox", request);
  }

  getSandbox(request: GetSandboxRequest): Promise<ClientResult<GetSandboxResult>> {
    return this.#invoke("getSandbox", request);
  }

  listSandboxes(request: ListSandboxesRequest): Promise<ClientResult<ListSandboxesResult>> {
    return this.#invoke("listSandboxes", request);
  }

  stopSandbox(request: StopSandboxRequest): Promise<ClientResult<StopSandboxResult>> {
    return this.#invoke("stopSandbox", request);
  }

  async deleteSandbox(
    request: DeleteSandboxRequest,
  ): Promise<ClientResult<DeleteSandboxResult>> {
    const result = await this.#invoke("deleteSandbox", request);
    if (!result.ok) return result;

    const disposals: Promise<void>[] = [];
    for (const [key, state] of this.#processes) {
      if (state.sandboxId !== request.sandboxId) continue;
      this.#processes.delete(key);
      settleProcess(state, { type: "deleted" });
      disposals.push(state.raw.dispose().catch(() => undefined));
    }
    await Promise.all(disposals);
    return result;
  }

  extendSandboxDeadline(
    request: ExtendSandboxDeadlineRequest,
  ): Promise<ClientResult<ExtendSandboxDeadlineResult>> {
    return this.#invoke("extendSandboxDeadline", request);
  }

  async startCommand(
    request: StartCommandRequest,
  ): Promise<ClientResult<StartCommandResult>> {
    if (!Number.isSafeInteger(request.outputLimitBytes) || request.outputLimitBytes < 1) {
      return invalidRequest(
        request,
        this.backendReference,
        "outputLimitBytes",
        "Command output limit must be a positive integer.",
      );
    }

    const scope = deadlineScope(request);
    try {
      if (scope.expired()) {
        return processFailure(
          request,
          this.backendReference,
          "LOCALBOX_DEADLINE_EXCEEDED",
          "The operation timed out.",
          "deadline-exceeded",
          "startCommand",
        );
      }
      const started = await this.backend.startRawCommand({
        requestId: request.requestId,
        deadline: request.deadline,
        sandboxId: request.sandboxId,
        command: request.command,
      }, scope.signal);
      if (!started.ok) {
        return isContractFailure(started, request.requestId)
          ? started
          : backendFailure(request.requestId, this.backendReference, "startCommand");
      }
      const raw = started.command;
      if (
        raw === null ||
        typeof raw !== "object" ||
        !Number.isFinite(raw.startedAt) ||
        typeof raw.events?.[Symbol.asyncIterator] !== "function" ||
        typeof raw.signal !== "function" ||
        typeof raw.dispose !== "function"
      ) {
        if (raw !== null && typeof raw === "object" && typeof raw.dispose === "function") {
          await Promise.resolve(raw.dispose()).catch(() => undefined);
        }
        return backendFailure(request.requestId, this.backendReference, "startCommand");
      }

      const processId = randomUUID();
      const completion = Promise.withResolvers<ProcessOutcome>();
      const state: RuntimeProcess = {
        sandboxId: request.sandboxId,
        processId,
        cwd: request.command.cwd,
        startedAt: raw.startedAt,
        raw,
        outputLimitBytes: request.outputLimitBytes,
        chunks: [],
        followers: new Set(),
        completion: completion.promise,
        resolveCompletion: completion.resolve,
        signals: new Map(),
        retainedBytes: 0,
        truncated: false,
        version: 0,
        outcome: undefined,
      };
      this.#processes.set(processKey(state.sandboxId, state.processId), state);
      void consumeRawCommand(state);
      return success({ process: record(state) });
    } catch {
      return processFailure(
        request,
        this.backendReference,
        scope.expired() ? "LOCALBOX_DEADLINE_EXCEEDED" : "LOCALBOX_BACKEND_FAILURE",
        scope.expired()
          ? "The operation timed out."
          : "The backend failed to start the command.",
        scope.expired() ? "deadline-exceeded" : "backend-failure",
        "startCommand",
      );
    } finally {
      scope.dispose();
    }
  }

  async waitForCommand(
    request: WaitForCommandRequest,
  ): Promise<ClientResult<WaitForCommandResult>> {
    const state = this.#processes.get(processKey(request.sandboxId, request.processId));
    if (state === undefined) return missingProcess(request, this.backendReference);

    let outcome = state.outcome;
    if (outcome === undefined) {
      const scope = deadlineScope(request);
      if (scope.expired()) {
        scope.dispose();
        return processFailure(
          request,
          this.backendReference,
          "LOCALBOX_DEADLINE_EXCEEDED",
          "The operation timed out.",
          "deadline-exceeded",
          "waitForCommand",
        );
      }
      const aborted = Promise.withResolvers<ProcessOutcome>();
      const abort = (): void => aborted.reject(new DOMException("The operation timed out", "AbortError"));
      scope.signal?.addEventListener("abort", abort, { once: true });
      try {
        outcome = await Promise.race([state.completion, aborted.promise]);
      } catch {
        return processFailure(
          request,
          this.backendReference,
          "LOCALBOX_DEADLINE_EXCEEDED",
          "The operation timed out.",
          "deadline-exceeded",
          "waitForCommand",
        );
      } finally {
        scope.signal?.removeEventListener("abort", abort);
        scope.dispose();
      }
    }

    if (outcome.type !== "complete") {
      return outcomeFailure(request, this.backendReference, outcome);
    }
    return success({
      result: {
        process: record(state),
        durationMs: Math.max(0, outcome.finishedAt - state.startedAt),
        exitCode: outcome.exitCode,
      },
    });
  }

  async signalProcess(
    request: SignalProcessRequest,
  ): Promise<ClientResult<SignalProcessResult>> {
    const state = this.#processes.get(processKey(request.sandboxId, request.processId));
    if (state === undefined) return missingProcess(request, this.backendReference);
    if (state.outcome !== undefined) return success({ process: record(state) });

    let delivery = state.signals.get(request.signal);
    if (delivery === undefined) {
      const scope = deadlineScope(request);
      if (scope.expired()) {
        scope.dispose();
        return processFailure(
          request,
          this.backendReference,
          "LOCALBOX_DEADLINE_EXCEEDED",
          "The operation timed out.",
          "deadline-exceeded",
          "signalProcess",
        );
      }
      delivery = state.raw.signal(request.signal, scope.signal).finally(scope.dispose);
      state.signals.set(request.signal, delivery);
      void delivery.catch(() => {
        if (state.signals.get(request.signal) === delivery) {
          state.signals.delete(request.signal);
        }
      });
    }
    try {
      await delivery;
      return success({ process: record(state) });
    } catch {
      const expired = request.deadline !== null && request.deadline.expiresAt <= Date.now();
      return processFailure(
        request,
        this.backendReference,
        expired ? "LOCALBOX_DEADLINE_EXCEEDED" : "LOCALBOX_BACKEND_FAILURE",
        expired ? "The operation timed out." : "The backend failed to signal the command.",
        expired ? "deadline-exceeded" : "backend-failure",
        "signalProcess",
      );
    }
  }

  async readCommandOutput(
    request: ReadCommandOutputRequest,
  ): Promise<ClientResult<ReadCommandOutputResult>> {
    const state = this.#processes.get(processKey(request.sandboxId, request.processId));
    if (state === undefined) return missingProcess(request, this.backendReference);
    if (!Number.isSafeInteger(request.limitBytes) || request.limitBytes < 1) {
      return invalidRequest(
        request,
        this.backendReference,
        "limitBytes",
        "Command output limit must be a positive integer.",
      );
    }
    const cursor = parseOutputCursor(request.cursor);
    if (cursor === null) {
      return invalidRequest(
        request,
        this.backendReference,
        "cursor",
        "Command output cursor is invalid.",
      );
    }

    const scope = deadlineScope(request);
    if (scope.expired()) {
      scope.dispose();
      return processFailure(
        request,
        this.backendReference,
        "LOCALBOX_DEADLINE_EXCEEDED",
        "The operation timed out.",
        "deadline-exceeded",
        "readCommandOutput",
      );
    }
    try {
      const version = state.version;
      const page = outputPage(state, request, cursor);
      if (page.chunks.length > 0 || page.complete || !request.follow) {
        return success(page);
      }
      try {
        await awaitProcessChange(state, version, scope.signal);
      } catch {
        return processFailure(
          request,
          this.backendReference,
          "LOCALBOX_DEADLINE_EXCEEDED",
          "The operation timed out.",
          "deadline-exceeded",
          "readCommandOutput",
        );
      }
      return success(outputPage(state, request, cursor));
    } finally {
      scope.dispose();
    }
  }

  readFile(request: ReadFileRequest): Promise<ClientResult<ReadFileResult>> {
    return this.#invoke("readFile", request);
  }

  writeFile(request: WriteFileRequest): Promise<ClientResult<WriteFileResult>> {
    return this.#invoke("writeFile", request);
  }

  makeDirectory(request: MakeDirectoryRequest): Promise<ClientResult<MakeDirectoryResult>> {
    return this.#invoke("makeDirectory", request);
  }

  getEndpoint(request: GetEndpointRequest): Promise<ClientResult<GetEndpointResult>> {
    return this.#invoke("getEndpoint", request);
  }

  async #invoke<Operation extends BackendOperation>(
    operation: Operation,
    request: OperationRequest<Operation>,
  ): Promise<OperationResult<Operation>> {
    try {
      const invoke = this.backend[operation] as (
        request: RequestMetadata,
      ) => Promise<unknown>;
      const result = await invoke.call(this.backend, request);
      if (isContractResult(result, request.requestId)) {
        return result as OperationResult<Operation>;
      }
    } catch {
      // Backend implementation failures are normalized below.
    }
    return backendFailure(
      request.requestId,
      this.backendReference,
      operation,
    ) as OperationResult<Operation>;
  }
}
