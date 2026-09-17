import type {
  ArtifactKind,
  CapabilitySupport,
  EndpointVisibility,
  IsolationLevel,
  IsolationTenancy,
  JsonObject,
  JsonValue,
  NetworkMode,
  PersistenceScope,
  RecoveryScope,
  SandboxCapabilities,
  SandboxOperationalCapability,
  SandboxRequirement,
  SandboxRequirementIssue,
  SnapshotOperation,
  TerminalMode,
} from "./index.js";

const SUPPORTS = ["native", "emulated", "partial", "unsupported"] as const;
const ACCEPTABLE_SUPPORTS = ["native", "emulated", "partial"] as const;
export const SANDBOX_OPERATIONAL_CAPABILITIES = [
  "command.start",
  "command.detached",
  "endpoint.expose",
  "filesystem.mkdir",
  "filesystem.read",
  "filesystem.write",
  "source.git",
  "source.tarball",
  "raw-command.input",
  "raw-command.managed-filesystem-owner",
] as const satisfies readonly SandboxOperationalCapability[];
const DOMAIN_NAMES = [
  "isolation",
  "artifacts",
  "persistence",
  "recovery",
  "networking",
  "resources",
  "terminals",
  "snapshots",
] as const;
const ISOLATION_LEVELS = ["process", "shared-kernel-container", "namespace-sandbox", "virtual-machine"] as const;
const ISOLATION_TENANCIES = ["trusted", "single-tenant", "multi-tenant"] as const;
const ARTIFACT_KINDS = ["runtime", "oci-image", "git", "tarball", "directory", "disk-image", "snapshot"] as const;
const PERSISTENCE_SCOPES = ["sandbox-lifecycle", "backend-restart"] as const;
const RECOVERY_SCOPES = ["sandbox", "process"] as const;
const NETWORK_MODES = ["allow-all", "deny-all", "custom"] as const;
const ENDPOINT_VISIBILITIES = ["loopback", "private", "public"] as const;
const TERMINAL_MODES = ["exec", "pty"] as const;
const SNAPSHOT_OPERATIONS = ["create", "restore", "clone"] as const;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: PlainObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isFiniteInteger(value: unknown, minimum = Number.MIN_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isEnumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isUniqueEnumArray<T extends string>(value: unknown, values: readonly T[]): value is readonly T[] {
  return Array.isArray(value) && value.every((item) => isEnumValue(item, values)) && new Set(value).size === value.length;
}

function isSupport(value: unknown): value is CapabilitySupport {
  return isEnumValue(value, SUPPORTS);
}

function isAcceptableSupport(value: unknown): value is readonly Exclude<CapabilitySupport, "unsupported">[] {
  return isUniqueEnumArray(value, ACCEPTABLE_SUPPORTS) && value.length > 0;
}

function descriptor(value: unknown): value is PlainObject {
  return isPlainObject(value) && hasExactKeys(value, ["support", "constraints", "diagnostic"]) && isSupport(value.support) && typeof value.diagnostic === "string" && value.diagnostic.trim().length > 0;
}

function nullConstraints(value: unknown): boolean {
  return value === null;
}

function endpointConstraints(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ["protocols", "visibilities"]) && isUniqueEnumArray(value.protocols, ["http", "https"]) && isUniqueEnumArray(value.visibilities, ENDPOINT_VISIBILITIES);
}

function rawInputConstraints(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ["maxBytes"]) && isFiniteInteger(value.maxBytes, 1);
}

function managedOwnerConstraints(value: unknown): boolean {
  return isPlainObject(value) && hasExactKeys(value, ["managedImagesOnly"]) && typeof value.managedImagesOnly === "boolean";
}

function validateOperationalDescriptor(name: SandboxOperationalCapability, value: unknown): boolean {
  if (!descriptor(value)) return false;
  if (name === "endpoint.expose") return endpointConstraints(value.constraints);
  if (name === "raw-command.input") return rawInputConstraints(value.constraints);
  if (name === "raw-command.managed-filesystem-owner") return managedOwnerConstraints(value.constraints);
  return nullConstraints(value.constraints);
}

function validateRange(value: unknown, minimumKey: string, maximumKey: string, stepKey: string): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, [minimumKey, maximumKey, stepKey])) return false;
  const minimum = value[minimumKey];
  const maximum = value[maximumKey];
  const step = value[stepKey];
  return isFiniteInteger(minimum, 1) && (maximum === null || (isFiniteInteger(maximum, minimum) && maximum >= minimum)) && isFiniteInteger(step, 1);
}

