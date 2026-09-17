# Contributing to Localbox

Thanks for helping improve Localbox. Bug reports, compatibility findings, documentation fixes, and focused code changes are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Search the existing issues before opening a new one.
- Use the issue forms so reports include the environment and reproduction details maintainers need.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
- Consider opening a feature request before a large or compatibility-sensitive change.

## Development setup

You need Node.js 22.12 or newer, pnpm 12.3.4, and a reachable Docker daemon for integration and smoke checks.

```sh
git clone https://github.com/<your-user>/localbox.git
cd localbox
pnpm install --frozen-lockfile
```

Create a focused branch from the current `main` branch. Keep unrelated changes in separate pull requests.

## Making changes

- Preserve the supported behavior documented in [`src/vercel/compatibility.json`](src/vercel/compatibility.json).
- Update the compatibility manifest and README when public behavior changes.
- Add or update tests for observable behavior, boundaries, state transitions, or regressions.
- Avoid tests that only assert implementation details.
- Keep error messages actionable and avoid writing unsolicited output to process streams.

## Verification

Run the smallest checks that cover your change:

| Command | Purpose | Docker required |
| --- | --- | --- |
| `pnpm typecheck` | Check TypeScript source and type tests. | No |
| `pnpm test:unit` | Run unit tests. | No |
| `pnpm build` | Build the published package. | No |
| `pnpm test:integration` | Exercise sandbox behavior against Docker. | Yes |
| `pnpm smoke` | Run the end-to-end example after building. | Yes |
| `pnpm compatibility:vercel` | Print the current Vercel compatibility report. | No |

For most changes, run type checking, unit tests, and the build. Run integration and smoke checks when changing Docker, lifecycle, command, filesystem, port, or timeout behavior.

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
