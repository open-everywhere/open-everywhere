# Contributing to Open Everywhere

Thanks for your interest in Open Everywhere — an open-weights, self-hostable take on the
"tag the bot in a channel" autonomous teammate, built on [Vercel Eve](https://github.com/vercel/eve).
Issues, discussions, and pull requests are welcome.

## Ways to contribute

- **Found a bug?** Open an issue with a minimal repro (use the bug template).
- **Have an idea?** Open a feature-request issue or start a Discussion first for anything large.
- **Security vulnerability?** **Do not open a public issue** — see [SECURITY.md](./SECURITY.md)
  for private reporting.
- **Code/docs change?** Open a PR (see below). For anything non-trivial, open an issue first
  so we can agree the shape before you build.

## Development setup

Open Everywhere targets **Node 24** (Eve's floor — `package.json#engines`).

```bash
git clone https://github.com/open-everywhere/open-everywhere.git
cd open-everywhere
npm ci
```

Run it locally (proves the model loop with no Slack/access needed):

```bash
npm run dev          # eve dev — TUI on http://127.0.0.1:3000 (needs an AI Gateway key or `eve link`)
```

See [`docs/deploy/setup-runbook.md`](./docs/deploy/setup-runbook.md) for standing it up against a
real workspace, and [`docs/introduction/core-concepts.md`](./docs/introduction/core-concepts.md) for the design.

## The bar for a PR

**This repo runs no CI, so no check appears on your pull request.** Do not wait for one. You
prove your own commit: run all four commands and report the result in the PR body.

```bash
npm run typecheck:all     # tsc against real Eve types (root + every workspace) — must be clean
npm test                  # the full deterministic suite — must be green
npm run build             # eve build — loads the full agent graph
npm run test:integration  # vitest — real host, scripted model against a real, in-process boot
```

Develop with targeted tests locally (a single file, a workspace suite, `typecheck:all`), then
run the four suites once before you open the PR, and put each command's exit code in the PR
body. Before merge, a maintainer re-runs the same four suites and runs the pre-merge fence
(`npm run deploy:merge-fence`, see [Sign your commits](#sign-your-commits-dco)). The live e2e
scenarios need credentials for real workspaces, so a pull request does not need them.

- **New behaviour needs a test.** Add a `scripts/<name>-test.ts` (follow the existing style:
  plain assertions, exit non-zero on failure), define a `test:<name>` script for it in that
  package's `package.json`, and append one line, `test:<name>`, to the package's `test-chain.txt`.
  Bug fixes should add a regression test that fails before the fix.
- **Keep it typed.** No `any`-escapes that defeat the resolver/identity types — those are
  load-bearing for the access model.
- **Match the surrounding code** — comment density, naming, and idiom.

## Where to start reading

- `agent/agent.ts` — the agent entry (model + gateway config).
- `agent/access/bundles.ts` — the access model as config-as-code (the "admin console").
- `packages/core/agent/access/resolver.ts` + `packages/core/agent/identity/binding.ts` — identity → effective access.
- `agent/channels/*` — the surface adapters (Slack is the reference).
- [`docs/how-it-works/access-and-scoping.md`](./docs/how-it-works/access-and-scoping.md), [`docs/capabilities/memory.md`](./docs/capabilities/memory.md) — the design rationale.

## Security-sensitive areas (extra care)

These enforce the security model — changes here get closer review:

- `packages/core/agent/access/egress.ts` + `agent/hooks/egress.ts` — the egress firewall + credential injection.
- `packages/core/agent/access/connector-scope.ts` — the connector hard-gate (reaches Eve internals; pinned by
  `npm run test:connector-scope -w @open-everywhere/core`, which fails loud on an Eve bump).
- `packages/core/agent/access/untrusted.ts` — the prompt-injection boundary.
- **CI invariant — never weaken it:** this repo runs no CI workflow, and the suites need
  **no secrets**. The one workflow, `.github/workflows/npm-publish.yml`, publishes to npm on a
  release tag in `open-everywhere/open-everywhere` only. It reads no secret, because npm trusted publishing
  needs none (see `docs/dev/publishing.md`). If you add a workflow to a fork, trigger it on `pull_request`, never on
  `pull_request_target` with a checkout of the PR head and access to secrets — that is the
  classic supply-chain RCE. Keep the suites secret-free.

## Pull request process

1. Fork and branch from `main`.
2. Make your change; add/extend tests; run targeted tests locally (a single test file, a
   workspace suite, `npm run typecheck:all`) as you go.
3. Open a PR with a clear description of what changed and why. Link any related issue.
4. Keep PRs focused — one logical change. Update docs in the same PR when behaviour changes.

## Sign your commits (DCO)

Open Everywhere uses the [Developer Certificate of Origin](https://developercertificate.org/) — a
lightweight sign-off certifying you have the right to submit your contribution under the
project's license. There is no CLA.

Add a sign-off line to every commit:

```bash
git commit -s -m "your message"
```

This appends `Signed-off-by: Your Name <your@email>` (using your `git config user.name` /
`user.email`). For an existing branch: `git rebase --signoff main`.

**What enforces this.** The pre-merge fence, `npm run deploy:merge-fence -- --pr <n>`. It reads
every commit in the PR and refuses the merge when one carries no `Signed-off-by: Name <email>`
trailer. Merge commits are exempt — a merge certifies no new authored work, and this repo asks you
to merge `main` in before merging.

Two limits, stated plainly so you know what the check is worth:

- It checks that a trailer is **present and well formed**. It does not check that the trailer's
  name and address match the commit author, and it cannot verify who signed.
- It gates a merge only when the maintainer runs it before the merge. The exit code is reported,
  not attested, and the fence's status context is not among `main`'s required checks.

So a maintainer who merges without the fence should still check the sign-offs.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating, you
agree to uphold it.

## License

By contributing, you agree your contributions are licensed under the project's
[Apache License 2.0](./LICENSE).
