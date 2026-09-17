import { describe, expect, test } from "vitest";
import type {
  ClientFailure,
  ClientSuccess,
  CreateSandboxRequest,
  CreateSandboxResult,
  JsonValue,
  ReadCommandOutputResult,
  ReadFileResult,
  SignalProcessRequest,
  UnsupportedRequirementDetails,
  WriteFileRequest,
} from "../../src/runtime/index.js";

function expectJsonRoundTrip(value: JsonValue): void {
  const encoded = JSON.stringify(value);
  const decoded = JSON.parse(encoded) as JsonValue;
  expect(decoded).toEqual(value);

  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || current === undefined) continue;
    expect(typeof current).not.toBe("bigint");
    expect(typeof current).not.toBe("function");
    expect(typeof current).not.toBe("symbol");
    expect(current).not.toBeInstanceOf(Date);
    expect(current).not.toBeInstanceOf(Error);
    expect(Buffer.isBuffer(current)).toBe(false);
    expect(current).not.toBeInstanceOf(Uint8Array);
    expect(current).not.toBeInstanceOf(Map);
    expect(current).not.toBeInstanceOf(Set);
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (typeof current === "object") {
      expect(Object.getPrototypeOf(current)).toBe(Object.prototype);
      pending.push(...Object.values(current));
    }
  }
}

const backend = {
  backendId: "docker-local",
  backendType: "docker",
} as const;

const createRequest = {
  requestId: "req-create-1",
  idempotencyKey: "create-sandbox-1",
  deadline: { expiresAt: 1_800_000_000_000 },
  sandboxId: "sandbox-1",
  backend,
  requirements: [
    { capability: "command.start", parameters: null },
    { capability: "filesystem.read", parameters: null },
    { capability: "filesystem.write", parameters: null },
    { capability: "filesystem.mkdir", parameters: null },
    { capability: "endpoint.expose", parameters: { ports: [3000] } },
  ],
  spec: {
    name: "example",
    bootSource: { type: "runtime", runtime: "node24" },
    source: { type: "tarball", url: "https://example.test/source.tar.gz" },
    persistent: true,
    timeoutMs: 300_000,
    environment: { NODE_ENV: "development" },
    tags: { owner: "contract-test" },
    ports: [3000],
    networkPolicy: "allow-all",
    resources: { vcpus: 1, memoryBytes: 2_147_483_648 },
    region: "local",
    failoverRegions: [],
  },
} as const satisfies CreateSandboxRequest;

const createSuccess = {
  ok: true,
  value: {
    sandbox: {
      sandboxId: "sandbox-1",
      name: "example",
      status: "running",
      persistent: true,
      bootSource: { type: "image", image: "ghcr.io/example/node24:resolved" },
      runtime: "node24",
      backend,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      statusUpdatedAt: 1_700_000_001_000,
      expiresAt: 1_700_000_300_000,
      timeoutMs: 300_000,
      tags: { owner: "contract-test" },
      ports: [3000],
      endpoints: [{
        endpointId: "sandbox-1:3000",
        sandboxId: "sandbox-1",
        port: 3000,
        protocol: "http",
        url: "http://127.0.0.1:49152",
        visibility: "loopback",
        backend,
      }],
      resources: { vcpus: 1, memoryBytes: 2_147_483_648 },
      region: "local",
      failoverRegions: [],
    },
  },
} as const satisfies ClientSuccess<CreateSandboxResult>;

const outputResult = {
  chunks: [
    { stream: "stdout", data: "ready\n" },
    { stream: "stderr", data: "warning\n" },
  ],
  nextCursor: "output-2",
  complete: false,
  truncated: false,
} as const satisfies ReadCommandOutputResult;
const signalRequest = {
  requestId: "req-signal-1",
  idempotencyKey: "signal-process-1",
  deadline: { expiresAt: 1_800_000_000_000 },
  sandboxId: "sandbox-1",
  processId: "process-1",
  signal: "SIGTERM",
} as const satisfies SignalProcessRequest;


const writeRequest = {
  requestId: "req-write-1",
  idempotencyKey: "write-file-1",
  deadline: null,
  sandboxId: "sandbox-1",
  path: "/vercel/sandbox/blob.bin",
  content: { encoding: "base64", data: "AP8B" },
  mode: 0o600,
} as const satisfies WriteFileRequest;

const readResult = {
  path: "/vercel/sandbox/blob.bin",
  content: { encoding: "base64", data: "AP8B" },
  bytesRead: 3,
  nextOffset: 3,
  endOfFile: true,
} as const satisfies ReadFileResult;

const unsupportedFailure = {
  ok: false,
  error: {
    category: "unsupported-requirement",
    code: "LOCALBOX_UNSUPPORTED_REQUIREMENT",
    message: "The selected backend cannot satisfy all sandbox requirements.",
    retryable: false,
    requestId: "req-create-2",
    backend,
    details: {
      type: "unsupported-requirements",
      requirements: [
        {
          requirement: {
            capability: "sandbox.network.deny-all",
            parameters: null,
          },
          reason: "This backend cannot isolate outbound networking.",
        },
      ],
    } satisfies UnsupportedRequirementDetails,
  },
} as const satisfies ClientFailure;

describe("runtime transport contract", () => {
  test("representative requests and results survive JSON round trips", () => {
    for (const value of [
      createRequest,
      createSuccess,
      outputResult,
      signalRequest,
      writeRequest,
      readResult,
    ] satisfies readonly JsonValue[]) {
      expectJsonRoundTrip(value);
    }
  });

  test("unsupported requirements retain their stable category and structured details", () => {
    expectJsonRoundTrip(unsupportedFailure);
    const decoded = JSON.parse(JSON.stringify(unsupportedFailure)) as ClientFailure;

    expect(decoded.error.category).toBe("unsupported-requirement");
    expect(decoded.error.code).toBe("LOCALBOX_UNSUPPORTED_REQUIREMENT");
    expect(decoded.error.details).toEqual(unsupportedFailure.error.details);
    expect(decoded.error.retryable).toBe(false);
  });
});
