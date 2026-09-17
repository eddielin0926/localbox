import { describe, expect, test } from "vitest";
import { EmbeddedSandboxClient } from "../../src/runtime/index.js";
import type {
  BackendReference,
  ClientFailure,
  CreateSandboxRequest,
  RequestMetadata,
  SandboxBackend,
  SandboxCapability,
  SandboxRecord,
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
  overrides: Partial<Omit<SandboxBackend, "reference" | "capabilities" | "rawCommandCapabilities">> = {},
): SandboxBackend {
  return {
    reference,
    capabilities,
    rawCommandCapabilities: ["input", "managed-filesystem-owner"],
    createSandbox: (request) => unavailable(request, "createSandbox"),
    getSandbox: (request) => unavailable(request, "getSandbox"),
    listSandboxes: (request) => unavailable(request, "listSandboxes"),
    stopSandbox: (request) => unavailable(request, "stopSandbox"),
    deleteSandbox: (request) => unavailable(request, "deleteSandbox"),
    extendSandboxDeadline: (request) => unavailable(request, "extendSandboxDeadline"),
    startRawCommand: (request) => unavailable(request, "startRawCommand"),
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

});
