# Source-control backends

The agent ships real code — clone, commit, push, open a PR under its own bot identity. The
built backend is a **GitHub App**. Non-GitHub backends (GitLab, Bitbucket) are a **Roadmap**
seam. This page is the extension angle; the capability is in
[Source control](../capabilities/source-control.md).

## The built backend: GitHub App

Source control is its own plane, distinct from the egress and connector planes. It gives the
agent its **own GitHub identity** (a GitHub App), so PRs it opens are authored by the bot, not
by a person impersonated. It owns:

- **App credentials** (org-level, set once at setup): app id, private key, webhook secret,
  installation id(s) — all via `secretRef`, never inlined.
- **The repo universe** — the installation defines which repos are reachable; a bundle's
  `repos` narrows within it. Effective repos = installation universe ∩ `bundle.repos`.
- **Token minting** — short-lived installation tokens, minted **host-side** from the app key
  and down-scoped per mint: **read-only** (`contents:read`, `metadata:read`) at checkout,
  scoped to the *union* of the session's granted repos and injected as a header transform on
  the sandbox's network policy (`github.com` / `codeload.github.com`) — it never enters the
  sandbox, only the fallback path (firewall enforcement unavailable) bakes it into git via
  `http.extraheader` — **PR-read** (`contents:read`, `pull_requests:read`, `metadata:read`)
  for the read-only PR verbs, which GitHub refuses to serve `GET …/pulls/{n}` without the
  `pull_requests` scope in the mint body (kept separate so the *persisted* checkout set is
  never widened; this one is in-memory for one call) — **conversation-read**
  (`issues:read`, `pull_requests:read`, `metadata:read`) and **conversation-write**
  (`issues:write`, `pull_requests:write`, `metadata:read`) for the verbs that read or comment
  on an issue-or-PR conversation, which name *both* families because GitHub routes the shared
  `/issues/{n}` endpoints by the resource the number names, and carry no `contents` at all —
  and **write** (`contents:write`,
  `pull_requests:write`, `metadata:read`) only inside the approval-gated
  `open_pull_request` flow, used inline in
  the one push command, never stored, and never put on the firewall (a standing write
  header would be reachable by any concurrent sandbox code). Tokens **never reach the
  model** either way.
- **Bot identity** — commits and PRs authored as `open-everywhere[bot]`, linked back to the
  originating surface/thread for audit.

The agent's `checkout_repo` tool lazily clones an allowed repo on demand (fail-closed on an
ungranted repo, like the connector hard-gate), and detects a repo's `AGENTS.md` / `CLAUDE.md`
convention file on clone — returning a lightweight flag, not the content.

## The seam shape for GitLab / Bitbucket — **Roadmap**

Today `packages/core/agent/scm/*` is **hardcoded to the GitHub App** (JWT mint, installations); there is no
`SCMProvider` interface yet. The seam is genuine but not abstracted: targeting GitLab or
Bitbucket means **introducing the interface first**, then writing an adapter behind it.

The right trigger to extract that interface is a **second real consumer**, which already exists:
authenticated git-repo access is used both for code checkout *and* for the
[`github` memory backing](./memory-backings.md). That's the point at which a `GitRepoBacking` /
`SCMProvider` interface earns its keep — the GitHub App plane becomes the default impl, and
plain-git / GitLab / Bitbucket slot in as alternative impls behind it. Until that interface
lands, non-GitHub source control is **Roadmap**, not a clean swap.

The interface, once introduced, would need to provide: authenticated clone/fetch/push transport
(scoped, ephemeral credential, injected host-side), a create-PR/merge-request API call authored
as a bot identity, and per-session repo down-scoping.

**One slice is already behind a seam:** the credential-binding config-repo PR — the host-side flow
that re-stamps a credential's custody env → db by opening a PR against the deployer's config repo
([binding PR](../security/credentials-and-planes.md#moving-custody-env--db-the-binding-pr)) — rides
the **`ConfigPrProvider`** port (`registerConfigPrProvider`, exported from the adapter-api barrel).
GitHub is the registered default (`registerGitHubConfigPrProvider`, wired at boot like the `github`
memory backing); a GitLab/Gitea self-hoster registers their own so PR-governed bindings aren't
GitHub-only. This is deliberately *just* the config-repo PR mechanism (resolve a write credential,
branch+commit the overlay, open/reopen the PR) — the broader clone/fetch/push and code-PR transport
above stays GitHub-hardcoded until the full `SCMProvider` interface lands.

## On Vercel / Off Vercel

- **On Vercel:** the GitHub App plane runs host-side; per-session installation tokens are minted
  and can be brokered at the sandbox firewall (the documented prod-hardening path), so the token
  never enters the sandbox.
- **Off Vercel:** a self-host deployer **registers their own Open Everywhere GitHub App** (the
  GHES model — app id + private key, one-time) rather than installing a hosted one. The whole
  plane is optional: it's only needed when a team hands the agent code work, and a preflight
  detects whether it's configured. GitLab/Bitbucket backends are **Roadmap** regardless of host.
