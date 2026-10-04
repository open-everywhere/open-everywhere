# Self-documentation

Open Everywhere ships its own manual **inside the agent**. Ask it "how does memory scoping work?",
"what can you actually do in this channel?", or "how do I connect another surface?" and it answers
from these docs — the same pages you are reading — rather than from whatever a general-purpose model
half-remembers about a product it was never trained on.

That is the same principle as the rest of the system: the control plane is the agent, not a
dashboard ([Control plane](../security/control-plane.md)), and configuration is code in your repo
([Config as code](../how-it-works/config-as-code.md)). If the operator surface is the agent itself,
the manual for that surface has to be reachable from inside the agent too — otherwise
self-management stops exactly where somebody needs to know how something works.

## The `read_docs` tool

One tool, two modes:

- **no arguments** — lists the manual this deployment ships: path, title and a one-line gist per doc;
- **a path** — returns that doc. Cross-references resolve the way they are written inside the docs,
  so `../../capabilities/memory.md` lifted out of a surface runbook just works, as does a bare
  `memory.md` when it is unambiguous.

It is an ordinary read: open to every member, never approval-gated, always audited (`docs.index` /
`docs.read` / `docs.refused` in the [audit log](../security/audit-and-provenance.md)). The window
gate does not narrow it either — `read_docs` is window-ungated, so every session grain may hold it.

One narrowing does apply, and it is the **lean seat** cut, not a permission. A standing or thread
seat that can delegate holds the conversational roster only, and `read_docs` is not on that roster.
Such a seat reads the manual through a one-shot worker. A seat that cannot delegate, a `native`
or `task` grain, and an unattended fire all hold `read_docs` directly.

Nothing it returns is about *your* org — it is product documentation, identical for every deployment
carrying the same bundles.

If a doc isn't part of this deployment's manual, the agent is told to **say so** rather than
improvise something plausible.

## You only get the docs for what you run

A deployment that doesn't carry the Notion bundle is never handed Notion's setup runbook. This
falls out of the [provider bundle](../extending/provider-bundles.md) model rather than needing a
second mechanism:

- each bundle ships its own `docs/deploy/surfaces/<id>.md` **inside the bundle**, so de-selecting the
  bundle removes its documentation from the deployment entirely — those pages are not shipped, not
  merely hidden;
- the registration goes through the same boot selection gate every other provider seam uses, and the
  read re-checks the selection, so a de-selected provider's manual is unreachable twice over;
- everything that is not one provider's runbook — concepts, security, memory, deploy, extension
  guides — is universal and always present.

An unknown doc and a doc belonging to a bundle you don't run get the **same** refusal. Distinguishing
them would disclose that a Notion manual exists to a deployment that deliberately carries no Notion.

## Where the manual ships

The universal manual ships inside the `@open-everywhere/core` package, at the subpath
`@open-everywhere/core/agent/docs/generated/index.js`. Each provider package carries its own
runbook. The app registers the universal manual once at boot, from its own
`agent/lib/register-docs.ts`, which `agent/lib/register-config.ts` imports.

An app scaffolded with `npx @open-everywhere/create` carries the same `register-docs.ts`. So its
agent serves the same pages as this repository's reference app, at the version of core it installed.
The scaffold copies no page into your app, so an upgrade of core also upgrades the manual. To add a
page of your own, call `registerDocs` again with more entries. An entry with the same `path` as a
shipped page replaces that page.

## It cannot drift

"The exact docs we ship" only means something if drift is impossible, so it is a build gate.

`docs/` is a directory of markdown in the repo; it does **not** exist on disk in a deployed instance
(the build emits JavaScript, and nothing else rides along). The manual is therefore *compiled into*
the deployment by `npm run docs:generate`, and `npm run lint:docs` — part of the standard test
chain — fails the build if:

- a doc was edited without regenerating,
- a provider bundle has no setup runbook, or a runbook names no bundle,
- a bundle stops handing its docs to the runtime,
- a generated module is left behind for a doc that no longer exists.

So the manual the agent quotes is the manual in the repo, at the commit that was deployed. In an app
that installs Open Everywhere from npm, it is the manual of the installed core version. If you change
a doc, regenerate and commit — see the contributor guide (`AGENTS.md`).

### …and it cannot be silently incomplete

Byte-identical docs are only half of it: a manual can be perfectly in sync and still fail to mention
a capability the agent has. So a second gate, `npm run lint:capability-docs`, is **total over the
agent's whole tool surface** — the same set every tool's [consequence
tier](../security/security-model.md) is pinned against, which includes the framework verbs and the
declared subagents, not just the ones written for this project. A tool that no page names fails the
build.

The honest bound: this pins that each capability is *named and described somewhere*, not that the
description is good — no lint can check that. What it removes is the silent case, where a verb ships
and the manual never learns it exists. Two limits on the claim:

- **Two declared exceptions.** Both are resolver files. Each one mounts other tools and nothing
  under its own name, so the model never sees the name and a page describing it would describe a
  capability nobody has. The lint reads both rows, with their reasons, from `UNDOCUMENTED_TOOLS`
  (`packages/core/agent/docs/capability-map.ts`) — and it reds if a page ever *does* name one, so
  the waiver cannot outlive its reason.
- **Runtime-injected planes are out of scope.** The gate counts the statically mounted tool
  surface. Connector operations, MCP operations and the injected `browser_*` family are built at
  run time, so no build-time lint can enumerate them. The `browser_*` tools are documented in
  [Browser QA](./browser-qa.md) all the same.

## What it is not

It is not a knowledge base of *your* content: team knowledge lives in [Memory](./memory.md), and
your own procedures live in [Skills](./skills-and-plugins.md). `read_docs` only ever serves Open
Everywhere's own first-party documentation, which is why it needs no untrusted-content handling and
never touches a credential, a network host, or your data.
