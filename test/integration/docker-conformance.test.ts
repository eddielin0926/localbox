import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { DockerBackend } from "../../src/backends/docker/index.js";
import { EmbeddedSandboxClient } from "../../src/runtime/embedded.js";
import type { SandboxSpec } from "../../src/runtime/index.js";
import {
  registerBackendConformanceProfiles,
  type BackendConformanceHarness,
} from "../conformance/backend-profile.js";

const TARBALL_SOURCE =
  "data:application/gzip;base64,H4sIAAAAAAACA+3NQQqDMBSE4bf2FJ5AniXoeYJNIaAI8QXE05u6KXSvCP7fZobZzCeullNobDU5ixadc0cW/6n6cr/+3Vtte5Va5QJ5MZ/KvTzTMuc0hHryFlL0Y9zCuxIAAAAAAAAAAAAAAAAAwO3t6qbNcwAoAAA=";
const capabilities = new DockerBackend().capabilities;
const stateRoot = mkdtempSync(join(tmpdir(), "localbox-docker-conformance-"));

afterAll(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

const dockerHarness: BackendConformanceHarness = {
  name: "Docker through EmbeddedSandboxClient",
  capabilities,
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
    return new EmbeddedSandboxClient(new DockerBackend(), { stateRoot });
  },
  createPeerClient() {
    return new EmbeddedSandboxClient(new DockerBackend(), { stateRoot });
  },
  sandboxSpec(name, overrides = {}) {
    const base: SandboxSpec = {
      name,
      bootSource: { type: "runtime", runtime: "node24" },
      source: null,
      persistent: false,
      timeoutMs: 20_000,
      environment: {},
      tags: { suite: "backend-conformance" },
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
    return `localbox-conformance-${slug}-${randomUUID()}`;
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

registerBackendConformanceProfiles(dockerHarness);
