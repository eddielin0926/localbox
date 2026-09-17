# Runtime client contract

The pending v0.3.0 release candidate adds the public `localbox/runtime` entry point for backend-neutral values exchanged between a compatibility frontend and a Localbox runtime; this entry point is not part of the published v0.2.0 package. It is the shared contract for embedded and future remote clients and does not select a transport.

## Boundary invariants

- Every request, result, backend reference, capability requirement, and operation failure is JSON-compatible. Optional data is represented by an absent property only where the type permits it; callers must not place `undefined` in boundary values.
- IDs are opaque strings. Lifecycle mutations include a caller-generated `requestId`, `idempotencyKey`, and explicit `sandboxId`; command and filesystem mutations follow the same rule. Reusing an idempotency key means retrying the same mutation, not starting a new one.
- Request deadlines are absolute Unix timestamps in milliseconds. They are not timers, `AbortSignal` values, or cancellation callbacks. A runtime that completes an operation returns a `ClientResult`; transport failures before a response remain transport concerns.
- Creation requirements describe the semantics a frontend needs. The runtime must return an `unsupported-requirement` failure listing every known unmet requirement before creating the sandbox. This contract does not define a capability registry or negotiation engine.
- Backend references contain only stable diagnostic identity. They never contain Docker, process, socket, or other in-process handles.
- Binary file data uses base64 at the client boundary. Filesystem reads are cursor-addressed and capped at 1 MiB per page; filesystem command input is likewise capped at 1 MiB per raw transfer. Large writes are staged through multiple bounded stdin transfers and committed only after the complete payload arrives, so payload size is independent of operating-system argument limits. Command output is UTF-8 text retained by the runtime and read in bounded, cursor-addressed pages, preserving stdout/stderr chunk order without callbacks or streams.
- Errors are plain data with a stable category, machine-readable code, retryability, request identity, optional backend identity, and discriminated details. Frontends translate these envelopes into their provider-specific error classes and messages.

## Current operation surface

The asynchronous `SandboxClient` covers the behavior required by the current Vercel frontend: create/get/list/stop/delete and deadline extension; command start/wait/bounded output, long-poll following, and portable signal delivery; bounded file read/write, recursive directory creation, and the provider-neutral semantic filesystem operation union; and resolution of a declared port to its loopback HTTP endpoint. Observed sandbox records carry the concrete resolved image, the optional provider-neutral runtime selector that produced it, and the currently resolved endpoint snapshots. This lets compatibility frontends preserve synchronous metadata access without receiving backend handles. The Vercel adapter remains responsible for provider conveniences such as generated names, callbacks, `Date`, `Buffer`, `Stats`, `Dirent`, stream conversion, and `AbortSignal` adaptation.

## Embedded construction

`EmbeddedSandboxClient` is constructed with exactly one `SandboxBackend` instance and remains bound to it. A `null` backend in a create request uses that injected instance; a non-null reference must match its stable ID and type. Applications that need multiple backends construct multiple clients, so selection never depends on a default, registry, singleton, or mutable global state.

## Backend responsibility

A backend owns provider sandbox state and the raw execution mechanism, but not neutral command lifecycle or filesystem semantics. It exposes a data-only reference, immutable sandbox and raw-command capability advertisements, lifecycle/endpoint operations, and one in-process raw-command primitive with optional bounded stdin. The embedded client compares requested backend identity and capabilities before calling `createSandbox`; unmet requirements produce one structured failure and no creation side effect. The filesystem bridge likewise preflights semantic, input-transfer, and privileged-operation capabilities before starting transfer or mutation. Raw command events are plain data discriminating stdout, stderr, completion, and backend failure.

## Command lifecycle and retention

`EmbeddedSandboxClient` assigns every command an opaque process ID and owns the per-sandbox process registry, ordered output chunks, cursors, followers, completion result, waiter fan-out, mutation idempotency, and signal-delivery state. Repeating a lifecycle, command, or filesystem mutation with the same idempotency key and payload returns the original outcome without repeating the side effect; reusing that key for a different mutation is rejected. Completion is settled once and remains stable for concurrent, repeated, and completion-after-deadline callers. Deleting a sandbox cancels outstanding command waiters, disposes raw backend handles, and removes every process owned by that sandbox.

Each start request supplies an output byte limit. The runtime retains the first bytes produced, in raw event order across stdout and stderr, until that limit is reached; later output is discarded and the `truncated` flag remains true. Cursors address the retained sequence and never move backward. A follow read at the current cursor waits for the next output event or terminal event, including output discarded after truncation, then returns one current page. This keeps storage bounded while preventing missed or duplicated retained chunks.

