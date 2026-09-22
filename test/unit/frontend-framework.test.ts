import { describe, expect, test } from "vitest";
import {
  applyFrontendOptionPolicy,
  argvCommand,
  bindFrontendOperation,
  commandCompletion,
  FRONTEND_SUPPORT_CLASSIFICATIONS,
  isSupportedFrontendClassification,
  liveProcess,
  shellCommand,
  UnsupportedFrontendOptionError,
} from "../../src/frontend/index.js";
import type {
  FrontendOptionRule,
  FrontendOperation,
} from "../../src/frontend/index.js";
import type {
  ClientResult,
  JsonObject,
  SandboxClient,
  SandboxError,
} from "../../src/runtime/index.js";

const client = {} as SandboxClient;

const sandboxError: SandboxError = {
  category: "invalid-request",
  code: "TEST_REJECTED",
  message: "The provider request was rejected.",
  retryable: false,
  requestId: "request-1",
  backend: null,
  details: {
    type: "invalid-request",
    field: "mode",
    reason: "The requested mode is unavailable.",
  },
};

type ProviderRequest = Readonly<{ value: string }>;
type ClientRequest = Readonly<{ translated: string }>;
type ClientValue = JsonObject & { readonly answer: string };

function operation(result: ClientResult<ClientValue>): FrontendOperation<
  ProviderRequest,
  ClientRequest,
  ClientValue,
  string
> {
  return {
    translateRequest(request) {
      return { translated: request.value.toUpperCase() };
    },
    async execute(receivedClient, request) {
      expect(receivedClient).toBe(client);
      expect(request).toEqual({ translated: "VALUE" });
      return result;
    },
    translateResult(value) {
      return `provider:${value.answer}`;
    },
    translateError(error) {
      return new RangeError(`provider:${error.code}`);
    },
  };
}

describe("frontend adapter boundary", () => {
  test("binds request, result, and error translation to only the supplied SandboxClient", async () => {
    const success = bindFrontendOperation(client, operation({
      ok: true,
      value: { answer: "accepted" },
    }));
    await expect(success({ value: "value" })).resolves.toBe("provider:accepted");

    const failure = bindFrontendOperation(client, operation({ ok: false, error: sandboxError }));
    await expect(failure({ value: "value" })).rejects.toEqual(
      new RangeError("provider:TEST_REJECTED"),
    );
  });

  test("finishes provider preflight before invoking an explicit client factory", async () => {
    let factoryCalls = 0;
    const source = (): SandboxClient => {
      factoryCalls += 1;
      return client;
    };
    const rules: readonly FrontendOptionRule<ProviderRequest>[] = [{
      option: "value",
      domain: "security",
      classification: "unsupported",
      rationale: "This observable security behavior cannot be honored locally.",
      requested: ({ value }) => value === "blocked",
    }];
    const base = operation({ ok: true, value: { answer: "accepted" } });
    const rejecting: typeof base = {
      ...base,
      translateRequest(request) {
        applyFrontendOptionPolicy(request, rules);
        return base.translateRequest(request);
      },
    };
    const bound = bindFrontendOperation(source, rejecting);

    await expect(bound({ value: "blocked" })).rejects.toBeInstanceOf(
      UnsupportedFrontendOptionError,
    );
    expect(factoryCalls).toBe(0);
    await expect(bound({ value: "value" })).resolves.toBe("provider:accepted");
    expect(factoryCalls).toBe(1);
  });
});

describe("frontend support and command semantics", () => {
  test("publishes exactly the five frontend support classifications", () => {
    expect(FRONTEND_SUPPORT_CLASSIFICATIONS).toEqual([
      "native",
      "emulated",
      "partial",
      "not-applicable",
      "unsupported",
    ]);
  });

  test("reports cloud-only inputs as not applicable without counting them as supported", () => {
    const decisions = applyFrontendOptionPolicy(
      { region: "iad1" },
      [{
        option: "region",
        domain: "hosted-control-plane",
        classification: "not-applicable",
        rationale: "Local execution has no hosted placement control plane.",
        requested: ({ region }) => region !== undefined,
      }],
    );

    expect(decisions).toEqual([{
      option: "region",
      domain: "hosted-control-plane",
      classification: "not-applicable",
      rationale: "Local execution has no hosted placement control plane.",
    }]);
    expect(isSupportedFrontendClassification(decisions[0]!.classification)).toBe(false);
    expect(isSupportedFrontendClassification("unsupported")).toBe(false);
    expect(isSupportedFrontendClassification("partial")).toBe(true);
  });

  test("keeps shell and argv inputs distinct from completion and live-process outcomes", () => {
    expect(shellCommand("printf '%s' \"$HOME\"")).toEqual({
      kind: "shell",
      command: "printf '%s' \"$HOME\"",
    });
    expect(argvCommand("printf", ["%s", "$HOME"])).toEqual({
      kind: "argv",
      executable: "printf",
      arguments: ["%s", "$HOME"],
    });
    expect(commandCompletion({ exitCode: 0 })).toEqual({
      kind: "completion",
      completion: { exitCode: 0 },
    });
    expect(liveProcess({ processId: "process-1" })).toEqual({
      kind: "process",
      process: { processId: "process-1" },
    });
  });
});
