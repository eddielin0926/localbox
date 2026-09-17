import Dockerode from "dockerode";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import {
  MANAGED_IMAGES,
  Sandbox,
  SandboxNotFoundError,
} from "../../src/vercel/index.js";
import { dockerContainerName } from "../../src/backends/docker/sandbox.js";

const docker = new Dockerode();
const ownedNames = new Set<string>();

function testName(): string {
  const name = `localbox-test-${randomUUID()}`;
  ownedNames.add(name);
  return name;
}

async function cleanupName(name: string): Promise<void> {
  try {
    const sandbox = await Sandbox.get({ name, resume: false });
    await sandbox.delete();
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) throw error;
  }
}

afterEach(async () => {
  const names = [...ownedNames];
  ownedNames.clear();
  await Promise.all(names.map(cleanupName));
});

afterAll(async () => {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ["dev.localbox.managed=true"] },
  });
  await Promise.all(containers.map(async (summary) => {
    const name = summary.Labels?.["dev.localbox.name"];
    if (name?.startsWith("localbox-test-") === true) {
      await docker.getContainer(summary.Id).remove({ force: true }).catch(() => undefined);
    }
  }));
});

describe("Docker mechanism integration", () => {
  test("executes argv without a shell and preserves split UTF-8 output", async () => {
    const sandbox = await Sandbox.create({
      name: testName(),
      env: { BASE_VALUE: "base" },
      timeout: 30_000,
    });
    await sandbox.fs.mkdir("work");

    const blocking = await sandbox.runCommand({
      cmd: "node",
      args: [
        "-e",
        "const [arg]=process.argv.slice(1);process.stdout.write([arg,process.env.BASE_VALUE,process.env.EXTRA,process.cwd()].join('|'));process.stderr.write('err');process.exitCode=7",
        "$HOME;echo injected",
      ],
      cwd: "work",
      env: { EXTRA: "merged" },
    });
    expect(blocking.exitCode).toBe(7);
    expect(await blocking.stdout()).toBe("$HOME;echo injected|base|merged|/vercel/sandbox/work");
    expect(await blocking.stderr()).toBe("err");

    const utf8 = await sandbox.runCommand("node", [
      "-e",
      "const b=Buffer.from('🙂');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20)",
    ]);
    expect(await utf8.stdout()).toBe("🙂");
  }, 120_000);

  test("maps managed images, resource limits, and deny-all networking to Docker", async () => {
    const name = testName();
    const sandbox = await Sandbox.create({
      name,
      runtime: "node24",
      resources: { vcpus: 1 },
      networkPolicy: "deny-all",
      timeout: 30_000,
    });
    expect(sandbox.image).toBe(MANAGED_IMAGES.node24);

    const info = await docker.getContainer(dockerContainerName(name)).inspect();
    expect(info.Config.Image).toBe(MANAGED_IMAGES.node24);
    expect(info.HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(info.HostConfig.Memory).toBe(2_048 * 1_048_576);
    expect(Object.keys(info.NetworkSettings.Networks)).toHaveLength(0);
  }, 120_000);

  test("publishes declared ports through the Docker host binding", async () => {
    const server = await Sandbox.create({ name: testName(), ports: [3000], timeout: 30_000 });
    await server.fs.writeFile(
      "server.mjs",
      "import{createServer}from'node:http';createServer((_q,r)=>r.end('ok')).listen(3000,'0.0.0')",
    );
    await server.runCommand({ cmd: "node", args: ["server.mjs"], detached: true });

    let body: string | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(server.domain(3000));
        if (response.ok) {
          body = await response.text();
          break;
        }
      } catch {
        // The published port is polled until Docker reports the process ready.
      }
      await delay(40);
    }
    expect(body).toBe("ok");
  }, 120_000);

  test("does not emit unsolicited process or console output", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const sandbox = await Sandbox.create({ name: testName(), timeout: 20_000 });
      await sandbox.runCommand("node", ["-e", "process.stdout.write('captured')"]);
      await sandbox.fs.writeFile("file", "contents");
      await sandbox.fs.readFile("file");
      await sandbox.delete();
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 120_000);
});
