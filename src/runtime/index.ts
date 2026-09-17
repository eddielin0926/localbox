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

export type CapabilitySupport = "native" | "emulated" | "partial" | "unsupported";

export type CapabilityDescriptor<Constraints extends JsonValue> = JsonObject & {
  readonly support: CapabilitySupport;
  readonly constraints: Constraints;
  /** Actionable backend-specific behavior and limitations. */
  readonly diagnostic: string;
};

export type SandboxOperationalCapability =
  | "command.start"
  | "command.detached"
  | "endpoint.expose"
  | "filesystem.mkdir"
  | "filesystem.read"
  | "filesystem.write"
  | "source.git"
  | "source.tarball"
  | "raw-command.input"
  | "raw-command.managed-filesystem-owner";

export type EndpointCapabilityConstraints = JsonObject & {
  readonly protocols: readonly ("http" | "https")[];
  readonly visibilities: readonly EndpointVisibility[];
};

export type SandboxOperationalCapabilities = JsonObject & {
  readonly "command.start": CapabilityDescriptor<null>;
  readonly "command.detached": CapabilityDescriptor<null>;
  readonly "endpoint.expose": CapabilityDescriptor<EndpointCapabilityConstraints>;
  readonly "filesystem.mkdir": CapabilityDescriptor<null>;
  readonly "filesystem.read": CapabilityDescriptor<null>;
  readonly "filesystem.write": CapabilityDescriptor<null>;
  readonly "source.git": CapabilityDescriptor<null>;
  readonly "source.tarball": CapabilityDescriptor<null>;
  readonly "raw-command.input": CapabilityDescriptor<JsonObject & {
    readonly maxBytes: number;
  }>;
  readonly "raw-command.managed-filesystem-owner": CapabilityDescriptor<JsonObject & {
    readonly managedImagesOnly: boolean;
  }>;
};

export type IsolationLevel =
  | "process"
  | "shared-kernel-container"
  | "namespace-sandbox"
  | "virtual-machine";
export type IsolationTenancy = "trusted" | "single-tenant" | "multi-tenant";
export type ArtifactKind =
  | "runtime"
  | "oci-image"
  | "git"
  | "tarball"
  | "directory"
  | "disk-image"
  | "snapshot";
export type PersistenceScope = "sandbox-lifecycle" | "backend-restart";
export type RecoveryScope = "sandbox" | "process";
export type NetworkMode = "allow-all" | "deny-all" | "custom";
export type EndpointVisibility = "loopback" | "private" | "public";
export type ResourceEnforcement = "hard" | "best-effort";
export type TerminalMode = "exec" | "pty";
export type SnapshotOperation = "create" | "restore" | "clone";

export type SandboxCapabilities = JsonObject & {
  readonly schemaVersion: 1;
  readonly operations: SandboxOperationalCapabilities;
  readonly isolation: CapabilityDescriptor<JsonObject & {
    readonly level: IsolationLevel;
    readonly tenancies: readonly IsolationTenancy[];
  }>;
  readonly artifacts: CapabilityDescriptor<JsonObject & {
    readonly kinds: readonly ArtifactKind[];
  }>;
  readonly persistence: CapabilityDescriptor<JsonObject & {
    readonly scopes: readonly PersistenceScope[];
  }>;
  readonly recovery: CapabilityDescriptor<JsonObject & {
    readonly scopes: readonly RecoveryScope[];
  }>;
  readonly networking: CapabilityDescriptor<JsonObject & {
    readonly modes: readonly NetworkMode[];
    readonly portExposure: readonly EndpointVisibility[];
    readonly customPolicies: boolean;
  }>;
  readonly resources: CapabilityDescriptor<JsonObject & {
    readonly cpu: JsonObject & {
      readonly minimumVcpus: number;
      readonly maximumVcpus: number | null;
      readonly stepVcpus: number;
    };
    readonly memory: JsonObject & {
      readonly minimumBytes: number;
      readonly maximumBytes: number | null;
      readonly stepBytes: number;
    };
    readonly memoryBytesPerVcpu: number | null;
    readonly enforcement: ResourceEnforcement;
  }>;
  readonly terminals: CapabilityDescriptor<JsonObject & {
    readonly modes: readonly TerminalMode[];
  }>;
  readonly snapshots: CapabilityDescriptor<JsonObject & {
    readonly operations: readonly SnapshotOperation[];
  }>;
};

