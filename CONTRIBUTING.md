# Contributing to Localbox

Thanks for helping improve Localbox. Bug reports, compatibility findings, documentation fixes, and focused code changes are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Search the existing issues before opening a new one.
- Use the issue forms so reports include the environment and reproduction details maintainers need.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
- Consider opening a feature request before a large or compatibility-sensitive change.

## Development setup

You need Node.js 22.12 or newer and pnpm 12.3.4. Docker is required for the default integration and smoke checks; Podman checks require a reachable rootless or rootful API socket.

```sh
git clone https://github.com/<your-user>/localbox.git
cd localbox
pnpm install --frozen-lockfile
```

Create a focused branch from the current `main` branch. Keep unrelated changes in separate pull requests.

## Making changes

- Preserve the supported behavior documented in [`src/frontend/manifests`](src/frontend/manifests).
- Update the provider manifest and user documentation when public behavior changes.
- Add or update tests for observable behavior, boundaries, state transitions, or regressions.
- Avoid tests that only assert implementation details.
- Keep error messages actionable and avoid writing unsolicited output to process streams.

### Frontend conventions

Each provider owns one data-only schema-v1 manifest in `src/frontend/manifests`. Do not add a provider-specific reporter or a second schema. Record the exact upstream package, pinned version, documentation URL, assessment date, public surfaces, support classification, type/behavior compatibility, and declaration drift configuration. Use only `native`, `emulated`, `partial`, `not-applicable`, or `unsupported`, and provide a concrete rationale for every non-native entry. `not-applicable` is limited to cloud-only concerns with no local semantic effect; requested behavior Localbox cannot preserve is `unsupported`.

Provider adapters expose their provider-specific package entry point but compose through `localbox/frontend` with an explicit public `SandboxClient` or factory. They must not import a backend, choose a backend globally, or move default embedded composition into adapter code. Translate and validate provider requests before resolving the client; unsupported security, isolation, network, resource, storage, snapshot, session, terminal, and hosted control-plane options must fail before sandbox creation. Explicitly report genuinely not-applicable inputs. Never silently ignore an option.

Frontend behavior suites reuse the discriminated shell/argv and completion/live-process contracts. Test those four semantics independently, along with option preflight, provider result/error translation, and meaningful differences recorded in the manifest. Keep package exports, published files, the all-frontend report script, README, and runtime documentation in sync when adding a frontend.

## Verification

Run the smallest checks that cover your change:

| Command | Purpose | Container engine required |
| --- | --- | --- |
| `pnpm typecheck` | Check TypeScript source and type tests. | No |
| `pnpm test:unit` | Run unit tests. | No |
| `pnpm build` | Build the published package. | No |
| `pnpm test:integration` | Exercise default sandbox behavior against Docker; Podman conformance is skipped unless configured. | Docker |
| `LOCALBOX_PODMAN_SOCKET=/absolute/podman.sock LOCALBOX_PODMAN_MODE=rootless pnpm test:podman` | Exercise Podman availability and applicable backend conformance profiles. Use `rootful` for a rootful service. | Podman |
| `pnpm smoke` | Run the end-to-end default example after building. | Docker |
| `pnpm compatibility` | Validate every frontend manifest and render reports in stable order; add `-- --json` for JSON. | No |
| `pnpm compatibility:vercel` | Validate and render only the Vercel report. | No |

For most changes, run type checking, unit tests, and the build. Run the applicable Docker and/or Podman integration checks when changing container-engine lifecycle, command, filesystem, port, persistence, timeout, or cleanup behavior.

## Pull requests

A useful pull request:

- explains the user-visible problem and resulting behavior;
- links related issues when available;
- calls out Vercel compatibility changes and intentional differences;
- lists the exact checks that were run;
- stays small enough to review safely; and
- uses a Conventional Commit title such as `fix: preserve sandbox state after stop`.

Maintainers may ask for changes before merging. Reviews focus on correctness, compatibility, maintainability, and regression risk.

## Release process

Maintainers release from a clean `main` commit after its required CI checks pass:

1. Update `package.json` and user-facing compatibility documentation in a focused release pull request, then run `pnpm smoke:package` to install the packed archive in a clean external pnpm consumer.
2. Run the manual `Publish Vercel-compatible images` workflow when managed-image sources or tags change, then confirm every image referenced by the package is publicly pullable.
3. Confirm the npm `localbox` package trusts `.github/workflows/release.yml` through the `npm` GitHub environment, or configure the `NPM_TOKEN` environment secret for the first publish only.
4. Create a GitHub release whose tag is exactly `v` plus the package version. Publishing the release triggers the npm workflow.
5. Verify the npm version, GitHub tag and release commit, package provenance, and documented smoke path.

Never publish a GitHub release while its npm authentication or required GHCR images are unavailable. A draft release is safe for preparing notes because it does not trigger publication.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
