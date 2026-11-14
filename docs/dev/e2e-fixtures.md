# The e2e fixture inventory

The rooms the e2e pack drives, with their live names. They live in three places — the `E2E_*` room
vars in `packages/core/scripts/e2e/env.ts`, the surface keys in `agent/memory/config/domains/`,
and the surface-scoped bindings in `agent/access/bundles.ts` — and none of the three carries a
name. This file does.

The two config sources are read in full, so a room added to a domain or a binding appears here the
next time this file is written. The `env.ts` side is a MAINTAINED list (`ROOM_VARS`): a name does
not say whether it holds a channel or a token, so the partition is declared, and a unit test refuses
a new entry in `env.ts`'s `ENV` registry that is neither a room nor a reasoned exemption.

**This file is generated. Do not edit it.** Write it with
`npm run e2e:fixtures -- inventory` from `packages/core`, which resolves every id through its
vendor, then run `npm run docs:generate` from the repo root — the `docs/` tree is compiled into
the shipped manual, so the two commits together. `-- inventory --check` compares the committed
rows against a fresh resolution and exits non-zero when a room this run can see has changed,
arrived or gone. It compares ROWS rather than text, so an operator holding part of the fixture set
is not told the file is stale over rooms their credentials never named. The check calls six
vendors, so the `test` chain's rung (`npm run lint:e2e-fixtures`) is inert unless
`E2E_FIXTURE_TABLE_CHECK=1`. Armed, it gates: a stale table fails the `test` chain.

A write REFUSES twice over, because a wrong name here is the defect this file exists to remove:
when a surface has no driver credential at all, and when a room that already carries a name in this
file does not resolve for the running credential. The second case is the sharper one — a token can
be valid for Slack and still miss a private channel its user is not in. Both refusals name what
they saw; `--partial` overrides them when the rooms are genuinely gone.

**A Teams row carries a name and an env var, never the key.** A Teams surface key holds the
operator's Microsoft 365 tenant id, so the id lives in the environment and this table redacts it.
That is a choice about what this table is FOR, not a prohibition: a tenant id is a tracked literal
by ruling, and no gate refuses one. A Teams row gives the reader the room's name and the variable
that carries its id, which is what the rest of this file gives every other row.

**A room id can live in Git rather than in an environment.** `TRACKED_ROOM_IDS` in
`fixture-inventory-lib.ts` carries the id itself for such a room, and the pack reads it whenever the
`E2E_*` variable is unset — the variable stays an override. A room id is a TRACKED literal by
ruling, so this is where one belongs; a room that lives only in an environment is one nobody can
provision, and J-MPIM skipped on five ships for exactly that reason. Those rows say so in their note.

**A room can need a credential of its own.** A `PlannedRoom` may declare `credentialVar`, and the
Linear addressed-only team does: it lives in a second Linear workspace, and a Linear personal API key
never reads outside the workspace it was minted in, so `E2E_LINEAR_API_KEY` cannot see it. Its key is
`E2E_ADDRESSED_LINEAR_API_KEY`. Unset, that room is SKIPPED by name — the provisioner never reds over
an absent credential, and never writes a value nobody gave it.

Column meanings: **id** is the vendor's own id (`owner/repo` on GitHub, empty on Teams). **name**
is what the vendor calls the room today, except for a DM and a group DM: this table prints
`(direct message)` and `(group DM)` there, because Slack names a group DM after the PEOPLE in it
and this file is tracked in a source-open repository. The id column still identifies the room.
**env var** is the `E2E_*` name that carries the id;
`—` means the pack drives the room through config alone. **claimed by** names the memory domains
and access bundles whose ROSTER spells the room; `unclaimed` means no roster does, so the room
resolves through the criteria domains (`org`, `dm`, `public`) instead.

## Slack

