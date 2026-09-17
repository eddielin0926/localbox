import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import { delimiter, dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { FILESYSTEM_TRANSFER_CHUNK_BYTES } from "../../runtime/filesystem-bridge.js";
import { negotiateSandboxRequirements } from "../../runtime/capabilities.js";
import {
  validateBootArtifact,
  type AvailabilityDiagnostic,
  type BackendReference,
  type ClientFailure,
  type ClientResult,
  type CreateSandboxRequest,
  type CreateSandboxResult,
  type DeleteSandboxRequest,
  type DeleteSandboxResult,
  type ExtendSandboxDeadlineRequest,
  type ExtendSandboxDeadlineResult,
  type GetEndpointRequest,
  type GetEndpointResult,
  type GetSandboxRequest,
  type GetSandboxResult,
  type JsonObject,
  type ListSandboxesRequest,
  type ListSandboxesResult,
  type ProbeAvailabilityRequest,
  type ProbeAvailabilityResult,
  type RequestMetadata,
  type SandboxBackend,
  type SandboxCapabilities,
  type SandboxNetworkPolicy,
  type SandboxRecord,
  type StartRawCommandRequest,
  type StartRawCommandResult,
  type StopSandboxRequest,
  type StopSandboxResult,
} from "../../runtime/index.js";
import { LocalRawCommand } from "../local-command.js";
import { ProcessBackend } from "../process/index.js";

const VIRTUAL_WORKSPACE = "/vercel/sandbox";
const INTERNAL_NETWORK_TAG = "localbox.internal.bwrap.network-policy";
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const HOST_ARTIFACT = Object.freeze({
  kind: "host",
  locator: { type: "host", selector: "current" },
  trust: "trusted",
  mutability: "mutable",
} as const);

export const BWRAP_CAPABILITIES = Object.freeze({
  schemaVersion: 1,
  operations: {
    "command.start": {
      support: "native",
      constraints: null,
      diagnostic: "Commands run as direct argv inside fresh bubblewrap user, mount, PID, IPC, and UTS namespaces.",
    },
    "command.detached": {
      support: "emulated",
      constraints: null,
      diagnostic: "The embedded runtime retains detached command state while a supervised bubblewrap process owns descendant cleanup; commands are not recoverable after restart.",
    },
    "endpoint.expose": {
      support: "unsupported",
      constraints: { protocols: [], visibilities: [] },
      diagnostic: "Bubblewrap does not provide deterministic port publication or remapping, so endpoints are not advertised.",
    },
    "filesystem.mkdir": {
      support: "native",
      constraints: null,
      diagnostic: "The neutral filesystem bridge executes inside the namespace against the sole writable /vercel/sandbox bind.",
    },
    "filesystem.read": {
      support: "native",
      constraints: null,
      diagnostic: "Filesystem reads execute inside the namespace; host paths outside explicit read-only runtime mounts are absent.",
    },
    "filesystem.write": {
      support: "native",
      constraints: null,
      diagnostic: "Filesystem writes are limited by the mount graph to the sandbox workspace and private tmpfs mounts.",
    },
    "source.git": {
      support: "unsupported",
      constraints: null,
      diagnostic: "The bubblewrap backend does not clone Git sources.",
    },
    "source.tarball": {
      support: "unsupported",
      constraints: null,
      diagnostic: "The bubblewrap backend does not download or extract tarballs.",
    },
    "raw-command.input": {
      support: "native",
      constraints: { maxBytes: FILESYSTEM_TRANSFER_CHUNK_BYTES },
      diagnostic: `The local supervisor accepts one bounded stdin payload up to ${FILESYSTEM_TRANSFER_CHUNK_BYTES} bytes.`,
    },
    "raw-command.managed-filesystem-owner": {
      support: "unsupported",
      constraints: { managedImagesOnly: true },
      diagnostic: "Commands retain the invoking uid/gid mapping; managed ownership and alternate users are unsupported.",
    },
  },
  isolation: {
    support: "native",
    constraints: { level: "namespace-sandbox", tenancies: ["trusted", "single-tenant"] },
    diagnostic: "Linux namespaces and a fail-closed mount graph isolate processes and filesystems, but the host kernel is shared and this is not a hostile multi-tenant or microVM boundary.",
  },
  artifacts: {
    support: "partial",
    constraints: { kinds: ["host"] },
    diagnostic: "Only the validated mutable current-host artifact is accepted; directory, OCI, disk, and snapshot artifacts never degrade to host execution.",
  },
  persistence: {
    support: "native",
    constraints: { scopes: ["sandbox-lifecycle", "backend-restart"] },
    diagnostic: "Private workspaces and lifecycle descriptors persist across stop/resume and backend reconstruction.",
  },
  recovery: {
    support: "partial",
    constraints: { scopes: ["sandbox"] },
    diagnostic: "Sandbox metadata and workspace data recover; commands, output, waiters, and idempotency state do not.",
  },
  networking: {
    support: "native",
    constraints: { modes: ["allow-all", "deny-all"], portExposure: [], customPolicies: false },
    diagnostic: "Allow-all explicitly retains host networking; deny-all creates a fresh network namespace. Port exposure and custom policies are unsupported.",
  },
  resources: {
    support: "unsupported",
    constraints: {
      cpu: { minimumVcpus: 1, maximumVcpus: null, stepVcpus: 1 },
      memory: { minimumBytes: 1, maximumBytes: null, stepBytes: 1 },
      memoryBytesPerVcpu: null,
      enforcement: "best-effort",
    },
    diagnostic: "The bubblewrap backend does not enforce cgroup CPU or memory limits.",
  },
  terminals: {
    support: "unsupported",
    constraints: { modes: [] },
    diagnostic: "Only non-interactive exec is supported; --new-session prevents controlling-terminal injection and no PTY is allocated.",
  },
  snapshots: {
    support: "unsupported",
    constraints: { operations: [] },
    diagnostic: "The bubblewrap backend does not create, restore, or clone snapshots.",
  },
} as const satisfies SandboxCapabilities);

export interface BwrapBackendOptions {
  /** Absolute, canonicalizable private state root. */
  readonly root: string;
  /** Stable identity allowing independent backend instances below one root. */
  readonly instanceId: string;
  /** Optional absolute bubblewrap executable used instead of PATH lookup. */
  readonly binaryPath?: string;
}

interface ProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface BindEntry {
  readonly source: string;
  readonly destination: string;
}

class BwrapOperationError extends Error {
  constructor(
    readonly category: ClientFailure["error"]["category"],
    readonly code: string,
    message: string,
    readonly details: ClientFailure["error"]["details"],
    readonly retryable = false,
  ) {
    super(message);
  }
}

export class BwrapBackend implements SandboxBackend {
  readonly reference: BackendReference;
  readonly capabilities = BWRAP_CAPABILITIES;
  readonly root: string;
  readonly instanceId: string;
  readonly binaryPath: string | undefined;
  readonly #state: ProcessBackend;
  readonly #commands = new Map<string, Set<LocalRawCommand>>();
  readonly #environments = new Map<string, Readonly<Record<string, string>>>();
  readonly #deadlineTimers = new Map<string, NodeJS.Timeout>();
  #resolvedBinary: Promise<string> | undefined;

  constructor(options: BwrapBackendOptions) {
    if (!isAbsolute(options.root)) {
      throw new TypeError("The bubblewrap backend root must be an absolute path.");
    }
    if (options.instanceId.length === 0 || options.instanceId.includes("\0")) {
      throw new TypeError("The bubblewrap backend instance ID must be a non-empty string without NUL bytes.");
    }
    if (options.binaryPath !== undefined && !isAbsolute(options.binaryPath)) {
      throw new TypeError("The injected bubblewrap binary path must be absolute.");
    }
    this.root = resolve(options.root);
    this.instanceId = options.instanceId;
    this.binaryPath = options.binaryPath === undefined ? undefined : resolve(options.binaryPath);
    const identity = createHash("sha256").update(`${this.root}\0${this.instanceId}`, "utf8").digest("hex");
    this.reference = Object.freeze({ backendId: `local-bwrap-${identity}`, backendType: "bwrap" });
    this.#state = new ProcessBackend({ root: this.root, instanceId: `bwrap:${this.instanceId}` });
  }

  probeAvailability(request: ProbeAvailabilityRequest): Promise<ClientResult<ProbeAvailabilityResult>> {
    return this.#run(request, "probeAvailability", async () => {
      const diagnostics: AvailabilityDiagnostic[] = [];
      if (process.platform !== "linux") {
        diagnostics.push({
          code: "BWRAP_PLATFORM_UNSUPPORTED",
          severity: "error",
          message: "The bubblewrap backend requires Linux namespace and mount APIs.",
          action: "Use this backend on Linux, or select another backend supported by the host.",
          details: { type: "bwrap-platform", platform: process.platform },
        });
        return { availability: this.#availability(diagnostics) };
      }

      const rootDiagnostic = await this.#rootDiagnostic();
      if (rootDiagnostic !== null) diagnostics.push(rootDiagnostic);

      const policyDiagnostic = await this.#namespacePolicyDiagnostic();
      if (policyDiagnostic !== null) diagnostics.push(policyDiagnostic);

      let binary: string | undefined;
      try {
        binary = await this.#resolveBinary();
      } catch {
        diagnostics.push({
          code: "BWRAP_BINARY_NOT_FOUND",
          severity: "error",
          message: "A usable bubblewrap executable was not found.",
          action: "Install the distribution bubblewrap package or configure an absolute executable path.",
          details: { type: "bwrap-binary", prerequisite: "executable" },
        });
      }

      if (binary !== undefined) {
        const version = await runProcess(binary, ["--version"]);
        const versionText = version.stdout.trim();
        if (version.exitCode !== 0 || !/^bubblewrap\s+\d+(?:\.\d+)+$/i.test(versionText)) {
          diagnostics.push({
            code: "BWRAP_VERSION_INCOMPATIBLE",
            severity: "error",
            message: "The bubblewrap executable did not report a compatible version.",
            action: "Install a supported distribution bubblewrap package with the documented command-line interface.",
            details: { type: "bwrap-binary", prerequisite: "compatible-version" },
          });
        } else if (!diagnostics.some(({ severity }) => severity === "error")) {
          try {
            const [allowProbe, denyProbe] = await Promise.all([
              this.#probeNamespaces(binary, "allow-all"),
              this.#probeNamespaces(binary, "deny-all"),
            ]);
            if (allowProbe.exitCode !== 0) diagnostics.push(this.#classifyProbeFailure(allowProbe));
            else if (denyProbe.exitCode !== 0) diagnostics.push(this.#classifyProbeFailure(denyProbe));
            else diagnostics.push({
              code: "BWRAP_PREREQUISITES_AVAILABLE",
              severity: "info",
              message: `Bubblewrap ${versionText.replace(/^bubblewrap\s+/i, "")} completed allow-all and deny-all namespace probes.`,
              action: "No action is required.",
              details: { type: "bwrap-probe", reason: "available" },
            });
          } catch {
            diagnostics.push({
              code: "BWRAP_PROBE_FAILED",
              severity: "error",
              message: "The bubblewrap namespace probe could not be executed.",
              action: "Verify the bubblewrap package, kernel namespace support, and host security policy.",
              details: { type: "bwrap-probe", reason: "unknown" },
            });
          }
        }
      }
      this.#assertRequestDeadline(request, "probeAvailability");
      return { availability: this.#availability(diagnostics) };
    });
  }

  createSandbox(request: CreateSandboxRequest): Promise<ClientResult<CreateSandboxResult>> {
    return this.#run(request, "createSandbox", async () => {
      this.#validateCreate(request);
      if (request.spec.networkPolicy === "deny-all") {
        const probe = await this.#probeNamespaces(await this.#resolveBinary(), "deny-all");
        if (probe.exitCode !== 0) {
          throw new BwrapOperationError(
            "backend-unavailable",
            "LOCALBOX_BWRAP_NETWORK_NAMESPACE_UNAVAILABLE",
            "The deny-all network namespace could not be created.",
            { type: "backend", operation: "createSandbox" },
          );
        }
      }
      const result = await this.#state.createSandbox({
        ...request,
        backend: this.#state.reference,
        requirements: [],
        spec: {
          ...request.spec,
          networkPolicy: "allow-all",
          tags: { ...request.spec.tags, [INTERNAL_NETWORK_TAG]: request.spec.networkPolicy },
        },
      });
      if (!result.ok) return this.#translateFailure(request, result);
      this.#environments.set(request.sandboxId, { ...request.spec.environment });
      const sandbox = this.#record(result.value.sandbox);
      this.#scheduleDeadline(sandbox);
      return { sandbox };
    });
  }

  getSandbox(request: GetSandboxRequest): Promise<ClientResult<GetSandboxResult>> {
    return this.#run(request, "getSandbox", async () => {
      const result = await this.#state.getSandbox(request);
      if (!result.ok) return this.#translateFailure(request, result);
      const sandbox = this.#record(result.value.sandbox);
      this.#scheduleDeadline(sandbox);
      return { sandbox };
    });
  }

  listSandboxes(request: ListSandboxesRequest): Promise<ClientResult<ListSandboxesResult>> {
    return this.#run(request, "listSandboxes", async () => {
      const result = await this.#state.listSandboxes(request);
      if (!result.ok) return this.#translateFailure(request, result);
      const sandboxes = result.value.sandboxes.map((record) => this.#record(record));
      for (const sandbox of sandboxes) this.#scheduleDeadline(sandbox);
      return { sandboxes, nextCursor: result.value.nextCursor };
    });
  }

  stopSandbox(request: StopSandboxRequest): Promise<ClientResult<StopSandboxResult>> {
    return this.#run(request, "stopSandbox", async () => {
      await this.#terminateSandbox(request.sandboxId);
      const result = await this.#state.stopSandbox(request);
      if (!result.ok) return this.#translateFailure(request, result);
      this.#clearDeadline(request.sandboxId);
      return { sandbox: this.#record(result.value.sandbox) };
    });
  }

  deleteSandbox(request: DeleteSandboxRequest): Promise<ClientResult<DeleteSandboxResult>> {
    return this.#run(request, "deleteSandbox", async () => {
      await this.#terminateSandbox(request.sandboxId);
      const result = await this.#state.deleteSandbox(request);
      if (!result.ok) return this.#translateFailure(request, result);
      this.#clearDeadline(request.sandboxId);
      this.#environments.delete(request.sandboxId);
      return result.value;
    });
  }

  extendSandboxDeadline(request: ExtendSandboxDeadlineRequest): Promise<ClientResult<ExtendSandboxDeadlineResult>> {
    return this.#run(request, "extendSandboxDeadline", async () => {
      const result = await this.#state.extendSandboxDeadline(request);
      if (!result.ok) return this.#translateFailure(request, result);
      const sandbox = this.#record(result.value.sandbox);
      this.#scheduleDeadline(sandbox);
      return { sandbox };
    });
  }

  async startRawCommand(request: StartRawCommandRequest, signal?: AbortSignal): Promise<StartRawCommandResult> {
    try {
      this.#assertRequestDeadline(request, "startCommand");
      if (signal?.aborted) throw new DOMException("The operation was cancelled.", "AbortError");
      if (request.privilege !== undefined) {
        throw new BwrapOperationError("failed-precondition", "LOCALBOX_UNSUPPORTED_CAPABILITY", "The bubblewrap backend does not support privileged raw commands.", { type: "backend", operation: "startCommand" });
      }
      if (request.command.user !== undefined) {
        throw this.#invalid("command.user", "The bubblewrap backend does not support alternate command users.");
      }
      const input = request.input === undefined ? null : Buffer.from(request.input.data, request.input.encoding);
      if (input !== null && input.length > FILESYSTEM_TRANSFER_CHUNK_BYTES) {
        throw this.#invalid("input", `Raw command input cannot exceed ${FILESYSTEM_TRANSFER_CHUNK_BYTES} bytes.`);
      }
      const state = await this.#state.getSandbox({
        requestId: request.requestId,
        idempotencyKey: `bwrap-command-${request.requestId}`,
        deadline: request.deadline,
        sandboxId: request.sandboxId,
        resume: false,
      });
      if (!state.ok) return this.#translateFailure(request, state);
      if (state.value.sandbox.status !== "running") {
        throw new BwrapOperationError("failed-precondition", "LOCALBOX_SANDBOX_STOPPED", `Sandbox '${request.sandboxId}' is stopped.`, {
          type: "resource", resource: "sandbox", resourceId: request.sandboxId,
        });
      }
      const policy = this.#networkPolicy(state.value.sandbox);
      const workspace = await this.#state.filesystemWorkspace(request.sandboxId);
      const cwd = await this.#validateVirtualCwd(workspace.root, request.command.cwd);
      const environment: Record<string, string> = {
        ...(this.#environments.get(request.sandboxId) ?? {}),
        ...request.command.environment,
      };
      for (const [key, value] of Object.entries(environment)) {
        if (key.length === 0 || key.includes("=") || key.includes("\0") || value.includes("\0")) {
          throw this.#invalid("command.environment", "Command environment names and values must be valid process environment strings.");
        }
      }
      const binary = await this.#resolveBinary();
      const arguments_ = await this.#sandboxArguments(policy, workspace.root, cwd, request.command, environment);
      let raw: LocalRawCommand;
      raw = new LocalRawCommand({
        command: binary,
        arguments: arguments_,
        cwd: "/",
        environment: minimalHostEnvironment(),
        input,
        description: "bubblewrap command",
        failureCode: "LOCALBOX_BWRAP_SUPERVISOR_FAILURE",
      }, () => {
        const commands = this.#commands.get(request.sandboxId);
        commands?.delete(raw);
        if (commands?.size === 0) this.#commands.delete(request.sandboxId);
      });
      const commands = this.#commands.get(request.sandboxId) ?? new Set<LocalRawCommand>();
      commands.add(raw);
      this.#commands.set(request.sandboxId, commands);
      try {
        await raw.waitUntilStarted(signal);
      } catch (error) {
        await raw.dispose().catch(() => undefined);
        throw error;
      }
      return { ok: true, command: raw };
    } catch (error) {
      return this.#failure(request, "startCommand", error);
    }
  }

  getEndpoint(request: GetEndpointRequest): Promise<ClientResult<GetEndpointResult>> {
    return Promise.resolve(this.#failure(request, "getEndpoint", new BwrapOperationError(
      "failed-precondition",
      "LOCALBOX_UNSUPPORTED_CAPABILITY",
      "The bubblewrap backend does not expose or remap ports.",
      { type: "backend", operation: "getEndpoint" },
    )));
  }

  async #sandboxArguments(
    policy: SandboxNetworkPolicy,
    workspace: string | null,
    cwd: string,
    command: StartRawCommandRequest["command"],
    environment: Readonly<Record<string, string>>,
  ): Promise<string[]> {
    const args = await this.#namespaceArguments(policy);
    if (workspace !== null) {
      await this.#validateBindSource(workspace, "workspace", true);
      args.push("--dir", "/vercel", "--bind", workspace, VIRTUAL_WORKSPACE);
    }
    args.push("--chdir", cwd, "--clearenv");
    const nodeBin = dirname(await realpath(process.execPath));
    const commandPath = [nodeBin, "/usr/local/bin", "/usr/bin", "/bin"].filter((value, index, values) => values.indexOf(value) === index).join(":");
    const sandboxEnvironment: Record<string, string> = {
      PATH: commandPath,
      HOME: "/home/localbox",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      ...environment,
    };
    for (const [key, value] of Object.entries(sandboxEnvironment)) args.push("--setenv", key, value);
    args.push("--", command.command, ...command.arguments);
    return args;
  }

  async #namespaceArguments(policy: SandboxNetworkPolicy): Promise<string[]> {
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      policy === "deny-all" ? "--unshare-net" : "--share-net",
      "--uid", String(process.getuid?.() ?? 0),
      "--gid", String(process.getgid?.() ?? 0),
      "--hostname", "localbox",
    ];
    const { binds, symlinks } = await this.#runtimeMounts();
    for (const bind of binds) args.push("--ro-bind", bind.source, bind.destination);
    for (const [destination, target] of symlinks) args.push("--symlink", target, destination);
    args.push(
      "--dir", "/etc",
      "--proc", "/proc",
      "--dev", "/dev",
      "--perms", "0700", "--tmpfs", "/tmp",
      "--perms", "0700", "--tmpfs", "/run",
      "--perms", "0700", "--tmpfs", "/home",
      "--dir", "/home/localbox",
      "--perms", "0700", "--tmpfs", "/root",
    );
    for (const bind of await this.#optionalEtcBinds()) args.push("--ro-bind", bind.source, bind.destination);
    return args;
  }

  async #runtimeMounts(): Promise<{
    readonly binds: readonly BindEntry[];
    readonly symlinks: readonly (readonly [string, string])[];
  }> {
    const binds: BindEntry[] = [];
    const symlinks: (readonly [string, string])[] = [];
    await this.#validateBindSource("/usr", "system runtime");
    binds.push({ source: "/usr", destination: "/usr" });
    for (const path of ["/bin", "/sbin", "/lib", "/lib64"]) {
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
          const target = await readlink(path);
          const resolved = resolve(dirname(path), target);
          if (resolved !== "/usr" && !resolved.startsWith("/usr/")) {
            throw new Error("System runtime symlink escapes /usr.");
          }
          symlinks.push([path, target]);
        } else if (metadata.isDirectory()) {
          await this.#validateBindSource(path, "system runtime");
          binds.push({ source: path, destination: path });
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    const executable = await realpath(process.execPath);
    if (!["/usr", "/bin", "/sbin", "/lib", "/lib64"].some((root) => inside(root, executable))) {
      const runtimeRoot = dirname(dirname(executable));
      await this.#validateBindSource(runtimeRoot, "Node runtime");
      binds.push({ source: runtimeRoot, destination: runtimeRoot });
    }
    return { binds, symlinks };
  }

  async #optionalEtcBinds(): Promise<readonly BindEntry[]> {
    const binds: BindEntry[] = [];
    for (const destination of [
      "/etc/ssl/certs",
      "/etc/ca-certificates",
      "/etc/resolv.conf",
      "/etc/hosts",
      "/etc/nsswitch.conf",
      "/etc/gai.conf",
    ]) {
      try {
        const source = await realpath(destination);
        await this.#validateBindSource(source, "runtime configuration");
        binds.push({ source, destination });
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTDIR")) throw error;
      }
    }
    return binds;
  }

  async #validateBindSource(
    source: string,
    purpose: string,
    allowBackendDescendant = false,
  ): Promise<void> {
    if (!isAbsolute(source) || source === sep || source.includes("\0")) {
      throw new Error(`Invalid ${purpose} bind source.`);
    }
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`Invalid ${purpose} bind source.`);
    }
    const canonical = await realpath(source);
    if (canonical !== source) throw new Error(`The ${purpose} bind source traverses a symbolic link.`);
    if (!allowBackendDescendant && overlaps(source, this.root)) {
      throw new Error(`The ${purpose} bind source overlaps the private backend root.`);
    }
    if (allowBackendDescendant && !inside(this.root, source)) {
      throw new Error(`The ${purpose} bind source is not owned by the private backend root.`);
    }
  }

  async #probeNamespaces(binary: string, policy: SandboxNetworkPolicy): Promise<ProbeResult> {
    const args = await this.#sandboxArguments(policy, null, "/", {
      command: "/usr/bin/true",
      arguments: [],
      cwd: "/",
      environment: {},
    }, {});
    return runProcess(binary, args);
  }

  #classifyProbeFailure(result: ProbeResult): AvailabilityDiagnostic {
    const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (output.includes("apparmor") || output.includes("restrict_unprivileged_userns")) {
      return {
        code: "BWRAP_APPARMOR_RESTRICTED",
        severity: "error",
        message: "Host AppArmor policy blocked the unprivileged bubblewrap namespace probe.",
        action: "Enable the distribution's supported unprivileged-user-namespace policy for bubblewrap, or use another backend.",
        details: { type: "bwrap-probe", reason: "apparmor" },
      };
    }
    if (output.includes("user namespace") || output.includes("max_user_namespaces") || output.includes("no permissions to create new namespace")) {
      return {
        code: "BWRAP_USER_NAMESPACE_DISABLED",
        severity: "error",
        message: "Unprivileged user namespaces are disabled or unavailable.",
        action: "Enable unprivileged user namespaces according to the host distribution's security guidance.",
        details: { type: "bwrap-probe", reason: "user-namespace-disabled" },
      };
    }
    if (output.includes("operation not permitted") || output.includes("permission denied") || output.includes("eperm")) {
      return {
        code: "BWRAP_PERMISSION_DENIED",
        severity: "error",
        message: "The kernel or host security policy denied bubblewrap namespace setup.",
        action: "Inspect user-namespace, seccomp, LSM, and container privilege policy for the Localbox process.",
        details: { type: "bwrap-probe", reason: "permission-denied" },
      };
    }
    if (output.includes("unknown option") || output.includes("invalid option") || output.includes("usage:")) {
      return {
        code: "BWRAP_VERSION_INCOMPATIBLE",
        severity: "error",
        message: "The installed bubblewrap does not support the required namespace arguments.",
        action: "Upgrade to a distribution bubblewrap package supporting the documented arguments.",
        details: { type: "bwrap-probe", reason: "incompatible-arguments" },
      };
    }
    return {
      code: "BWRAP_PROBE_FAILED",
      severity: "error",
      message: `Bubblewrap namespace setup failed with exit code ${result.exitCode}.`,
      action: "Run the documented availability checks for the host kernel and bubblewrap package.",
      details: { type: "bwrap-probe", reason: "unknown" },
    };
  }

  async #namespacePolicyDiagnostic(): Promise<AvailabilityDiagnostic | null> {
    const values = await Promise.all([
      readOptionalInteger("/proc/sys/user/max_user_namespaces"),
      readOptionalInteger("/proc/sys/kernel/unprivileged_userns_clone"),
      readOptionalInteger("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
    ]);
    if (values[0] === 0 || values[1] === 0) {
      return {
        code: "BWRAP_USER_NAMESPACE_DISABLED",
        severity: "error",
        message: "The readable kernel policy disables unprivileged user namespaces.",
        action: "Enable unprivileged user namespaces according to the host distribution's security guidance.",
        details: { type: "bwrap-kernel-policy", reason: "user-namespace-disabled" },
      };
    }
    if (values[2] === 1) {
      return {
        code: "BWRAP_APPARMOR_RESTRICTED",
        severity: "warning",
        message: "The readable AppArmor policy restricts unprivileged user namespaces unless an allowed application profile applies.",
        action: "Ensure the distribution-supported bubblewrap AppArmor profile is installed; the execution probe will verify it.",
        details: { type: "bwrap-kernel-policy", reason: "apparmor" },
      };
    }
    return null;
  }

  async #rootDiagnostic(): Promise<AvailabilityDiagnostic | null> {
    let nearest = this.root;
    let metadata: Stats | undefined;
    for (;;) {
      try {
        metadata = await lstat(nearest);
        break;
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          return {
            code: "BWRAP_ROOT_INACCESSIBLE",
            severity: "error",
            message: "The configured private backend root cannot be inspected.",
            action: "Grant read, write, and execute access to the root or its nearest existing parent.",
            details: { type: "bwrap-root", prerequisite: "read-write-execute" },
          };
        }
        const parent = dirname(nearest);
        if (parent === nearest) break;
        nearest = parent;
      }
    }
    if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return {
        code: "BWRAP_ROOT_INVALID",
        severity: "error",
        message: "The configured private backend root or its nearest existing parent is not a real directory.",
        action: "Configure a canonical absolute path containing only non-symlink directories.",
        details: { type: "bwrap-root", prerequisite: metadata?.isSymbolicLink() ? "non-symlink" : "directory" },
      };
    }
    try {
      if (await realpath(nearest) !== nearest) {
        return {
          code: "BWRAP_ROOT_INVALID",
          severity: "error",
          message: "The configured private backend root traverses a symbolic link.",
          action: "Configure a canonical absolute path containing only non-symlink directories.",
          details: { type: "bwrap-root", prerequisite: "non-symlink" },
        };
      }
      await access(nearest, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      return {
        code: "BWRAP_ROOT_INACCESSIBLE",
        severity: "error",
        message: "The Localbox user cannot create or access private bubblewrap state.",
        action: "Grant read, write, and execute access to the root or its nearest existing parent.",
        details: { type: "bwrap-root", prerequisite: "read-write-execute" },
      };
    }
    return null;
  }

  async #resolveBinary(): Promise<string> {
    this.#resolvedBinary ??= resolveExecutable(this.binaryPath ?? "bwrap");
    return this.#resolvedBinary;
  }

  #validateCreate(request: CreateSandboxRequest): void {
    const issues = negotiateSandboxRequirements(this.capabilities, request.requirements);
    if (issues.length > 0) {
      const unsupported = issues.some((issue) => issue.kind === "unsupported" || issue.kind === "constraint");
      throw new BwrapOperationError(
        unsupported ? "unsupported-requirement" : "invalid-request",
        unsupported ? "LOCALBOX_UNSUPPORTED_REQUIREMENT" : "LOCALBOX_INVALID_REQUEST",
        "The bubblewrap backend cannot satisfy the requested sandbox capabilities.",
        { type: "requirement-negotiation", issues },
      );
    }
    if (request.sandboxId !== request.spec.name) throw this.#invalid("sandboxId", "sandboxId must match spec.name.");
    if (request.backend !== null && !sameBackend(request.backend, this.reference)) {
      throw this.#invalid("backend", "The requested backend reference does not match this bubblewrap backend instance.");
    }
    const validation = validateBootArtifact(request.spec.bootArtifact);
    if (!validation.ok || validation.artifact.kind !== "host" ||
      validation.artifact.locator.type !== "host" || validation.artifact.locator.selector !== "current") {
      throw this.#invalid("spec.bootArtifact", "BwrapBackend accepts only the validated current-host artifact.");
    }
    if (request.spec.frontendMetadata !== null) throw this.#invalid("spec.frontendMetadata", "The current-host artifact does not accept provider image metadata.");
    if (request.spec.source !== null) throw this.#invalid("spec.source", "BwrapBackend does not materialize Git or tarball sources.");
    if (request.spec.resources.vcpus !== null || request.spec.resources.memoryBytes !== null) {
      throw this.#invalid("spec.resources", "BwrapBackend does not enforce CPU or memory limits.");
    }
    if (request.spec.ports.length > 0) throw this.#invalid("spec.ports", "BwrapBackend does not expose or remap ports.");
    if (request.spec.region !== null || request.spec.failoverRegions.length > 0) {
      throw this.#invalid("spec.region", "BwrapBackend does not support regions or failover regions.");
    }
    if (!Number.isSafeInteger(request.spec.timeoutMs) || request.spec.timeoutMs < 1) {
      throw this.#invalid("spec.timeoutMs", "Sandbox timeout must be a positive integer in milliseconds.");
    }
    if (Object.hasOwn(request.spec.tags, INTERNAL_NETWORK_TAG)) {
      throw this.#invalid("spec.tags", "Sandbox tags contain a reserved bubblewrap metadata key.");
    }
    if (!isStringRecord(request.spec.environment) || !isStringRecord(request.spec.tags)) {
      throw this.#invalid("spec", "Sandbox environment and tags must contain only string values.");
    }
  }

  #networkPolicy(record: SandboxRecord): SandboxNetworkPolicy {
    const value = record.tags[INTERNAL_NETWORK_TAG];
    if (value === "allow-all" || value === "deny-all") return value;
    throw new BwrapOperationError("backend-failure", "LOCALBOX_BWRAP_DESCRIPTOR_INVALID", "The bubblewrap sandbox network policy is missing or invalid.", { type: "backend", operation: "readSandbox" });
  }

  #record(record: SandboxRecord): SandboxRecord {
    const { [INTERNAL_NETWORK_TAG]: _networkPolicy, ...tags } = record.tags;
    return { ...record, backend: this.reference, bootArtifact: HOST_ARTIFACT, tags };
  }

  #availability(diagnostics: readonly AvailabilityDiagnostic[]): ProbeAvailabilityResult["availability"] {
    return {
      schemaVersion: 1,
      backend: this.reference,
      status: diagnostics.some(({ severity }) => severity === "error") ? "unavailable" : "available",
      checkedAt: Date.now(),
      diagnostics,
    };
  }

  async #validateVirtualCwd(workspace: string, cwd: string): Promise<string> {
    if (cwd.includes("\0") || !posix.isAbsolute(cwd)) throw this.#invalid("command.cwd", "Command cwd must be an absolute virtual workspace path.");
    const normalized = posix.normalize(cwd);
    if (normalized !== VIRTUAL_WORKSPACE && !normalized.startsWith(`${VIRTUAL_WORKSPACE}/`)) {
      throw this.#invalid("command.cwd", "Command cwd must remain within /vercel/sandbox.");
    }
    const suffix = normalized === VIRTUAL_WORKSPACE ? "" : normalized.slice(VIRTUAL_WORKSPACE.length + 1);
    const hostPath = join(workspace, ...suffix.split("/").filter(Boolean));
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(hostPath);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
        throw this.#invalid("command.cwd", "Command cwd must name an existing directory inside the workspace.");
      }
      throw error;
    }
    const workspaceReal = await realpath(workspace);
    if (!inside(workspaceReal, resolvedPath) || !(await stat(resolvedPath)).isDirectory()) {
      throw this.#invalid("command.cwd", "Command cwd resolves outside the sandbox workspace.");
    }
    return normalized;
  }

  #scheduleDeadline(record: SandboxRecord): void {
    this.#clearDeadline(record.sandboxId);
    if (record.status !== "running" || record.expiresAt === null) return;
    const timer = setTimeout(() => void this.#expire(record.sandboxId), Math.max(0, record.expiresAt - Date.now()));
    timer.unref();
    this.#deadlineTimers.set(record.sandboxId, timer);
  }

  #clearDeadline(sandboxId: string): void {
    const timer = this.#deadlineTimers.get(sandboxId);
    if (timer !== undefined) clearTimeout(timer);
    this.#deadlineTimers.delete(sandboxId);
  }

  async #expire(sandboxId: string): Promise<void> {
    await this.#terminateSandbox(sandboxId);
    await this.#state.stopSandbox({
      requestId: `bwrap-expire-${sandboxId}`,
      idempotencyKey: `bwrap-expire-${sandboxId}`,
      deadline: null,
      sandboxId,
    }).catch(() => undefined);
  }

  async #terminateSandbox(sandboxId: string): Promise<void> {
    const commands = [...(this.#commands.get(sandboxId) ?? [])];
    await Promise.all(commands.map((command) => command.dispose().catch(() => undefined)));
    this.#commands.delete(sandboxId);
  }

  async #run<T extends JsonObject>(
    request: RequestMetadata,
    operation: string,
    work: () => Promise<T | ClientFailure>,
  ): Promise<ClientResult<T>> {
    try {
      this.#assertRequestDeadline(request, operation);
      const result = await work();
      if (isClientFailure(result)) return result;
      return { ok: true, value: result };
    } catch (error) {
      return this.#failure(request, operation, error);
    }
  }

  #translateFailure(request: RequestMetadata, result: ClientFailure): ClientFailure {
    return {
      ok: false,
      error: { ...result.error, requestId: request.requestId, backend: this.reference },
    };
  }

  #failure(request: RequestMetadata, operation: string, error: unknown): ClientFailure {
    let translated: BwrapOperationError;
    if (error instanceof BwrapOperationError) translated = error;
    else if (error instanceof DOMException && error.name === "AbortError") {
      translated = new BwrapOperationError("cancelled", "LOCALBOX_OPERATION_CANCELLED", `The ${operation} operation was cancelled.`, { type: "backend", operation });
    } else {
      translated = new BwrapOperationError("backend-failure", "LOCALBOX_BWRAP_BACKEND_FAILURE", `The bubblewrap backend could not complete ${operation}.`, { type: "backend", operation });
    }
    return {
      ok: false,
      error: {
        category: translated.category,
        code: translated.code,
        message: translated.message,
        retryable: translated.retryable,
        requestId: request.requestId,
        backend: this.reference,
        details: translated.details,
      },
    };
  }

  #invalid(field: string, reason: string): BwrapOperationError {
    return new BwrapOperationError("invalid-request", "LOCALBOX_INVALID_REQUEST", reason, { type: "invalid-request", field, reason });
  }

  #assertRequestDeadline(request: RequestMetadata, operation: string): void {
    if (request.deadline !== null && request.deadline.expiresAt <= Date.now()) {
      throw new BwrapOperationError("deadline-exceeded", "LOCALBOX_DEADLINE_EXCEEDED", `The ${operation} operation exceeded its deadline.`, { type: "backend", operation }, true);
    }
  }
}

