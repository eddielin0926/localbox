import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BwrapBackend } from "../../src/backends/bwrap/index.js";
import { EmbeddedSandboxClient } from "../../src/runtime/embedded.js";
import type {
  ClientResult,
  CreateSandboxRequest,
  JsonObject,
  SandboxClient,
  SandboxSpec,
} from "../../src/runtime/index.js";

const TEST_TIMEOUT_MS = 120_000;
let sequence = 0;

function metadata(label: string) {
  sequence += 1;
  return {
    requestId: `bwrap-test:${label}:${sequence}`,
    idempotencyKey: `bwrap-test:key:${label}:${sequence}`,
    deadline: { expiresAt: Date.now() + 30_000 },
  } as const;
}

function spec(name: string, overrides: Partial<SandboxSpec> = {}): SandboxSpec {
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
    persistent: true,
    timeoutMs: 30_000,
    environment: {},
    tags: {},
    ports: [],
    networkPolicy: "allow-all",
    resources: { vcpus: null, memoryBytes: null },
    region: null,
    failoverRegions: [],
  };
  return { ...base, ...overrides, name, resources: overrides.resources ?? base.resources };
}

function createRequest(name: string, overrides: Partial<SandboxSpec> = {}): CreateSandboxRequest {
  return {
    ...metadata(`create:${name}`),
    sandboxId: name,
    backend: null,
    requirements: [],
    spec: spec(name, overrides),
  };
}

