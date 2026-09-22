import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe } from "vitest";
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
const stateRoot = mkdtempSync(join(tmpdir(), "localbox-podman-conformance-"));

afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe.skipIf(socketPath === undefined)("configured Podman service", () => {
  const createBackend = (): PodmanBackend => new PodmanBackend({ mode, socketPath: podmanSocketPath });
  const podmanHarness: BackendConformanceHarness = {
    name: `Podman ${mode} through EmbeddedSandboxClient`,
    capabilities: createBackend().capabilities,
    sourceFixtures: {
      git: {
        type: "git",
        url: "https://github.com/octocat/Hello-World.git",
        revision: null,
        depth: 1,
        credentials: null,
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
