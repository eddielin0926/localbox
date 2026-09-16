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

The asynchronous `SandboxClient` covers the behavior required by the current Vercel frontend: create/get/list/stop/delete and deadline extension; command start/wait/bounded output and portable signal delivery; file read/write and recursive directory creation; and resolution of a declared port to its loopback HTTP endpoint. The Vercel adapter remains responsible for provider conveniences such as generated names, callbacks, `Date` and `Buffer` conversion, async pagination, request cancellation, and blocking-versus-detached command behavior.

## Intentional non-goals

This contract does not implement an embedded runtime, Docker backend, transport server, RPC protocol, persistence, backend capability discovery, reconnection, live log streaming, transport-level cancellation, provider SDK types, or additional filesystem operations. Those behaviors require later M2 work or a demonstrated transport-neutral contract extension. It also does not change the development interception rules in [INTERCEPTION.md](INTERCEPTION.md).
