import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

interface ProcessResult {
  code: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

const fixtureDirectory = fileURLToPath(
  new URL("../fixtures/node-resolution/", import.meta.url),
);
const projectDirectory = fileURLToPath(new URL("../../", import.meta.url));

let temporaryDirectory: string;
let applicationDirectory: string;

function runFixtureResult(entry: string, preload: boolean): Promise<ProcessResult> {
  const arguments_ = preload
    ? ["--import", "localbox/node-preload", entry]
    : [entry];
  const { promise, resolve } = Promise.withResolvers<ProcessResult>();

  execFile(
    process.execPath,
    arguments_,
    {
      cwd: applicationDirectory,
      env: { ...process.env, NODE_OPTIONS: undefined },
    },
    (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
        signal: error?.signal ?? null,
        stderr,
        stdout,
      });
    },
  );

  return promise;
}

async function runFixture(entry: string, preload: boolean): Promise<string> {
  const result = await runFixtureResult(entry, preload);

  if (result.code !== 0) {
    throw new Error(`fixture exited with ${result.code}\n${result.stderr}`);
  }

  return result.stdout.trim();
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "localbox-resolution-"));
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

  const localboxDirectory = join(applicationDirectory, "node_modules", "localbox");
  await mkdir(join(localboxDirectory, "dist", "vercel"), { recursive: true });
  await copyFile(
    join(projectDirectory, "package.json"),
    join(localboxDirectory, "package.json"),
  );
  await copyFile(
    join(fixtureDirectory, "localbox-vercel.js"),
    join(localboxDirectory, "dist", "vercel", "index.js"),
  );
  await cp(
    join(projectDirectory, "dist", "interception"),
    join(localboxDirectory, "dist", "interception"),
    { recursive: true },
  );
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Node ESM resolution preload", () => {
  test.each(["static.mjs", "dynamic.mjs", "child-entry.mjs"])(
    "maps @vercel/sandbox to Localbox for %s",
    async (entry) => {
      await expect(runFixture(entry, true)).resolves.toBe("localbox");
    },
  );

  test("classifies hook setup failures and stops before provider fallback", async () => {
    const hookPath = join(
      applicationDirectory,
      "node_modules",
      "localbox",
      "dist",
      "interception",
      "resolve-hook.js",
    );
    const missingHookPath = `${hookPath}.missing`;
    await rename(hookPath, missingHookPath);

    try {
      const result = await runFixtureResult("static.mjs", true);

      expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
      expect(result.stderr).toContain("LOCALBOX_HOOK_SETUP_FAILED");
      expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stderr).toContain("resolve-hook.js");
      expect(result.stderr).toContain("did not fall back to @vercel/sandbox");
    } finally {
      await rename(missingHookPath, hookPath);
    }
  });

  test("leaves ordinary provider resolution unchanged without the preload", async () => {
    await expect(runFixture("static.mjs", false)).resolves.toBe("provider");
  });

  test("delegates provider subpaths and unrelated modules unchanged", async () => {
    await expect(runFixture("isolation.mjs", true)).resolves.toBe(
      "provider-subpath:unrelated.txt",
    );
  });
});
