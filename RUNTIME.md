# Runtime client contract

The pending v0.3.0 release candidate adds the public `localbox/runtime` entry point for backend-neutral values exchanged between a compatibility frontend and a Localbox runtime; this entry point is not part of the published v0.2.0 package. It is the shared contract for embedded and future remote clients and does not select a transport.

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

## Current operation surface

The asynchronous `SandboxClient` covers the behavior required by the current Vercel frontend: create/get/list/stop/delete and deadline extension; command start/wait/bounded output, long-poll following, and portable signal delivery; bounded file read/write, recursive directory creation, and the provider-neutral semantic filesystem operation union; and resolution of a declared port to its loopback HTTP endpoint. Observed sandbox records carry the concrete resolved image, the optional provider-neutral runtime selector that produced it, and the currently resolved endpoint snapshots. This lets compatibility frontends preserve synchronous metadata access without receiving backend handles. The Vercel adapter remains responsible for provider conveniences such as generated names, callbacks, `Date`, `Buffer`, `Stats`, `Dirent`, stream conversion, and `AbortSignal` adaptation.

## Embedded construction

`EmbeddedSandboxClient` is constructed with exactly one `SandboxBackend` instance and remains bound to it. A `null` backend in a create request uses that injected instance; a non-null reference must match its stable ID and type. Applications that need multiple backends construct multiple clients, so selection never depends on a default, registry, singleton, or mutable global state. The constructor accepts either an explicit absolute state root or a preconstructed `LocalSandboxStateStore`; the default composition supplies the platform-resolved state root.

## Local state and sandbox-name ownership

`resolveLocalStateRoot` uses `$XDG_STATE_HOME/localbox` only when `XDG_STATE_HOME` is an absolute path, as required by the XDG Base Directory specification. An unset, empty, or relative value is ignored and falls back to `<homedir>/.local/state/localbox`. An explicit constructor override must also be absolute. This injection point isolates tests and permits multiple runtime instances to share or intentionally separate ownership domains.

The schema-v1 layout is:

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

Canonical writes use a unique same-directory temporary file, a complete write, file `fsync`, close, atomic rename, and parent-directory `fsync` where the host supports directory synchronization. Temporary files are ignored during reads and removed under the operation lock. Readers accept only bounded regular files containing schema-v1 JSON with the complete expected shape; malformed, partial, version-mismatched, name/digest-mismatched, or non-JSON data is never coerced into metadata. Directory `fsync` is best-effort on hosts that reject it, so the strongest crash guarantee depends on filesystem and operating-system rename/flush semantics.

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

`DockerBackend` is the only Docker boundary. It owns Dockerode construction and values, managed-image resolution, labels, container creation and inspection, persistence and resource settings, network and published-port inspection, watchdog deadlines, source materialization, raw exec creation, bounded stdin attachment, stream demultiplexing, exit inspection, raw signal delivery, cleanup, and Docker failure translation. It does not contain filesystem operation scripts or semantic filesystem APIs. Docker exec IDs, streams, containers, and inspect values remain private. The backend does not allocate neutral process IDs or retain replay output, cursors, followers, waiters, or frontend callbacks.

Docker is a shared-kernel container backend for trusted or single-tenant local development, not a hostile multi-tenant security boundary. Its isolation is `partial` at `shared-kernel-container`; commands are native while detached lifecycle and filesystem semantics are emulated by the embedded runtime; managed ownership is partial and restricted to Localbox images. Runtime aliases, OCI images, Git, and tarball artifacts are accepted, but directory, disk-image, and snapshot artifacts are not. Persistent containers survive stop/resume and Localbox process restart while Docker data remains; sandbox records can be rediscovered, but processes, buffered output, waiters, and idempotency state cannot.

Networking is partial: bridge `allow-all` and network-none `deny-all` are available, published HTTP ports are loopback-only, and custom policies are unsupported. A deny-all sandbox with a Git or tarball source has network access during source materialization and is disconnected afterward. Resources are partial: Docker hard-enforces integer NanoCPU quotas and memory at exactly 2 GiB per vCPU, with no independent memory setting or host-capacity guarantee. Interactive PTYs and snapshot operations are explicitly unsupported. These classifications do not claim the future boot-artifact model.

The default Docker composition lives in `src/default-client.ts` and accepts an explicit absolute state-root override while otherwise following XDG resolution. The Vercel compatibility frontend receives a generic `SandboxClient` factory and retains only the client plus neutral records and IDs. Its create requests require the operational command/filesystem surface, selected source and endpoint operations, accepted artifact kinds, requested persistence, selected network policy, and requested resource values. It accepts native, emulated, or partial implementations because those classifications preserve the released local v0.3 behavior; unsupported snapshot, mount, retention, and custom cloud/network options continue to fail before client allocation.

## Trusted host process backend

`ProcessBackend` is an opt-in POSIX backend for explicitly trusted, single-user workloads. It is constructed with an absolute private backend root and an optional stable instance identity, then injected explicitly:

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

When `root` is omitted it resolves to `<localbox-XDG-state-root>/backends/process`. The normalized root and instance ID are hashed into both a stable backend reference and a digest-only instance directory, so independent identities can share one parent without mutable registries or path injection. `createDefaultSandboxClient()` and the Vercel interception composition remain Docker-backed; there is no environment switch or global process-backend selection.

The process backend accepts only `{ type: "runtime", runtime: "host" }` with no source, no ports, `allow-all` networking, no resource request, and no region. It never treats an OCI image name as permission to execute its contents on the host. Complete capability negotiation runs before a sandbox workspace is created.

