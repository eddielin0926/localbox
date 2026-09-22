# Runtime client contract

The pending v0.4.0 release candidate extends the public `localbox/runtime` entry point with capability and requirement negotiation, explicit boot artifacts, allocation-free backend availability probes, XDG-backed sandbox metadata, and explicit Podman, process, and Bubblewrap backends. It remains the shared contract for embedded and future remote clients and does not select a transport.

## Boundary invariants

- Every request, result, backend reference, capability requirement, and operation failure is JSON-compatible. Optional data is represented by an absent property only where the type permits it; callers must not place `undefined` in boundary values.
- IDs are opaque strings. Lifecycle mutations include a caller-generated `requestId`, `idempotencyKey`, and explicit `sandboxId`; command and filesystem mutations follow the same rule. Reusing an idempotency key means retrying the same mutation, not starting a new one.
- Request deadlines are absolute Unix timestamps in milliseconds. They are not timers, `AbortSignal` values, or cancellation callbacks. A runtime that completes an operation returns a `ClientResult`; transport failures before a response remain transport concerns.
- Creation requirements describe the semantics a frontend needs. The runtime validates the complete capability document and requirement list, then returns every malformed, conflicting, or unmet requirement before creating the sandbox. Unsupported requirements use the stable `unsupported-requirement` category; malformed, unknown, duplicate, conflicting, or invalid-backend-advertisement cases use `invalid-request`.
- Backend references contain only stable diagnostic identity. They never contain Docker, process, socket, or other in-process handles.
- Binary file data uses base64 at the client boundary. Filesystem reads are cursor-addressed and capped at 1 MiB per page; filesystem command input is likewise capped at 1 MiB per raw transfer. Large writes are staged through multiple bounded stdin transfers and committed only after the complete payload arrives, so payload size is independent of operating-system argument limits. Command output is UTF-8 text retained by the runtime and read in bounded, cursor-addressed pages, preserving stdout/stderr chunk order without callbacks or streams.
- Errors are plain data with a stable category, machine-readable code, retryability, request identity, optional backend identity, and discriminated details. Frontends translate these envelopes into their provider-specific error classes and messages.

## Capability schema

`SandboxCapabilities` is a versioned, JSON-safe keyed record. `schemaVersion` is currently `1`. The `operations` record contains every known command, endpoint, filesystem, source, and raw-command feature; each key is mandatory, including unsupported features, so omission cannot be mistaken for support. The remaining mandatory entries are `isolation`, `artifacts`, `persistence`, `recovery`, `networking`, `resources`, `terminals`, and `snapshots`. Unknown keys and missing entries invalidate the advertisement.

Every operation and domain entry has exactly three fields:

- `support`: `native`, `emulated`, `partial`, or `unsupported`. Native means the backend mechanism directly provides the advertised behavior. Emulated means Localbox composes another primitive while preserving the observable contract. Partial means only the declared constraints are guaranteed. Unsupported never satisfies a create requirement.
- `constraints`: a domain-specific JSON record, or explicit `null` for an unconstrained operation. Isolation declares a strength and permitted tenancy; artifacts declare accepted kinds; persistence and recovery declare scopes; networking declares modes, endpoint visibility, and custom-policy support; resources declare CPU/memory bounds, granularity, coupling, and enforcement; terminals declare exec/PTY modes; snapshots declare create/restore/clone operations.
- `diagnostic`: actionable backend-specific text explaining the mechanism, boundary, and alternative when a requirement is unavailable.

Capability data contains no constructors, callbacks, `Error`, `Map`, `Set`, backend handles, or provider objects. The raw execution features used by the filesystem bridge (`raw-command.input` and `raw-command.managed-filesystem-owner`) live in the same operational record, including the transfer bound and managed-image restriction; there is no second raw-capability list.

## Requirements and negotiation

Create requirements are a discriminated union. Every requirement names its domain through `type`, carries a non-empty `acceptableSupport` list drawn from `native`, `emulated`, and `partial`, and uses typed domain fields rather than a free-form parameter bag. Operational requirements name one known operation. Domain requirements state isolation minimum and tenancy, artifact kinds, persistence/recovery scope, network mode/exposure/custom-policy need, CPU/memory/enforcement bounds, terminal mode, or snapshot operation.

`negotiateSandboxRequirements` is pure. It does not mutate capabilities, requirements, client state, or backend state. Its deterministic order is:

