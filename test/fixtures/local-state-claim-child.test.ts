import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { test } from "vitest";
import {
  LocalSandboxStateConflictError,
  LocalSandboxStateStore,
} from "../../src/runtime/index.js";

const barrier = process.env.LOCALBOX_CLAIM_BARRIER;
const resultPath = process.env.LOCALBOX_CLAIM_RESULT;
const stateRoot = process.env.LOCALBOX_CLAIM_STATE_ROOT;

if (barrier === undefined || resultPath === undefined || stateRoot === undefined) {
  throw new Error("The child claim fixture requires its isolated state paths.");
}

test("claims one shared name from a real child process", async () => {
  while (!existsSync(barrier)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  const store = new LocalSandboxStateStore({ root: stateRoot });
  try {
    await store.acquire("cross-process", { backendId: "child", backendType: "memory" });
    await writeFile(resultPath, "won", { mode: 0o600 });
  } catch (error) {
    if (!(error instanceof LocalSandboxStateConflictError)) throw error;
    await writeFile(resultPath, "lost", { mode: 0o600 });
  }
});
