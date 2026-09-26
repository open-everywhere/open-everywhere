# The tidy toolchain

Three scripts measure and reduce this repository's comment weight. They change comments only, and
one of them proves it. Nothing here runs at runtime; they are contributor tools.

## The tools

- **`node scripts/tidy/loc.mjs`** — the line counter. It prints files, code, comment and blank lines
  per area, with a comment-to-code ratio, a `TOTAL` row and the 25 files carrying the most comment
  lines. `--json` prints the same report as JSON, and `--root <dir>` counts another tree. An area is
  one workspace package, one `agent/<sub>` directory, or one remaining top-level directory. It counts
  the files git tracks, so a build's own output never reaches the table.
- **`npm run tidy -- inventory <path...> --out <file.jsonl>`** — one JSON record per comment block:
  `{id, file, start, end, kind, text, next_code, class}`. `class` is `auto-history` (every line is a
  date, a history word or a ticket reference) or `candidate`. Two kinds of block are never in the
  inventory at all: one holding a compiler or linter directive, and one with code after its closing
  `*/` — deleting the second would move that code, so `apply` refuses a decision naming either.
- **`npm run tidy -- apply <decisions.jsonl>`** — performs `{id, action, text?}` decisions, where
  `action` is `keep`, `delete` or `replace`. An id it cannot place is an error; `--reapply` says the
  decisions file has already run. A replacement is re-wrapped in the block's own comment style at its
  own indent, a blank run left behind collapses to one line, and a second run writes nothing new.
- **`npm run tidy -- verify --base <git-ref>`** — the gate. See the invariant below.
- **`node scripts/tidy/dead-report-audit.mjs`** — how much of `lint:dead` is real. It runs knip with
  the flags the `lint:dead` script itself carries, then re-checks every entry against an independent
  import sweep, and prints how many reported entries have an importer. `--json` prints the verdict
  per entry. It is a measuring instrument, not a gate: run it after changing `knip.json` or
  `tsconfig.knip.json` to see what the change did to the report.

[`scripts/tidy/RUBRIC.md`](../../scripts/tidy/RUBRIC.md) is the instruction set a judging agent reads
to decide each block. 🔴 **The repo copy is the canonical one.** It began as a copy of the tracking
ticket's text and has since been edited here — PR #544 added the OPE-1427 section and the
operator-caveat KEEP row — so the ticket is history and this file is the rubric.

## What `npm run lint:dead` now trusts

`lint:dead` runs knip. **Every entry it reports is a candidate to check, not a verdict.** 🔴 **"No
importer" is not "deletable".** Read the two structural blind spots below before you delete anything
from it.

The two halves of the report are not equally ready to work. The FILE list is short enough to read in
full — empty today, since OPE-1476 withdrew the one entry it held. The EXPORT list is not: 360
entries have no importer, and most of them are published package API, which is the second blind spot
below. Neither list is a delete queue.

knip resolves an `@open-everywhere/*` import through the target package's `exports` map, and every
entry in those maps points into `dist/` — a path `knip.json` ignores. A cross-package import was
therefore invisible, and the source file looked unreached. `tsconfig.knip.json` fixes it: it maps
each `@open-everywhere/*` specifier to the package's SOURCE directory, and `lint:dead` passes it as
`--tsConfig`. Read that file's header for why the mapping is not in the tsconfigs `typecheck:all`
compiles. `scripts/tidy/knip-resolution-test.ts` is the gate; a new workspace package needs a row in
the mapping, and that test is what turns a missing row into a red.

### The two blind spots

**Reached by convention, not by import.** Two kinds of entry point have no importer anywhere, so
knip cannot see them and `knip.json` names them as entries instead: each package's
`agent/contributions.ts`, which the roster loads through a specifier it builds at runtime
(`scaffold/roster-fs.ts`), and the app's `agent/instructions/` directory, which eve discovers by
location. `agent/instructions/access.ts` has already gone missing once, which silently unmounted
every dynamic instruction. A contribution manifest names its modules as data strings, so a module
listed there is invisible to knip too; today they all sit under `agent/tools/`, `agent/channels/`
and their siblings, which knip's eve plugin already treats as entry paths.