1. Validate the capability record in schema order, reporting unknown keys before missing keys and malformed entries.
2. Validate requirements in request order, explicitly rejecting unknown discriminants, unknown fields, malformed values, empty/invalid support lists, duplicate requirements, and conflicting requirements for the same operation or domain.
3. Compare the support classification before domain constraints. `unsupported` always fails; a supported classification must appear in `acceptableSupport`.
4. Compare domain constraints in the requirement's field order and return at most one ordered issue per requirement, with the backend diagnostic attached.

`EmbeddedSandboxClient.createSandbox` performs backend-reference matching and the complete negotiation before registering the idempotency mutation, claiming the sandbox name, or invoking `backend.createSandbox`. A failed preflight therefore starts no state mutation, backend create, raw command, filesystem transfer, or other allocation. Valid retries retain the existing in-process idempotency behavior; rejected retries are recomputed from immutable input and produce the same ordered issues with the current request ID.

## Boot artifacts

`SandboxSpec.bootArtifact` and `SandboxRecord.bootArtifact` contain exactly one validated, discriminated `BootArtifact`. Provider selectors never cross this boundary. The Vercel frontend resolves its `runtime` and `image` options to a concrete OCI artifact before calling `SandboxClient`; invalid or unsupported provider selectors produce an explicit conversion failure and never select another backend.

| Kind | Locator and identity | Additional fields | Current execution support |
| --- | --- | --- | --- |
| `host` | `{ type: "host", selector: "current" }` | `trust: "trusted"`, `mutability: "mutable"` | Process only |
| `directory` | `{ type: "absolute-path", path }` | explicit trust and mutable/read-only declaration | Modeled; unsupported |
| `oci-image` | `{ type: "oci-reference", reference }` | nullable sha256/sha512 digest, explicit trust and mutability, nullable Linux/Windows amd64/arm64 platform hint | Docker and Podman |
| `disk-image` | `{ type: "absolute-path", path }` | nullable digest, raw/qcow2 format, nullable architecture, explicit trust and mutable/read-only declaration | Modeled; unsupported |
| `snapshot` | `{ type: "snapshot-id", snapshotId, scope, backend }` | backend-scoped locators require backend identity; portable locators prohibit one; nullable digest and explicit trust/mutability | Modeled; unsupported |

Validation rejects relative paths, empty or NUL-bearing identities, whitespace-bearing OCI references, malformed or uppercase digests, unknown fields or kinds, and immutable OCI/snapshot claims without a digest. These declarations prevent callers and backends from inferring portability, integrity, or immutability from a path, tag, or snapshot ID. They are metadata, not an isolation upgrade: Localbox does not verify an arbitrary caller's trust declaration, a mutable tag can change, and a digest states expected content identity rather than proving registry or publisher trust.

`EmbeddedSandboxClient` validates the artifact and derives a mandatory artifact requirement before name claims or backend calls. If the caller omitted that requirement, the client adds it; if the caller supplied one, it must include the actual kind and cannot be weakened by a duplicate. Docker and Podman accept OCI artifacts, including arbitrary explicit image references, under their documented trusted/single-tenant container boundaries. Process accepts only the exact current-host artifact. Directory, disk-image, and snapshot inputs remain representation-only until a future backend advertises and implements them.

`frontendMetadata` is a narrow provider-owned display record. The current Vercel variant retains the resolved `image` and original nullable `runtime` so the released synchronous getters survive without reintroducing provider selectors as execution input. Backends execute only `bootArtifact`.

## Backend availability

`SandboxClient.probeAvailability` is a read-only, deadline-aware operation. A successful probe returns schema version `1`, the exact backend identity, `available` or `unavailable`, a millisecond timestamp, and an ordered non-empty diagnostic list. Every diagnostic has a stable code, `info`/`warning`/`error` severity, safe message, actionable remediation, and one typed details object. The embedded client rejects wrong identities, unknown codes, malformed/non-JSON values, inconsistent status/severity, thrown provider values, and late responses; failures use the normal stable envelope. Probe diagnostics deliberately omit environment values, registry credentials, container-engine endpoint values, and provider causes.

Probing never creates a sandbox, directory, container, image pull, or prerequisite installation. Docker calls only the daemon version API and distinguishes a missing endpoint, endpoint permission denial, and an otherwise unreachable daemon with context/socket remediation. Podman calls only the Docker-compatible version and information APIs, verifies the endpoint identifies Podman, detects its actual rootless/rootful mode, and fails availability if that mode differs from the backend's immutable capability contract. Process checks POSIX support, the configured absolute non-symlink root or nearest existing parent, read/write/execute access, the current Node executable, and the bundled supervisor program. It does not create the configured root during the probe.

## Current operation surface

