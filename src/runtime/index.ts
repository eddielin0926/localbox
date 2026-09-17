/** JSON values accepted at the Localbox client boundary. */
export type JsonPrimitive = boolean | number | string | null;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type RequestId = string;
export type IdempotencyKey = string;
export type SandboxId = string;
export type ProcessId = string;
export type BackendId = string;
export type EndpointId = string;
export type OutputCursor = string;
export type PageCursor = string;
export type TimestampMilliseconds = number;

export type SandboxStatus = "pending" | "running" | "stopping" | "stopped" | "failed";
export type ProcessStatus = "running" | "exited";
export type OutputStream = "stdout" | "stderr" | "both";

export type Deadline = JsonObject & {
  /** Absolute Unix timestamp in milliseconds. */
  readonly expiresAt: TimestampMilliseconds;
};

export type RequestMetadata = JsonObject & {
  readonly requestId: RequestId;
  readonly deadline: Deadline | null;
};
export type ProcessSignal =
  | "SIGHUP"
  | "SIGINT"
  | "SIGQUIT"
  | "SIGKILL"
  | "SIGTERM"
  | "SIGCONT"
  | "SIGSTOP"
  | number;

export type MutationMetadata = RequestMetadata & {
  readonly idempotencyKey: IdempotencyKey;
};

export type SandboxReference = JsonObject & {
  readonly sandboxId: SandboxId;
};

export type ProcessReference = SandboxReference & {
  readonly processId: ProcessId;
};

export type EndpointReference = SandboxReference & {
  readonly endpointId: EndpointId;
};

/**
 * A diagnostic reference to a configured backend instance. The reference is
 * data only; it cannot be used as an in-process backend handle.
 */
export type BackendReference = JsonObject & {
  readonly backendId: BackendId;
  readonly backendType: string;
};

export type SandboxCapability =
  | "command.start"
  | "command.detached"
  | "endpoint.expose"
  | "filesystem.mkdir"
  | "filesystem.read"
  | "filesystem.write"
  | "sandbox.network.allow-all"
  | "sandbox.network.deny-all"
  | "sandbox.persistence"
  | "sandbox.resource-limits"
  | "sandbox.source.git"
  | "sandbox.source.tarball";

/** A semantic requirement that must be checked before sandbox creation. */
export type SandboxRequirement = JsonObject & {
  readonly capability: SandboxCapability;
  readonly parameters: JsonObject | null;
};

export type UnsupportedSandboxRequirement = JsonObject & {
  readonly requirement: SandboxRequirement;
  readonly reason: string;
};

export type RuntimeBootSource = JsonObject & {
  readonly type: "runtime";
  readonly runtime: string;
};

export type ImageBootSource = JsonObject & {
  readonly type: "image";
  readonly image: string;
};

export type SandboxBootSource = RuntimeBootSource | ImageBootSource;

export type GitSandboxSource = JsonObject & {
  readonly type: "git";
  readonly url: string;
  readonly revision: string | null;
  readonly depth: number | null;
  readonly credentials: (JsonObject & {
    readonly username: string;
    readonly password: string;
  }) | null;
};

export type TarballSandboxSource = JsonObject & {
  readonly type: "tarball";
  readonly url: string;
};

export type SandboxSource = GitSandboxSource | TarballSandboxSource;
export type SandboxNetworkPolicy = "allow-all" | "deny-all";

export type SandboxResources = JsonObject & {
  readonly vcpus: number | null;
  readonly memoryBytes: number | null;
};

/** Complete desired state used to create a sandbox. */
export type SandboxSpec = JsonObject & {
  readonly name: string;
  readonly bootSource: SandboxBootSource;
  readonly source: SandboxSource | null;
  readonly persistent: boolean;
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly ports: readonly number[];
  readonly networkPolicy: SandboxNetworkPolicy;
  readonly resources: SandboxResources;
  readonly region: string | null;
  readonly failoverRegions: readonly string[];
};

/** Backend-neutral observed state returned by lifecycle operations. */
export type SandboxRecord = JsonObject & {
  readonly sandboxId: SandboxId;
  readonly name: string;
  readonly status: SandboxStatus;
  readonly persistent: boolean;
  readonly bootSource: SandboxBootSource;
  readonly backend: BackendReference;
  readonly createdAt: TimestampMilliseconds;
  readonly updatedAt: TimestampMilliseconds;
  readonly statusUpdatedAt: TimestampMilliseconds;
  readonly expiresAt: TimestampMilliseconds | null;
  readonly timeoutMs: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly ports: readonly number[];
  readonly resources: SandboxResources;
  readonly region: string | null;
  readonly failoverRegions: readonly string[];
};

