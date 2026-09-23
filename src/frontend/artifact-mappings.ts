import {
  negotiateSandboxRequirements,
  validateBootArtifact,
  type ArtifactDigest,
  type BackendReference,
  type BootArtifact,
  type OciImageBootArtifact,
  type SandboxCapabilities,
  type SnapshotBootArtifact,
} from "../runtime/index.js";
import { MANAGED_IMAGES } from "./vercel-managed-images.js";

export const FRONTEND_ARTIFACT_MAPPING_SCHEMA_VERSION = 1 as const;

export const FRONTEND_ARTIFACT_CONTRACTS = Object.freeze({
  vercel: Object.freeze({
    id: "vercel@3.3.0",
    provider: "vercel",
    package: "@vercel/sandbox",
    version: "3.3.0",
  }),
  cloudflareStable: Object.freeze({
    id: "cloudflare@0.12.9",
    provider: "cloudflare",
    package: "@cloudflare/sandbox",
    version: "0.12.9",
  }),
  cloudflareNext: Object.freeze({
    id: "cloudflare@0.13.0-next.769.1",
    provider: "cloudflare",
    package: "@cloudflare/sandbox",
    version: "0.13.0-next.769.1",
  }),
  e2b: Object.freeze({
    id: "e2b@2.8.0",
    provider: "e2b",
    package: "e2b",
    version: "2.8.0",
  }),
  daytona: Object.freeze({
    id: "daytona@0.216.0",
    provider: "daytona",
    package: "@daytona/sdk",
    version: "0.216.0",
  }),
} as const);

export type FrontendArtifactContract =
  (typeof FRONTEND_ARTIFACT_CONTRACTS)[keyof typeof FRONTEND_ARTIFACT_CONTRACTS]["id"];

export const CLOUDFLARE_STABLE_IMAGE_ALIASES = Object.freeze({
  default: "docker.io/cloudflare/sandbox:0.12.9",
  python: "docker.io/cloudflare/sandbox:0.12.9-python",
  opencode: "docker.io/cloudflare/sandbox:0.12.9-opencode",
  musl: "docker.io/cloudflare/sandbox:0.12.9-musl",
} as const);

export const CLOUDFLARE_NEXT_IMAGE_ALIASES = Object.freeze({
  default: "docker.io/cloudflare/sandbox:0.13.0-next.769.1",
  python: "docker.io/cloudflare/sandbox:0.13.0-next.769.1-python",
  opencode: "docker.io/cloudflare/sandbox:0.13.0-next.769.1-opencode",
  musl: "docker.io/cloudflare/sandbox:0.13.0-next.769.1-musl",
} as const);

export interface VercelArtifactSelection {
  readonly contract: "vercel@3.3.0";
  readonly runtime?: string;
  readonly image?: string;
  readonly requiresAuthentication?: boolean;
}

export interface CloudflareStableArtifactSelection {
  readonly contract: "cloudflare@0.12.9";
  readonly image?: string;
  readonly dockerfile?: string;
  readonly requiresAuthentication?: boolean;
}

export interface CloudflareNextArtifactSelection {
  readonly contract: "cloudflare@0.13.0-next.769.1";
  readonly image?: string;
  readonly dockerfile?: string;
  readonly requiresAuthentication?: boolean;
}

export interface E2BArtifactSelection {
  readonly contract: "e2b@2.8.0";
  readonly template?: string;
  readonly templateBuild?: boolean;
}

export interface DaytonaArtifactSelection {
  readonly contract: "daytona@0.216.0";
  readonly image?: string;
  readonly snapshot?: string;
  readonly imageBuild?: boolean;
  readonly language?: string;
  readonly requiresAuthentication?: boolean;
}

export type FrontendArtifactSelection =
  | VercelArtifactSelection
  | CloudflareStableArtifactSelection
  | CloudflareNextArtifactSelection
  | E2BArtifactSelection
  | DaytonaArtifactSelection;

export interface FrontendArtifactMappingOptions {
  /** E2B template IDs or names explicitly installed as local OCI artifacts. */
  readonly e2bTemplates?: Readonly<Record<string, OciImageBootArtifact>>;
  /** Daytona snapshot IDs or names actually present in the selected local backend. */
  readonly daytonaSnapshots?: Readonly<Record<string, SnapshotBootArtifact>>;
  /** Required to prove that a configured Daytona snapshot can be restored. */
  readonly backend?: Readonly<{
    readonly reference: BackendReference;
    readonly capabilities: SandboxCapabilities;
  }>;
  /** Registry hosts known to require credentials that cannot cross SandboxClient. */
  readonly privateRegistryHosts?: readonly string[];
}

