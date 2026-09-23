import { describe, expect, test } from "vitest";
import {
  validateBootArtifact,
  type BootArtifact,
} from "../../src/runtime/index.js";

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

});