The asynchronous `SandboxClient` covers availability plus the behavior required by the current Vercel frontend: create/get/list/stop/delete and deadline extension; command start/wait/bounded output, long-poll following, and portable signal delivery; bounded file read/write, recursive directory creation, the provider-neutral semantic filesystem operation union; and resolution of a declared port to its loopback HTTP endpoint. Observed sandbox records carry the concrete boot artifact, narrow frontend-owned display metadata, and currently resolved endpoint snapshots. Compatibility frontends therefore preserve synchronous metadata access without receiving backend handles or provider selectors as execution input.

## Embedded construction

`EmbeddedSandboxClient` is constructed with exactly one `SandboxBackend` instance and remains bound to it. A `null` backend in a create request uses that injected instance; a non-null reference must match its stable ID and type. Applications that need multiple backends construct multiple clients, so selection never depends on a default, registry, singleton, or mutable global state. The constructor accepts either an explicit absolute state root or a preconstructed `LocalSandboxStateStore`; the default composition supplies the platform-resolved state root.

## Local state and sandbox-name ownership

`resolveLocalStateRoot` uses `$XDG_STATE_HOME/localbox` only when `XDG_STATE_HOME` is an absolute path, as required by the XDG Base Directory specification. An unset, empty, or relative value is ignored and falls back to `<homedir>/.local/state/localbox`. An explicit constructor override must also be absolute. This injection point isolates tests and permits multiple runtime instances to share or intentionally separate ownership domains.

The schema-v2 layout is:

```text
<state-root>/                         0700
  sandboxes/                          0700
    <sha256(UTF-8 sandbox name)>/     0700, atomic ownership claim
      state.json                      0600, canonical claim or active record
      .state.<random>.tmp             0600, incomplete write; never read as state
      .operation/                     0700, short-lived serialized mutation lock
        owner.json                    0600, lock owner metadata for crash recovery
```

The digest is the complete lowercase SHA-256 value, so arbitrary sandbox names never become path components. The canonical record retains the original name, configured backend reference, an unguessable ownership token, creator PID/process nonce/start timestamp, and claim/update timestamps. A committed active record additionally embeds the complete backend-neutral `SandboxRecord` and activation timestamp. It never stores backend handles, command buffers, process output, environment variables, source credentials, or provider objects.

Name ownership is global within one state root and independent of backend object or process. Acquisition uses an atomic directory creation; there is no check-then-write path. Capability/backend preflight runs first, then creation acquires the claim before backend allocation. Backend success commits the observed record. Backend failure releases only the caller's token; an already-existing backend resource is first observed and recorded for pre-v0.4 Docker compatibility. Get, list, stop, resume, and deadline extension refresh the active record. Successful deletion verifies the token and releases ownership. Every commit, update, and release re-reads and compares the token while holding the entry's filesystem operation lock, so a delayed operation cannot remove or overwrite a successor claim.

Canonical writes use a unique same-directory temporary file, a complete write, file `fsync`, close, atomic rename, and parent-directory `fsync` where the host supports directory synchronization. Temporary files are ignored during reads and removed under the operation lock. Readers accept only bounded regular files containing complete expected JSON; malformed, partial, version/name/digest mismatched, or non-JSON data is never coerced. Schema-v1 claims are upgraded in memory. A schema-v1 active record converts only the exact legacy current-host selector or a concrete image string; all other runtime selectors fail closed rather than being guessed. Converted image provenance is `untrusted`, and state is written as schema v2 on the next commit/update. Directory `fsync` is best-effort on hosts that reject it, so the strongest crash guarantee depends on filesystem and operating-system rename/flush semantics.

Conflict and cleanup reconciliation is conservative:

| State entry | Backend probe | Decision |
| --- | --- | --- |
| Active record or dead creator claim | Live resource | Preserve ownership, refresh/commit the record, reject the competing create |
| Missing metadata (including a pre-v0.4 Docker resource) | Live resource | Adopt the observed neutral record; get/list remain discoverable and a colliding create is rejected |
| Dead creator or stale active record | Confirmed `not-found` | Token-verified release, then retry acquisition |
| Empty/interrupted or corrupt entry | Live resource | Repair with a new token and the observed record, then reject the competing create |
| Old empty/interrupted or corrupt entry | Confirmed `not-found` | Atomically quarantine/remove the invalid entry, then retry acquisition |
| Any entry | Backend unavailable, timeout, malformed result, or unknown failure | Preserve ownership and fail closed |
| Claim whose PID still exists, including possible PID reuse | Confirmed `not-found` | Preserve the claim; liveness ambiguity is never treated as proof of death |