export type FrontendArtifactMappingProvenance = "managed" | "caller" | "configured-local";

export interface FrontendArtifactMappingIdentity {
  readonly schemaVersion: typeof FRONTEND_ARTIFACT_MAPPING_SCHEMA_VERSION;
  readonly contract: FrontendArtifactContract;
  readonly provider: "vercel" | "cloudflare" | "e2b" | "daytona";
  readonly upstream: Readonly<{
    readonly selector: "runtime" | "image" | "container" | "template" | "snapshot";
    readonly identifier: string;
    readonly qualifiers: Readonly<Record<string, string>>;
  }>;
  readonly local: Readonly<{
    readonly kind: BootArtifact["kind"];
    readonly identity: string;
    readonly trust: BootArtifact["trust"];
    readonly mutability: BootArtifact["mutability"];
    readonly digest: string | null;
    readonly provenance: FrontendArtifactMappingProvenance;
  }>;
}

export type FrontendArtifactMappingErrorCategory =
  | "invalid-selector"
  | "unknown-identifier"
  | "incompatible-contract"
  | "authentication-required"
  | "artifact-unavailable"
  | "unsupported"
  | "capability-mismatch"
  | "invalid-configuration";

export interface FrontendArtifactMappingError {
  readonly code:
    | "FRONTEND_ARTIFACT_INVALID_SELECTOR"
    | "FRONTEND_ARTIFACT_UNKNOWN_IDENTIFIER"
    | "FRONTEND_ARTIFACT_INCOMPATIBLE_CONTRACT"
    | "FRONTEND_ARTIFACT_AUTHENTICATION_REQUIRED"
    | "FRONTEND_ARTIFACT_UNAVAILABLE"
    | "FRONTEND_ARTIFACT_UNSUPPORTED"
    | "FRONTEND_ARTIFACT_CAPABILITY_MISMATCH"
    | "FRONTEND_ARTIFACT_INVALID_CONFIGURATION";
  readonly category: FrontendArtifactMappingErrorCategory;
  readonly contract: string;
  readonly field: string;
  readonly message: string;
}

export type FrontendArtifactResolution =
  | {
    readonly ok: true;
    readonly artifact: BootArtifact;
    readonly mapping: FrontendArtifactMappingIdentity;
  }
  | {
    readonly ok: false;
    readonly error: FrontendArtifactMappingError;
  };

const VERCEL_RUNTIME_IMAGES: Readonly<Record<string, string>> = Object.freeze({
  node22: MANAGED_IMAGES.node22,
  node24: MANAGED_IMAGES.node24,
  node26: MANAGED_IMAGES.node26,
  "python3.13": MANAGED_IMAGES.python313,
});

const VERCEL_IMAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  universal: MANAGED_IMAGES.universal,
  "universal:latest": MANAGED_IMAGES.universal,
  "node:22": MANAGED_IMAGES.node22,
  "node:22.23.2": MANAGED_IMAGES.node22,
  "node:24": MANAGED_IMAGES.node24,
  "node:24.19.0": MANAGED_IMAGES.node24,
  "node:26": MANAGED_IMAGES.node26,
  "node:26.7.0": MANAGED_IMAGES.node26,
  "python:3.14": MANAGED_IMAGES.python314,
  "python:al-3.13.1": MANAGED_IMAGES.python313,
  ubuntu: MANAGED_IMAGES.ubuntu,
  "ubuntu:latest": MANAGED_IMAGES.ubuntu,
  arch: MANAGED_IMAGES.arch,
  "arch:latest": MANAGED_IMAGES.arch,
});

const OCI_DIGEST_ALGORITHMS = ["sha256", "sha512"] as const;
const VERCEL_DIGEST_ALGORITHMS = ["sha256"] as const;

function failure(
  contract: string,
  field: string,
  category: FrontendArtifactMappingErrorCategory,
  code: FrontendArtifactMappingError["code"],
  message: string,
): FrontendArtifactResolution {
  return { ok: false, error: { code, category, contract, field, message } };
}

