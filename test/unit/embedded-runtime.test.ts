import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EmbeddedSandboxClient } from "../../src/runtime/index.js";
import type {
  BackendReference,
  ClientFailure,
  CreateSandboxRequest,
  RequestMetadata,
  SandboxBackend,
  SandboxCapabilities,
  SandboxRecord,
} from "../../src/runtime/index.js";
import {
  TEST_CAPABILITIES,
  TEST_OCI_ARTIFACT,
  testCapabilitiesWithOperationSupport,
} from "../fixtures/runtime-capabilities.js";


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
  capabilities: SandboxCapabilities = TEST_CAPABILITIES,
  overrides: Partial<Omit<SandboxBackend, "reference" | "capabilities">> = {},
): SandboxBackend {
  return {
    reference,
    capabilities,
    probeAvailability: () => Promise.resolve({
      ok: true,
      value: {
        availability: {
          schemaVersion: 1,
          backend: reference,
          status: "available",
          checkedAt: 1_700_000_000_000,
          diagnostics: [{
            code: "PROCESS_PREREQUISITES_AVAILABLE",
            severity: "info",
            message: "Test backend prerequisites are available.",
            action: "No action is required.",
            details: { type: "process-runtime", prerequisite: "node-executable" },
          }],
        },
      },
    }),
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
      bootArtifact: TEST_OCI_ARTIFACT,
      frontendMetadata: {
        type: "vercel",
        image: TEST_OCI_ARTIFACT.locator.reference,
        runtime: "node24",
      },
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
    bootArtifact: request.spec.bootArtifact,
    frontendMetadata: request.spec.frontendMetadata,
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
  return createBackend(reference, TEST_CAPABILITIES, {
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
    const stateRoot = await mkdtemp(join(tmpdir(), "localbox-embedded-runtime-"));
    try {
      const firstReference = { backendId: "first", backendType: "memory" } as const;
      const secondReference = { backendId: "second", backendType: "memory" } as const;
      const first = new EmbeddedSandboxClient(createMemoryBackend(firstReference), { stateRoot });
      const second = new EmbeddedSandboxClient(createMemoryBackend(secondReference), { stateRoot });

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
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects backend mismatches and unsupported requirements before creation", async () => {
    const reference = { backendId: "selected", backendType: "test" } as const;
    let createCalls = 0;
    let rawCommandCalls = 0;
    const operationCapabilities = testCapabilitiesWithOperationSupport({
      "filesystem.write": "unsupported",
    });
    const capabilities: SandboxCapabilities = {
      ...operationCapabilities,
      persistence: {
        support: "unsupported",
        constraints: { scopes: [] },
        diagnostic: "This test backend cannot preserve stopped sandboxes.",
      },
    };
    const client = new EmbeddedSandboxClient(
      createBackend(reference, capabilities, {
        async createSandbox(request) {
          createCalls += 1;
          return { ok: true, value: { sandbox: sandboxRecord(request, reference) } };
        },
        async startRawCommand(request) {
          rawCommandCalls += 1;
          return unavailable(request, "startRawCommand");
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
        {
          type: "operation",
          operation: "filesystem.write",
          acceptableSupport: ["native", "emulated", "partial"],
        },
        {
          type: "persistence",
          scope: "sandbox-lifecycle",
          acceptableSupport: ["native", "emulated", "partial"],
        },
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
          type: "requirement-negotiation",
          issues: [
            {
              kind: "unsupported",
              requirement: { type: "operation", operation: "filesystem.write" },
              backendDiagnostic: "Test backend writes files.",
            },
            {
              kind: "unsupported",
              requirement: { type: "persistence", scope: "sandbox-lifecycle" },
              backendDiagnostic: "This test backend cannot preserve stopped sandboxes.",
            },
          ],
        },
      },
    });
    const retried = await client.createSandbox({
      ...createRequest("unsupported-retry", "sandbox-unsupported", "unsupported", null, [
        {
          type: "operation",
          operation: "filesystem.write",
          acceptableSupport: ["native", "emulated", "partial"],
        },
        {
          type: "persistence",
          scope: "sandbox-lifecycle",
          acceptableSupport: ["native", "emulated", "partial"],
        },
      ]),
      idempotencyKey: "create:sandbox-unsupported",
    });
    expect(retried).toMatchObject({
      ok: false,
      error: {
        requestId: "unsupported-retry",
        details: { type: "requirement-negotiation", issues: unsupported.ok ? [] : unsupported.error.details.type === "requirement-negotiation" ? unsupported.error.details.issues : [] },
      },
    });
    expect(rawCommandCalls).toBe(0);
    const malformed = await client.createSandbox(
      createRequest(
        "malformed",
        "sandbox-malformed",
        "malformed",
        null,
        [
          {
            type: "future-requirement",
            acceptableSupport: ["native"],
          },
        ] as unknown as CreateSandboxRequest["requirements"],
      ),
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: {
        category: "invalid-request",
        code: "LOCALBOX_INVALID_REQUIREMENT",
        details: {
          type: "requirement-negotiation",
          issues: [{ index: 0, kind: "unknown" }],
        },
      },
    });
    expect(rawCommandCalls).toBe(0);
    expect(createCalls).toBe(0);
  });

  test("derives the boot artifact requirement and rejects conflicts before state or backend allocation", async () => {
    const reference = { backendId: "artifact-only-host", backendType: "test" } as const;
    let createCalls = 0;
    const capabilities: SandboxCapabilities = {
      ...TEST_CAPABILITIES,
      artifacts: {
        support: "partial",
        constraints: { kinds: ["host"] },
        diagnostic: "This backend accepts only current-host artifacts.",
      },
    };
    const client = new EmbeddedSandboxClient(createBackend(reference, capabilities, {
      async createSandbox(request) {
        createCalls += 1;
        return { ok: true, value: { sandbox: sandboxRecord(request, reference) } };
      },
    }));

    const omitted = await client.createSandbox(
      createRequest("derived-artifact", "derived-artifact", "derived-artifact"),
    );
    expect(omitted).toMatchObject({
      ok: false,
      error: {
        category: "unsupported-requirement",
        details: {
          type: "requirement-negotiation",
          issues: [{
            requirement: { type: "artifacts", kinds: ["oci-image"] },
          }],
        },
      },
    });

    const conflicting = await client.createSandbox(
      createRequest("conflicting-artifact", "conflicting-artifact", "conflicting-artifact", null, [{
        type: "artifacts",
        kinds: ["host"],
        acceptableSupport: ["partial"],
      }]),
    );
    expect(conflicting).toMatchObject({
      ok: false,
      error: {
        category: "invalid-request",
        details: {
          type: "requirement-negotiation",
          issues: [{ index: 0, kind: "conflict" }],
        },
      },
    });

    const unknown = createRequest("unknown-artifact", "unknown-artifact", "unknown-artifact");
    (unknown.spec as unknown as Record<string, unknown>).bootArtifact = {
      kind: "future-artifact",
      locator: {},
      trust: "trusted",
      mutability: "mutable",
    };
    expect(await client.createSandbox(unknown)).toMatchObject({
      ok: false,
      error: {
        category: "invalid-request",
        details: { type: "invalid-request", field: "spec.bootArtifact.kind" },
      },
    });
    expect(createCalls).toBe(0);
  });

  test("validates availability identity, diagnostics, deadlines, and thrown failures", async () => {
    const reference = { backendId: "probe", backendType: "test" } as const;
    const valid = new EmbeddedSandboxClient(createBackend(reference));
    expect(await valid.probeAvailability({
      requestId: "probe-valid",
      deadline: null,
    })).toMatchObject({
      ok: true,
      value: {
        availability: {
          backend: reference,
          status: "available",
          diagnostics: [{ code: "PROCESS_PREREQUISITES_AVAILABLE" }],
        },
      },
    });

    const wrongIdentity = new EmbeddedSandboxClient(createBackend(reference, TEST_CAPABILITIES, {
      probeAvailability: () => Promise.resolve({
        ok: true,
        value: {
          availability: {
            schemaVersion: 1,
            backend: { backendId: "other", backendType: "test" },
            status: "available",
            checkedAt: 1,
            diagnostics: [{
              code: "PROCESS_PREREQUISITES_AVAILABLE",
              severity: "info",
              message: "Available.",
              action: "No action.",
              details: { type: "process-runtime", prerequisite: "node-executable" },
            }],
          },
        },
      }),
    }));
    expect(await wrongIdentity.probeAvailability({
      requestId: "probe-wrong-identity",
      deadline: null,
    })).toMatchObject({ ok: false, error: { code: "LOCALBOX_BACKEND_FAILURE" } });

    const malformed = new EmbeddedSandboxClient(createBackend(reference, TEST_CAPABILITIES, {
      probeAvailability: () => Promise.resolve({
        ok: true,
        value: {
          availability: {
            schemaVersion: 1,
            backend: reference,
            status: "available",
            checkedAt: 1,
            diagnostics: [{
              code: "FUTURE_DIAGNOSTIC",
              severity: "info",
              message: "Unknown.",
              action: "No action.",
              details: { type: "process-runtime", prerequisite: "node-executable" },
            }],
          },
        },
      } as never),
    }));
    expect(await malformed.probeAvailability({
      requestId: "probe-malformed",
      deadline: null,
    })).toMatchObject({ ok: false, error: { code: "LOCALBOX_BACKEND_FAILURE" } });

    let deadlineCalls = 0;
    const deadline = new EmbeddedSandboxClient(createBackend(reference, TEST_CAPABILITIES, {
      probeAvailability: () => {
        deadlineCalls += 1;
        return Promise.withResolvers<never>().promise;
      },
    }));
    expect(await deadline.probeAvailability({
      requestId: "probe-expired",
      deadline: { expiresAt: 0 },
    })).toMatchObject({
      ok: false,
      error: { category: "deadline-exceeded", code: "LOCALBOX_DEADLINE_EXCEEDED" },
    });
    expect(deadlineCalls).toBe(0);

    const thrown = new EmbeddedSandboxClient(createBackend(reference, TEST_CAPABILITIES, {
      probeAvailability: () => Promise.reject(new Error("credential=secret")),
    }));
    const failure = await thrown.probeAvailability({
      requestId: "probe-thrown",
      deadline: null,
    });
    expect(failure).toMatchObject({
      ok: false,
      error: { category: "backend-failure", code: "LOCALBOX_BACKEND_FAILURE" },
    });
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

});
