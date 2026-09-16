import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface ObservedProcess {
  arguments: string[];
  cwd: string;
  environment: string;
  existingPreloadRan: boolean;
  nodeOptions: string;
}

const fixtureDirectory = fileURLToPath(new URL("../fixtures/cli/", import.meta.url));
const projectDirectory = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(projectDirectory, "dist", "cli.js");
const cleanEnvironment = { ...process.env };
delete cleanEnvironment.NODE_OPTIONS;

let temporaryDirectory: string;
let applicationDirectory: string;

function startProcess(
  command: string,
  arguments_: string[],
  options: RunOptions = {},
): ChildProcessWithoutNullStreams {
  return spawn(command, arguments_, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function startCli(arguments_: string[], options: RunOptions = {}): ChildProcessWithoutNullStreams {
  return process.platform === "win32"
    ? startProcess(process.execPath, [cliPath, ...arguments_], options)
    : startProcess(cliPath, arguments_, options);
}

function collectProcess(child: ChildProcessWithoutNullStreams): Promise<ProcessResult> {
  const { promise, reject, resolve } = Promise.withResolvers<ProcessResult>();
  let stderr = "";
  let stdout = "";

  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    resolve({ code, signal, stderr, stdout });
  });

  return promise;
}

function runProcess(
  command: string,
  arguments_: string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return collectProcess(startProcess(command, arguments_, options));
}

function runCli(arguments_: string[], options: RunOptions = {}): Promise<ProcessResult> {
  return collectProcess(startCli(arguments_, options));
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "localbox-cli-"));
  applicationDirectory = join(temporaryDirectory, "application");
  await cp(join(fixtureDirectory, "app"), applicationDirectory, { recursive: true });

  const providerDirectory = join(
    applicationDirectory,
    "node_modules",
    "@vercel",
    "sandbox",
  );
  await mkdir(dirname(providerDirectory), { recursive: true });
  await cp(join(fixtureDirectory, "provider"), providerDirectory, { recursive: true });
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("localbox process wrapper", () => {
  test("requires the separator and an executable", async () => {
    const missingSeparator = await runCli([process.execPath], { env: cleanEnvironment });
    expect(missingSeparator).toMatchObject({ code: 2, signal: null });
    expect(missingSeparator.stderr).toContain("the `--` separator is required");
    expect(missingSeparator.stderr).toContain("Usage: localbox -- <command> [arguments...]");

    const missingExecutable = await runCli(["--"], { env: cleanEnvironment });
    expect(missingExecutable).toMatchObject({ code: 2, signal: null });
    expect(missingExecutable.stderr).toContain("an executable is required after `--`");
  });

  test("rejects an unsupported runtime before starting the command", async () => {
    const result = await runProcess(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(fixtureDirectory, "unsupported-node.mjs")).href,
        cliPath,
        "--",
        process.execPath,
        "-e",
        'process.stdout.write("started")',
      ],
      { env: cleanEnvironment },
    );

    expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
    expect(result.stderr).toBe(
      "localbox: [LOCALBOX_UNSUPPORTED_RUNTIME] Node.js 20.11.1 is unsupported; " +
        "Node.js >=22.12.0 is required. Switch Node.js versions and retry.\n",
    );
  });

  test("forwards arguments, cwd, and environment while composing NODE_OPTIONS", async () => {
    const existingNodeOptions = `--import=${pathToFileURL(
      join(applicationDirectory, "existing-preload.mjs"),
    ).href} --no-warnings`;
    const result = await runCli(
      [
        "--",
        process.execPath,
        join(applicationDirectory, "observe.mjs"),
        "two words",
        "",
        "--",
        "$HOME;exit 9",
      ],
      {
        cwd: applicationDirectory,
        env: {
          ...cleanEnvironment,
          LOCALBOX_TEST_MARKER: "preserved",
          NODE_OPTIONS: existingNodeOptions,
        },
      },
    );

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    const observed = JSON.parse(result.stdout) as ObservedProcess;
    expect(observed).toMatchObject({
      arguments: ["two words", "", "--", "$HOME;exit 9"],
      cwd: applicationDirectory,
      environment: "preserved",
      existingPreloadRan: true,
    });
    expect(observed.nodeOptions).not.toBe(existingNodeOptions);
    expect(observed.nodeOptions.endsWith(existingNodeOptions)).toBe(true);
    expect(observed.nodeOptions.startsWith("--import=file:"), observed.nodeOptions).toBe(true);
  });

  test("changes provider resolution only for wrapped execution", async () => {
    const entry = join(applicationDirectory, "resolution.mjs");
    const ordinary = await runProcess(process.execPath, [entry], {
      cwd: applicationDirectory,
      env: cleanEnvironment,
    });
    const wrapped = await runCli(["--", process.execPath, entry], {
      cwd: applicationDirectory,
      env: cleanEnvironment,
    });

    expect(ordinary).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(ordinary.stdout.trim()).toBe("provider");
    expect(wrapped).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(wrapped.stdout.trim()).toBe("localbox");
  });

  test("returns the child numeric exit status", async () => {
    const result = await runCli(["--", process.execPath, "-e", "process.exit(37)"], {
      env: cleanEnvironment,
    });

    expect(result).toMatchObject({ code: 37, signal: null });
  });

  test("reports a direct spawn failure as a wrapper error", async () => {
    const missingCommand = join(temporaryDirectory, "missing-executable");
    const result = await runCli(["--", missingCommand], { env: cleanEnvironment });

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.stderr).toContain(`failed to start ${JSON.stringify(missingCommand)}`);
  });

  describe.skipIf(process.platform === "win32")("portable signals", () => {
    test.each(["SIGINT", "SIGTERM"] as const)(
      "forwards %s, mirrors signal termination, and leaves cwd unchanged",
      async (signal) => {
        const entriesBefore = (await readdir(applicationDirectory, { recursive: true })).sort();
        const child = startCli(
          ["--", process.execPath, join(applicationDirectory, "signal.mjs"), signal],
          { cwd: applicationDirectory, env: cleanEnvironment },
        );
        child.stdout.setEncoding("utf8");
        let stdout = "";
        let fixtureReady = false;
        const ready = Promise.withResolvers<void>();
        const completed = Promise.withResolvers<ProcessResult>();

        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("READY\n")) {
            fixtureReady = true;
            ready.resolve();
          }
        });
        child.once("error", (error) => {
          ready.reject(error);
          completed.reject(error);
        });
        child.once("close", (code, childSignal) => {
          if (!fixtureReady) ready.reject(new Error(`${signal} fixture exited before ready`));
          completed.resolve({ code, signal: childSignal, stderr: "", stdout });
        });

        await ready.promise;
        child.kill(signal);
        const result = await completed.promise;

        expect(result).toMatchObject({ code: null, signal });
        expect(result.stdout).toContain(`RECEIVED:${signal}`);
        expect((await readdir(applicationDirectory, { recursive: true })).sort()).toEqual(
          entriesBefore,
        );
      },
    );
  });
});