| id | name | env var | claimed by | note |
| --- | --- | --- | --- | --- |
| `C0EXCHAN001` | #watercooler | — | e2e-solo | — |
| `C0EXCHAN002` | #watercooler2 | — | e2e-solo | — |
| `C0EXCHAN003` | #watercooler3 | `E2E_SLACK_CHANNEL`<br>`E2E_SLACK_UNIFIED_CHANNEL_A` | e2e-unified | — |
| `C0EXCHAN004` | #oe-e2e-private | `E2E_SLACK_PRIVATE_CHANNEL` | unclaimed | — |
| `C0EXCHAN005` | #oe-e2e-b | `E2E_SLACK_CHANNEL_B` | e2e-b | — |
| `C0EXCHAN006` | #oe-e2e-supervisor | `E2E_SLACK_SUPERVISOR_CHANNEL` | e2e-supervisor | — |
| `C0EXCHAN007` | #oe-e2e-cap | `E2E_SLACK_CAP_CHANNEL` | e2e-cap | — |
| `C0EXCHAN008` | #oe-soak-dev | `E2E_SLACK_SOAK_CHANNEL_DEV` | soak | — |
| `C0EXCHAN009` | #oe-soak-ops | `E2E_SLACK_SOAK_CHANNEL_OPS` | soak | — |
| `C0EXCHAN010` | (group DM) | `E2E_SLACK_MPIM_CHANNEL` | unclaimed | id from this repository (`TRACKED_ROOM_IDS.E2E_SLACK_MPIM_CHANNEL`), not from the environment; unclaimed by design — a group DM takes no memory and no criteria layer whatever a roster says — `resolveMemoryPlan` answers NONE for mode "mpim" and `domainMatchFor` returns undefined, so the flag's "resolves through the criteria domains" remedy does not apply here |
| `C0EXCHAN011` | #oe-e2e-halt | `E2E_SLACK_HALT_CHANNEL` | unclaimed | id from this repository (`TRACKED_ROOM_IDS.E2E_SLACK_HALT_CHANNEL`), not from the environment |
| `C0EXGENRL` | #general | `E2E_NOTION_CHANNEL` | e2e-connector | — |
| `C0EXRANDM` | #random | `E2E_SLACK_UNIFIED_CHANNEL_B` | e2e-unified | — |
| `D0EXDMCH001` | (direct message — `conversations.info` needs `im:read`) | `E2E_SLACK_DM_CHANNEL` | unclaimed | — |

## Discord

| id | name | env var | claimed by | note |
| --- | --- | --- | --- | --- |
| `1300000000000000101` | #general | `E2E_DISCORD_CHANNEL` | e2e-unified | — |
| `1300000001500000001` | (fabricated id) | — | it-memory | synthetic — an integration-tier fixture id, never a live room |
| `1300000001500000002` | (fabricated id) | — | it-memory-b | synthetic — an integration-tier fixture id, never a live room |
| `1300000001500000003` | (fabricated id) | — | it-memory | synthetic — an integration-tier fixture id, never a live room |
| `1300000001500000004` | (fabricated id) | — | it-notion-withhold | synthetic — an integration-tier fixture id, never a live room |
| `1300000001500000005` | (fabricated id) | — | it-memory | synthetic — an integration-tier fixture id, never a live room |
| `1300000001500000006` | (fabricated id) | — | it-judge-lift-github | synthetic — an integration-tier fixture id, never a live room |
| `1300000001500000007` | (fabricated id) | — | it-memory | synthetic — an integration-tier fixture id, never a live room |
| `1300000001500000009` | (fabricated id) | — | it-work-read-fixture-discord | synthetic — an integration-tier fixture id, never a live room |
| `1300000001500000011` | (fabricated id) | — | it-memory | synthetic — an integration-tier fixture id, never a live room |
| `1300000000000000102` | #oe-e2e-addressed-discord | `E2E_ADDRESSED_DISCORD_CHANNEL` | e2e-engaged | — |

## Microsoft Teams

| id | name | env var | claimed by | note |
| --- | --- | --- | --- | --- |
| — | oe-e2e-addressed-teams | `E2E_ADDRESSED_TEAMS_SURFACE` | unclaimed | unclaimed by design — no explicit domain holds it — it falls to the `org` criteria domain, which declares `ambientSupervisor: false` in this deployment, and that addressed-only posture is the one J-ENGAGED-teams drives |
| — | General | `E2E_TEAMS_CHANNEL_ID` | e2e-unified | — |
| — | Open Everywhere | `E2E_TEAMS_TEAM_ID` | unclaimed | unclaimed by design — a TEAM, not a room — a domain names channels, never the team above them |
| — | (fabricated id) | — | it-work-read-fixture-teams | synthetic — an integration-tier fixture id, never a live room |

## GitHub

| id | name | env var | claimed by | note |
| --- | --- | --- | --- | --- |
| `oe-it-judge-lift/arm-a` | (fabricated id) | — | it-judge-lift-github | synthetic — an integration-tier fixture id, never a live room |
| `oe-it-judge-lift/arm-b` | (fabricated id) | — | it-judge-lift-github | synthetic — an integration-tier fixture id, never a live room |
| `example-owner/e2e-scratch` | example-owner/e2e-scratch | `E2E_GITHUB_REPO`<br>`E2E_PR_REPO` | e2e-unified | — |
| `example-owner/soak-scratch` | example-owner/soak-scratch | `E2E_GITHUB_SOAK_REPO` | soak | — |
| `example-owner/oe-e2e-addressed-github` | example-owner/oe-e2e-addressed-github | `E2E_ADDRESSED_GITHUB_REPO` | e2e-engaged | id from this repository (`TRACKED_ROOM_IDS.E2E_ADDRESSED_GITHUB_REPO`), not from the environment |
| `example-owner/ungranted-repo` | — | `E2E_PR_UNGRANTED_REPO` | unclaimed | never probed — the refusal happens before any remote touch, so the driver PAT is not meant to reach this repo; unclaimed by design — S-PR-BOUNDARY proves the grant check REFUSES this repo, so no domain may claim it |