export type CreateSandboxRequest = MutationMetadata & SandboxReference & {
  /** null asks the runtime to select a backend. */
  readonly backend: BackendReference | null;
  readonly requirements: readonly SandboxRequirement[];
  readonly spec: SandboxSpec;
};

export type CreateSandboxResult = JsonObject & {
  readonly sandbox: SandboxRecord;
};

/**
 * Getting with resume=true may mutate lifecycle state, so it carries the same
 * idempotency identity as every other lifecycle mutation.
 */
export type GetSandboxRequest = MutationMetadata & SandboxReference & {
  readonly resume: boolean;
};

export type GetSandboxResult = JsonObject & {
  readonly sandbox: SandboxRecord;
};

export type ListSandboxesRequest = RequestMetadata & {
  readonly namePrefix: string | null;
  readonly tags: Readonly<Record<string, string>>;
  readonly statuses: readonly SandboxStatus[];
  readonly sortBy: "createdAt" | "name" | "statusUpdatedAt";
  readonly sortOrder: "asc" | "desc";
  readonly limit: number;
  readonly cursor: PageCursor | null;
};

export type ListSandboxesResult = JsonObject & {
  readonly sandboxes: readonly SandboxRecord[];
  readonly nextCursor: PageCursor | null;
};

export type StopSandboxRequest = MutationMetadata & SandboxReference;

export type StopSandboxResult = JsonObject & {
  readonly sandbox: SandboxRecord;
};

export type DeleteSandboxRequest = MutationMetadata & SandboxReference;

export type DeleteSandboxResult = JsonObject & {
  readonly sandboxId: SandboxId;
  readonly deletedAt: TimestampMilliseconds;
};

export type ExtendSandboxDeadlineRequest = MutationMetadata & SandboxReference & {
  readonly additionalMilliseconds: number;
};

export type ExtendSandboxDeadlineResult = JsonObject & {
  readonly sandbox: SandboxRecord;
};

export type CommandSpec = JsonObject & {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
};

/**
 * Output is retained by the runtime and retrieved through readCommandOutput;
 * callers never pass streams or callbacks across the client boundary.
 */
export type StartCommandRequest = MutationMetadata & ProcessReference & {
  readonly command: CommandSpec;
  readonly outputLimitBytes: number;
};

export type ProcessRecord = JsonObject & {
  readonly sandboxId: SandboxId;
  readonly processId: ProcessId;
  readonly status: ProcessStatus;
  readonly cwd: string;
  readonly startedAt: TimestampMilliseconds;
  readonly finishedAt: TimestampMilliseconds | null;
  readonly exitCode: number | null;
};

export type StartCommandResult = JsonObject & {
  readonly process: ProcessRecord;
};

export type WaitForCommandRequest = RequestMetadata & ProcessReference;

export type CommandResult = JsonObject & {
  readonly process: ProcessRecord;
  readonly durationMs: number;
  readonly exitCode: number;
};

export type WaitForCommandResult = JsonObject & {
  readonly result: CommandResult;
};
export type SignalProcessRequest = MutationMetadata & ProcessReference & {
  readonly signal: ProcessSignal;
};

export type SignalProcessResult = JsonObject & {
  readonly process: ProcessRecord;
};


export type ReadCommandOutputRequest = RequestMetadata & ProcessReference & {
  readonly stream: OutputStream;
  readonly cursor: OutputCursor | null;
  readonly limitBytes: number;
};

export type CommandOutputChunk = JsonObject & {
  readonly stream: "stdout" | "stderr";
  readonly data: string;
};

/** A bounded, cursor-addressed output page suitable for polling or remote RPC. */
export type ReadCommandOutputResult = JsonObject & {
  readonly chunks: readonly CommandOutputChunk[];
  readonly nextCursor: OutputCursor | null;
  readonly complete: boolean;
  readonly truncated: boolean;
};

/** Binary file values use base64; Buffer and Uint8Array never cross the boundary. */
export type FileContent =
  | (JsonObject & {
    readonly encoding: "utf8";
    readonly data: string;
  })
  | (JsonObject & {
    readonly encoding: "base64";
    readonly data: string;
  });

export type ReadFileRequest = RequestMetadata & SandboxReference & {
  readonly path: string;
  readonly offset: number;
  readonly limitBytes: number;
  readonly encoding: "utf8" | "base64";
};

export type ReadFileResult = JsonObject & {
  readonly path: string;
  readonly content: FileContent;
  readonly bytesRead: number;
  readonly nextOffset: number;
  readonly endOfFile: boolean;
};

export type WriteFileRequest = MutationMetadata & SandboxReference & {
  readonly path: string;
  readonly content: FileContent;
  readonly mode: number | null;
};

export type WriteFileResult = JsonObject & {
  readonly path: string;
  readonly bytesWritten: number;
};

