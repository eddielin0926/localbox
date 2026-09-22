import type {
  ClientResult,
  JsonObject,
  SandboxClient,
  SandboxError,
} from "../runtime/index.js";

/** Compatibility manifest schema emitted by this release. */
export const FRONTEND_COMPATIBILITY_SCHEMA_VERSION = 1 as const;

/**
 * Frontend support is intentionally separate from backend capability support.
 * A cloud-only concern can be not applicable to local execution even though a
 * requested observable behavior would be unsupported.
 */
export const FRONTEND_SUPPORT_CLASSIFICATIONS = [
  "native",
  "emulated",
  "partial",
  "not-applicable",
  "unsupported",
] as const;

export type FrontendSupportClassification =
  (typeof FRONTEND_SUPPORT_CLASSIFICATIONS)[number];

export function isSupportedFrontendClassification(
  classification: FrontendSupportClassification,
): boolean {
  return classification === "native" ||
    classification === "emulated" ||
    classification === "partial";
}

export type SandboxClientFactory = () => SandboxClient | Promise<SandboxClient>;
export type FrontendSandboxClientSource = SandboxClient | SandboxClientFactory;

/**
 * Resolves the client explicitly supplied at an application composition root.
 * Factories are not cached and no default backend or mutable registry is read.
 */
export function resolveFrontendSandboxClient(
  source: FrontendSandboxClientSource,
): SandboxClient | Promise<SandboxClient> {
  return typeof source === "function" ? source() : source;
}

/**
 * Provider-owned translation for one operation. Request translation is
 * synchronous so validation and option-policy rejection finish before a
 * client factory can allocate a sandbox runtime.
 */
export interface FrontendOperation<
  ProviderRequest,
  ClientRequest,
  ClientValue extends JsonObject,
  ProviderResult,
> {
  translateRequest(request: ProviderRequest): ClientRequest;
  execute(client: SandboxClient, request: ClientRequest): Promise<ClientResult<ClientValue>>;
  translateResult(value: ClientValue): ProviderResult;
  translateError(error: SandboxError): Error;
}

/** Bind provider translation to one explicit client or client factory. */
export function bindFrontendOperation<
  ProviderRequest,
  ClientRequest,
  ClientValue extends JsonObject,
  ProviderResult,
>(
  source: FrontendSandboxClientSource,
  operation: FrontendOperation<ProviderRequest, ClientRequest, ClientValue, ProviderResult>,
): (request: ProviderRequest) => Promise<ProviderResult> {
  return async (request) => {
    const clientRequest = operation.translateRequest(request);
    const client = await resolveFrontendSandboxClient(source);
    const result = await operation.execute(client, clientRequest);
    if (!result.ok) throw operation.translateError(result.error);
    return operation.translateResult(result.value);
  };
}

export const FRONTEND_OPTION_DOMAINS = [
  "security",
  "isolation",
  "network",
  "resource",
  "storage",
  "snapshot",
  "session",
  "terminal",
  "hosted-control-plane",
] as const;

export type FrontendOptionDomain = (typeof FRONTEND_OPTION_DOMAINS)[number];
export type FrontendOptionClassification = Extract<
  FrontendSupportClassification,
  "not-applicable" | "unsupported"
>;

export interface FrontendOptionRule<Options> {
  readonly option: string;
  readonly domain: FrontendOptionDomain;
  readonly classification: FrontendOptionClassification;
  readonly rationale: string;
  readonly requested: (options: Options) => boolean;
}

export type NotApplicableFrontendOption = Readonly<{
  option: string;
  domain: FrontendOptionDomain;
  classification: "not-applicable";
  rationale: string;
}>;

export class UnsupportedFrontendOptionError extends Error {
  readonly option: string;
  readonly domain: FrontendOptionDomain;
  readonly classification = "unsupported" as const;

