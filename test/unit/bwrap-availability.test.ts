import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BwrapBackend } from "../../src/backends/bwrap/index.js";

test("BwrapBackend reports a missing injected binary without allocating backend state", async () => {
  const root = await mkdtemp(join(tmpdir(), "localbox-bwrap-unavailable-"));
  const backendRoot = join(root, "backend");
  try {
    const backend = new BwrapBackend({
      root: backendRoot,
      instanceId: "missing-binary",
      binaryPath: join(root, `missing-bwrap-${randomUUID()}`),
    });
    const result = await backend.probeAvailability({ requestId: "missing-bwrap", deadline: null });
    expect(result).toMatchObject({
      ok: true,
      value: {
        availability: {
          status: "unavailable",
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "BWRAP_BINARY_NOT_FOUND",
              message: expect.not.stringContaining(root),
            }),
          ]),
        },
      },
    });
    await expect(stat(backendRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
