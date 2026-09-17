import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { ProcessBackend } from "../../src/backends/process/index.js";
import { PROCESS_SUPERVISOR_PROGRAM } from "../../src/backends/process/supervisor.js";
import { EmbeddedSandboxClient } from "../../src/runtime/embedded.js";
import type {
  ClientResult,
  CreateSandboxRequest,
  JsonObject,
  RawCommand,
  RawCommandEvent,
  SandboxClient,
  SandboxSpec,
} from "../../src/runtime/index.js";

const TEST_TIMEOUT_MS = 30_000;
let sequence = 0;

function metadata(label: string) {
  sequence += 1;
  return {
    requestId: `process-test:${label}:${sequence}`,
    idempotencyKey: `process-test:key:${label}:${sequence}`,
    deadline: { expiresAt: Date.now() + 10_000 },
  } as const;
}

function spec(name: string, overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  const base: SandboxSpec = {
    name,
    bootSource: { type: "runtime", runtime: "host" },
    source: null,
    persistent: true,
    timeoutMs: 20_000,
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

async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  // These integration checks observe real POSIX process-table transitions;
  // fake timers cannot advance kernel signal delivery or process reaping.
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`Condition was not observed within ${timeoutMs}ms.`);
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(" ");
      return fields[2] !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

async function readRaw(raw: RawCommand): Promise<RawCommandEvent[]> {
  const events: RawCommandEvent[] = [];
  for await (const event of raw.events) events.push(event);
  return events;
}

async function readCommandText(client: SandboxClient, sandboxId: string, processId: string): Promise<string> {
  let cursor: string | null = null;
  let complete = false;
  let text = "";
  while (!complete) {
    const page = unwrap(await client.readCommandOutput({
      requestId: `process-test:output:${randomUUID()}`,
      deadline: { expiresAt: Date.now() + 10_000 },
      sandboxId,
      processId,
      stream: "both",
      cursor,
      limitBytes: 4096,
      follow: true,
    }));
    text += page.chunks.map((chunk) => chunk.data).join("");
    cursor = page.nextCursor;
    complete = page.complete;
  }
  return text;
}

async function cleanupClient(client: SandboxClient, sandboxId: string): Promise<void> {
  await client.deleteSandbox({ ...metadata(`cleanup:${sandboxId}`), sandboxId });
}

describe("ProcessBackend", () => {
  test("rejects unsupported guarantees before allocating a sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-process-rejection-"));
    try {
      const backend = new ProcessBackend({ root: join(root, "backend"), instanceId: "rejection" });
      const client = new EmbeddedSandboxClient(backend, { stateRoot: join(root, "state") });
      const name = `rejected-${randomUUID()}`;
      const result = await client.createSandbox({
        ...createRequest(name, { bootSource: { type: "image", image: "node:24" } }),
        requirements: [{
          type: "isolation",
          minimumLevel: "shared-kernel-container",
          tenancy: "single-tenant",
          acceptableSupport: ["partial"],
        }],
      });
      expect(result).toMatchObject({ ok: false, error: { category: "unsupported-requirement" } });
      const listed = unwrap(await client.listSandboxes({
        requestId: `process-test:list:${randomUUID()}`,
        deadline: null,
        namePrefix: name,
        tags: {},
        statuses: [],
        sortBy: "name",
        sortOrder: "asc",
        limit: 10,
        cursor: null,
      }));
      expect(listed.sandboxes).toEqual([]);
      expect(backend.capabilities).toMatchObject({
        isolation: { support: "partial", constraints: { level: "process", tenancies: ["trusted"] } },
        networking: { constraints: { modes: ["allow-all"], portExposure: [], customPolicies: false } },
        resources: { support: "unsupported" },
        terminals: { support: "unsupported" },
        snapshots: { support: "unsupported" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("preserves workspace state across stop, resume, and backend reconstruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-process-recovery-"));
    const name = `recovery-${randomUUID()}`;
    try {
      const options = { root: join(root, "backend"), instanceId: "recovery" } as const;
      const client = new EmbeddedSandboxClient(new ProcessBackend(options), { stateRoot: join(root, "state") });
      unwrap(await client.createSandbox(createRequest(name));
      unwrap(await client.writeFile({
        ...metadata(`write:${name}`),
        sandboxId: name,
        path: "/vercel/sandbox/persisted.txt",
        content: { encoding: "utf8", data: "survives" },
        mode: null,
      }));
      expect(unwrap(await client.stopSandbox({ ...metadata(`stop:${name}`), sandboxId: name })).sandbox.status).toBe("stopped");

      const reconstructed = new EmbeddedSandboxClient(new ProcessBackend(options), { stateRoot: join(root, "state") });
      expect(unwrap(await reconstructed.getSandbox({
        ...metadata(`resume:${name}`),
        sandboxId: name,
        resume: true,
      })).sandbox.status).toBe("running");
      expect(unwrap(await reconstructed.readFile({
        requestId: `process-test:read:${randomUUID()}`,
        deadline: null,
        sandboxId: name,
        path: "/vercel/sandbox/persisted.txt",
        offset: 0,
        limitBytes: 32,
        encoding: "utf8",
      })).content).toEqual({ encoding: "utf8", data: "survives" });
      await cleanupClient(reconstructed, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("preserves direct argv, sandbox and command environment, cwd, and raw stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-process-command-"));
    const name = `command-${randomUUID()}`;
    try {
      const backend = new ProcessBackend({ root: join(root, "backend"), instanceId: "command" });
      const client = new EmbeddedSandboxClient(backend, { stateRoot: join(root, "state") });
      unwrap(await client.createSandbox(createRequest(name, { environment: { SANDBOX_VALUE: "sandbox" } })));
      unwrap(await client.makeDirectory({
        ...metadata(`mkdir:${name}`),
        sandboxId: name,
        path: "/vercel/sandbox/nested",
        recursive: false,
        mode: null,
      }));
      const started = unwrap(await client.startCommand({
        ...metadata(`command:${name}`),
        sandboxId: name,
        command: {
          command: process.execPath,
          arguments: [
            "-e",
            "process.stdout.write(JSON.stringify({argv:process.argv.slice(1),sandbox:process.env.SANDBOX_VALUE,command:process.env.COMMAND_VALUE,cwd:process.cwd()}))",
            "space value",
            "$literal;not-shell",
          ],
          cwd: "/vercel/sandbox/nested",
          environment: { COMMAND_VALUE: "command" },
        },
        outputLimitBytes: 4096,
      }));
      unwrap(await client.waitForCommand({
        requestId: `process-test:wait:${randomUUID()}`,
        deadline: { expiresAt: Date.now() + 10_000 },
        sandboxId: name,
        processId: started.process.processId,
      }));
      expect(JSON.parse(await readCommandText(client, name, started.process.processId))).toMatchObject({
        argv: ["space value", "$literal;not-shell"],
        sandbox: "sandbox",
        command: "command",
      });

      const raw = await backend.startRawCommand({
        requestId: `process-test:raw:${randomUUID()}`,
        deadline: { expiresAt: Date.now() + 10_000 },
        sandboxId: name,
        command: {
          command: process.execPath,
          arguments: ["-e", "process.stdin.pipe(process.stdout)"],
          cwd: "/vercel/sandbox",
          environment: {},
        },
        input: { encoding: "utf8", data: "stdin payload" },
      });
      if (!raw.ok) throw new Error(raw.error.message);
      const events = await readRaw(raw.command);
      expect(events.filter((event) => event.type === "stdout").map((event) => event.data).join("")).toBe("stdin payload");
      expect(events.at(-1)).toMatchObject({ type: "complete", exitCode: 0 });
      await cleanupClient(client, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("handles startup aborts and signal/completion races without duplicate terminals", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-process-races-"));
    const name = `races-${randomUUID()}`;
    try {
      const backend = new ProcessBackend({ root: join(root, "backend"), instanceId: "races" });
      unwrap(await backend.createSandbox(createRequest(name)));
      const aborted = new AbortController();
      aborted.abort();
      const cancelled = await backend.startRawCommand({
        requestId: `process-test:aborted:${randomUUID()}`,
        deadline: { expiresAt: Date.now() + 10_000 },
        sandboxId: name,
        command: {
          command: process.execPath,
          arguments: ["-e", ""],
          cwd: "/vercel/sandbox",
          environment: {},
        },
      }, aborted.signal);
      expect(cancelled).toMatchObject({ ok: false, error: { category: "cancelled" } });

      const started = await backend.startRawCommand({
        requestId: `process-test:race:${randomUUID()}`,
        deadline: { expiresAt: Date.now() + 10_000 },
        sandboxId: name,
        command: {
          command: process.execPath,
          arguments: ["-e", "setImmediate(()=>{})"],
          cwd: "/vercel/sandbox",
          environment: {},
        },
      });
      if (!started.ok) throw new Error(started.error.message);
      const eventsPromise = readRaw(started.command);
      await started.command.signal("SIGTERM").catch(() => undefined);
      const events = await eventsPromise;
      expect(events.filter((event) => event.type === "complete" || event.type === "backend-failure")).toHaveLength(1);
      unwrap(await backend.deleteSandbox({ ...metadata(`delete-race:${name}`), sandboxId: name }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("maps filesystem paths without exposing or following host escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-process-filesystem-"));
    const name = `filesystem-${randomUUID()}`;
    try {
      const backend = new ProcessBackend({ root: join(root, "backend"), instanceId: "filesystem" });
      const client = new EmbeddedSandboxClient(backend, { stateRoot: join(root, "state") });
      unwrap(await client.createSandbox(createRequest(name)));
      const outside = join(root, "outside-secret.txt");
      await writeFile(outside, "secret", { mode: 0o600 });
      const workspace = await backend.filesystemWorkspace(name);
      await symlink(outside, join(workspace.root, "escape"));

      const result = await client.readFile({
        requestId: `process-test:escape:${randomUUID()}`,
        deadline: null,
        sandboxId: name,
        path: "/vercel/sandbox/escape",
        offset: 0,
        limitBytes: 32,
        encoding: "utf8",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { details: { type: "file", code: "EACCES", path: "/vercel/sandbox/escape" } },
      });
      if (!result.ok) expect(result.error.message).not.toContain(root);

      const traversal = await client.readFile({
        requestId: `process-test:traversal:${randomUUID()}`,
        deadline: null,
        sandboxId: name,
        path: "/vercel/sandbox/../../outside-secret.txt",
        offset: 0,
        limitBytes: 32,
        encoding: "utf8",
      });
      expect(traversal).toMatchObject({ ok: false, error: { details: { code: "EACCES" } } });
      await cleanupClient(client, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("keeps explicit backend instances isolated below one root", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-process-instances-"));
    const name = `shared-name-${randomUUID()}`;
    try {
      const first = new ProcessBackend({ root, instanceId: "first" });
      const second = new ProcessBackend({ root, instanceId: "second" });
      expect(first.reference).not.toEqual(second.reference);
      const firstResult = unwrap(await first.createSandbox(createRequest(name)));
      const secondResult = unwrap(await second.createSandbox(createRequest(name)));
      expect(firstResult.sandbox.backend).toEqual(first.reference);
      expect(secondResult.sandbox.backend).toEqual(second.reference);
      unwrap(await first.deleteSandbox({ ...metadata(`delete-first:${name}`), sandboxId: name }));
      expect(unwrap(await second.getSandbox({ ...metadata(`get-second:${name}`), sandboxId: name, resume: false })).sandbox.status).toBe("running");
      unwrap(await second.deleteSandbox({ ...metadata(`delete-second:${name}`), sandboxId: name }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("delete terminates the command process group including descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-process-group-"));
    const name = `group-${randomUUID()}`;
    let descendantPid: number | undefined;
    try {
      const client = new EmbeddedSandboxClient(
        new ProcessBackend({ root: join(root, "backend"), instanceId: "group" }),
        { stateRoot: join(root, "state") },
      );
      unwrap(await client.createSandbox(createRequest(name)));
      const childProgram = "setInterval(()=>{},1000)";
      const parentProgram = "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',process.argv[1]],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1000)";
      const started = unwrap(await client.startCommand({
        ...metadata(`start-group:${name}`),
        sandboxId: name,
        command: {
          command: process.execPath,
          arguments: ["-e", parentProgram, childProgram],
          cwd: "/vercel/sandbox",
          environment: {},
        },
        outputLimitBytes: 128,
      }));
      const firstOutput = unwrap(await client.readCommandOutput({
        requestId: `process-test:group-output:${randomUUID()}`,
        deadline: { expiresAt: Date.now() + 10_000 },
        sandboxId: name,
        processId: started.process.processId,
        stream: "stdout",
        cursor: null,
        limitBytes: 128,
        follow: true,
      }));
      descendantPid = Number(firstOutput.chunks.map((chunk) => chunk.data).join(""));
      expect(await processIsAlive(descendantPid)).toBe(true);
      unwrap(await client.deleteSandbox({ ...metadata(`delete-group:${name}`), sandboxId: name }));
      await pollUntil(async () => !(await processIsAlive(descendantPid!)));
    } finally {
      if (descendantPid !== undefined && await processIsAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  test("the supervisor watchdog cleans descendants after abrupt parent death", async () => {
    const root = await mkdtemp(join(tmpdir(), "localbox-process-watchdog-"));
    const supervisorPidFile = join(root, "supervisor.pid");
    const descendantPidFile = join(root, "descendant.pid");
    const targetProgram = "const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)";
    const helperProgram = "const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const program=Buffer.from(process.argv[1],'base64').toString('utf8');const supervisor=spawn(process.execPath,['--input-type=module','-e',program,String(process.pid)],{stdio:['ignore','ignore','ignore','ipc']});writeFileSync(process.argv[2],String(supervisor.pid));supervisor.on('message',m=>{if(m?.type==='supervisor-ready')supervisor.send({type:'start',command:{command:process.execPath,arguments:['-e',process.argv[4],process.argv[3]],cwd:process.cwd(),environment:process.env},input:null})});setInterval(()=>{},1000)";
    const helper = spawn(process.execPath, [
      "-e",
      helperProgram,
      Buffer.from(PROCESS_SUPERVISOR_PROGRAM).toString("base64"),
      supervisorPidFile,
      descendantPidFile,
      targetProgram,
    ], { stdio: "ignore", shell: false });
    let supervisorPid: number | undefined;
    let descendantPid: number | undefined;
    try {
      await pollUntil(async () => {
        try {
          supervisorPid = Number(await readFile(supervisorPidFile, "utf8"));
          descendantPid = Number(await readFile(descendantPidFile, "utf8"));
          return Number.isSafeInteger(supervisorPid) && Number.isSafeInteger(descendantPid);
        } catch {
          return false;
        }
      });
      expect(await processIsAlive(supervisorPid!)).toBe(true);
      expect(await processIsAlive(descendantPid!)).toBe(true);
      helper.kill("SIGKILL");
      await pollUntil(async () => !(await processIsAlive(supervisorPid!)) && !(await processIsAlive(descendantPid!)), 10_000);
    } finally {
      helper.kill("SIGKILL");
      for (const pid of [supervisorPid, descendantPid]) {
        if (pid !== undefined && await processIsAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