| Capability | Classification | Process behavior |
| --- | --- | --- |
| Command start | `native` | Direct argv execution with `shell: false`, an explicit mapped cwd, and explicit environment composition |
| Detached command | `emulated` | In-process command/output identity plus a per-command supervisor; not restart-recoverable |
| Filesystem mkdir/read/write | `emulated` | Neutral bridge mapped into the private workspace with traversal and symlink escape checks |
| Raw stdin | `native` | One binary-safe payload bounded to 1 MiB |
| Isolation | `partial`, level `process`, tenancy `trusted` | Private directory and process bookkeeping only; **no security isolation boundary** |
| Artifacts | `partial` | The `host` runtime selector only; Git, tarball, OCI image, directory, disk image, and snapshot inputs are rejected |
| Persistence | `native` | Workspace and lifecycle descriptor survive stop/resume and backend reconstruction |
| Recovery | `partial`, scope `sandbox` | Metadata/workspace only; commands, output, waiters, and idempotency state are not recovered |
| Networking | `partial`, mode `allow-all` | The host network stack is shared directly; no namespace, deny policy, custom policy, endpoint record, or port remapping |
| Managed owner, resources, terminals, snapshots | `unsupported` | Rejected before process or workspace allocation |

Each instance stores schema-v1 descriptors below `<root>/instances/<identity-digest>/sandboxes/<sandbox-name-digest>/sandbox.json` and workspace content in the adjacent `workspace/` directory. Directories are mode `0700`, descriptors are mode `0600`, descriptor replacement is write-sync-rename-directory-sync, creation is staged then atomically renamed, and sandbox deletion addresses only digest-derived directories. Per-sandbox lock directories serialize lifecycle updates across reconstructed backend objects; unreadable or malformed descriptors fail closed. Persistent stop retains the workspace, resume starts a new deadline, and get/list reconcile expired descriptors. Ephemeral stop or expiry removes the private workspace. Environment values are deliberately not persisted, consistent with metadata-only recovery.

Every command is launched through a small Node supervisor using direct argv and `shell: false`. On POSIX the target becomes a distinct process-group leader. Signals address that group; stop, delete, deadline expiry, filesystem abort, and raw-command disposal send `TERM`, wait a bounded interval, then send `KILL`. Completion is emitted once after UTF-8 stream decoding and descendant cleanup. The supervisor records the Localbox parent PID and polls both parent identity and liveness, so abrupt parent exit triggers the same group cleanup before the supervisor exits. Process IDs and supervisor handles never enter descriptors or public records.

The backend currently requires POSIX process-group semantics and rejects construction on Windows. Linux is the CI-covered platform; macOS uses the same Node/POSIX primitives but remains a platform caveat until covered by CI. Host commands can read host files, use host credentials, inspect or signal other same-user processes, bind arbitrary ports, and consume unbounded resources. Therefore `ProcessBackend` **must not** run hostile code, untrusted dependencies, or multi-tenant workloads; use a container, namespace sandbox, or VM backend for those cases.

## Backend conformance profiles

Every operational capability key must map to at least one observable behavior profile in `test/conformance/backend-profile.ts`, and every domain has an explicit coverage mapping. Registration supplies a `BackendConformanceHarness`: the complete capability record, a client constructor, an optional peer client sharing the same state root, a complete valid `SandboxSpec`, unique sandbox-name generation, source fixtures when source operations are supported, and deterministic cleanup. The shared profiles exercise lifecycle and mutation idempotency, cross-runtime sandbox-name ownership, command ordering/wait/signal/error behavior, bounded binary and text filesystem pages, endpoint records, request and sandbox deadlines, persistence, sources, networking, resource records, and deletion cleanup.

A profile declares typed requirements and runs only when negotiation confirms the backend's advertised support class and constraints satisfy them. Precisely unsupported operations or domain constraints are capability-only skips; malformed advertisements, unknown or missing keys, and unprofiled capability keys fail the coverage profile. Each case owns uniquely named resources and invokes harness cleanup from a `finally` path, so profiles are parallel- and full-suite-safe.

To register a future backend, publish all schema v1 keys even when unsupported, choose support classifications before constraints, state the security boundary in each diagnostic, and use the narrowest honest bounds. Add or update an observable profile whenever adding an operational key, and reject an unknown requirement discriminant rather than guessing its meaning. Construct the backend behind its normal `SandboxClient` boundary, provide real source fixtures for supported source operations, and call `registerBackendConformanceProfiles`. Backend-specific mechanism tests may remain beside the registration, but reusable contract expectations belong in the profiles. Docker registers through `EmbeddedSandboxClient` in `test/integration/docker-conformance.test.ts`; Process registers without Docker in `test/process/process-conformance.test.ts`.

## Error boundary

Valid contract failures returned by a backend retain their category, code, message, retryability, backend identity, and structured details. Thrown values, malformed results, request-ID mismatches, and non-JSON values become a stable `LOCALBOX_BACKEND_FAILURE` envelope for the current operation. Backend errors, stacks, handles, class instances, and other implementation values never cross the client boundary.

## Intentional non-goals

This layer does not provide a transport server, RPC protocol, durable command output or idempotency state, distributed leases, remote/shared-filesystem coordination, dynamic backend discovery, reconnection, a new public stream API, transport-level cancellation, or additional provider APIs. Bubblewrap, Podman, the general boot-artifact/availability model, and a remote service or control plane remain deferred to later milestones. Backend selection remains explicit and instance-bound rather than global or mutable. This work does not change the development interception rules in [INTERCEPTION.md](./INTERCEPTION.md).
