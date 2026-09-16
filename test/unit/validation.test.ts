import { describe, expect, test } from "vitest";
import {
  DockerUnavailableError,
  ImagePullError,
  InvalidSandboxOptionsError,
  PortNotExposedError,
  Sandbox,
  SandboxNotFoundError,
  UnsupportedImageError,
} from "../../src/vercel/index.js";
import type { SandboxCreateOptions } from "../../src/vercel/types.js";
import { dockerContainerName } from "../../src/vercel/sandbox.js";
import { resolveSandboxPath } from "../../src/vercel/filesystem.js";

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
    ];

    for (const options of invalidOptions) {
      await expect(Sandbox.create(options as unknown as SandboxCreateOptions)).rejects.toBeInstanceOf(
        InvalidSandboxOptionsError,
      );
    }
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
