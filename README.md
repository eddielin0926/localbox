# Localbox

Run cloud-sandbox APIs locally with Docker.

Localbox is a local runtime for cloud-sandbox APIs. Vercel Sandbox is the current compatibility target, exposed through `localbox/vercel`. No hosted Localbox service, credentials, CLI, or configuration file is required.

## Features

- Create, stop, resume, list, and delete named Docker sandboxes.
- Run blocking or detached commands with buffered and streaming output.
- Read and write files through a Node.js-style filesystem API.
- Keep a sandbox filesystem across stops with persistent containers.
- Expose container ports on loopback-only host URLs.
- Use Vercel-shaped types and behavior for the supported surface.

## Prerequisites

- Node.js 22.12 or newer
- A reachable Docker daemon
- Registry access for the first image pull

## Installation

```sh
pnpm add localbox
```

Start Docker before creating a sandbox. The default image is `node:24-bookworm-slim`; Docker downloads it on first use and reuses its local cache afterward.

## Usage

Import the current Vercel-compatible API from `localbox/vercel`:

```js
import { Sandbox } from "localbox/vercel";

const sandbox = await Sandbox.create({ name: "hello-localbox" });

try {
  await sandbox.fs.writeFile("hello.mjs", `
    const message = "hello from Localbox";
    process.stdout.write(message);
  `);

  const command = await sandbox.runCommand("node", ["hello.mjs"]);
  console.log(await command.stdout());
} finally {
  await sandbox.delete();
}
```

`Sandbox.create()` uses a five-minute timeout, persistent storage, and `/vercel/sandbox` as the working directory by default. Use `runtime: "node24"` for the default image or pass a custom `image` containing `node` and `/bin/sh`.

### Run an HTTP server

Declare ports when creating the sandbox. Localbox binds them to random ports on `127.0.0.1`:

```js
import { Sandbox } from "localbox/vercel";

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

  await sandbox.runCommand({
    cmd: "node",
    args: ["server.mjs"],
    detached: true,
  });

  console.log(sandbox.domain(3000));
} finally {
  await sandbox.delete();
}
```

See [`examples/basic.mjs`](examples/basic.mjs) for a runnable example covering ports, persistence, and cleanup.

## API reference

### Sandbox creation options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | Generated UUID | Stable local sandbox name. |
| `image` | `string` | `node:24-bookworm-slim` | Docker image containing `node` and `/bin/sh`. |
| `runtime` | `"node24"` | `"node24"` | Selects the default Node.js image. |
| `ports` | `number[]` | `[]` | TCP ports to expose on `127.0.0.1`. |
| `timeout` | `number` | `300000` | Sandbox lifetime in milliseconds. |
| `env` | `Record<string, string>` | `{}` | Environment variables added to the container. |
| `persistent` | `boolean` | `true` | Retain the container filesystem after `stop()`. |
| `signal` | `AbortSignal` | - | Cancels creation. |

### Sandbox

| API | Description |
| --- | --- |
| `Sandbox.create(options?)` | Creates and starts a sandbox. |
| `Sandbox.get({ name, resume? })` | Opens a named sandbox. It stays stopped unless `resume` is true or an operation needs it. |
| `Sandbox.getOrCreate(options)` | Opens a named sandbox or creates it when absent. Supports `onCreate` and `onResume` callbacks. |
| `Sandbox.list(options?)` | Lists managed sandboxes with filtering, sorting, pagination, page iteration, and item iteration. |
| `sandbox.refresh()` | Reconciles cached status with Docker without resuming the sandbox. Localbox extension. |
| `sandbox.runCommand(...)` | Runs a command directly, without an implicit shell. Supports blocking and detached execution. |
| `sandbox.domain(port)` | Returns the loopback HTTP URL for an exposed port. |
| `sandbox.extendTimeout(ms)` | Adds milliseconds to the current in-container deadline. |
| `sandbox.stop()` | Stops the sandbox. Persistent sandboxes retain their writable layer. |
| `sandbox.delete()` | Force-removes the container and invalidates the handle. |
| `sandbox.mkDir(path)` | Creates a directory recursively. |
| `sandbox.writeFiles(files)` | Writes multiple text or binary files, with optional modes. |
| `sandbox.readFile(source)` | Returns a readable stream, or `null` when the file does not exist. |
| `sandbox.readFileToBuffer(source)` | Returns a `Buffer`, or `null` when the file does not exist. |
| `sandbox.downloadFile(source, destination)` | Copies a sandbox file to the host and returns its resolved path. |

A sandbox exposes `name`, `persistent`, `image`, `ports`, `timeout`, `createdAt`, `status`, `expiresAt`, and `fs`.

### Commands

`runCommand` accepts either `(cmd, args?, options?)` or an options object with `cmd`, `args`, `cwd`, `env`, `detached`, `stdout`, `stderr`, and `signal`.

