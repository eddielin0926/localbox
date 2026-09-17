import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapBackend, EmbeddedSandboxClient } from "../dist/runtime/index.js";

const root = await mkdtemp(join(tmpdir(), "localbox-bwrap-smoke-"));
const sentinel = join(root, "host-sentinel.txt");
const sandboxId = `bwrap-smoke-${process.pid}`;
const metadata = (label) => ({
  requestId: `smoke:${label}`,
  idempotencyKey: `smoke:${label}`,
  deadline: { expiresAt: Date.now() + 20_000 },
});
const unwrap = (result) => {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message}`);
};

await writeFile(sentinel, "must-not-be-visible", { mode: 0o600 });
const backend = new BwrapBackend({ root: join(root, "backend"), instanceId: "smoke" });
const client = new EmbeddedSandboxClient(backend, { stateRoot: join(root, "state") });

try {
  const availability = unwrap(await backend.probeAvailability({ requestId: "smoke:probe", deadline: null }));
  if (availability.availability.status !== "available") {
    throw new Error(`Bwrap unavailable: ${availability.availability.diagnostics.map(({ code }) => code).join(", ")}`);
  }
  unwrap(await client.createSandbox({
    ...metadata("create"),
    sandboxId,
    backend: null,
    requirements: [
      { type: "operation", operation: "command.start", acceptableSupport: ["native"] },
      { type: "operation", operation: "filesystem.write", acceptableSupport: ["native"] },
      { type: "operation", operation: "filesystem.read", acceptableSupport: ["native"] },
      { type: "isolation", minimumLevel: "namespace-sandbox", tenancy: "single-tenant", acceptableSupport: ["native"] },
    ],
    spec: {
      name: sandboxId,
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
      tags: { smoke: "bwrap" },
      ports: [],
      networkPolicy: "deny-all",
      resources: { vcpus: null, memoryBytes: null },
      region: null,
      failoverRegions: [],
    },
  }));
  unwrap(await client.writeFile({
    ...metadata("write"),
    sandboxId,
    path: "/vercel/sandbox/input.txt",
    content: { encoding: "utf8", data: "bwrap-backend" },
    mode: null,
  }));
  const started = unwrap(await client.startCommand({
    ...metadata("command"),
    sandboxId,
    command: {
      command: process.execPath,
      arguments: [
        "-e",
        "const fs=require('node:fs');const host=process.argv[1];const visible=fs.existsSync(host);const text=fs.readFileSync('input.txt','utf8').toUpperCase();fs.writeFileSync('output.txt',text);process.stdout.write(JSON.stringify({text,visible}))",
        sentinel,
      ],
      cwd: "/vercel/sandbox",
      environment: {},
    },
    outputLimitBytes: 1024,
  }));
  const completed = unwrap(await client.waitForCommand({
    requestId: "smoke:wait",
    deadline: { expiresAt: Date.now() + 20_000 },
    sandboxId,
    processId: started.process.processId,
  }));
  const output = unwrap(await client.readCommandOutput({
    requestId: "smoke:output",
    deadline: { expiresAt: Date.now() + 20_000 },
    sandboxId,
    processId: started.process.processId,
    stream: "both",
    cursor: null,
    limitBytes: 1024,
    follow: false,
  }));
  const payload = JSON.parse(output.chunks.map((chunk) => chunk.data).join(""));
  const written = unwrap(await client.readFile({
    requestId: "smoke:read",
    deadline: { expiresAt: Date.now() + 20_000 },
    sandboxId,
    path: "/vercel/sandbox/output.txt",
    offset: 0,
    limitBytes: 1024,
    encoding: "utf8",
  }));
  if (completed.result.exitCode !== 0 || payload.text !== "BWRAP-BACKEND" || payload.visible !== false || written.content.data !== "BWRAP-BACKEND") {
    throw new Error("Bubblewrap smoke did not preserve workspace I/O or isolate the host sentinel.");
  }
  unwrap(await client.deleteSandbox({ ...metadata("delete"), sandboxId }));
  const listed = unwrap(await client.listSandboxes({
    requestId: "smoke:list",
    deadline: { expiresAt: Date.now() + 20_000 },
    namePrefix: sandboxId,
    tags: {},
    statuses: [],
    sortBy: "name",
    sortOrder: "asc",
    limit: 10,
    cursor: null,
  }));
  if (listed.sandboxes.length !== 0) throw new Error("Bubblewrap smoke left a sandbox state entry.");
  process.stdout.write("Bubblewrap backend smoke passed.\n");
} finally {
  await client.deleteSandbox({ ...metadata("cleanup"), sandboxId }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