**Published for consumers outside this repository.** A module in a package's `exports` map is public
API of a package we publish. Nothing in this repository has to import it, and knip cannot see the
consumers that do. So a file the report names is not deletable on that evidence alone: the question
is whether the published surface is still wanted. `packages/adapters/agent/model/connector-op-tier.ts`
was the one such file, and OPE-1476 answered the question by WITHDRAWING it — the connector-op model
arm went, both halves, with its `exports` rows. The report's file list is empty as a result.

The same holds symbol by symbol — `packages/core/agent/adapter-api.ts` is itself a published subpath,
so **deleting one of its re-export lines is a breaking change for a consumer, not a tidy-up**. That
barrel's surface is now PINNED: `npm run test:adapter-api-surface` compares its export list to
`packages/core/scripts/adapter-api-surface.json` and reds on any addition or removal, so the surface
changes deliberately or not at all (OPE-1477).

🔴 **The barrel's ~360 export entries stay in the report, and that is the accepted trade.** The
obvious way to silence them is to name `agent/adapter-api.ts` as a knip entry of `packages/core` —
which is what it is. Do not: `scripts/tidy/knip-resolution-test.ts` proves that `--tsConfig` makes a
package-boundary import resolve, and it proves it with two probes that both run through this barrel
(the barrel itself, and `access/wake-mapping.ts` behind it). Declaring the barrel an entry makes both
probes unreportable in either mode, so the negative control fails and the app→core half of that gate
is gone. Measured 2026-09-08: the change reds `test:tidy-knip-resolution` with exactly those two
assertions. A stronger gate is worth more than a quieter report. Read the entries as what they are —
a published surface with no in-tree importer — and read the pin for whether one may be deleted.

### What the fix moved

Measured with `node scripts/tidy/dead-report-audit.mjs`, which re-checks every entry knip reports
against an independent import sweep. Before is the commit this fix landed on; after is
this repository with the fix, measured 2026-09-13. Re-run the auditor to refresh the after column —
these are the numbers of one tree on one day, not an invariant:

| | before | after |
| --- | --- | --- |
| unused files reported | 21 | 0 |
| of those, with an importer | 12 | 0 |
| **of those, no importer found** | **9** | **0** |
| unused exports reported | 513 | 396 |
| of those, with an importer | 135 | 33 |
| of those, used only inside their own file | 366 | 3 |
| **of those, no importer found** | **12** | **360** |

🔴 **The bold rows are the ones a reader acts on, and the export one moved UP, not down.** That is
the fix working rather than failing. Before, an export with no importer sat among 501 entries that
had one or were used locally, so the 12 were unfindable; now 360 entries are genuinely unimported
inside this repository. Unimported is still not unused — most of them are published package API, the
second blind spot above. The file row moved the other way, 9 to 0: 7 of the 9 were the
convention-loaded `contributions.ts` manifests that `knip.json` now declares as entries, and OPE-1476
withdrew `connector-op-tier.ts`, the last entry the list held.

🔴 **Read the export rows carefully — two changes move them in opposite directions.** Resolution
alone RAISES the count, because package files now enter the graph and their exports become
candidates: the earlier tree with the resolution fix and no other change reported **728** export
entries, not 513. `knip.json` then sets `ignoreExportsUsedInFile: true`, which dropped the 381
entries whose symbol is used inside its own file, leaving 347 on that tree. So the export list no
longer offers the "drop the redundant `export` keyword" cleanup at all — that class is not empty, it
is deliberately not reported. Remove the flag to see it.

The file rows carry no such caveat: 21 reported with 12 importable became 0 reported, and that is the
resolution fix plus the entry declarations plus the OPE-1476 withdrawal.

Whatever the list says, prove a candidate with a `git grep -w` sweep of your own before you delete
it — and use `git grep --untracked --no-exclude-standard`, because plain `--untracked` does not reach
the gitignored `oe build` output under `agent/tools/`, `agent/channels/` and their siblings.

## The verify invariant

A changed path that is not `.ts`, `.mts`, `.mjs` or `.js` fails the gate: nothing here can read it, so
nothing here can call it comment-only. A changed file the gate can read still fails on either of two
counts before the three checks below:

- the base carries the file and its current text is empty — a deleted file, or one truncated to
  nothing. The test is on zero bytes, so a file left holding a newline is not empty and goes on to
  the three checks;