type RequirementSupport = JsonObject & {
  readonly acceptableSupport: readonly Exclude<CapabilitySupport, "unsupported">[];
};

export type OperationalSandboxRequirement = RequirementSupport & {
  readonly type: "operation";
  readonly operation: SandboxOperationalCapability;
};
export type IsolationSandboxRequirement = RequirementSupport & {
  readonly type: "isolation";
  readonly minimumLevel: IsolationLevel;
  readonly tenancy: IsolationTenancy;
};
export type ArtifactSandboxRequirement = RequirementSupport & {
  readonly type: "artifacts";
  readonly kinds: readonly ArtifactKind[];
};
export type PersistenceSandboxRequirement = RequirementSupport & {
  readonly type: "persistence";
  readonly scope: PersistenceScope;
};
export type RecoverySandboxRequirement = RequirementSupport & {
  readonly type: "recovery";
  readonly scope: RecoveryScope;
};
export type NetworkingSandboxRequirement = RequirementSupport & {
  readonly type: "networking";
  readonly mode: NetworkMode;
  readonly portExposure: EndpointVisibility | null;
  readonly customPolicy: boolean;
};
export type ResourceSandboxRequirement = RequirementSupport & {
  readonly type: "resources";
  readonly vcpus: number | null;
  readonly memoryBytes: number | null;
  readonly enforcement: ResourceEnforcement;
};
export type TerminalSandboxRequirement = RequirementSupport & {
  readonly type: "terminals";
  readonly mode: TerminalMode;
};
export type SnapshotSandboxRequirement = RequirementSupport & {
  readonly type: "snapshots";
  readonly operation: SnapshotOperation;
};

/** A transport-safe semantic guarantee that must be negotiated before creation. */
export type SandboxRequirement =
  | OperationalSandboxRequirement
  | IsolationSandboxRequirement
  | ArtifactSandboxRequirement
  | PersistenceSandboxRequirement
  | RecoverySandboxRequirement
  | NetworkingSandboxRequirement
  | ResourceSandboxRequirement
  | TerminalSandboxRequirement
  | SnapshotSandboxRequirement;

export type SandboxRequirementIssue = JsonObject & {
  readonly index: number | null;
  readonly kind:
    | "malformed"
    | "unknown"
    | "duplicate"
    | "conflict"
    | "unsupported"
    | "constraint"
    | "invalid-backend-capabilities";
  readonly requirement: SandboxRequirement | null;
  readonly reason: string;
  readonly backendDiagnostic: string | null;
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
  /** Provider runtime selector when one was used to resolve the concrete image. */
  readonly runtime: string | null;
  readonly backend: BackendReference;
  readonly createdAt: TimestampMilliseconds;
  readonly updatedAt: TimestampMilliseconds;
  readonly statusUpdatedAt: TimestampMilliseconds;
  readonly expiresAt: TimestampMilliseconds | null;
  readonly timeoutMs: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly ports: readonly number[];
  /** Currently resolved endpoints, used by synchronous compatibility frontends. */
  readonly endpoints: readonly EndpointRecord[];
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
  /** Internal execution identity; omitted for the sandbox's default user. */
  readonly user?: string;
};

/**
 * Output is retained by the runtime and retrieved through readCommandOutput;
 * callers never pass streams or callbacks across the client boundary. Process
 * identity is allocated by the runtime when the command starts.
 */
