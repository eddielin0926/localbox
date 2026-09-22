import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe } from "vitest";
import { MANAGED_IMAGES } from "../../src/backends/docker/index.js";
import {
  PodmanBackend,
  type PodmanMode,
} from "../../src/backends/podman/index.js";
import { EmbeddedSandboxClient } from "../../src/runtime/embedded.js";
import type { SandboxSpec } from "../../src/runtime/index.js";
import {
  registerBackendConformanceProfiles,
  type BackendConformanceHarness,
} from "../conformance/backend-profile.js";

const socketPath = process.env.LOCALBOX_PODMAN_SOCKET;
const podmanSocketPath = socketPath ?? "/run/localbox/unconfigured-podman.sock";
const configuredMode = process.env.LOCALBOX_PODMAN_MODE ?? "rootless";
if (configuredMode !== "rootless" && configuredMode !== "rootful") {
  throw new Error("LOCALBOX_PODMAN_MODE must be rootless or rootful.");
}
const mode = configuredMode as PodmanMode;
const TARBALL_SOURCE =
  "data:application/gzip;base64,H4sIAAAAAAACA+3NQQqDMBSE4bf2FJ5AniXoeYJNIaAI8QXE05u6KXSvCP7fZobZzCeullNobDU5ixadc0cW/6n6cr/+3Vtte5Va5QJ5MZ/KvTzTMuc0hHryFlL0Y9zCuxIAAAAAAAAAAAAAAAAAwO3t6qbNcwAoAAA=";
const temporaryRoot = mkdtempSync(join(tmpdir(), "localbox-podman-conformance-"));
const stateRoot = join(temporaryRoot, "state");
const gitWorktree = join(temporaryRoot, "git-worktree");
const gitRepository = join(temporaryRoot, "fixture.git");
let gitDaemon: ChildProcess | undefined;
let gitDaemonClosed: Promise<void> | undefined;
let gitDaemonError: Error | undefined;
let gitSourceUrl: string | undefined;

async function allocateTcpPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const address = server.address();
  const closed = once(server, "close");
  server.close();
  await closed;
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate a TCP port for the Git fixture.");
  }
  return address.port;
}

function closeOnly(child: ChildProcess): Promise<void> {
  const closed = Promise.withResolvers<void>();
  child.once("close", () => closed.resolve());
  return closed.promise;
}

async function startGitDaemon(): Promise<{
  readonly daemon: ChildProcess;
  readonly closed: Promise<void>;
  readonly port: number;
}> {
  const failures: string[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await allocateTcpPort();
    const daemon = spawn(
      "git",
      [
        "daemon",
        "--verbose",
        "--reuseaddr",
        `--base-path=${temporaryRoot}`,
        "--strict-paths",
        "--export-all",
        "--listen=0.0.0.0",
        `--port=${port}`,
        "--enable=upload-pack",
        "--disable=upload-archive",
        "--disable=receive-pack",
        gitRepository,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const closed = closeOnly(daemon);
    const ready = Promise.withResolvers<void>();
    let output = "";
    daemon.once("error", (error) => {
      if (gitDaemon === daemon) gitDaemonError = error;
      ready.reject(error);
    });
    daemon.once("close", (code, signal) => {
      const detail = output.trim() || `exit code ${code ?? signal}`;
      ready.reject(new Error(`Git fixture daemon exited before ready: ${detail}`));
    });
    daemon.stderr?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-4096);
      if (output.includes("Ready to rumble")) ready.resolve();
    });
    try {
      await ready.promise;
      return { daemon, closed, port };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill("SIGTERM");
      }
      await closed;
    }
  }
  throw new Error(`Git fixture daemon failed to start: ${failures.join("; ")}`);
}

beforeAll(async () => {
  if (socketPath === undefined) return;

  execFileSync("git", ["init", "--quiet", "--initial-branch=main", gitWorktree]);
  writeFileSync(
    join(gitWorktree, "README"),
    "Localbox Podman conformance Git fixture.\n",
  );
  execFileSync("git", [
    "-C",
    gitWorktree,
    "-c",
    "core.autocrlf=false",
    "add",
    "README",
  ]);
  execFileSync(
    "git",
    [
      "-C",
      gitWorktree,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Localbox Conformance",
      "-c",
      "user.email=conformance@localbox.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "Create fixture",
    ],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    },
  );
  execFileSync("git", ["clone", "--quiet", "--bare", gitWorktree, gitRepository]);

  const fixture = await startGitDaemon();
  gitDaemon = fixture.daemon;
  gitDaemonClosed = fixture.closed;
  gitSourceUrl =
    `git://host.containers.internal:${fixture.port}/fixture.git`;
});

afterAll(async () => {
  try {
    if (
      gitDaemon !== undefined &&
      gitDaemon.exitCode === null &&
      gitDaemon.signalCode === null
    ) {
      gitDaemon.kill("SIGTERM");
    }
    await gitDaemonClosed;
    if (gitDaemonError !== undefined) throw gitDaemonError;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe.skipIf(socketPath === undefined)("configured Podman service", () => {
  const createBackend = (): PodmanBackend => new PodmanBackend({ mode, socketPath: podmanSocketPath });
  const podmanHarness: BackendConformanceHarness = {
    name: `Podman ${mode} through EmbeddedSandboxClient`,
    capabilities: createBackend().capabilities,
    sourceFixtures: {
      get git() {
        if (gitSourceUrl === undefined) {
          throw new Error("Podman Git fixture daemon has not started.");
        }
        return {
          type: "git",
          url: gitSourceUrl,
          revision: null,
          depth: 1,
          credentials: null,
        } as const;
      },
      tarball: { type: "tarball", url: TARBALL_SOURCE },
    },
    createClient() {
      return new EmbeddedSandboxClient(createBackend(), { stateRoot });
    },
    createPeerClient() {
      return new EmbeddedSandboxClient(createBackend(), { stateRoot });
    },
    sandboxSpec(name, overrides = {}) {
      const base: SandboxSpec = {
        name,
        bootArtifact: {
          kind: "oci-image",
          locator: { type: "oci-reference", reference: MANAGED_IMAGES.node24 },
          digest: null,
          trust: "trusted",
          mutability: "mutable",
          platform: null,
        },
        frontendMetadata: {
          type: "vercel",
          image: MANAGED_IMAGES.node24,
          runtime: "node24",
        },
        source: null,
        persistent: false,
        timeoutMs: 20_000,
        environment: {},
        tags: { suite: "backend-conformance", engine: "podman" },
        ports: [],
        networkPolicy: "allow-all",
        resources: { vcpus: null, memoryBytes: null },
        region: null,
        failoverRegions: [],
      };
      return {
        ...base,
        ...overrides,
        name,
        resources: overrides.resources ?? base.resources,
      };
    },
    uniqueSandboxName(profile) {
      const slug = profile.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 32);
      return `localbox-podman-${slug}-${randomUUID()}`;
    },
    async cleanup(client, sandboxId) {
      const result = await client.deleteSandbox({
        requestId: `cleanup:${sandboxId}:${randomUUID()}`,
        idempotencyKey: `cleanup:${sandboxId}:${randomUUID()}`,
        deadline: { expiresAt: Date.now() + 10_000 },
        sandboxId,
      });
      if (!result.ok && result.error.category !== "not-found") {
        throw new Error(`Cleanup failed for ${sandboxId}: ${result.error.message}`);
      }
    },
  };

  registerBackendConformanceProfiles(podmanHarness);
});