## Linear

| id | name | env var | claimed by | note |
| --- | --- | --- | --- | --- |
| `1a000000-0000-4000-8000-000000000011` | base e2e workspace (E2E) | `E2E_LINEAR_TEAM_ID` | e2e-unified | — |
| `1a000000-0000-4000-8000-000000000012` | Addressed (E2E) | `E2E_ADDRESSED_LINEAR_TEAM_ID` | e2e-engaged | id from this repository (`TRACKED_ROOM_IDS.E2E_ADDRESSED_LINEAR_TEAM_ID`), not from the environment |
| `1a000000-0000-4000-8000-000000000013` | Soak (SOAK) | `E2E_SOAK_LINEAR_TEAM_ID` | soak | — |
| `oe-deploy-smoke-*` | — | — | e2e-linear-signed-delivery | container claim — a same-level glob, not one room |

## Notion

| id | name | env var | claimed by | note |
| --- | --- | --- | --- | --- |
| `40000000-0000-4000-8000-000000000101` | Test | `E2E_NOTION_PAGE_ID` | e2e-unified | — |
| `40000000-0000-4000-8000-000000000102` | Metrics Export Spec (Soak Spec v1) | `E2E_NOTION_SOAK_PAGE_1` | soak | — |
| `40000000-0000-4000-8000-000000000103` | Soak Notes Page | `E2E_NOTION_SOAK_PAGE_2` | soak | — |
| `40000000-0000-4000-8000-000000000104` | oe-e2e-addressed-notion | `E2E_ADDRESSED_NOTION_PAGE_ID` | e2e-engaged | — |
| `40000000-0000-4000-8000-000000000105` | Own-account fixture | `E2E_NOTION_OWN_ACCOUNT_PAGE_ID` | e2e-unified | id from this repository (`TRACKED_ROOM_IDS.E2E_NOTION_OWN_ACCOUNT_PAGE_ID`), not from the environment |
| `6f7ea678-0000-4000-8000-000000000002` | (fabricated id) | — | it-notion-withhold | synthetic — an integration-tier fixture id, never a live room |
| `6f7ea678-0000-4000-8000-000000000003` | (fabricated id) | — | it-notion-withhold | synthetic — an integration-tier fixture id, never a live room |
| `6f7ea678-1071-4000-8000-000000000002` | (fabricated id) | — | it-work-read-fixture-notion | synthetic — an integration-tier fixture id, never a live room |

## Flags

### In an env var, in no domain (3)

- **Slack `C0EXCHAN004`** — E2E_SLACK_PRIVATE_CHANNEL names it, but no domain roster does — it resolves through the criteria domains (`org`, `dm`, `public`) instead
- **Slack `C0EXCHAN011`** — E2E_SLACK_HALT_CHANNEL names it, but no domain roster does — it resolves through the criteria domains (`org`, `dm`, `public`) instead
- **Slack `D0EXDMCH001`** — E2E_SLACK_DM_CHANNEL names it, but no domain roster does — it resolves through the criteria domains (`org`, `dm`, `public`) instead

## What this table does not prove

- **Membership, permission and grant are out of scope.** A row proves the room exists and is
  reachable by the credential the run held. It does not prove the OE bot is in it, that a bundle
  grants anything on it, or that its domain has the posture a scenario needs.
- **A `?` name is two different things.** With a credential for that surface it means the id did
  not resolve, and the row carries the vendor's own reason. Without one it means nobody looked.
  The note says which.
- **Synthetic rooms are never probed.** The integration tier declares domains over fabricated ids;
  those rows say so and carry no name.

## A room's domain decides its lane

The board runs two legs at once only when the seats and fixtures they declare do not overlap
(`packages/core/scripts/e2e/lanes.ts`, OPE-2364). A seat follows the domain: every room in
`e2e-unified` shares one seat, and each `e2e-engaged` room is its own seat. When a room moves to
another domain, update the rows of the legs that drive it in the same pull request. A row that
names too few seats lets two legs crowd one seat, and both legs then go red for a reason that is
not the product's.
