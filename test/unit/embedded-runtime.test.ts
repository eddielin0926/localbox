import { describe, expect, test } from "vitest";
import { EmbeddedSandboxClient } from "../../src/runtime/index.js";
import type {
  BackendReference,
  ClientFailure,
  ClientResult,
  CreateSandboxRequest,
  RequestMetadata,
  SandboxBackend,
  SandboxCapability,
  SandboxRecord,
  WriteFileRequest,
  WriteFileResult,
} from "../../src/runtime/index.js";

const ALL_CAPABILITIES = [
  "command.start",
  "command.detached",
  "endpoint.expose",
  "filesystem.mkdir",
  "filesystem.read",
  "filesystem.write",
  "sandbox.network.allow-all",
  "sandbox.network.deny-all",
  "sandbox.persistence",
  "sandbox.resource-limits",
  "sandbox.source.git",
  "sandbox.source.tarball",
] as const satisfies readonly SandboxCapability[];

function unavailable(
  request: RequestMetadata,
  operation: string,
): Promise<ClientFailure> {
  return Promise.resolve({
    ok: false,
    error: {
      category: "backend-unavailable",
      code: "TEST_BACKEND_UNAVAILABLE",
      message: `${operation} is not implemented by this test backend.`,
      retryable: false,
      requestId: request.requestId,
      backend: null,
      details: { type: "backend", operation },
    },
  });
}

function createBackend(
  reference: BackendReference,
  capabilities: readonly SandboxCapability[] = ALL_CAPABILITIES,
  overrides: Partial<Omit<SandboxBackend, "reference" | "capabilities">> = {},
): SandboxBackend {
  return {
    reference,
    capabilities,
    createSandbox: (request) => unavailable(request, "createSandbox"),
    getSandbox: (request) => unavailable(request, "getSandbox"),
    listSandboxes: (request) => unavailable(request, "listSandboxes"),
    stopSandbox: (request) => unavailable(request, "stopSandbox"),
    deleteSandbox: (request) => unavailable(request, "deleteSandbox"),
    extendSandboxDeadline: (request) => unavailable(request, "extendSandboxDeadline"),
    startCommand: (request) => unavailable(request, "startCommand"),
    waitForCommand: (request) => unavailable(request, "waitForCommand"),
    signalProcess: (request) => unavailable(request, "signalProcess"),
    readCommandOutput: (request) => unavailable(request, "readCommandOutput"),
    readFile: (request) => unavailable(request, "readFile"),
    writeFile: (request) => unavailable(request, "writeFile"),
    makeDirectory: (request) => unavailable(request, "makeDirectory"),
    getEndpoint: (request) => unavailable(request, "getEndpoint"),
    ...overrides,
  };
}

function createRequest(
  requestId: string,
  sandboxId: string,
  name: string,
  backend: BackendReference | null = null,
  requirements: CreateSandboxRequest["requirements"] = [],
): CreateSandboxRequest {
  return {
    requestId,
    idempotencyKey: `create:${sandboxId}`,
    deadline: { expiresAt: 1_800_000_000_000 },
    sandboxId,
    backend,
    requirements,
    spec: {
      name,
      bootSource: { type: "runtime", runtime: "node24" },
      source: null,
      persistent: false,
      timeoutMs: 300_000,
      environment: {},
      tags: {},
      ports: [],
      networkPolicy: "allow-all",
      resources: { vcpus: null, memoryBytes: null },
      region: null,
      failoverRegions: [],
    },
  };
}

function sandboxRecord(
  request: CreateSandboxRequest,
  backend: BackendReference,
): SandboxRecord {
  return {
    sandboxId: request.sandboxId,
    name: request.spec.name,
    status: "running",
    persistent: request.spec.persistent,
    bootSource: request.spec.bootSource.type === "image"
      ? request.spec.bootSource
      : { type: "image", image: `resolved:${request.spec.bootSource.runtime}` },
    runtime: request.spec.bootSource.type === "runtime" ? request.spec.bootSource.runtime : null,
    backend,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    statusUpdatedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
    timeoutMs: request.spec.timeoutMs,
    tags: request.spec.tags,
    ports: request.spec.ports,
    endpoints: [],
    resources: request.spec.resources,
    region: request.spec.region,
    failoverRegions: request.spec.failoverRegions,
  };
}

