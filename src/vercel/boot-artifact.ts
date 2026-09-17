import type {
  OciImageBootArtifact,
  SandboxFrontendMetadata,
} from "../runtime/index.js";
import { MANAGED_IMAGES } from "../backends/docker/managed-images.js";

export interface VercelBootSelection {
  readonly runtime?: string;
  readonly image?: string;
}

export type VercelBootResolution =
  | {
    readonly ok: true;
    readonly artifact: OciImageBootArtifact;
    readonly metadata: SandboxFrontendMetadata;
  }
  | {
    readonly ok: false;
    readonly category: "invalid" | "unsupported";
    readonly field: "runtime" | "image";
    readonly message: string;
  };

const RUNTIME_IMAGES: Readonly<Record<string, string>> = Object.freeze({
  node22: MANAGED_IMAGES.node22,
  node24: MANAGED_IMAGES.node24,
  node26: MANAGED_IMAGES.node26,
  "python3.13": MANAGED_IMAGES.python313,
});

const VERCEL_IMAGES: Readonly<Record<string, string>> = Object.freeze({
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

function success(
  reference: string,
  runtime: string | null,
  provenance: "managed" | "caller",
): VercelBootResolution {
  const digestMatch = reference.match(/@sha256:([a-f0-9]{64})$/);
  const digest = digestMatch === null
    ? null
    : { algorithm: "sha256" as const, value: digestMatch[1]! };
  return {
    ok: true,
    artifact: {
      kind: "oci-image",
      locator: { type: "oci-reference", reference },
      digest,
      trust: provenance === "managed" ? "trusted" : "untrusted",
      mutability: digest === null ? "mutable" : "immutable",
      platform: null,
    },
    metadata: { type: "vercel", image: reference, runtime },
  };
}

/** Converts provider selectors exactly once, before the SandboxClient boundary. */
export function resolveVercelBootArtifact(selection: VercelBootSelection): VercelBootResolution {
  if (selection.image !== undefined && selection.runtime !== undefined) {
    return {
      ok: false,
      category: "invalid",
      field: "image",
      message: "Choose either image or runtime, not both.",
    };
  }

  if (selection.runtime !== undefined) {
    const reference = RUNTIME_IMAGES[selection.runtime];
    if (reference === undefined) {
      return {
        ok: false,
        category: "unsupported",
        field: "runtime",
        message: `Unsupported runtime "${selection.runtime}". Use node22, node24, node26, python3.13, or a custom image.`,
      };
    }
    return success(reference, selection.runtime, "managed");
  }

  if (selection.image === undefined) return success(MANAGED_IMAGES.universal, null, "managed");
  const image = selection.image.trim();
  if (image.length === 0) {
    return {
      ok: false,
      category: "invalid",
      field: "image",
      message: "Sandbox image must not be empty.",
    };
  }
  if (image.includes("\0") || /\s/.test(image)) {
    return {
      ok: false,
      category: "invalid",
      field: "image",
      message: "Sandbox image must not contain whitespace or NUL bytes.",
    };
  }

  const unqualified = image.startsWith("vcr.vercel.com/")
    ? image.slice("vcr.vercel.com/".length)
    : image;
  const managedPrefix = "vercel/sandbox/";
  if (!unqualified.startsWith(managedPrefix)) return success(image, null, "caller");

  const managedName = unqualified.slice(managedPrefix.length);
  const reference = VERCEL_IMAGES[managedName];
  if (reference === undefined) {
    return {
      ok: false,
      category: "unsupported",
      field: "image",
      message: `Unsupported Vercel managed image "${image}". Use a mirrored managed image or a custom OCI image.`,
    };
  }
  return success(reference, null, "managed");
}
