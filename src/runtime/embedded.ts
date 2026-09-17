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
  ErrorCategory,
  JsonObject,
  ListSandboxesRequest,
  ListSandboxesResult,
  MakeDirectoryRequest,
  MakeDirectoryResult,
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

type BackendOperation = keyof SandboxClient;
type OperationRequest<Operation extends BackendOperation> = Parameters<SandboxClient[Operation]>[0];
type OperationResult<Operation extends BackendOperation> = Awaited<
  ReturnType<SandboxClient[Operation]>
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
  operation: BackendOperation,
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

/** In-process client bound permanently to one explicitly supplied backend. */
export class EmbeddedSandboxClient implements SandboxClient {
  readonly backend: SandboxBackend;
  readonly backendReference: BackendReference;
  readonly #capabilities: ReadonlySet<SandboxCapability>;

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

  deleteSandbox(request: DeleteSandboxRequest): Promise<ClientResult<DeleteSandboxResult>> {
    return this.#invoke("deleteSandbox", request);
  }

  extendSandboxDeadline(
    request: ExtendSandboxDeadlineRequest,
  ): Promise<ClientResult<ExtendSandboxDeadlineResult>> {
    return this.#invoke("extendSandboxDeadline", request);
  }

  startCommand(request: StartCommandRequest): Promise<ClientResult<StartCommandResult>> {
    return this.#invoke("startCommand", request);
  }

  waitForCommand(request: WaitForCommandRequest): Promise<ClientResult<WaitForCommandResult>> {
    return this.#invoke("waitForCommand", request);
  }

  signalProcess(request: SignalProcessRequest): Promise<ClientResult<SignalProcessResult>> {
    return this.#invoke("signalProcess", request);
  }

  readCommandOutput(
    request: ReadCommandOutputRequest,
  ): Promise<ClientResult<ReadCommandOutputResult>> {
    return this.#invoke("readCommandOutput", request);
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
