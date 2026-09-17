import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import type {
  ClientResult,
  CreateSandboxRequest,
  JsonObject,
  ReadCommandOutputResult,
  SandboxCapability,
  SandboxClient,
  SandboxSource,
  SandboxSpec,
} from "../../src/runtime/index.js";

const ALL_CAPABILITIES = [
  "command.start",
  "command.detached",
  "endpoint.expose",
  "filesystem.mkdir",
  "filesystem.read",
  "filesystem.write",
  "sandbox.network.allow-all",
  "sandbox.network.deny-all",
  "sandbox.persistence",
  "sandbox.resource-limits",
  "sandbox.source.git",
  "sandbox.source.tarball",
] as const satisfies readonly SandboxCapability[];

export const BACKEND_CONFORMANCE_COVERAGE = {
  "command.start": ["command execution", "command cleanup"],
  "command.detached": ["command signals", "command cleanup"],
  "endpoint.expose": ["endpoint records", "endpoint cleanup"],
  "filesystem.mkdir": ["filesystem directories"],
  "filesystem.read": ["filesystem pages", "filesystem errors"],
  "filesystem.write": ["filesystem writes", "filesystem cancellation"],
  "sandbox.network.allow-all": ["allow-all networking"],
  "sandbox.network.deny-all": ["deny-all networking"],
  "sandbox.persistence": ["persistent lifecycle"],
  "sandbox.resource-limits": ["resource limits"],
  "sandbox.source.git": ["git source materialization"],
  "sandbox.source.tarball": ["tarball source materialization"],
} as const satisfies Record<SandboxCapability, readonly string[]>;

export type SandboxSpecOverrides = Partial<Pick<
  SandboxSpec,
  | "bootSource"
  | "source"
  | "persistent"
  | "timeoutMs"
  | "environment"
  | "tags"
  | "ports"
  | "networkPolicy"
  | "resources"
  | "region"
  | "failoverRegions"
>>;

export interface BackendConformanceHarness {
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly sourceFixtures?: Readonly<Partial<Record<"git" | "tarball", SandboxSource>>>;
  createClient(): SandboxClient | Promise<SandboxClient>;
  sandboxSpec(name: string, overrides?: SandboxSpecOverrides): SandboxSpec;
  uniqueSandboxName(profile: string): string;
  cleanup(client: SandboxClient, sandboxId: string): Promise<void>;
}

interface ProfileContext {
  readonly client: SandboxClient;
  readonly sandboxIds: Set<string>;
}

let requestSequence = 0;

function requestId(label: string): string {
  requestSequence += 1;
  return `conformance:${label}:${requestSequence}`;
}

function requestMetadata(label: string, expiresAt: number | null = null) {
  return {
    requestId: requestId(label),
    deadline: expiresAt === null ? null : { expiresAt },
  } as const;
}

function mutationMetadata(label: string, idempotencyKey = requestId(`key:${label}`)) {
  return {
    ...requestMetadata(label),
    idempotencyKey,
  } as const;
}

