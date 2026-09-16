# Localbox roadmap

Localbox aims to let cloud-sandbox-dependent applications run locally during development while preserving provider imports wherever interception is technically possible. The v0.2 baseline exposes a Vercel-compatible frontend through `localbox/vercel`, executes with Docker, and adds explicit development interception; later milestones add more frontends and backends, and deployment modes ranging from embedded use to distributed infrastructure on AWS, Azure, or Google Cloud.

This roadmap describes direction rather than release dates. Milestones are ordered by dependency; scope may move as compatibility targets and upstream SDKs evolve.

## Architecture

Localbox separates four independently replaceable concerns:

1. **Development interception** is an explicit, process-scoped development choice that selects a local compatibility implementation for an application import such as `@vercel/sandbox`.
2. **Compatibility frontends** reproduce provider SDK semantics and translate APIs such as Vercel Sandbox, Cloudflare Sandbox, E2B, and Daytona into the Localbox sandbox client contract.
3. **Execution runtime and isolation backends** implement that contract through an embedded runtime or remote control plane, then execute sandboxes through process, bwrap, container engines, Apple container, Incus, Kubernetes, or microVMs.
4. **Deployment infrastructure** hosts embedded or local execution and, later, single-node services, remote workers, Kubernetes installations, or cloud deployments.

The intended request path is:

```text
Application using a provider import
  -> opt-in development interception
    -> compatibility frontend
      -> sandbox client contract
        -> embedded runtime, or remote control plane
          -> worker supervisor
            -> isolation backend
              -> sandbox
```

Interception selects an implementation without defining provider semantics. Frontends define those semantics. The client contract defines transport-safe operations. The runtime or control plane manages lifecycle and placement. Workers reconcile desired and observed state. Backends provide isolation. Deployment modules provision and operate the infrastructure.

## Principles

- Never activate interception by default.
- Never mutate installed provider packages or application source to enable interception.
- Never change provider-package resolution in ordinary or production execution unless Localbox is explicitly enabled.
- Keep compatibility frontends independent from isolation backends.
- Preserve one observable behavior contract in embedded and remote modes.
- Keep core requests, results, process events, and backend references serializable.
- Pin every compatibility target to an upstream package version and publish a compatibility manifest.
- Classify features as native, emulated, partial, not applicable, or unsupported.
- Reject unsupported security, isolation, networking, and resource requirements instead of silently weakening them.
- Treat process and ordinary container backends as trusted or single-tenant execution, not hostile multi-tenant isolation.
- Keep the control plane out of the user workload execution path.
- Prefer PostgreSQL, an OCI registry, and S3-compatible object storage before introducing additional mandatory infrastructure.
- Store local persistent state under `XDG_STATE_HOME` when it is set.

## Delivery tracking

GitHub milestones map roadmap outcomes to semantic releases. Dates stay unset until a milestone becomes active; dependency order, not an invented calendar, controls sequencing.