function validateDomainDescriptor(domain: typeof DOMAIN_NAMES[number], value: unknown): boolean {
  if (!descriptor(value) || !isPlainObject(value.constraints)) return false;
  const constraints = value.constraints;
  switch (domain) {
    case "isolation":
      return hasExactKeys(constraints, ["level", "tenancies"]) && isEnumValue(constraints.level, ISOLATION_LEVELS) && isUniqueEnumArray(constraints.tenancies, ISOLATION_TENANCIES);
    case "artifacts":
      return hasExactKeys(constraints, ["kinds"]) && isUniqueEnumArray(constraints.kinds, ARTIFACT_KINDS);
    case "persistence":
      return hasExactKeys(constraints, ["scopes"]) && isUniqueEnumArray(constraints.scopes, PERSISTENCE_SCOPES);
    case "recovery":
      return hasExactKeys(constraints, ["scopes"]) && isUniqueEnumArray(constraints.scopes, RECOVERY_SCOPES);
    case "networking":
      return hasExactKeys(constraints, ["customPolicies", "modes", "portExposure"]) && typeof constraints.customPolicies === "boolean" && isUniqueEnumArray(constraints.modes, NETWORK_MODES) && isUniqueEnumArray(constraints.portExposure, ENDPOINT_VISIBILITIES);
    case "resources":
      return hasExactKeys(constraints, ["cpu", "enforcement", "memory", "memoryBytesPerVcpu"]) && validateRange(constraints.cpu, "minimumVcpus", "maximumVcpus", "stepVcpus") && validateRange(constraints.memory, "minimumBytes", "maximumBytes", "stepBytes") && (constraints.memoryBytesPerVcpu === null || isFiniteInteger(constraints.memoryBytesPerVcpu, 1)) && (constraints.enforcement === "hard" || constraints.enforcement === "best-effort");
    case "terminals":
      return hasExactKeys(constraints, ["modes"]) && isUniqueEnumArray(constraints.modes, TERMINAL_MODES);
    case "snapshots":
      return hasExactKeys(constraints, ["operations"]) && isUniqueEnumArray(constraints.operations, SNAPSHOT_OPERATIONS);
  }
}

function issue(index: number | null, kind: SandboxRequirementIssue["kind"], reason: string, requirement: SandboxRequirement | null = null, backendDiagnostic: string | null = null): SandboxRequirementIssue {
  return { index, kind, requirement, reason, backendDiagnostic };
}

function validateCapabilities(value: unknown): readonly SandboxRequirementIssue[] {
  if (!isPlainObject(value)) return [issue(null, "invalid-backend-capabilities", "Backend capabilities must be a plain JSON object.")];
  const topKeys = ["schemaVersion", "operations", ...DOMAIN_NAMES];
  const actualTopKeys = Object.keys(value);
  const unknownTopKeys = actualTopKeys.filter((key) => !topKeys.includes(key));
  const missingTopKeys = topKeys.filter((key) => !Object.hasOwn(value, key));
  const problems: SandboxRequirementIssue[] = [];
  for (const key of unknownTopKeys.sort()) problems.push(issue(null, "invalid-backend-capabilities", `Backend capabilities contain unknown entry ${key}.`));
  for (const key of missingTopKeys) problems.push(issue(null, "invalid-backend-capabilities", `Backend capabilities are missing required entry ${key}.`));
  if (value.schemaVersion !== 1) problems.push(issue(null, "invalid-backend-capabilities", "Backend capability schemaVersion must be 1."));

  if (!isPlainObject(value.operations)) {
    problems.push(issue(null, "invalid-backend-capabilities", "Backend operations must be a keyed capability record."));
  } else {
    const operationKeys = Object.keys(value.operations);
    for (const key of operationKeys.filter((key) => !SANDBOX_OPERATIONAL_CAPABILITIES.includes(key as SandboxOperationalCapability)).sort()) {
      problems.push(issue(null, "invalid-backend-capabilities", `Backend operations contain unknown entry ${key}.`));
    }
    for (const name of SANDBOX_OPERATIONAL_CAPABILITIES) {
      if (!Object.hasOwn(value.operations, name)) {
        problems.push(issue(null, "invalid-backend-capabilities", `Backend operations are missing required entry ${name}.`));
      } else if (!validateOperationalDescriptor(name, value.operations[name])) {
        problems.push(issue(null, "invalid-backend-capabilities", `Backend operation ${name} has malformed support, constraints, or diagnostic data.`));
      }
    }
  }
  for (const domain of DOMAIN_NAMES) {
    if (Object.hasOwn(value, domain) && !validateDomainDescriptor(domain, value[domain])) {
      problems.push(issue(null, "invalid-backend-capabilities", `Backend ${domain} capability has malformed support, constraints, or diagnostic data.`));
    }
  }
  return problems;
}

