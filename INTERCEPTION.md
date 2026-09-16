# v0.2 development interception contract

This document fixes the framework-neutral interception contract for Localbox v0.2. It is the implementation contract for [M1](ROADMAP.md#m1--development-interception-and-local-dx); the CLI and Node preload implement the core path, while the matrix below records its verified and unsupported boundaries.

This contract describes Localbox v0.2.0. The package includes the `localbox --` wrapper alongside its existing `localbox/vercel` import.

## Activation and command surface

The v0.2 command form is:

```sh
localbox -- <command> [<argument>...]
```

- Interception is enabled only by this explicit wrapper invocation. `NODE_ENV=development`, installing `localbox`, importing `localbox/vercel`, or setting any ambient configuration does not enable it.
- The `--` separator is mandatory. The first token after it is the executable and every later token is one argument passed unchanged, including later `--` tokens. Missing the separator or command is a usage error and exits with status `2` without starting a child.
- The wrapper launches the executable directly; it does not join arguments into a string or add shell parsing. A caller that wants shell behavior must name the shell explicitly, for example `localbox -- sh -c 'node app.mjs'`.

## Process contract

The wrapped command observes the same process interface it would have without Localbox, except for the process-scoped Node preload that activates interception:

- **Command and arguments:** the executable and argument vector are forwarded exactly and in order.
- **Working directory:** the child starts in the wrapper's current working directory. Localbox does not change directories.
- **Environment:** the child receives a copy of the wrapper environment. Localbox prepends its packaged `--import` registration module to any existing `NODE_OPTIONS` value so the hook is registered before the application entry point and caller-supplied `--import` preloads; existing options remain present and retain their relative order. Node always runs `--require` preloads before `--import` preloads, so provider resolution inside an existing `--require` preload is a toolchain bypass rather than supported interception. Other caller variables are unchanged. Localbox does not write the parent environment, shell profile, package-manager configuration, or machine-wide configuration.
- **Standard streams:** file descriptors `0`, `1`, and `2` are inherited, preserving TTY behavior, interactive input, output ordering, and terminal control. The wrapper does not buffer or prefix child output.
- **Normal exit:** when the child exits with a numeric status, the wrapper exits with the same status. Failure to spawn a child is a wrapper error and exits with status `1`.
- **Termination:** `SIGINT` and `SIGTERM` are the portable termination signals in this contract. The wrapper ensures its direct child receives either signal, forwarding it when the operating system has not already delivered it to the foreground process group, and does not deliberately deliver it twice. The wrapper then waits for the child to finish. If the child terminates from a signal, the wrapper terminates with the same signal where the platform permits; otherwise it uses the conventional `128 + signal number` status (`130` for `SIGINT`, `143` for `SIGTERM`). Signals that cannot be handled, including `SIGKILL`, and platform-specific job-control signals are outside this contract.

## Resolution contract

- The supported runtime range is Node.js `>=22.12.0`, matching the package `engines` field. The wrapper checks the Node runtime executing the Localbox CLI before launching the command.
- In an intercepted Node process, only the exact bare ESM specifier `@vercel/sandbox` is redirected, and it resolves to the same module exported publicly as `localbox/vercel` by the installed Localbox package.
- Static `import` and dynamic `import()` use the same mapping when they run after the Localbox preload. Package subpaths such as `@vercel/sandbox/*` and every other specifier continue through Node's next resolver unchanged.
- Direct imports of `localbox/vercel` remain supported and are never rewritten. Their behavior is the same inside and outside wrapped execution.
- The preload is carried through the wrapped environment. It therefore applies to Node processes in the descendant process tree that inherit `NODE_OPTIONS`, and Node also preloads `--import` modules in worker threads, `child_process.fork()` children, and cluster workers. A child that replaces or removes `NODE_OPTIONS` has opted out of inherited interception.
- Hook state lives only in participating Node processes. Exiting the process tree leaves no modified source, package contents, lockfiles, loader files, or persistent configuration.

## Supported topology and ordinary execution

The supported v0.2 topology is a host-installed Localbox CLI launching a host command, such as `node`, `npm`, `pnpm`, or another development tool, whose Node application processes inherit the wrapper environment. Non-Node processes may be in that tree but are not themselves subject to Node resolution hooks.

Commands launched normally, without `localbox --`, resolve `@vercel/sandbox` through the application's ordinary package resolution. Localbox does not activate from installation, `NODE_ENV`, or the presence of Docker. CI, release builds, production builds, and production startup must use ordinary execution and therefore the original provider SDK. Wrapping a production build or production process is outside the supported v0.2 contract; Localbox does not attempt to infer a command's intent.

## Initial toolchain status

| Caller or resolution path | Status | Behavior and action |
| --- | --- | --- |
| Direct Node.js ESM static import or dynamic `import()` of the exact bare `@vercel/sandbox` specifier | **Verified** | Packaged resolution tests cover both forms, and the packaged Docker smoke keeps the static application import unchanged. Run the application through `localbox --`; the import maps to `localbox/vercel`. |
| The first host-launched Node.js process launched by the wrapper with inherited `NODE_OPTIONS` | **Verified end to end** | The CLI process test covers wrapper semantics. The packaged Docker smoke installs the package archive, launches its CLI artifact, creates a Localbox sandbox, performs a file-backed command, and deletes the sandbox. |
| Further Node.js descendants, worker threads, `child_process.fork()` children, and cluster workers that preserve inherited `NODE_OPTIONS` | **Supported by documented Node behavior; not fully integration-tested** | Node preloads `--import` modules in these contexts. A descendant that deletes or replaces `NODE_OPTIONS` leaves the supported path. |
| CommonJS `require("@vercel/sandbox")`, including an existing `--require` preload | **Unsupported** | CommonJS interception is outside v0.2. `--require` also runs before Localbox's `--import` preload. Use an explicit `localbox/vercel` import in development code that can do so; Localbox does not fall back remotely. |
| Next.js, Vite, Turbopack, and other bundler or framework resolvers | **Unverified** | No core compatibility claim or adapter currently exists. Confirm the toolchain's resolution path before treating a result as a bypass; use `localbox/vercel` explicitly when acceptable. |
| Bun, Deno, and other alternate JavaScript runtimes | **Unsupported** | The core hook uses Node's `node:module` API. |
| Application callers running inside containers | **Unsupported** | The verified topology launches the application on the host and uses Docker only for Localbox sandbox execution. Caller-to-host routing is outside v0.2. |

## Packaged end-to-end evidence

The Docker CI job keeps the direct-import smoke and runs the unchanged-import smoke separately:

```sh
pnpm smoke
pnpm smoke:interception
```

`pnpm smoke` continues to execute [`examples/basic.mjs`](examples/basic.mjs) through `localbox/vercel`. `pnpm smoke:interception` packs the repository, installs that archive with the real `@vercel/sandbox@3.3.0` package in an isolated temporary application, and runs [`examples/interception/app.mjs`](examples/interception/app.mjs) through the packaged CLI. The fixture creates a uniquely named Docker sandbox, writes a file, reads it through a sandbox command, validates the result, and deletes the sandbox in `finally`.

The external driver runs an ordinary provider-resolution probe before and immediately after the wrapped command. It verifies that both ordinary runs resolve inside the installed real provider package without invoking `Sandbox.create()` or contacting the remote service. It also verifies that the parent `NODE_OPTIONS` value is unchanged and that Docker has no container carrying the fixture's unique `dev.localbox.name` label. On any failure, the driver force-removes a remaining labeled container and removes its temporary package and application directories.

## Diagnostics

Diagnostics go to standard error and identify one of these categories:

- **`LOCALBOX_UNSUPPORTED_RUNTIME`:** the CLI is running on a Node version below `22.12.0`. The diagnostic includes the detected version, the supported range, and guidance to change Node versions. The command is not launched and the wrapper exits with status `1`.
- **`LOCALBOX_HOOK_SETUP_FAILED`:** the Node version is supported but the preload or resolution hook cannot be initialized. The diagnostic preserves the underlying error and states that the application was not started and the provider was not used as a fallback.
- **`LOCALBOX_TOOLCHAIN_BYPASS`:** reserved for a framework, bundler, alternate JavaScript runtime, daemon, or child whose resolution path is directly known to run outside the participating Node hook. The diagnostic must name the observed path limitation and point to an explicit `localbox/vercel` import or an available optional adapter; it must not describe the Node runtime as unsupported.

The core wrapper cannot observe every resolver in a descendant toolchain and therefore does not infer `LOCALBOX_TOOLCHAIN_BYPASS` merely because its hook did not see a provider import. A resolver callback, toolchain configuration, replaced `NODE_OPTIONS`, or an equivalent direct observation is required evidence. Localbox does not buffer arbitrary child output to guess whether a bypass occurred.

Runtime and hook-setup failures fail closed. Any adapter that emits a bypass diagnostic must do the same: Localbox never handles an interception failure by silently selecting the installed remote `@vercel/sandbox` implementation.

## Optional adapter boundary

An adapter is an optional integration package or explicit toolchain configuration for a resolver that is proven to bypass the core Node path. It sits outside the core CLI/runtime dependency graph: an adapter may depend on Localbox, but the `localbox` package must not depend on a framework, bundler, adapter registry, or adapter package.

Adapters must be explicitly enabled for development, map only the intended provider specifier to the public `localbox/vercel` entry point, preserve ordinary provider resolution when not enabled, and fail closed with an actionable diagnostic when setup fails. They must not silently choose remote execution or claim a bypass without direct evidence from the toolchain they integrate with.

No adapter API or registry is defined until a concrete toolchain requires one. The current executable seam is the public `localbox/vercel` export plus each toolchain's own opt-in alias or resolver configuration; adding an unused core interface would broaden the contract without proving interoperability.

## Non-goals for v0.2 core interception

- Framework-specific aliases or adapters for Next.js, Vite, Turbopack, or other toolchains.
- Interception for CommonJS `require()`, alternate JavaScript runtimes, or provider package subpaths.
- Source, lockfile, or `node_modules` mutation; package-manager overrides; shell-profile changes; or global configuration.
- Remapping any package other than the exact `@vercel/sandbox` specifier.
- Containerized application callers, caller-to-host endpoint routing, reverse proxies, or public endpoint behavior. Docker remains the sandbox execution backend, not the supported caller environment for this contract.
- Recursive process supervision, daemon discovery, or guarantees for descendants that detach or replace the inherited environment.
- Changes to Vercel compatibility behavior or to the existing `localbox/vercel` direct-import API.

## Node.js basis

The CLI reads the actual runtime from [`process.versions.node`](https://nodejs.org/docs/latest-v22.x/api/process.html#processversions), which is the Node version without the leading `v`. The contract also relies on Node's documented behavior that [`--import` preloads modules](https://nodejs.org/docs/latest-v22.x/api/cli.html#--importmodule) in the main thread, workers, forked processes, and cluster workers; [`NODE_OPTIONS`](https://nodejs.org/docs/latest-v22.x/api/cli.html#node_optionsoptions) accepts `--import`; and [module customization hooks](https://nodejs.org/docs/latest-v22.x/api/module.html#customization-hooks) can be registered before application modules load. Node awaits the hook module's [`initialize`](https://nodejs.org/docs/latest-v22.x/api/module.html#initialize) function before the main application thread resumes, allowing setup failures to stop application startup. Signal forwarding follows Node's documented [signal portability](https://nodejs.org/docs/latest-v22.x/api/process.html#signal-events) and [child-process exit reporting](https://nodejs.org/docs/latest-v22.x/api/child_process.html#event-exit).
