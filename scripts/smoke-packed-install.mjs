import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "localbox-packed-install-"));
const archiveDirectory = join(temporaryRoot, "archive");
const consumerDirectory = join(temporaryRoot, "consumer");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: "true" },
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function runPnpm(args, cwd) {
  if (process.env.npm_execpath) {
    run(process.env.npm_execpath, args, cwd);
    return;
  }

  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, cwd);
}

try {
  mkdirSync(archiveDirectory);
  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "localbox-packed-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(consumerDirectory, "pnpm-workspace.yaml"),
    "packages: []\n\nallowBuilds:\n  cpu-features: false\n  protobufjs: false\n  ssh2: false\n",
  );

  runPnpm(["pack", "--pack-destination", archiveDirectory], projectRoot);

  const archives = readdirSync(archiveDirectory).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected one packed archive, found ${archives.length}`);
  }

  const archivePath = join(archiveDirectory, archives[0]);
  runPnpm(["add", "--save-dev", "--save-exact", archivePath], consumerDirectory);

  const installedManifest = JSON.parse(
    readFileSync(join(consumerDirectory, "node_modules", "localbox", "package.json"), "utf8"),
  );
  if (installedManifest.dependencies?.dockerode !== "5.0.1") {
    throw new Error(
      `Expected packed dockerode dependency 5.0.1, received ${JSON.stringify(installedManifest.dependencies?.dockerode)}`,
    );
  }

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { Sandbox } from "localbox/vercel"; if (typeof Sandbox?.create !== "function") throw new Error("localbox/vercel did not export Sandbox.create");',
    ],
    consumerDirectory,
  );

  console.log("Packed localbox archive installed and imported successfully in a clean pnpm consumer.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
