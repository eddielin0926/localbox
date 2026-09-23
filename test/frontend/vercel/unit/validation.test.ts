import { describe, expect, test } from "vitest";
import type { RequestMetadata, SandboxClient } from "../../../../src/runtime/index.js";
import { createVercelSandboxClass } from "../../../../src/frontend/vercel/sandbox.js";
import {
  DockerUnavailableError,
  ImagePullError,
  InvalidSandboxOptionsError,
  PortNotExposedError,
  SandboxNotFoundError,
  UnsupportedImageError,
  UnsupportedSandboxCapabilityError,
} from "../../../../src/frontend/vercel/index.js";
import type { SandboxCreateOptions } from "../../../../src/frontend/vercel/types.js";
import { resolveSandboxPath } from "../../../../src/frontend/vercel/filesystem.js";

const rejectingClient = new Proxy({}, {
  get(_target, property) {
    if (property === "then") return undefined;
    return (request: RequestMetadata) => Promise.resolve({
      ok: false as const,
      error: {
        category: "invalid-request" as const,
        code: "LOCALBOX_INVALID_REQUEST",
        message: "The client rejected invalid sandbox options.",
        retryable: false,
        requestId: request.requestId,
        backend: { backendId: "validation", backendType: "test" },
        details: {
          type: "invalid-request" as const,
          field: null,
          reason: "The client rejected invalid sandbox options.",
        },
      },
    });
  },
}) as SandboxClient;


describe("sandbox option validation", () => {
  test("translates frontend and client-boundary validation failures consistently", async () => {
    const Sandbox = createVercelSandboxClass(() => rejectingClient);
    const invalidOptions = [
      { name: "   " },
      { name: "x".repeat(129) },
      { image: "image", runtime: "node24" },
      { runtime: "python" as "node24" },
      { image: " " },
      { timeout: 0 },
      { timeout: 1.5 },
      { ports: [0] },
      { ports: [65_536] },
      { ports: [3000, 3000] },
      { ports: Array.from({ length: 16 }, (_, index) => index + 1) },
      { env: { "BAD=KEY": "value" } },
      { env: { LOCALBOX_PRIVATE: "value" } },
      { resources: { vcpus: 0 } },
      {
        tags: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`tag-${index}`, "value"])),
      },
      { region: " " },
      { region: "iad1", failoverRegions: ["iad1"] },
      { failoverRegions: ["sfo1", "sfo1"] },
      { source: { type: "git", url: "https://example.test/repo.git", depth: 0 } },
      { source: { type: "tarball", url: " " } },
    ];

    for (const options of invalidOptions) {
      await expect(Sandbox.create(options as unknown as SandboxCreateOptions)).rejects.toBeInstanceOf(
        InvalidSandboxOptionsError,
      );
    }
  });

  test("rejects unsupported upstream capabilities before constructing a client", async () => {
    const Sandbox = createVercelSandboxClass(() => {
      throw new Error("client factory must not be called");
    });
    const unsupportedOptions = [
      { source: { type: "snapshot", snapshotId: "snap_123" } },
      { mounts: { "/data": { drive: "drive_123", mode: "read-write" } } },
      { snapshotExpiration: 60_000 },
      { keepLastSnapshots: { count: 2 } },
      { networkPolicy: { allow: ["example.com"] } },
      { networkPolicy: "deny-all", ports: [3000] },
    ];

    for (const options of unsupportedOptions) {
      await expect(Sandbox.create(options as unknown as SandboxCreateOptions)).rejects.toBeInstanceOf(
        UnsupportedSandboxCapabilityError,
      );
    }
  });

  test("resolves sandbox paths and rejects NUL bytes", () => {
    expect(resolveSandboxPath("a/../b.txt")).toBe("/vercel/sandbox/b.txt");
    expect(resolveSandboxPath("/tmp/file")).toBe("/tmp/file");
    expect(() => resolveSandboxPath("bad\0path")).toThrow(/NUL/);
  });

  test("public errors provide corrective actions without daemon response text", () => {
    expect(new DockerUnavailableError(new Error("raw body")).message).toBe(
      "Cannot connect to Docker. Start Docker and retry.",
    );
    expect(new UnsupportedImageError("broken").message).toContain("must contain node and /bin/sh");
    expect(new PortNotExposedError("box", 8080).message).toContain("Include it in create({ ports })");
    expect(new SandboxNotFoundError("box").message).toContain("Create it before retrying");
    expect(new ImagePullError("private/image", new Error("registry body")).message).not.toContain("registry body");
  });
});
