import { describe, expect, test } from "vitest";
import {
  CLOUDFLARE_NEXT_IMAGE_ALIASES,
  CLOUDFLARE_STABLE_IMAGE_ALIASES,
  FRONTEND_ARTIFACT_CONTRACTS,
  resolveFrontendBootArtifact,
} from "../../src/frontend/index.js";
import type { FrontendArtifactResolution } from "../../src/frontend/index.js";
import type { SandboxCapabilities, SnapshotBootArtifact } from "../../src/runtime/index.js";
import { TEST_CAPABILITIES } from "../fixtures/runtime-capabilities.js";

const backend = { backendId: "snapshots-local", backendType: "test" } as const;
const snapshotArtifact: SnapshotBootArtifact = {
  kind: "snapshot",
  locator: {
    type: "snapshot-id",
    snapshotId: "local-snapshot-42",
    scope: "backend",
    backend,
  },
  digest: null,
  trust: "trusted",
  mutability: "mutable",
};

function expectFailure(
  resolution: FrontendArtifactResolution,
  category: string,
  code: string,
): void {
  expect(resolution).toMatchObject({
    error: { category, code },
  });
}

describe("shared frontend artifact mappings", () => {
  test("pins every provider mapping to its assessed upstream contract", () => {
    expect(FRONTEND_ARTIFACT_CONTRACTS).toEqual({
      vercel: {
        id: "vercel@3.3.0",
        provider: "vercel",
        package: "@vercel/sandbox",
        version: "3.3.0",
      },
      cloudflareStable: {
        id: "cloudflare@0.12.9",
        provider: "cloudflare",
        package: "@cloudflare/sandbox",
        version: "0.12.9",
      },
      cloudflareNext: {
        id: "cloudflare@0.13.0-next.769.1",
        provider: "cloudflare",
        package: "@cloudflare/sandbox",
        version: "0.13.0-next.769.1",
      },
      e2b: {
        id: "e2b@2.8.0",
        provider: "e2b",
        package: "e2b",
        version: "2.8.0",
      },
      daytona: {
        id: "daytona@0.216.0",
        provider: "daytona",
        package: "@daytona/sdk",
        version: "0.216.0",
      },
    });
  });

  test("records Vercel upstream identity and the exact managed local artifact identity", () => {
    expect(resolveFrontendBootArtifact({
      contract: "vercel@3.3.0",
      runtime: "node24",
    })).toMatchObject({
      ok: true,
      artifact: {
        kind: "oci-image",
        locator: { type: "oci-reference" },
        trust: "trusted",
      },
      mapping: {
        schemaVersion: 1,
        contract: "vercel@3.3.0",
        provider: "vercel",
        upstream: { selector: "runtime", identifier: "node24" },
        local: { kind: "oci-image", trust: "trusted", provenance: "managed" },
      },
    });
  });

  test("keeps Cloudflare stable and next aliases on isolated release lines", () => {
    const stable = resolveFrontendBootArtifact({
      contract: "cloudflare@0.12.9",
      image: "python",
    });
    const next = resolveFrontendBootArtifact({
      contract: "cloudflare@0.13.0-next.769.1",
      image: "python",
    });
    expect(stable).toMatchObject({
      ok: true,
      artifact: { locator: { reference: CLOUDFLARE_STABLE_IMAGE_ALIASES.python } },
      mapping: { contract: "cloudflare@0.12.9" },
    });
    expect(next).toMatchObject({
      ok: true,
      artifact: { locator: { reference: CLOUDFLARE_NEXT_IMAGE_ALIASES.python } },
      mapping: { contract: "cloudflare@0.13.0-next.769.1" },
    });

    expectFailure(resolveFrontendBootArtifact({
      contract: "cloudflare@0.12.9",
      image: CLOUDFLARE_NEXT_IMAGE_ALIASES.default,
    }), "incompatible-contract", "FRONTEND_ARTIFACT_INCOMPATIBLE_CONTRACT");
    expectFailure(resolveFrontendBootArtifact({
      contract: "cloudflare@0.13.0-next.769.1",
      image: CLOUDFLARE_STABLE_IMAGE_ALIASES.default,
    }), "incompatible-contract", "FRONTEND_ARTIFACT_INCOMPATIBLE_CONTRACT");
  });

  test("maps only explicitly configured E2B templates to local OCI artifacts", () => {
    const localTemplate = {
      kind: "oci-image",
      locator: { type: "oci-reference", reference: "registry.example.test/e2b/python:3.11" },
      digest: null,
      trust: "trusted",
      mutability: "mutable",
      platform: null,
    } as const;
    expect(resolveFrontendBootArtifact(
      { contract: "e2b@2.8.0", template: "python-3.11" },
      { e2bTemplates: { "python-3.11": localTemplate } },
    )).toEqual({
      ok: true,
      artifact: localTemplate,
      mapping: {
        schemaVersion: 1,
        contract: "e2b@2.8.0",
        provider: "e2b",
        upstream: { selector: "template", identifier: "python-3.11", qualifiers: {} },
        local: {
          kind: "oci-image",
          identity: "registry.example.test/e2b/python:3.11",
          trust: "trusted",
          mutability: "mutable",
          digest: null,
          provenance: "configured-local",
        },
      },
    });

    expectFailure(
      resolveFrontendBootArtifact({ contract: "e2b@2.8.0", template: "ubuntu:24.04" }),
      "artifact-unavailable",
      "FRONTEND_ARTIFACT_UNAVAILABLE",
    );
  });

  test("accepts explicit OCI references only for provider contracts that permit them", () => {
    const reference = `registry.example.test/team/runtime@sha256:${"a".repeat(64)}`;
    for (const selection of [
      { contract: "vercel@3.3.0", image: reference },
      { contract: "cloudflare@0.12.9", image: reference },
      { contract: "cloudflare@0.13.0-next.769.1", image: reference },
      { contract: "daytona@0.216.0", image: reference },
    ] as const) {
      expect(resolveFrontendBootArtifact(selection)).toMatchObject({
        ok: true,
        artifact: {
          kind: "oci-image",
          locator: { reference },
          digest: { algorithm: "sha256", value: "a".repeat(64) },
          trust: "untrusted",
          mutability: "immutable",
        },
      });
    }

    expectFailure(
      resolveFrontendBootArtifact({ contract: "e2b@2.8.0", template: reference }),
      "artifact-unavailable",
      "FRONTEND_ARTIFACT_UNAVAILABLE",
    );
  });

  test("resolves Daytona snapshots only when the local artifact and backend capabilities match", () => {
    expect(resolveFrontendBootArtifact(
      {
        contract: "daytona@0.216.0",
        snapshot: "project-ready",
        language: "typescript",
      },
      {
        daytonaSnapshots: { "project-ready": snapshotArtifact },
        backend: { reference: backend, capabilities: TEST_CAPABILITIES },
      },
    )).toMatchObject({
      ok: true,
      artifact: snapshotArtifact,
      mapping: {
        upstream: {
          selector: "snapshot",
          identifier: "project-ready",
          qualifiers: { language: "typescript" },
        },
        local: {
          kind: "snapshot",
          identity: "test:snapshots-local:snapshot:local-snapshot-42",
          trust: "trusted",
          provenance: "configured-local",
        },
      },
    });

    expectFailure(
      resolveFrontendBootArtifact({ contract: "daytona@0.216.0", snapshot: "cloud-only" }),
      "artifact-unavailable",
      "FRONTEND_ARTIFACT_UNAVAILABLE",
    );
  });

  test("rejects a present Daytona snapshot when restore capability is absent", () => {
    const capabilitiesWithoutSnapshots: SandboxCapabilities = {
      ...TEST_CAPABILITIES,
      snapshots: {
        support: "unsupported",
        constraints: { operations: [] },
        diagnostic: "This backend has no local snapshot restore implementation.",
      },
    };
    expectFailure(resolveFrontendBootArtifact(
      { contract: "daytona@0.216.0", snapshot: "project-ready" },
      {
        daytonaSnapshots: { "project-ready": snapshotArtifact },
        backend: { reference: backend, capabilities: capabilitiesWithoutSnapshots },
      },
    ), "capability-mismatch", "FRONTEND_ARTIFACT_CAPABILITY_MISMATCH");
  });

  test("rejects contradictory selectors, private registries, and cloud-only builds deterministically", () => {
    expectFailure(resolveFrontendBootArtifact({
      contract: "vercel@3.3.0",
      runtime: "node24",
      image: "node:24",
    }), "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR");

    expectFailure(resolveFrontendBootArtifact({
      contract: "cloudflare@0.12.9",
      image: "default",
      dockerfile: "./Dockerfile",
    }), "invalid-selector", "FRONTEND_ARTIFACT_INVALID_SELECTOR");

    expectFailure(resolveFrontendBootArtifact({
      contract: "daytona@0.216.0",
      image: "registry.private.test/team/runtime:latest",
    }, {
      privateRegistryHosts: ["registry.private.test"],
    }), "authentication-required", "FRONTEND_ARTIFACT_AUTHENTICATION_REQUIRED");

    expectFailure(resolveFrontendBootArtifact({
      contract: "e2b@2.8.0",
      templateBuild: true,
    }), "unsupported", "FRONTEND_ARTIFACT_UNSUPPORTED");
    expectFailure(resolveFrontendBootArtifact({
      contract: "daytona@0.216.0",
      imageBuild: true,
    }), "unsupported", "FRONTEND_ARTIFACT_UNSUPPORTED");
    expectFailure(resolveFrontendBootArtifact({
      contract: "cloudflare@0.13.0-next.769.1",
      dockerfile: "./Dockerfile",
    }), "unsupported", "FRONTEND_ARTIFACT_UNSUPPORTED");
  });
});