export type StartCommandRequest = MutationMetadata & SandboxReference & {
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
  /** Wait until output or completion when the cursor is currently caught up. */
  readonly follow: boolean;
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

/**
 * Plain-data events emitted by a backend raw command. The embedded runtime
 * consumes these immediately; they are never exposed through SandboxClient.
 */
export type RawCommandEvent =
  | (JsonObject & {
    readonly type: "stdout";
    readonly data: string;
  })
  | (JsonObject & {
    readonly type: "stderr";
    readonly data: string;
  })
  | (JsonObject & {
    readonly type: "complete";
    readonly exitCode: number;
    readonly finishedAt: TimestampMilliseconds;
  })
  | (JsonObject & {
    readonly type: "backend-failure";
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  });

/** In-process raw command primitive implemented by a concrete backend. */
export interface RawCommand {
  readonly startedAt: TimestampMilliseconds;
  readonly events: AsyncIterable<RawCommandEvent>;
  signal(signal: ProcessSignal, abortSignal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export type StartRawCommandRequest = RequestMetadata & SandboxReference & {
  readonly command: CommandSpec;
  /** Bounded binary-safe stdin supplied outside the command argument vector. */
  readonly input?: FileContent;
  /** Narrow internal privilege grant; never an arbitrary public root user. */
  readonly privilege?: "managed-filesystem-owner";
};

export type StartRawCommandResult =
  | { readonly ok: true; readonly command: RawCommand }
  | ClientFailure;

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

export type FilesystemOperation =
  | "appendFile"
  | "readdir"
  | "stat"
  | "lstat"
  | "unlink"
  | "rm"
  | "rmdir"
  | "rename"
  | "copyFile"
  | "access"
  | "chmod"
  | "chown"
  | "symlink"
  | "readlink"
  | "realpath"
  | "truncate"
  | "mkdtemp";

/**
 * Provider-neutral semantic filesystem operation. Operation arguments and
 * results remain plain JSON; binary append data uses FileContent.
 */
export type RunFilesystemOperationRequest = MutationMetadata & SandboxReference & {
  readonly operation: FilesystemOperation;
  readonly arguments: JsonObject;
  readonly content: FileContent | null;
};

export type RunFilesystemOperationResult = JsonObject & {
  readonly value: JsonValue;
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

export type RequirementNegotiationDetails = JsonObject & {
  readonly type: "requirement-negotiation";
  readonly issues: readonly SandboxRequirementIssue[];
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

export type FileErrorDetails = JsonObject & {
  readonly type: "file";
  readonly code: string | null;
  readonly syscall: string | null;
  readonly path: string | null;
};

export type NoErrorDetails = JsonObject & {
  readonly type: "none";
};

export type SandboxErrorDetails =
  | InvalidRequestDetails
  | RequirementNegotiationDetails
  | ResourceErrorDetails
  | BackendErrorDetails
  | SourceErrorDetails
  | FileErrorDetails
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
  runFilesystemOperation(
    request: RunFilesystemOperationRequest,
  ): Promise<ClientResult<RunFilesystemOperationResult>>;

  getEndpoint(request: GetEndpointRequest): Promise<ClientResult<GetEndpointResult>>;
}

/**
 * In-process execution port. SandboxClient command lifecycle operations are
 * deliberately absent: a backend only starts a raw command and emits
 * plain-data events. EmbeddedSandboxClient owns process identity and state.
 */
export type SandboxBackend = Pick<
  SandboxClient,
  | "createSandbox"
  | "getSandbox"
  | "listSandboxes"
  | "stopSandbox"
  | "deleteSandbox"
  | "extendSandboxDeadline"
  | "getEndpoint"
> & {
  readonly reference: BackendReference;
  readonly capabilities: SandboxCapabilities;
  startRawCommand(
    request: StartRawCommandRequest,
    signal?: AbortSignal,
  ): Promise<StartRawCommandResult>;
};

export { EmbeddedSandboxClient } from "./embedded.js";
export {
  negotiateSandboxRequirements,
  SANDBOX_OPERATIONAL_CAPABILITIES,
} from "./capabilities.js";
export {
  DockerBackend,
  MANAGED_IMAGES,
  MANAGED_IMAGE_REGISTRY,
  MANAGED_IMAGE_UPSTREAM_COMMIT,
} from "../default-client.js";
