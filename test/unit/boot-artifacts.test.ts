import { describe, expect, test } from "vitest";
import {
  validateBootArtifact,
  validateSandboxFrontendMetadata,
  type BootArtifact,
} from "../../src/runtime/index.js";
import { MANAGED_IMAGES } from "../../src/backends/docker/managed-images.js";
import { resolveVercelBootArtifact } from "../../src/vercel/boot-artifact.js";

const artifacts = [
  {
    kind: "host",
    locator: { type: "host", selector: "current" },
    trust: "trusted",
    mutability: "mutable",
  },
  {
    kind: "directory",
    locator: { type: "absolute-path", path: "/srv/localbox/root" },
    trust: "untrusted",
    mutability: "read-only",
  },
  {
    kind: "oci-image",
    locator: {
      type: "oci-reference",
      reference: `registry.example.test/team/app@sha256:${"a".repeat(64)}`,
    },
    digest: { algorithm: "sha256", value: "a".repeat(64) },
    trust: "untrusted",
    mutability: "immutable",
    platform: { os: "linux", architecture: "arm64", variant: "v8" },
  },
  {
    kind: "disk-image",
    locator: { type: "absolute-path", path: "/srv/localbox/disk.qcow2" },
    digest: { algorithm: "sha512", value: "b".repeat(128) },
    trust: "trusted",
    mutability: "read-only",
    format: "qcow2",
    architecture: "amd64",
  },
  {
    kind: "snapshot",
    locator: {
      type: "snapshot-id",
      snapshotId: "snapshot-123",
      scope: "backend",
      backend: { backendId: "vm-a", backendType: "future-vm" },
    },
    digest: null,
    trust: "trusted",
    mutability: "mutable",
  },
] as const satisfies readonly BootArtifact[];

describe("boot artifact contract", () => {
  test("validates and JSON-round-trips every explicit artifact kind", () => {
    for (const artifact of artifacts) {
      expect(validateBootArtifact(artifact)).toEqual({ ok: true, artifact });
      expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
    }
  });

  test("rejects ambiguous locators, digests, inferred immutability, and unknown fields", () => {
    const invalid = [
      { ...artifacts[0], locator: { type: "host", selector: "/bin/node" } },
      { ...artifacts[1], locator: { type: "absolute-path", path: "relative/path" } },
      {
        ...artifacts[2],
        digest: { algorithm: "sha256", value: "A".repeat(64) },
      },
      {
        ...artifacts[2],
        digest: null,
        mutability: "immutable",
      },
      {
        ...artifacts[3],
        locator: { type: "absolute-path", path: "/disk\0image" },
      },
      {
        ...artifacts[4],
        locator: {
          type: "snapshot-id",
          snapshotId: "snapshot-123",
          scope: "portable",
          backend: { backendId: "vm-a", backendType: "future-vm" },
        },
      },
      { ...artifacts[0], executable: "/bin/node" },
      { kind: "future", locator: {}, trust: "trusted", mutability: "mutable" },
    ];
    for (const artifact of invalid) expect(validateBootArtifact(artifact).ok).toBe(false);
  });

  test("keeps provider metadata descriptive of the concrete artifact", () => {
    const artifact = artifacts[2];
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
    expect(validateSandboxFrontendMetadata(metadata, artifacts[0])).toMatchObject({
      ok: false,
      field: "frontendMetadata.image",
    });
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
