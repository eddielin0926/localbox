import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const fixtureDirectory = join(projectDirectory, "examples", "interception");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "localbox-interception-"));
const packageDirectory = join(temporaryDirectory, "package");
const applicationDirectory = join(temporaryDirectory, "application");
const sandboxName = `localbox-interception-${randomUUID()}`;
const originalNodeOptions = process.env.NODE_OPTIONS;
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_OPTIONS;

function run(command, arguments_, options = {}) {
  const { promise, resolve } = Promise.withResolvers();
  execFile(
    command,
    arguments_,
    {
      cwd: options.cwd,
      env: options.env ?? childEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    },
    (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
        error,
        stderr,
        stdout,
      });
    },
  );
  return promise;
}

async function runSuccessful(label, command, arguments_, options = {}) {
  const result = await run(command, arguments_, options);
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with exit code ${String(result.code)}\n${result.stdout}${result.stderr}`,
      { cause: result.error ?? undefined },
    );
  }
  return result;
}

async function providerProbe(providerDirectory) {
  const result = await runSuccessful(
    "ordinary provider probe",
    process.execPath,
    ["provider-probe.mjs"],
    { cwd: applicationDirectory },
  );

  let observation;
  try {
    observation = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`Provider probe returned invalid JSON: ${JSON.stringify(result.stdout)}`, {
      cause: error,
    });
  }

  if (observation.sandboxType !== "function" || typeof observation.resolved !== "string") {
    throw new Error(`Provider probe returned an unexpected result: ${result.stdout.trim()}`);
  }

  const resolvedPath = await realpath(fileURLToPath(observation.resolved));
  const providerRelativePath = relative(providerDirectory, resolvedPath);
  if (providerRelativePath.startsWith("..") || isAbsolute(providerRelativePath)) {
    throw new Error(`Ordinary execution resolved outside @vercel/sandbox: ${resolvedPath}`);
  }

  return { resolvedPath, sandboxType: observation.sandboxType };
}

async function ownedContainerIds() {
  const result = await runSuccessful(
    "Docker cleanup probe",
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=dev.localbox.name=${sandboxName}`,
    ],
  );
  return result.stdout.trim().split("\n").filter(Boolean);
}

async function forceContainerCleanup() {
  const ids = await ownedContainerIds();
  if (ids.length === 0) return;
  await runSuccessful("Docker fallback cleanup", "docker", ["container", "rm", "--force", ...ids]);
  const remaining = await ownedContainerIds();
  if (remaining.length > 0) {
    throw new Error(`Could not remove Localbox containers: ${remaining.join(", ")}`);
  }
}

let failure;
try {
  await mkdir(packageDirectory);
  await mkdir(applicationDirectory);
  await writeFile(
    join(applicationDirectory, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await copyFile(join(fixtureDirectory, "app.mjs"), join(applicationDirectory, "app.mjs"));
  await copyFile(
    join(fixtureDirectory, "provider-probe.mjs"),
    join(applicationDirectory, "provider-probe.mjs"),
  );

  await runSuccessful(
    "package creation",
    "npm",
    ["pack", "--pack-destination", packageDirectory],
    { cwd: projectDirectory },
  );
  const archives = (await readdir(packageDirectory)).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected one package archive, found ${archives.length}.`);
  }
  const archivePath = join(packageDirectory, archives[0]);

  await runSuccessful(
    "fixture dependency installation",
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      archivePath,
      "@vercel/sandbox@3.3.0",
    ],
    { cwd: applicationDirectory },
  );

  const providerDirectory = await realpath(
    join(applicationDirectory, "node_modules", "@vercel", "sandbox"),
  );
  const providerPackage = JSON.parse(
    await readFile(join(providerDirectory, "package.json"), "utf8"),
  );
  if (providerPackage.name !== "@vercel/sandbox" || providerPackage.version !== "3.3.0") {
    throw new Error(
      `Expected @vercel/sandbox@3.3.0, found ${String(providerPackage.name)}@${String(providerPackage.version)}.`,
    );
  }

  const before = await providerProbe(providerDirectory);

  const localboxPackagePath = join(applicationDirectory, "node_modules", "localbox", "package.json");
  const localboxPackage = JSON.parse(await readFile(localboxPackagePath, "utf8"));
  const binPath =
    typeof localboxPackage.bin === "string"
      ? localboxPackage.bin
      : localboxPackage.bin?.localbox;
  if (typeof binPath !== "string") {
    throw new Error("The packed Localbox package does not expose its CLI binary.");
  }
  const cliPath = join(dirname(localboxPackagePath), binPath);
  const wrappedEnvironment = {
    ...childEnvironment,
    LOCALBOX_INTERCEPTION_SMOKE_NAME: sandboxName,
  };
  const wrapped = await runSuccessful(
    "wrapped unchanged-import fixture",
    process.execPath,
    [cliPath, "--", process.execPath, "app.mjs"],
    { cwd: applicationDirectory, env: wrappedEnvironment },
  );
  const wrappedObservation = JSON.parse(wrapped.stdout.trim());
  if (
    wrappedObservation.name !== sandboxName ||
    wrappedObservation.result !== "UNCHANGED IMPORT REACHED LOCALBOX"
  ) {
    throw new Error(`Wrapped fixture returned an unexpected result: ${wrapped.stdout.trim()}`);
  }

  const after = await providerProbe(providerDirectory);
  if (after.resolvedPath !== before.resolvedPath || after.sandboxType !== before.sandboxType) {
    throw new Error("Ordinary provider resolution changed after wrapped execution.");
  }
  if (process.env.NODE_OPTIONS !== originalNodeOptions) {
    throw new Error("Wrapped execution changed the parent NODE_OPTIONS value.");
  }

  const leftovers = await ownedContainerIds();
  if (leftovers.length > 0) {
    throw new Error(`Wrapped fixture left Localbox containers behind: ${leftovers.join(", ")}`);
  }

  console.log("ordinary-provider-before-ok");
  console.log("wrapped-docker-sandbox-ok");
  console.log("ordinary-provider-after-ok");
  console.log("cleanup-ok");
} catch (error) {
  failure = error;
} finally {
  try {
    await forceContainerCleanup();
  } catch (cleanupError) {
    failure =
      failure === undefined
        ? cleanupError
        : new AggregateError([failure, cleanupError], "Smoke test and fallback cleanup failed.");
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

if (failure !== undefined) throw failure;
