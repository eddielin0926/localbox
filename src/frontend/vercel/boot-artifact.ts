import { resolveFrontendBootArtifact } from "../artifact-mappings.js";
import type {
  OciImageBootArtifact,
  SandboxFrontendMetadata,
} from "../../runtime/index.js";

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

/** Converts provider selectors exactly once, before the SandboxClient boundary. */
export function resolveVercelBootArtifact(selection: VercelBootSelection): VercelBootResolution {
  const resolution = resolveFrontendBootArtifact({
    contract: "vercel@3.3.0",
    ...(selection.runtime === undefined ? {} : { runtime: selection.runtime }),
    ...(selection.image === undefined ? {} : { image: selection.image }),
  });
  if (!resolution.ok) {
    return {
      ok: false,
      category: resolution.error.category === "invalid-selector" ? "invalid" : "unsupported",
      field: resolution.error.field === "runtime" ? "runtime" : "image",
      message: resolution.error.message,
    };
  }
  if (resolution.artifact.kind !== "oci-image") {
    throw new TypeError("The Vercel artifact contract resolved a non-OCI artifact.");
  }
  return {
    ok: true,
    artifact: resolution.artifact,
    metadata: {
      type: "vercel",
      image: resolution.artifact.locator.reference,
      runtime: selection.runtime ?? null,
    },
  };
}
