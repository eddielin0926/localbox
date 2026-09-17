import { describe, expect, test } from "vitest";
import {
  negotiateSandboxRequirements,
} from "../../src/runtime/index.js";
import type {
  CapabilitySupport,
  SandboxCapabilities,
  SandboxRequirement,
} from "../../src/runtime/index.js";
import { backendCapabilityCoverage } from "../conformance/backend-profile.js";
import {
  TEST_CAPABILITIES,
  testCapabilitiesWithOperationSupport,
} from "../fixtures/runtime-capabilities.js";

const ACCEPT_SUPPORTED = ["native", "emulated", "partial"] as const;

function commandRequirement(acceptableSupport: readonly Exclude<CapabilitySupport, "unsupported">[]): SandboxRequirement {
  return {
    type: "operation",
    operation: "command.start",
    acceptableSupport,
  };
}

describe("sandbox capability negotiation", () => {
  test("keeps native, emulated, partial, and unsupported support classifications distinct", () => {
    for (const support of ["native", "emulated", "partial"] as const) {
      const capabilities = testCapabilitiesWithOperationSupport({ "command.start": support });
      expect(negotiateSandboxRequirements(capabilities, [commandRequirement([support])])).toEqual([]);
      const other = support === "native" ? "emulated" : "native";
      expect(negotiateSandboxRequirements(capabilities, [commandRequirement([other])])).toMatchObject([
        { index: 0, kind: "unsupported", requirement: { type: "operation" } },
      ]);
    }

    const unsupported = testCapabilitiesWithOperationSupport({ "command.start": "unsupported" });
    expect(negotiateSandboxRequirements(unsupported, [commandRequirement(ACCEPT_SUPPORTED)])).toEqual([
      {
        index: 0,
        kind: "unsupported",
        requirement: commandRequirement(ACCEPT_SUPPORTED),
        reason: "The backend explicitly classifies this capability as unsupported.",
        backendDiagnostic: "Test backend starts commands.",
      },
    ]);
  });

  test("rejects stronger isolation and unavailable artifact, network, and resource constraints in request order", () => {
    const capabilities: SandboxCapabilities = {
      ...TEST_CAPABILITIES,
      isolation: {
        support: "partial",
        constraints: { level: "shared-kernel-container", tenancies: ["trusted", "single-tenant"] },
        diagnostic: "Shared-kernel test isolation is not a VM or multi-tenant boundary.",
      },
      artifacts: {
        support: "partial",
        constraints: { kinds: ["host", "oci-image"] },
        diagnostic: "This test backend accepts host and OCI image artifacts only.",
      },
      networking: {
        support: "partial",
        constraints: { modes: ["allow-all"], portExposure: ["loopback"], customPolicies: false },
        diagnostic: "This test backend has no deny-all or custom network policy.",
      },
      resources: {
        support: "partial",
        constraints: {
          cpu: { minimumVcpus: 1, maximumVcpus: 4, stepVcpus: 1 },
          memory: { minimumBytes: 2_147_483_648, maximumBytes: 8_589_934_592, stepBytes: 2_147_483_648 },
          memoryBytesPerVcpu: 2_147_483_648,
          enforcement: "hard",
        },
        diagnostic: "This test backend couples memory to CPU and supports at most four vCPUs.",
      },
    };
    const requirements = [
      {
        type: "isolation",
        minimumLevel: "virtual-machine",
        tenancy: "multi-tenant",
        acceptableSupport: ACCEPT_SUPPORTED,
      },
      {
        type: "artifacts",
        kinds: ["snapshot"],
        acceptableSupport: ACCEPT_SUPPORTED,
      },
      {
        type: "networking",
        mode: "deny-all",
        portExposure: "public",
        customPolicy: true,
        acceptableSupport: ACCEPT_SUPPORTED,
      },
      {
        type: "resources",
        vcpus: 6,
        memoryBytes: 8_589_934_592,
        enforcement: "hard",
        acceptableSupport: ACCEPT_SUPPORTED,
      },
    ] as const satisfies readonly SandboxRequirement[];

    const result = negotiateSandboxRequirements(capabilities, requirements);
    expect(result.map(({ index, kind, backendDiagnostic }) => ({ index, kind, backendDiagnostic }))).toEqual([
      { index: 0, kind: "constraint", backendDiagnostic: capabilities.isolation.diagnostic },
      { index: 1, kind: "constraint", backendDiagnostic: capabilities.artifacts.diagnostic },
      { index: 2, kind: "constraint", backendDiagnostic: capabilities.networking.diagnostic },
      { index: 3, kind: "constraint", backendDiagnostic: capabilities.resources.diagnostic },
    ]);
    expect(result[0]?.reason).toContain("requires isolation level virtual-machine");
    expect(result[2]?.reason).toContain("does not enforce custom network policies");
    expect(result[3]?.reason).toContain("cannot satisfy 6 vCPUs");
  });

  test("accepts values inside partial bounds and rejects coupled resource values outside them", () => {
    const capabilities: SandboxCapabilities = {
      ...TEST_CAPABILITIES,
      resources: {
        support: "partial",
        constraints: {
          cpu: { minimumVcpus: 1, maximumVcpus: 4, stepVcpus: 1 },
          memory: { minimumBytes: 2_147_483_648, maximumBytes: 8_589_934_592, stepBytes: 2_147_483_648 },
          memoryBytesPerVcpu: 2_147_483_648,
          enforcement: "hard",
        },
        diagnostic: "Memory is fixed at 2 GiB per vCPU.",
      },
    };
    const withinBounds = {
      type: "resources",
      vcpus: 2,
      memoryBytes: 4_294_967_296,
      enforcement: "hard",
      acceptableSupport: ["partial"],
    } as const satisfies SandboxRequirement;
    const outsideCoupling = {
      ...withinBounds,
      memoryBytes: 6_442_450_944,
    } as const satisfies SandboxRequirement;

    expect(negotiateSandboxRequirements(capabilities, [withinBounds])).toEqual([]);
    expect(negotiateSandboxRequirements(capabilities, [outsideCoupling])).toMatchObject([
      { index: 0, kind: "constraint", reason: expect.stringContaining("memory bytes per vCPU") },
    ]);
  });

  test("rejects unknown, malformed, duplicate, and conflicting requirements deterministically", () => {
    const first = commandRequirement(["native"]);
    const requirements: unknown = [
      { type: "future-domain", acceptableSupport: ["native"] },
      { type: "operation", operation: "command.start", acceptableSupport: [] },
      first,
      first,
      commandRequirement(["emulated"]),
    ];

    const expected = ["unknown", "malformed", "duplicate", "conflict"];
    const initial = negotiateSandboxRequirements(TEST_CAPABILITIES, requirements);
    expect(initial.map(({ kind }) => kind)).toEqual(expected);
    expect(initial.map(({ index }) => index)).toEqual([0, 1, 3, 4]);
    expect(negotiateSandboxRequirements(TEST_CAPABILITIES, requirements)).toEqual(initial);
  });

  test("reports unknown advertised entries and missing profile coverage keys", () => {
    const operations = {
      ...TEST_CAPABILITIES.operations,
      "future.operation": {
        support: "native",
        constraints: null,
        diagnostic: "Future operation.",
      },
    };
    delete (operations as Partial<typeof operations>)["filesystem.read"];
    const capabilities = {
      ...TEST_CAPABILITIES,
      operations,
      futureDomain: {
        support: "native",
        constraints: {},
        diagnostic: "Future domain.",
      },
    } as unknown as SandboxCapabilities;

    const report = backendCapabilityCoverage(capabilities);
    expect(report.unknown).toEqual(["capabilities.futureDomain", "operations.future.operation"]);
    expect(report.missing).toContain("operations.filesystem.read");
    expect(report.invalid).not.toEqual([]);
  });
});