function unwrap<T extends JsonObject>(result: ClientResult<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

function createRequest(
  harness: BackendConformanceHarness,
  name: string,
  requirements: readonly SandboxCapability[] = [],
  overrides: SandboxSpecOverrides = {},
  idempotencyKey = requestId(`key:create:${name}`),
): CreateSandboxRequest {
  return {
    ...mutationMetadata(`create:${name}`, idempotencyKey),
    sandboxId: name,
    backend: null,
    requirements: requirements.map((capability) => ({ capability, parameters: null })),
    spec: harness.sandboxSpec(name, overrides),
  };
}

function hasCapabilities(
  harness: BackendConformanceHarness,
  capabilities: readonly SandboxCapability[],
): boolean {
  const advertised = new Set(harness.capabilities);
  return capabilities.every((capability) => advertised.has(capability));
}

function profileTest(
  harness: BackendConformanceHarness,
  capabilities: readonly SandboxCapability[],
  title: string,
  run: (context: ProfileContext) => Promise<void>,
): void {
  const advertised = new Set(harness.capabilities);
  const absent = capabilities.filter((capability) => !advertised.has(capability));
  const suffix = absent.length === 0
    ? capabilities.length === 0 ? "" : ` [capabilities: ${capabilities.join(", ")}]`
    : ` [absent capability: ${absent.join(", ")}]`;
  test.skipIf(absent.length > 0)(`${title}${suffix}`, async () => {
    const context: ProfileContext = {
      client: await harness.createClient(),
      sandboxIds: new Set<string>(),
    };
    try {
      await run(context);
    } finally {
      await Promise.all(
        [...context.sandboxIds].map((sandboxId) =>
          harness.cleanup(context.client, sandboxId)
        ),
      );
    }
  });
}

async function createSandbox(
  harness: BackendConformanceHarness,
  context: ProfileContext,
  profile: string,
  capabilities: readonly SandboxCapability[] = [],
  overrides: SandboxSpecOverrides = {},
): Promise<string> {
  const sandboxId = harness.uniqueSandboxName(profile);
  context.sandboxIds.add(sandboxId);
  unwrap(await context.client.createSandbox(
    createRequest(harness, sandboxId, capabilities, overrides),
  ));
  return sandboxId;
}

async function readAllOutput(
  client: SandboxClient,
  sandboxId: string,
  processId: string,
  limitBytes = 3,
): Promise<{ readonly text: string; readonly streams: readonly string[] }> {
  let cursor: string | null = null;
  let complete = false;
  const text: string[] = [];
  const streams: string[] = [];
  while (!complete) {
    const page: ReadCommandOutputResult = unwrap(await client.readCommandOutput({
      ...requestMetadata(`read-output:${processId}`),
      sandboxId,
      processId,
      stream: "both",
      cursor,
      limitBytes,
      follow: true,
    }));
    for (const chunk of page.chunks) {
      text.push(chunk.data);
      streams.push(chunk.stream);
    }
    cursor = page.nextCursor;
    complete = page.complete;
  }
  return { text: text.join(""), streams };
}

async function waitForStatus(
  client: SandboxClient,
  sandboxId: string,
  expected: "running" | "stopped",
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.getSandbox({
      ...mutationMetadata(`poll:${sandboxId}`),
      sandboxId,
      resume: false,
    });
    if (result.ok && result.value.sandbox.status === expected) return;
    // The backend watchdog uses platform time, so poll observable state at a short interval.
    await delay(25);
  }
  throw new Error(`Sandbox ${sandboxId} did not reach ${expected} within ${timeoutMs}ms.`);
}

export function backendCapabilityCoverage(capabilities: readonly string[]): Readonly<{
  covered: readonly SandboxCapability[];
  unknown: readonly string[];
}> {
  const known = new Set<string>(ALL_CAPABILITIES);
  const unknown = [...new Set(capabilities.filter((capability) => !known.has(capability)))];
  const covered = ALL_CAPABILITIES.filter((capability) => capabilities.includes(capability));
  return { covered, unknown };
}