An empty claim directory receives a short grace period because it can be observed between atomic directory creation and the durable claim write. Explicit cleanup and later conflicting creates can reclaim it only after the backend confirms absence. The store is local coordination, not a distributed lease: copying or sharing the state directory across hosts is unsupported. State names, tags, backend identity, PIDs, and endpoint metadata may be sensitive; the private modes limit access to the owning account, but operators should protect and avoid publishing the state root.

## Backend responsibility

A backend owns provider sandbox state and the raw execution mechanism, but not neutral command lifecycle or filesystem semantics. It exposes a data-only reference, one complete immutable capability record, lifecycle/endpoint operations, and one in-process raw-command primitive with optional bounded stdin. The embedded client compares requested backend identity and negotiates the typed requirements before calling `createSandbox`; any preflight issue produces one structured JSON-safe failure and no creation side effect. The filesystem bridge reads its semantic, input-transfer, and managed-ownership support from the same operational capability record before starting transfer or mutation. Raw command events are plain data discriminating stdout, stderr, completion, and backend failure.

## Command lifecycle and retention

`EmbeddedSandboxClient` assigns every command an opaque process ID and owns the per-sandbox process registry, ordered output chunks, cursors, followers, completion result, waiter fan-out, mutation idempotency, and signal-delivery state. Repeating a lifecycle, command, or filesystem mutation with the same idempotency key and payload returns the original outcome without repeating the side effect; reusing that key for a different mutation is rejected. Completion is settled once and remains stable for concurrent, repeated, and completion-after-deadline callers. Deleting a sandbox cancels outstanding command waiters, disposes raw backend handles, and removes every process owned by that sandbox.

Each start request supplies an output byte limit. The runtime retains the first bytes produced, in raw event order across stdout and stderr, until that limit is reached; later output is discarded and the `truncated` flag remains true. Cursors address the retained sequence and never move backward. A follow read at the current cursor waits for the next output event or terminal event, including output discarded after truncation, then returns one current page. This keeps storage bounded while preventing missed or duplicated retained chunks.

## Filesystem bridge ownership

The runtime owns one filesystem program and wire protocol. It validates paths and operation arguments, rejects NUL bytes, serializes operation arguments, stages binary input, decodes results and Node-style file errors, and implements every semantic operation used by both the direct runtime methods and the Vercel facade. Relative Vercel paths are resolved against `/vercel/sandbox` at the adapter boundary; absolute paths remain absolute. The adapter alone reconstructs `Buffer`, `Stats`, `Dirent`, and stream values.

Backends need only raw command execution plus advertised bounded-input support. Reads execute as bounded offset pages. Writes and appends send at most 1 MiB per stdin transfer to a sandbox-side staging file, then perform the target mutation after all chunks arrive; abort or transfer failure removes staging state without committing the target. Operation arguments are capped at 64 KiB and command results at 16 MiB. No file payload is placed in an argument vector.

Ownership changes use the explicit internal `managed-filesystem-owner` raw-command privilege. A backend must reject that privilege before process start unless the sandbox uses a trusted managed image; it then runs only the neutral filesystem program with the managed image's fixed Node executable as root. Public arbitrary `user: root` is never a substitute. Unsupported semantic, transfer, or privilege capabilities fail before filesystem mutation or data transfer begins.

Host-style backends may implement the internal `filesystemWorkspace(sandboxId)` mapping. The bridge then translates the public `/vercel/sandbox` root to that private absolute workspace for the duration of its fixed filesystem command only. It validates every lexical path and real ancestor, rejects traversal and symlink resolution outside the workspace, keeps staged transfers inside the workspace, and maps results and file errors back to virtual paths. Container backends omit the mapping and retain their existing container-global `/vercel/sandbox` behavior.

## Docker backend ownership and security boundary

`DockerBackend` is the Docker-specific driver over the shared container-engine execution layer. The driver owns Dockerode construction, stable Docker identity, Docker capability text, availability diagnostics, and Docker failure codes. The shared layer owns validated OCI artifacts and labels, container creation and inspection, persistence and resource settings, network and published-port inspection, watchdog deadlines, source materialization, raw exec creation, bounded stdin attachment, stream demultiplexing, exit inspection, raw signal delivery, and cleanup. Vercel runtime/image alias conversion belongs to the frontend. Container-engine code does not contain filesystem operation scripts or semantic filesystem APIs. Engine exec IDs, streams, containers, and inspect values remain private. The backend does not allocate neutral process IDs or retain replay output, cursors, followers, waits, signal idempotency, or semantic filesystem state.

