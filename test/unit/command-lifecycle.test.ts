import { describe, expect, test } from "vitest";
import { EmbeddedSandboxClient } from "../../src/runtime/index.js";
import type {
  ClientFailure,
  ProcessSignal,
  RawCommand,
  RawCommandEvent,
  SandboxBackend,
  StartCommandRequest,
} from "../../src/runtime/index.js";

const REFERENCE = { backendId: "commands", backendType: "test" } as const;

class ControlledRawCommand implements RawCommand {
  readonly startedAt = 1_700_000_000_000;
  readonly events: AsyncIterable<RawCommandEvent>;
  readonly #events: RawCommandEvent[] = [];
  readonly #followers = new Set<() => void>();
  readonly #deliveredSignals = new Set<ProcessSignal>();
  #closed = false;
  disposed = false;

  constructor() {
    this.events = this.#iterate();
  }

  emit(event: RawCommandEvent): void {
    if (this.#closed) throw new Error("command is closed");
    this.#events.push(event);
    if (event.type === "complete" || event.type === "backend-failure") this.#closed = true;
    for (const wake of this.#followers) wake();
    this.#followers.clear();
  }

  async signal(signal: ProcessSignal): Promise<void> {
    if (this.#deliveredSignals.has(signal)) {
      throw new Error("raw primitive received a duplicate signal");
    }
    this.#deliveredSignals.add(signal);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.#closed = true;
    for (const wake of this.#followers) wake();
    this.#followers.clear();
  }

  async *#iterate(): AsyncGenerator<RawCommandEvent, void, void> {
    let cursor = 0;
    for (;;) {
      while (cursor < this.#events.length) {
        const event = this.#events[cursor];
        cursor += 1;
        if (event !== undefined) yield event;
      }
      if (this.#closed) return;
      const deferred = Promise.withResolvers<void>();
      const wake = (): void => deferred.resolve();
      this.#followers.add(wake);
      try {
        if (cursor === this.#events.length && !this.#closed) await deferred.promise;
      } finally {
        this.#followers.delete(wake);
      }
    }
  }
}

function unavailable(requestId: string, operation: string): ClientFailure {
  return {
    ok: false,
    error: {
      category: "backend-unavailable",
      code: "TEST_BACKEND_UNAVAILABLE",
      message: `${operation} is unavailable.`,
      retryable: false,
      requestId,
      backend: REFERENCE,
      details: { type: "backend", operation },
    },
  };
}

function backend(raw: ControlledRawCommand): SandboxBackend {
  return {
    reference: REFERENCE,
    capabilities: ["command.start", "command.detached"],
    rawCommandCapabilities: [],
    createSandbox: (request) => Promise.resolve(unavailable(request.requestId, "createSandbox")),
    getSandbox: (request) => Promise.resolve(unavailable(request.requestId, "getSandbox")),
    listSandboxes: (request) => Promise.resolve(unavailable(request.requestId, "listSandboxes")),
    stopSandbox: (request) => Promise.resolve(unavailable(request.requestId, "stopSandbox")),
    deleteSandbox: (request) => Promise.resolve({
      ok: true,
      value: { sandboxId: request.sandboxId, deletedAt: 1_700_000_000_500 },
    }),
    extendSandboxDeadline: (request) => Promise.resolve(
      unavailable(request.requestId, "extendSandboxDeadline"),
    ),
    startRawCommand: () => Promise.resolve({ ok: true, command: raw }),
    getEndpoint: (request) => Promise.resolve(unavailable(request.requestId, "getEndpoint")),
  };
}

function startRequest(outputLimitBytes = 1024): StartCommandRequest {
  return {
    requestId: "start",
    idempotencyKey: "start-once",
    deadline: null,
    sandboxId: "sandbox",
    command: {
      command: "node",
      arguments: ["script.js"],
      cwd: "/workspace",
      environment: {},
    },
    outputLimitBytes,
  };
}

async function start(client: EmbeddedSandboxClient, outputLimitBytes = 1024) {
  const result = await client.startCommand(startRequest(outputLimitBytes));
  if (!result.ok) throw new Error(result.error.message);
  return result.value.process;
}

function readRequest(processId: string, cursor: string | null, follow = false) {
  return {
    requestId: `read:${cursor ?? "start"}:${follow}`,
    deadline: null,
    sandboxId: "sandbox",
    processId,
    stream: "both",
    cursor,
    limitBytes: 1024,
    follow,
  } as const;
}

describe("EmbeddedSandboxClient command lifecycle", () => {
  test("preserves interleaved order, cursor replay, and follow wakeups", async () => {
    const raw = new ControlledRawCommand();
    const client = new EmbeddedSandboxClient(backend(raw));
    const process = await start(client);

    raw.emit({ type: "stdout", data: "one" });
    const first = await client.readCommandOutput(readRequest(process.processId, null, true));
    if (!first.ok) throw new Error(first.error.message);
    raw.emit({ type: "stderr", data: "two" });
    const second = await client.readCommandOutput(
      readRequest(process.processId, first.value.nextCursor, true),
    );
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.chunks).toEqual([{ stream: "stderr", data: "two" }]);

    const replay = await client.readCommandOutput(readRequest(process.processId, null));
    expect(replay).toMatchObject({
      ok: true,
      value: {
        chunks: [
          { stream: "stdout", data: "one" },
          { stream: "stderr", data: "two" },
        ],
        complete: false,
        truncated: false,
      },
    });
    if (!replay.ok) throw new Error(replay.error.message);

    const followed = client.readCommandOutput(
      readRequest(process.processId, replay.value.nextCursor, true),
    );
    raw.emit({ type: "stdout", data: "three" });
    await expect(followed).resolves.toMatchObject({
      ok: true,
      value: { chunks: [{ stream: "stdout", data: "three" }], complete: false },
    });

    raw.emit({ type: "complete", exitCode: 0, finishedAt: raw.startedAt + 25 });
    await client.waitForCommand({
      requestId: "wait-complete",
      deadline: null,
      sandboxId: "sandbox",
      processId: process.processId,
    });
    const complete = await client.readCommandOutput(readRequest(process.processId, null));
    expect(complete).toMatchObject({
      ok: true,
      value: {
        chunks: [
          { stream: "stdout", data: "one" },
          { stream: "stderr", data: "two" },
          { stream: "stdout", data: "three" },
        ],
        complete: true,
        nextCursor: null,
      },
    });
  });

  test("bounds retention and advances cursors without duplicating retained output", async () => {
    const raw = new ControlledRawCommand();
    const client = new EmbeddedSandboxClient(backend(raw));
    const process = await start(client, 5);

    raw.emit({ type: "stdout", data: "abc" });
    const first = await client.readCommandOutput(readRequest(process.processId, null, true));
    if (!first.ok) throw new Error(first.error.message);
    raw.emit({ type: "stderr", data: "def" });
    await client.readCommandOutput(
      readRequest(process.processId, first.value.nextCursor, true),
    );
    const retained = await client.readCommandOutput(readRequest(process.processId, null));
    expect(retained).toEqual({
      ok: true,
      value: {
        chunks: [
          { stream: "stdout", data: "abc" },
          { stream: "stderr", data: "de" },
        ],
        nextCursor: "2:0",
        complete: false,
        truncated: true,
      },
    });
    if (!retained.ok) throw new Error(retained.error.message);

    const beyondLimit = client.readCommandOutput(
      readRequest(process.processId, retained.value.nextCursor, true),
    );
    raw.emit({ type: "stdout", data: "ghi" });
    await expect(beyondLimit).resolves.toEqual({
      ok: true,
      value: {
        chunks: [],
        nextCursor: "2:0",
        complete: false,
        truncated: true,
      },
    });

    raw.emit({ type: "complete", exitCode: 0, finishedAt: raw.startedAt + 30 });
    await expect(
      client.readCommandOutput(readRequest(process.processId, "2:0", true)),
    ).resolves.toEqual({
      ok: true,
      value: { chunks: [], nextCursor: null, complete: true, truncated: true },
    });
  });

  test("settles concurrent, repeated, and completion-before-wait callers identically", async () => {
    const raw = new ControlledRawCommand();
    const client = new EmbeddedSandboxClient(backend(raw));
    const process = await start(client);
    const request = {
      requestId: "wait-1",
      deadline: null,
      sandboxId: "sandbox",
      processId: process.processId,
    } as const;
    const first = client.waitForCommand(request);
    const second = client.waitForCommand({ ...request, requestId: "wait-2" });

    raw.emit({ type: "complete", exitCode: 7, finishedAt: raw.startedAt + 42 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({
      ok: true,
      value: { result: { durationMs: 42, exitCode: 7, process: { status: "exited" } } },
    });
    expect(secondResult).toMatchObject({
      ok: true,
      value: { result: { durationMs: 42, exitCode: 7, process: { status: "exited" } } },
    });
    await expect(client.waitForCommand({
      ...request,
      requestId: "wait-after-completion",
      deadline: { expiresAt: 0 },
    })).resolves.toMatchObject({ ok: true, value: { result: { exitCode: 7 } } });
  });

  test("delivers each portable signal once and leaves completion stable across a deadline race", async () => {
    const raw = new ControlledRawCommand();
    const client = new EmbeddedSandboxClient(backend(raw));
    const process = await start(client);
    const signal = {
      requestId: "signal-1",
      idempotencyKey: "term",
      deadline: null,
      sandboxId: "sandbox",
      processId: process.processId,
      signal: "SIGTERM",
    } as const;
    await expect(client.signalProcess(signal)).resolves.toMatchObject({ ok: true });
    await expect(client.signalProcess({ ...signal, requestId: "signal-2" })).resolves.toMatchObject({
      ok: true,
    });

    const timedOut = await client.waitForCommand({
      requestId: "expired-wait",
      deadline: { expiresAt: 0 },
      sandboxId: "sandbox",
      processId: process.processId,
    });
    expect(timedOut).toMatchObject({
      ok: false,
      error: { category: "deadline-exceeded", code: "LOCALBOX_DEADLINE_EXCEEDED" },
    });
    raw.emit({ type: "complete", exitCode: 143, finishedAt: raw.startedAt + 50 });
    await expect(client.waitForCommand({
      requestId: "wait-after-race",
      deadline: null,
      sandboxId: "sandbox",
      processId: process.processId,
    })).resolves.toMatchObject({ ok: true, value: { result: { exitCode: 143 } } });
  });

  test("disposes a malformed backend handle when startup cannot publish process state", async () => {
    const raw = new ControlledRawCommand();
    let disposed = false;
    const malformed = {
      startedAt: raw.startedAt,
      events: {},
      signal: () => Promise.resolve(),
      dispose: () => {
        disposed = true;
        return Promise.resolve();
      },
    } as unknown as RawCommand;
    const client = new EmbeddedSandboxClient({
      ...backend(raw),
      startRawCommand: () => Promise.resolve({ ok: true, command: malformed }),
    });

    const result = await client.startCommand(startRequest());
    expect(result).toMatchObject({
      ok: false,
      error: { category: "backend-failure", code: "LOCALBOX_BACKEND_FAILURE" },
    });
    expect(disposed).toBe(true);
  });

  test("turns backend failure into stable JSON-safe wait failures", async () => {
    const raw = new ControlledRawCommand();
    const client = new EmbeddedSandboxClient(backend(raw));
    const process = await start(client);
    raw.emit({
      type: "backend-failure",
      code: "TEST_RAW_FAILURE",
      message: "raw command failed",
      retryable: false,
    });

    for (const requestId of ["failure-1", "failure-2"]) {
      const result = await client.waitForCommand({
        requestId,
        deadline: null,
        sandboxId: "sandbox",
        processId: process.processId,
      });
      expect(result).toEqual({
        ok: false,
        error: {
          category: "backend-failure",
          code: "TEST_RAW_FAILURE",
          message: "raw command failed",
          retryable: false,
          requestId,
          backend: REFERENCE,
          details: { type: "backend", operation: "command" },
        },
      });
    }
  });

  test("cancels outstanding waiters and releases raw state when the sandbox is deleted", async () => {
    const raw = new ControlledRawCommand();
    const client = new EmbeddedSandboxClient(backend(raw));
    const process = await start(client);
    const waiting = client.waitForCommand({
      requestId: "waiting",
      deadline: null,
      sandboxId: "sandbox",
      processId: process.processId,
    });

    await expect(client.deleteSandbox({
      requestId: "delete",
      idempotencyKey: "delete",
      deadline: null,
      sandboxId: "sandbox",
    })).resolves.toMatchObject({ ok: true });
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      error: { category: "cancelled", code: "LOCALBOX_OPERATION_CANCELLED" },
    });
    expect(raw.disposed).toBe(true);
    await expect(client.waitForCommand({
      requestId: "after-delete",
      deadline: null,
      sandboxId: "sandbox",
      processId: process.processId,
    })).resolves.toMatchObject({
      ok: false,
      error: { category: "not-found", code: "LOCALBOX_PROCESS_NOT_FOUND" },
    });
  });
});
