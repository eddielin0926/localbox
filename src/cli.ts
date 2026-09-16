#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:os";
import process from "node:process";

type PortableSignal = "SIGINT" | "SIGTERM";

const USAGE = "Usage: localbox -- <command> [arguments...]";
const PORTABLE_SIGNALS: readonly PortableSignal[] = ["SIGINT", "SIGTERM"];
const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_NODE_MINOR = 12;

function failUsage(message: string): void {
  console.error(`localbox: ${message}\n${USAGE}`);
  process.exitCode = 2;
}

function terminateWithSignal(signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(process.pid, signal);
      return;
    } catch {
      // Fall through when the platform cannot reproduce signal termination.
    }
  }

  const signalNumber = constants.signals[signal];
  process.exitCode = signalNumber === undefined ? 1 : 128 + signalNumber;
}

const arguments_ = process.argv.slice(2);
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
const supportedNode =
  nodeMajor > MINIMUM_NODE_MAJOR ||
  (nodeMajor === MINIMUM_NODE_MAJOR && nodeMinor >= MINIMUM_NODE_MINOR);

if (arguments_[0] !== "--") {
  failUsage("the `--` separator is required");
} else {
  const command = arguments_[1];

  if (command === undefined || command.length === 0) {
    failUsage("an executable is required after `--`");
  } else if (!supportedNode) {
    console.error(
      `localbox: [LOCALBOX_UNSUPPORTED_RUNTIME] Node.js ${process.versions.node} is unsupported; ` +
        "Node.js >=22.12.0 is required. Switch Node.js versions and retry.",
    );
    process.exitCode = 1;
  } else {
    const preloadOption = `--import=${new URL("./interception/node-preload.js", import.meta.url).href}`;
    const existingNodeOptions = process.env.NODE_OPTIONS;
    const childEnvironment = {
      ...process.env,
      NODE_OPTIONS:
        existingNodeOptions === undefined || existingNodeOptions.length === 0
          ? preloadOption
          : `${preloadOption} ${existingNodeOptions}`,
    };
    const child = spawn(command, arguments_.slice(2), {
      env: childEnvironment,
      stdio: "inherit",
    });

    let settled = false;
    let receivedSignal: PortableSignal | undefined;
    let pendingForward: NodeJS.Timeout | undefined;

    const removeSignalHandlers = (): void => {
      for (const signal of PORTABLE_SIGNALS) process.off(signal, handleSignal);
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(pendingForward);
      removeSignalHandlers();

      if (code !== null) {
        process.exitCode = code;
        return;
      }

      if (signal !== null) terminateWithSignal(signal);
    };

    function handleSignal(signal: PortableSignal): void {
      if (settled || receivedSignal !== undefined) return;
      receivedSignal = signal;

      // A terminal normally sends the signal to the whole foreground process group.
      // Give the child a chance to report that delivery before forwarding a PID-directed signal.
      pendingForward = setTimeout(() => {
        pendingForward = undefined;
        if (!settled && child.exitCode === null && child.signalCode === null) child.kill(signal);
      }, 25);
    }

    for (const signal of PORTABLE_SIGNALS) process.on(signal, handleSignal);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(pendingForward);
      removeSignalHandlers();
      console.error(`localbox: failed to start ${JSON.stringify(command)}: ${error.message}`);
      process.exitCode = 1;
    });

    child.once("exit", finish);
  }
}