Docker is a shared-kernel container backend for trusted or single-tenant local development, not a hostile multi-tenant security boundary. Its isolation is `partial` at `shared-kernel-container`; commands are native while detached lifecycle and filesystem semantics are emulated by the embedded runtime; managed ownership is partial and restricted to Localbox images. Docker accepts only OCI boot artifacts. Arbitrary explicit OCI references remain runnable for compatibility, but an artifact `trust` value is provenance metadata and never strengthens Docker isolation or authorizes managed-root behavior. Git and tarball remain post-boot workspace sources, not boot-artifact kinds. Host, directory, disk-image, and snapshot artifacts are rejected before Docker allocation.

Networking is partial: bridge `allow-all` and network-none `deny-all` are available, published HTTP ports are loopback-only, and custom policies are unsupported. A deny-all sandbox with a Git or tarball source has network access during source materialization and is disconnected afterward. Resources are partial: Docker hard-enforces integer NanoCPU quotas and memory at exactly 2 GiB per vCPU, with no independent memory setting or host-capacity guarantee. Interactive PTYs and snapshot operations are explicitly unsupported. Docker does not provide path containment for host directories, VM isolation, portable snapshot guarantees, remote upload/storage, or registry provenance verification.

The default Docker composition lives in `src/default-client.ts` and accepts an explicit absolute state-root override while otherwise following XDG resolution. The Vercel compatibility frontend receives a generic `SandboxClient` factory and retains only the client plus neutral records and IDs. Its create requests require the operational command/filesystem surface, selected source and endpoint operations, accepted artifact kinds, requested persistence, selected network policy, and requested resource values. It accepts native, emulated, or partial implementations because those classifications preserve the released local v0.3 behavior; unsupported snapshot, mount, retention, and custom cloud/network options continue to fail before client allocation.

## Podman container-engine backend

`PodmanBackend` uses the shared container-engine lifecycle, OCI image, exec-stream, source, port, persistence, watchdog, label recovery, and cleanup implementation where Podman's Docker-compatible API has matching semantics. Construction remains explicit and instance-bound:

```ts
import { EmbeddedSandboxClient, PodmanBackend } from "localbox/runtime";

const backend = new PodmanBackend({
  mode: "rootless",
  // Optional for the standard per-user socket.
  socketPath: "/run/user/1000/podman/podman.sock",
});
const client = new EmbeddedSandboxClient(backend, {
  stateRoot: "/absolute/private/localbox-runtime-state",
});
```

`mode` defaults to `rootless` and selects both a stable backend identity and one immutable capability document. The default rootless endpoint is `$XDG_RUNTIME_DIR/podman/podman.sock`, falling back to `/run/user/<uid>/podman/podman.sock`; rootful defaults to `/run/podman/podman.sock`. A custom endpoint must be an absolute Unix socket path. There is no Docker-context or Podman-connection-shell fallback and no automatic switch between modes.

| Capability | Rootless Podman | Rootful Podman |
| --- | --- | --- |
| OCI lifecycle, exec, files, sources, ports, persistence, cleanup | Supported through the shared engine path | Supported through the shared engine path |
| Isolation/service authority | Container root maps into the invoking user's namespace; shared host kernel | Service has host-root authority; shared host kernel |
| CPU and memory request | Unsupported and rejected before allocation because cgroup delegation varies by host/session | Partial hard enforcement: integer vCPU quota and fixed 2 GiB memory per vCPU |
| `allow-all` / `deny-all` | Connected engine network or network-none; source-backed creation disconnects every attached network after materialization | Same |
| Recovery | Sandbox containers and writable layers only; in-flight process state is not recoverable | Same |

Rootless is a reduction in service privilege, not a stronger advertised tenancy class: commands still share the host kernel and operate with the invoking account's effective storage/network authority through Podman. Rootful mode makes anyone with access to its API socket effectively host-root. Neither mode is safe for hostile multi-tenant workloads. Localbox sets `no-new-privileges`, publishes requested ports only on `127.0.0.1`, does not mount the API socket into containers, and exposes no privileged-container option. Operators must protect the socket, engine storage, registry credentials, and Localbox state root.

Podman-specific preflight verifies both the engine identity and configured mode before the first allocation. Rootless resource requests fail explicitly rather than being accepted as portable container-engine guarantees. Interactive terminals, snapshots, drive mounts, custom network policies, non-loopback endpoints, registry trust verification, cgroup portability across hosts, and remote Podman services are unsupported. Git/tarball materialization for a `deny-all` sandbox necessarily has network access until source setup completes; Localbox then enumerates and disconnects every attached engine network instead of assuming Docker's `bridge` network name.

