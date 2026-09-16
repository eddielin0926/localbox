import { describe, expect, test } from "vitest";
import {
  DockerUnavailableError,
  ImagePullError,
  InvalidSandboxOptionsError,
  MANAGED_IMAGES,
  PortNotExposedError,
  Sandbox,
  SandboxNotFoundError,
  UnsupportedImageError,
  UnsupportedSandboxCapabilityError,
} from "../../src/vercel/index.js";
import type { SandboxCreateOptions } from "../../src/vercel/types.js";
import { dockerContainerName } from "../../src/vercel/sandbox.js";
import { resolveSandboxPath } from "../../src/vercel/filesystem.js";
import { resolveSandboxImage } from "../../src/vercel/managed-images.js";

describe("sandbox option validation", () => {
  test("rejects invalid create options before contacting Docker", async () => {
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

  test("rejects unsupported upstream capabilities before contacting Docker", async () => {
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

  test("derives stable collision-resistant Docker names", () => {
    const first = dockerContainerName("My Sandbox / One");
    const same = dockerContainerName("My Sandbox / One");
    const different = dockerContainerName("My Sandbox / Two");

    expect(first).toBe(same);
    expect(first).toMatch(/^localbox-my-sandbox-one-[a-f0-9]{12}$/);
    expect(different).not.toBe(first);
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
