import Dockerode from "dockerode";
import { randomUUID } from "node:crypto";
import * as localFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import {
  Command,
  MANAGED_IMAGES,
  PortNotExposedError,
  Sandbox,
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
} from "../../src/vercel/index.js";
import { dockerContainerName } from "../../src/backends/docker/sandbox.js";
const docker = new Dockerode();

const ownedNames = new Set<string>();
const TARBALL_SOURCE =
  "data:application/gzip;base64,H4sIAAAAAAACA+3NQQqDMBSE4bf2FJ5AniXoeYJNIaAI8QXE05u6KXSvCP7fZobZzCeullNobDU5ixadc0cW/6n6cr/+3Vtte5Va5QJ5MZ/KvTzTMuc0hHryFlL0Y9zCuxIAAAAAAAAAAAAAAAAAwO3t6qbNcwAoAAA=";

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

describe("Docker-backed sandbox contracts", () => {
  test("runs blocking and detached commands without a shell", async () => {
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

    // Real container writes are required to force Docker to split one UTF-8 code point.
    const utf8 = await sandbox.runCommand("node", [
      "-e",
      "const b=Buffer.from('🙂');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20)",
    ]);
    expect(await utf8.stdout()).toBe("🙂");
    const missing = await sandbox.runCommand("localbox-command-that-does-not-exist");
    expect(missing.exitCode).toBe(127);
    expect(await missing.stderr()).toContain("ENOENT");

    // Real container timers distinguish output produced before and after log subscription.
    const detached = await sandbox.runCommand({
      cmd: "node",
      args: ["-e", "console.log('early');setTimeout(()=>console.log('late'),100);setTimeout(()=>{},180)"],
      detached: true,
    });
    const earlyLogs = detached.logs();
    expect((await earlyLogs.next()).value?.data).toContain("early");
    earlyLogs.close();
    const replayed: string[] = [];
    for await (const chunk of detached.logs()) replayed.push(chunk.data);
    const finished = await detached.wait();
    expect(replayed.join("")).toBe("early\nlate\n");
    expect(await finished.stdout()).toBe("early\nlate\n");
    expect(finished).toBeInstanceOf(Command);
    expect(await finished.wait()).toBe(finished);
    expect(detached.durationMs).toBe(finished.durationMs);
    expect(finished.durationMs).toBeGreaterThan(0);

    const killable = await sandbox.runCommand({
      cmd: "node",
      args: ["-e", "setInterval(()=>console.log('tick'),25)"],
      detached: true,
    });
    const killLogs = killable.logs();
    const firstKillLog = await killLogs.next();
    expect(firstKillLog.value?.data).toContain("tick");
    await killable.kill();
    await killLogs.return(undefined);
    const killed = await killable.wait();
    expect(await killed.stdout()).toContain("tick");
    expect(killed.exitCode).not.toBe(0);

    const abortable = await sandbox.runCommand({
      cmd: "node",
      args: ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
      detached: true,
    });
    const abortLogs = abortable.logs();
    await abortLogs.next();
    await abortLogs.return(undefined);
    const controller = new AbortController();
    const abortedWait = abortable.wait({ signal: controller.signal });
    queueMicrotask(() => controller.abort());
    await expect(abortedWait).rejects.toMatchObject({ name: "AbortError" });
    await expect(abortable.wait()).resolves.toHaveProperty("exitCode");
  }, 120_000);

  test("materializes sources and preserves local create controls", async () => {
    const name = testName();
    const sandbox = await Sandbox.create({
      name,
      runtime: "node24",
      source: { type: "tarball", url: TARBALL_SOURCE },
      resources: { vcpus: 1 },
      networkPolicy: "deny-all",
      tags: { team: "sdk", purpose: "create-contract" },
      region: "iad1",
      failoverRegions: ["sfo1"],
      timeout: 30_000,
    });

    expect(await sandbox.fs.readFile("fixture.txt", "utf8")).toBe("source materialized\n");
    expect(sandbox.tags).toEqual({ team: "sdk", purpose: "create-contract" });
    expect(sandbox.region).toBe("iad1");
    expect(sandbox.failoverRegions).toEqual(["sfo1"]);
    expect(sandbox.vcpus).toBe(1);
    expect(sandbox.memory).toBe(2_048);
    expect(sandbox.runtime).toBe("node24");
    expect(sandbox.image).toBe(MANAGED_IMAGES.node24);
    const fetched = await Sandbox.get({ name });
    expect(fetched.runtime).toBe("node24");
    expect(fetched.image).toBe(MANAGED_IMAGES.node24);

    const info = await docker.getContainer(dockerContainerName(name)).inspect();
    expect(info.HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(info.HostConfig.Memory).toBe(2_048 * 1_048_576);
    expect(Object.keys(info.NetworkSettings.Networks)).toHaveLength(0);
  }, 120_000);

  test("supports binary filesystem operations and compatibility helpers", async () => {
    const name = testName();
    const sandbox = await Sandbox.create({ name, timeout: 30_000 });
    const localDirectory = join(tmpdir(), name);
    try {
      await sandbox.fs.mkdir("data/nested", { recursive: true });
      await sandbox.fs.writeFile("data/nested/a.bin", Buffer.from([0, 255, 1]));
      await sandbox.fs.appendFile("data/nested/a.bin", Buffer.from([2, 3]));
      expect(await sandbox.fs.readFile("data/nested/a.bin")).toEqual(Buffer.from([0, 255, 1, 2, 3]));
      expect(await sandbox.fs.readFile("data/nested/a.bin", "utf8")).toBe("\u0000�\u0001\u0002\u0003");

      await sandbox.fs.rename("data/nested/a.bin", "data/nested/b.bin");
      await sandbox.fs.copyFile("data/nested/b.bin", "data/nested/c.bin");
      await sandbox.fs.chmod("data/nested/c.bin", 0o640);
      await sandbox.fs.access("data/nested/c.bin");
      expect(await sandbox.fs.readdir("data/nested")).toEqual(["b.bin", "c.bin"]);
      expect(await sandbox.fs.exists("data/nested/c.bin")).toBe(true);
      expect(await sandbox.fs.exists("missing")).toBe(false);
      const fileStats = await sandbox.fs.stat("data/nested/c.bin");
      expect(fileStats.isFile()).toBe(true);
      expect(fileStats.mode & 0o777).toBe(0o640);
      await sandbox.fs.chown("data/nested/c.bin", 0, 0);
      expect(await sandbox.fs.stat("data/nested/c.bin")).toMatchObject({ uid: 0, gid: 0 });
      await sandbox.fs.chown("data/nested/c.bin", fileStats.uid, fileStats.gid);
      await sandbox.fs.symlink("c.bin", "data/nested/current");
      expect(await sandbox.fs.readlink("data/nested/current")).toBe("c.bin");
      expect(await sandbox.fs.realpath("data/nested/current")).toBe("/vercel/sandbox/data/nested/c.bin");
      expect((await sandbox.fs.lstat("data/nested/current")).isSymbolicLink()).toBe(true);
      const entries = await sandbox.fs.readdir("data/nested", { withFileTypes: true });
      expect(entries.find((entry) => entry.name === "current")?.isSymbolicLink()).toBe(true);
      await sandbox.fs.copyFile("data/nested/c.bin", "data/nested/truncated.bin");
      await sandbox.fs.truncate("data/nested/truncated.bin", 2);
      expect((await sandbox.fs.stat("data/nested/truncated.bin")).size).toBe(2);
      await sandbox.fs.unlink("data/nested/truncated.bin");
      await sandbox.fs.unlink("data/nested/current");
      const temporary = await sandbox.fs.mkdtemp("data/temp-");
      expect(temporary).toMatch(/^\/vercel\/sandbox\/data\/temp-/);
      await sandbox.fs.rmdir(temporary);
      await expect(sandbox.fs.readFile("missing")).rejects.toMatchObject({ code: "ENOENT" });

      await sandbox.mkDir("helpers");
      await sandbox.writeFiles([
        { path: "helpers/first", content: "first" },
        { path: "helpers/second", content: Buffer.from("second"), mode: 0o600 },
      ]);
      expect(await sandbox.readFileToBuffer({ path: "helpers/first" })).toEqual(Buffer.from("first"));
      expect(await sandbox.readFileToBuffer({ path: "helpers/missing" })).toBeNull();
      const stream = await sandbox.readFile({ path: "helpers/first" });
      const chunks: Buffer[] = [];
      if (stream !== null) {
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks)).toEqual(Buffer.from("first"));
      expect(await sandbox.readFile({ path: "helpers/missing" })).toBeNull();
      const downloaded = await sandbox.downloadFile(
        { path: "data/nested/c.bin" },
        { path: "out/c.bin", cwd: localDirectory },
        { mkdirRecursive: true },
      );
      expect(downloaded).toBe(join(localDirectory, "out/c.bin"));
      expect(await localFs.readFile(downloaded!)).toEqual(Buffer.from([0, 255, 1, 2, 3]));

      await sandbox.fs.rm("data/nested", { recursive: true });
      expect(await sandbox.fs.exists("data/nested")).toBe(false);
    } finally {
      await localFs.rm(localDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  test("lists managed sandboxes with stable pagination", async () => {
    const prefix = `localbox-test-list-${randomUUID()}`;
    const names = [`${prefix}-a`, `${prefix}-b`] as const;
    names.forEach((name) => ownedNames.add(name));
    await Sandbox.create({ name: names[0], timeout: 30_000 });
    const stopped = await Sandbox.create({ name: names[1], timeout: 30_000 });
    await stopped.stop();

    const result = await Sandbox.list({
      namePrefix: prefix,
      sortBy: "name",
      sortOrder: "asc",
      limit: 1,
    });
    expect(result.sandboxes.map((sandbox) => sandbox.name)).toEqual([names[0]]);
    expect(result.pagination).toEqual({ count: 1, next: "1" });

    const pages: string[][] = [];
    for await (const page of result.pages()) {
      pages.push(page.sandboxes.map((sandbox) => sandbox.name));
    }
    expect(pages).toEqual([[names[0]], [names[1]]]);
    expect((await result.toArray()).map((sandbox) => sandbox.status)).toEqual(["running", "stopped"]);

    const iterated: string[] = [];
    for await (const sandbox of result) iterated.push(sandbox.name);
    expect(iterated).toEqual(names);
  }, 120_000);

  test("applies getOrCreate callbacks and persistent lifecycle rules", async () => {
    const name = testName();
    let created = 0;
    let resumed = 0;
    const initial = await Sandbox.getOrCreate({
      name,
      timeout: 30_000,
      onCreate: async (sandbox) => {
        created += 1;
        await sandbox.fs.writeFile("state.bin", Buffer.from([1, 2, 3]));
      },
      onResume: async (sandbox) => {
        resumed += 1;
        const result = await sandbox.runCommand("node", ["-e", "process.stdout.write('resumed')"]);
        expect(await result.stdout()).toBe("resumed");
      },
    });
    expect(created).toBe(1);
    await initial.stop();
    expect(await initial.fs.readFile("state.bin")).toEqual(Buffer.from([1, 2, 3]));
    expect(resumed).toBe(1);
    await initial.stop();

    const existing = await Sandbox.getOrCreate({
      name,
      image: "ignored-invalid-image",
      onCreate: async () => { created += 1; },
      onResume: async (sandbox) => {
        resumed += 1;
        const result = await sandbox.runCommand("node", ["-e", "process.stdout.write('resumed')"]);
        expect(await result.stdout()).toBe("resumed");
      },
    });
    expect(existing.status).toBe("stopped");
    expect(created).toBe(1);
    expect(resumed).toBe(1);
    expect(await existing.fs.readFile("state.bin")).toEqual(Buffer.from([1, 2, 3]));
    expect(resumed).toBe(2);

    await expect(Sandbox.create({ name })).rejects.toBeInstanceOf(SandboxAlreadyExistsError);
    const missingName = testName();
    await expect(Sandbox.get({ name: missingName, resume: false })).rejects.toBeInstanceOf(SandboxNotFoundError);

    const ephemeralName = testName();
    const ephemeral = await Sandbox.create({ name: ephemeralName, persistent: false });
    await ephemeral.stop();
    await expect(Sandbox.get({ name: ephemeralName, resume: false })).rejects.toBeInstanceOf(SandboxNotFoundError);
  }, 120_000);

  test("serves exposed ports and enforces in-container deadlines", async () => {
    const server = await Sandbox.create({ name: testName(), ports: [3000], timeout: 30_000 });
    await server.fs.writeFile(
      "server.mjs",
      "import{createServer}from'node:http';createServer((_q,r)=>r.end('ok')).listen(3000,'0.0.0.0')",
    );
    await server.runCommand({ cmd: "node", args: ["server.mjs"], detached: true });
    let body: string | undefined;
    // Poll the real published port because Docker readiness cannot use fake timers.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(server.domain(3000));
        if (response.ok) {
          body = await response.text();
          break;
        }
      } catch {
        await delay(40);
      }
    }
    expect(body).toBe("ok");
    expect(() => server.domain(3001)).toThrow(PortNotExposedError);

    // The watchdog runs in Docker, so its wall clock must be observed rather than faked.
    const timed = await Sandbox.create({ name: testName(), timeout: 700 });
    while (await timed.refresh() === "running") await delay(20);
    expect(timed.status).toBe("stopped");

    const extended = await Sandbox.create({ name: testName(), timeout: 800 });
    const originalDeadline = extended.expiresAt!.getTime();
    await extended.extendTimeout(800);
    expect(extended.expiresAt!.getTime()).toBe(originalDeadline + 800);
    await delay(Math.max(0, originalDeadline - Date.now() + 100));
    expect(await extended.refresh()).toBe("running");
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