## Trusted host process backend

`ProcessBackend` is an opt-in POSIX backend for explicitly trusted, single-user workloads. It requires an absolute private backend root and stable instance identity, then is injected explicitly:

```ts
import { EmbeddedSandboxClient, ProcessBackend } from "localbox/runtime";

const backend = new ProcessBackend({
  root: "/absolute/private/localbox-process-state",
  instanceId: "developer-host",
});
const client = new EmbeddedSandboxClient(backend, {
  stateRoot: "/absolute/private/localbox-runtime-state",
});
```

The caller injects both roots explicitly; applications that follow XDG should resolve them before construction. The normalized backend root and instance ID are hashed into both a stable backend reference and a digest-only instance directory, so independent identities can share one parent without mutable registries or path injection. `createDefaultSandboxClient()` and the Vercel interception composition remain Docker-backed; there is no environment switch or global process-backend selection.

The process backend accepts only `{ kind: "host", locator: { type: "host", selector: "current" }, trust: "trusted", mutability: "mutable" }` with no source, no ports, `allow-all` networking, no resource request, and no region. It never treats an OCI image, directory, disk image, or snapshot locator as permission to execute its contents on the host. Complete artifact and capability preflight runs before a sandbox workspace is created.

| Capability | Classification | Process behavior |
| --- | --- | --- |
| Command start | `native` | Direct argv execution with `shell: false`, an explicit mapped cwd, and explicit environment composition |
| Detached command | `emulated` | In-process command/output identity plus a per-command supervisor; not restart-recoverable |
| Filesystem mkdir/read/write | `emulated` | Neutral bridge mapped into the private workspace with traversal and symlink escape checks |
| Raw stdin | `native` | One binary-safe payload bounded to 1 MiB |
| Isolation | `partial`, level `process`, tenancy `trusted` | Private directory and process bookkeeping only; **no security isolation boundary** |
| Artifacts | `partial` | The exact current-host artifact only; Git, tarball, OCI image, directory, disk image, and snapshot inputs are rejected |
| Persistence | `native` | Workspace and lifecycle descriptor survive stop/resume and backend reconstruction |
| Recovery | `partial`, scope `sandbox` | Metadata/workspace only; commands, output, waiters, and idempotency state are not recovered |
| Networking | `partial`, mode `allow-all` | The host network stack is shared directly; no namespace, deny policy, custom policy, endpoint record, or port remapping |
| Managed owner, resources, terminals, snapshots | `unsupported` | Rejected before process or workspace allocation |

Each instance stores schema-v1 descriptors below `<root>/instances/<identity-digest>/sandboxes/<sandbox-name-digest>/sandbox.json` and workspace content in the adjacent `workspace/` directory. Directories are mode `0700`, descriptors are mode `0600`, descriptor replacement is write-sync-rename-directory-sync, creation is staged then atomically renamed, and sandbox deletion addresses only digest-derived directories. Per-sandbox lock directories serialize lifecycle updates across reconstructed backend objects; unreadable or malformed descriptors fail closed. Persistent stop retains the workspace, resume starts a new deadline, and get/list reconcile expired descriptors. Ephemeral stop or expiry removes the private workspace. Environment values are deliberately not persisted, consistent with metadata-only recovery.

Every command is launched through a small Node supervisor using direct argv and `shell: false`. On POSIX the target becomes a distinct process-group leader. Signals address that group; stop, delete, deadline expiry, filesystem abort, and raw-command disposal send `TERM`, wait a bounded interval, then send `KILL`. Completion is emitted once after UTF-8 stream decoding and descendant cleanup. The supervisor records the Localbox parent PID and polls both parent identity and liveness, so abrupt parent exit triggers the same group cleanup before the supervisor exits. Process IDs and supervisor handles never enter descriptors or public records.

The backend requires POSIX process-group semantics. Its constructor retains configuration so `probeAvailability` can report unsupported platforms or invalid roots without mutation; lifecycle operations still fail closed when those prerequisites are absent. Linux is the CI-covered platform; macOS uses the same Node/POSIX primitives but remains a platform caveat until covered by CI. Host commands can read host files, use host credentials, inspect or signal other same-user processes, bind arbitrary ports, and consume unbounded resources. Therefore `ProcessBackend` **must not** run hostile code, untrusted dependencies, or multi-tenant workloads; a caller's artifact trust declaration is not sandboxing. Use a container, namespace sandbox, or VM backend for those cases.

## Linux Bubblewrap namespace backend