function digestFromReference(
  reference: string,
  algorithms: readonly ArtifactDigest["algorithm"][],
): ArtifactDigest | null {
  const match = reference.match(/@(sha256|sha512):([a-f0-9]+)$/);
  if (match === null || !algorithms.includes(match[1] as ArtifactDigest["algorithm"])) {
    return null;
  }
  const value = match[2]!;
  if (match[1] === "sha256" && value.length === 64) {
    return { algorithm: "sha256", value };
  }
  if (match[1] === "sha512" && value.length === 128) {
    return { algorithm: "sha512", value };
  }
  return null;
}

function ociArtifact(
  reference: string,
  trust: "trusted" | "untrusted",
  digestAlgorithms: readonly ArtifactDigest["algorithm"][] = OCI_DIGEST_ALGORITHMS,
): OciImageBootArtifact {
  const digest = digestFromReference(reference, digestAlgorithms);
  return {
    kind: "oci-image",
    locator: { type: "oci-reference", reference },
    digest,
    trust,
    mutability: digest === null ? "mutable" : "immutable",
    platform: null,
  };
}

function artifactIdentity(artifact: BootArtifact): string {
  switch (artifact.kind) {
    case "host":
      return "host:current";
    case "directory":
    case "disk-image":
      return artifact.locator.path;
    case "oci-image":
      return artifact.locator.reference;
    case "snapshot":
      return artifact.locator.scope === "portable"
        ? `snapshot:${artifact.locator.snapshotId}`
        : `${artifact.locator.backend!.backendType}:${artifact.locator.backend!.backendId}:snapshot:${artifact.locator.snapshotId}`;
  }
}

function artifactDigest(artifact: BootArtifact): string | null {
  if (artifact.kind === "host" || artifact.kind === "directory" || artifact.digest === null) {
    return null;
  }
  return `${artifact.digest.algorithm}:${artifact.digest.value}`;
}

function success(
  contract: FrontendArtifactContract,
  provider: FrontendArtifactMappingIdentity["provider"],
  selector: FrontendArtifactMappingIdentity["upstream"]["selector"],
  identifier: string,
  qualifiers: Readonly<Record<string, string>>,
  artifact: BootArtifact,
  provenance: FrontendArtifactMappingProvenance,
): FrontendArtifactResolution {
  const validation = validateBootArtifact(artifact);
  if (!validation.ok) {
    return failure(
      contract,
      validation.field,
      "invalid-configuration",
      "FRONTEND_ARTIFACT_INVALID_CONFIGURATION",
      `Configured local artifact is invalid: ${validation.reason}`,
    );
  }
  return {
    ok: true,
    artifact: validation.artifact,
    mapping: {
      schemaVersion: FRONTEND_ARTIFACT_MAPPING_SCHEMA_VERSION,
      contract,
      provider,
      upstream: { selector, identifier, qualifiers },
      local: {
        kind: validation.artifact.kind,
        identity: artifactIdentity(validation.artifact),
        trust: validation.artifact.trust,
        mutability: validation.artifact.mutability,
        digest: artifactDigest(validation.artifact),
        provenance,
      },
    },
  };
}

function invalidText(value: string): boolean {
  return value.trim().length === 0 || value.includes("\0") || /\s/.test(value);
}

function registryHost(reference: string): string {
  const first = reference.split("/", 1)[0]!.toLowerCase();
  return first === "localhost" || first.includes(".") || first.includes(":") ? first : "docker.io";
}

function privateRegistry(reference: string, options: FrontendArtifactMappingOptions): boolean {
  const host = registryHost(reference);
  return options.privateRegistryHosts?.some((candidate) => candidate.trim().toLowerCase() === host) ?? false;
}

function authenticationFailure(
  contract: FrontendArtifactContract,
  field: string,
  reference: string,
): FrontendArtifactResolution {
  return failure(
    contract,
    field,
    "authentication-required",
    "FRONTEND_ARTIFACT_AUTHENTICATION_REQUIRED",
    `OCI image "${reference}" requires private registry authentication, which cannot cross the SandboxClient boundary.`,
  );
}

