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

`EmbeddedSandboxClient.createSandbox` performs backend-reference matching and the complete negotiation before registering the idempotency mutation or invoking `backend.createSandbox`. A failed preflight therefore starts no backend create, raw command, filesystem transfer, or other allocation. Valid retries retain the existing idempotency behavior; rejected retries are recomputed from immutable input and produce the same ordered issues with the current request ID.

## Current operation surface

The asynchronous `SandboxClient` covers the behavior required by the current Vercel frontend: create/get/list/stop/delete and deadline extension; command start/wait/bounded output, long-poll following, and portable signal delivery; bounded file read/write, recursive directory creation, and the provider-neutral semantic filesystem operation union; and resolution of a declared port to its loopback HTTP endpoint. Observed sandbox records carry the concrete resolved image, the optional provider-neutral runtime selector that produced it, and the currently resolved endpoint snapshots. This lets compatibility frontends preserve synchronous metadata access without receiving backend handles. The Vercel adapter remains responsible for provider conveniences such as generated names, callbacks, `Date`, `Buffer`, `Stats`, `Dirent`, stream conversion, and `AbortSignal` adaptation.

## Embedded construction

`EmbeddedSandboxClient` is constructed with exactly one `SandboxBackend` instance and remains bound to it. A `null` backend in a create request uses that injected instance; a non-null reference must match its stable ID and type. Applications that need multiple backends construct multiple clients, so selection never depends on a default, registry, singleton, or mutable global state.

## Backend responsibility

A backend owns provider sandbox state and the raw execution mechanism, but not neutral command lifecycle or filesystem semantics. It exposes a data-only reference, one complete immutable capability record, lifecycle/endpoint operations, and one in-process raw-command primitive with optional bounded stdin. The embedded client compares requested backend identity and negotiates the typed requirements before calling `createSandbox`; any preflight issue produces one structured JSON-safe failure and no creation side effect. The filesystem bridge reads its semantic, input-transfer, and managed-ownership support from the same operational capability record before starting transfer or mutation. Raw command events are plain data discriminating stdout, stderr, completion, and backend failure.

## Command lifecycle and retention

`EmbeddedSandboxClient` assigns every command an opaque process ID and owns the per-sandbox process registry, ordered output chunks, cursors, followers, completion result, waiter fan-out, mutation idempotency, and signal-delivery state. Repeating a lifecycle, command, or filesystem mutation with the same idempotency key and payload returns the original outcome without repeating the side effect; reusing that key for a different mutation is rejected. Completion is settled once and remains stable for concurrent, repeated, and completion-after-deadline callers. Deleting a sandbox cancels outstanding command waiters, disposes raw backend handles, and removes every process owned by that sandbox.

Each start request supplies an output byte limit. The runtime retains the first bytes produced, in raw event order across stdout and stderr, until that limit is reached; later output is discarded and the `truncated` flag remains true. Cursors address the retained sequence and never move backward. A follow read at the current cursor waits for the next output event or terminal event, including output discarded after truncation, then returns one current page. This keeps storage bounded while preventing missed or duplicated retained chunks.

## Filesystem bridge ownership

The runtime owns one filesystem program and wire protocol. It validates paths and operation arguments, rejects NUL bytes, serializes operation arguments, stages binary input, decodes results and Node-style file errors, and implements every semantic operation used by both the direct runtime methods and the Vercel facade. Relative Vercel paths are resolved against `/vercel/sandbox` at the adapter boundary; absolute paths remain absolute. The adapter alone reconstructs `Buffer`, `Stats`, `Dirent`, and stream values.

Backends need only raw command execution plus advertised bounded-input support. Reads execute as bounded offset pages. Writes and appends send at most 1 MiB per stdin transfer to a sandbox-side staging file, then perform the target mutation after all chunks arrive; abort or transfer failure removes staging state without committing the target. Operation arguments are capped at 64 KiB and command results at 16 MiB. No file payload is placed in an argument vector.

Ownership changes use the explicit internal `managed-filesystem-owner` raw-command privilege. A backend must reject that privilege before process start unless the sandbox uses a trusted managed image; it then runs only the neutral filesystem program with the managed image's fixed Node executable as root. Public arbitrary `user: root` is never a substitute. Unsupported semantic, transfer, or privilege capabilities fail before filesystem mutation or data transfer begins.

## Docker backend ownership and security boundary