`BwrapBackend` is an opt-in Linux backend for trusted or single-tenant local development that needs a stronger boundary than `ProcessBackend` without adopting a Docker image:

```ts
import { BwrapBackend, EmbeddedSandboxClient } from "localbox/runtime";

const backend = new BwrapBackend({
  root: "/absolute/private/localbox-bwrap-state",
  instanceId: "developer-host",
  // binaryPath: "/usr/bin/bwrap", // optional; otherwise resolved from PATH
});
const client = new EmbeddedSandboxClient(backend, {
  stateRoot: "/absolute/private/localbox-runtime-state",
});
```

The absolute normalized root and stable instance ID produce a digest-only backend reference and private instance directory. Multiple Bubblewrap, Process, and Docker instances can coexist; the default client and Vercel interception remain Docker-backed. `BwrapBackend` accepts only the exact trusted, mutable current-host artifact. It rejects directory, OCI, disk-image, and snapshot artifacts, sources, ports/endpoints, regions, hard resources, terminals, snapshots, managed ownership, and alternate users before workspace allocation.

| Capability | Classification | Bubblewrap behavior |
| --- | --- | --- |
| Command start | `native` | Direct argv, explicit cwd/environment, and no shell inside a fresh namespace set |
| Detached command | `emulated` | Embedded command identity plus the shared local process-group supervisor; not restart-recoverable |
| Filesystem mkdir/read/write | `native` | The neutral bridge runs inside the namespace and sees the writable workspace at `/vercel/sandbox` |
| Raw stdin | `native` | One binary-safe payload bounded to 1 MiB |
| Isolation | `native`, level `namespace-sandbox`, tenancy `trusted` or `single-tenant` | New user, mount, PID, IPC, and UTS namespaces; opportunistic cgroup namespace; shared host kernel |
| Artifacts | `partial` | The exact current-host artifact only |
| Persistence | `native` | Private workspace and lifecycle descriptor survive stop/resume and backend reconstruction |
| Recovery | `partial`, scope `sandbox` | Metadata/workspace only; commands, output, waiters, environment overlays, and idempotency state are not recovered |
| Networking | `native`, modes `allow-all` and `deny-all` | `allow-all` explicitly retains host networking; `deny-all` requires a successfully probed fresh network namespace |
| Endpoints, sources, managed owner, resources, terminals, snapshots | `unsupported` | Rejected before allocation or command start |

Bubblewrap begins with an empty tmpfs root. Localbox read-only binds the canonical `/usr` runtime plus validated non-merged system runtime directories or merged-`/usr` symlinks. If the running Node executable is outside those trees (for example a CI toolcache), only its resolved version root is read-only bound at the same path; Localbox does not mount its home/toolcache parent or arbitrary `PATH` entries. A small allowlist of resolved certificate, resolver, and host-name files is read-only bound below a freshly created `/etc`. `/proc` is new, `/dev` is minimal, and `/run`, `/home`, and `/root` are private tmpfs mounts. `/tmp` is a private backend-owned directory beside the sandbox workspace so multi-command filesystem transfers remain isolated and atomic. The only writable host binds are that private temporary directory and `/vercel/sandbox`; neither exposes the descriptor, caller home, repository, state-root paths, or sibling workspaces. Other bind sources must be canonical regular files/directories outside private state, merged-system symlinks must resolve below `/usr`, and validation failure aborts before spawn.

Commands use `--die-with-parent` and `--new-session` in addition to the existing supervisor. The supervisor retains ordered UTF-8 events, direct bounded stdin, TERM/KILL escalation, abort/dispose races, and abrupt Localbox-parent cleanup. It signals the bubblewrap owner process; Bubblewrap supplies a namespace PID 1 and kernel namespace teardown kills every descendant when that owner exits. Stop, delete, deadline expiry, or filesystem cancellation disposes every tracked command before lifecycle cleanup. Persistent stop retains only descriptor/workspace data; deletion removes only the backend-owned digest directory without following a user-controlled path.

Availability probing does not allocate a sandbox. It checks Linux, the private-root prerequisite, executable resolution and `bwrap --version`, readable `max_user_namespaces`, `unprivileged_userns_clone`, and AppArmor restriction policy, then runs real `/usr/bin/true` probes using the same mount and namespace strategy for both `--share-net` and `--unshare-net`. Stable diagnostics distinguish missing binaries, disabled user namespaces, AppArmor restriction, permission/EPERM failures, incompatible arguments/version, root problems, and unknown probe failures. Messages do not include configured roots, PATH entries, environment values, or raw stderr. The supported CI baseline installs Ubuntu 24.04's distribution `bubblewrap` package in a privileged, AppArmor-unconfined job container because the hosted runner blocks nested unprivileged namespace creation. CI marks only that distro binary setuid as a controlled fixture, then launches the complete Localbox process and every bubblewrap invocation as uid/gid 1000 with cleared supplementary groups. The backend detects that supported bubblewrap mode, preserves the invoking identity inside the namespace, and still runs the real availability, mount, network, lifecycle, and escape probes without skips or mocks.