function resolveVercel(
  selection: VercelArtifactSelection,
  options: FrontendArtifactMappingOptions,
): FrontendArtifactResolution {
  const contract = selection.contract;
  if (selection.image !== undefined && selection.runtime !== undefined) {
    return failure(contract, "image", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "Choose either image or runtime, not both.");
  }
  if (selection.runtime !== undefined) {
    const reference = VERCEL_RUNTIME_IMAGES[selection.runtime];
    if (reference === undefined) {
      return failure(contract, "runtime", "unknown-identifier", "FRONTEND_ARTIFACT_UNKNOWN_IDENTIFIER", `Unsupported runtime "${selection.runtime}". Use node22, node24, node26, python3.13, or a custom image.`);
    }
    return success(contract, "vercel", "runtime", selection.runtime, {}, ociArtifact(reference, "trusted", VERCEL_DIGEST_ALGORITHMS), "managed");
  }

  if (selection.image === undefined) {
    return success(contract, "vercel", "image", "universal", {}, ociArtifact(MANAGED_IMAGES.universal, "trusted", VERCEL_DIGEST_ALGORITHMS), "managed");
  }
  const image = selection.image.trim();
  if (image.length === 0) {
    return failure(contract, "image", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "Sandbox image must not be empty.");
  }
  if (image.includes("\0") || /\s/.test(image)) {
    return failure(contract, "image", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "Sandbox image must not contain whitespace or NUL bytes.");
  }

  const unqualified = image.startsWith("vcr.vercel.com/")
    ? image.slice("vcr.vercel.com/".length)
    : image;
  const managedPrefix = "vercel/sandbox/";
  if (unqualified.startsWith(managedPrefix)) {
    const managedName = unqualified.slice(managedPrefix.length);
    const reference = VERCEL_IMAGE_ALIASES[managedName];
    if (reference === undefined) {
      return failure(contract, "image", "unknown-identifier", "FRONTEND_ARTIFACT_UNKNOWN_IDENTIFIER", `Unsupported Vercel managed image "${image}". Use a mirrored managed image or a custom OCI image.`);
    }
    return success(contract, "vercel", "image", image, {}, ociArtifact(reference, "trusted", VERCEL_DIGEST_ALGORITHMS), "managed");
  }
  if (selection.requiresAuthentication === true || privateRegistry(image, options)) {
    return authenticationFailure(contract, "image", image);
  }
  return success(contract, "vercel", "image", image, {}, ociArtifact(image, "untrusted", VERCEL_DIGEST_ALGORITHMS), "caller");
}

function cloudflareOfficialReference(image: string): string | null {
  const match = /^(?:docker\.io\/)?cloudflare\/sandbox:(.+)$/.exec(image);
  return match?.[1] ?? null;
}

function resolveCloudflare(
  selection: CloudflareStableArtifactSelection | CloudflareNextArtifactSelection,
  options: FrontendArtifactMappingOptions,
): FrontendArtifactResolution {
  const contract = selection.contract;
  const aliases = contract === FRONTEND_ARTIFACT_CONTRACTS.cloudflareStable.id
    ? CLOUDFLARE_STABLE_IMAGE_ALIASES
    : CLOUDFLARE_NEXT_IMAGE_ALIASES;
  const otherAliases = contract === FRONTEND_ARTIFACT_CONTRACTS.cloudflareStable.id
    ? CLOUDFLARE_NEXT_IMAGE_ALIASES
    : CLOUDFLARE_STABLE_IMAGE_ALIASES;

  if (selection.image !== undefined && selection.dockerfile !== undefined) {
    return failure(contract, "image", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "Choose either a Cloudflare image selector or a Dockerfile build, not both.");
  }
  if (selection.dockerfile !== undefined) {
    return failure(contract, "dockerfile", "unsupported", "FRONTEND_ARTIFACT_UNSUPPORTED", "Cloudflare Dockerfile builds require Wrangler and the hosted container build pipeline; configure a concrete local OCI image instead.");
  }
  if (selection.image === undefined) {
    return failure(contract, "image", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "A Cloudflare container image selector is required; Localbox does not guess a default image.");
  }
  const image = selection.image.trim();
  if (invalidText(image)) {
    return failure(contract, "image", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "Cloudflare container image must not be empty or contain whitespace or NUL bytes.");
  }
  if (selection.requiresAuthentication === true || privateRegistry(image, options)) {
    return authenticationFailure(contract, "image", image);
  }

  if (Object.hasOwn(aliases, image)) {
    const reference = aliases[image as keyof typeof aliases];
    return success(contract, "cloudflare", "container", image, {}, ociArtifact(reference, "trusted"), "managed");
  }

  const canonical = image.startsWith("cloudflare/sandbox:") ? `docker.io/${image}` : image;
  const matchesOwnReference = canonical === aliases.default ||
    canonical === aliases.python ||
    canonical === aliases.opencode ||
    canonical === aliases.musl;
  if (matchesOwnReference) {
    return success(contract, "cloudflare", "container", image, {}, ociArtifact(canonical, "trusted"), "managed");
  }
  const matchesOtherReference = canonical === otherAliases.default ||
    canonical === otherAliases.python ||
    canonical === otherAliases.opencode ||
    canonical === otherAliases.musl;
  if (matchesOtherReference) {
    return failure(contract, "image", "incompatible-contract", "FRONTEND_ARTIFACT_INCOMPATIBLE_CONTRACT", `Cloudflare image "${image}" belongs to a different @cloudflare/sandbox release line.`);
  }
  const officialTag = cloudflareOfficialReference(image);
  if (officialTag !== null) {
    return failure(contract, "image", "unknown-identifier", "FRONTEND_ARTIFACT_UNKNOWN_IDENTIFIER", `Cloudflare image tag "${officialTag}" is not mapped for ${contract}; use one of ${Object.keys(aliases).join(", ")} or the exact matching release image.`);
  }
  return success(contract, "cloudflare", "container", image, {}, ociArtifact(image, "untrusted"), "caller");
}