- the two texts are byte-identical, so the change is not in the text at all — a file mode, or a new
  empty file.

Each shape empties what a check compares. A file whose every line is a comment has no tokens, so
deleting it leaves check 1 nothing to compare and every removed line is a comment line. (Deleting a
file that holds code still reds on check 1.) A byte-identical pair produces no diff hunk either, so
all three checks pass it vacuously.

For every other changed file that is one of the four, all three hold:

1. the two versions produce an identical TOKEN STREAM (comments and whitespace are trivia, so a
   comment rewrite moves no token — a changed type annotation does);
2. every line the unified diff changed is a comment line or a blank line;
3. the count of directive lines (`@ts-expect-error`, `eslint-disable`, `/// <reference`, and the
   rest of the allowlist in `scripts/tidy/comments.mjs`) is unchanged in each file.

Any failure exits non-zero and names the file. Checks 1 and 2 cover each other: the token stream
catches a change the line classifier misreads, and the diff check catches re-indentation the token
stream cannot see. Four files here hold template literals whose lines a line classifier reads as
comments; those lines are string content, and check 1 refuses to let them move.

## Phase 4 — the docs audit

Phase 1 judges a comment block. **Phase 4 judges a page under `docs/`.** Its rubric is
[`scripts/tidy/RUBRIC-P4.md`](../../scripts/tidy/RUBRIC-P4.md), beside the Phase 1 one, and the same
rule holds: the repo copy is canonical. This section is the judged inventory it produced.

**Result: 75 pages, 25,042 lines, and every page is a KEEP.** The audit deleted nothing and folded
nothing, so it touched no page any open pull request was editing.

The tree has grown since. `docs/` holds 82 tracked pages today, so the table below is a record of one
audit, not a current index — seven pages arrived after it, four of them under `docs/dev/`, and no row
names any of the seven.

🔴 **Every number here is measured on one fixed tree, and that base is load-bearing.** An audit of
`docs/` that reports on the tree containing its own report counts itself: this inventory names all 75
page paths, which lifts every inbound-link count by one, and it quotes absent identifiers, which
inflates the absent total. Re-measure against a stated base, never against the working tree.

### How each verdict was proved

Three measurements rank a page for reading. **A verdict comes from reading the page**, and the
numbers only say which pages to read first and what to check.

- **Reachability (`In`).** Tracked files outside the page that link to it. Markdown link targets are
  resolved relative to the linking file, so a `./sibling.md` counts; `agent/docs/generated/**` is
  excluded, because it mirrors `docs/` and references nothing independently. **No page scores 0, so
  there are no orphans.** Two pages score 1 — `deploy/consuming-as-packages.md` and this page —
  reachable from the `docs/README.md` index alone. That index carries 73 of the other 74 pages; the
  one it omits is `deploy/platforms/self-host-egress.md`, which ten other pages link to. The index is
  therefore not the test for reachability.
- **Identifier resolution (`Ids/absent`).** Backticked identifiers on the page — `OE_*` env vars,
  camelCase symbols, snake_case tool names — against **tracked code only**: `*.ts`, `*.tsx`,
  `*.mts`, `*.mjs`, `*.js`, `*.json`, `*.sql`. Every `.md` is out of the corpus, and so are
  `agent/docs/generated/**` and `packages/providers/*/agent/docs-generated.ts`. One reason covers
  all three: **prose mirrors prose.** The generated modules embed each page verbatim, so leaving
  them in confirms every name a page uses and scores a meaningless 0 absent — that is how the first
  sweep of this audit read 0 of 2,756. Other tracked markdown does the same job more quietly:
  `ProviderCredential`, `assertProvidersValid` and `OE_CREDENTIAL_BROKER` each sit in
  `packages/core/scripts/e2e/README-db-broker-flip.md` or `review/audits/access-identity.md` and in
  no TypeScript file at all, so a corpus that counted markdown would have called all three live.
  Against code only, **39 of 2,759 identifiers (1.4%) are absent**.
  Thirty of the 39 are absent by design — upstream `eve` symbols (`getVercelSandboxCredentials`,
  `truncateHead`), vendor API names (Graph's `unsetReaction`, Bot Framework's `BadArgument`),
  extensionless repo files the scan cannot see (`Dockerfile`), example names
  (`acme__frobnicate_widget`, the Slack id `C12345678`), and interfaces a page states are not built
  (`SCMProvider`). **The other seven are real stale symbol references**, listed below — the P4 pass first counted nine, and two of those were misfiled (see the two 🔴 notes under the table).