async function resolveExecutable(binary: string): Promise<string> {
  const candidates = isAbsolute(binary)
    ? [binary]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, binary));
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const metadata = await stat(canonical);
      if (!metadata.isFile()) continue;
      await access(canonical, fsConstants.X_OK);
      return canonical;
    } catch {
      // Continue PATH lookup without exposing candidate paths in diagnostics.
    }
  }
  throw new Error("Bubblewrap executable not found.");
}

function runProcess(command: string, arguments_: readonly string[]): Promise<ProbeResult> {
  const deferred = Promise.withResolvers<ProbeResult>();
  const child = spawn(command, [...arguments_], {
    cwd: "/",
    env: minimalHostEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  const collect = (destination: Buffer[], chunk: Buffer): void => {
    if (outputBytes >= MAX_PROBE_OUTPUT_BYTES) return;
    const remaining = MAX_PROBE_OUTPUT_BYTES - outputBytes;
    destination.push(chunk.subarray(0, remaining));
    outputBytes += Math.min(chunk.length, remaining);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  child.once("error", deferred.reject);
  child.once("close", (code, signal) => {
    const signalNumber = signal === null ? 0 : 1;
    deferred.resolve({
      exitCode: code ?? 128 + signalNumber,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  });
  return deferred.promise;
}

function minimalHostEnvironment(): Readonly<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
}

async function readOptionalInteger(path: string): Promise<number | null> {
  try {
    const value = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

function sameBackend(left: BackendReference, right: BackendReference): boolean {
  return left.backendId === right.backendId && left.backendType === right.backendType;
}

function isClientFailure(value: JsonObject): value is ClientFailure {
  return value.ok === false && value.error !== null && typeof value.error === "object";
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

export { VIRTUAL_WORKSPACE as BWRAP_VIRTUAL_WORKSPACE };