function configuredArtifact<T extends BootArtifact>(
  contract: FrontendArtifactContract,
  field: string,
  providerIdentifier: string,
  value: T,
  expectedKind: T["kind"],
): { readonly ok: true; readonly artifact: T } | { readonly ok: false; readonly resolution: FrontendArtifactResolution } {
  const validation = validateBootArtifact(value);
  if (!validation.ok || validation.artifact.kind !== expectedKind) {
    const reason = validation.ok
      ? `expected ${expectedKind}, received ${validation.artifact.kind}`
      : validation.reason;
    return {
      ok: false,
      resolution: failure(contract, field, "invalid-configuration", "FRONTEND_ARTIFACT_INVALID_CONFIGURATION", `Local mapping for "${providerIdentifier}" is invalid: ${reason}.`),
    };
  }
  return { ok: true, artifact: validation.artifact as T };
}

function resolveE2B(
  selection: E2BArtifactSelection,
  options: FrontendArtifactMappingOptions,
): FrontendArtifactResolution {
  const contract = selection.contract;
  if (selection.template !== undefined && selection.templateBuild === true) {
    return failure(contract, "template", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "Choose either an E2B template identifier or a template build, not both.");
  }
  if (selection.templateBuild === true) {
    return failure(contract, "templateBuild", "unsupported", "FRONTEND_ARTIFACT_UNSUPPORTED", "E2B template builds are cloud control-plane operations and cannot be resolved to a pre-existing local artifact.");
  }
  if (selection.template === undefined) {
    return failure(contract, "template", "artifact-unavailable", "FRONTEND_ARTIFACT_UNAVAILABLE", "The E2B default hosted template has no configured local OCI artifact.");
  }
  const template = selection.template.trim();
  if (invalidText(template)) {
    return failure(contract, "template", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "E2B template identifier must not be empty or contain whitespace or NUL bytes.");
  }
  const configured = options.e2bTemplates;
  if (configured === undefined || !Object.hasOwn(configured, template)) {
    return failure(contract, "template", "artifact-unavailable", "FRONTEND_ARTIFACT_UNAVAILABLE", `E2B template "${template}" is hosted-only or has no explicitly configured local OCI artifact.`);
  }
  const candidate = configuredArtifact(contract, "template", template, configured[template]!, "oci-image");
  if (!candidate.ok) return candidate.resolution;
  const reference = candidate.artifact.locator.reference;
  if (privateRegistry(reference, options)) return authenticationFailure(contract, "template", reference);
  return success(contract, "e2b", "template", template, {}, candidate.artifact, "configured-local");
}

function sameBackend(left: BackendReference, right: BackendReference): boolean {
  return left.backendId === right.backendId && left.backendType === right.backendType;
}

