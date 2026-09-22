import { isAbsolute, join } from "node:path";
import Dockerode from "dockerode";
import {
  ContainerEngineBackend,
  DOCKER_CAPABILITIES,
  type ContainerEngineDriver,
} from "../container-engine/index.js";
import { DockerUnavailableError, UnsupportedSandboxCapabilityError } from "../container-engine/errors.js";
import type {
  AvailabilityDiagnostic,
  BackendAvailability,
  BackendReference,
  ClientFailure,
  ClientResult,
  CreateSandboxRequest,
  ProbeAvailabilityRequest,
  ProbeAvailabilityResult,
  SandboxCapabilities,
} from "../../runtime/index.js";

export type PodmanMode = "rootless" | "rootful";

export interface PodmanBackendOptions {
  /** Selects the capability contract and must match the service reached by socketPath. */
  readonly mode?: PodmanMode;
  /** Absolute path to a Podman API Unix socket. */
  readonly socketPath?: string;
}

const ROOTLESS_REFERENCE = Object.freeze({
  backendId: "local-podman-rootless",
  backendType: "podman",
}) satisfies BackendReference;

const ROOTFUL_REFERENCE = Object.freeze({
  backendId: "local-podman-rootful",
  backendType: "podman",
}) satisfies BackendReference;

export const PODMAN_ROOTFUL_CAPABILITIES = Object.freeze({
  ...DOCKER_CAPABILITIES,
  operations: {
    ...DOCKER_CAPABILITIES.operations,
    "command.start": {
      support: "native",
      constraints: null,
      diagnostic: "Podman exec starts commands inside the selected container through its Docker-compatible API.",
    },
    "endpoint.expose": {
      support: "native",
      constraints: { protocols: ["http"], visibilities: ["loopback"] },
      diagnostic: "Podman publishes declared TCP ports as HTTP endpoints bound to 127.0.0.1.",
    },
    "raw-command.input": {
      support: "native",
      constraints: DOCKER_CAPABILITIES.operations["raw-command.input"].constraints,
      diagnostic: "Podman exec accepts the bounded stdin chunks used by the Localbox filesystem bridge.",
    },
  },
  isolation: {
    support: "partial",
    constraints: { level: "shared-kernel-container", tenancies: ["trusted", "single-tenant"] },
    diagnostic: "Rootful Podman containers share the host kernel and the service has host-root authority; use only trusted or single-tenant workloads, not hostile multi-tenancy.",
  },
  artifacts: {
    support: "partial",
    constraints: { kinds: ["oci-image"] },
    diagnostic: "Podman accepts validated OCI image artifacts; trust metadata describes provenance and does not strengthen container isolation.",
  },
  persistence: {
    support: "native",
    constraints: { scopes: ["sandbox-lifecycle", "backend-restart"] },
    diagnostic: "Persistent Podman containers retain their writable layer across stop/resume and Localbox process restart while Podman storage remains available.",
  },
  recovery: {
    support: "partial",
    constraints: { scopes: ["sandbox"] },
    diagnostic: "Sandbox containers can be rediscovered from Podman labels, but in-flight commands, output buffers, waiters, and idempotency records cannot be recovered.",
  },
  networking: {
    support: "partial",
    constraints: { modes: ["allow-all", "deny-all"], portExposure: ["loopback"], customPolicies: false },
    diagnostic: "Podman supports connected or network-none containers and loopback-only published ports; custom policies and non-loopback exposure are unsupported, and source setup precedes deny-all disconnection.",
  },
  resources: {
    support: "partial",
    constraints: DOCKER_CAPABILITIES.resources.constraints,
    diagnostic: "Rootful Podman hard-enforces integer CPU quotas and the Localbox fixed 2 GiB memory limit per vCPU through the service cgroup hierarchy.",
  },
  terminals: {
    support: "unsupported",
    constraints: { modes: [] },
    diagnostic: "The Podman backend exposes non-interactive exec only; interactive PTYs are unsupported.",
  },
  snapshots: {
    support: "unsupported",
    constraints: { operations: [] },
    diagnostic: "The Podman backend cannot create, restore, or clone Localbox snapshots; use an OCI image or source artifact instead.",
  },
} as const satisfies SandboxCapabilities);

