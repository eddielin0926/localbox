export const PROCESS_SUPERVISOR_PROGRAM = String.raw`
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const parentPid = Number(process.argv[1]);
const KILL_GRACE_MS = 750;
const POLL_MS = 25;
let target = null;
let targetPid = null;
let configured = false;
let finished = false;
let spawnFailed = false;
let shuttingDown = null;

function send(message) {
  if (!process.connected || typeof process.send !== "function") return;
  process.send(message, () => undefined);
}

function groupSignal(signal) {
  if (targetPid === null) return false;
  try {
    process.kill(-targetPid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    throw error;
  }
}

function groupAlive() {
  return groupSignal(0);
}


async function cleanGroup(initialSignal = "SIGTERM") {
  if (targetPid === null) return;
  try {
    groupSignal(initialSignal);
  } catch {}
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    if (!groupAlive()) return;
    await delay(POLL_MS);
  }
  try {
    groupSignal("SIGKILL");
  } catch {}
  const killDeadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < killDeadline && groupAlive()) await delay(POLL_MS);
}

async function shutdown(exitCode = 1) {
  shuttingDown ??= (async () => {
    clearInterval(parentWatchdog);
    if (!finished) {
      finished = true;
      await cleanGroup("SIGTERM");
      send({ type: "complete", exitCode, finishedAt: Date.now() });
    }
    process.exit(exitCode);
  })();
  await shuttingDown;
}

for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(128 + (osConstants.signals[signal] ?? 1)));
}

const parentWatchdog = setInterval(() => {
  if (process.ppid !== parentPid) {
    void shutdown(1);
    return;
  }
  try {
    process.kill(parentPid, 0);
  } catch {
    void shutdown(1);
  }
}, 100);
parentWatchdog.unref();

process.on("disconnect", () => void shutdown(1));
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "terminate") {
    void shutdown(1);
    return;
  }
  if (message.type !== "start" || configured) return;
  configured = true;
  const command = message.command;
  try {
    target = spawn(command.command, command.arguments, {
      cwd: command.cwd,
      env: command.environment,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    send({ type: "spawn-error", code: error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN", message: error instanceof Error ? error.message : String(error) });
    send({ type: "complete", exitCode: 127, finishedAt: Date.now() });
    finished = true;
    clearInterval(parentWatchdog);
    process.disconnect();
    return;
  }

  target.once("spawn", () => {
    targetPid = target.pid;
    send({ type: "ready", pid: targetPid });
    const input = message.input === null ? null : Buffer.from(message.input, "base64");
    if (input !== null && input.length > 0) target.stdin.write(input);
    target.stdin.end();
  });

  for (const [stream, readable] of [["stdout", target.stdout], ["stderr", target.stderr]]) {
    readable.on("data", (chunk) => send({ type: "output", stream, data: Buffer.from(chunk).toString("base64") }));
  }

  target.once("error", (error) => {
    if (finished) return;
    spawnFailed = true;
    send({ type: "spawn-error", code: error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN", message: error.message });
  });

  target.once("close", async (code, signal) => {
    if (finished) return;
    finished = true;
    await cleanGroup("SIGTERM");
    clearInterval(parentWatchdog);
    const signalNumber = signal === null ? 0 : (osConstants.signals[signal] ?? 1);
    send({
      type: "complete",
      exitCode: spawnFailed ? 127 : code === null ? 128 + signalNumber : code,
      finishedAt: Date.now(),
    });
    if (process.connected) process.disconnect();
  });
});

send({ type: "supervisor-ready" });
`;