function resolveDaytona(
  selection: DaytonaArtifactSelection,
  options: FrontendArtifactMappingOptions,
): FrontendArtifactResolution {
  const contract = selection.contract;
  const selected = Number(selection.image !== undefined) +
    Number(selection.snapshot !== undefined) + Number(selection.imageBuild === true);
  if (selected > 1) {
    return failure(contract, "image", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "Choose exactly one Daytona image, snapshot, or dynamic image build selector.");
  }
  if (selection.imageBuild === true) {
    return failure(contract, "image", "unsupported", "FRONTEND_ARTIFACT_UNSUPPORTED", "Daytona Image builders and Dockerfiles require a hosted dynamic snapshot build; pass a concrete public OCI image string instead.");
  }
  if (selection.image !== undefined) {
    const image = selection.image.trim();
    if (invalidText(image)) {
      return failure(contract, "image", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "Daytona image must not be empty or contain whitespace or NUL bytes.");
    }
    if (selection.requiresAuthentication === true || privateRegistry(image, options)) {
      return authenticationFailure(contract, "image", image);
    }
    return success(
      contract,
      "daytona",
      "image",
      image,
      selection.language === undefined ? {} : { language: selection.language },
      ociArtifact(image, "untrusted"),
      "caller",
    );
  }
  if (selection.snapshot === undefined) {
    return failure(contract, "snapshot", "artifact-unavailable", "FRONTEND_ARTIFACT_UNAVAILABLE", "Daytona default and language-selected snapshots are hosted artifacts; configure an actually present local snapshot explicitly.");
  }

  const snapshot = selection.snapshot.trim();
  if (invalidText(snapshot)) {
    return failure(contract, "snapshot", "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR", "Daytona snapshot identifier must not be empty or contain whitespace or NUL bytes.");
  }
  const configured = options.daytonaSnapshots;
  if (configured === undefined || !Object.hasOwn(configured, snapshot)) {
    return failure(contract, "snapshot", "artifact-unavailable", "FRONTEND_ARTIFACT_UNAVAILABLE", `Daytona snapshot "${snapshot}" is not present in the configured local snapshot store.`);
  }
  const candidate = configuredArtifact(contract, "snapshot", snapshot, configured[snapshot]!, "snapshot");
  if (!candidate.ok) return candidate.resolution;
  if (options.backend === undefined) {
    return failure(contract, "snapshot", "capability-mismatch", "FRONTEND_ARTIFACT_CAPABILITY_MISMATCH", `Daytona snapshot "${snapshot}" requires an explicit backend identity and capability contract before it can be selected.`);
  }
  const artifactBackend = candidate.artifact.locator.backend;
  if (artifactBackend !== null && !sameBackend(artifactBackend, options.backend.reference)) {
    return failure(contract, "snapshot", "capability-mismatch", "FRONTEND_ARTIFACT_CAPABILITY_MISMATCH", `Daytona snapshot "${snapshot}" belongs to backend ${artifactBackend.backendType}/${artifactBackend.backendId}, not ${options.backend.reference.backendType}/${options.backend.reference.backendId}.`);
  }
  const issues = negotiateSandboxRequirements(options.backend.capabilities, [
    { type: "artifacts", kinds: ["snapshot"], acceptableSupport: ["native", "emulated", "partial"] },
    { type: "snapshots", operation: "restore", acceptableSupport: ["native", "emulated", "partial"] },
  ]);
  if (issues.length > 0) {
    return failure(contract, "snapshot", "capability-mismatch", "FRONTEND_ARTIFACT_CAPABILITY_MISMATCH", `The selected backend cannot restore Daytona snapshot "${snapshot}": ${issues.map(({ reason }) => reason).join(" ")}`);
  }
  return success(
    contract,
    "daytona",
    "snapshot",
    snapshot,
    selection.language === undefined ? {} : { language: selection.language },
    candidate.artifact,
    "configured-local",
  );
}

/**
 * Resolve a pinned provider selector to one validated concrete artifact.
 * This function is synchronous so every failure occurs before client creation.
 */
export function resolveFrontendBootArtifact(
  selection: FrontendArtifactSelection,
  options: FrontendArtifactMappingOptions = {},
): FrontendArtifactResolution {
  switch (selection.contract) {
    case "vercel@3.3.0":
      return resolveVercel(selection, options);
    case "cloudflare@0.12.9":
    case "cloudflare@0.13.0-next.769.1":
      return resolveCloudflare(selection, options);
    case "e2b@2.8.0":
      return resolveE2B(selection, options);
    case "daytona@0.216.0":
      return resolveDaytona(selection, options);
    default: {
      const unknown = selection as { readonly contract?: unknown };
      const contract = typeof unknown.contract === "string" ? unknown.contract : "<missing>";
      return failure(contract, "contract", "incompatible-contract", "FRONTEND_ARTIFACT_INCOMPATIBLE_CONTRACT", `Unknown frontend artifact contract "${contract}".`);
    }
  }
}