function unwrap<T extends JsonObject>(result: ClientResult<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

async function commandText(
  client: SandboxClient,
  sandboxId: string,
  source: string,
  arguments_: readonly string[] = [],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const started = unwrap(await client.startCommand({
    ...metadata(`command:${sandboxId}`),
    sandboxId,
    command: {
      command: process.execPath,
      arguments: ["-e", source, ...arguments_],
      cwd: "/vercel/sandbox",
      environment,
    },
    outputLimitBytes: 64 * 1024,
  }));
  const completed = unwrap(await client.waitForCommand({
    requestId: `bwrap-test:wait:${randomUUID()}`,
    deadline: { expiresAt: Date.now() + 30_000 },
    sandboxId,
    processId: started.process.processId,
  }));
  const output = unwrap(await client.readCommandOutput({
    requestId: `bwrap-test:output:${randomUUID()}`,
    deadline: { expiresAt: Date.now() + 30_000 },
    sandboxId,
    processId: started.process.processId,
    stream: "both",
    cursor: null,
    limitBytes: 64 * 1024,
    follow: false,
  }));
  return {
    exitCode: completed.result.exitCode,
    output: output.chunks.map((chunk) => chunk.data).join(""),
  };
}

async function cleanup(client: SandboxClient, sandboxId: string): Promise<void> {
  await client.deleteSandbox({ ...metadata(`cleanup:${sandboxId}`), sandboxId }).catch(() => undefined);
}

describe("BwrapBackend", () => {
  test("reports a successful real namespace probe and an honest capability boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-bwrap-probe-"));
    try {
      const backend = new BwrapBackend({ root: join(root, "backend"), instanceId: "probe" });
      const result = unwrap(await backend.probeAvailability({ requestId: "bwrap-probe", deadline: null }));
      expect(result.availability.status).toBe("available");
      expect(result.availability.diagnostics).toContainEqual(expect.objectContaining({ code: "BWRAP_PREREQUISITES_AVAILABLE" }));
      expect(backend.capabilities).toMatchObject({
        isolation: { support: "native", constraints: { level: "namespace-sandbox", tenancies: ["trusted", "single-tenant"] } },
        networking: { support: "native", constraints: { modes: ["allow-all", "deny-all"], portExposure: [] } },
        resources: { support: "unsupported" },
        terminals: { support: "unsupported" },
        snapshots: { support: "unsupported" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("classifies namespace probe failures without exposing host stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-bwrap-classify-"));
    const cases = [
      ["apparmor denied user namespace", "BWRAP_APPARMOR_RESTRICTED"],
      ["No permissions to create new namespace", "BWRAP_USER_NAMESPACE_DISABLED"],
      ["Operation not permitted", "BWRAP_PERMISSION_DENIED"],
      ["Unknown option --unshare-cgroup-try", "BWRAP_VERSION_INCOMPATIBLE"],
      ["opaque private failure detail", "BWRAP_PROBE_FAILED"],
    ] as const;
    try {
      for (const [stderr, code] of cases) {
        const binary = join(root, `fake-bwrap-${randomUUID()}`);
        await writeFile(binary, [
          `#!${process.execPath}`,
          "if (process.argv.includes('--version')) { process.stdout.write('bubblewrap 0.8.0\\n'); process.exit(0); }",
          `process.stderr.write(${JSON.stringify(stderr)});`,
          "process.exit(1);",
          "",
        ].join("\n"), { mode: 0o755 });
        const backend = new BwrapBackend({
          root: join(root, `backend-${randomUUID()}`),
          instanceId: `classify-${code}`,
          binaryPath: binary,
        });
        const result = unwrap(await backend.probeAvailability({
          requestId: `classify:${code}`,
          deadline: null,
        }));
        expect(result.availability.status).toBe("unavailable");
        expect(result.availability.diagnostics).toContainEqual(expect.objectContaining({ code }));
        expect(JSON.stringify(result.availability)).not.toContain("opaque private failure detail");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("rejects unsupported artifacts and ports before backend allocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-bwrap-reject-"));
    try {
      const backendRoot = join(root, "backend");
      const client = new EmbeddedSandboxClient(
        new BwrapBackend({ root: backendRoot, instanceId: "reject" }),
        { stateRoot: join(root, "state") },
      );
      const name = `reject-${randomUUID()}`;
      const result = await client.createSandbox(createRequest(name, {
        bootArtifact: {
          kind: "oci-image",
          locator: { type: "oci-reference", reference: "node:24" },
          digest: null,
          trust: "untrusted",
          mutability: "mutable",
          platform: null,
        },
        ports: [3000],
      }));
      expect(result).toMatchObject({ ok: false, error: { category: "unsupported-requirement" } });
      await expect(readFile(join(backendRoot, "instances"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("preserves argv, environment, cwd, stdin-backed filesystem operations, and blocks host/sibling escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-bwrap-security-"));
    const backendRoot = join(root, "backend");
    const stateRoot = join(root, "state");
    const sentinel = join(root, "host-sentinel.txt");
    const homeSentinel = join(homedir(), `.localbox-bwrap-sentinel-${randomUUID()}`);
    await writeFile(sentinel, "host-secret", { mode: 0o600 });
    await writeFile(homeSentinel, "home-secret", { mode: 0o600 });
    const first = `first-${randomUUID()}`;
    const sibling = `sibling-${randomUUID()}`;
    const client = new EmbeddedSandboxClient(
      new BwrapBackend({ root: backendRoot, instanceId: "security" }),
      { stateRoot },
    );
    try {
      unwrap(await client.createSandbox(createRequest(first, { environment: { SANDBOX_VALUE: "sandbox" } })));
      unwrap(await client.createSandbox(createRequest(sibling)));
      unwrap(await client.writeFile({
        ...metadata(`write:${sibling}`), sandboxId: sibling, path: "/vercel/sandbox/sibling.txt",
        content: { encoding: "utf8", data: "sibling-secret" }, mode: null,
      }));
      unwrap(await client.makeDirectory({
        ...metadata(`mkdir:${first}`), sandboxId: first, path: "/vercel/sandbox/nested", recursive: false, mode: null,
      }));
      unwrap(await client.writeFile({
        ...metadata(`write:${first}`), sandboxId: first, path: "/vercel/sandbox/nested/input.txt",
        content: { encoding: "utf8", data: "namespace-data" }, mode: null,
      }));
      unwrap(await client.runFilesystemOperation({
        ...metadata(`symlink:${first}`),
        sandboxId: first,
        operation: "symlink",
        arguments: { target: sentinel, path: "/vercel/sandbox/escape" },
        content: null,
      }));

      const script = "const fs=require('node:fs');const paths=JSON.parse(process.argv[1]);const visible=paths.filter(p=>{try{return fs.readFileSync(p,'utf8').includes('secret')}catch{return false}});const input=fs.readFileSync('nested/input.txt','utf8');process.stdout.write(JSON.stringify({argv:process.argv.slice(2),env:process.env.SANDBOX_VALUE,cmd:process.env.COMMAND_VALUE,cwd:process.cwd(),input,visible}))";
      const executed = await commandText(client, first, script, [
        JSON.stringify([sentinel, homeSentinel, "/etc/passwd", "/vercel/sandbox/escape", "/vercel/sandbox/../sibling.txt"]),
        "space value",
        "$literal;not-shell",
      ], { COMMAND_VALUE: "command" });
      expect(executed.exitCode).toBe(0);
      expect(JSON.parse(executed.output)).toEqual({
        argv: ["space value", "$literal;not-shell"],
        env: "sandbox",
        cmd: "command",
        cwd: "/vercel/sandbox",
        input: "namespace-data",
        visible: [],
      });
    } finally {
      await cleanup(client, first);
      await cleanup(client, sibling);
      await rm(homeSentinel, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("retains host networking only for allow-all and fails closed for deny-all", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-bwrap-network-"));
    const server = createServer((socket) => socket.end("reachable"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected an IPv4 test server.");
    const client = new EmbeddedSandboxClient(
      new BwrapBackend({ root: join(root, "backend"), instanceId: "network" }),
      { stateRoot: join(root, "state") },
    );
    const allow = `allow-${randomUUID()}`;
    const deny = `deny-${randomUUID()}`;
    try {
      unwrap(await client.createSandbox(createRequest(allow, { networkPolicy: "allow-all" })));
      unwrap(await client.createSandbox(createRequest(deny, { networkPolicy: "deny-all" })));
      const script = "const net=require('node:net');const s=net.connect(Number(process.argv[1]),'127.0.0.1');s.setTimeout(1000);s.on('connect',()=>{process.stdout.write('connected');s.end()});s.on('timeout',()=>{process.stdout.write('blocked');s.destroy()});s.on('error',()=>process.stdout.write('blocked'))";
      expect((await commandText(client, allow, script, [String(address.port)])).output).toBe("connected");
      expect((await commandText(client, deny, script, [String(address.port)])).output).toBe("blocked");
    } finally {
      await cleanup(client, allow);
      await cleanup(client, deny);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("persists workspace and network policy across stop and backend reconstruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-bwrap-recovery-"));
    const options = { root: join(root, "backend"), instanceId: "recovery" } as const;
    const stateRoot = join(root, "state");
    const name = `recovery-${randomUUID()}`;
    try {
      const first = new EmbeddedSandboxClient(new BwrapBackend(options), { stateRoot });
      unwrap(await first.createSandbox(createRequest(name, { networkPolicy: "deny-all" })));
      unwrap(await first.writeFile({
        ...metadata(`write:${name}`), sandboxId: name, path: "/vercel/sandbox/persisted.txt",
        content: { encoding: "utf8", data: "survives" }, mode: null,
      }));
      unwrap(await first.stopSandbox({ ...metadata(`stop:${name}`), sandboxId: name }));

      const reconstructed = new EmbeddedSandboxClient(new BwrapBackend(options), { stateRoot });
      unwrap(await reconstructed.getSandbox({ ...metadata(`resume:${name}`), sandboxId: name, resume: true }));
      const result = await commandText(reconstructed, name, "const fs=require('node:fs');const os=require('node:os');const external=Object.values(os.networkInterfaces()).flat().filter(Boolean).filter(x=>!x.internal).length;process.stdout.write(fs.readFileSync('persisted.txt','utf8')+':'+external)");
      expect(result.output).toBe("survives:0");
      await cleanup(reconstructed, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
  test("keeps backend instances and same-named workspaces independent", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-bwrap-instances-"));
    const name = `shared-name-${randomUUID()}`;
    const firstBackend = new BwrapBackend({ root: join(root, "backend"), instanceId: "first" });
    const secondBackend = new BwrapBackend({ root: join(root, "backend"), instanceId: "second" });
    const first = new EmbeddedSandboxClient(firstBackend, { stateRoot: join(root, "state-first") });
    const second = new EmbeddedSandboxClient(secondBackend, { stateRoot: join(root, "state-second") });
    try {
      expect(firstBackend.reference).not.toEqual(secondBackend.reference);
      unwrap(await first.createSandbox(createRequest(name)));
      unwrap(await second.createSandbox(createRequest(name)));
      unwrap(await first.writeFile({
        ...metadata("first-write"), sandboxId: name, path: "/vercel/sandbox/value.txt",
        content: { encoding: "utf8", data: "first" }, mode: null,
      }));
      unwrap(await second.writeFile({
        ...metadata("second-write"), sandboxId: name, path: "/vercel/sandbox/value.txt",
        content: { encoding: "utf8", data: "second" }, mode: null,
      }));
      expect((await commandText(first, name, "process.stdout.write(require('node:fs').readFileSync('value.txt','utf8'))")).output).toBe("first");
      expect((await commandText(second, name, "process.stdout.write(require('node:fs').readFileSync('value.txt','utf8'))")).output).toBe("second");
    } finally {
      await cleanup(first, name);
      await cleanup(second, name);
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

});