export type MakeDirectoryRequest = MutationMetadata & SandboxReference & {
  readonly path: string;
  readonly recursive: boolean;
  readonly mode: number | null;
};

export type MakeDirectoryResult = JsonObject & {
  readonly path: string;
  readonly created: boolean;
};

export type GetEndpointRequest = RequestMetadata & SandboxReference & {
  readonly port: number;
};

export type EndpointRecord = JsonObject & {
  readonly endpointId: EndpointId;
  readonly sandboxId: SandboxId;
  readonly port: number;
  readonly protocol: "http" | "https";
  readonly url: string;
  readonly visibility: "loopback" | "private" | "public";
  readonly backend: BackendReference;
};

export type GetEndpointResult = JsonObject & {
  readonly endpoint: EndpointRecord;
};

export type ErrorCategory =
  | "invalid-request"
  | "unsupported-requirement"
  | "already-exists"
  | "not-found"
  | "failed-precondition"
  | "deadline-exceeded"
  | "cancelled"
  | "backend-unavailable"
  | "backend-failure"
  | "source-failure"
  | "image-failure"
  | "internal";

export type InvalidRequestDetails = JsonObject & {
  readonly type: "invalid-request";
  readonly field: string | null;
  readonly reason: string;
};

export type UnsupportedRequirementDetails = JsonObject & {
  readonly type: "unsupported-requirements";
  readonly requirements: readonly UnsupportedSandboxRequirement[];
};

export type ResourceErrorDetails = JsonObject & {
  readonly type: "resource";
  readonly resource: "sandbox" | "process" | "endpoint";
  readonly resourceId: string;
};

export type BackendErrorDetails = JsonObject & {
  readonly type: "backend";
  readonly operation: string;
};

export type SourceErrorDetails = JsonObject & {
  readonly type: "source";
  readonly sourceType: "git" | "tarball";
};

export type NoErrorDetails = JsonObject & {
  readonly type: "none";
};

export type SandboxErrorDetails =
  | InvalidRequestDetails
  | UnsupportedRequirementDetails
  | ResourceErrorDetails
  | BackendErrorDetails
  | SourceErrorDetails
  | NoErrorDetails;

/** Stable failure data. Implementations must not return Error instances or causes. */
export type SandboxError = JsonObject & {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId: RequestId;
  readonly backend: BackendReference | null;
  readonly details: SandboxErrorDetails;
};

export type ClientSuccess<T extends JsonObject> = JsonObject & {
  readonly ok: true;
  readonly value: T;
};

export type ClientFailure = JsonObject & {
  readonly ok: false;
  readonly error: SandboxError;
};

export type ClientResult<T extends JsonObject> = ClientSuccess<T> | ClientFailure;

/**
 * Transport-neutral asynchronous client. A transport may fail before producing
 * a response, but every completed Localbox operation is represented by
 * ClientResult rather than by an Error instance.
 */
export interface SandboxClient {
  createSandbox(request: CreateSandboxRequest): Promise<ClientResult<CreateSandboxResult>>;
  getSandbox(request: GetSandboxRequest): Promise<ClientResult<GetSandboxResult>>;
  listSandboxes(request: ListSandboxesRequest): Promise<ClientResult<ListSandboxesResult>>;
  stopSandbox(request: StopSandboxRequest): Promise<ClientResult<StopSandboxResult>>;
  deleteSandbox(request: DeleteSandboxRequest): Promise<ClientResult<DeleteSandboxResult>>;
  extendSandboxDeadline(
    request: ExtendSandboxDeadlineRequest,
  ): Promise<ClientResult<ExtendSandboxDeadlineResult>>;

  startCommand(request: StartCommandRequest): Promise<ClientResult<StartCommandResult>>;
  waitForCommand(request: WaitForCommandRequest): Promise<ClientResult<WaitForCommandResult>>;
  signalProcess(request: SignalProcessRequest): Promise<ClientResult<SignalProcessResult>>;
  readCommandOutput(
    request: ReadCommandOutputRequest,
  ): Promise<ClientResult<ReadCommandOutputResult>>;

  readFile(request: ReadFileRequest): Promise<ClientResult<ReadFileResult>>;
  writeFile(request: WriteFileRequest): Promise<ClientResult<WriteFileResult>>;
  makeDirectory(request: MakeDirectoryRequest): Promise<ClientResult<MakeDirectoryResult>>;

  getEndpoint(request: GetEndpointRequest): Promise<ClientResult<GetEndpointResult>>;
}

/**
 * In-process execution port. Implementations own sandbox state and advertise
 * the semantics they can satisfy before creation.
 */
export interface SandboxBackend extends SandboxClient {
  readonly reference: BackendReference;
  readonly capabilities: readonly SandboxCapability[];
}

export { EmbeddedSandboxClient } from "./embedded.js";