  constructor(rule: Readonly<{
    option: string;
    domain: FrontendOptionDomain;
    rationale: string;
  }>) {
    super(`Unsupported ${rule.domain} option "${rule.option}": ${rule.rationale}`);
    this.name = "UnsupportedFrontendOptionError";
    this.option = rule.option;
    this.domain = rule.domain;
  }
}

/**
 * Applies the shared reject-versus-not-applicable policy. Unsupported requests
 * throw in rule order; cloud-only no-effect inputs are returned for explicit
 * reporting and must not be counted as supported.
 */
export function applyFrontendOptionPolicy<Options>(
  options: Options,
  rules: readonly FrontendOptionRule<Options>[],
  unsupportedError: (rule: FrontendOptionRule<Options>) => Error =
    (rule) => new UnsupportedFrontendOptionError(rule),
): readonly NotApplicableFrontendOption[] {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.option.trim().length === 0) throw new TypeError("Frontend option names must not be empty.");
    if (rule.rationale.trim().length === 0) {
      throw new TypeError(`Frontend option "${rule.option}" requires a rationale.`);
    }
    if (!FRONTEND_OPTION_DOMAINS.includes(rule.domain)) {
      throw new TypeError(`Unknown frontend option domain: ${String(rule.domain)}`);
    }
    if (rule.classification !== "unsupported" && rule.classification !== "not-applicable") {
      throw new TypeError(
        `Unknown frontend option classification for "${rule.option}": ${String(rule.classification)}`,
      );
    }
    if (seen.has(rule.option)) throw new TypeError(`Duplicate frontend option rule: ${rule.option}`);
    seen.add(rule.option);
  }

  const notApplicable: NotApplicableFrontendOption[] = [];
  for (const rule of rules) {
    if (!rule.requested(options)) continue;
    if (rule.classification === "unsupported") throw unsupportedError(rule);
    notApplicable.push({
      option: rule.option,
      domain: rule.domain,
      classification: "not-applicable",
      rationale: rule.rationale,
    });
  }
  return notApplicable;
}

/** A command string whose shell interpretation is part of the provider contract. */
export type FrontendShellCommandInput = Readonly<{
  kind: "shell";
  command: string;
}>;

/** An executable and argument vector that must bypass shell interpretation. */
export type FrontendArgvCommandInput = Readonly<{
  kind: "argv";
  executable: string;
  arguments: readonly string[];
}>;

export type FrontendCommandInput = FrontendShellCommandInput | FrontendArgvCommandInput;

/** A provider call whose observable result is already complete. */
export type FrontendCommandCompletion<Completion> = Readonly<{
  kind: "completion";
  completion: Completion;
}>;

/** A provider call whose observable result is a still-live process handle. */
export type FrontendLiveProcess<ProcessHandle> = Readonly<{
  kind: "process";
  process: ProcessHandle;
}>;

export type FrontendCommandOutcome<Completion, ProcessHandle> =
  | FrontendCommandCompletion<Completion>
  | FrontendLiveProcess<ProcessHandle>;

export function shellCommand(command: string): FrontendShellCommandInput {
  return { kind: "shell", command };
}

export function argvCommand(
  executable: string,
  arguments_: readonly string[] = [],
): FrontendArgvCommandInput {
  return { kind: "argv", executable, arguments: [...arguments_] };
}

export function commandCompletion<Completion>(
  completion: Completion,
): FrontendCommandCompletion<Completion> {
  return { kind: "completion", completion };
}

export function liveProcess<ProcessHandle>(
  process: ProcessHandle,
): FrontendLiveProcess<ProcessHandle> {
  return { kind: "process", process };
}

/**
 * Harness shape shared by provider behavior suites. The separate execute and
 * start operations prevent completed results and live handles from collapsing
 * into one provider-specific command shape.
 */
export interface FrontendCommandConformance<Completion, ProcessHandle> {
  execute(input: FrontendCommandInput): Promise<FrontendCommandCompletion<Completion>>;
  start(input: FrontendCommandInput): Promise<FrontendLiveProcess<ProcessHandle>>;
}