export function registerBackendConformanceProfiles(harness: BackendConformanceHarness): void {
  describe(`${harness.name} backend conformance`, () => {
    test("advertises only capabilities with behavior profile coverage", () => {
      const report = backendCapabilityCoverage(harness.capabilities);
      expect(report.unknown).toEqual([]);
      expect(report.covered).toEqual([...new Set(harness.capabilities)]);
      for (const capability of report.covered) {
        expect(BACKEND_CONFORMANCE_COVERAGE[capability].length).toBeGreaterThan(0);
      }
    });

    profileTest(harness, [], "lifecycle create, get, list, delete, and retry idempotency", async (context) => {
      const name = harness.uniqueSandboxName("lifecycle");
      context.sandboxIds.add(name);
      const idempotencyKey = requestId(`key:create:${name}`);
      const firstRequest = createRequest(harness, name, [], {}, idempotencyKey);
      const first = unwrap(await context.client.createSandbox(firstRequest)).sandbox;
      const retried = unwrap(await context.client.createSandbox({
        ...firstRequest,
        requestId: requestId(`retry-create:${name}`),
      })).sandbox;
      expect(retried.sandboxId).toBe(first.sandboxId);
      expect(retried.createdAt).toBe(first.createdAt);

      const fetched = unwrap(await context.client.getSandbox({
        ...mutationMetadata(`get:${name}`),
        sandboxId: name,
        resume: false,
      })).sandbox;
      expect(fetched).toMatchObject({ sandboxId: name, name, status: "running" });

      const listed = unwrap(await context.client.listSandboxes({
        ...requestMetadata(`list:${name}`),
        namePrefix: name,
        tags: {},
        statuses: [],
        sortBy: "name",
        sortOrder: "asc",
        limit: 1,
        cursor: null,
      }));
      expect(listed.sandboxes.map((sandbox) => sandbox.sandboxId)).toEqual([name]);

      const deleteMetadata = mutationMetadata(`delete:${name}`);
      const deleted = unwrap(await context.client.deleteSandbox({
        ...deleteMetadata,
        sandboxId: name,
      }));
      const deleteRetry = unwrap(await context.client.deleteSandbox({
        ...deleteMetadata,
        requestId: requestId(`retry-delete:${name}`),
        sandboxId: name,
      }));
      expect(deleteRetry).toEqual(deleted);
      const missing = await context.client.getSandbox({
        ...mutationMetadata(`missing:${name}`),
        sandboxId: name,
        resume: false,
      });
      expect(missing).toMatchObject({ ok: false, error: { category: "not-found" } });
    });

    profileTest(harness, [], "ephemeral stop removes the sandbox", async (context) => {
      const sandboxId = await createSandbox(harness, context, "ephemeral", [], {
        persistent: false,
      });
      unwrap(await context.client.stopSandbox({
        ...mutationMetadata(`stop:${sandboxId}`),
        sandboxId,
      }));
      const missing = await context.client.getSandbox({
        ...mutationMetadata(`get-stopped:${sandboxId}`),
        sandboxId,
        resume: false,
      });
      expect(missing).toMatchObject({ ok: false, error: { category: "not-found" } });
    });

    profileTest(harness, ["sandbox.persistence"], "persistent stop and resume preserve state and are idempotent", async (context) => {
      const sandboxId = await createSandbox(
        harness,
        context,
        "persistence",
        ["sandbox.persistence"],
        { persistent: true },
      );
      if (hasCapabilities(harness, ["filesystem.write", "filesystem.read"])) {
        unwrap(await context.client.writeFile({
          ...mutationMetadata(`persistent-write:${sandboxId}`),
          sandboxId,
          path: "/vercel/sandbox/state.bin",
          content: { encoding: "base64", data: "AQID" },
          mode: null,
        }));
      }

      const stopMetadata = mutationMetadata(`persistent-stop:${sandboxId}`);
      const stopped = unwrap(await context.client.stopSandbox({
        ...stopMetadata,
        sandboxId,
      })).sandbox;
      const stopRetry = unwrap(await context.client.stopSandbox({
        ...stopMetadata,
        requestId: requestId(`retry-stop:${sandboxId}`),
        sandboxId,
      })).sandbox;
      expect(stopped.status).toBe("stopped");
      expect(stopRetry.status).toBe("stopped");

      const resumeMetadata = mutationMetadata(`resume:${sandboxId}`);
      const resumed = unwrap(await context.client.getSandbox({
        ...resumeMetadata,
        sandboxId,
        resume: true,
      })).sandbox;
      const resumeRetry = unwrap(await context.client.getSandbox({
        ...resumeMetadata,
        requestId: requestId(`retry-resume:${sandboxId}`),
        sandboxId,
        resume: true,
      })).sandbox;
      expect(resumed.status).toBe("running");
      expect(resumeRetry.status).toBe("running");

      if (hasCapabilities(harness, ["filesystem.write", "filesystem.read"])) {
        const state = unwrap(await context.client.readFile({
          ...requestMetadata(`persistent-read:${sandboxId}`),
          sandboxId,
          path: "/vercel/sandbox/state.bin",
          offset: 0,
          limitBytes: 16,
          encoding: "base64",
        }));
        expect(state.content).toEqual({ encoding: "base64", data: "AQID" });
      }
    });

    profileTest(harness, ["command.start"], "commands preserve output order, pagination, exit status, errors, and start idempotency", async (context) => {
      const sandboxId = await createSandbox(harness, context, "commands", ["command.start"]);
      const startMetadata = mutationMetadata(`start:${sandboxId}`);
      const request = {
        ...startMetadata,
        sandboxId,
        command: {
          command: "node",
          arguments: ["-e", "process.stdout.write('one',()=>process.stderr.write('two',()=>process.stdout.write('three',()=>{process.exitCode=7})))"],
          cwd: "/vercel/sandbox",
          environment: {},
        },
        outputLimitBytes: 1024,
      } as const;
      const process = unwrap(await context.client.startCommand(request)).process;
      const retry = unwrap(await context.client.startCommand({
        ...request,
        requestId: requestId(`retry-start:${sandboxId}`),
      })).process;
      expect(retry.processId).toBe(process.processId);
      const waited = unwrap(await context.client.waitForCommand({
        ...requestMetadata(`wait:${process.processId}`),
        sandboxId,
        processId: process.processId,
      }));
      expect(waited.result).toMatchObject({ exitCode: 7, process: { status: "exited" } });
      const output = await readAllOutput(context.client, sandboxId, process.processId);
      expect(output.text).toBe("onetwothree");
      expect(output.streams).toEqual(["stdout", "stderr", "stdout", "stdout"]);

      const missing = unwrap(await context.client.startCommand({
        ...mutationMetadata(`missing-command:${sandboxId}`),
        sandboxId,
        command: {
          command: "localbox-command-that-does-not-exist",
          arguments: [],
          cwd: "/vercel/sandbox",
          environment: {},
        },
        outputLimitBytes: 4096,
      })).process;
      const missingResult = unwrap(await context.client.waitForCommand({
        ...requestMetadata(`wait-missing:${sandboxId}`),
        sandboxId,
        processId: missing.processId,
      }));
      expect(missingResult.result.exitCode).toBe(127);
      expect((await readAllOutput(context.client, sandboxId, missing.processId, 4096)).text).toContain("ENOENT");
    });

    profileTest(harness, ["command.start", "command.detached"], "detached commands follow output and accept idempotent signals", async (context) => {
      const sandboxId = await createSandbox(
        harness,
        context,
        "signals",
        ["command.start", "command.detached"],
      );
      const process = unwrap(await context.client.startCommand({
        ...mutationMetadata(`start-signal:${sandboxId}`),
        sandboxId,
        command: {
          command: "node",
          arguments: ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
          cwd: "/vercel/sandbox",
          environment: {},
        },
        outputLimitBytes: 1024,
      })).process;
      const first = unwrap(await context.client.readCommandOutput({
        ...requestMetadata(`follow:${process.processId}`, Date.now() + 5_000),
        sandboxId,
        processId: process.processId,
        stream: "both",
        cursor: null,
        limitBytes: 1024,
        follow: true,
      }));
      expect(first.chunks.map((chunk) => chunk.data).join("")).toBe("ready");

      const signalMetadata = mutationMetadata(`signal:${process.processId}`);
      unwrap(await context.client.signalProcess({
        ...signalMetadata,
        sandboxId,
        processId: process.processId,
        signal: "SIGTERM",
      }));
      unwrap(await context.client.signalProcess({
        ...signalMetadata,
        requestId: requestId(`retry-signal:${process.processId}`),
        sandboxId,
        processId: process.processId,
        signal: "SIGTERM",
      }));
      const result = unwrap(await context.client.waitForCommand({
        ...requestMetadata(`wait-signalled:${process.processId}`),
        sandboxId,
        processId: process.processId,
      }));
      expect(result.result.exitCode).not.toBe(0);
    });

    profileTest(harness, ["filesystem.mkdir", "filesystem.write", "filesystem.read"], "filesystem supports recursive directories, binary and text pages, idempotent writes, and stable errors", async (context) => {
      const sandboxId = await createSandbox(
        harness,
        context,
        "filesystem",
        ["filesystem.mkdir", "filesystem.write", "filesystem.read"],
      );
      const mkdirMetadata = mutationMetadata(`mkdir:${sandboxId}`);
      const directory = unwrap(await context.client.makeDirectory({
        ...mkdirMetadata,
        sandboxId,
        path: "/vercel/sandbox/data/nested",
        recursive: true,
        mode: 0o750,
      }));
      const directoryRetry = unwrap(await context.client.makeDirectory({
        ...mkdirMetadata,
        requestId: requestId(`retry-mkdir:${sandboxId}`),
        sandboxId,
        path: "/vercel/sandbox/data/nested",
        recursive: true,
        mode: 0o750,
      }));
      expect(directoryRetry).toEqual(directory);

      const writeMetadata = mutationMetadata(`write:${sandboxId}`);
      const binaryWrite = {
        ...writeMetadata,
        sandboxId,
        path: "/vercel/sandbox/data/nested/blob.bin",
        content: { encoding: "base64", data: "AP8BAgM=" } as const,
        mode: 0o640,
      };
      const written = unwrap(await context.client.writeFile(binaryWrite));
      const writeRetry = unwrap(await context.client.writeFile({
        ...binaryWrite,
        requestId: requestId(`retry-write:${sandboxId}`),
      }));
      expect(writeRetry).toEqual(written);

      const first = unwrap(await context.client.readFile({
        ...requestMetadata(`read-first:${sandboxId}`),
        sandboxId,
        path: binaryWrite.path,
        offset: 0,
        limitBytes: 2,
        encoding: "base64",
      }));
      const second = unwrap(await context.client.readFile({
        ...requestMetadata(`read-second:${sandboxId}`),
        sandboxId,
        path: binaryWrite.path,
        offset: first.nextOffset,
        limitBytes: 8,
        encoding: "base64",
      }));
      expect(first).toMatchObject({ content: { encoding: "base64", data: "AP8=" }, bytesRead: 2, endOfFile: false });
      expect(second).toMatchObject({ content: { encoding: "base64", data: "AQID" }, bytesRead: 3, endOfFile: true });

      unwrap(await context.client.writeFile({
        ...mutationMetadata(`write-text:${sandboxId}`),
        sandboxId,
        path: "/vercel/sandbox/data/nested/text.txt",
        content: { encoding: "utf8", data: "hello" },
        mode: null,
      }));
      expect(unwrap(await context.client.readFile({
        ...requestMetadata(`read-text:${sandboxId}`),
        sandboxId,
        path: "/vercel/sandbox/data/nested/text.txt",
        offset: 0,
        limitBytes: 16,
        encoding: "utf8",
      })).content).toEqual({ encoding: "utf8", data: "hello" });

      const missing = await context.client.readFile({
        ...requestMetadata(`read-missing:${sandboxId}`),
        sandboxId,
        path: "/vercel/sandbox/missing",
        offset: 0,
        limitBytes: 16,
        encoding: "base64",
      });
      expect(missing).toMatchObject({
        ok: false,
        error: {
          category: "not-found",
          details: { type: "file", code: "ENOENT", path: "/vercel/sandbox/missing" },
        },
      });
    });

    profileTest(harness, ["filesystem.write", "filesystem.read"], "expired filesystem writes abort before changing the target", async (context) => {
      const sandboxId = await createSandbox(
        harness,
        context,
        "filesystem-deadline",
        ["filesystem.write", "filesystem.read"],
      );
      const path = "/vercel/sandbox/unchanged.txt";
      unwrap(await context.client.writeFile({
        ...mutationMetadata(`initial-write:${sandboxId}`),
        sandboxId,
        path,
        content: { encoding: "utf8", data: "before" },
        mode: null,
      }));
      const expired = await context.client.writeFile({
        ...mutationMetadata(`expired-write:${sandboxId}`),
        deadline: { expiresAt: 0 },
        sandboxId,
        path,
        content: { encoding: "utf8", data: "after" },
        mode: null,
      });
      expect(expired).toMatchObject({ ok: false, error: { category: "deadline-exceeded" } });
      expect(unwrap(await context.client.readFile({
        ...requestMetadata(`verify-abort:${sandboxId}`),
        sandboxId,
        path,
        offset: 0,
        limitBytes: 16,
        encoding: "utf8",
      })).content).toEqual({ encoding: "utf8", data: "before" });
    });

    profileTest(harness, ["endpoint.expose"], "endpoint records resolve declared ports and reject unavailable ports", async (context) => {
      const sandboxId = await createSandbox(
        harness,
        context,
        "endpoint",
        ["endpoint.expose"],
        { ports: [3000] },
      );
      const sandbox = unwrap(await context.client.getSandbox({
        ...mutationMetadata(`get-endpoint:${sandboxId}`),
        sandboxId,
        resume: false,
      })).sandbox;
      const endpoint = unwrap(await context.client.getEndpoint({
        ...requestMetadata(`endpoint:${sandboxId}`),
        sandboxId,
        port: 3000,
      })).endpoint;
      expect(endpoint).toMatchObject({
        sandboxId,
        port: 3000,
        protocol: "http",
        visibility: "loopback",
      });
      expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(sandbox.endpoints).toContainEqual(endpoint);
      const unavailable = await context.client.getEndpoint({
        ...requestMetadata(`missing-endpoint:${sandboxId}`),
        sandboxId,
        port: 3001,
      });
      expect(unavailable).toMatchObject({ ok: false, error: { category: "not-found" } });
    });

    profileTest(harness, [], "request deadlines fail without side effects", async (context) => {
      const prefix = harness.uniqueSandboxName("expired-request");
      const result = await context.client.listSandboxes({
        ...requestMetadata(`expired-list:${prefix}`, 0),
        namePrefix: prefix,
        tags: {},
        statuses: [],
        sortBy: "createdAt",
        sortOrder: "asc",
        limit: 1,
        cursor: null,
      });
      expect(result).toMatchObject({ ok: false, error: { category: "deadline-exceeded" } });
    });

    profileTest(harness, ["sandbox.persistence"], "sandbox deadlines extend idempotently and expire", async (context) => {
      const sandboxId = await createSandbox(harness, context, "deadline", ["sandbox.persistence"], {
        persistent: true,
        timeoutMs: 800,
      });
      const initial = unwrap(await context.client.getSandbox({
        ...mutationMetadata(`deadline-get:${sandboxId}`),
        sandboxId,
        resume: false,
      })).sandbox;
      expect(initial.expiresAt).not.toBeNull();
      const extensionMetadata = mutationMetadata(`extend:${sandboxId}`);
      const extended = unwrap(await context.client.extendSandboxDeadline({
        ...extensionMetadata,
        sandboxId,
        additionalMilliseconds: 800,
      })).sandbox;
      const retry = unwrap(await context.client.extendSandboxDeadline({
        ...extensionMetadata,
        requestId: requestId(`retry-extend:${sandboxId}`),
        sandboxId,
        additionalMilliseconds: 800,
      })).sandbox;
      expect(extended.expiresAt).toBe((initial.expiresAt ?? 0) + 800);
      expect(retry.expiresAt).toBe(extended.expiresAt);
      await waitForStatus(context.client, sandboxId, "stopped", 5_000);
    });

    profileTest(harness, ["sandbox.resource-limits"], "resource limits are visible in sandbox records", async (context) => {
      const sandboxId = await createSandbox(
        harness,
        context,
        "resources",
        ["sandbox.resource-limits"],
        { resources: { vcpus: 1, memoryBytes: 2_147_483_648 } },
      );
      const record = unwrap(await context.client.getSandbox({
        ...mutationMetadata(`get-resources:${sandboxId}`),
        sandboxId,
        resume: false,
      })).sandbox;
      expect(record.resources).toEqual({ vcpus: 1, memoryBytes: 2_147_483_648 });
    });

    for (const policy of ["allow-all", "deny-all"] as const) {
      const networkCapability = `sandbox.network.${policy}` as const;
      profileTest(harness, [networkCapability, "command.start"], `${policy} networking matches the declared isolation policy`, async (context) => {
        const sandboxId = await createSandbox(
          harness,
          context,
          `network-${policy}`,
          [networkCapability, "command.start"],
          { networkPolicy: policy },
        );
        const process = unwrap(await context.client.startCommand({
          ...mutationMetadata(`network-command:${sandboxId}`),
          sandboxId,
          command: {
            command: "node",
            arguments: [
              "-e",
              "const os=require('node:os');const n=Object.values(os.networkInterfaces()).flat().filter(Boolean).filter(x=>!x.internal).length;process.stdout.write(String(n))",
            ],
            cwd: "/vercel/sandbox",
            environment: {},
          },
          outputLimitBytes: 128,
        })).process;
        unwrap(await context.client.waitForCommand({
          ...requestMetadata(`wait-network:${sandboxId}`),
          sandboxId,
          processId: process.processId,
        }));
        const output = Number((await readAllOutput(context.client, sandboxId, process.processId, 128)).text);
        if (policy === "allow-all") expect(output).toBeGreaterThan(0);
        else expect(output).toBe(0);
      });
    }

    for (const sourceType of ["git", "tarball"] as const) {
      const sourceCapability = `sandbox.source.${sourceType}` as const;
      profileTest(harness, [sourceCapability, "filesystem.read"], `${sourceType} sources materialize into the workspace`, async (context) => {
        const source = harness.sourceFixtures?.[sourceType];
        if (source === undefined) {
          throw new Error(`${harness.name} advertises ${sourceCapability} without a conformance source fixture.`);
        }
        const sandboxId = await createSandbox(
          harness,
          context,
          `source-${sourceType}`,
          [sourceCapability, "filesystem.read"],
          { source },
        );
        const result = await context.client.readFile({
          ...requestMetadata(`read-source:${sandboxId}`),
          sandboxId,
          path: sourceType === "git" ? "/vercel/sandbox/README" : "/vercel/sandbox/fixture.txt",
          offset: 0,
          limitBytes: 4096,
          encoding: "utf8",
        });
        expect(result).toMatchObject({ ok: true, value: { bytesRead: expect.any(Number) } });
        if (result.ok) expect(result.value.bytesRead).toBeGreaterThan(0);
      });
    }

    profileTest(harness, ["command.start", "command.detached", "endpoint.expose"], "deletion cleans commands, endpoints, and sandbox resources", async (context) => {
      const sandboxId = await createSandbox(
        harness,
        context,
        "cleanup",
        ["command.start", "command.detached", "endpoint.expose"],
        { ports: [3000] },
      );
      const process = unwrap(await context.client.startCommand({
        ...mutationMetadata(`cleanup-command:${sandboxId}`),
        sandboxId,
        command: {
          command: "node",
          arguments: ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
          cwd: "/vercel/sandbox",
          environment: {},
        },
        outputLimitBytes: 1024,
      })).process;
      unwrap(await context.client.readCommandOutput({
        ...requestMetadata(`cleanup-ready:${sandboxId}`, Date.now() + 5_000),
        sandboxId,
        processId: process.processId,
        stream: "both",
        cursor: null,
        limitBytes: 1024,
        follow: true,
      }));
      const waiting = context.client.waitForCommand({
        ...requestMetadata(`cleanup-wait:${sandboxId}`),
        sandboxId,
        processId: process.processId,
      });
      unwrap(await context.client.deleteSandbox({
        ...mutationMetadata(`cleanup-delete:${sandboxId}`),
        sandboxId,
      }));
      await expect(waiting).resolves.toMatchObject({ ok: false, error: { category: "cancelled" } });
      await expect(context.client.readCommandOutput({
        ...requestMetadata(`cleanup-output:${sandboxId}`),
        sandboxId,
        processId: process.processId,
        stream: "both",
        cursor: null,
        limitBytes: 1024,
        follow: false,
      })).resolves.toMatchObject({ ok: false, error: { category: "not-found" } });
      await expect(context.client.getEndpoint({
        ...requestMetadata(`cleanup-endpoint:${sandboxId}`),
        sandboxId,
        port: 3000,
      })).resolves.toMatchObject({ ok: false, error: { category: "not-found" } });
      await expect(context.client.getSandbox({
        ...mutationMetadata(`cleanup-get:${sandboxId}`),
        sandboxId,
        resume: false,
      })).resolves.toMatchObject({ ok: false, error: { category: "not-found" } });
    });
  });
}
