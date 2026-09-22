import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  PodmanBackend,
  type PodmanMode,
} from "../../src/backends/podman/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startPodmanService(mode: PodmanMode, engineName = "Podman Engine"): Promise<{
  readonly socketPath: string;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "localbox-podman-api-"));
  const socketPath = join(root, "podman.sock");
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    response.setHeader("content-type", "application/json");
    if (path.endsWith("/version")) {
      response.end(JSON.stringify({
        Platform: { Name: engineName },
        Version: "5.4.2",
        ApiVersion: "1.41",
      }));
      return;
    }
    if (path.endsWith("/info")) {
      response.end(JSON.stringify({
        SecurityOptions: mode === "rootless"
          ? ["name=seccomp", "name=rootless"]
          : ["name=seccomp"],
      }));
      return;
    }
    response.statusCode = 500;
    response.end(JSON.stringify({ message: `Unexpected API request ${path}` }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    await rm(root, { recursive: true, force: true });
  };
  cleanups.push(close);
  return { socketPath, requests, close };
}

describe("PodmanBackend", () => {
  test.each(["rootless", "rootful"] as const)(
    "detects an available %s service without allocating a sandbox",
    async (mode) => {
      const service = await startPodmanService(mode);
      const backend = new PodmanBackend({ mode, socketPath: service.socketPath });
      const result = await backend.probeAvailability({
        requestId: `probe-${mode}`,
        deadline: { expiresAt: Date.now() + 5_000 },
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          availability: {
            backend: { backendId: `local-podman-${mode}`, backendType: "podman" },
            status: "available",
            diagnostics: [{
              code: "PODMAN_SERVICE_AVAILABLE",
              details: { type: "podman-service", reason: "available", mode },
            }],
          },
        },
      });
      expect(service.requests).toHaveLength(2);
      expect(service.requests.every((path) =>
        path.endsWith("/info") || path.endsWith("/version")
      )).toBe(true);
    },
  );

  test("fails availability when the configured capability mode differs from the service", async () => {
    const service = await startPodmanService("rootful");
    const backend = new PodmanBackend({ mode: "rootless", socketPath: service.socketPath });
    const result = await backend.probeAvailability({
      requestId: "probe-mode-mismatch",
      deadline: null,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        availability: {
          status: "unavailable",
          diagnostics: [{
            code: "PODMAN_MODE_MISMATCH",
            details: {
              type: "podman-service",
              reason: "mode-mismatch",
              mode: "rootful",
            },
          }],
        },
      },
    });
  });

  test("rejects a non-Podman Docker-compatible endpoint", async () => {
    const service = await startPodmanService("rootful", "Docker Engine");
    const backend = new PodmanBackend({ mode: "rootful", socketPath: service.socketPath });
    const result = await backend.probeAvailability({
      requestId: "probe-engine-mismatch",
      deadline: null,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        availability: {
          status: "unavailable",
          diagnostics: [{
            code: "PODMAN_ENGINE_MISMATCH",
            details: {
              type: "podman-service",
              reason: "engine-mismatch",
              mode: null,
            },
          }],
        },
      },
    });
  });

  test("rootless rejects hard resource guarantees before contacting Podman", async () => {
    const backend = new PodmanBackend({
      mode: "rootless",
      socketPath: join(tmpdir(), "localbox-podman-must-not-connect.sock"),
    });
    const result = await backend.createSandbox({
      requestId: "rootless-resource-create",
      idempotencyKey: "rootless-resource-create",
      deadline: null,
      sandboxId: "rootless-resource-create",
      backend: null,
      requirements: [],
      spec: {
        name: "rootless-resource-create",
        bootArtifact: {
          kind: "oci-image",
          locator: { type: "oci-reference", reference: "example.invalid/localbox:test" },
          digest: null,
          trust: "trusted",
          mutability: "mutable",
          platform: null,
        },
        frontendMetadata: null,
        source: null,
        persistent: false,
        timeoutMs: 10_000,
        environment: {},
        tags: {},
        ports: [],
        networkPolicy: "allow-all",
        resources: { vcpus: 1, memoryBytes: 2_147_483_648 },
        region: null,
        failoverRegions: [],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        category: "failed-precondition",
        code: "LOCALBOX_UNSUPPORTED_CAPABILITY",
        backend: { backendId: "local-podman-rootless", backendType: "podman" },
      },
    });
  });
});