function createMemoryBackend(reference: BackendReference): SandboxBackend {
  const sandboxes = new Map<string, SandboxRecord>();
  return createBackend(reference, ALL_CAPABILITIES, {
    async createSandbox(request) {
      if (sandboxes.has(request.sandboxId)) {
        return {
          ok: false,
          error: {
            category: "already-exists",
            code: "TEST_ALREADY_EXISTS",
            message: "Sandbox already exists in this backend.",
            retryable: false,
            requestId: request.requestId,
            backend: reference,
            details: {
              type: "resource",
              resource: "sandbox",
              resourceId: request.sandboxId,
            },
          },
        };
      }
      const sandbox = sandboxRecord(request, reference);
      sandboxes.set(request.sandboxId, sandbox);
      return { ok: true, value: { sandbox } };
    },
    async listSandboxes() {
      return {
        ok: true,
        value: { sandboxes: [...sandboxes.values()], nextCursor: null },
      };
    },
  });
}

function listRequest(requestId: string) {
  return {
    requestId,
    deadline: null,
    namePrefix: null,
    tags: {},
    statuses: [],
    sortBy: "createdAt",
    sortOrder: "asc",
    limit: 100,
    cursor: null,
  } as const;
}

function writeRequest(requestId: string, path: string): WriteFileRequest {
  return {
    requestId,
    idempotencyKey: `write:${path}`,
    deadline: { expiresAt: 1_800_000_123_456 },
    sandboxId: "sandbox-1",
    path,
    content: { encoding: "utf8", data: "payload" },
    mode: 0o600,
  };
}

