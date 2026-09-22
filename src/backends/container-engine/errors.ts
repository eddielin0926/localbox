import type { SourceErrorStage } from "../../runtime/index.js";

const SOURCE_DIAGNOSTIC_LIMIT = 2_048;

function sourceDiagnostic(cause: unknown, redactions: readonly string[]): string | null {
  const message = cause instanceof Error
    ? cause.message
    : typeof cause === "string"
    ? cause
    : null;
  if (message === null) return null;

  let diagnostic = message;
  for (const value of redactions) {
    if (value.length === 0) continue;
    diagnostic = diagnostic.replaceAll(value, "[redacted]");
    const encoded = encodeURIComponent(value);
    if (encoded !== value) diagnostic = diagnostic.replaceAll(encoded, "[redacted]");
  }
  diagnostic = diagnostic
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1[redacted]@")
    .replace(/([?&](?:access_token|auth|key|password|secret|token)=)[^&#\s]*/giu, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (diagnostic.length === 0) return null;
  if (diagnostic.length <= SOURCE_DIAGNOSTIC_LIMIT) return diagnostic;
  return `${diagnostic.slice(0, SOURCE_DIAGNOSTIC_LIMIT - 1)}…`;
}

export class DockerBackendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class DockerUnavailableError extends DockerBackendError {
  constructor(cause?: unknown) {
    super("Cannot connect to the configured container engine. Start it and retry.", { cause });
  }
}

export class SandboxAlreadyExistsError extends DockerBackendError {
  readonly sandboxName: string;

  constructor(name: string, cause?: unknown) {
    super(`A sandbox named "${name}" already exists.`, { cause });
    this.sandboxName = name;
  }
}

export class SandboxNotFoundError extends DockerBackendError {
  readonly sandboxName: string;

  constructor(name: string, cause?: unknown) {
    super(`Sandbox "${name}" was not found.`, { cause });
    this.sandboxName = name;
  }
}

export class SandboxDeletedError extends DockerBackendError {
  readonly sandboxName: string;

  constructor(name: string) {
    super(`Sandbox "${name}" has been deleted.`);
    this.sandboxName = name;
  }
}

export class UnsupportedImageError extends DockerBackendError {
  readonly image: string;

  constructor(image: string, cause?: unknown) {
    super(`Image "${image}" cannot run Localbox sandboxes. Use an image with node, /bin/sh, git, and tar.`, { cause });
    this.image = image;
  }
}

export class PortNotExposedError extends DockerBackendError {
  readonly sandboxName: string;
  readonly port: number;

  constructor(name: string, port: number) {
    super(`Port ${port} is not exposed for sandbox "${name}". Include it in create({ ports }) and retry.`);
    this.sandboxName = name;
    this.port = port;
  }
}

export class InvalidSandboxOptionsError extends DockerBackendError {}

export class UnsupportedSandboxCapabilityError extends DockerBackendError {
  readonly capability: string;

  constructor(capability: string) {
    super(`The container-engine backend does not support ${capability}. Remove that requirement or use a capable backend.`);
    this.capability = capability;
  }
}

export interface SandboxSourceErrorOptions {
  readonly exitCode?: number;
  readonly redactions?: readonly string[];
}

export class SandboxSourceError extends DockerBackendError {
  readonly sourceType: "git" | "tarball";
  readonly stage: SourceErrorStage;
  readonly exitCode: number | null;
  readonly diagnostic: string | null;

  constructor(
    sourceType: "git" | "tarball",
    stage: SourceErrorStage,
    cause?: unknown,
    options: SandboxSourceErrorOptions = {},
  ) {
    const exitCode = options.exitCode ?? null;
    const diagnostic = sourceDiagnostic(cause, options.redactions ?? []);
    const exit = exitCode === null ? "" : ` (exit code ${exitCode})`;
    const detail = diagnostic === null ? "." : `: ${diagnostic}`;
    super(`Could not materialize the ${sourceType} sandbox source during ${stage}${exit}${detail}`, { cause });
    this.sourceType = sourceType;
    this.stage = stage;
    this.exitCode = exitCode;
    this.diagnostic = diagnostic;
  }
}

export class ImagePullError extends DockerBackendError {
  readonly image: string;

  constructor(image: string, cause?: unknown) {
    super(`Could not pull image "${image}". Check the image name, registry access, and container-engine credentials.`, { cause });
    this.image = image;
  }
}