function isJsonValue(value: unknown): value is JsonValue {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object" || current === undefined || seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) pending.push(...current);
    else if (isPlainObject(current)) pending.push(...Object.values(current));
    else return false;
  }
  return true;
}

function validateRequirement(value: unknown): value is SandboxRequirement {
  if (!isPlainObject(value) || !isAcceptableSupport(value.acceptableSupport) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "operation":
      return hasExactKeys(value, ["type", "operation", "acceptableSupport"]) && isEnumValue(value.operation, SANDBOX_OPERATIONAL_CAPABILITIES);
    case "isolation":
      return hasExactKeys(value, ["type", "acceptableSupport", "minimumLevel", "tenancy"]) && isEnumValue(value.minimumLevel, ISOLATION_LEVELS) && isEnumValue(value.tenancy, ISOLATION_TENANCIES);
    case "artifacts":
      return hasExactKeys(value, ["type", "acceptableSupport", "kinds"]) && isUniqueEnumArray(value.kinds, ARTIFACT_KINDS) && value.kinds.length > 0;
    case "persistence":
      return hasExactKeys(value, ["type", "acceptableSupport", "scope"]) && isEnumValue(value.scope, PERSISTENCE_SCOPES);
    case "recovery":
      return hasExactKeys(value, ["type", "acceptableSupport", "scope"]) && isEnumValue(value.scope, RECOVERY_SCOPES);
    case "networking":
      return hasExactKeys(value, ["type", "acceptableSupport", "mode", "portExposure", "customPolicy"]) && isEnumValue(value.mode, NETWORK_MODES) && (value.portExposure === null || isEnumValue(value.portExposure, ENDPOINT_VISIBILITIES)) && typeof value.customPolicy === "boolean";
    case "resources":
      return hasExactKeys(value, ["type", "acceptableSupport", "vcpus", "memoryBytes", "enforcement"]) && (value.vcpus === null || isFiniteInteger(value.vcpus, 1)) && (value.memoryBytes === null || isFiniteInteger(value.memoryBytes, 1)) && (value.vcpus !== null || value.memoryBytes !== null) && (value.enforcement === "hard" || value.enforcement === "best-effort");
    case "terminals":
      return hasExactKeys(value, ["type", "acceptableSupport", "mode"]) && isEnumValue(value.mode, TERMINAL_MODES);
    case "snapshots":
      return hasExactKeys(value, ["type", "acceptableSupport", "operation"]) && isEnumValue(value.operation, SNAPSHOT_OPERATIONS);
    default:
      return false;
  }
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`).join(",")}}`;
}

function requirementKey(requirement: SandboxRequirement): string {
  return requirement.type === "operation" ? `operation:${requirement.operation}` : requirement.type;
}

function capabilityFor(capabilities: SandboxCapabilities, requirement: SandboxRequirement) {
  return requirement.type === "operation" ? capabilities.operations[requirement.operation] : capabilities[requirement.type];
}

function supportProblem(capabilities: SandboxCapabilities, requirement: SandboxRequirement): string | null {
  const capability = capabilityFor(capabilities, requirement);
  if (capability.support === "unsupported") return "The backend explicitly classifies this capability as unsupported.";
  if (!requirement.acceptableSupport.includes(capability.support)) return `The backend provides ${capability.support} support, but the requirement accepts only ${requirement.acceptableSupport.join(", ")}.`;
  return null;
}

function outsideRange(value: number, minimum: number, maximum: number | null, step: number): boolean {
  return value < minimum || (maximum !== null && value > maximum) || (value - minimum) % step !== 0;
}