export const PODMAN_ROOTLESS_CAPABILITIES = Object.freeze({
  ...PODMAN_ROOTFUL_CAPABILITIES,
  isolation: {
    support: "partial",
    constraints: { level: "shared-kernel-container", tenancies: ["trusted", "single-tenant"] },
    diagnostic: "Rootless Podman maps container root into the invoking user's namespace and avoids a host-root service, but containers still share the host kernel and are not a hostile multi-tenant boundary.",
  },
  resources: {
    support: "unsupported",
    constraints: {
      cpu: { minimumVcpus: 1, maximumVcpus: null, stepVcpus: 1 },
      memory: { minimumBytes: 1, maximumBytes: null, stepBytes: 1 },
      memoryBytesPerVcpu: null,
      enforcement: "best-effort",
    },
    diagnostic: "Localbox does not promise CPU or memory enforcement for rootless Podman because delegation depends on host cgroup and user-session configuration; resource requests fail before allocation.",
  },
} as const satisfies SandboxCapabilities);

interface PodmanServiceIdentity {
  readonly apiVersion: string | null;
  readonly mode: PodmanMode;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPodmanVersion(value: unknown): boolean {
  if (!isObject(value)) return false;
  const platform = isObject(value.Platform) ? value.Platform.Name : undefined;
  if (typeof platform === "string" && /podman/i.test(platform)) return true;
  if (typeof value.Version === "string" && /podman/i.test(value.Version)) return true;
  if (!Array.isArray(value.Components)) return false;
  return value.Components.some((component) =>
    isObject(component) && typeof component.Name === "string" && /podman/i.test(component.Name)
  );
}

function podmanModeFromInfo(value: unknown): PodmanMode {
  if (!isObject(value)) return "rootful";
  if (value.Rootless === true || value.rootless === true) return "rootless";
  const host = isObject(value.host) ? value.host : null;
  const security = host !== null && isObject(host.security) ? host.security : null;
  if (security?.rootless === true) return "rootless";
  const securityOptions = value.SecurityOptions;
  if (Array.isArray(securityOptions) && securityOptions.some((entry) =>
    typeof entry === "string" && /(^|[=,:])rootless($|[=,:])/i.test(entry)
  )) return "rootless";
  return "rootful";
}

async function inspectPodman(client: Dockerode): Promise<PodmanServiceIdentity | null> {
  const [version, info] = await Promise.all([client.version(), client.info()]);
  if (!isPodmanVersion(version)) return null;
  return {
    apiVersion: isObject(version) && typeof version.ApiVersion === "string"
      ? version.ApiVersion
      : null,
    mode: podmanModeFromInfo(info),
  };
}

async function withDeadline<T>(
  work: Promise<T>,
  request: ProbeAvailabilityRequest,
): Promise<T> {
  if (request.deadline === null) return work;
  const remaining = request.deadline.expiresAt - Date.now();
  if (remaining <= 0) throw new DOMException("The operation timed out", "AbortError");
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new DOMException("The operation timed out", "AbortError"));
  }, remaining);
  timer.unref();
  try {
    return await Promise.race([work, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function availability(
  reference: BackendReference,
  status: BackendAvailability["status"],
  diagnostic: AvailabilityDiagnostic,
): ClientResult<ProbeAvailabilityResult> {
  return {
    ok: true,
    value: {
      availability: {
        schemaVersion: 1,
        backend: reference,
        status,
        checkedAt: Date.now(),
        diagnostics: [diagnostic],
      },
    },
  };
}

function deadlineFailure(reference: BackendReference, requestId: string): ClientFailure {
  return {
    ok: false,
    error: {
      category: "deadline-exceeded",
      code: "LOCALBOX_DEADLINE_EXCEEDED",
      message: "The probeAvailability operation exceeded its deadline.",
      retryable: true,
      requestId,
      backend: reference,
      details: { type: "backend", operation: "probeAvailability" },
    },
  };
}

async function probePodmanAvailability(
  client: Dockerode,
  reference: BackendReference,
  expectedMode: PodmanMode,
  request: ProbeAvailabilityRequest,
): Promise<ClientResult<ProbeAvailabilityResult>> {
  try {
    const identity = await withDeadline(inspectPodman(client), request);
    if (identity === null) {
      return availability(reference, "unavailable", {
        code: "PODMAN_ENGINE_MISMATCH",
        severity: "error",
        message: "The configured endpoint is not a Podman service.",
        action: "Configure socketPath with the Podman API socket for the selected mode.",
        details: { type: "podman-service", reason: "engine-mismatch", apiVersion: null, mode: null },
      });
    }
    if (identity.mode !== expectedMode) {
      return availability(reference, "unavailable", {
        code: "PODMAN_MODE_MISMATCH",
        severity: "error",
        message: `The Podman service is ${identity.mode}, but this backend advertises ${expectedMode} capabilities.`,
        action: `Construct PodmanBackend with mode "${identity.mode}" or select the matching Podman socket.`,
        details: { type: "podman-service", reason: "mode-mismatch", apiVersion: identity.apiVersion, mode: identity.mode },
      });
    }
    return availability(reference, "available", {
      code: "PODMAN_SERVICE_AVAILABLE",
      severity: "info",
      message: `The ${identity.mode} Podman service answered the version and information APIs.`,
      action: "No action is required.",
      details: { type: "podman-service", reason: "available", apiVersion: identity.apiVersion, mode: identity.mode },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return deadlineFailure(reference, request.requestId);
    }
    const code = (error as NodeJS.ErrnoException).code;
    const diagnostic: AvailabilityDiagnostic = code === "ENOENT"
      ? {
        code: "PODMAN_SOCKET_NOT_FOUND",
        severity: "error",
        message: "The configured Podman API socket does not exist.",
        action: "Start podman system service for the selected mode or configure its absolute socket path.",
        details: { type: "podman-service", reason: "not-found", apiVersion: null, mode: null },
      }
      : code === "EACCES" || code === "EPERM"
      ? {
        code: "PODMAN_SOCKET_PERMISSION_DENIED",
        severity: "error",
        message: "The Podman API socket exists but the current user cannot access it.",
        action: "Use the current user's rootless socket or grant access to the selected rootful socket.",
        details: { type: "podman-service", reason: "permission-denied", apiVersion: null, mode: null },
      }
      : {
        code: "PODMAN_SERVICE_UNREACHABLE",
        severity: "error",
        message: "The Podman service did not answer the version and information APIs.",
        action: "Start podman system service and verify the configured socket path.",
        details: { type: "podman-service", reason: "unreachable", apiVersion: null, mode: null },
      };
    return availability(reference, "unavailable", diagnostic);
  }
}

function defaultSocketPath(mode: PodmanMode): string {
  if (mode === "rootful") return "/run/podman/podman.sock";
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  if (runtimeDirectory !== undefined && isAbsolute(runtimeDirectory)) {
    return join(runtimeDirectory, "podman", "podman.sock");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) {
    throw new TypeError("Rootless Podman requires an explicit absolute socketPath on this platform.");
  }
  return `/run/user/${uid}/podman/podman.sock`;
}

export class PodmanBackend extends ContainerEngineBackend {
  readonly mode: PodmanMode;
  readonly socketPath: string;

  constructor(options: PodmanBackendOptions = {}) {
    const mode = options.mode ?? "rootless";
    if (mode !== "rootless" && mode !== "rootful") {
      throw new TypeError("Podman mode must be rootless or rootful.");
    }
    const socketPath = options.socketPath ?? defaultSocketPath(mode);
    if (!isAbsolute(socketPath)) {
      throw new TypeError("Podman socketPath must be absolute.");
    }
    const reference = mode === "rootless" ? ROOTLESS_REFERENCE : ROOTFUL_REFERENCE;
    const capabilities = mode === "rootless"
      ? PODMAN_ROOTLESS_CAPABILITIES
      : PODMAN_ROOTFUL_CAPABILITIES;
    const client = new Dockerode({ socketPath });
    let verification: Promise<void> | undefined;
    const driver: ContainerEngineDriver = {
      name: "Podman",
      reference,
      capabilities,
      client,
      unavailableCode: "LOCALBOX_PODMAN_UNAVAILABLE",
      unavailableMessage: "Cannot connect to Podman. Start the matching API service and retry.",
      failureCode: "LOCALBOX_PODMAN_FAILURE",
      probeAvailability: (request) =>
        probePodmanAvailability(client, reference, mode, request),
      async beforeOperation(signal) {
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        verification ??= inspectPodman(client).then((identity) => {
          if (identity === null || identity.mode !== mode) {
            throw new DockerUnavailableError();
          }
        });
        try {
          await verification;
        } catch (error) {
          verification = undefined;
          throw error;
        }
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
      },
      async beforeCreate(request: CreateSandboxRequest) {
        if (mode === "rootless" &&
            (request.spec.resources.vcpus !== null || request.spec.resources.memoryBytes !== null)) {
          throw new UnsupportedSandboxCapabilityError(
            "resource guarantees with rootless Podman",
          );
        }
      },
    };
    super(driver);
    this.mode = mode;
    this.socketPath = socketPath;
  }
}
