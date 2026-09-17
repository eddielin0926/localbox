import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedSandboxClient, ProcessBackend } from "../dist/runtime/index.js";

const root = await mkdtemp(join(tmpdir(), "localbox-process-smoke-"));
const sandboxId = `process-smoke-${process.pid}`;
const metadata = (label) => ({
  requestId: `smoke:${label}`,
  idempotencyKey: `smoke:${label}`,
  deadline: { expiresAt: Date.now() + 10_000 },
});
const unwrap = (result) => {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message}`);
};

const client = new EmbeddedSandboxClient(
  new ProcessBackend({ root: join(root, "backend"), instanceId: "smoke" }),
  { stateRoot: join(root, "state") },
);

try {
  unwrap(await client.createSandbox({
    ...metadata("create"),
    sandboxId,
    backend: null,
    requirements: [
      { type: "operation", operation: "command.start", acceptableSupport: ["native"] },
      { type: "operation", operation: "filesystem.write", acceptableSupport: ["emulated"] },
      { type: "operation", operation: "filesystem.read", acceptableSupport: ["emulated"] },
      { type: "isolation", minimumLevel: "process", tenancy: "trusted", acceptableSupport: ["partial"] },
      { type: "networking", mode: "allow-all", portExposure: null, customPolicy: false, acceptableSupport: ["partial"] },
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
      persistent: true,
      timeoutMs: 20_000,
      environment: {},
      tags: { smoke: "process" },
      ports: [],
      networkPolicy: "allow-all",
      resources: { vcpus: null, memoryBytes: null },
      region: null,
      failoverRegions: [],
    },
  }));
  unwrap(await client.writeFile({
    ...metadata("write"),
    sandboxId,
    path: "/vercel/sandbox/input.txt",
    content: { encoding: "utf8", data: "process-backend" },
    mode: null,
  }));
  const started = unwrap(await client.startCommand({
    ...metadata("command"),
    sandboxId,
    command: {
      command: process.execPath,
      arguments: ["-e", "const fs=require('node:fs');process.stdout.write(fs.readFileSync('input.txt','utf8').toUpperCase())"],
      cwd: "/vercel/sandbox",
      environment: {},
    },
    outputLimitBytes: 1024,
  }));
  const completed = unwrap(await client.waitForCommand({
    requestId: "smoke:wait",
    deadline: { expiresAt: Date.now() + 10_000 },
    sandboxId,
    processId: started.process.processId,
  }));
  const output = unwrap(await client.readCommandOutput({
    requestId: "smoke:output",
    deadline: { expiresAt: Date.now() + 10_000 },
    sandboxId,
    processId: started.process.processId,
    stream: "both",
    cursor: null,
    limitBytes: 1024,
    follow: false,
  }));
  if (completed.result.exitCode !== 0 || output.chunks.map((chunk) => chunk.data).join("") !== "PROCESS-BACKEND") {
    throw new Error("Process backend smoke output did not match the expected result.");
  }
  process.stdout.write("Process backend smoke passed.\n");
} finally {
  await client.deleteSandbox({ ...metadata("delete"), sandboxId }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
