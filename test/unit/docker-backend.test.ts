import { describe, expect, test } from "vitest";
import { DockerBackend } from "../../src/runtime/index.js";

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
});