## Filesystem bridge ownership

The runtime owns one filesystem program and wire protocol. It validates paths and operation arguments, rejects NUL bytes, serializes operation arguments, stages binary input, decodes results and Node-style file errors, and implements every semantic operation used by both the direct runtime methods and the Vercel facade. Relative Vercel paths are resolved against `/vercel/sandbox` at the adapter boundary; absolute paths remain absolute. The adapter alone reconstructs `Buffer`, `Stats`, `Dirent`, and stream values.

Backends need only raw command execution plus advertised bounded-input support. Reads execute as bounded offset pages. Writes and appends send at most 1 MiB per stdin transfer to a sandbox-side staging file, then perform the target mutation after all chunks arrive; abort or transfer failure removes staging state without committing the target. Operation arguments are capped at 64 KiB and command results at 16 MiB. No file payload is placed in an argument vector.

Ownership changes use the explicit internal `managed-filesystem-owner` raw-command privilege. A backend must reject that privilege before process start unless the sandbox uses a trusted managed image; it then runs only the neutral filesystem program with the managed image's fixed Node executable as root. Public arbitrary `user: root` is never a substitute. Unsupported semantic, transfer, or privilege capabilities fail before filesystem mutation or data transfer begins.

## Docker backend ownership

`DockerBackend` is the only Docker boundary. It owns Dockerode construction and values, managed-image resolution, labels, container creation and inspection, persistence and resource settings, network and published-port inspection, watchdog deadlines, source materialization, raw exec creation, bounded stdin attachment, stream demultiplexing, exit inspection, raw signal delivery, cleanup, and Docker failure translation. It does not contain filesystem operation scripts or semantic filesystem APIs. Docker exec IDs, streams, containers, and inspect values remain private. The backend does not allocate neutral process IDs or retain replay output, cursors, followers, waiters, or frontend callbacks.

The default Docker composition lives in `src/default-client.ts`. The Vercel compatibility frontend receives a generic `SandboxClient` factory and retains only the client plus neutral records and IDs. Its tests inject a contract-only client; frontend behavior never imports or receives a Docker backend, container, exec, stream, inspect response, error, or identifier.

## Backend conformance profiles

Every advertised backend capability must map to at least one observable behavior profile in `test/conformance/backend-profile.ts`. Registration supplies a `BackendConformanceHarness`: the declared capability strings, a client constructor, a complete valid `SandboxSpec`, unique sandbox-name generation, source fixtures when source capabilities are advertised, and deterministic cleanup. The shared profiles exercise lifecycle and mutation idempotency, command ordering/wait/signal/error behavior, bounded binary and text filesystem pages, endpoint records, request and sandbox deadlines, persistence, sources, networking, resource records, and deletion cleanup.

A profile is skipped only when the harness does not advertise one of its named required capabilities; the skipped test name lists that absent capability. Registration fails coverage when a backend advertises an unknown capability or a known capability has no profile mapping. Each case owns uniquely named resources and invokes harness cleanup from a `finally` path, so profiles are parallel- and full-suite-safe.

To register a future backend, construct it behind its normal `SandboxClient` boundary, publish its immutable capability list, implement the harness methods, provide real source fixtures for advertised source capabilities, and call `registerBackendConformanceProfiles`. Backend-specific mechanism tests may remain beside the registration, but reusable contract expectations belong in the profiles. Docker registers through `EmbeddedSandboxClient` in `test/integration/docker-conformance.test.ts`; the existing Docker integration CI job discovers and runs that file.

## Error boundary

Valid contract failures returned by a backend retain their category, code, message, retryability, backend identity, and structured details. Thrown values, malformed results, request-ID mismatches, and non-JSON values become a stable `LOCALBOX_BACKEND_FAILURE` envelope for the current operation. Backend errors, stacks, handles, class instances, and other implementation values never cross the client boundary.

## Intentional non-goals

This layer does not provide a transport server, RPC protocol, durable runtime state beyond current Docker persistence, dynamic backend discovery, reconnection, a new public stream API, transport-level cancellation, or additional provider APIs. Process, bwrap, and Podman backends and a remote service or control plane remain deferred to later milestones. Backend selection remains explicit and instance-bound rather than global or mutable. This work does not change the development interception rules in [INTERCEPTION.md](./INTERCEPTION.md).
