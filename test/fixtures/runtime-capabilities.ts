import type {
  CapabilitySupport,
  SandboxCapabilities,
  SandboxOperationalCapability,
} from "../../src/runtime/index.js";

const native = (diagnostic: string) => ({
  support: "native" as const,
  constraints: null,
  diagnostic,
});

export const TEST_CAPABILITIES = {
  schemaVersion: 1,
  operations: {
    "command.start": native("Test backend starts commands."),
    "command.detached": native("Test backend keeps detached commands."),
    "endpoint.expose": {
      support: "native",
      constraints: { protocols: ["http"], visibilities: ["loopback"] },
      diagnostic: "Test backend exposes loopback HTTP endpoints.",
    },
    "filesystem.mkdir": native("Test backend creates directories."),
    "filesystem.read": native("Test backend reads files."),
    "filesystem.write": native("Test backend writes files."),
    "source.git": native("Test backend accepts Git sources."),
    "source.tarball": native("Test backend accepts tarball sources."),
    "raw-command.input": {
      support: "native",
      constraints: { maxBytes: 1_048_576 },
      diagnostic: "Test backend accepts raw command input.",
    },
    "raw-command.managed-filesystem-owner": {
      support: "native",
      constraints: { managedImagesOnly: false },
      diagnostic: "Test backend supports managed filesystem ownership.",
    },
  },
  isolation: {
    support: "native",
    constraints: { level: "virtual-machine", tenancies: ["trusted", "single-tenant", "multi-tenant"] },
    diagnostic: "Test backend provides VM isolation.",
  },
  artifacts: {
    support: "native",
    constraints: { kinds: ["host", "directory", "oci-image", "disk-image", "snapshot"] },
    diagnostic: "Test backend accepts every artifact kind.",
  },
  persistence: {
    support: "native",
    constraints: { scopes: ["sandbox-lifecycle", "backend-restart"] },
    diagnostic: "Test backend persists sandbox state.",
  },
  recovery: {
    support: "native",
    constraints: { scopes: ["sandbox", "process"] },
    diagnostic: "Test backend recovers sandbox and process state.",
  },
  networking: {
    support: "native",
    constraints: {
      modes: ["allow-all", "deny-all", "custom"],
      portExposure: ["loopback", "private", "public"],
      customPolicies: true,
    },
    diagnostic: "Test backend provides all network policies.",
  },
  resources: {
    support: "native",
    constraints: {
      cpu: { minimumVcpus: 1, maximumVcpus: 64, stepVcpus: 1 },
      memory: { minimumBytes: 1_048_576, maximumBytes: 137_438_953_472, stepBytes: 1_048_576 },
      memoryBytesPerVcpu: null,
      enforcement: "hard",
    },
    diagnostic: "Test backend enforces independent CPU and memory limits.",
  },
  terminals: {
    support: "native",
    constraints: { modes: ["exec", "pty"] },
    diagnostic: "Test backend provides exec and PTY terminals.",
  },
  snapshots: {
    support: "native",
    constraints: { operations: ["create", "restore", "clone"] },
    diagnostic: "Test backend supports every snapshot operation.",
  },
} as const satisfies SandboxCapabilities;

export const TEST_OCI_ARTIFACT = {
  kind: "oci-image",
  locator: { type: "oci-reference", reference: "registry.example.test/localbox:test" },
  digest: null,
  trust: "untrusted",
  mutability: "mutable",
  platform: null,
} as const;

export const TEST_HOST_ARTIFACT = {
  kind: "host",
  locator: { type: "host", selector: "current" },
  trust: "trusted",
  mutability: "mutable",
} as const;

export function testCapabilitiesWithOperationSupport(
  support: Readonly<Partial<Record<SandboxOperationalCapability, CapabilitySupport>>>,
): SandboxCapabilities {
  const entries = Object.entries(TEST_CAPABILITIES.operations) as [
    SandboxOperationalCapability,
    SandboxCapabilities["operations"][SandboxOperationalCapability],
  ][];
  const operations = Object.fromEntries(
    entries.map(([name, capability]) => [
      name,
      { ...capability, support: support[name] ?? capability.support },
    ]),
  ) as unknown as SandboxCapabilities["operations"];
  return { ...TEST_CAPABILITIES, operations };
}