The mount graph intentionally provides Linux namespace/filesystem isolation, not a complete hostile-code sandbox: Bubblewrap itself documents that its security boundary is determined by the caller's arguments, everything mounted is part of the attack surface, and the host kernel remains shared. Localbox does not compile a seccomp policy or enforce cgroup resources. The threat-model comparison is:

- `ProcessBackend`: trusted host process bookkeeping, **no isolation boundary**.
- `BwrapBackend`: Linux user/PID/IPC/UTS/mount and optional network namespace isolation with a narrow filesystem, sharing the host kernel.
- `DockerBackend`: a root-authority container boundary with image/rootfs, cgroup, network, and port mechanisms, sharing the host kernel.
- `PodmanBackend`: the same shared-kernel container mechanisms; rootless mode maps service/container root into the invoking user's namespaces, while rootful mode has host-root service authority.
- None of these is a microVM or a suitable hostile multi-tenant isolation boundary. Use a hardened VM/microVM runtime for adversarial multi-tenancy.

The argument contract follows the upstream Bubblewrap README and the Debian bookworm `bwrap(1)` manual for bubblewrap 0.8.0, including ordered filesystem operations, unprivileged user namespaces, explicit network sharing, PID reaping, `--new-session`, and `--die-with-parent`. Other distribution versions are accepted only when `--version` and the actual namespace probes pass.

## Backend conformance profiles

Every operational capability key must map to at least one observable behavior profile in `test/conformance/backend-profile.ts`, and every domain has an explicit coverage mapping. Registration supplies a `BackendConformanceHarness`: the complete capability record, a client constructor, an optional peer client sharing the same state root, a complete valid `SandboxSpec`, unique sandbox-name generation, source fixtures when source operations are supported, and deterministic cleanup. The shared profiles exercise lifecycle and mutation idempotency, cross-runtime sandbox-name ownership, command ordering/wait/signal/error behavior, bounded binary and text filesystem pages, endpoint records, request and sandbox deadlines, persistence, sources, networking, resource records, and deletion cleanup.

A profile declares typed requirements and runs only when negotiation confirms the backend's advertised support class and constraints satisfy them. Precisely unsupported operations or domain constraints are capability-only skips; malformed advertisements, unknown or missing keys, and unprofiled capability keys fail the coverage profile. Each case owns uniquely named resources and invokes harness cleanup from a `finally` path, so profiles are parallel- and full-suite-safe.

To register a future backend, publish all schema v1 keys even when unsupported, choose support classifications before constraints, state the security boundary in each diagnostic, and use the narrowest honest bounds. Add or update an observable profile whenever adding an operational key, and reject an unknown requirement discriminant rather than guessing its meaning. Construct the backend behind its normal `SandboxClient` boundary, provide real source fixtures for supported source operations, and call `registerBackendConformanceProfiles`. Backend-specific mechanism tests may remain beside the registration, but reusable contract expectations belong in the profiles. Docker and configured Podman services register through `EmbeddedSandboxClient` in `test/integration/docker-conformance.test.ts` and `test/integration/podman-conformance.test.ts`; process and Bubblewrap use the same profile from their backend-specific suites.

## Error boundary

Valid contract failures returned by a backend retain their category, code, message, retryability, backend identity, and structured details. Thrown values, malformed results, request-ID mismatches, and non-JSON values become a stable `LOCALBOX_BACKEND_FAILURE` envelope for the current operation. Backend errors, stacks, handles, class instances, and other implementation values never cross the client boundary.

## Intentional non-goals

This layer does not provide a transport server, RPC protocol, durable command output or idempotency state, distributed leases, remote artifact upload/storage, remote/shared-filesystem coordination, dynamic backend discovery, reconnection, a new public stream API, transport-level cancellation, automatic prerequisite installation, or additional provider APIs. Directory/disk/snapshot execution, remote Podman services, seccomp policy compilation, portable cgroup enforcement, terminals, microVMs, and a remote service or control plane remain deferred. Backend selection remains explicit and instance-bound rather than global or mutable. This work does not change the development interception rules in [INTERCEPTION.md](./INTERCEPTION.md).