| Roadmap milestone | Target release | Tracking issue |
| --- | --- | --- |
| M0 — Docker-backed Vercel baseline | `v0.1.0` | [#3](https://github.com/eddielin0926/localbox/issues/3) |
| M1 — Development interception and local DX | `v0.2.0` | [#4](https://github.com/eddielin0926/localbox/issues/4) |
| M2 — Neutral runtime and backend boundary | `v0.3.0` | [#5](https://github.com/eddielin0926/localbox/issues/5) |
| M3 — Pluggable local backends | `v0.4.0` | [#6](https://github.com/eddielin0926/localbox/issues/6) |
| M4 — Compatibility frontend framework | `v0.5.0` | [#7](https://github.com/eddielin0926/localbox/issues/7) |
| M5 — Single-node Localbox service | `v0.6.0` | [#8](https://github.com/eddielin0926/localbox/issues/8) |
| M6 — Distributed control plane and workers | `v0.7.0` | [#9](https://github.com/eddielin0926/localbox/issues/9) |
| M7 — Kubernetes distribution | `v0.8.0` | [#10](https://github.com/eddielin0926/localbox/issues/10) |
| M8 — AWS, Azure, and Google Cloud blueprints | `v0.9.0` | [#11](https://github.com/eddielin0926/localbox/issues/11) |
| M9 — Hardened isolation and platform maturity | `v1.0.0` | [#12](https://github.com/eddielin0926/localbox/issues/12) |

M0 through M3 are decomposed into implementation sub-issues. Later milestones remain outcome-level epics until their dependencies stabilize; decomposing them earlier would encode assumptions the neutral runtime and distributed architecture have not yet validated. GitHub blocked-by relationships record the critical path.

Every release requires:

- all milestone exit criteria and required CI checks to pass;
- public, immutable GHCR tags for every managed image referenced by that version;
- matching `package.json`, Git tag, npm package, and GitHub release versions; and
- release notes that identify compatibility changes, unsupported behavior, and security-boundary changes.

## Milestones

### M0 — Docker-backed Vercel baseline

**Status:** Current foundation

Establish and preserve the existing local product while later seams are introduced.

Deliverables:

- Vercel-shaped sandbox lifecycle through `localbox/vercel`.
- Docker-backed commands, files, ports, persistence, and timeouts.
- Versioned Vercel compatibility manifest.
- Unit, integration, smoke, type, and compatibility checks for the supported surface.

Exit criteria:

- The documented Docker workflow remains the behavioral baseline for subsequent milestones.
- Compatibility differences remain explicit and machine-readable.

### M1 — Development interception and local DX

**Status:** Release candidate; publication pending.

Provide the first opt-in path for running an unchanged Node development application against Localbox.

Deliverables:

- An explicit Localbox CLI process wrapper that installs a process-scoped Node module-resolution hook according to the [v0.2 interception contract](INTERCEPTION.md).
- A narrowly scoped mapping from `@vercel/sandbox` to `localbox/vercel`; no other package resolution changes.
- Continued support for direct `localbox/vercel` imports.
- Actionable diagnostics when the hook cannot be installed or when a framework or bundler resolves modules outside it.
- Optional framework adapters or aliases, isolated from the framework-neutral core and used only when a host toolchain cannot honor the Node hook.

Exit criteria:

- An unmodified Node development application importing `@vercel/sandbox` runs against Docker when launched through Localbox.
- The same application resolves the real Vercel package when launched normally.
- Exiting the wrapped process leaves no interception state behind.
- The existing direct-import smoke path still passes.

### M2 — Neutral runtime and backend boundary

Extract Docker from the compatibility frontend without changing public behavior.

Deliverables:

- Backend-neutral sandbox, process, endpoint, status, deadline, and error types.
- A transport-safe sandbox client contract.
- Embedded client implementation for in-process use.
- `DockerBackend` containing Docker lifecycle, exec, stream demultiplexing, labels, ports, and error translation.
- Backend-neutral command buffering, following, waiting, cancellation, and signal handling.
- Backend-neutral filesystem bridge built on the execution primitive.
- Backend conformance suite.

Exit criteria:

- Docker-specific types and operations exist only inside the Docker backend.
- `localbox/vercel` passes its existing observable behavior checks through the neutral runtime.
- A backend can be selected through runtime construction without mutable global configuration.

### M3 — Pluggable local backends

Prove that the backend boundary supports materially different execution models.

Deliverables:

- Capability negotiation for isolation, artifacts, persistence, recovery, networking, resource limits, terminals, and snapshots.
- Local sandbox metadata and atomic name ownership under the XDG state directory.
- Process backend for explicitly trusted workloads.
- bwrap backend for Linux namespace and filesystem isolation.
- Podman support through a tested container-engine path or a dedicated driver where semantics differ.
- Neutral boot-artifact representation for host, directory, OCI image, disk image, and snapshot sources.
- Backend-specific diagnostics and availability probing.

Exit criteria:

- Docker, process, and bwrap pass the applicable backend conformance profile.
- Unsupported artifact or isolation requirements fail before sandbox creation.
- Multiple backend instances can coexist in one process.
- Documentation states the security boundary of every backend.

Follow-on backend tracks after M3 include Apple container and Incus. Firecracker and Cloud Hypervisor remain M9 work, after the M6 distributed-worker foundation and alongside the guest-agent protocol.

### M4 — Compatibility frontend framework

Make provider API compatibility an explicit layer over the sandbox client contract.

Deliverables:

- Vercel moved into the common frontend layout without behavior regression.
- Versioned compatibility manifests and reports for every frontend.
- Cloudflare frontend with stable and preview/next targets treated as separate API contracts while both exist.
- E2B frontend covering the documented local lifecycle, command, file, timeout, and endpoint subset.
- Daytona frontend covering the documented local lifecycle, process, file, image, resource, and session subset supported by runtime capabilities.
- Local artifact mappings for provider image, template, and snapshot identifiers.
- Shared policy for native, emulated, partial, not-applicable, and unsupported features.

Exit criteria:

- Each frontend binds to the sandbox client rather than a concrete backend.
- Each frontend identifies the exact upstream package and version it targets.
- Shell-command, direct-argv, completion-result, and process-handle APIs preserve their distinct observable semantics.
- Cloud control-plane options are rejected or documented as not applicable; they are never silently accepted.

### M5 — Single-node Localbox service

Run the same runtime behind a durable remote API on one machine.

Deliverables:

- `localboxd` service exposing the sandbox client contract over a versioned protocol.
- Remote client implementation used by compatibility frontends.
- Persistent sandbox, process, deadline, endpoint, and idempotency metadata.
- Cursor-based process event and log streaming with reconnect support.
- Local endpoint proxy for HTTP and WebSocket traffic.
- Worker reconciliation after service restart.
- Docker Compose distribution using external or bundled PostgreSQL, object storage, and registry options.

Exit criteria:

- The same frontend behavior suite passes in embedded and remote modes.
- Restarting the daemon reconciles existing persistent sandboxes without duplicating them.
- Retried create, stop, delete, and signal requests are idempotent.
- Workers and sandbox administration endpoints do not require public exposure.

### M6 — Distributed control plane and workers

Separate scheduling and API responsibilities from workload execution.

Deliverables:

- Independently scalable control-plane and worker services.
- Outbound worker registration, heartbeat, capability, and capacity reporting.
- Placement by requirements, labels, architecture, region, and available capacity.
- Lease-based sandbox ownership and desired-versus-observed state reconciliation.
- Worker-loss detection, orphan handling, and recoverable reassignment policy.
- Shared OCI registry and S3-compatible artifact storage.
- Authenticated endpoint routing to private workers.
- Project isolation, service credentials, audit events, and basic usage accounting.

Exit criteria:

- A failed worker is detected and its leases expire without split ownership.
- The control plane never directly launches or hosts user processes.
- Placement refuses workers that cannot satisfy requested isolation or resource capabilities.
- Process logs and lifecycle state survive client and control-plane reconnects.

### M7 — Kubernetes distribution

Provide a portable production deployment and a Kubernetes-native execution option.

Deliverables:

- Helm chart for the control plane, workers, endpoint proxy, and required configuration.
- Support for external PostgreSQL, object storage, and OCI registries.
- Kubernetes backend mapping sandboxes to Pods.
- RuntimeClass and dedicated-node-pool hooks for stronger runtimes such as gVisor or Kata Containers.
- Network policy, pod security, resource quota, ingress, certificate, and observability configuration.
- Upgrade, rollback, backup, and disaster-recovery procedures.

Exit criteria:

- A clean cluster can install, exercise, upgrade, and remove Localbox through documented commands.
- Control-plane and worker capacity scale independently.
- Sandboxes remain private unless a frontend explicitly exposes an endpoint.
- The Kubernetes backend passes its applicable backend conformance profile.

### M8 — AWS, Azure, and Google Cloud blueprints

Make production self-hosting repeatable in each major cloud without creating three different Localbox architectures.

Deliverables:

- Shared OpenTofu/Terraform modules around the Helm deployment.
- AWS reference deployment using EKS, ECR, S3, RDS PostgreSQL, private networking, and dedicated worker node groups.
- Azure reference deployment using AKS, Azure Container Registry, Blob Storage, Azure Database for PostgreSQL, private networking, and dedicated worker pools.
- Google Cloud reference deployment using GKE, Artifact Registry, Cloud Storage, Cloud SQL for PostgreSQL, private networking, and dedicated worker pools.
- Workload identity, encryption, secret management, ingress, DNS, certificate, logging, and autoscaling integration for each provider.
- Cost and security profiles for development, single-tenant production, and hardened execution.

Exit criteria:

- Each reference deployment is created and destroyed from a clean account or project by documented automation.
- The same deployment conformance scenario passes on AWS, Azure, and Google Cloud.
- Workers run in private networks and connect outbound to the control plane.
- Provider modules expose the same logical inputs and outputs where cloud services permit.

### M9 — Hardened isolation and platform maturity

Support hostile workloads and specialized execution without weakening simpler deployment modes.

Deliverables:

- Versioned guest-agent protocol for execution, files, readiness, deadlines, terminals, and shutdown.
- Firecracker and Cloud Hypervisor backends on dedicated KVM-capable worker pools.
- Snapshot, restore, image conversion, and warm-pool services.
- Enforced CPU, memory, disk, process, network, and egress policies.
- Tenant-aware scheduling and stronger workload identity.
- Worker image provenance, artifact signing, vulnerability scanning, and measured upgrade procedures.
- High-availability and recovery objectives with load, failure, and isolation testing.
- Stable extension contracts for third-party frontends, backends, and deployment modules.

Exit criteria:

- Untrusted workloads are scheduled only onto backends and worker pools approved for that threat model.
- Host escape, cross-tenant access, stale endpoint, and lease-conflict scenarios have explicit tests and operational responses.
- Snapshot and restore behavior is portable within each documented backend profile.
- Public APIs and extension contracts meet the project’s stability policy.

## Cross-cutting tracks

These tracks continue across milestones rather than waiting for a single release:

### Compatibility

- Track upstream SDK releases and declaration changes.
- Keep manifests versioned beside each frontend.
- Test observable behavior rather than source shape.
- Document why unsupported cloud control-plane features are not applicable locally.

### Developer experience

- Keep the interception contract stable as compatibility frontends and provider SDKs evolve.
- Require explicit development opt-in and actionable diagnostics in every interception mode.
- Leave ordinary and production resolution on the original provider SDK unless Localbox is explicitly enabled.
- Ship framework and bundler adapters or aliases as optional packages; the core runtime must not depend on them.
- Fail with guidance when a toolchain bypasses the supported interception path; never silently fall back to remote execution.

### Security

- Maintain an explicit threat model for each backend and deployment profile.
- Keep workers private and use outbound control-plane connections.
- Treat frontend compatibility as API compatibility, never as equivalent provider isolation.
- Fail closed when resource or security requirements cannot be enforced.

### Operations

- Use structured events, metrics, and traces across control-plane and worker boundaries.
- Make lifecycle mutations idempotent and reconcilable.
- Support backup and restore before claiming production readiness.
- Publish upgrade compatibility and rollback requirements for every distributed release.

### Testing

Avoid a full frontend-by-backend Cartesian test matrix:

1. Every backend runs the backend conformance suite.
2. Every frontend runs its compatibility suite against a canonical conforming runtime.
3. Selected frontend/backend pairs receive integration coverage for capability-sensitive behavior.
4. Embedded and remote modes run the same observable frontend scenarios.
5. Cloud blueprints run one shared deployment conformance scenario.

## Implementation research references

These projects and services are inputs for implementation research only. Listing them does not promise a dependency, compatibility target, or adoption:

- **Vercel Sandbox** — provider SDK semantics for the current compatibility frontend.
- **contember/edvabe** — local interception and developer-experience patterns.
- **Cloudflare Sandbox and Miniflare** — provider SDK semantics and local development behavior.
- **LocalStack and Overcast** — local interception and developer-experience patterns for redirecting cloud-facing applications.
- **E2B Runtime** — execution isolation and backend abstraction.
- **Trigger.dev** — self-hosted control-plane and worker-operation patterns.
- **Supabase CLI** — opt-in local developer experience and lifecycle management.
- **Microsandbox** — execution isolation and backend abstraction.
- **AML sandbox providers** — provider SDK semantics and backend capability modeling.

## Out of scope until required by a milestone

- A general-purpose workflow engine.
- Hosted organization, billing, or marketplace parity with compatibility targets.
- Silent emulation of security or resource guarantees.
- A mandatory Kubernetes dependency for embedded and single-node use.
- One abstraction that hides meaningful differences between containers, namespaces, and virtual machines.
