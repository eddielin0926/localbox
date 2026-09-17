# Runtime client contract

The `localbox/runtime` entry point defines the backend-neutral values exchanged between a compatibility frontend and a Localbox runtime. It is the shared contract for embedded and future remote clients; it does not select a transport.

## Boundary invariants

- Every request, result, backend reference, capability requirement, and operation failure is JSON-compatible. Optional data is represented by an absent property only where the type permits it; callers must not place `undefined` in boundary values.
- IDs are opaque strings. Lifecycle mutations include a caller-generated `requestId`, `idempotencyKey`, and explicit `sandboxId`; command and filesystem mutations follow the same rule. Reusing an idempotency key means retrying the same mutation, not starting a new one.
- Request deadlines are absolute Unix timestamps in milliseconds. They are not timers, `AbortSignal` values, or cancellation callbacks. A runtime that completes an operation returns a `ClientResult`; transport failures before a response remain transport concerns.
- Creation requirements describe the semantics a frontend needs. The runtime must return an `unsupported-requirement` failure listing every known unmet requirement before creating the sandbox. This contract does not define a capability registry or negotiation engine.
- Backend references contain only stable diagnostic identity. They never contain Docker, process, socket, or other in-process handles.
- Binary file data uses base64. Command output is UTF-8 text retained by the runtime and read in bounded, cursor-addressed pages, preserving stdout/stderr chunk order without callbacks or streams.
- Errors are plain data with a stable category, machine-readable code, retryability, request identity, optional backend identity, and discriminated details. Frontends translate these envelopes into their provider-specific error classes and messages.

## Current operation surface

The asynchronous `SandboxClient` covers the behavior required by the current Vercel frontend: create/get/list/stop/delete and deadline extension; command start/wait/bounded output and portable signal delivery; file read/write and recursive directory creation; and resolution of a declared port to its loopback HTTP endpoint. Observed sandbox records carry the concrete resolved image, the optional provider-neutral runtime selector that produced it, and the currently resolved endpoint snapshots. This lets compatibility frontends preserve synchronous metadata access without receiving backend handles. The Vercel adapter remains responsible for provider conveniences such as generated names, callbacks, `Date` and `Buffer` conversion, async pagination, request cancellation, and blocking-versus-detached command behavior.

## Embedded construction

`EmbeddedSandboxClient` is constructed with exactly one `SandboxBackend` instance and remains bound to it. A `null` backend in a create request uses that injected instance; a non-null reference must match its stable ID and type. Applications that need multiple backends construct multiple clients, so selection never depends on a default, registry, singleton, or mutable global state.

## Backend responsibility

A backend owns sandbox and process state and implements the full client operation surface. It exposes a data-only reference and an immutable capability advertisement. The embedded client compares requested backend identity and capabilities before calling `createSandbox`; unmet requirements produce one structured failure and no creation side effect. Other requests, including request IDs, idempotency keys, and absolute deadlines, are passed to the selected backend unchanged.

## Docker backend ownership

`DockerBackend` is the only Docker boundary. It owns Dockerode construction and values, managed-image resolution, labels, container creation and inspection, persistence and resource settings, network and published-port inspection, watchdog deadlines, source materialization, exec attachment and stream demultiplexing, process output retention, filesystem bridge execution, cleanup, and Docker failure translation. Its stable reference, capability list, operation results, sandbox records, process records, endpoint records, and failures are JSON-only.

The Vercel compatibility frontend constructs an `EmbeddedSandboxClient` with a `DockerBackend` explicitly and retains only `SandboxClient` plus neutral records and IDs. It never receives a Docker container, exec, stream, inspect response, error, or buffer from the backend.

## Error boundary

Valid contract failures returned by a backend retain their category, code, message, retryability, backend identity, and structured details. Thrown values, malformed results, request-ID mismatches, and non-JSON values become a stable `LOCALBOX_BACKEND_FAILURE` envelope for the current operation. Backend errors, stacks, handles, class instances, and other implementation values never cross the client boundary.

## Intentional non-goals

This layer does not provide a transport server, RPC protocol, durable runtime state, dynamic backend discovery, reconnection, live log streaming, transport-level cancellation, or additional provider APIs. Neutral command lifecycle redesign remains deferred to #24, the broader filesystem bridge remains deferred to #25, and remote transport remains deferred to #26. The current command and filesystem mechanics exist only to preserve the Vercel-compatible behavior through the backend boundary; they are not the later redesigns. The compatibility `chown` tunnel recognizes one internal process identity, substitutes a backend-owned chown program, and executes it as root only for mirrored managed images; custom images fail with a structured unsupported-capability error until #25 defines privileged filesystem operations. Backend selection remains explicit and instance-bound rather than global or mutable. This work does not change the development interception rules in [INTERCEPTION.md](INTERCEPTION.md).