- **Peak overlap.** The largest share of this page's 8-grams found in any one other page, after code
  blocks and link targets are stripped. Six pairs reach 20%, all of them Roadmap platform siblings.
  The seventh-largest pair in the tree is 7.7%.

### Why the delete set is empty

- **No retired-plane page.** No page's subject is gone. Several pages describe a plane that *was*
  retired and are KEEP *because* of it: `capabilities/pr-walkthrough.md`, `extending/database.md` and
  `deploy/cloud-proof.md` each state that `.github/workflows/` was deleted and say what that
  costs now, and `extending/webhook-ingress.md` records the six-axis provisioning vocabulary that
  "once lived here". A page reporting a removal is making a live claim.
- **No dead duplicate.** The Roadmap platform pages hold the only real overlap: `gcp.md`, `azure.md`
  and `aws.md` share 56–58% of the smaller page's 8-grams pairwise, and each shares 31–33% with
  `cloudflare.md`. The shared text is the frame — "a hosting platform is a curated set of adapters",
  the fail-closed sentence. The content is the proposed per-seam adapter table, the memory-backing row
  and the "what you'd supply" checklist, none of which `deploy/hosting-overview.md` carries and each
  of which names different primitives. Each page is a KEEP.
- **The near-miss pairs were read, not scored.** `extending/connectors.md` against
  `capabilities/connectors-and-providers.md`, `deploy/hosting-overview.md` against
  `deploy/platforms/comparison.md`, `extending/surfaces.md` against
  `extending/chat-surface-contract.md`, and `introduction/core-concepts.md` against `glossary.md` are
  deliberate concept/recipe splits. Each page names its sibling in its own opening lines and divides
  the subject with it.

### The stale symbol references and path drifts — fixed (OPE-1480)

Each was a wrong name inside an otherwise-live page, so none changed a page verdict. All are
corrected. The table is kept because two of its rows are worth carrying forward.

| Page | Was written | Now says |
|---|---|---|
| `security/audit-and-provenance.md` | `query_audit` tool | `audit_query` (`agent/control/server.ts`) |
| `deploy/configuration-reference.md` | `host_html_artifact` tool | `post_file` alone — `hostHtmlArtifact` is an internal function, never a tool |
| `extending/provider-bundles.md` | `CoreCodecPlatform` | rewritten: `wake-origin-codecs.ts` registers no codec in core, so there is no union left to name |
| `extending/connectors.md`, `extending/credential-brokers.md`, `security/credentials-and-planes.md` | `ProviderCredential` | `ConnectorCredential` (`access/connector-credentials.ts`) |
| `security/credentials-and-planes.md` | `assertProvidersValid` | `assertConnectorCredentialsValid` |
| `extending/tools.md` | `packages/core/scripts/window-gate-lint.ts` | `scripts/window-gate-lint.ts` |
| `how-it-works/identity.md` | `agent/domains.ts` | `agent/memory/config/domains/<name>.ts` |

🔴 **Two rows this audit filed were NOT defects, and are left alone.** The audit counted
`OE_CREDENTIAL_BROKER` in `deploy/configuration-reference.md` and `extending/credential-brokers.md`
as stale symbol references. The name is genuinely absent from code, but both pages already say so:
each is a strikethrough or past-tense REMOVAL NOTICE telling an operator to delete the variable.
`RUBRIC-P4.md` classifies exactly that as a KEEP, and the audit's own "Actually" column conceded it
("inert — no code reads it"). So the real count was **seven references across FIVE symbols, plus the
two path drifts** — not nine. Five symbols, seven references, because `ProviderCredential` is named
on three pages; count the table rows, not the pages. A name absent from code is not by itself a stale reference; a page
that accurately records a retirement is doing its job.

🔴 **One replacement this audit proposed was WRONG.** It named `query_analytics` for `query_audit`.
`query_analytics` is an agent tool under `agent/tools/`; the sentence is about a CONTROL-PLANE read
tool, and that tool is `audit_query`. Verify a replacement against the surface the sentence is
about, not only against the tree.

