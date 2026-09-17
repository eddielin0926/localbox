import type {
  ArtifactDigest,
  ArtifactPlatform,
  BackendReference,
  BootArtifact,
  SandboxFrontendMetadata,
} from "./index.js";

export type BootArtifactValidationResult =
  | { readonly ok: true; readonly artifact: BootArtifact }
  | { readonly ok: false; readonly field: string; readonly reason: string };

const SHA256 = /^[a-f0-9]{64}$/;
const SHA512 = /^[a-f0-9]{128}$/;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function absolutePath(value: unknown): value is string {
  return nonEmptyText(value) && (value.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(value));
}

function backendReference(value: unknown): value is BackendReference {
  return isPlainObject(value) && hasOnlyKeys(value, ["backendId", "backendType"]) &&
    nonEmptyText(value.backendId) && nonEmptyText(value.backendType);
}

function digest(value: unknown): value is ArtifactDigest {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["algorithm", "value"])) return false;
  if (value.algorithm === "sha256") return typeof value.value === "string" && SHA256.test(value.value);
  if (value.algorithm === "sha512") return typeof value.value === "string" && SHA512.test(value.value);
  return false;
}

function platform(value: unknown): value is ArtifactPlatform {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["os", "architecture", "variant"])) return false;
  return (value.os === "linux" || value.os === "windows") &&
    (value.architecture === "amd64" || value.architecture === "arm64") &&
    (value.variant === null || nonEmptyText(value.variant));
}

function failure(field: string, reason: string): BootArtifactValidationResult {
  return { ok: false, field, reason };
}

