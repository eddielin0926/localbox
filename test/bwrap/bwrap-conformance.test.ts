import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { BwrapBackend } from "../../src/backends/bwrap/index.js";
import { EmbeddedSandboxClient } from "../../src/runtime/embedded.js";
import type { SandboxSpec } from "../../src/runtime/index.js";
import {
  registerBackendConformanceProfiles,
  type BackendConformanceHarness,
} from "../conformance/backend-profile.js";

const temporaryRoot = mkdtempSync(join(tmpdir(), "localbox-bwrap-conformance-"));
const backendRoot = join(temporaryRoot, "backend");
const stateRoot = join(temporaryRoot, "state");
const instanceId = "conformance";
const capabilities = new BwrapBackend({ root: backendRoot, instanceId }).capabilities;

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

const bwrapHarness: BackendConformanceHarness = {
  name: "Bubblewrap through EmbeddedSandboxClient",
  capabilities,
  createClient() {
    return new EmbeddedSandboxClient(
      new BwrapBackend({ root: backendRoot, instanceId }),
      { stateRoot },
    );
  },
  createPeerClient() {
    return new EmbeddedSandboxClient(
      new BwrapBackend({ root: backendRoot, instanceId }),
      { stateRoot },
    );
  },
  sandboxSpec(name, overrides = {}) {
    const base: SandboxSpec = {
      name,
      bootArtifact: {
        kind: "host",
        locator: { type: "host", selector: "current" },
        trust: "trusted",
        mutability: "mutable",
      },
      frontendMetadata: null,
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
    return `localbox-bwrap-${slug}-${randomUUID()}`;
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

registerBackendConformanceProfiles(bwrapHarness);
