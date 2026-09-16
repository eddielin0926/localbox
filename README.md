# localbox/vercel

Run Vercel-shaped sandboxes locally with Docker. No Localbox service, credentials, CLI setup, configuration file, or environment variables are required.

## 60-second quickstart

Prerequisites:

- Node.js 22.12 or newer
- A reachable Docker daemon
- Registry access for the first image pull

Start Docker, then install the SDK:

```sh
pnpm add localbox
```

```js
import { Sandbox } from "localbox/vercel";

const sandbox = await Sandbox.create({ name: "hello-localbox" });
try {
  const result = await sandbox.runCommand("node", [
    "-e",
    "process.stdout.write('hello from Localbox')",
  ]);
  console.log(await result.stdout());
} finally {
  await sandbox.delete();
}
```

The first create may wait for `node:24-bookworm-slim` to download. Later creates reuse Docker's image cache.

## Supported compatibility surface

| Vercel-shaped API | Localbox behavior |
| --- | --- |
| `Sandbox.list(options)` | Lists managed Docker containers with filtering, sorting, pagination, and async iteration. |
| `Sandbox.create(options)` | Creates and starts a named Docker container. |
| `Sandbox.get({ name, resume })` | Opens a managed container without resuming it unless requested. |
| `Sandbox.getOrCreate(options)` | Opens an existing name or creates it; existing containers do not resume unless requested. |
| `sandbox.refresh()` | Reconciles cached status with Docker without resuming. This is a Localbox extension. |
| `sandbox.stop()` | Stops the session. Persistent containers retain their filesystem. |
| `sandbox.delete()` | Force-removes the container and makes that handle inert. |
| `sandbox.extendTimeout(ms)` | Adds milliseconds to the live in-container deadline. |
| `sandbox.domain(port)` | Returns the port's loopback-only HTTP URL. |
| `sandbox.runCommand(...)` | Runs argv without a shell, with blocking and detached modes. |
| `command.logs()` / `wait()` | Replays buffered logs, follows live output, and returns a stable `CommandFinished`. |
| `command.output()` / `stdout()` / `stderr()` | Returns Vercel-compatible promises and supports abort signals. |
| `command.kill(signal)` | Signals the launched command process using Vercel-compatible names or numbers. |
| `sandbox.fs.*` | Implements all 21 methods in Vercel's documented `FileSystem` subset. |
| `readFile`, `mkDir`, `writeFiles`, `readFileToBuffer`, `downloadFile` | Provides the implemented Vercel-shaped streaming and buffered file helpers. |

`Sandbox.create()` defaults to a five-minute timeout, `persistent: true`, and `/vercel/sandbox` as the relative working directory. `runtime: "node24"` and the default image both select `node:24-bookworm-slim`. Custom images must contain `node` and `/bin/sh`.

## Measured compatibility

Compatibility is measured against `@vercel/sandbox@3.3.0`. The versioned source is [`src/vercel/compatibility.json`](src/vercel/compatibility.json).

| Surface | Available | Type-compatible | Behavior-compatible |
| --- | ---: | ---: | ---: |
| `Sandbox` | 14/28 (50.0%) | 8/28 (28.6%) | 7/28 (25.0%) |
| `Command` | 6/6 (100%) | 6/6 (100%) | 6/6 (100%) |
| `FileSystem` | 21/21 (100%) | 21/21 (100%) | 21/21 (100%) |
| **Total** | **41/55 (74.5%)** | **35/55 (63.6%)** | **34/55 (61.8%)** |

Run `pnpm compatibility:vercel` to validate the manifest and reproduce these scores. Type assertions compile Localbox's compatible methods against the official SDK declarations.

## Example with a port

```js
const sandbox = await Sandbox.create({
  name: "local-http",
  ports: [3000],
});

try {
  await sandbox.fs.writeFile("server.mjs", `
    import { createServer } from "node:http";
    createServer((_request, response) => response.end("ok"))
      .listen(3000, "0.0.0.0");
  `);
  await sandbox.runCommand({ cmd: "node", args: ["server.mjs"], detached: true });
  console.log(sandbox.domain(3000));
} finally {
  await sandbox.delete();
}
```

## Differences from Vercel Sandbox

| Area | Localbox |
| --- | --- |
| Package | Import `localbox/vercel`; it is not a transparent `@vercel/sandbox` replacement. |
| URLs | Exposed ports bind only to `127.0.0.1`; there is no public URL or reverse proxy. |
| Isolation | Docker containers share the host kernel rather than using microVM isolation. |
| Persistence | A stopped persistent container retains its writable layer; snapshots are not portable. |
| User | Commands run as the image's default user, which is root in the default image. |
| Images | Custom images require `node` and `/bin/sh`. |
| Detached commands | Handles and their replay buffers do not survive the host Node.js process. |

Docker containers are not a safe security boundary for hostile multi-tenant code.

## Lifecycle and cleanup

Persistence defaults to the Vercel-compatible value `true`. `stop()` intentionally leaves an inspectable stopped container, while `delete()` removes it. Always clean up explicitly:

```js
const sandbox = await Sandbox.create({ name: "job" });
try {
  // Use the sandbox.
} finally {
  await sandbox.delete();
}
```

Inspect a managed container directly when debugging:

```sh
docker ps -a --filter label=dev.localbox.name=<sandbox.name>
```

## Errors and fixes

| Error | Corrective action |
| --- | --- |
| `DockerUnavailableError` | Start Docker and retry. |
| `UnsupportedImageError` | Use an image containing `node` and `/bin/sh`. |
| `PortNotExposedError` | Include the TCP port in `Sandbox.create({ ports })`. |
| Image pull failure | Check the image name, registry access, and Docker credentials. |

The SDK does not write unsolicited output to the console or process streams. Observe command output with `stdout()`, `stderr()`, `output()`, `logs()`, or caller-provided `Writable` streams.