| API | Description |
| --- | --- |
| `command.logs(options?)` | Async iterator that replays buffered chunks and follows live stdout and stderr. |
| `command.wait(options?)` | Waits for completion and returns a `CommandFinished`. |
| `command.output(stream?, options?)` | Returns buffered `stdout`, `stderr`, or both. |
| `command.stdout(options?)` | Returns buffered standard output. |
| `command.stderr(options?)` | Returns buffered standard error. |
| `command.kill(signal?, options?)` | Sends a portable signal name or signal number to the command. |

Command handles expose `cmdId`, `cwd`, `startedAt`, `exitCode`, and `durationMs`.

### Filesystem

Paths are relative to `/vercel/sandbox` unless absolute. Methods accept an `AbortSignal` through their options.

| API | Description |
| --- | --- |
| `fs.readFile(path, options?)` | Reads a file as a `Buffer` or encoded string. |
| `fs.writeFile(path, data, options?)` | Writes text or binary data. |
| `fs.appendFile(path, data, options?)` | Appends text or binary data. |
| `fs.mkdir(path, options?)` | Creates a directory, optionally recursively. |
| `fs.readdir(path, options?)` | Lists names or `Dirent` objects. |
| `fs.stat(path, options?)` | Reads target metadata. |
| `fs.lstat(path, options?)` | Reads link metadata without following the link. |
| `fs.unlink(path, options?)` | Removes a file or symbolic link. |
| `fs.rm(path, options?)` | Removes a path, optionally recursively or forcibly. |
| `fs.rmdir(path, options?)` | Removes an empty directory. |
| `fs.rename(oldPath, newPath, options?)` | Renames or moves a path. |
| `fs.copyFile(source, destination, options?)` | Copies a file. |
| `fs.access(path, options?)` | Checks whether a path is accessible. |
| `fs.exists(path, options?)` | Returns whether a path exists. |
| `fs.chmod(path, mode, options?)` | Changes file mode bits. |
| `fs.chown(path, uid, gid, options?)` | Changes numeric ownership. |
| `fs.symlink(target, path, options?)` | Creates a symbolic link. |
| `fs.readlink(path, options?)` | Reads a symbolic link target. |
| `fs.realpath(path, options?)` | Resolves a canonical absolute path. |
| `fs.truncate(path, length?, options?)` | Resizes a file. |
| `fs.mkdtemp(prefix, options?)` | Creates a unique temporary directory. |

## Vercel compatibility

Vercel Sandbox is Localbox's current compatibility target. Import it from `localbox/vercel`; Localbox is not a transparent replacement for `@vercel/sandbox`.

Compatibility is checked against `@vercel/sandbox@3.3.0`. The versioned [`compatibility.json`](src/vercel/compatibility.json) records each assessed method, its type compatibility, behavioral differences, and unsupported APIs. Run the report locally with:

```sh
pnpm compatibility:vercel
```

The complete documented `Command` and `FileSystem` method sets in that manifest are implemented. The supported `Sandbox` subset covers local lifecycle, commands, files, ports, and timeouts. Cloud control-plane features such as snapshots, forks, sessions, users and groups, interactive terminals, resource updates, regions, and network policies are not implemented.

### Differences from Vercel Sandbox

| Area | Localbox behavior |
| --- | --- |
| Import | Uses `localbox/vercel`. |
| URLs | Exposed ports use loopback URLs; there is no public domain or reverse proxy. |
| Isolation | Docker containers share the host kernel instead of using microVM isolation. |
| Persistence | A stopped persistent container retains its writable layer; snapshots are not portable. |
| User | Commands use the image's default user, which is root in the default image. |
| Detached commands | Handles and replay buffers exist only in the host Node.js process that created them. |

## Lifecycle and cleanup

`stop()` preserves a persistent sandbox for later use. `Sandbox.get({ name })` returns its handle without starting it; the first command or filesystem operation resumes it automatically. `delete()` permanently removes the container.

Always clean up sandboxes that should not survive:

```js
const sandbox = await Sandbox.create({ name: "job" });
try {
  // Use the sandbox.
} finally {
  await sandbox.delete();
}
```

Inspect managed containers directly when debugging:

```sh
docker ps -a --filter label=dev.localbox.name=<sandbox-name>
```

## Security

Localbox is intended for local development and trusted workloads. Docker containers share the host kernel and are not a safe isolation boundary for hostile multi-tenant code. Exposed ports bind only to `127.0.0.1`, and containers run with Docker's `no-new-privileges` security option.

## Troubleshooting

| Error | Action |
| --- | --- |
| `DockerUnavailableError` | Start Docker and retry. |
| `UnsupportedImageError` | Use an image containing `node` and `/bin/sh`. |
| `PortNotExposedError` | Include the TCP port in `Sandbox.create({ ports })`. |
| Image pull failure | Check the image name, registry access, and Docker credentials. |

The SDK does not write unsolicited output to console or process streams. Read command output with `stdout()`, `stderr()`, `output()`, or `logs()`, or provide `Writable` streams to `runCommand`.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm smoke
pnpm compatibility:vercel
```
