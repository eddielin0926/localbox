import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const fixtureDirectory = fileURLToPath(
  new URL("../fixtures/node-resolution/", import.meta.url),
);
const projectDirectory = fileURLToPath(new URL("../../", import.meta.url));

let temporaryDirectory: string;
let applicationDirectory: string;

function runFixture(entry: string, preload: boolean): Promise<string> {
  const arguments_ = preload
    ? ["--import", "localbox/node-preload", entry]
    : [entry];
  const { promise, reject, resolve } = Promise.withResolvers<string>();

  execFile(
    process.execPath,
    arguments_,
    {
      cwd: applicationDirectory,
      env: { ...process.env, NODE_OPTIONS: undefined },
    },
    (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }

      resolve(stdout.trim());
    },
  );

  return promise;
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

  test("leaves ordinary provider resolution unchanged without the preload", async () => {
    await expect(runFixture("static.mjs", false)).resolves.toBe("provider");
  });

  test("delegates provider subpaths and unrelated modules unchanged", async () => {
    await expect(runFixture("isolation.mjs", true)).resolves.toBe(
      "provider-subpath:unrelated.txt",
    );
  });
});
