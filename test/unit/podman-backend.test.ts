import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type Dockerode from "dockerode";
import { afterEach, describe, expect, test } from "vitest";
import {
  PodmanBackend,
  type PodmanMode,
} from "../../src/backends/podman/index.js";
import { containerEngineContainerName } from "../../src/backends/container-engine/sandbox.js";
import { startRawCommand } from "../../src/backends/container-engine/command.js";
import { dockerStatus } from "../../src/backends/container-engine/docker.js";
import type { RawCommandEvent } from "../../src/runtime/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startPodmanService(
  mode: PodmanMode,
  engineName = "Podman Engine",
  sandboxName?: string,
): Promise<{
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
    if (sandboxName !== undefined && path.endsWith("/_ping")) {
      response.setHeader("content-type", "text/plain");
      response.end("OK");
      return;
    }
    const containerName = sandboxName === undefined
      ? undefined
      : containerEngineContainerName(sandboxName);
    if (
      containerName !== undefined &&
      path.endsWith(`/containers/${containerName}/json`)
    ) {
      const image = "example.invalid/localbox:test";
      const bootArtifact = {
        kind: "oci-image",
        locator: { type: "oci-reference", reference: image },
        digest: null,
        trust: "trusted",
        mutability: "mutable",
        platform: null,
      };
      response.end(JSON.stringify({
        Id: "podman-container",
        Created: "2026-09-22T00:00:00.000Z",
        Name: `/${containerName}`,
        Config: {
          Image: image,
          User: "ubuntu",
          WorkingDir: "/vercel",
          Env: [],
          Labels: {
            "dev.localbox.managed": "true",
            "dev.localbox.name": sandboxName,
            "dev.localbox.persistent": "false",
            "dev.localbox.image": image,
            "dev.localbox.bootArtifact": JSON.stringify(bootArtifact),
            "dev.localbox.timeout": "10000",
            "dev.localbox.created": "2026-09-22T00:00:00.000Z",
            "dev.localbox.ports": "[]",
            "dev.localbox.tags": "{}",
            "dev.localbox.failoverRegions": "[]",
          },
        },
        State: {
          Status: "running",
          Running: true,
          Paused: false,
          Restarting: false,
          OOMKilled: false,
          Dead: false,
          Pid: 1,
          ExitCode: 0,
          Error: "",
          StartedAt: "2026-09-22T00:00:01.000Z",
          FinishedAt: "0001-01-01T00:00:00Z",
        },
        HostConfig: { PortBindings: {}, NanoCpus: 0, Memory: 0 },
        NetworkSettings: { Ports: {}, Networks: {} },
      }));
      return;
    }
    if (
      containerName !== undefined &&
      request.method === "DELETE" &&
      path.includes(`/containers/${containerName}?`) &&
      path.includes("force=true")
    ) {
      response.statusCode = 204;
      response.end();
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

  test.each(["rootless", "rootful"] as const)(
    "%s ephemeral stop force-removes the container without using Podman's stop endpoint",
    async (mode) => {
      const sandboxName = `${mode}-ephemeral-stop`;
      const service = await startPodmanService(mode, "Podman Engine", sandboxName);
      const backend = new PodmanBackend({ mode, socketPath: service.socketPath });

      const result = await backend.stopSandbox({
        requestId: `${mode}-ephemeral-stop`,
        idempotencyKey: `${mode}-ephemeral-stop`,
        deadline: null,
        sandboxId: sandboxName,
      });

      expect(result).toMatchObject({
        ok: true,
        value: { sandbox: { sandboxId: sandboxName, status: "stopped" } },
      });
      expect(service.requests.some((path) =>
        path.includes(`/containers/${containerEngineContainerName(sandboxName)}?`) &&
        path.includes("force=true")
      )).toBe(true);
      expect(service.requests.some((path) => path.includes("/stop"))).toBe(false);
    },
  );

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
  test("rootful commands complete from their recorded status when Podman discards the exec session", async () => {
    const commandStream = new PassThrough();
    const statusStream = new PassThrough();
    const missing = Object.assign(new Error("exec record unavailable"), { statusCode: 404 });
    const commandExec = {
      start: () => Promise.resolve(commandStream),
      inspect: () => Promise.reject(missing),
    } as unknown as Dockerode.Exec;
    const statusExec = {
      start: () => {
        setImmediate(() => statusStream.end("143"));
        return Promise.resolve(statusStream);
      },
      inspect: () => Promise.resolve({ Running: false, ExitCode: 0 }),
    } as unknown as Dockerode.Exec;
    let execCreations = 0;
    const container = {
      exec: () => Promise.resolve(execCreations++ === 0 ? commandExec : statusExec),
    } as unknown as Dockerode.Container;
    const docker = {
      modem: {
        demuxStream(
          source: NodeJS.ReadableStream,
          stdout: NodeJS.WritableStream,
          _stderr: NodeJS.WritableStream,
        ) {
          source.pipe(stdout);
        },
      },
    } as unknown as Dockerode;
    const command = await startRawCommand(docker, container, {
      cmd: ["node", "-e", "process.exit(143)"],
      cwd: "/vercel/sandbox",
      env: [],
      execSessionNotFound: (error) => dockerStatus(error) === 404,
    });

    await expect(command.signal("SIGTERM")).resolves.toBeUndefined();

    commandStream.end("ready");
    const events: RawCommandEvent[] = [];
    for await (const event of command.events) events.push(event);

    expect(events).toMatchObject([
      { type: "stdout", data: "ready" },
      { type: "complete", exitCode: 143 },
    ]);
    expect(events).toHaveLength(2);
    expect(execCreations).toBe(2);
  });

  test("does not treat an unrecognized exec inspect 404 as command completion", async () => {
    const commandStream = new PassThrough();
    const missing = Object.assign(new Error("request not found"), { statusCode: 404 });
    const commandExec = {
      start: () => Promise.resolve(commandStream),
      inspect: () => Promise.reject(missing),
    } as unknown as Dockerode.Exec;
    const container = {
      exec: () => Promise.resolve(commandExec),
    } as unknown as Dockerode.Container;
    const docker = {
      modem: {
        demuxStream(
          source: NodeJS.ReadableStream,
          stdout: NodeJS.WritableStream,
          _stderr: NodeJS.WritableStream,
        ) {
          source.pipe(stdout);
        },
      },
    } as unknown as Dockerode;
    const command = await startRawCommand(docker, container, {
      cmd: ["node", "-e", "process.exit(1)"],
      cwd: "/vercel/sandbox",
      env: [],
    });

    commandStream.end();
    const events: RawCommandEvent[] = [];
    for await (const event of command.events) events.push(event);

    expect(events).toMatchObject([{ type: "backend-failure" }]);
    expect(events).toHaveLength(1);
  });
});
