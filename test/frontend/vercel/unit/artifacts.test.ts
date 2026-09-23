import { describe, expect, test } from "vitest";
import { MANAGED_IMAGES } from "../../../../src/frontend/vercel-managed-images.js";
import { resolveVercelBootArtifact } from "../../../../src/frontend/vercel/boot-artifact.js";
import { validateSandboxFrontendMetadata } from "../../../../src/runtime/index.js";

describe("Vercel boot artifacts", () => {
  test("keeps provider metadata descriptive of the concrete artifact", () => {
    const artifact = {
      kind: "oci-image",
      locator: {
        type: "oci-reference",
        reference: `registry.example.test/team/app@sha256:${"a".repeat(64)}`,
      },
      digest: { algorithm: "sha256", value: "a".repeat(64) },
      trust: "untrusted",
      mutability: "immutable",
      platform: { os: "linux", architecture: "arm64", variant: "v8" },
    } as const;
    const metadata = {
      type: "vercel",
      image: artifact.locator.reference,
      runtime: "node24",
    } as const;

    expect(validateSandboxFrontendMetadata(metadata, artifact)).toEqual({
      ok: true,
      metadata,
    });
    expect(validateSandboxFrontendMetadata(
      { ...metadata, image: "registry.example.test/other:latest" },
      artifact,
    )).toMatchObject({ ok: false, field: "frontendMetadata.image" });
    expect(validateSandboxFrontendMetadata(metadata, {
      kind: "host",
      locator: { type: "host", selector: "current" },
      trust: "trusted",
      mutability: "mutable",
    })).toMatchObject({ ok: false, field: "frontendMetadata.image" });
  });

  test("resolves Vercel runtime and image selectors to one concrete OCI artifact", () => {
    expect(resolveVercelBootArtifact({ runtime: "node24" })).toEqual({
      ok: true,
      artifact: {
        kind: "oci-image",
        locator: { type: "oci-reference", reference: MANAGED_IMAGES.node24 },
        digest: null,
        trust: "trusted",
        mutability: "mutable",
        platform: null,
      },
      metadata: { type: "vercel", image: MANAGED_IMAGES.node24, runtime: "node24" },
    });
    expect(resolveVercelBootArtifact({ image: "vcr.vercel.com/vercel/sandbox/python:3.14" }))
      .toMatchObject({
        ok: true,
        artifact: { locator: { reference: MANAGED_IMAGES.python314 }, trust: "trusted" },
        metadata: { image: MANAGED_IMAGES.python314, runtime: null },
      });
    const pinned = `registry.example.test/team/app@sha256:${"c".repeat(64)}`;
    expect(resolveVercelBootArtifact({ image: pinned })).toMatchObject({
      ok: true,
      artifact: {
        locator: { reference: pinned },
        digest: { algorithm: "sha256", value: "c".repeat(64) },
        trust: "untrusted",
        mutability: "immutable",
      },
    });
    const sha512 = `registry.example.test/team/app@sha512:${"d".repeat(128)}`;
    expect(resolveVercelBootArtifact({ image: sha512 })).toMatchObject({
      ok: true,
      artifact: {
        locator: { reference: sha512 },
        digest: null,
        trust: "untrusted",
        mutability: "mutable",
      },
    });
  });

  test("returns structured invalid and unsupported provider conversion failures", () => {
    expect(resolveVercelBootArtifact({ runtime: "node24", image: "node:24" })).toEqual({
      ok: false,
      category: "invalid",
      field: "image",
      message: "Choose either image or runtime, not both.",
    });
    expect(resolveVercelBootArtifact({ runtime: "ruby99" })).toMatchObject({
      ok: false,
      category: "unsupported",
      field: "runtime",
    });
    expect(resolveVercelBootArtifact({ image: "vercel/sandbox/node:999" })).toMatchObject({
      ok: false,
      category: "unsupported",
      field: "image",
    });
  });
});
