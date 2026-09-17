import { describe, expect, test } from "vitest";
import { DockerBackend } from "../../src/backends/docker/index.js";
import { InvalidSandboxOptionsError } from "../../src/backends/docker/errors.js";
import {
  MANAGED_IMAGES,
  resolveSandboxImage,
} from "../../src/backends/docker/managed-images.js";
import { dockerContainerName } from "../../src/backends/docker/sandbox.js";

describe("DockerBackend boundary", () => {
  test("translates invalid operations into JSON-safe client failures", async () => {
    const backend = new DockerBackend();
    const result = await backend.listSandboxes({
      requestId: "request-invalid-list",
      deadline: null,
      namePrefix: null,
      tags: {},
      statuses: [],
      sortBy: "createdAt",
      sortOrder: "desc",
      limit: 0,
      cursor: null,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        category: "invalid-request",
        code: "LOCALBOX_INVALID_REQUEST",
        message: "Sandbox list limit must be a positive integer.",
        retryable: false,
        requestId: "request-invalid-list",
        backend: { backendId: "local-docker", backendType: "docker" },
        details: {
          type: "invalid-request",
          field: null,
          reason: "Sandbox list limit must be a positive integer.",
        },
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("advertises an honest transport-safe capability matrix", () => {
    const capabilities = new DockerBackend().capabilities;

    expect(capabilities.schemaVersion).toBe(1);
    expect(Object.fromEntries(
      Object.entries(capabilities.operations).map(([name, entry]) => [name, entry.support]),
    )).toEqual({
      "command.start": "native",
      "command.detached": "emulated",
      "endpoint.expose": "native",
      "filesystem.mkdir": "emulated",
      "filesystem.read": "emulated",
      "filesystem.write": "emulated",
      "source.git": "emulated",
      "source.tarball": "emulated",
      "raw-command.input": "native",
      "raw-command.managed-filesystem-owner": "partial",
    });
    expect(capabilities).toMatchObject({
      isolation: {
        support: "partial",
        constraints: {
          level: "shared-kernel-container",
          tenancies: ["trusted", "single-tenant"],
        },
      },
      artifacts: {
        support: "partial",
        constraints: { kinds: ["runtime", "oci-image", "git", "tarball"] },
      },
      persistence: {
        support: "native",
        constraints: { scopes: ["sandbox-lifecycle", "backend-restart"] },
      },
      recovery: {
        support: "partial",
        constraints: { scopes: ["sandbox"] },
      },
      networking: {
        support: "partial",
        constraints: {
          modes: ["allow-all", "deny-all"],
          portExposure: ["loopback"],
          customPolicies: false,
        },
      },
      resources: {
        support: "partial",
        constraints: {
          cpu: { minimumVcpus: 1, maximumVcpus: null, stepVcpus: 1 },
          memoryBytesPerVcpu: 2_147_483_648,
          enforcement: "hard",
        },
      },
      terminals: {
        support: "unsupported",
        constraints: { modes: [] },
      },
      snapshots: {
        support: "unsupported",
        constraints: { operations: [] },
      },
    });
    expect(JSON.parse(JSON.stringify(capabilities))).toEqual(capabilities);
    for (const entry of [
      ...Object.values(capabilities.operations),
      capabilities.isolation,
      capabilities.artifacts,
      capabilities.persistence,
      capabilities.recovery,
      capabilities.networking,
      capabilities.resources,
      capabilities.terminals,
      capabilities.snapshots,
    ]) {
      expect(entry.diagnostic.length).toBeGreaterThan(20);
    }
  });

  test("resolves managed image aliases without rewriting custom OCI images", () => {
    expect(resolveSandboxImage({})).toBe(MANAGED_IMAGES.universal);
    expect(resolveSandboxImage({ runtime: "node24" })).toBe(MANAGED_IMAGES.node24);
    expect(resolveSandboxImage({ image: "vercel/sandbox/node:22" })).toBe(MANAGED_IMAGES.node22);
    expect(resolveSandboxImage({ image: "vcr.vercel.com/vercel/sandbox/python:3.14" })).toBe(
      MANAGED_IMAGES.python314,
    );
    expect(resolveSandboxImage({ image: "registry.example.test/team/image:v1" })).toBe(
      "registry.example.test/team/image:v1",
    );
    expect(() => resolveSandboxImage({ image: "vercel/sandbox/node:999" })).toThrow(
      InvalidSandboxOptionsError,
    );
  });

  test("derives stable collision-resistant container names", () => {
    const first = dockerContainerName("My Sandbox / One");
    const same = dockerContainerName("My Sandbox / One");
    const different = dockerContainerName("My Sandbox / Two");

    expect(first).toBe(same);
    expect(first).toMatch(/^localbox-my-sandbox-one-[a-f0-9]{12}$/);
    expect(different).not.toBe(first);
  });
});