### The inventory

`In` is inbound links. `Ids/absent` is backticked identifiers against tracked code only — every
`.md` out, generated modules included. `Peak overlap` is the largest 8-gram containment in any one
other page. All on that same tree.

| Page | Lines | In | Ids/absent | Peak overlap | Verdict |
|---|---:|---:|---:|---:|---|
| `docs/README.md` | 109 | 8 | 0/0 | 2% | KEEP |
| `docs/capabilities/analytics.md` | 94 | 3 | 9/0 | 0% | KEEP |
| `docs/capabilities/browser-qa.md` | 133 | 3 | 26/0 | 0% | KEEP |
| `docs/capabilities/connectors-and-providers.md` | 819 | 12 | 41/0 | 2% | KEEP |
| `docs/capabilities/memory.md` | 651 | 28 | 42/0 | 0% | KEEP |
| `docs/capabilities/pr-walkthrough.md` | 280 | 2 | 19/0 | 0% | KEEP |
| `docs/capabilities/proactivity-and-routines.md` | 1650 | 29 | 94/0 | 0% | KEEP |
| `docs/capabilities/roles.md` | 137 | 2 | 15/0 | 0% | KEEP |
| `docs/capabilities/self-documentation.md` | 85 | 3 | 1/0 | 0% | KEEP |
| `docs/capabilities/skills-and-plugins.md` | 237 | 15 | 11/0 | 0% | KEEP |
| `docs/capabilities/source-control.md` | 432 | 18 | 29/0 | 0% | KEEP |
| `docs/core-app-separation.md` | 166 | 9 | 10/0 | 1% | KEEP |
| `docs/deploy/cloud-proof.md` | 264 | 11 | 13/1 | 0% | KEEP |
| `docs/deploy/configuration-reference.md` | 1203 | 31 | 349/2 | 0% | KEEP |
| `docs/deploy/consuming-as-packages.md` | 101 | 1 | 8/1 | 0% | KEEP |
| `docs/deploy/database-graduation.md` | 178 | 4 | 8/0 | 1% | KEEP |
| `docs/deploy/hosting-overview.md` | 92 | 11 | 3/0 | 2% | KEEP |
| `docs/deploy/observability.md` | 129 | 3 | 18/0 | 0% | KEEP |
| `docs/deploy/platforms/aws.md` | 35 | 3 | 1/0 | 55% | KEEP |
| `docs/deploy/platforms/azure.md` | 35 | 3 | 0/0 | 57% | KEEP |
| `docs/deploy/platforms/cloudflare.md` | 38 | 3 | 4/0 | 25% | KEEP |
| `docs/deploy/platforms/comparison.md` | 309 | 6 | 15/4 | 1% | KEEP |
| `docs/deploy/platforms/gcp.md` | 35 | 3 | 0/0 | 58% | KEEP |
| `docs/deploy/platforms/self-host-egress.md` | 133 | 11 | 10/0 | 0% | KEEP |
| `docs/deploy/platforms/self-roll.md` | 61 | 5 | 13/1 | 4% | KEEP |
| `docs/deploy/platforms/vercel.md` | 93 | 10 | 3/0 | 1% | KEEP |
| `docs/deploy/rollback.md` | 452 | 7 | 32/0 | 0% | KEEP |
| `docs/deploy/self-upgrade-release-records.md` | 137 | 2 | 9/0 | 0% | KEEP |
| `docs/deploy/setup-runbook.md` | 315 | 15 | 31/0 | 1% | KEEP |
| `docs/deploy/surfaces/discord.md` | 368 | 8 | 30/1 | 8% | KEEP |
| `docs/deploy/surfaces/github.md` | 221 | 5 | 39/0 | 3% | KEEP |
| `docs/deploy/surfaces/linear.md` | 442 | 9 | 65/1 | 2% | KEEP |
| `docs/deploy/surfaces/notion.md` | 327 | 9 | 42/0 | 1% | KEEP |
| `docs/deploy/surfaces/slack.md` | 525 | 11 | 49/1 | 6% | KEEP |
| `docs/deploy/surfaces/support-matrix.md` | 218 | 11 | 25/0 | 3% | KEEP |
| `docs/deploy/surfaces/teams.md` | 365 | 8 | 41/4 | 3% | KEEP |
| `docs/deploy/telemetry.md` | 208 | 9 | 70/0 | 2% | KEEP |
| `docs/dev/tidy.md` | 71 | 1 | 8/0 | 0% | KEEP |
| `docs/extending/adapter-model.md` | 265 | 25 | 19/0 | 2% | KEEP |
| `docs/extending/chat-surface-contract.md` | 1141 | 6 | 105/3 | 0% | KEEP |
| `docs/extending/connectors.md` | 93 | 8 | 7/1 | 4% | KEEP |
| `docs/extending/credential-brokers.md` | 154 | 17 | 14/2 | 1% | KEEP |
| `docs/extending/database.md` | 353 | 18 | 52/1 | 0% | KEEP |
| `docs/extending/drop-in-arms.md` | 624 | 3 | 65/2 | 1% | KEEP |
| `docs/extending/memory-backings.md` | 187 | 10 | 22/0 | 1% | KEEP |
| `docs/extending/models-and-gateway.md` | 338 | 12 | 23/0 | 1% | KEEP |
| `docs/extending/provider-bundles.md` | 451 | 12 | 61/1 | 0% | KEEP |
| `docs/extending/provider-rate-limits.md` | 544 | 10 | 118/3 | 0% | KEEP |
| `docs/extending/sandbox.md` | 190 | 11 | 15/0 | 2% | KEEP |
| `docs/extending/scheduler-and-identity.md` | 61 | 10 | 3/0 | 0% | KEEP |
| `docs/extending/source-control-backends.md` | 79 | 5 | 12/2 | 1% | KEEP |
| `docs/extending/surfaces.md` | 74 | 17 | 7/0 | 2% | KEEP |
| `docs/extending/testing.md` | 345 | 4 | 41/0 | 0% | KEEP |
| `docs/extending/tools.md` | 332 | 5 | 18/0 | 0% | KEEP |
| `docs/extending/webhook-ingress.md` | 768 | 9 | 58/3 | 1% | KEEP |
| `docs/glossary.md` | 925 | 8 | 205/1 | 1% | KEEP |
| `docs/how-it-works/access-and-scoping.md` | 709 | 38 | 62/0 | 2% | KEEP |
| `docs/how-it-works/access-requests.md` | 208 | 7 | 15/0 | 0% | KEEP |
| `docs/how-it-works/agent-and-loop.md` | 824 | 16 | 54/0 | 1% | KEEP |
| `docs/how-it-works/config-as-code.md` | 269 | 17 | 20/1 | 1% | KEEP |
| `docs/how-it-works/identity.md` | 1229 | 19 | 92/0 | 0% | KEEP |
| `docs/how-it-works/pre-approval-rules.md` | 180 | 2 | 8/0 | 1% | KEEP |
| `docs/introduction/built-on-eve.md` | 65 | 3 | 5/0 | 0% | KEEP |
| `docs/introduction/core-concepts.md` | 134 | 9 | 15/0 | 2% | KEEP |
| `docs/introduction/quick-start.md` | 155 | 7 | 4/0 | 1% | KEEP |
| `docs/introduction/what-is-open-everywhere.md` | 78 | 2 | 3/0 | 3% | KEEP |
| `docs/security/audit-and-provenance.md` | 136 | 19 | 53/1 | 0% | KEEP |
| `docs/security/control-plane.md` | 964 | 27 | 133/0 | 1% | KEEP |
| `docs/security/credentials-and-planes.md` | 282 | 21 | 63/2 | 2% | KEEP |
| `docs/security/honesty-ledger.md` | 129 | 2 | 3/0 | 0% | KEEP |
| `docs/security/permission-homeostasis.md` | 88 | 5 | 14/0 | 1% | KEEP |
| `docs/security/revocation-latency.md` | 214 | 7 | 18/0 | 3% | KEEP |
| `docs/security/security-model.md` | 547 | 32 | 78/0 | 0% | KEEP |
| `docs/security/self-upgrade-fence.md` | 322 | 8 | 10/0 | 0% | KEEP |
| `docs/security/spend-and-cost.md` | 437 | 9 | 81/0 | 1% | KEEP |
| **75 pages** | **25,042** | min 1 | **2,759/39** | max 58% | **all KEEP** |