function constraintProblems(capabilities: SandboxCapabilities, requirement: SandboxRequirement): readonly string[] {
  switch (requirement.type) {
    case "operation":
      return [];
    case "isolation": {
      const constraints = capabilities.isolation.constraints;
      const problems: string[] = [];
      if (ISOLATION_LEVELS.indexOf(constraints.level) < ISOLATION_LEVELS.indexOf(requirement.minimumLevel)) problems.push(`requires isolation level ${requirement.minimumLevel}, but the backend provides ${constraints.level}`);
      if (!constraints.tenancies.includes(requirement.tenancy)) problems.push(`requires ${requirement.tenancy} use, but the backend permits ${constraints.tenancies.join(", ") || "no tenancy model"}`);
      return problems;
    }
    case "artifacts": {
      const missing = requirement.kinds.filter((kind) => !capabilities.artifacts.constraints.kinds.includes(kind));
      return missing.length === 0 ? [] : [`does not accept artifact kinds ${missing.join(", ")}`];
    }
    case "persistence":
      return capabilities.persistence.constraints.scopes.includes(requirement.scope) ? [] : [`does not provide persistence scope ${requirement.scope}`];
    case "recovery":
      return capabilities.recovery.constraints.scopes.includes(requirement.scope) ? [] : [`does not recover ${requirement.scope} state`];
    case "networking": {
      const constraints = capabilities.networking.constraints;
      const problems: string[] = [];
      if (!constraints.modes.includes(requirement.mode)) problems.push(`does not provide network mode ${requirement.mode}`);
      if (requirement.portExposure !== null && !constraints.portExposure.includes(requirement.portExposure)) problems.push(`does not expose ${requirement.portExposure} endpoints`);
      if (requirement.customPolicy && !constraints.customPolicies) problems.push("does not enforce custom network policies");
      return problems;
    }
    case "resources": {
      const constraints = capabilities.resources.constraints;
      const problems: string[] = [];
      if (requirement.enforcement === "hard" && constraints.enforcement !== "hard") problems.push("does not provide hard resource enforcement");
      if (requirement.vcpus !== null && outsideRange(requirement.vcpus, constraints.cpu.minimumVcpus, constraints.cpu.maximumVcpus, constraints.cpu.stepVcpus)) problems.push(`cannot satisfy ${requirement.vcpus} vCPUs within its advertised CPU bounds`);
      if (requirement.memoryBytes !== null && outsideRange(requirement.memoryBytes, constraints.memory.minimumBytes, constraints.memory.maximumBytes, constraints.memory.stepBytes)) problems.push(`cannot satisfy ${requirement.memoryBytes} memory bytes within its advertised memory bounds`);
      if (constraints.memoryBytesPerVcpu !== null) {
        if (requirement.vcpus === null && requirement.memoryBytes !== null) problems.push("cannot set memory independently of vCPUs");
        else if (requirement.vcpus !== null && requirement.memoryBytes !== null && requirement.memoryBytes !== requirement.vcpus * constraints.memoryBytesPerVcpu) problems.push(`requires ${constraints.memoryBytesPerVcpu} memory bytes per vCPU`);
      }
      return problems;
    }
    case "terminals":
      return capabilities.terminals.constraints.modes.includes(requirement.mode) ? [] : [`does not provide terminal mode ${requirement.mode}`];
    case "snapshots":
      return capabilities.snapshots.constraints.operations.includes(requirement.operation) ? [] : [`does not provide snapshot operation ${requirement.operation}`];
  }
}

/** Pure, deterministic preflight over transport data. It never mutates either input. */
export function negotiateSandboxRequirements(capabilitiesValue: unknown, requirementsValue: unknown): readonly SandboxRequirementIssue[] {
  const capabilityIssues = validateCapabilities(capabilitiesValue);
  if (capabilityIssues.length > 0) return capabilityIssues;
  const capabilities = capabilitiesValue as SandboxCapabilities;
  if (!Array.isArray(requirementsValue)) return [issue(null, "malformed", "Sandbox requirements must be an array.")];

  const issues: SandboxRequirementIssue[] = [];
  const seen = new Map<string, string>();
  for (let index = 0; index < requirementsValue.length; index += 1) {
    const candidate = requirementsValue[index];
    if (!isJsonValue(candidate) || !isPlainObject(candidate)) {
      issues.push(issue(index, "malformed", "Requirement must be a plain JSON object."));
      continue;
    }
    if (typeof candidate.type !== "string" || !["operation", ...DOMAIN_NAMES].includes(candidate.type)) {
      issues.push(issue(index, "unknown", `Unknown requirement type ${typeof candidate.type === "string" ? candidate.type : "<missing>"}.`));
      continue;
    }
    if (!validateRequirement(candidate)) {
      issues.push(issue(index, "malformed", `Requirement ${candidate.type} has unknown fields or malformed constraints.`));
      continue;
    }
    const requirement = candidate;
    const key = requirementKey(requirement);
    const encoded = stableJson(requirement);
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push(issue(index, previous === encoded ? "duplicate" : "conflict", previous === encoded ? `Requirement ${key} is duplicated.` : `Requirement ${key} conflicts with an earlier requirement.`, requirement));
      continue;
    }
    seen.set(key, encoded);

    const capability = capabilityFor(capabilities, requirement);
    const unsupported = supportProblem(capabilities, requirement);
    if (unsupported !== null) {
      issues.push(issue(index, "unsupported", unsupported, requirement, capability.diagnostic));
      continue;
    }
    const problems = constraintProblems(capabilities, requirement);
    if (problems.length > 0) issues.push(issue(index, "constraint", `Backend ${problems.join("; ")}.`, requirement, capability.diagnostic));
  }
  return issues;
}
