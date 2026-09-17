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