/** Strictly validates a transport value without normalizing or inferring trust. */
export function validateBootArtifact(value: unknown): BootArtifactValidationResult {
  if (!isPlainObject(value)) return failure("bootArtifact", "Boot artifact must be a plain JSON object.");
  if (typeof value.kind !== "string") return failure("bootArtifact.kind", "Boot artifact kind is required.");
  if (value.trust !== "trusted" && value.trust !== "untrusted") {
    return failure("bootArtifact.trust", "Boot artifact trust must be declared as trusted or untrusted.");
  }

  switch (value.kind) {
    case "host": {
      if (!hasOnlyKeys(value, ["kind", "locator", "trust", "mutability"])) {
        return failure("bootArtifact", "Host artifacts contain unknown or missing fields.");
      }
      if (!isPlainObject(value.locator) ||
          !hasOnlyKeys(value.locator, ["type", "selector"]) ||
          value.locator.type !== "host" || value.locator.selector !== "current") {
        return failure("bootArtifact.locator", "Host locator must select the current host runtime.");
      }
      if (value.trust !== "trusted") {
        return failure("bootArtifact.trust", "Direct host execution requires an explicit trusted declaration.");
      }
      if (value.mutability !== "mutable") {
        return failure("bootArtifact.mutability", "The current host runtime must be declared mutable.");
      }
      return { ok: true, artifact: value as BootArtifact };
    }
    case "directory": {
      if (!hasOnlyKeys(value, ["kind", "locator", "trust", "mutability"])) {
        return failure("bootArtifact", "Directory artifacts contain unknown or missing fields.");
      }
      if (!isPlainObject(value.locator) ||
          !hasOnlyKeys(value.locator, ["type", "path"]) ||
          value.locator.type !== "absolute-path" || !absolutePath(value.locator.path)) {
        return failure("bootArtifact.locator", "Directory locator must contain an absolute path without NUL bytes.");
      }
      if (value.mutability !== "mutable" && value.mutability !== "read-only") {
        return failure("bootArtifact.mutability", "Directory mutability must be mutable or read-only.");
      }
      return { ok: true, artifact: value as BootArtifact };
    }
    case "oci-image": {
      if (!hasOnlyKeys(value, ["kind", "locator", "trust", "mutability", "digest", "platform"])) {
        return failure("bootArtifact", "OCI image artifacts contain unknown or missing fields.");
      }
      if (!isPlainObject(value.locator) ||
          !hasOnlyKeys(value.locator, ["type", "reference"]) ||
          value.locator.type !== "oci-reference" || !nonEmptyText(value.locator.reference) ||
          /\s/.test(value.locator.reference as string)) {
        return failure("bootArtifact.locator", "OCI image locator must contain a non-empty reference without whitespace or NUL bytes.");
      }
      if (value.digest !== null && !digest(value.digest)) {
        return failure("bootArtifact.digest", "OCI image digest must be a lowercase sha256 or sha512 digest.");
      }
      if (value.platform !== null && !platform(value.platform)) {
        return failure("bootArtifact.platform", "OCI image platform must use a supported OS and architecture with an explicit nullable variant.");
      }
      if (value.mutability !== "mutable" && value.mutability !== "immutable") {
        return failure("bootArtifact.mutability", "OCI image mutability must be mutable or immutable.");
      }
      if (value.mutability === "immutable" && value.digest === null) {
        return failure("bootArtifact.digest", "An immutable OCI image requires an explicit digest.");
      }
      return { ok: true, artifact: value as BootArtifact };
    }
    case "disk-image": {
      if (!hasOnlyKeys(value, ["kind", "locator", "trust", "mutability", "digest", "format", "architecture"])) {
        return failure("bootArtifact", "Disk image artifacts contain unknown or missing fields.");
      }
      if (!isPlainObject(value.locator) ||
          !hasOnlyKeys(value.locator, ["type", "path"]) ||
          value.locator.type !== "absolute-path" || !absolutePath(value.locator.path)) {
        return failure("bootArtifact.locator", "Disk image locator must contain an absolute path without NUL bytes.");
      }
      if (value.digest !== null && !digest(value.digest)) {
        return failure("bootArtifact.digest", "Disk image digest must be a lowercase sha256 or sha512 digest.");
      }
      if (value.format !== "raw" && value.format !== "qcow2") {
        return failure("bootArtifact.format", "Disk image format must be raw or qcow2.");
      }
      if (value.architecture !== null && value.architecture !== "amd64" && value.architecture !== "arm64") {
        return failure("bootArtifact.architecture", "Disk image architecture must be amd64, arm64, or null.");
      }
      if (value.mutability !== "mutable" && value.mutability !== "read-only") {
        return failure("bootArtifact.mutability", "Disk image mutability must be mutable or read-only.");
      }
      return { ok: true, artifact: value as BootArtifact };
    }
    case "snapshot": {
      if (!hasOnlyKeys(value, ["kind", "locator", "trust", "mutability", "digest"])) {
        return failure("bootArtifact", "Snapshot artifacts contain unknown or missing fields.");
      }
      if (!isPlainObject(value.locator) ||
          !hasOnlyKeys(value.locator, ["type", "snapshotId", "scope", "backend"]) ||
          value.locator.type !== "snapshot-id" || !nonEmptyText(value.locator.snapshotId) ||
          (value.locator.scope !== "backend" && value.locator.scope !== "portable") ||
          !(value.locator.backend === null || backendReference(value.locator.backend))) {
        return failure("bootArtifact.locator", "Snapshot locator must declare an ID, scope, and nullable backend identity.");
      }
      if ((value.locator.scope === "backend") !== (value.locator.backend !== null)) {
        return failure("bootArtifact.locator.backend", "Backend-scoped snapshots require a backend identity; portable snapshots must not carry one.");
      }
      if (value.digest !== null && !digest(value.digest)) {
        return failure("bootArtifact.digest", "Snapshot digest must be a lowercase sha256 or sha512 digest.");
      }
      if (value.mutability !== "mutable" && value.mutability !== "immutable") {
        return failure("bootArtifact.mutability", "Snapshot mutability must be mutable or immutable.");
      }
      if (value.mutability === "immutable" && value.digest === null) {
        return failure("bootArtifact.digest", "An immutable snapshot requires an explicit digest.");
      }
      return { ok: true, artifact: value as BootArtifact };
    }
    default:
      return failure("bootArtifact.kind", `Unknown boot artifact kind ${JSON.stringify(value.kind)}.`);
  }
}

export type SandboxFrontendMetadataValidationResult =
  | { readonly ok: true; readonly metadata: SandboxFrontendMetadata | null }
  | { readonly ok: false; readonly field: string; readonly reason: string };

/** Validates provider display metadata without allowing it to select execution. */
export function validateSandboxFrontendMetadata(
  value: unknown,
  artifact: BootArtifact,
): SandboxFrontendMetadataValidationResult {
  if (value === null) return { ok: true, metadata: null };
  if (!isPlainObject(value) ||
      !hasOnlyKeys(value, ["type", "image", "runtime"]) ||
      value.type !== "vercel" ||
      !nonEmptyText(value.image) ||
      !(value.runtime === null || nonEmptyText(value.runtime))) {
    return {
      ok: false,
      field: "frontendMetadata",
      reason: "Vercel frontend metadata must contain a non-empty image and nullable non-empty runtime.",
    };
  }
  if (artifact.kind !== "oci-image" || value.image !== artifact.locator.reference) {
    return {
      ok: false,
      field: "frontendMetadata.image",
      reason: "Vercel frontend metadata must describe the concrete OCI boot artifact.",
    };
  }
  return { ok: true, metadata: value as SandboxFrontendMetadata };
}