`DockerBackend` is the only Docker boundary. It owns Dockerode construction and values, managed-image resolution, labels, container creation and inspection, persistence and resource settings, network and published-port inspection, watchdog deadlines, source materialization, raw exec creation, bounded stdin attachment, stream demultiplexing, exit inspection, raw signal delivery, cleanup, and Docker failure translation. It does not contain filesystem operation scripts or semantic filesystem APIs. Docker exec IDs, streams, containers, and inspect values remain private. The backend does not allocate neutral process IDs or retain replay output, cursors, followers, waiters, or frontend callbacks.

Docker is a shared-kernel container backend for trusted or single-tenant local development, not a hostile multi-tenant security boundary. Its isolation is `partial` at `shared-kernel-container`; commands are native while detached lifecycle and filesystem semantics are emulated by the embedded runtime; managed ownership is partial and restricted to Localbox images. Runtime aliases, OCI images, Git, and tarball artifacts are accepted, but directory, disk-image, and snapshot artifacts are not. Persistent containers survive stop/resume and Localbox process restart while Docker data remains; sandbox records can be rediscovered, but processes, buffered output, waiters, and idempotency state cannot.

Networking is partial: bridge `allow-all` and network-none `deny-all` are available, published HTTP ports are loopback-only, and custom policies are unsupported. A deny-all sandbox with a Git or tarball source has network access during source materialization and is disconnected afterward. Resources are partial: Docker hard-enforces integer NanoCPU quotas and memory at exactly 2 GiB per vCPU, with no independent memory setting or host-capacity guarantee. Interactive PTYs and snapshot operations are explicitly unsupported. These classifications do not claim the future boot-artifact model.

The default Docker composition lives in `src/default-client.ts`. The Vercel compatibility frontend receives a generic `SandboxClient` factory and retains only the client plus neutral records and IDs. Its create requests require the operational command/filesystem surface, selected source and endpoint operations, accepted artifact kinds, requested persistence, selected network policy, and requested resource values. It accepts native, emulated, or partial implementations because those classifications preserve the released local v0.3 behavior; unsupported snapshot, mount, retention, and custom cloud/network options continue to fail before client allocation.

## Backend conformance profiles

Every operational capability key must map to at least one observable behavior profile in `test/conformance/backend-profile.ts`, and every domain has an explicit coverage mapping. Registration supplies a `BackendConformanceHarness`: the complete capability record, a client constructor, a complete valid `SandboxSpec`, unique sandbox-name generation, source fixtures when source operations are supported, and deterministic cleanup. The shared profiles exercise lifecycle and mutation idempotency, command ordering/wait/signal/error behavior, bounded binary and text filesystem pages, endpoint records, request and sandbox deadlines, persistence, sources, networking, resource records, and deletion cleanup.

A profile declares typed requirements and runs when every required capability is native, emulated, or partial in one of its explicitly accepted classes. It skips only an explicitly `unsupported` entry; a malformed advertisement, unknown key, missing key, unprofiled key, unacceptable supported class, or constraint mismatch fails instead of silently skipping. Each case owns uniquely named resources and invokes harness cleanup from a `finally` path, so profiles are parallel- and full-suite-safe.

To register a future backend, publish all schema v1 keys even when unsupported, choose support classifications before constraints, state the security boundary in each diagnostic, and use the narrowest honest bounds. Add or update an observable profile whenever adding an operational key, and reject an unknown requirement discriminant rather than guessing its meaning. Construct the backend behind its normal `SandboxClient` boundary, provide real source fixtures for supported source operations, and call `registerBackendConformanceProfiles`. Backend-specific mechanism tests may remain beside the registration, but reusable contract expectations belong in the profiles. Docker registers through `EmbeddedSandboxClient` in `test/integration/docker-conformance.test.ts`; the Docker integration CI job discovers that file.

## Error boundary

Valid contract failures returned by a backend retain their category, code, message, retryability, backend identity, and structured details. Thrown values, malformed results, request-ID mismatches, and non-JSON values become a stable `LOCALBOX_BACKEND_FAILURE` envelope for the current operation. Backend errors, stacks, handles, class instances, and other implementation values never cross the client boundary.

## Intentional non-goals

This layer does not provide a transport server, RPC protocol, durable runtime state beyond current Docker persistence, dynamic backend discovery, reconnection, a new public stream API, transport-level cancellation, or additional provider APIs. Process, bwrap, and Podman backends and a remote service or control plane remain deferred to later milestones. Backend selection remains explicit and instance-bound rather than global or mutable. This work does not change the development interception rules in [INTERCEPTION.md](./INTERCEPTION.md).