describe("EmbeddedSandboxClient", () => {
  test("keeps coexisting backend instances isolated", async () => {
    const firstReference = { backendId: "first", backendType: "memory" } as const;
    const secondReference = { backendId: "second", backendType: "memory" } as const;
    const first = new EmbeddedSandboxClient(createMemoryBackend(firstReference));
    const second = new EmbeddedSandboxClient(createMemoryBackend(secondReference));

    const firstCreate = await first.createSandbox(
      createRequest("create-first", "shared-id", "first-sandbox"),
    );
    const secondCreate = await second.createSandbox(
      createRequest("create-second", "shared-id", "second-sandbox"),
    );
    expect(firstCreate.ok).toBe(true);
    expect(secondCreate.ok).toBe(true);

    const firstList = await first.listSandboxes(listRequest("list-first"));
    const secondList = await second.listSandboxes(listRequest("list-second"));
    expect(firstList).toMatchObject({
      ok: true,
      value: {
        sandboxes: [{ name: "first-sandbox", backend: firstReference }],
      },
    });
    expect(secondList).toMatchObject({
      ok: true,
      value: {
        sandboxes: [{ name: "second-sandbox", backend: secondReference }],
      },
    });
  });

  test("rejects backend mismatches and unsupported requirements before creation", async () => {
    const reference = { backendId: "selected", backendType: "test" } as const;
    let createCalls = 0;
    const client = new EmbeddedSandboxClient(
      createBackend(reference, ["command.start"], {
        async createSandbox(request) {
          createCalls += 1;
          return { ok: true, value: { sandbox: sandboxRecord(request, reference) } };
        },
      }),
    );

    const mismatch = await client.createSandbox(
      createRequest("mismatch", "sandbox-mismatch", "mismatch", {
        backendId: "other",
        backendType: "test",
      }),
    );
    expect(mismatch).toEqual({
      ok: false,
      error: {
        category: "invalid-request",
        code: "LOCALBOX_BACKEND_MISMATCH",
        message: "The requested backend does not match the configured backend.",
        retryable: false,
        requestId: "mismatch",
        backend: reference,
        details: {
          type: "invalid-request",
          field: "backend",
          reason: "Requested test/other; configured test/selected.",
        },
      },
    });

    const unsupported = await client.createSandbox(
      createRequest("unsupported", "sandbox-unsupported", "unsupported", null, [
        { capability: "filesystem.write", parameters: null },
        { capability: "sandbox.persistence", parameters: { durable: true } },
      ]),
    );
    expect(unsupported).toMatchObject({
      ok: false,
      error: {
        category: "unsupported-requirement",
        code: "LOCALBOX_UNSUPPORTED_REQUIREMENT",
        retryable: false,
        requestId: "unsupported",
        backend: reference,
        details: {
          type: "unsupported-requirements",
          requirements: [
            { requirement: { capability: "filesystem.write" } },
            { requirement: { capability: "sandbox.persistence" } },
          ],
        },
      },
    });
    expect(createCalls).toBe(0);
  });

  test("passes mutation identity and deadline data to the selected backend unchanged", async () => {
    const reference = { backendId: "metadata", backendType: "test" } as const;
    let received: WriteFileRequest | undefined;
    const client = new EmbeddedSandboxClient(
      createBackend(reference, ALL_CAPABILITIES, {
        async writeFile(request) {
          received = request;
          return {
            ok: true,
            value: { path: request.path, bytesWritten: 7 },
          } satisfies ClientResult<WriteFileResult>;
        },
      }),
    );
    const request = Object.freeze({
      ...writeRequest("write-request", "/workspace/value.txt"),
      deadline: Object.freeze({ expiresAt: 1_800_000_123_456 }),
    });

    const result = await client.writeFile(request);

    expect(result).toEqual({
      ok: true,
      value: { path: "/workspace/value.txt", bytesWritten: 7 },
    });
    expect(received).toBe(request);
    expect(received?.requestId).toBe("write-request");
    expect(received?.idempotencyKey).toBe("write:/workspace/value.txt");
    expect(received?.deadline).toBe(request.deadline);
  });

  test("preserves valid failures and normalizes thrown or non-JSON backend failures", async () => {
    const reference = { backendId: "errors", backendType: "test" } as const;
    const client = new EmbeddedSandboxClient(
      createBackend(reference, ALL_CAPABILITIES, {
        async writeFile(request) {
          if (request.path === "/throw") {
            const failure = new Error("backend secret");
            Object.assign(failure, { handle: new Map([["private", true]]) });
            throw failure;
          }
          if (request.path === "/invalid") {
            return {
              ok: false,
              error: {
                category: "backend-failure",
                code: "UNSAFE",
                message: "unsafe",
                retryable: false,
                requestId: request.requestId,
                backend: reference,
                details: new Error("nested secret"),
              },
            } as unknown as ClientResult<WriteFileResult>;
          }
          return {
            ok: false,
            error: {
              category: "not-found",
              code: "TEST_FILE_NOT_FOUND",
              message: "The requested file does not exist.",
              retryable: false,
              requestId: request.requestId,
              backend: reference,
              details: {
                type: "resource",
                resource: "sandbox",
                resourceId: request.sandboxId,
                path: request.path,
              },
            },
          } satisfies ClientFailure;
        },
      }),
    );

    const thrown = await client.writeFile(writeRequest("thrown", "/throw"));
    const invalid = await client.writeFile(writeRequest("invalid", "/invalid"));
    const valid = await client.writeFile(writeRequest("valid", "/missing"));

    for (const [requestId, failure] of [
      ["thrown", thrown],
      ["invalid", invalid],
    ] as const) {
      expect(failure).toEqual({
        ok: false,
        error: {
          category: "backend-failure",
          code: "LOCALBOX_BACKEND_FAILURE",
          message: "The backend failed to complete the operation.",
          retryable: false,
          requestId,
          backend: reference,
          details: { type: "backend", operation: "writeFile" },
        },
      });
      expect(JSON.stringify(failure)).not.toContain("secret");
      expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
    }
    expect(valid).toEqual({
      ok: false,
      error: {
        category: "not-found",
        code: "TEST_FILE_NOT_FOUND",
        message: "The requested file does not exist.",
        retryable: false,
        requestId: "valid",
        backend: reference,
        details: {
          type: "resource",
          resource: "sandbox",
          resourceId: "sandbox-1",
          path: "/missing",
        },
      },
    });
  });
});
