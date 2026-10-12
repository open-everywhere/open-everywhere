# Behaviour inventory — the `surfaces-and-seats` plane

This page enumerates what the CODE does on the surfaces-and-seats plane, and says which docs page
documents each behaviour. It is a worklist for the documentation, not a specification. The
specification is the code it cites, and the contract pages it points at.

Built from `main` on 2026-09-13. It covers 346 code behaviours, the 39-row surface-parity
contract, the 39-seam provider registration matrix, and the 54-scenario e2e roster.

## How to read a row

| Column | What it means |
|---|---|
| **ID** | A stable id. Cite it in a ticket or a docs pull request. |
| **Behaviour** | One sentence, in the house style. For an UNDOCUMENTED row this sentence IS the paste-ready sentence: paste it with the Code cell as its citation. |
| **Code** | The symbol that implements the behaviour, and its file and line. |
| **Documented by** | `docs/<page>#<anchor>`, or **UNDOCUMENTED**. |
| **Tested by** | What the row DECLARES about its own testing — never the coverage answer. Two values only: `?` (nothing declared) and `n/a: <reason>` (the row is out of scope, and why). The e2e ids this column used to carry by hand are now `proves` fields on the scenarios themselves, and `npm run coverage-board` derives the answer from them; see [the coverage matrix](../dev/coverage-matrix.md). |

## How the rows were built, and what the columns are worth

**The rows come from the code, never from a docs page.** Each source file on the plane was read and
each distinct decision or guarantee it makes became one row. Every citation is then checked by
machine: the named symbol must appear on the cited line. All 338 rows passed that check at the base
sha above. A line number moves as soon as an edit lands above the declaration, so re-run the check
against the sha you read. The symbol name, not the line, is the durable half of a citation.

**Where a machine-readable roster exists, the rows are generated from it rather than typed.** Three
rosters carry this plane, and a later lint can re-derive these sections from them:

- `SURFACE_CAPABILITIES` in `packages/core/agent/identity/surface-parity.ts` — section A.1. Each
  entry carries an `id`, a `label` and a `section` pointer such as `§4.1`. The generator resolves
  that pointer against the headings of `docs/extending/chat-surface-contract.md`, so the
  `Documented by` column for section A.1 is derived, not judged.
- The six bundles' `register<X>Provider()` functions — section A.2. The generator reads every
  `register*(` call inside each function body and pivots it into a six-column matrix.
- `SCENARIOS` in `packages/core/scripts/e2e/scenarios.ts` — section G, and the `Tested by` column.

**`Documented by` is evidence, and here is exactly what counts as evidence.** A row is documented
when one of these holds:

1. a docs line under a heading names the row's code SYMBOL. This arm is mechanical and a lint
   can re-run it;
2. a docs line names the dotted AUDIT ACTION the behaviour writes (`reply.post`,
   `routine.skip`) or the REFUSAL REASON it records (`no-edit-arm`, `answered-this-turn`). Such a
   cell is marked *names the reason, not the rule*: the page proves the row exists in the log, and
   says nothing about the decision that wrote it. Treat it as half documented.
   `docs/security/audit-and-provenance.md` is searched first, because that is an action string's
   proper home;
3. the run read the owning docs section and found the behaviour stated in prose. This arm is a
   human judgement and it is NOT re-derivable, so no count is claimed for it and no cell is marked
   with it.

**Every row on this page now cites a page and an anchor.** The rows this page once marked
`UNDOCUMENTED` were documented by reading the code each row cites and writing what it DOES on the
manual page that owns the area. Those cells carry a `docs/<page>#<anchor>` cell rather than a
markdown link, and the anchor is the section that states the behaviour.

🔴 **A cited anchor is a claim about one section, not about the whole page.** The citation says the
named section states this behaviour; it does not say the section is the only place the behaviour is
described, nor that every sentence of the section is about this row. Read the row's `Code` cell as
the specification, and the anchor as where the manual explains it. A citation goes stale the moment
either side moves, so re-check the symbol, not the line number.

Counts: 338 rows, 338 documented, 0 UNDOCUMENTED.

## A.1 The surface-parity contract — 38 capabilities, six surfaces

Generated from `SURFACE_CAPABILITIES`. Every row here is documented **by construction**: the three
tables in the contract's §7.1, §7.1.1 and §7.2 are rendered from these same declarations by
`npx tsx scripts/surface-parity.ts`, and `npm run lint:surface-parity` reds on an unanswered row
or an `unsupported` with no reason. The `Surfaces` column is the tally of the generated table.

**`Tested by` no longer holds a coverage claim, and that is the point.** It used to carry two
vocabularies by hand — a live e2e leg id (`J1`, `S24`, `J-ENGAGED-slack`) and a `npm run …` name —
and nothing ever checked one, so a deleted test left the page claiming it forever. Every one of
those ids now lives as a `proves` declaration on the leg itself, and `npm run coverage-board`
derives the answer from those declarations. The column carries only `?` or `n/a: <reason>`. The
distinction the old vocabularies drew still holds and the board still reports it: a live e2e leg
says a real deployment drives the row, while a deterministic suite proves the wiring and never the
vendor's behaviour. See [the coverage matrix](../dev/coverage-matrix.md).

| ID | Capability | Group | Roster line | Surfaces | Documented by | Tested by |
|---|---|---|---|---|---|---|
| `PAR-identity-mapper` | Identity mapper | seam | `packages/core/agent/identity/surface-parity.ts:38` | all 6 | [contract §2.1](../extending/chat-surface-contract.md#21-the-binding--who-and-where) | ? |
| `PAR-capability-manifest` | Capability manifest | seam | `packages/core/agent/identity/surface-parity.ts:39` | all 6 | [contract §2.4](../extending/chat-surface-contract.md#24-the-capability-manifest--what-this-surface-honours) | ? |
| `PAR-post-arm` | Post arm | seam | `packages/core/agent/identity/surface-parity.ts:40` | all 6 | [contract §4.1](../extending/chat-surface-contract.md#41-reply--put-a-message-in-the-room) | ? |
| `PAR-wake-origin-codec` | Wake-origin codec | seam | `packages/core/agent/identity/surface-parity.ts:41` | all 6 | [contract §2.3](../extending/chat-surface-contract.md#23-the-stored-origin--how-the-answer-gets-back) | ? |
| `PAR-read-adapter` | Read adapter | seam | `packages/core/agent/identity/surface-parity.ts:51` | all 6 | [contract §4.5](../extending/chat-surface-contract.md#45-read_channel-read-this-room) | ? |
| `PAR-reaction-feedback-ingest` | Reaction **feedback** ingest | seam | `packages/core/agent/identity/surface-parity.ts:52` | 5/6 — not notion | [contract §4.9](../extending/chat-surface-contract.md#49-ack--the-hosts-own-signals) | ? |
| `PAR-ancillary-ops` | Ancillary ops (`SurfaceMessageOps`) | seam | `packages/core/agent/identity/surface-parity.ts:53` | all 6 | [contract §4.9](../extending/chat-surface-contract.md#49-ack--the-hosts-own-signals) | ? |
| `PAR-ambient-engagement-seam` | **Ambient engagement seam** | seam | `packages/core/agent/identity/surface-parity.ts:54` | all 6 | [contract §2.5](../extending/chat-surface-contract.md#25-the-ambient-engagement-seam--optional-and-its-absence-is-visible) | ? |
| `PAR-owned-thread-ingress` | **Owned-thread ingress divert** | seam | `packages/core/agent/identity/surface-parity.ts:72` | all 6 | [contract §2.6](../extending/chat-surface-contract.md#26-the-owned-thread-ingress-divert--who-hears-a-threads-follow-up) | ? |
| `PAR-seat-catch-up` | **Seat catch-up read** (since last wake) | seam | `packages/core/agent/identity/surface-parity.ts:80` | all 6 | [contract §2.5](../extending/chat-surface-contract.md#25-the-ambient-engagement-seam--optional-and-its-absence-is-visible) | ? |
| `PAR-origin-placement-carry` | **Wake-origin placement carry** (`placementRef`/`carryPlacement`) | seam | `packages/core/agent/identity/surface-parity.ts:50` | 2/6 — not teams, github, linear, notion | [contract §2.3](../extending/chat-surface-contract.md#23-the-stored-origin--how-the-answer-gets-back) | ? |
| `PAR-engaged-row-promotion` | **Engaged wake row promotion** (`thread-follow`) | seam | `packages/core/agent/identity/surface-parity.ts:64` | 3/6 — not slack, discord, teams | [contract §2.5](../extending/chat-surface-contract.md#25-the-ambient-engagement-seam--optional-and-its-absence-is-visible) | ? |
| `PAR-seat-context-admission` | **Seat context-line admission** (`admitContextLines`) | seam | `packages/core/agent/identity/surface-parity.ts:91` | 4/6 — not teams, notion | [contract §2.5](../extending/chat-surface-contract.md#25-the-ambient-engagement-seam--optional-and-its-absence-is-visible) | ? |
| `PAR-approval-card` | **Approval card** (tappable Approve/Reject) | seam | `packages/core/agent/identity/surface-parity.ts:108` | 2/6 — not teams, github, linear, notion | [contract §4.1](../extending/chat-surface-contract.md#41-reply--put-a-message-in-the-room) | ? |
| `PAR-judge-lift-notice` | **Judge-lift notice** (a lifted act leaves a trace) | seam | `packages/core/agent/identity/surface-parity.ts:119` | all 6 | [contract §4.1](../extending/chat-surface-contract.md#41-reply--put-a-message-in-the-room) | ? |
| `PAR-addressed-leg` | Addressed (@mention) leg | shape | `packages/core/agent/identity/surface-parity.ts:121` | all 6 | [contract §2.2](../extending/chat-surface-contract.md#22-the-addressing--which-container-this-turn-arrived-in) | ? |
| `PAR-ambient-leg` | Ambient (non-mention) leg | shape | `packages/core/agent/identity/surface-parity.ts:122` | all 6 | [contract §2.5](../extending/chat-surface-contract.md#25-the-ambient-engagement-seam--optional-and-its-absence-is-visible) | ? |
| `PAR-name-drop-mention` | Name-drop / structured mention | shape | `packages/core/agent/identity/surface-parity.ts:123` | 3/6 — not teams, github, linear | [contract §2.5](../extending/chat-surface-contract.md#25-the-ambient-engagement-seam--optional-and-its-absence-is-visible) | ? |
| `PAR-message-edit-wake` | Message-EDIT wake | shape | `packages/core/agent/identity/surface-parity.ts:129` | 1/6 — not discord, teams, github, linear, notion | [contract §2.5](../extending/chat-surface-contract.md#25-the-ambient-engagement-seam--optional-and-its-absence-is-visible) | ? |
| `PAR-threads` | Threads | shape | `packages/core/agent/identity/surface-parity.ts:130` | all 6 | [contract §4.6](../extending/chat-surface-contract.md#46-read_thread-read-this-thread) | ? |
| `PAR-rooms` | Standing rooms *(not §4.5's `read_channel` container)* | shape | `packages/core/agent/identity/surface-parity.ts:136` | 3/6 — not github, linear, notion | [contract §4.7.1](../extending/chat-surface-contract.md#471-post_message-the-deliberate-cross-container-exception-tier-p1) | n/a: unannotated — lane F |
| `PAR-dm` | DM (`dm`) | shape | `packages/core/agent/identity/surface-parity.ts:137` | 3/6 — not github, linear, notion | [contract §4.7.2](../extending/chat-surface-contract.md#472-dm_person-the-deliberate-cross-audience-exception-tier-p2) | ? |
| `PAR-mpim` | Group DM (`mpim`) | shape | `packages/core/agent/identity/surface-parity.ts:138` | 3/6 — not github, linear, notion | [contract §4.7.2](../extending/chat-surface-contract.md#472-dm_person-the-deliberate-cross-audience-exception-tier-p2) | ? |
| `PAR-reply` | `reply` | verb | `packages/core/agent/identity/surface-parity.ts:140` | all 6 | [contract §4.1](../extending/chat-surface-contract.md#41-reply--put-a-message-in-the-room) | ? |
| `PAR-edit_reply` | `edit_reply` | verb | `packages/core/agent/identity/surface-parity.ts:141` | all 6 | [contract §4.2](../extending/chat-surface-contract.md#42-edit_reply-correct-one-of-your-own-posts) | n/a: unannotated — lane F |
| `PAR-react` | `react` | verb | `packages/core/agent/identity/surface-parity.ts:142` | 4/6 — not teams, notion | [contract §4.3](../extending/chat-surface-contract.md#43-react--leave-an-emoji) | ? |
| `PAR-no_reply` | `no_reply` | verb | `packages/core/agent/identity/surface-parity.ts:143` | all 6 | [contract §4.4](../extending/chat-surface-contract.md#44-no_reply-decline-to-answer) | ? |
| `PAR-read_channel` | `read_channel` | verb | `packages/core/agent/identity/surface-parity.ts:144` | all 6 | [contract §4.5](../extending/chat-surface-contract.md#45-read_channel-read-this-room) | ? |
| `PAR-read_thread` | `read_thread` | verb | `packages/core/agent/identity/surface-parity.ts:145` | all 6 | [contract §4.6](../extending/chat-surface-contract.md#46-read_thread-read-this-thread) | n/a: unannotated — lane F |
| `PAR-search` | `search` | verb | `packages/core/agent/identity/surface-parity.ts:146` | 3/6 — not slack, discord, teams | [contract §4.7](../extending/chat-surface-contract.md#47-search--the-deliberate-cross-container-exception) | ? |
| `PAR-post_message` | `post_message` (P1) | verb | `packages/core/agent/identity/surface-parity.ts:147` | 3/6 — not github, linear, notion | [contract §4.7.1](../extending/chat-surface-contract.md#471-post_message-the-deliberate-cross-container-exception-tier-p1) | n/a: unannotated — lane F |
| `PAR-dm_person` | `dm_person` (P2) | verb | `packages/core/agent/identity/surface-parity.ts:148` | 3/6 — not github, linear, notion | [contract §4.7.2](../extending/chat-surface-contract.md#472-dm_person-the-deliberate-cross-audience-exception-tier-p2) | n/a: unannotated — lane F |
| `PAR-set_dm_delivery` | `set_dm_delivery` (P2, recipient) | verb | `packages/core/agent/identity/surface-parity.ts:149` | 3/6 — not github, linear, notion | [contract §4.7.2](../extending/chat-surface-contract.md#472-dm_person-the-deliberate-cross-audience-exception-tier-p2) | n/a: unannotated — lane F |
| `PAR-stop` | `stop` (human) | verb | `packages/core/agent/identity/surface-parity.ts:150` | all 6 | [contract §4.8](../extending/chat-surface-contract.md#48-stop--the-humans-cancel) | ? |
| `PAR-ack_stop_glyph` | `ack`: ✋ glyph | verb | `packages/core/agent/identity/surface-parity.ts:151` | 3/6 — not teams, github, notion | [contract §4.9](../extending/chat-surface-contract.md#49-ack--the-hosts-own-signals) | n/a: unannotated — lane F |
| `PAR-ack_cancel_note` | `ack`: cancel note | verb | `packages/core/agent/identity/surface-parity.ts:152` | all 6 | [contract §4.9](../extending/chat-surface-contract.md#49-ack--the-hosts-own-signals) | n/a: unannotated — lane F |
| `PAR-stand_down` | `stand_down` | verb | `packages/core/agent/identity/surface-parity.ts:153` | all 6 | [contract §4.10](../extending/chat-surface-contract.md#410-stand_down-stop-following-this-conversation) | ? |
| `PAR-post_file` | `post_file` | verb | `packages/core/agent/identity/surface-parity.ts:154` | 3/6 — not teams, github, linear | [contract §7.4](../extending/chat-surface-contract.md#74-the-file-attach-finding-stated-plainly) | ? |


## A.2 The registration-seam matrix — what each bundle actually wires

Read from every `register*(` call inside each bundle's `register<X>Provider()`. Nine seams are
universal. The parity roster in A.1 names fifteen seam capabilities, so the seams below that it does
not name are wired with no cross-surface ledger stating who has them. `registerCardPoster` left that
set in OPE-1838: `PAR-approval-card` now states each surface's position, and `lint:surface-parity`
cross-checks it against `hasApprovalCardPath` — the predicate the propose sites themselves read.
`registerJudgeLiftNoticePoster` left it in OPE-1854 the same way, and the row it gained asks a
DIFFERENT question from the one above it. A registered poster is the BUTTON arm of the judge-lift
notice, not the whole road: `postJudgeLiftNotice` (`packages/core/agent/approvals/flow.ts`) picks a
registered poster, Slack's built-in Block Kit render, or the shared plain-text render on the
surface's own `SurfaceMessageOps` transport. So the seam stays 1/6 while `PAR-judge-lift-notice` is
all 6 — the bundles that register no poster still get the notice, in words.

| Seam | Bundles | Absent from | Example call |
|---|---|---|---|
| `registerCapabilityManifest` | 6/6 | — | `packages/providers/slack/agent/register.ts:79` |
| `registerIdentityMapper` | 6/6 | — | `packages/providers/slack/agent/register.ts:74` |
| `registerPostArm` | 6/6 | — | `packages/providers/slack/agent/register.ts:89` |
| `registerProviderDocs` | 6/6 | — | `packages/providers/slack/agent/register.ts:141` |
| `registerProviderEvents` | 6/6 | — | `packages/providers/slack/agent/register.ts:88` |
| `registerReadAdapter` | 6/6 | — | `packages/providers/slack/agent/register.ts:91` |
| `registerSeatCatchUp` | 6/6 | — | `packages/providers/slack/agent/register.ts:96` |
| `registerSurfaceParity` | 6/6 | — | `packages/providers/slack/agent/register.ts:83` |
| `registerWakeOriginCodec` | 6/6 | — | `packages/providers/slack/agent/register.ts:90` |
| `registerReactionSurface` | 5/6 | notion | `packages/providers/slack/agent/register.ts:97` |
| `registerSurfaceMessageOps` | 5/6 | slack | `packages/providers/discord/agent/register.ts:95` |
| `registerAccountDirectory` | 3/6 | github,linear,notion | `packages/providers/slack/agent/register.ts:112` |
| `registerBotDisplayName` | 3/6 | github,linear,notion | `packages/providers/slack/agent/register.ts:102` |
| `registerWebhookVerifier` | 3/6 | discord,teams,linear | `packages/providers/slack/agent/register.ts:137` |
| `registerEventNormalizer` | 2/6 | slack,discord,teams,github | `packages/providers/linear/agent/register.ts:126` |
| `registerEventScopeGrant` | 2/6 | slack,discord,teams,github | `packages/providers/linear/agent/register.ts:127` |
| `registerRoutineDispatch` | 2/6 | slack,github,linear,notion | `packages/providers/discord/agent/register.ts:102` |
| `registerAccountDisplayName` | 1/6 | discord,teams,github,linear,notion | `packages/providers/slack/agent/register.ts:107` |
| `registerCardPoster` | 1/6 | slack,teams,github,linear,notion | `packages/providers/discord/agent/register.ts:96` |
| `registerDiscordOps` | 1/6 | slack,teams,github,linear,notion | `packages/providers/discord/agent/register.ts:142` |
| `registerEntityActionAdapter` | 1/6 | slack,discord,teams,github,notion | `packages/providers/linear/agent/register.ts:105` |
| `registerGithubOps` | 1/6 | slack,discord,teams,linear,notion | `packages/providers/github/agent/register.ts:118` |
| `registerJudgeLiftNoticePoster` | 1/6 | slack,teams,github,linear,notion | `packages/providers/discord/agent/register.ts:101` |
| `registerLinearWorkSearch` | 1/6 | slack,discord,teams,github,notion | `packages/providers/linear/agent/register.ts:102` |
| `registerNativeAdminCheck` | 1/6 | slack,teams,github,linear,notion | `packages/providers/discord/agent/register.ts:104` |
| `registerNativeMemberCheck` | 1/6 | slack,teams,github,linear,notion | `packages/providers/discord/agent/register.ts:111` |
| `registerNotionMemory` | 1/6 | slack,discord,teams,github,linear | `packages/providers/notion/agent/register.ts:131` |
| `registerNotionWorkSearch` | 1/6 | slack,discord,teams,github,linear | `packages/providers/notion/agent/register.ts:103` |
| `registerScopeLabelResolver` | 1/6 | slack,teams,github,linear,notion | `packages/providers/discord/agent/register.ts:115` |
| `registerSlackAttachmentResolver` | 1/6 | discord,teams,github,linear,notion | `packages/providers/slack/agent/register.ts:116` |
| `registerSlackBridge` | 1/6 | discord,teams,github,linear,notion | `packages/providers/slack/agent/register.ts:121` |
| `registerSlackGovernanceMembers` | 1/6 | discord,teams,github,linear,notion | `packages/providers/slack/agent/register.ts:119` |
| `registerSlackOps` | 1/6 | discord,teams,github,linear,notion | `packages/providers/slack/agent/register.ts:131` |
| `registerSubtreePlatform` | 1/6 | slack,discord,teams,github,linear | `packages/providers/notion/agent/register.ts:127` |
| `registerSurfaceCommandReconciler` | 1/6 | slack,teams,github,linear,notion | `packages/providers/discord/agent/register.ts:137` |
| `registerSurfaceCredentialProbe` | 1/6 | slack,discord,teams,github,notion | `packages/providers/linear/agent/register.ts:112` |
| `registerTeamsBridge` | 1/6 | slack,discord,github,linear,notion | `packages/providers/teams/agent/register.ts:184` |
| `registerTeamsOps` | 1/6 | slack,discord,github,linear,notion | `packages/providers/teams/agent/register.ts:214` |
| `registerTicketCreateAdapter` | 1/6 | slack,discord,teams,github,notion | `packages/providers/linear/agent/register.ts:108` |

## B. Seat kinds, wake, addressing and coalescing

86 behaviours, 0 UNDOCUMENTED. Owning pages: docs/extending/chat-surface-contract.md (§2) · docs/how-it-works/agent-and-loop.md · docs/glossary.md §1.

| ID | Behaviour | Code | Documented by | Tested by |
|---|---|---|---|---|
| `SEAT-01` | A warm (name-drop-latched) surface auto-disengages after 3 consecutive silent woken turns. Participating surfaces are exempt. | `WARM_SILENT_LIMIT` — `packages/core/agent/channels/engagement.ts:11` | [deploy/surfaces/discord.md#stopping-it-following](../deploy/surfaces/discord.md#stopping-it-following) | ? |
| `SEAT-02` | A promotion caused by the agent's own post downgrades to a plain refresh while the row is stopped. | `ownPostMustNotRevive` — `packages/core/agent/channels/engagement.ts:34` | `docs/extending/chat-surface-contract.md#251-what-the-engagement-registry-answers-and-which-way-each-read-fails` | ? |
| `SEAT-03` | Engagement writes are best-effort: a store failure is logged and swallowed, never failing the turn. | `markThreadEngaged` — `packages/core/agent/channels/engagement.ts:44` | [extending/chat-surface-contract.md#25-the-ambient-engagement-seam-optional-and-its-absence-is-visible](../extending/chat-surface-contract.md#25-the-ambient-engagement-seam--optional-and-its-absence-is-visible) | ? |
| `SEAT-04` | Stand-down reads fail OPEN: an absent anchor or unreadable store answers "not stopped", so replies still deliver. | `isThreadStopped` — `packages/core/agent/channels/engagement.ts:114` | `docs/extending/chat-surface-contract.md#251-what-the-engagement-registry-answers-and-which-way-each-read-fails` | n/a: unannotated — lane F |
| `SEAT-05` | Engagement reads fail CLOSED: a store error answers "not engaged", so the agent never barges in. | `isThreadEngaged` — `packages/core/agent/channels/engagement.ts:143` | `docs/extending/chat-surface-contract.md#251-what-the-engagement-registry-answers-and-which-way-each-read-fails` | n/a: unannotated — lane F |
| `SEAT-06` | An undirected room wake stores and stops at a domain-grain row, always separate from the conversation row. | `roomEngagementAddress` — `packages/core/agent/channels/engagement.ts:133` | [extending/chat-surface-contract.md#410-stand_down-stop-following-this-conversation](../extending/chat-surface-contract.md#410-stand_down-stop-following-this-conversation) | n/a: unannotated — lane F |
| `SEAT-07` | Only an engaged, in-thread, human, non-mention message delivers. Any subtype except message_changed disqualifies. | `shouldDeliverReply` — `packages/core/agent/channels/engagement.ts:193` | [extending/chat-surface-contract.md#25-the-ambient-engagement-seam-optional-and-its-absence-is-visible](../extending/chat-surface-contract.md#25-the-ambient-engagement-seam--optional-and-its-absence-is-visible) | ? |
| `SEAT-08` | Mention, dm, dispatch and spawn classify addressed. An UNADDRESSED post from a bot or an unauth author classifies uncertain whatever the ambient reason. | `classifyParticipation` — `packages/core/agent/channels/engagement.ts:240` | `docs/extending/chat-surface-contract.md#252-how-certain-the-agent-is-that-a-wake-was-meant-for-it` | n/a: unannotated — lane F |
| `SEAT-09` | A judged wake states follow-up="thread-engaged" only when the caller passes threadEngaged. Direct, direct-mention and name-drop are excluded. | `engagedFollowUpContract` — `packages/core/agent/channels/engaged-wake.ts:75` | [security/audit-and-provenance](../security/audit-and-provenance.md#whats-logged) *names the reason, not the rule* | ? |
| `SEAT-10` | Enrolment requires participating===true and stopped!==true. No anchor, no row or store error answers false. | `conversationEnrolledForSilence` — `packages/core/agent/channels/engaged-wake.ts:131` | `docs/extending/chat-surface-contract.md#251-what-the-engagement-registry-answers-and-which-way-each-read-fails` | ? |
| `SEAT-11` | On an enrolled conversation the silence verb refuses exactly addressed_to_other. nothing_to_add and stand_down stay available. | `NO_REPLY_ADDRESSED_TO_OTHER_REFUSAL` — `packages/core/agent/channels/engaged-wake.ts:157` | `docs/extending/chat-surface-contract.md#251-what-the-engagement-registry-answers-and-which-way-each-read-fails` | ? |
| `SEAT-12` | Three frozen admission policies exist: wide, wide-with-bots and members-only, selected by a domain's declared name. | `SEAT_ADMISSION_FUNCTIONS` — `packages/core/agent/channels/seat-admission.ts:40` | [deploy/configuration-reference.md#where-a-domain-lives-and-how-you-add-one](../deploy/configuration-reference.md#where-a-domain-lives-and-how-you-add-one) | ? |
| `SEAT-13` | An unknown or absent admission name fails SOFT to the default "wide" policy, never to admit-nothing. | `admissionFunction` — `packages/core/agent/channels/seat-admission.ts:61` | [deploy/configuration-reference.md#where-a-domain-lives-and-how-you-add-one](../deploy/configuration-reference.md#where-a-domain-lives-and-how-you-add-one) | n/a: unannotated — lane F |
| `SEAT-14` | An ungraded rendered line floors per sender: a person at unauth, a machine author at relay. | `admitContextLines` — `packages/core/agent/channels/seat-admission.ts:90` | `docs/how-it-works/agent-and-loop.md#what-enters-a-seats-context` | ? |
| `SEAT-15` | An ambient skip writes one audit row per surface+reason per process, logs every skip, and never throws. | `auditAmbientSkip` — `packages/core/agent/channels/ambient-skip.ts:54` | `docs/how-it-works/agent-and-loop.md#when-ambient-talk-is-skipped` | ? |
| `SEAT-16` | A DM seat's primary rotation trigger is a 30-day expiry clock from row creation. 0 disables it. | `DM_SEAT_ROTATE_EXPIRY_MS` — `packages/core/agent/channels/dm-seat.ts:18` | [deploy/configuration-reference.md#session-rotation-standing-seats](../deploy/configuration-reference.md#session-rotation-standing-seats) | ? |
| `SEAT-17` | A DM seat rotates as a backstop after 50 turns, deliberately below the supervisor's 60. | `DM_SEAT_ROTATE_TURN_BUDGET` — `packages/core/agent/channels/dm-seat.ts:23` | [deploy/configuration-reference.md#session-rotation-standing-seats](../deploy/configuration-reference.md#session-rotation-standing-seats) | ? |
| `SEAT-18` | A DM seat's input-token rotation backstop is 5,000,000 tokens, kept above the supervisor's. | `DM_SEAT_ROTATE_TOKEN_BUDGET` — `packages/core/agent/channels/dm-seat.ts:29` | [deploy/configuration-reference.md#session-rotation-standing-seats](../deploy/configuration-reference.md#session-rotation-standing-seats) | ? |
| `SEAT-19` | A DM seat has no quiet-gap rotation rung (spelled POSITIVE_INFINITY), so idleness alone never rotates a DM. No setting turns it on. | `dmSeatThresholds` — `packages/core/agent/channels/dm-seat.ts:41` | [deploy/configuration-reference.md#session-rotation-standing-seats](../deploy/configuration-reference.md#session-rotation-standing-seats) | ? |
| `SEAT-20` | A DM wake adopts, rotates or resumes. A rotation carries the DM's rolling conversation summary (OPE-2431) and the outgoing generation's recorded tail. A self-healing resume, past `DM_SEAT_HEAL_GRACE_MS`, carries the stored summary alone. | `getOrCreateDmSeat` — `packages/core/agent/channels/dm-seat.ts:96` | `docs/how-it-works/agent-and-loop.md#dm-seats-and-the-dm-audience` | ? |
| `SEAT-21` | A store failure reads as stopped and not-delivered, suppressing the proactive DM and re-carding the next one. | `readDmAudience` — `packages/core/agent/channels/dm-audience.ts:50` | `docs/how-it-works/agent-and-loop.md#dm-seats-and-the-dm-audience` | n/a: unannotated — lane F |
| `SEAT-22` | A recipient's stop THROWS on store failure, so a failed stop is never reported as a landed one. | `stopDmAudience` — `packages/core/agent/channels/dm-audience.ts:82` | `docs/how-it-works/agent-and-loop.md#dm-seats-and-the-dm-audience` | n/a: unannotated — lane F |
| `SEAT-23` | Only the recipient lifts their own DM stop. Re-adding an operator grant writes the same address and stays stopped. | `resumeDmAudience` — `packages/core/agent/channels/dm-audience.ts:102` | `docs/how-it-works/agent-and-loop.md#dm-seats-and-the-dm-audience` | n/a: unannotated — lane F |
| `SEAT-24` | Every proactive DM carries a host-authored footer naming who asked, where from, and how to stop, in words and never as ids (none in the conversation the person asked from). | `dmDeliveryFooter` — `packages/core/agent/channels/dm-audience.ts:371` | `docs/how-it-works/agent-and-loop.md#dm-seats-and-the-dm-audience` | n/a: unannotated — lane F |
| `SEAT-25` | The single renderer never branches on platform: direct emits the body verbatim, every judged addressing emits the envelope alone. | `renderWake` — `packages/core/agent/channels/normalized-wake.ts:161` | `docs/how-it-works/agent-and-loop.md#what-a-wake-renders-as` | ? |
| `SEAT-26` | Only Slack offers the wake-arm seam. Discord, teams, github, linear and notion all decline with empty field lists. | `WAKE_ARM_SURFACE_CONTRACT` — `packages/core/agent/channels/wake-arm.ts:34` | [extending/adapter-model.md#a-seam-a-surface-may-decline-the-wake-arms-per-surface-contract](../extending/adapter-model.md#a-seam-a-surface-may-decline-the-wake-arms-per-surface-contract) | ? |
| `SEAT-27` | A consulted wake arm is handed at most 4000 characters of message text. | `WAKE_ARM_MAX_TEXT_CHARS` — `packages/core/agent/channels/wake-arm.ts:91` | [extending/adapter-model.md#a-seam-a-surface-may-decline-the-wake-arms-per-surface-contract](../extending/adapter-model.md#a-seam-a-surface-may-decline-the-wake-arms-per-surface-contract) | ? |
| `SEAT-28` | An arm only ADDS a wake: a built-in wake, a policy drop, a declining surface or no arm all skip the consult. | `wakeAfterArm` — `packages/core/agent/channels/wake-arm.ts:185` | [extending/adapter-model.md#a-seam-a-surface-may-decline-the-wake-arms-per-surface-contract](../extending/adapter-model.md#a-seam-a-surface-may-decline-the-wake-arms-per-surface-contract) | ? |
| `SEAT-29` | One arm consult gets 8000ms. A timeout, throw or off-vocabulary answer keeps the built-in answer. | `wakeArmTimeoutMs` — `packages/core/agent/channels/wake-arm.ts:131` | [extending/drop-in-arms.md#the-additive-instance-the-wake-decision](../extending/drop-in-arms.md#the-additive-instance-the-wake-decision) | ? |
| `SEAT-30` | A turn whose wake names no readable container throws WakeContainerError instead of guessing a surface segment. | `resolveWakeChannel` — `packages/core/agent/channels/wake-container.ts:26` | `docs/how-it-works/agent-and-loop.md#where-a-read-verb-reads` | ? |
| `SEAT-31` | read_thread refuses loudly on a top-level turn rather than returning an empty thread. | `requireWakeThreadRoot` — `packages/core/agent/channels/wake-container.ts:42` | `docs/how-it-works/agent-and-loop.md#where-a-read-verb-reads` | ? |
| `SEAT-32` | The latency band judges the in-turn segment alone. A missing turn-start row leaves inBand undefined and worst "unsplit". | `splitWakeLatency` — `packages/core/agent/channels/wake-timing.ts:234` | `docs/how-it-works/agent-and-loop.md#how-a-wake-is-timed-and-accounted` | ? |
| `SEAT-33` | A vendor clock reading is admitted only between the Discord epoch and Date's maximum. Anything else yields no reading. | `slackVendorEventTime` — `packages/core/agent/channels/wake-timing.ts:78` | `docs/how-it-works/agent-and-loop.md#how-a-wake-is-timed-and-accounted` | ? |
| `SEAT-34` | One turn-end accounting read loads at most 50 unaudited pending wakes. Past that the row is marked capped. | `MAX_ACCOUNTING_WAKES` — `packages/core/agent/channels/wake-accounting.ts:22` | `docs/how-it-works/agent-and-loop.md#how-a-wake-is-timed-and-accounted` | n/a: unannotated — lane F |
| `SEAT-35` | Every candidate, not just the leftovers, is stamped audited, so a wake is reported unaccounted at most once. | `settleWakeAccounting` — `packages/core/agent/channels/wake-accounting.ts:106` | `docs/how-it-works/agent-and-loop.md#how-a-wake-is-timed-and-accounted` | n/a: unannotated — its only prover is the maintainer's soak checker, which is not in this repo |
| `SEAT-36` | Only a stored "direct-mention" stamp counts as addressed. Absent, malformed or other tiers read as ambient. | `addressingClassOf` — `packages/core/agent/channels/wake-accounting.ts:47` | [security/audit-and-provenance](../security/audit-and-provenance.md#whats-logged) *names the reason, not the rule* | ? |
| `SEAT-37` | A platform with no registered origin codec misses the Map and fails closed, so its stored replies drop. | `wakeOriginCodec` — `packages/core/agent/channels/wake-origin-codec.ts:47` | `docs/how-it-works/agent-and-loop.md#what-a-wake-renders-as` | ? |
| `SEAT-38` | The self-dispatch body is capped at 512KB and the cap is enforced before the HMAC or the vault read. | `SELF_DISPATCH_MAX_BODY_BYTES` — `packages/core/agent/channels/self-dispatch.ts:30` | `docs/how-it-works/agent-and-loop.md#the-self-dispatch-hop` | ? |
| `SEAT-39` | Self-dispatch answers 404 disarmed, 413 oversized, 401 bad/stale signature, 400 malformed or window-disabled, 200 dispatched. | `handleSelfDispatch` — `packages/core/agent/channels/self-dispatch.ts:199` | `docs/how-it-works/agent-and-loop.md#the-self-dispatch-hop` | ? |
| `SEAT-40` | A self-dispatch POST is attempted twice, retrying only on abort or network error, never on a non-2xx. | `SELF_DISPATCH_ATTEMPTS` — `packages/core/agent/channels/self-dispatch.ts:46` | `docs/how-it-works/agent-and-loop.md#the-self-dispatch-hop` | n/a: unannotated — lane F |
| `SEAT-41` | A vendor webhook retry is squashed per instance for 10 minutes, bounded at 5000 keys with oldest-first pruning. | `EventDedupe` — `packages/core/agent/channels/front-queue.ts:7` | `docs/how-it-works/agent-and-loop.md#the-front-door--de-duplication-and-per-thread-order` | n/a: unannotated — lane F |
| `SEAT-42` | One thread's wakes deliver strictly serially in arrival order. Different threads run concurrently. | `ThreadFifo` — `packages/core/agent/channels/front-queue.ts:46` | `docs/how-it-works/agent-and-loop.md#the-front-door--de-duplication-and-per-thread-order` | ? |
| `SEAT-43` | A parked delegation mints a wake id whose origin is COPIED from the dispatching wake, never invented. | `openTaskWake` — `packages/core/agent/channels/task-wake.ts:64` | `docs/how-it-works/agent-and-loop.md#a-background-tasks-answer-finds-its-conversation` | ? |
| `SEAT-44` | Tasks dispatched by a coalesced turn are re-pointed at the conversation the turn actually addressed. | `retargetTaskWakes` — `packages/core/agent/channels/task-wake.ts:97` | `docs/how-it-works/agent-and-loop.md#a-background-tasks-answer-finds-its-conversation` | ? |
| `SEAT-45` | A settlement installs the task's wake identity only on an UNINGRESSED turn. Every outcome writes an audit row. | `installTaskWake` — `packages/core/agent/channels/task-wake.ts:196` | `docs/how-it-works/agent-and-loop.md#a-background-tasks-answer-finds-its-conversation` | n/a: unannotated — lane F |
| `SEAT-46` | At most one redrive fires per original wake id, and only for an unreplied prose drop, on any addressing. Its instruction is a trusted envelope `<system-note>`, never a fenced message body. | `maybeRedrive` — `packages/core/agent/channels/unified-redrive.ts:165` | `docs/how-it-works/agent-and-loop.md#which-wake-a-reply-may-answer` | ? |
| `SEAT-47` | A wake's reply target stays resolvable for 6 hours, enforced again as a read-time TTL. | `WAKE_TARGET_TTL_MS` — `packages/core/agent/channels/unified-window.ts:146` | `docs/how-it-works/agent-and-loop.md#which-wake-a-reply-may-answer` | ? |
| `SEAT-48` | Four ordered arms admit a reply: no turn wake, this turn's wake, same conversation, or a pending sibling on this window. | `resolveAnswerableReplyTarget` — `packages/core/agent/channels/unified-window.ts:450` | `docs/how-it-works/agent-and-loop.md#which-wake-a-reply-may-answer` | ? |
| `SEAT-49` | The edit path shares every reply arm except the answered check, so an answered wake stays editable. | `resolveEditableWakeTarget` — `packages/core/agent/channels/unified-window.ts:472` | `docs/how-it-works/agent-and-loop.md#which-wake-a-reply-may-answer` | n/a: unannotated — lane F |
| `SEAT-50` | A single-window turn's closing prose reaches no room on any addressing — it is dropped, audited, and re-driven once towards the `reply` tool. | the `message.completed` drop branch — `packages/core/agent/channels/unified.ts:782` | [security/audit-and-provenance](../security/audit-and-provenance.md#whats-logged) *names the reason, not the rule* | ? |
| `SEAT-51` | Five refusals name a withheld drop and suppress its redrive: stale-conversation, should-be-edit, declined-this-turn, answered-this-turn, stopped. | `PROSE_BLOCKING_REFUSALS` — `packages/core/agent/channels/unified-window.ts:1007` | [extending/chat-surface-contract](../extending/chat-surface-contract.md#41-reply--put-a-message-in-the-room) *names the reason, not the rule* | ? |
| `SEAT-52` | Native mention suppression and the direct-mention stamp derive from one predicate, so the two legs never double-reply or gap. | `singleWindowMentionPolicy` — `packages/core/agent/channels/unified-window.ts:706` | [security/audit-and-provenance](../security/audit-and-provenance.md#whats-logged) *names the reason, not the rule* | ? |
| `SEAT-53` | Only a positive per-platform thread signal reads thread-scoped. Top-level traffic routes to the standing seat. | `isThreadScopedWakeOrigin` — `packages/core/agent/channels/unified-window.ts:577` | `docs/how-it-works/agent-and-loop.md#the-window-token--what-a-session-id-says-about-itself` | ? |
| `SEAT-54` | A DM-family ingress positively stamps grain "standing", narrowing the seat's hands. A non-DM ingress stamps nothing. | `rootDmGrainAttrs` — `packages/core/agent/channels/unified-window.ts:633` | `docs/how-it-works/agent-and-loop.md#the-window-token--what-a-session-id-says-about-itself` | ? |
| `SEAT-55` | A degenerate key mints the pre-window token byte-identically. A colon-bearing windowId throws at the mint. | `formatWindowToken` — `packages/core/agent/channels/window-key.ts:34` | `docs/how-it-works/agent-and-loop.md#the-window-token--what-a-session-id-says-about-itself` | ? |
| `SEAT-56` | One classifier resolves seven session kinds — window, task, thread-seat, container-supervisor, dm-seat, subagent, native. | `classifySessionId` — `packages/core/agent/channels/window-key.ts:354` | `docs/how-it-works/agent-and-loop.md#the-window-token--what-a-session-id-says-about-itself` | n/a: unannotated — lane F |
| `SEAT-57` | A DM delegation anchor always carries generation 0, unreachable by rotateChannelSession, so it never collides. | `DM_ANCHOR_GENERATION` — `packages/core/agent/channels/window-key.ts:205` | `docs/how-it-works/agent-and-loop.md#the-window-token--what-a-session-id-says-about-itself` | ? |
| `SEAT-58` | Both dispatch gates admit a DM-anchored delivery by byte-exact self-consistency with the token's own anchor surface. | `dmAnchorSurfaceForToken` — `packages/core/agent/channels/window-key.ts:273` | `docs/how-it-works/agent-and-loop.md#the-window-token--what-a-session-id-says-about-itself` | ? |
| `SEAT-59` | Every rotation appends a fresh 6-hex-char salt, so a reset generation counter still mints a unique token. | `mintGenerationSalt` — `packages/core/agent/channels/window-key.ts:325` | `docs/how-it-works/agent-and-loop.md#the-window-token--what-a-session-id-says-about-itself` | ? |
| `SEAT-60` | A dm-seat token is excluded from the supervisor-shaped allowlist, so it routes to the primary model. | `isSupervisorShapedToken` — `packages/core/agent/channels/window-key.ts:432` | `docs/how-it-works/agent-and-loop.md#the-window-token--what-a-session-id-says-about-itself` | ? |
| `SEAT-61` | No approval memo is keyed on a window or work-session token: a conversation keeps no grant, and its one-call connector-op approvals wait under the thread or DM that asked (OPE-2363). | `proposingGrantScope` — `packages/core/agent/identity/binding.ts` | `docs/security/revocation-latency.md#session-approval-grants-are-revocable` | ? |
| `SEAT-62` | A window's platform vector derives purely from identity and domain config. An unresolvable identity yields empty, failed closed. | `sourcesForWindow` — `packages/core/agent/channels/window-sources.ts:31` | `docs/how-it-works/agent-and-loop.md#which-platforms-one-window-reaches` | ? |
| `SEAT-63` | A catch-up read starts at the seat's last wake, floored by the adapter's maxReachbackHours bootstrap window, then widened down to the start of the surface's own timestamp unit. | `seatCatchUpSinceMs` — `packages/core/agent/channels/backscroll-window.ts:79`, `seatCatchUpBounds` — `packages/core/agent/channels/seat-catch-up.ts:183` | [how-it-works/agent-and-loop.md#a-wake-a-dispatch-a-turn](../how-it-works/agent-and-loop.md#a-wake-a-dispatch-a-turn) | ? |
| `SEAT-64` | Admission runs before the token cap, newest messages are kept, and at least one admitted message always survives. | `fetchedBackscroll` — `packages/core/agent/channels/backscroll-window.ts:92` | `docs/how-it-works/agent-and-loop.md#what-enters-a-seats-context` | ? |
| `SEAT-65` | A backscroll message costs 4 characters per token plus 110 tokens of rendered per-message overhead. | `approxMessageTokens` — `packages/core/agent/channels/backscroll-window.ts:45` | `docs/how-it-works/agent-and-loop.md#what-enters-a-seats-context` | n/a: unannotated — lane F |
| `SEAT-66` | A missing platform fetch reports the catch-up unavailable. A registered fetch that throws degrades silently to empty. | `seatCatchUp` — `packages/core/agent/channels/seat-catch-up.ts:353` | [how-it-works/agent-and-loop.md#a-wake-a-dispatch-a-turn](../how-it-works/agent-and-loop.md#a-wake-a-dispatch-a-turn) | ? |
| `SEAT-67` | A channel key with unloadable config resolves the default wide admission rather than throwing out of the wake path. | `seatAdmissionFor` — `packages/core/agent/channels/seat-catch-up.ts:209` | `docs/how-it-works/agent-and-loop.md#what-enters-a-seats-context` | n/a: unannotated — lane F |
| `SEAT-68` | Both markers are required: a run-key failure with a 500, timeout or missing token classifies false and keeps its retry. | `isPrunedDeploymentWakeError` — `packages/core/agent/channels/stranded-seat.ts:45` | `docs/how-it-works/agent-and-loop.md#when-a-seats-generation-retires` | ? |
| `SEAT-69` | A stranded seat is MARKED for rotation at its next wake, never rotated here, and the heal never throws. | `healPrunedDeploymentStrand` — `packages/core/agent/channels/stranded-seat.ts:99` | `docs/how-it-works/agent-and-loop.md#when-a-seats-generation-retires` | ? |
| `SEAT-70` | At most one session-park audit row is written per registry key or token per hour. | `PARK_AUDIT_WINDOW_MS` — `packages/core/agent/channels/session-park.ts:51` | [extending/testing](../extending/testing.md#writing-an-integration-test) *names the reason, not the rule* | ? |
| `SEAT-71` | A park retires the generation by bumping usage by the largest token budget in the tree, guaranteeing rotation. | `parkRotateDelta` — `packages/core/agent/channels/session-park.ts:57` | `docs/how-it-works/agent-and-loop.md#when-a-seats-generation-retires` | ? |
| `SEAT-72` | A park never answers eve's continuation prompt and never redelivers the parked message. A rowless session gets remedy "none". | `handleSessionLimitPark` — `packages/core/agent/channels/session-park.ts:189` | `docs/how-it-works/agent-and-loop.md#when-a-seats-generation-retires` | ? |
| `SEAT-73` | A session is unresumable only on eve's WORLD_CONTRACT_ERROR code or both unreadable-World markers together. | `isUnresumableSessionError` — `packages/core/agent/channels/session-resume.ts:24` | `docs/how-it-works/agent-and-loop.md#when-a-seats-generation-retires` | ? |
| `SEAT-74` | At most 64 outgoing generations wait for retirement. Oldest entries are dropped first. | `MAX_PENDING` — `packages/core/agent/channels/generation-retirement.ts:149` | `docs/how-it-works/agent-and-loop.md#when-a-seats-generation-retires` | ? |
| `SEAT-75` | Retirement is refused for the incoming token, an unreadable read, a still-live registry row, a live turn or an owed delegation. | `retirementVerdict` — `packages/core/agent/channels/generation-retirement.ts:361` | `docs/how-it-works/agent-and-loop.md#when-a-seats-generation-retires` | ? |
| `SEAT-76` | One generation's owed-task row records at most 32 delegations. Extras go uncounted rather than blocking reaps. | `MAX_GENERATION_DELEGATIONS` — `packages/core/agent/channels/generation-retirement.ts:228` | `docs/how-it-works/agent-and-loop.md#when-a-seats-generation-retires` | ? |
| `SEAT-77` | A retirement drain confirms within a 5000ms deadline before giving up. | `RETIREMENT_CONFIRM_TIMEOUT_MS` — `packages/core/agent/channels/generation-retirement.ts:450` | `docs/how-it-works/agent-and-loop.md#when-a-seats-generation-retires` | n/a: unannotated — lane F |
| `SEAT-78` | A per-surface seat proves a read by surface key. A unified seat by the addressed wake, falling back to currentWakeId. | `stampReadReach` — `packages/core/agent/channels/read-reach.ts:77` | `docs/how-it-works/agent-and-loop.md#what-a-turn-proves-it-read` | n/a: unannotated — lane F |
| `SEAT-79` | A record id enters the ledger only when the turn's own host wake stamp names that same record. | `noteAuthoredRecordRead` — `packages/core/agent/channels/read-reach.ts:174` | `docs/how-it-works/agent-and-loop.md#what-a-turn-proves-it-read` | ? |
| `SEAT-80` | Only positive refutations mark. The probe runs over distinct human authors and a throw answers empty for the page. | `refutedReadAuthorIds` — `packages/core/agent/channels/read-author-trust.ts:40` | [extending/provider-bundles.md#chat-surface-plane](../extending/provider-bundles.md#chat-surface-plane) | ? |
| `SEAT-81` | A channel key is ch_ plus base64url of platform:container. An empty platform returns the container unchanged. | `encodeChannelKey` — `packages/core/agent/channels/channel-key.ts:23` | `docs/how-it-works/agent-and-loop.md#the-channel-key--one-opaque-name-for-a-container` | ? |
| `SEAT-82` | Decoding is canonicality-checked by re-encoding, so two different keys can never name one container. | `decodeChannelKey` — `packages/core/agent/channels/channel-key.ts:33` | `docs/how-it-works/agent-and-loop.md#the-channel-key--one-opaque-name-for-a-container` | ? |
| `SEAT-83` | A DM-anchored token is admitted only to the exact surface its anchor names. Every other surface reads domain config, fail-closed. | `windowEnabledFor` — `packages/core/agent/channels/unified.ts:182` | `docs/how-it-works/agent-and-loop.md#the-window-token--what-a-session-id-says-about-itself` | ? |
| `SEAT-84` | A silence ack is suppressed when a sibling wake in the same CONTAINER, not merely the same turn, was answered. | `answeredSameContainerThisTurn` — `packages/core/agent/channels/unified.ts:239` | `docs/how-it-works/agent-and-loop.md#which-wake-a-reply-may-answer` | ? |
| `SEAT-85` | Unaccounted-wake accounting is audit-only, and a missing window token, turn id or turn wake writes a reason-tagged skip row. | `auditUnaccountedWakesForTurn` — `packages/core/agent/channels/unified.ts:268` | `docs/how-it-works/agent-and-loop.md#how-a-wake-is-timed-and-accounted` | n/a: unannotated — lane F |
| `SEAT-86` | A body renders unfenced only for from="human" at peer or principal trust with no positive refutation. | `authorTrustAdmitsUnfencedBody` — `packages/core/agent/channels/wake-envelope.ts:280` | [glossary.md#3-taint](../glossary.md#3-taint) | ? |

## C. Reply, edit and settlement

55 behaviours, 0 UNDOCUMENTED. Owning pages: docs/extending/chat-surface-contract.md (§4) · docs/security/audit-and-provenance.md.

| ID | Behaviour | Code | Documented by | Tested by |
|---|---|---|---|---|
| `REPLY-01` | Resolves the post target from the session binding alone, returning null where the manifest declares no midTurnPost. | `resolveReplyTarget` — `packages/core/agent/channels/reply-post.ts:56` | `docs/extending/chat-surface-contract.md#412-the-reply-choke-point--target-de-duplication-and-what-lands` | ? |
| `REPLY-02` | Writes one reply.post audit row per landed post, its platform column naming the surface, never the route. | `auditReplyPost` — `packages/core/agent/channels/reply-post.ts:137` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `reply.post`, not the rule | ? |
| `REPLY-03` | Writes a reply.post.failed row with reason platform-error, the failure class and the platform HTTP status. | `auditReplyPostFailed` — `packages/core/agent/channels/reply-post.ts:175` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `reply.post.failed`, not the rule | n/a: unannotated — lane F |
| `REPLY-04` | Writes a reply.refused row and marks the refusal on the turn, so the drop row can name which host decision withheld the answer. | `auditReplyRefused` — `packages/core/agent/channels/reply-post.ts:219` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `reply.refused`, not the rule | n/a: unannotated — lane F |
| `REPLY-05` | Writes a reply.forced row whenever the model overrides a host verdict and posts anyway. | `auditReplyForced` — `packages/core/agent/channels/reply-post.ts:242` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `reply.forced`, not the rule | n/a: unannotated — lane F |
| `REPLY-06` | Releases the dedupe claim on a definitive failure only. An ambiguous one keeps it so identical retries cannot double-post. | `releasePostKeyOnFailure` — `packages/core/agent/channels/reply-post.ts:213` | `docs/extending/chat-surface-contract.md#412-the-reply-choke-point--target-de-duplication-and-what-lands` | ? |
| `REPLY-07` | Returns the sentinel deduped:reply instead of a platform id when a byte-identical repost was suppressed. | `REPLY_DEDUPE_SKIPPED_ID` — `packages/core/agent/channels/reply-post.ts:293` | `docs/extending/chat-surface-contract.md#412-the-reply-choke-point--target-de-duplication-and-what-lands` | ? |
| `REPLY-08` | Keys idempotency on target, wake id and body, so two identical calls put one message in the room. | `postReply` — `packages/core/agent/channels/reply-post.ts:329` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) | n/a: unannotated — its only prover is the maintainer's soak checker, which is not in this repo |
| `REPLY-09` | Answers null for a Linear mention target and a workspace-less Notion target, leaving those posts permanently uneditable. | `replyEditLocus` — `packages/core/agent/channels/reply-post.ts:401` | `docs/extending/chat-surface-contract.md#413-editing-a-post--locus-ownership-and-the-six-hour-window` | ? |
| `REPLY-10` | Records a turn's dropped closing prose as one audit row, taint-clean, and posts nothing. | `dropClosingProse` — `packages/core/agent/channels/closing-prose-drop.ts:42` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `turn.supervisor_prose_dropped`, not the rule | ? |
| `REPLY-11` | Re-reads the durable stopped flag per post, allows exactly one post, and fails open in every unknown direction. | `standDownState` — `packages/core/agent/tools/reply.ts:170` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | n/a: unannotated — lane F |
| `REPLY-12` | Spends the stand-down valve in both halves and writes a reply.stand_down_ack row carrying the engagement anchor. | `spendStoppedAck` — `packages/core/agent/tools/reply.ts:237` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `reply.stand_down_ack`, not the rule | n/a: unannotated — lane F |
| `REPLY-13` | Resolves the reply target from the model's wake-id against the durable map. An unheld or expired id fails closed. | `unifiedReplyEntry` — `packages/core/agent/tools/reply.ts:262` | [how-it-works/agent-and-loop](../how-it-works/agent-and-loop.md#a-wake-a-dispatch-a-turn) *names the reason, not the rule* | n/a: unannotated — lane F |
| `REPLY-14` | Posts only into the conversation that woke the turn and records that post carrying no wake id. | `baseReplyEntry` — `packages/core/agent/tools/reply.ts:607` | `docs/extending/chat-surface-contract.md#412-the-reply-choke-point--target-de-duplication-and-what-lands` | n/a: unannotated — lane F |
| `REPLY-15` | Counts pending inbound wakes registered after the anchor in the same conversation and reports the reply stale. | `replyFreshness` — `packages/core/agent/channels/reply-freshness.ts:126` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | ? |
| `REPLY-16` | Loads at most 20 newer wakes. Past that cap the refusal reports the count as "at least". | `MAX_NEWER_WAKES` — `packages/core/agent/channels/reply-freshness.ts:77` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | ? |
| `REPLY-17` | Records a staleness refusal per turn per wake, capped at 32, so the gate refuses at most once. | `markStaleRefusedThisTurn` — `packages/core/agent/channels/reply-freshness.ts:221` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | n/a: unannotated — lane F |
| `REPLY-18` | Reads the fold verdict even under force, so a reply.forced row always means a real verdict was overridden. | `refuseIfShouldFold` — `packages/core/agent/channels/reply-fold.ts:366` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `reply.forced`, not the rule | ? |
| `REPLY-19` | Confirms the fold target against the own-post ledger before steering, so the redirect cannot draw not-own-post. | `replyFoldTarget` — `packages/core/agent/channels/reply-fold.ts:273` | [extending/chat-surface-contract](../extending/chat-surface-contract.md#42-editreply--correct-one-of-your-own-posts) *names the reason, not the rule* | ? |
| `REPLY-20` | Names both wake and message_id and warns that an edit replaces the message outright. | `foldIntoEditRefusalMessage` — `packages/core/agent/channels/reply-fold.ts:328` | `docs/extending/chat-surface-contract.md#413-editing-a-post--locus-ownership-and-the-six-hour-window` | n/a: unannotated — lane F |
| `REPLY-21` | Refuses one second done:true answer per wake per turn, audited with reason answered-this-turn. | `isWakeDoneThisTurn` — `packages/core/agent/channels/reply-signal.ts:111` | [extending/chat-surface-contract](../extending/chat-surface-contract.md#41-reply--put-a-message-in-the-room) *names the reason, not the rule* | ? |
| `REPLY-22` | Keeps a hard wall on a Linear mention origin, where a response activity ends the agent session. | `terminalPostClosesConversation` — `packages/core/agent/channels/unified-reply.ts:228` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | n/a: unannotated — lane F |
| `REPLY-23` | Counts overrides per (reason, key). The first writes the reply.forced row, later ones write none. | `noteForcedOverrideThisTurn` — `packages/core/agent/channels/reply-signal.ts:579` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `reply.forced`, not the rule | ? |
| `REPLY-24` | Arms the turn-closeout latch with reason forced-override-repeat after 2 overrides of one verdict. | `FORCED_OVERRIDE_TURN_LIMIT` — `packages/core/agent/channels/reply-signal.ts:556` | [security/audit-and-provenance](../security/audit-and-provenance.md#whats-logged) *names the reason, not the rule* | ? |
| `REPLY-25` | Refuses a reply to a wake this turn declined, reason declined-this-turn, and ends the turn. | `isWakeDeclinedThisTurn` — `packages/core/agent/channels/reply-signal.ts:300` | [extending/chat-surface-contract](../extending/chat-surface-contract.md#41-reply--put-a-message-in-the-room) *names the reason, not the rule* | ? |
| `REPLY-26` | Holds the acknowledgement debt until a post lands after the stand-down snapshot or the stopped valve spends. | `standDownAckOwedThisTurn` — `packages/core/agent/channels/reply-signal.ts:453` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | ? |
| `REPLY-27` | Writes an ungated reply.no_reply_after_stand_down row each time an owed acknowledgement refuses a silence call. | `NO_REPLY_AFTER_STAND_DOWN_ACTION` — `packages/core/agent/channels/reply-signal.ts:420` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | ? |
| `REPLY-28` | Writes the post, provenance, own-post ledger, tail ring and answered-container records inside one dedupe-guarded run. | `postUnifiedReply` — `packages/core/agent/channels/unified-reply.ts:79` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) | ? |
| `REPLY-29` | Applies the arm's retargetEditLocus before the ownership fence, degrading to the base locus on any failure. | `resolveUnifiedEditLocus` — `packages/core/agent/channels/unified-reply.ts:236` | `docs/extending/chat-surface-contract.md#413-editing-a-post--locus-ownership-and-the-six-hour-window` | n/a: unannotated — lane F |
| `REPLY-30` | Closes an open agent session on a silent turn with a fixed host acknowledgement, never model prose. | `completeUnifiedSessionSilently` — `packages/core/agent/channels/unified-reply.ts:278` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | ? |
| `REPLY-31` | Checks the edit arm, then ledger ownership, then dispatches. Every outcome leaves exactly one audit row. | `editPostedMessage` — `packages/core/agent/channels/reply-edit.ts:140` | `docs/extending/chat-surface-contract.md#413-editing-a-post--locus-ownership-and-the-six-hour-window` | ? |
| `REPLY-32` | Refuses an edit of a message absent from the ledger, writing reply.edit.refused with reason not-own-post. | `EDIT_NOT_OWN_REFUSAL_REASON` — `packages/core/agent/channels/reply-edit.ts:28` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `reply.edit.refused`, not the rule | ? |
| `REPLY-33` | Refuses on a surface with no editMessage arm under reason no-edit-arm and names that surface. | `EDIT_NO_ARM_REFUSAL_REASON` — `packages/core/agent/channels/reply-edit.ts:31` | [extending/chat-surface-contract](../extending/chat-surface-contract.md#42-editreply--correct-one-of-your-own-posts) *names the reason, not the rule* | ? |
| `REPLY-34` | Rethrows a definitive edit failure, and returns edited:false on an ambiguous one, ending the turn. | `editOrReportAmbiguous` — `packages/core/agent/tools/edit_reply.ts:41` | `docs/extending/chat-surface-contract.md#413-editing-a-post--locus-ownership-and-the-six-hour-window` | n/a: unannotated — lane F |
| `REPLY-35` | Keeps a posted message editable for 6 hours, after which the ledger refuses every edit. | `OWN_POST_TTL_MS` — `packages/core/agent/channels/own-post-ledger.ts:14` | `docs/extending/chat-surface-contract.md#413-editing-a-post--locus-ownership-and-the-six-hour-window` | ? |
| `REPLY-36` | Fails closed on a missing org, blank id or store error, turning every unknown into a refusal. | `isOwnPost` — `packages/core/agent/channels/own-post-ledger.ts:57` | `docs/extending/chat-surface-contract.md#413-editing-a-post--locus-ownership-and-the-six-hour-window` | ? |
| `REPLY-37` | Forgets then re-marks the container stamp so the silent-close gate reads a current answer time. | `recordContainerAnswered` — `packages/core/agent/channels/answered-container-ledger.ts:42` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | ? |
| `REPLY-38` | Returns a non-empty terminal note so eve's empty-step reissue never nudges a turn that chose silence. | `NO_REPLY_NOTE` — `packages/core/agent/tools/no_reply.ts:58` | `docs/extending/chat-surface-contract.md#415-how-a-turn-ends` | ? |
| `REPLY-39` | Logs one silence row per turn. A second call ends the turn under reason no-reply-redundant. | `NO_REPLY_REDUNDANT_CLOSEOUT_REASON` — `packages/core/agent/tools/no_reply.ts:52` | `docs/extending/chat-surface-contract.md#415-how-a-turn-ends` | ? |
| `REPLY-40` | Writes an engagement.stood_down row on every call — carrying the anchor and, when the verb reached the registry, whether a row was really flagged (`marked`), else the refusal code for the turn shape that stopped it (`refused`). An empty window therefore means the verb was never called OR its best-effort audit write was dropped — never that the registry lacked the conversation, which is a `marked: false` row. | `STAND_DOWN_ACTION` — `packages/core/agent/tools/stand_down.ts:19` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `engagement.stood_down`, not the rule | ? |
| `REPLY-41` | Refuses a stand-down in a 1:1 DM, because no DM wake gate ever reads the stopped marker. | `DM_REFUSAL` — `packages/core/agent/tools/stand_down.ts:57` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | ? |
| `REPLY-42` | Renders the acknowledgement route for this seat's stamped delivery arm, defaulting to dual-mode when unstamped. | `standDownAckRoute` — `packages/core/agent/tools/stand_down.ts:95` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | ? |
| `REPLY-43` | Latches the turn silent once a post lands into a stopped conversation, so trailing prose never follows. | `markStandDownSilenceThisTurn` — `packages/core/agent/channels/stand-down-silence.ts:52` | `docs/extending/chat-surface-contract.md#414-staleness-the-stand-down-debt-and-the-terminal-post` | ? |
| `REPLY-45` | Consumes both silence signals first, then ranks silent-routine over stand-down over the no_reply reason. | `finalMessageActionForTurn` — `packages/core/agent/channels/turn-delivery.ts:64` | `docs/extending/chat-surface-contract.md#415-how-a-turn-ends` | ? |
| `REPLY-46` | Appends one shared sentence on all four reply and edit tool doors while a dispatched worker still owes. | `PENDING_WORK_INSTRUCTION` — `packages/core/agent/channels/turn-delivery.ts:202` | `docs/extending/chat-surface-contract.md#412-the-reply-choke-point--target-de-duplication-and-what-lands` | n/a: unannotated — lane F |
| `REPLY-47` | Rewrites every memory-mount citation to its bare silo-relative path at each reply and edit choke point. | `truncateMemoryCitationPaths` — `packages/core/agent/channels/turn-delivery.ts:250` | `docs/extending/chat-surface-contract.md#412-the-reply-choke-point--target-de-duplication-and-what-lands` | ? |
| `REPLY-48` | Ends the turn natively on a successful reply, with no further model call (endsTurn). | `unifiedReplyEntry` — `packages/core/agent/tools/reply.ts:284` | `docs/extending/chat-surface-contract.md#415-how-a-turn-ends` | ? |
| `REPLY-49` | Asks for the owed reply after an addressed react, and names the NO_REPLY sentinel after an unaddressed one. | `reactResultNote` — `packages/core/agent/tools/react.ts:33` | `docs/extending/chat-surface-contract.md#415-how-a-turn-ends` | ? |
| `REPLY-50` | Strips a model-forged Sources-read line at every choke point; appends no footer since OPE-2487. | `applyReplyProvenance` — `packages/core/agent/channels/reply-provenance.ts:694` | `docs/extending/chat-surface-contract.md#412-the-reply-choke-point--target-de-duplication-and-what-lands` | ? |
| `REPLY-51` | Writes a reply.provenance row carrying the full source list plus how many the reach rule withheld. | `auditReplyProvenance` — `packages/core/agent/channels/reply-provenance.ts:652` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `reply.provenance`, not the rule | ? |
| `REPLY-52` | Cancels the resolved anchor's exact turn id and writes one turn.cancel_requested row per request. | `cancelAnchoredTurn` — `packages/core/agent/channels/turn-cancel.ts:115` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `turn.cancel_requested`, not the rule | ? |
| `REPLY-53` | Records a stop eve accepted and never applied as turn.stop_ignored, keeping turn.cancelled strict. | `TURN_STOP_IGNORED_ACTION` — `packages/core/agent/channels/turn-cancel.ts:52` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `turn.stop_ignored`, not the rule | ? |
| `REPLY-54` | Refuses a react whose wake origin has no reaction primitive and steers to reply or no_reply. | `reactEntry` — `packages/core/agent/tools/react.ts:32` | `docs/extending/chat-surface-contract.md#415-how-a-turn-ends` | ? |
| `REPLY-55` | Emits telemetry for every reaction but durably records reaction.feedback only on the bot's own reply. | `ingestReaction` — `packages/core/agent/channels/reaction-ingest.ts:166` | [extending/provider-bundles.md#chat-surface-plane](../extending/provider-bundles.md#chat-surface-plane) | ? |

## D. Delegation and thread seats

46 behaviours, 0 UNDOCUMENTED. Owning pages: docs/extending/chat-surface-contract.md §2.6 · docs/extending/tools.md · docs/how-it-works/access-and-scoping.md.

| ID | Behaviour | Code | Documented by | Tested by |
|---|---|---|---|---|
| `DELG-01` | A review with evidenceSeen false must recommend block — silence about an unseen change never reads as approval. | `FRESH_EYES_REVIEW_OUTPUT` — `packages/core/agent/subagents/contracts.ts:53` | `docs/extending/tools.md#the-shipped-review-contract` | ? |
| `DELG-02` | Findings use one closed five-rung severity scale including nit, so a reviewer can approve with nits. | `REVIEW_SEVERITY` — `packages/core/agent/subagents/contracts.ts:30` | `docs/extending/tools.md#the-shipped-review-contract` | n/a: unannotated — lane F |
| `DELG-03` | A subagent directory must be lower snake_case, because the directory name IS the model-visible tool name. | `SUBAGENT_NAME_RE` — `packages/core/agent/subagents/declared.ts:45` | `docs/extending/tools.md#declared-subagents--the-rules-the-lint-enforces` | n/a: unannotated — lane F |
| `DELG-04` | Only tools, skills, hooks, connections, sandbox, lib and subagents are discovered. A schedules directory fails the build. | `SUPPORTED_SUBAGENT_DIRS` — `packages/core/agent/subagents/declared.ts:49` | `docs/extending/tools.md#declared-subagents--the-rules-the-lint-enforces` | n/a: unannotated — lane F |
| `DELG-05` | Zero hands: every framework tool must be explicitly disabled or replaced per subagent, or it mounts unfenced. | `checkDeclaredSubagents` — `packages/core/agent/subagents/declared.ts:81` | `docs/extending/tools.md#declared-subagents--the-rules-the-lint-enforces` | ? |
| `DELG-06` | A missing hooks/spend.ts is a lint failure, because hooks are not inherited and delegated tokens would go unledgered. | `checkDeclaredSubagents` — `packages/core/agent/subagents/declared.ts:81` | `docs/extending/tools.md#declared-subagents--the-rules-the-lint-enforces` | ? |
| `DELG-07` | A declared subagent must export a description and an instructions file, and must NOT export an `outputSchema` — eve 0.67.0 removed the field, so the lint reds when it is present. | `checkDeclaredSubagents` — `packages/core/agent/subagents/declared.ts#checkDeclaredSubagents` | `docs/extending/tools.md#declared-subagents--the-rules-the-lint-enforces` | ? |
| `DELG-08` | A thread ownership row expires after 7 days, returning an abandoned thread to the standing seat. | `THREAD_OWNER_TTL_MS` — `packages/core/agent/channels/thread-ownership.ts:10` | `docs/extending/chat-surface-contract.md#261-thread-ownership--who-a-threads-follow-up-wakes` | ? |
| `DELG-09` | Owner lookup fails closed: a store error yields null and the message routes to the standing seat. | `resolveThreadOwner` — `packages/core/agent/channels/thread-ownership.ts:29` | `docs/extending/chat-surface-contract.md#261-thread-ownership--who-a-threads-follow-up-wakes` | n/a: unannotated — lane F |
| `DELG-10` | A task-owner token from a stale generation, or any owner token from a different domain, is ignored and routes to the standing seat. A thread seat's generation never makes it stale, so it survives its parent's rotation. | `routeThreadMessage` — `packages/core/agent/channels/thread-ownership.ts:70` | `docs/extending/chat-surface-contract.md#261-thread-ownership--who-a-threads-follow-up-wakes` | ? |
| `DELG-11` | Owner grain is read from token shape: t/ is a wide-hands task worker, s/ a narrow thread seat. | `routeThreadMessage` — `packages/core/agent/channels/thread-ownership.ts:70` | `docs/extending/chat-surface-contract.md#261-thread-ownership--who-a-threads-follow-up-wakes` | ? |
| `DELG-12` | The thread-seat record lives exactly as long as the ownership row it shadows — the same 7-day window. | `THREAD_SEAT_STATE_TTL_MS` — `packages/core/agent/channels/thread-seat-state.ts:20` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | n/a: unannotated — lane F |
| `DELG-13` | A stored wake origin is re-validated on read. An unreadable one answers "no origin" rather than misrouting a delivery. | `threadSeatOrigin` — `packages/core/agent/channels/thread-seat-state.ts:54` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-14` | The close is one conditional store write that names the closing seat: two racing closes close it once, an old seat never closes a newer seat's record, and with no record it returns null and no hand-back fires. | `recordThreadSeatClose` — `packages/core/agent/channels/thread-seat-state.ts:84` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-15` | Reading seat state is fail-soft: a store error reads as no record, and the caller distinguishes the two. | `readThreadSeatState` — `packages/core/agent/channels/thread-seat-state.ts:84` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | n/a: unannotated — lane F |
| `DELG-16` | Thread-seat spawning fails closed on the delegation flag and requires a real standing window token. | `canSpawnThreadFromWindow` — `packages/core/agent/tools/spawn_thread_session.ts:58` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | n/a: unannotated — lane F |
| `DELG-17` | A task worker or thread seat can never spawn another thread seat — no recursive thread trees. | `isOwnTokenTaskOrThread` — `packages/core/agent/tools/spawn_thread_session.ts:49` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | n/a: unannotated — lane F |
| `DELG-18` | The child wake id derives from the tool callId, so an in-attempt retry cannot deliver the brief twice. | `deterministicChildWakeId` — `packages/core/agent/tools/spawn_thread_session.ts:33` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | n/a: unannotated — lane F |
| `DELG-19` | A spawned seat is told the task is its own, that it runs real work through its own work session with `work`, and that it finishes by posting its completion and calling `complete_thread`. | `renderThreadSeatBrief` — `packages/core/agent/tools/spawn_thread_session.ts:72` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | n/a: unannotated — lane F |
| `DELG-20` | A steer names the sender's ROLE, never an identity, so it carries no authority of its own. | `renderSeatSteer` — `packages/core/agent/tools/message_thread_seat.ts:24` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | n/a: unannotated — lane F |
| `DELG-21` | The steer states explicitly whether the thread's people can see it. Mirror is required with no default. | `renderSeatSteer` — `packages/core/agent/tools/message_thread_seat.ts:24` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-22` | Colons are stripped from a supplied thread id exactly as the spawn strips them, so one thread has one key. | `threadKeyArgument` — `packages/core/agent/tools/read_thread_seat.ts:18` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | n/a: unannotated — lane F |
| `DELG-23` | Only a session running on a thread-seat window token may complete a thread. Everything else is refused. | `isOwnTokenThreadSeat` — `packages/core/agent/tools/complete_thread.ts:21` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-24` | The hand-back resolves the parent's LIVE token from its registry row, so a rotated generation cannot swallow it. | `handBackToParent` — `packages/core/agent/channels/thread-seat-close.ts:216` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-25` | The hand-back is host-written from recorded facts, carries the seat's report verbatim when there is one, and is ambient, so the parent stays silent unless it decides otherwise. | `renderThreadSeatHandBack` — `packages/core/agent/channels/thread-seat-close.ts:105` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-26` | Work-platform registration is additive and idempotent: the first non-undefined role wins, so order cannot change grants. | `registerWorkPlatform` — `packages/core/agent/channels/work-registry.ts:10` | `docs/how-it-works/access-and-scoping.md#work-destinations--where-a-work-verb-may-land` | n/a: unannotated — lane F |
| `DELG-27` | A caller with no resolvable domain holds no work grant. There is never a default destination. | `grantedWorkPlatforms` — `packages/core/agent/channels/work-destinations.ts:14` | `docs/how-it-works/access-and-scoping.md#work-destinations--where-a-work-verb-may-land` | n/a: unannotated — lane F |
| `DELG-28` | An unreadable config or identity-less context yields an empty repo grant — a refusal, never a default. | `grantedRepos` — `packages/core/agent/channels/work-destinations.ts:27` | `docs/how-it-works/access-and-scoping.md#work-destinations--where-a-work-verb-may-land` | n/a: unannotated — lane F |
| `DELG-29` | GitHub is admissible only via the access bundle's repo list plus a registered adapter, not a credentials row. | `workDestinationPlatforms` — `packages/core/agent/channels/work-destinations.ts:39` | [extending/chat-surface-contract.md#47-search-the-deliberate-cross-container-exception](../extending/chat-surface-contract.md#47-search--the-deliberate-cross-container-exception) | ? |
| `DELG-30` | The entity source binds to the asking session. Only the approval card's venue may move, and never outside the domain. | `setStateEntry` — `packages/core/agent/tools/set_state.ts:40` | `docs/how-it-works/access-and-scoping.md#proposing-a-ticket-state-change` | ? |
| `DELG-31` | A ticket state change freezes its args and posts a card. Nothing mutates until a human clicks confirm. | `setStateEntry` — `packages/core/agent/tools/set_state.ts:40` | `docs/how-it-works/access-and-scoping.md#proposing-a-ticket-state-change` | ? |
| `DELG-32` | One domain-config read is threaded to both the entity gate and the venue walk, so the two cannot disagree. | `safeDomains` — `packages/core/agent/tools/set_state.ts:23` | `docs/how-it-works/access-and-scoping.md#proposing-a-ticket-state-change` | n/a: unannotated — lane F |
| `DELG-33` | resume takes a two-value scope enum only. The halt key is derived host-side from the seat's binding, never the model. | `chatHaltAddress` — `packages/core/agent/tools/halt.ts:35` | `docs/security/control-plane.md#the-in-chat-halt-and-resume-verbs-take-two-scopes-not-four` | ? |
| `DELG-34` | One status line per session is upserted into a shared surface-tier STATUS.md that every thread in the surface reads. | `upsertStatusItem` — `packages/core/agent/status/status.ts:89` | `docs/how-it-works/agent-and-loop.md#the-shared-status-file` | n/a: unannotated — lane F |
| `DELG-35` | The reply mark read is destructive and consumed exactly once per terminal completion, below the buffer-tool-status return. | `consumeSupervisorReplyMark` — `packages/core/agent/channels/supervisor-complete.ts:12` | `docs/how-it-works/agent-and-loop.md#what-a-terminal-turn-records` | n/a: unannotated — lane F |
| `DELG-36` | Exactly one lifecycle row per terminal turn, and a tool reply files a platform-scoped replied row whatever the closing action was. | `completeSupervisorTurn` — `packages/core/agent/channels/supervisor-complete.ts:67` | `docs/how-it-works/agent-and-loop.md#what-a-terminal-turn-records` | ? |
| `DELG-37` | Closing prose with no tool reply is dropped and audited as turn.supervisor_prose_dropped — the only witness an answer was owed. | `completeSupervisorTurn` — `packages/core/agent/channels/supervisor-complete.ts:67` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `turn.supervisor_prose_dropped`, not the rule | ? |
| `DELG-38` | A replied row stamps detail.route tool. Byte counts live only on the canonical reply.post row. | `SUPERVISOR_REPLIED_ROUTE` — `packages/core/agent/channels/supervisor-complete.ts:64` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `detail.route`, not the rule | ? |
| `DELG-39` | A failed judge turn or dead session audits and posts nothing — the shared reserved posture across ticketing supervisors. | `auditSupervisorFailure` — `packages/core/agent/channels/supervisor-complete.ts:132` | `docs/how-it-works/agent-and-loop.md#what-a-terminal-turn-records` | n/a: unannotated — lane F |
| `DELG-40` | A named window group wins over the domain's mode. Solo (one window per channel) is the residue default. | `supervisorGrainFor` — `packages/core/agent/channels/unified-supervisor.ts:155` | [glossary.md#1-seat-grain-posture](../glossary.md#1-seat-grain-posture) | ? |
| `DELG-41` | One predicate decides every divert and privacy floor, so a group window is floored exactly as a solo one. | `grainUsesUnifiedWindow` — `packages/core/agent/channels/unified-supervisor.ts:149` | `docs/how-it-works/agent-and-loop.md#one-synthetic-channel-one-model-context` | ? |
| `DELG-42` | A non-standing token answers undefined, which a caller must treat as no registry row, never as the surface key. | `standingSeatRegistryKey` — `packages/core/agent/channels/unified-supervisor.ts:112` | `docs/how-it-works/agent-and-loop.md#one-synthetic-channel-one-model-context` | ? |
| `DELG-43` | Window sessions key on a synthetic oe-domain surfaceKey that can never collide with a real platform surface key. | `unifiedDomainSessionKey` — `packages/core/agent/channels/unified-supervisor.ts:82` | [deploy/configuration-reference](../deploy/configuration-reference.md#where-a-domain-lives-and-how-you-add-one) *names the reason, not the rule* | ? |
| `DELG-44` | A bare unanchored oe-sup substring test identifies a supervisor step, deliberately broader than the anchored codec. | `isSupervisorToken` — `packages/core/agent/channels/unified-supervisor.ts:104` | [glossary](../glossary.md#1-seat-grain-posture) *names the reason, not the rule* | ? |
| `DELG-45` | Every rotation mint adds a fresh salt, so a token stays unique even if the generation counter is reset. | `mintRotationToken` — `packages/core/agent/channels/unified-supervisor.ts:191` | `docs/how-it-works/agent-and-loop.md#one-synthetic-channel-one-model-context` | ? |
| `DELG-46` | Every single-window wake fans into one synthetic unified channel, giving one literal model context across providers. | `UNIFIED_CHANNEL_NAME` — `packages/core/agent/channels/unified-supervisor.ts:20` | `docs/how-it-works/agent-and-loop.md#one-synthetic-channel-one-model-context` | ? |
| `DELG-47` | Every thread-seat close — completed, expired or closed — records how it ended, releases the thread only while it names that seat, and hands the thread back to the parent. | `closeThreadSeat` — `packages/core/agent/channels/thread-seat-close.ts:134` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-48` | An open thread seat whose thread had no message for three days is closed by the daily tidy pass with a hand-back, before the ownership TTL could drop it. | `sweepIdleThreadSeats` — `packages/core/agent/channels/thread-seat-close.ts:248` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-49` | A message routed to a thread seat moves its idle clock and its ownership row's TTL together, so an active thread never expires. | `touchThreadSeatActivity` — `packages/core/agent/channels/thread-seat-state.ts:108` | `docs/extending/chat-surface-contract.md#261-thread-ownership--who-a-threads-follow-up-wakes` | ? |
| `DELG-50` | A finished thread gets a done reaction on its root message where the surface codec names one; an expired or host-closed thread gets none. | `threadRootMessageOf` — `packages/core/agent/channels/thread-seat-close.ts:41` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-51` | `complete_thread` posts the completion in the thread when the seat did not post this turn: its report, or a fixed done line. | `completionPostFor` — `packages/core/agent/tools/complete_thread.ts:32` | `docs/extending/chat-surface-contract.md#262-the-thread-seat-lifecycle` | ? |
| `DELG-52` | The seat prompt states ONE routing decision: orchestrate a task through the seat's own work session, or hand its orchestration to a thread session. | `ROUTING_DECISION` — `packages/core/agent/instructions/seat-prompt.ts:869` | `docs/how-it-works/agent-and-loop.md` | ? |
| `DELG-53` | A DM seat reads a persona that names the direct message; a thread seat reads one that names its thread and its task. | `renderDmSeatPersona` — `packages/core/agent/instructions/seat-prompt.ts:938` | `docs/how-it-works/agent-and-loop.md` | ? |

## E. Routines, schedules and webhooks

92 behaviours, 0 UNDOCUMENTED. Owning pages: docs/capabilities/proactivity-and-routines.md · docs/extending/webhook-ingress.md.

| ID | Behaviour | Code | Documented by | Tested by |
|---|---|---|---|---|
| `ROUT-01` | The routine dispatcher ticks every 10 minutes, so no routine achieves a finer cadence. | `DISPATCH_TICK_MINUTES` — `packages/core/agent/routines/schedule.ts:46` | [capabilities/proactivity-and-routines.md#how-firing-works](../capabilities/proactivity-and-routines.md#how-firing-works) | ? |
| `ROUT-02` | Event and once triggers return no next run. Cron and interval step from the due anchor. | `computeNextRun` — `packages/core/agent/routines/schedule.ts:187` | `docs/capabilities/proactivity-and-routines.md#the-schedule-arithmetic` | ? |
| `ROUT-03` | Cron search scans 367 days minute-by-minute, then returns null as never-firing. | `nextCronAfter` — `packages/core/agent/routines/schedule.ts:123` | `docs/capabilities/proactivity-and-routines.md#the-schedule-arithmetic` | n/a: unannotated — lane F |
| `ROUT-04` | When day-of-month and day-of-week are both restricted, either matching fires (Vixie semantics). | `cronMatches` — `packages/core/agent/routines/schedule.ts:101` | `docs/capabilities/proactivity-and-routines.md#the-schedule-arithmetic` | ? |
| `ROUT-05` | A routine with null or unparseable nextRunAt is never due. | `isDue` — `packages/core/agent/routines/schedule.ts:205` | `docs/capabilities/proactivity-and-routines.md#the-schedule-arithmetic` | ? |
| `ROUT-06` | One tick sorts due routines most-overdue-first so newer routines cannot starve older ones. | `dispatchTick` — `packages/core/agent/schedules/dispatch.ts:151` | `docs/capabilities/proactivity-and-routines.md#one-dispatcher-tick` | n/a: unannotated — lane F |
| `ROUT-07` | At most 3 routine root sessions start per tick. Overflow stays due and unaudited. | `routineMaxConcurrency` — `packages/core/agent/schedules/dispatch.ts:77` | `docs/capabilities/proactivity-and-routines.md#one-dispatcher-tick` | n/a: unannotated — lane F |
| `ROUT-08` | A pre-fire skip retires a once routine with a declined marker in disabledReason. | `onceDisablePatch` — `packages/core/agent/schedules/dispatch.ts:108` | [capabilities/proactivity-and-routines](../capabilities/proactivity-and-routines.md#condition-gates) *names the reason, not the rule* | n/a: unannotated — lane F |
| `ROUT-09` | A break-glass halt covering the routine skips the fire, writes routine.skip reason halted, edits no row. | `routineFireHalted` — `packages/core/agent/routines/fire-halt.ts:33` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `routine.skip`, not the rule | ? |
| `ROUT-10` | A creator removed from the room or with a deactivated account skips the fire, never strikes it. | `checkFireEligibility` — `packages/core/agent/routines/fire-eligibility.ts:204` | `docs/capabilities/proactivity-and-routines.md#the-creator-must-still-be-there` | ? |
| `ROUT-11` | Every DM fire re-verifies the creator's internal standing live. Unverifiable binds external. | `recheckFireCreator` — `packages/core/agent/routines/fire-creator.ts:69` | `docs/capabilities/proactivity-and-routines.md#the-creator-must-still-be-there` | ? |
| `ROUT-12` | An unwired platform resolves null, so the fire dry-runs and the schedule does not advance. | `resolveRoutineTarget` — `packages/core/agent/schedules/routine-dispatch.ts:163` | `docs/capabilities/proactivity-and-routines.md#where-a-fire-posts-back` | n/a: unannotated — lane F |
| `ROUT-13` | Creation refuses a routine on a platform with no registered post-back resolver. | `canDispatchRoutinesOn` — `packages/core/agent/schedules/routine-dispatch.ts:192` | `docs/capabilities/proactivity-and-routines.md#where-a-fire-posts-back` | ? |
| `ROUT-14` | Collectors run then the gate decides, before any session starts or budget is spent. | `runPreFire` — `packages/core/agent/routines/pre-fire.ts:62` | `docs/capabilities/proactivity-and-routines.md#pre-fire-collection-and-the-gate-in-order` | ? |
| `ROUT-15` | If the pre-fire step itself throws, a gated routine fails closed and an ungated one fires. | `preFireFallback` — `packages/core/agent/routines/pre-fire.ts:126` | [capabilities/proactivity-and-routines](../capabilities/proactivity-and-routines.md#condition-gates) *names the reason, not the rule* | ? |
| `ROUT-16` | An unknown gate name, a throwing predicate, or a malformed verdict all fail closed. | `evaluateRoutineGate` — `packages/core/agent/routines/gate.ts:182` | `docs/capabilities/proactivity-and-routines.md#pre-fire-collection-and-the-gate-in-order` | ? |
| `ROUT-17` | Creation refuses a gate that names no collector, since an empty collection satisfies it vacuously. | `validateRoutineGate` — `packages/core/agent/routines/gate.ts:122` | `docs/capabilities/proactivity-and-routines.md#pre-fire-collection-and-the-gate-in-order` | ? |
| `ROUT-18` | A gated one-shot stays due at most 24 hours, then retires with a routine.disabled row. | `GATE_WAIT_MS` — `packages/core/agent/routines/gate.ts:229` | [capabilities/proactivity-and-routines.md#condition-gates](../capabilities/proactivity-and-routines.md#condition-gates) — names the action `routine.disabled`, not the rule | ? |
| `ROUT-19` | A routine declares at most 4 pre-run collectors. | `MAX_ROUTINE_COLLECTORS` — `packages/core/agent/routines/collector.ts:103` | `docs/capabilities/proactivity-and-routines.md#collector-limits` | ? |
| `ROUT-20` | An undeclared collector deadline is 10 seconds. A declared one caps at 60 seconds. | `COLLECTOR_DEFAULT_TIMEOUT_MS` — `packages/core/agent/routines/collector.ts:120` | `docs/capabilities/proactivity-and-routines.md#collector-limits` | n/a: unannotated — lane F |
| `ROUT-21` | A collected body over 4000 characters is truncated with a visible marker, never dropped silently. | `COLLECTOR_BODY_MAX_CHARS` — `packages/core/agent/routines/collector.ts:110` | `docs/capabilities/proactivity-and-routines.md#collector-limits` | ? |
| `ROUT-22` | Host-composed failure lines render outside the untrusted fence. Collected bodies render inside it. | `renderCollectedBlock` — `packages/core/agent/routines/collector.ts:478` | `docs/capabilities/proactivity-and-routines.md#collector-limits` | ? |
| `ROUT-23` | Writes a throttled routine.skip row carrying reason and a suppressed count. Fails open on store error. | `auditRoutineSkip` — `packages/core/agent/routines/fire-audit.ts:316` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `routine.skip`, not the rule | n/a: unannotated — lane F |
| `ROUT-24` | Skip rows are throttled to one per routine-and-reason per hour (3600000 ms). | `SKIP_WINDOW_MS` — `packages/core/agent/routines/fire-audit.ts:221` | `docs/capabilities/proactivity-and-routines.md#fire-audit-rows` | ? |
| `ROUT-25` | Clock-leg rows are stamped the synthetic principal routine:dispatcher, never the creator. | `ROUTINE_DISPATCHER_PRINCIPAL` — `packages/core/agent/routines/fire-audit.ts:236` | `docs/capabilities/proactivity-and-routines.md#fire-audit-rows` | ? |
| `ROUT-26` | A rejected delivery writes routine.fire_lost with sessionId null, since no session started. | `auditRoutineFireLost` — `packages/core/agent/routines/fire-audit.ts:413` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `routine.fire_lost`, not the rule | n/a: unannotated — lane F |
| `ROUT-27` | Routine forensics read a 7-day audit window, scanning at most 5000 rows. | `FORENSIC_WINDOW_MS` — `packages/core/agent/routines/fire-audit.ts:531` | `docs/capabilities/proactivity-and-routines.md#fire-audit-rows` | n/a: unannotated — lane F |
| `ROUT-28` | Three consecutive failed runs self-disable a routine. | `MAX_CONSECUTIVE_FAILURES` — `packages/core/agent/routines/lifecycle.ts:16` | [capabilities/proactivity-and-routines.md#when-the-outcome-fold-runs](../capabilities/proactivity-and-routines.md#when-the-outcome-fold-runs) | ? |
| `ROUT-29` | The three-failure streak must also span at least one hour (3600000 ms) before disabling. | `MIN_CONSECUTIVE_FAILURE_SPAN_MS` — `packages/core/agent/routines/lifecycle.ts:29` | [capabilities/proactivity-and-routines.md#when-the-outcome-fold-runs](../capabilities/proactivity-and-routines.md#when-the-outcome-fold-runs) | ? |
| `ROUT-30` | A skipped outcome never counts as a failure, and a once trigger is terminal after one fire. | `applyOutcome` — `packages/core/agent/routines/lifecycle.ts:89` | `docs/capabilities/proactivity-and-routines.md#outcomes-stalls-and-bounds` | ? |
| `ROUT-31` | Writes the routine.fire join row and routine.disabled only on the disable transition. | `foldRoutineOutcome` — `packages/core/agent/routines/outcome-fold.ts:70` | [security/audit-and-provenance.md#whats-logged](../security/audit-and-provenance.md#whats-logged) — names the action `routine.fire`, not the rule | ? |
| `ROUT-32` | Records lastStallAt once per fire and writes routine.stalled. Fail-soft, never blocking the refusal. | `recordCheckpointStall` — `packages/core/agent/routines/outcome-fold.ts:279` | [capabilities/proactivity-and-routines.md#durable-jobs-persistent-multi-step-work](../capabilities/proactivity-and-routines.md#durable-jobs-persistent-multi-step-work) — names the action `routine.stalled`, not the rule | ? |
| `ROUT-33` | Three consecutive checkpoint-blocked fires retire a bounded routine. | `MAX_STALLED_FIRES` — `packages/core/agent/routines/stall.ts:83` | `docs/capabilities/proactivity-and-routines.md#outcomes-stalls-and-bounds` | ? |
| `ROUT-34` | The stall dimension is checked before the fire cap and the deadline. An unparseable deadline is ignored. | `checkBound` — `packages/core/agent/routines/bound.ts:199` | `docs/capabilities/proactivity-and-routines.md#outcomes-stalls-and-bounds` | ? |
| `ROUT-35` | A fresh durable-job bound caps at 200 fires and 7 days, whichever comes first. | `DEFAULT_JOB_MAX_FIRES` — `packages/core/agent/routines/bound.ts:89` | `docs/capabilities/proactivity-and-routines.md#outcomes-stalls-and-bounds` | ? |
| `ROUT-36` | Writes routine.disabled carrying boundDimension, fireCount and stalledFires, then announces in-room. | `retireExhaustedRoutine` — `packages/core/agent/routines/outcome-fold.ts:226` | [capabilities/proactivity-and-routines.md#condition-gates](../capabilities/proactivity-and-routines.md#condition-gates) — names the action `routine.disabled`, not the rule | n/a: unannotated — lane F |
| `ROUT-37` | A self-disable posts a host-composed notice through the routine's own wake origin, fail-soft. | `announceSelfDisable` — `packages/core/agent/routines/disable-notice.ts:141` | [capabilities/proactivity-and-routines.md#silent-routines-postpolicy-never](../capabilities/proactivity-and-routines.md#silent-routines-postpolicy-never) | ? |
| `ROUT-38` | The `create_routine` tool TELLS the model to start a self-check-in about 1 minute out and back off to about 5 minutes. Nothing enforces either bound — see H.2. | `CHECK_IN_START_MS` — `packages/core/agent/routines/check-in.ts:38` | `docs/capabilities/proactivity-and-routines.md#the-self-check-in-doctrine-is-advice-not-a-bound` | ? |
| `ROUT-39` | A job-ledger write over 16 KiB UTF-8 is rejected outright rather than truncated. | `jobStateWithinCap` — `packages/core/agent/routines/job.ts:31` | `docs/capabilities/proactivity-and-routines.md#the-job-ledger-and-watch-state` | ? |
| `ROUT-40` | A tainted writing turn raises the routine's monotonic jobTainted flag, which is never lowered. | `applyJobStateObservation` — `packages/core/agent/routines/job.ts:58` | `docs/capabilities/proactivity-and-routines.md#the-job-ledger-and-watch-state` | ? |
| `ROUT-41` | A watch whose state hash is unchanged records outcome skipped and posts nothing. | `applyWatchObservation` — `packages/core/agent/routines/watch.ts:229` | `docs/capabilities/proactivity-and-routines.md#the-job-ledger-and-watch-state` | ? |
| `ROUT-42` | A silent routine ends its turn with NO_REPLY and nothing is posted. | `WATCH_SILENCE_SENTINEL` — `packages/core/agent/routines/watch.ts:29` | `docs/capabilities/proactivity-and-routines.md#the-job-ledger-and-watch-state` | ? |
| `ROUT-43` | A silent routine's terminal prose is dropped with a distinct reason separate from an empty message. | `SILENT_ROUTINE_DROP_REASON` — `packages/core/agent/routines/report.ts:42` | `docs/capabilities/proactivity-and-routines.md#the-job-ledger-and-watch-state` | ? |
| `ROUT-44` | A routine carries at most 10 follow-ups. The oldest is evicted and the eviction is reported. | `MAX_ROUTINE_FOLLOW_UPS` — `packages/core/agent/routines/follow-ups.ts:60` | `docs/capabilities/proactivity-and-routines.md#follow-ups-and-standing-rules` | ? |
| `ROUT-45` | A routine carries at most 20 standing rules, each capped at 300 characters, refused at the cap. | `POLICY_MAX_RULES` — `packages/core/agent/routines/policy.ts:107` | `docs/capabilities/proactivity-and-routines.md#follow-ups-and-standing-rules` | ? |
| `ROUT-46` | A routine's own fire may never add or remove its own standing rules. | `policyAuthorRefusal` — `packages/core/agent/routines/policy.ts:188` | `docs/capabilities/proactivity-and-routines.md#follow-ups-and-standing-rules` | ? |
| `ROUT-47` | A redelivered event with the same source-scoped delivery id inside 10 minutes is dropped as a replay. | `DELIVERY_DEDUPE_TTL_MS` — `packages/core/agent/routines/ingress.ts:128` | `docs/capabilities/proactivity-and-routines.md#event-ingress--de-duplication-fan-out-and-matching` | n/a: unannotated — lane F |
| `ROUT-48` | Order is normalize, then dedupe, then capture, then fan out. An unmodelled event burns no dedupe slot. | `admitTrigger` — `packages/core/agent/routines/ingress.ts:777` | `docs/capabilities/proactivity-and-routines.md#event-ingress--de-duplication-fan-out-and-matching` | ? |
| `ROUT-49` | One inbound event fans out to at most 3 routines. Over-cap matches are dropped and audited fanout_cap. | `eventMaxFanOut` — `packages/core/agent/routines/ingress.ts:122` | `docs/capabilities/proactivity-and-routines.md#event-ingress--de-duplication-fan-out-and-matching` | n/a: unannotated — lane F |
| `ROUT-50` | Every evaluation failure returns a verdict, never an exception, so one bad row cannot abort the fan-out. | `evaluateSubscription` — `packages/core/agent/routines/event-match.ts:163` | `docs/capabilities/proactivity-and-routines.md#event-ingress--de-duplication-fan-out-and-matching` | ? |
| `ROUT-51` | A subscription to a container-proving source must narrow its scope in the filter or is refused. | `validateSubscription` — `packages/core/agent/routines/event-match.ts:116` | `docs/capabilities/proactivity-and-routines.md#event-ingress--de-duplication-fan-out-and-matching` | ? |
| `ROUT-52` | A declared readableBy short-circuits the scope adapter. No adapter, no scope or unresolvable all refuse. | `checkEventReadGrant` — `packages/core/agent/routines/event-authz.ts:217` | `docs/capabilities/proactivity-and-routines.md#event-ingress--de-duplication-fan-out-and-matching` | ? |
| `ROUT-53` | A stored jq filter expression is capped at 1000 characters. | `FILTER_MAX_LENGTH` — `packages/core/agent/routines/jq-filter.ts:126` | `docs/capabilities/proactivity-and-routines.md#the-jq-filter` | ? |
| `ROUT-54` | Create-time probes take the fastest of 3 timed runs against a 250 ms budget. | `probeFilter` — `packages/core/agent/routines/jq-filter.ts:363` | `docs/capabilities/proactivity-and-routines.md#the-jq-filter` | n/a: unannotated — lane F |
| `ROUT-55` | The subscription-liveness stamp coalesces to one write per routine per minute. | `MATCH_STAMP_WINDOW_MS` — `packages/core/agent/routines/match-stamp.ts:80` | `docs/capabilities/proactivity-and-routines.md#the-jq-filter` | n/a: unannotated — lane F |
| `ROUT-56` | A triggered fire on a windowed domain is a work request into the work session (`routines/fire-work.ts`). A fire whose auth names no surface keeps the native send; the thread-seat fire is retired (OPE-2350). | `divertTriggeredFire` — `packages/core/agent/routines/fire-window.ts:62` | `docs/capabilities/proactivity-and-routines.md#how-a-triggered-fire-is-seated-and-scoped` | ? |
| `ROUT-57` | The dispatcher writes routine.fire_attrs_sent with key names only, never attribute values. | `FIRE_ATTRS_SENT_ACTION` — `packages/core/agent/routines/fire-carriage.ts:47` | [capabilities/proactivity-and-routines.md#silent-routines-postpolicy-never](../capabilities/proactivity-and-routines.md#silent-routines-postpolicy-never) — names the action `routine.fire_attrs_sent`, not the rule | n/a: unannotated — lane F |
| `ROUT-58` | A routine's partition is derived from its stored surfaceKey, with no live session binding. | `routinePartition` — `packages/core/agent/routines/partition.ts:15` | `docs/capabilities/proactivity-and-routines.md#how-a-triggered-fire-is-seated-and-scoped` | ? |
| `ROUT-59` | An unparseable oe-routine permission key arms nothing — fail-closed. | `routinePermissionKeyParts` — `packages/core/agent/routines/permission-key.ts:34` | `docs/capabilities/proactivity-and-routines.md#how-a-triggered-fire-is-seated-and-scoped` | ? |
| `ROUT-60` | A fire waits at most 120 seconds on a permission card inside the 300-second function wall. | `ROUTINE_CARD_WAIT_CEILING_SECONDS` — `packages/core/agent/routines/permission-card-wait.ts:71` | `docs/capabilities/proactivity-and-routines.md#how-a-triggered-fire-is-seated-and-scoped` | ? |
| `ROUT-61` | The daily 04:00 UTC tidy pass writes a memory.tidy_tick heartbeat row per org, even on a no-op. | `tidyTick` — `packages/core/agent/schedules/tidy.ts:97` | [deploy/rollback.md#store-identity](../deploy/rollback.md#store-identity) — names the action `memory.tidy_tick`, not the rule | ? |
| `ROUT-62` | The weekly Monday 05:00 UTC digest writes dream.mode3_tick per org, so a quiet week differs from a dead cron. | `mode3Tick` — `packages/core/agent/schedules/dream-mode3.ts:263` | [deploy/rollback.md#store-identity](../deploy/rollback.md#store-identity) — names the action `dream.mode3_tick`, not the rule | ? |
| `ROUT-63` | Swept orgs come from the setting `schedules.sweepOrgs` (was OE_TIDY_ORGS until OPE-2411), shipped as the single org "default". | `tidyOrgs` — `packages/core/agent/schedules/tidy.ts:57` | `docs/capabilities/proactivity-and-routines.md#how-a-triggered-fire-is-seated-and-scoped` | n/a: unannotated — lane F |
| `ROUT-64` | Fail-closed order: unknown id 404, oversize 413, no verifier 401, floor 401, no key 401, bad signature 401. | `gateWebhookDelivery` — `packages/core/agent/webhooks/gate.ts:244` | `docs/extending/webhook-ingress.md#9-the-delivery-gate-in-order` | ? |
| `ROUT-65` | A webhook body over 256 KiB (262144 bytes) is rejected 413 before any verification. | `webhookMaxBodyBytes` — `packages/core/agent/webhooks/gate.ts:79` | [deploy/configuration-reference.md#webhook-triggers](../deploy/configuration-reference.md#webhook-triggers) | ? |
| `ROUT-66` | Signed-timestamp freshness tolerates 300 seconds of skew, deployment-wide. | `webhookMaxSkewSeconds` — `packages/core/agent/webhooks/gate.ts:98` | [deploy/configuration-reference.md#webhook-triggers](../deploy/configuration-reference.md#webhook-triggers) | ? |
| `ROUT-67` | The local-dev unverified hatch applies only to env-homed hooks with no resolvable key. | `acceptedUnverified` — `packages/core/agent/webhooks/gate.ts:178` | `docs/extending/webhook-ingress.md#9-the-delivery-gate-in-order` | ? |
| `ROUT-68` | Authentication strength is an ordered ladder: unverified, signed, signed-fresh. | `WEBHOOK_AUTH_GRADES` — `packages/core/agent/webhooks/verifier.ts:295` | [extending/webhook-ingress](../extending/webhook-ingress.md#4d-authfloor-how-strongly-a-delivery-must-be-authenticated) *names the reason, not the rule* | ? |
| `ROUT-69` | A hook declaring an authFloor above its scheme's ceiling refuses every delivery forever. | `meetsWebhookAuthFloor` — `packages/core/agent/webhooks/verifier.ts:316` | `docs/extending/webhook-ingress.md#9-the-delivery-gate-in-order` | ? |
| `ROUT-70` | A de-selected provider bundle registers no verifier, so its hooks fail closed at resolution. | `registerWebhookVerifier` — `packages/core/agent/webhooks/verifier.ts:218` | [extending/provider-bundles.md#event-ingress-plane](../extending/provider-bundles.md#event-ingress-plane) | ? |
| `ROUT-71` | An unresolvable or empty current secret discards every previous rotation key too, yielding a 401. | `resolveHookKeys` — `packages/core/agent/webhooks/secrets.ts:48` | `docs/extending/webhook-ingress.md#9-the-delivery-gate-in-order` | ? |
| `ROUT-72` | Replay nonces are retained for two skew widths plus 60 seconds — 660 seconds by default. | `webhookReplayNonceTtlMs` — `packages/core/agent/webhooks/replay-dedupe.ts:73` | `docs/extending/webhook-ingress.md#replay-refusal` | ? |
| `ROUT-73` | A replayed signed delivery inside the retention window is refused. A store error fails open. | `firstSightingOfWebhookDelivery` — `packages/core/agent/webhooks/replay-dedupe.ts:121` | `docs/extending/webhook-ingress.md#replay-refusal` | ? |
| `ROUT-74` | Replay nonces are namespaced per hook id, so two hooks sharing a secret never collide. | `webhookReplayStoreKey` — `packages/core/agent/webhooks/replay-dedupe.ts:87` | `docs/extending/webhook-ingress.md#replay-refusal` | ? |
| `ROUT-75` | The caller sees a constant "delivery refused". The full reason goes only to the audit row. | `REPLAYED_DELIVERY_CALLER_BODY` — `packages/core/agent/webhooks/replay-dedupe.ts:183` | `docs/extending/webhook-ingress.md#replay-refusal` | ? |
| `ROUT-76` | Writes a throttled webhook.rejected row. An unknown hook id logs under synthetic workspace and surface. | `auditWebhookRejection` — `packages/core/agent/webhooks/reject-audit.ts:86` | [extending/webhook-ingress.md#issuing-and-rotating-the-secret](../extending/webhook-ingress.md#issuing-and-rotating-the-secret) — names the action `webhook.rejected`, not the rule | ? |
| `ROUT-77` | Rejection rows throttle to one per hook-and-status per 60 seconds, ids truncated to 100 characters. | `REJECTION_WINDOW_MS` — `packages/core/agent/webhooks/reject-audit.ts:35` | `docs/extending/webhook-ingress.md#replay-refusal` | ? |
| `ROUT-78` | Skew is checked before any HMAC, and any listed v1 signature may match any configured key. | `standardWebhookVerifier` — `packages/core/agent/webhooks/oe-standard-webhook.ts:293` | `docs/extending/webhook-ingress.md#the-standard-webhooks-verifier` | ? |
| `ROUT-79` | The nonce hashes the signed webhook-id only. The timestamp is deliberately excluded. | `standardWebhookReplayKey` — `packages/core/agent/webhooks/oe-standard-webhook.ts:243` | [capabilities/proactivity-and-routines](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers) *names the reason, not the rule* | ? |
| `ROUT-80` | Minted secrets are whsec_ plus 33 random bytes, base64 with no padding. | `mintStandardWebhookSecret` — `packages/core/agent/webhooks/oe-standard-webhook.ts:218` | `docs/extending/webhook-ingress.md#the-standard-webhooks-verifier` | ? |
| `ROUT-81` | Three disclosure postures exist: trigger-only, content-bearing, projection. | `WEBHOOK_POSTURES` — `packages/core/agent/webhooks/config.ts:80` | [capabilities/proactivity-and-routines](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers) *names the reason, not the rule* | n/a: unannotated — lane F |
| `ROUT-82` | A projection hook with an empty key list withholds the payload rather than widening to the raw body. | `configHookDisclosure` — `packages/core/agent/webhooks/config.ts:290` | `docs/extending/webhook-ingress.md#10-what-a-fire-may-disclose-store-and-spend` | ? |
| `ROUT-83` | A guest audience floor declines the fire with a constant webhook.declined reason naming the fix. | `WEBHOOK_AUDIENCE_FLOOR_REASON` — `packages/core/agent/webhooks/dispatch.ts:194` | [capabilities/proactivity-and-routines.md#inbound-webhook-triggers](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers) — names the action `webhook.declined`, not the rule | ? |
| `ROUT-84` | A webhook fire is spend-capped with no admin bypass, since no human asked for it. | `fireWebhook` — `packages/core/agent/webhooks/dispatch.ts:205` | `docs/extending/webhook-ingress.md#10-what-a-fire-may-disclose-store-and-spend` | n/a: unannotated — lane F |
| `ROUT-85` | A capture window defaults to 15 minutes and is clamped between 1 second and 60 minutes. | `captureDeadline` — `packages/core/agent/webhooks/capture-window.ts:128` | `docs/extending/webhook-ingress.md#10-what-a-fire-may-disclose-store-and-spend` | ? |
| `ROUT-86` | Arming a capture window on a trigger-only hook is refused as a storage back door. | `refuseCaptureArm` — `packages/core/agent/webhooks/capture-window.ts:141` | [capabilities/proactivity-and-routines](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers) *names the reason, not the rule* | ? |
| `ROUT-87` | A redacted event is never stored, and a document over 16384 characters is dropped, not truncated. | `captureDocument` — `packages/core/agent/webhooks/capture-window.ts:213` | `docs/extending/webhook-ingress.md#10-what-a-fire-may-disclose-store-and-spend` | ? |
| `ROUT-88` | A webhook-secret reveal link lives 15 minutes and is single-use. | `REVEAL_GRANT_TTL_MS` — `packages/core/agent/webhooks/reveal-page.ts:113` | `docs/extending/webhook-ingress.md#10-what-a-fire-may-disclose-store-and-spend` | ? |
| `ROUT-89` | Redemption writes webhook.secret_revealed under platform web, principal the bound asker. | `handleRevealPost` — `packages/core/agent/webhooks/reveal-page.ts:347` | [extending/webhook-ingress.md#issuing-and-rotating-the-secret](../extending/webhook-ingress.md#issuing-and-rotating-the-secret) — names the action `webhook.secret_revealed`, not the rule | ? |
| `ROUT-90` | A captured handshake secret is logged only as the first 8 hex characters of its sha256. | `secretFingerprint` — `packages/core/agent/webhooks/handshake-capture.ts:75` | `docs/extending/webhook-ingress.md#10-what-a-fire-may-disclose-store-and-spend` | ? |
| `ROUT-91` | An emit-only hook's read-grant reach is inert, never a refusal, because no room can be tested. | `webhookReach` — `packages/core/agent/webhooks/achievability.ts:225` | `docs/extending/webhook-ingress.md#10-what-a-fire-may-disclose-store-and-spend` | ? |
| `ROUT-92` | A key is minted only for schemes that are receiver-minted shared-secret and have a normalizer. | `mintableSourceVocabulary` — `packages/core/agent/webhooks/source-vocabulary.ts:227` | [extending/webhook-ingress](../extending/webhook-ingress.md#5-what-decides-whether-we-can-mint-a-sources-secret) *names the reason, not the rule* | ? |

## F. Memory

60 behaviours, 0 UNDOCUMENTED. Owning pages: docs/capabilities/memory.md · docs/extending/memory-backings.md.

| ID | Behaviour | Code | Documented by | Tested by |
|---|---|---|---|---|
| `MEM-01` | An mpim group chat gets no memory at all — execution only, zero reads and zero writes. | `resolveMemoryPlan` — `packages/core/agent/memory/resolve.ts:106` | [capabilities/proactivity-and-routines.md#two-refusals](../capabilities/proactivity-and-routines.md#two-refusals) | ? |
| `MEM-02` | A DM writes only its own personal silo. Shared domain silos are added read-only, so DMs never feed shared memory. | `resolveMemoryPlan` — `packages/core/agent/memory/resolve.ts:106` | [capabilities/memory.md#dm-and-personal-memory](../capabilities/memory.md#dm-and-personal-memory) | ? |
| `MEM-03` | The trust gate runs before domain lookup: an external or guest channel routes to the public pseudo-domain, read-only. | `resolveMemoryPlan` — `packages/core/agent/memory/resolve.ts:106` | [capabilities/memory.md#the-trust-gate-the-security-keystone](../capabilities/memory.md#the-trust-gate-the-security-keystone) | ? |
| `MEM-04` | External sessions never persist into shared memory — the returned plan's writes list is always empty. | `resolveMemoryPlan` — `packages/core/agent/memory/resolve.ts:106` | [capabilities/memory.md#the-trust-gate-the-security-keystone](../capabilities/memory.md#the-trust-gate-the-security-keystone) | ? |
| `MEM-05` | A grouping-only domain with no silo does not fall through to the org default. Resolution stops at one hop. | `resolveMemoryPlan` — `packages/core/agent/memory/resolve.ts:106` | [deploy/surfaces/teams](../deploy/surfaces/teams.md#gotchas) | ? |
| `MEM-06` | A DM's surface-tier reads and writes are hard-pinned to the DB provider, never git or Notion. | `surfaceProvider` — `packages/core/agent/memory/resolve.ts:53` | `docs/capabilities/memory.md#how-a-plan-resolves--the-rules-behind-the-composition` | ? |
| `MEM-07` | A silo named by two domains resolves to no owning credential, falling back to the org default rather than an arbitrary owner. | `siloAccess` — `packages/core/agent/memory/resolve.ts:169` | `docs/capabilities/memory.md#how-a-plan-resolves--the-rules-behind-the-composition` | ? |
| `MEM-08` | A domain's memory may be a list. Each named silo materialises into its own sandbox directory and is never merged. | `memoryRefs` — `packages/core/agent/memory/domain.ts:231` | `docs/capabilities/memory.md#how-a-plan-resolves--the-rules-behind-the-composition` | n/a: unannotated — lane F |
| `MEM-09` | Config load fails loud when a silo has no provider, or sets both select and recursive. | `assertSilosValid` — `packages/core/agent/memory/silo.ts:47` | `docs/capabilities/memory.md#how-a-plan-resolves--the-rules-behind-the-composition` | ? |
| `MEM-10` | A silo with recursive false defaults to include-only selection. Otherwise the whole subtree recurses. | `normalizeSelection` — `packages/core/agent/memory/selection.ts:62` | `docs/capabilities/memory.md#how-select-decides-what-materialises` | ? |
| `MEM-11` | Most-specific selection rule wins, and a rule strictly below a node forces descent to reach it. | `makeSelector` — `packages/core/agent/memory/selection.ts:67` | `docs/capabilities/memory.md#how-select-decides-what-materialises` | ? |
| `MEM-12` | Memory resolves at domain grain: a Discord thread keys to its parent channel, not its own surface key. | `domainKeyOf` — `packages/core/agent/memory/partition.ts:32` | `docs/capabilities/memory.md#grain-keys-and-names` | ? |
| `MEM-13` | The control plane's partition only reaches silo tiers. Workspace and surface tiers stay unreadable, fail-closed. | `controlPartition` — `packages/core/agent/memory/partition.ts:56` | `docs/capabilities/memory.md#grain-keys-and-names` | n/a: unannotated — lane F |
| `MEM-14` | A silo tier is keyed by silo name alone, so many domains referencing it share exactly one bucket. | `tierRelDir` — `packages/core/agent/memory/layout.ts:14` | `docs/capabilities/memory.md#grain-keys-and-names` | n/a: unannotated — lane F |
| `MEM-15` | Config-supplied names are sanitised to alphanumerics, dots, dashes and underscores, and truncated to 100 characters. | `safeName` — `packages/core/agent/memory/layout.ts:9` | `docs/capabilities/memory.md#grain-keys-and-names` | n/a: unannotated — lane F |
| `MEM-16` | Tier writes are upsert-only: omitting a file never removes it from the durable store. | `writeTier` — `packages/core/agent/memory/store.ts:118` | [extending/memory-backings.md#the-memoryprovider-interface](../extending/memory-backings.md#the-memoryprovider-interface) | ? |
| `MEM-17` | Deleting a git-backed tier leaves the bytes in commit history, so it is not true erasure. | `deleteTier` — `packages/core/agent/memory/store.ts:140` | [capabilities/memory](../capabilities/memory.md#opting-a-notion-silo-into-write-back) | n/a: unannotated — lane F |
| `MEM-18` | Tier version probing returns null when git is unavailable, rather than reading any file contents. | `tierVersion` — `packages/core/agent/memory/store.ts:93` | `docs/capabilities/memory.md#grain-keys-and-names` | ? |
| `MEM-19` | Trimming a section keeps the n newest bullets and returns the overflow for migration into the topic file. | `trimSectionToRecent` — `packages/core/agent/memory/markdown.ts:71` | `docs/capabilities/memory.md#what-the-file-layer-guarantees` | ? |
| `MEM-20` | A dangling wikilink still becomes an edge marked unresolved — intent is preserved rather than dropped. | `buildGraph` — `packages/core/agent/memory/graph.ts:118` | `docs/capabilities/memory.md#what-the-file-layer-guarantees` | ? |
| `MEM-21` | Silos that failed to materialise are named in the index as missing, so the agent never reads absent as empty. | `renderMemoryIndex` — `packages/core/agent/memory/listing.ts:157` | `docs/capabilities/memory.md#what-the-file-layer-guarantees` | ? |
| `MEM-22` | A Notion-backed silo is a read-only projected cache whose source of truth is updated through Notion's own tools. | `isProjectedCache` — `packages/core/agent/memory/readonly.ts:10` | [capabilities/memory.md#notion-a-read-only-hot-cache-by-default](../capabilities/memory.md#notion-a-read-only-hot-cache-by-default) | ? |
| `MEM-23` | A writable Notion silo is append-only: changing a line above the last is refused at persist. | `isAppendOnlyBacking` — `packages/core/agent/memory/readonly.ts:18` | [capabilities/memory.md#opting-a-notion-silo-into-write-back](../capabilities/memory.md#opting-a-notion-silo-into-write-back) | ? |
| `MEM-24` | A read-only tier is chmod'd a-w recursively so an edit fails loud with EACCES in the same turn. | `lockCommand` — `packages/core/agent/memory/readonly.ts:47` | `docs/capabilities/memory.md#what-the-file-layer-guarantees` | ? |
| `MEM-25` | The memory root unlock is re-locked in a finally, so a transport error never leaves it writable. | `withMemoryRootWritable` — `packages/core/agent/memory/root-fence.ts:40` | `docs/capabilities/memory.md#what-the-file-layer-guarantees` | ? |
| `MEM-26` | A write into a silo outside the session's plan is refused rather than re-routed, because unowned bytes are dropped silently. | `memoryWriteRefusal` — `packages/core/agent/memory/write-fence.ts:81` | `docs/capabilities/memory.md#what-the-file-layer-guarantees` | ? |
| `MEM-27` | An unreadable memory plan fails closed: the write is refused rather than allowed unchecked. | `assertMemoryWriteAllowed` — `packages/core/agent/memory/write-fence.ts:113` | `docs/capabilities/memory.md#what-the-file-layer-guarantees` | n/a: unannotated — lane F |
| `MEM-28` | RECURRING.md is host-owned: the sandbox snapshot never overlays it and it never counts as a conflict. | `HOST_OWNED_FILES` — `packages/core/agent/memory/host-owned-files.ts:3` | `docs/capabilities/memory.md#what-the-file-layer-guarantees` | n/a: unannotated — lane F |
| `MEM-29` | An admin direct write stamps an idempotent human-edit HTML comment, replacing any prior marker rather than stacking one. | `stampHumanEdit` — `packages/core/agent/memory/provenance.ts:7` | [capabilities/memory.md#purging-the-one-memory-verb](../capabilities/memory.md#purging-the-one-memory-verb) | ? |
| `MEM-30` | Files carrying the human-edit marker are the dream cycle's skip-set for destructive detection. | `humanEditedFiles` — `packages/core/agent/memory/provenance.ts:22` | [capabilities/memory.md#memory-hygiene-the-dream-cycle](../capabilities/memory.md#memory-hygiene-the-dream-cycle) | ? |
| `MEM-31` | Every bullet absent from the turn's baseline takes a provenance mark when the turn ingested external content. | `markAddedBullets` — `packages/core/agent/memory/provenance-mark.ts:291` | `docs/capabilities/memory.md#provenance-marks-on-what-a-turn-wrote` | ? |
| `MEM-32` | At most 4 ingestion kinds are named in one provenance mark. The rest collapse into a "+n more" tail. | `MAX_MARKED_KINDS` — `packages/core/agent/memory/provenance-mark.ts:38` | `docs/capabilities/memory.md#provenance-marks-on-what-a-turn-wrote` | ? |
| `MEM-33` | The unverified-claim attribution is INSERTED only. No word of the original bullet is dropped, moved or rewritten. | `recastAsAttributedClaim` — `packages/core/agent/memory/provenance-mark.ts:144` | `docs/capabilities/memory.md#provenance-marks-on-what-a-turn-wrote` | ? |
| `MEM-34` | A bullet under 3 letter-bearing words is a fragment and takes the suffix only, never the in-sentence hedge. | `MIN_ASSERTION_WORDS` — `packages/core/agent/memory/provenance-mark.ts:124` | `docs/capabilities/memory.md#provenance-marks-on-what-a-turn-wrote` | ? |
| `MEM-35` | Any rewrite holding fewer distinct provenance carriers than the before bytes is reverted per file. | `guardProvenanceMarks` — `packages/core/agent/memory/provenance-mark.ts:268` | `docs/capabilities/memory.md#provenance-marks-on-what-a-turn-wrote` | ? |
| `MEM-36` | On a merge the survivor inherits the FIRST disclosing source's carriers, not the strictest of several. | `conserveProvenanceOnMerge` — `packages/core/agent/memory/provenance-mark.ts:187` | `docs/capabilities/memory.md#provenance-marks-on-what-a-turn-wrote` | ? |
| `MEM-37` | Baselines store a 12-character sha1 of each trimmed line, so re-indenting a file never reads as new bullets. | `lineDigest` — `packages/core/agent/memory/provenance-mark.ts:205` | `docs/capabilities/memory.md#provenance-marks-on-what-a-turn-wrote` | ? |
| `MEM-38` | Purge audit rows carry a sha256 of each bullet plus its length, never the verbatim text. | `bulletSha256` — `packages/core/agent/memory/purge-redaction.ts:11` | [capabilities/memory.md#purging-the-one-memory-verb](../capabilities/memory.md#purging-the-one-memory-verb) | ? |
| `MEM-39` | Any durable surface shows a 12-character hash prefix plus char count instead of a purged bullet's content. | `redactedBulletLabel` — `packages/core/agent/memory/purge-redaction.ts:16` | [capabilities/memory.md#purging-the-one-memory-verb](../capabilities/memory.md#purging-the-one-memory-verb) | n/a: unannotated — lane F |
| `MEM-40` | Deletion audit measures membership, not position: a reorder or reformat records no removed lines. | `removedLineDigests` — `packages/core/agent/memory/purge-redaction.ts:49` | `docs/capabilities/memory.md#provenance-marks-on-what-a-turn-wrote` | ? |
| `MEM-41` | One purge may carry at most 25 distinct bullets. A broader phrase is refused as a fishing expedition. | `MAX_PURGE_BULLETS` — `packages/core/agent/tools/purge_memory.ts:58` | [capabilities/memory.md#purging-the-one-memory-verb](../capabilities/memory.md#purging-the-one-memory-verb) | ? |
| `MEM-42` | The purge sweep searches every writable silo and every file, so a fact cannot survive in an unnamed silo. | `findPurgeCandidates` — `packages/core/agent/tools/purge_memory.ts:69` | [capabilities/memory.md#purging-the-one-memory-verb](../capabilities/memory.md#purging-the-one-memory-verb) | ? |
| `MEM-43` | Purge needs a verified sender and a non-empty phrase. Zero matches throws and creates no pending row. | `planPurge` — `packages/core/agent/tools/purge_memory.ts:124` | [capabilities/memory.md#purging-the-one-memory-verb](../capabilities/memory.md#purging-the-one-memory-verb) | ? |
| `MEM-44` | A connector-owned memory backing must declare subject app-principal. Any user-subject token throws at registration. | `registerConnectorMemory` — `packages/core/agent/memory/connector-memory.ts:52` | [extending/memory-backings.md#connector-owned-memory](../extending/memory-backings.md#connector-owned-memory) | n/a: unannotated — lane F |
| `MEM-45` | Config load fails when a domain's connector-backed silo reaches past that domain's own connector and container grants. | `assertConnectorMemoryGrants` — `packages/core/agent/memory/connector-memory.ts:88` | `docs/capabilities/memory.md#the-connector-timing-and-wake-seams` | ? |
| `MEM-46` | Per-session memory sync timing writes one audit row under action memory.sync_timing, only when the env flag is set. | `MEMORY_SYNC_TIMING_ACTION` — `packages/core/agent/memory/sync-timing.ts:14` | [deploy/configuration-reference.md#observability](../deploy/configuration-reference.md#observability) — names the action `memory.sync_timing`, not the rule | ? |
| `MEM-47` | A timing row failing the taint allowlist is dropped with a warning rather than written — fail-closed on org data. | `emitMemorySyncTiming` — `packages/core/agent/memory/sync-timing.ts:204` | `docs/capabilities/memory.md#the-connector-timing-and-wake-seams` | n/a: unannotated — lane F |
| `MEM-48` | The wake delta filters memory.write rows to silos this session reads and drops rows this session wrote itself. | `selectChangedSilos` — `packages/core/agent/memory/wake-delta.ts:58` | [security/audit-and-provenance.md#properties-that-make-the-log-trustworthy](../security/audit-and-provenance.md#properties-that-make-the-log-trustworthy) — names the action `memory.write`, not the rule | ? |
| `MEM-49` | The wake delta emits silo names, paths and counts only — never memory-file content, which may be untrusted. | `formatMemoryDelta` — `packages/core/agent/memory/wake-delta.ts:93` | `docs/capabilities/memory.md#the-connector-timing-and-wake-seams` | ? |
| `MEM-50` | The delta is fail-soft: any audit read error resolves to null so a missing reminder never breaks a wake. | `renderMemoryDelta` — `packages/core/agent/memory/wake-delta.ts:118` | `docs/capabilities/memory.md#the-connector-timing-and-wake-seams` | ? |
| `MEM-51` | Only dedup, link-repair and salience-reorder auto-apply. Consolidate, contradiction, supersede and stale are proposed, never applied. | `SAFE_KINDS` — `packages/core/agent/memory/dream/ops.ts:17` | `docs/capabilities/memory.md#what-the-dream-cycle-may-do-by-itself` | ? |
| `MEM-52` | A dated bullet older than 180 days is flagged for review or archival, never deleted automatically. | `detectStale` — `packages/core/agent/memory/dream/ops.ts:297` | `docs/capabilities/memory.md#what-the-dream-cycle-may-do-by-itself` | ? |
| `MEM-53` | A survivor inherits a donor's disclosure only at token overlap 0.9 or above, with full containment and matching polarity. | `RESTATEMENT_THRESHOLD` — `packages/core/agent/memory/dream/ops.ts:237` | `docs/capabilities/memory.md#what-the-dream-cycle-may-do-by-itself` | ? |
| `MEM-54` | Each dream run puts at most 10 candidates before the judge — one judge call per surviving candidate. | `DEFAULT_CANDIDATE_CAP` — `packages/core/agent/memory/dream/candidates.ts:38` | `docs/capabilities/memory.md#what-the-dream-cycle-may-do-by-itself` | ? |
| `MEM-55` | A stale bullet with no later same-subject superseder is dropped, never judged. | `selectCandidates` — `packages/core/agent/memory/dream/candidates.ts:82` | `docs/capabilities/memory.md#what-the-dream-cycle-may-do-by-itself` | ? |
| `MEM-56` | A failed or unparseable judge verdict drops the candidate quietly rather than proposing it. | `tidySiloJudged` — `packages/core/agent/memory/dream/tidy.ts:97` | `docs/capabilities/memory.md#what-the-dream-cycle-may-do-by-itself` | ? |
| `MEM-57` | A destructive proposal writes a memory.proposal audit row carrying kind, scope, file and counts, never the before/after text. | `recordProposal` — `packages/core/agent/memory/dream/proposal.ts:27` | [security/audit-and-provenance.md#properties-that-make-the-log-trustworthy](../security/audit-and-provenance.md#properties-that-make-the-log-trustworthy) — names the action `memory.proposal`, not the rule | ? |
| `MEM-58` | One skill proposal carries at most 8 corrections, newest first, capped both per pull request and over the concatenation. | `MAX_CORRECTIONS` — `packages/core/agent/memory/dream/correction.ts:28` | `docs/capabilities/memory.md#what-the-dream-cycle-may-do-by-itself` | ? |
| `MEM-59` | Only OWNER, MEMBER or COLLABORATOR feedback becomes a correction. Bots and empty bodies are refused. | `correctionRefusal` — `packages/core/agent/memory/dream/correction.ts:61` | `docs/capabilities/memory.md#what-the-dream-cycle-may-do-by-itself` | ? |
| `MEM-60` | In-room admin memory reads and control-plane writes are capped at 64KB (65536 bytes). | `MEMORY_WRITE_MAX_BYTES` — `packages/core/agent/control/writes.ts:250` | `docs/capabilities/memory.md#what-the-dream-cycle-may-do-by-itself` | n/a: unannotated — lane F |
| `MEM-61` | A bullet rewrites the one already under its section that a caller's predicate matches, keeping its position; anything unmatched still appends. | `supersedeUnderSection` — `packages/core/agent/memory/markdown.ts:165` | `docs/capabilities/memory.md#writing-memory-files-not-a-verb` | ? |
| `MEM-62` | The one host road that supersedes keys on an EXACT workflow signature, never a similarity: a bullet with no signature, or a different one, always appends. | `enrichmentSignatureOf` — `packages/core/agent/memory/dream/learn.ts:248` | `docs/capabilities/memory.md#writing-memory-files-not-a-verb` | ? |

## G. The e2e scenario roster — what is currently proven

Derived BY HAND from `SCENARIOS` in `packages/core/scripts/e2e/scenarios.ts` — no script writes this
table, so a roster change reaches it only when someone carries it across, and the table does not
list every leg on the roster. This is the list the matrix's e2e cell draws on. EVERY scenario runs
on EVERY ship (OPE-1836): there is no optional tier and no dry-skip, and a leg that cannot run is
RED with its reason rather than absent.

Every column names a field of the scenario it describes — `Surface` is `surface`, `Suite` is
`suite`, `Smoke` is `smoke`, `Expensive` is `expensive`, `Judged` is `judged`. Add a column only for
a field the roster really has: a column naming a field the code deleted reads as a live tier, and a
reader takes it for one.

**`ID` is this page's stable id; `Scenario` is the roster id the code uses.** A scenario's `proves`
field cites behaviour-row `ID`s, and the matrix's e2e cell reports the `Scenario` value against
them. `scripts/env-docs-lint.ts` excludes
`docs/inventory/` outright (OPE-1780), so the `E2E-` prefix is belt-and-braces here.

| ID | Scenario | Surface | Suite | Smoke | Expensive | Judged | What it drives |
|---|---|---|---|---|---|---|---|
| `E2E-J1` | `J1` | slack | core | yes | — | yes | Slack core journey: wake+continuity, reply tool post, react, no_reply silence+revive, stop (absorbs S1/S2/S3/S21/S22) |
| `E2E-J2` | `J2` | slack | core | — | — | yes | Slack memory journey: teach→fresh-thread recall, cross-domain silo isolation, purge decide (absorbs S4/S12) |
| `E2E-S-MEM-READ` | `S-MEM-READ` | slack | core | — | — | — | Memory recall OPENS A FILE: asserted on reads + delegation evidence, not on reply text (OPE-121) |
| `E2E-J3` | `J3` | slack | core | — | — | yes | Slack governance journey: reject then INDEPENDENT approve, non-admin click denied, admin-tool refusal + admin listing (a |
| `E2E-S6` | `S6` | slack | core | — | — | — | /oe zero-inference (synthetic command) |
| `E2E-J-DISC` | `J-DISC` | discord | core | — | — | yes | Discord journey: mention → auto-thread → continuity → stop → post_file → card-shape (absorbs S7) |
| `E2E-S8` | `S8` | cross | core | — | — | yes | Cross-platform recall Slack→Discord (stretch, config-dependent) |
| `E2E-S9` | `S9` | slack | core | — | — | yes | Name-drop wake + negative control (optional) |
| `E2E-S10` | `S10` | slack | core | — | — | — | Spend-cap refusal = circuit breaker + the ingress DOOR it refused at (optional, fully deterministic) |
| `E2E-S11` | `S11` | slack | core | — | — | yes | Private channel: engagement + memory never feeds the shared tier |
| `E2E-S13` | `S13` | slack | core | — | — | yes | Real Slack DM: a genuine chat.postMessage through the driver's own token wakes the agent (OPE-1036 — no forged envelope) |
| `E2E-S14` | `S14` | slack | core | — | — | yes | DM personal memory: DM recall hits, channel recall misses |
| `E2E-S-LINK-SLACK` | `S-LINK-SLACK` | slack | core | — | — | — | Identity linking v2, Slack↔Slack: DM mints a code → a channel claim is REFUSED (DM-only venue) → the SECOND account clai |
| `E2E-J4` | `J4` | slack | core | — | — | yes | Slack access-request journey: propose card (tap+PR opt-in), DM refusal, out-of-vocab refusal (absorbs S17/S18) |
| `E2E-J-MPIM` | `J-MPIM` | slack | core | — | — | yes | Slack GROUP DM (mpim): a plain message in a group DM wakes the agent through the mpim door and is answered in that room  |
| `E2E-S20` | `S20` | slack | core | — | — | yes | Inbound webhook: a signed POST wakes a quoted reply; an unsigned POST is rejected and posts nothing (reply quality is RE |
| `E2E-S23` | `S23` | slack | core | — | — | yes | One-shot routine: create_routine(\"once\") acks now; the live fire is opt-in (dispatcher ticks every ~10 min) |
| `E2E-S24` | `S24` | slack | core | — | — | yes | Notion connector: search/read via the bound connector (optional — needs E2E_NOTION_CHANNEL bound to a live Notion creden |
| `E2E-J-TEAMS` | `J-TEAMS` | teams | core | yes | — | yes | Teams reply chain: @mention wake + relevant reply, non-mention admission asserted on the dispatch rows (mention gate OR  |
| `E2E-J-ENGAGED-teams` | `J-ENGAGED-teams` | teams | core | — | — | yes | Teams engaged seam (OPE-1500): an @mention engages the reply chain, a PLAIN follow-up wakes, stand_down marks the row, a |
| `E2E-J-TEAMS-DM` | `J-TEAMS-DM` | teams | core | — | — | yes | Teams 1:1 DM: a personal-scope Graph message wakes the bot and gets a reply — the DM plane's first live leg (OPE-972) |
| `E2E-J-GH` | `J-GH` | github | core | — | — | yes | GitHub ambient: @mention reply + eyes + mention-gate + resume + reply-targeting across two issues + forge (TODO(github-a |
| `E2E-J-LIN` | `J-LIN` | linear | core | — | — | yes | Linear ambient: @mention reply w/ self-attribution + literal-mention, self-loop, assign wake, reply-targeting across two |
| `E2E-J-NOT` | `J-NOT` | notion | core | — | — | — | Notion ambient: forge-replay on-topic anchor → reply; reply-targeting across two discussions; off-topic → audited silenc |
| `E2E-S-OWN-ACCOUNT-NOTION` | `S-OWN-ACCOUNT-NOTION` | notion | core | — | — | — | Own-account gate: a live 'use my own Notion account' ask REFUSES the team-key read (connector.acting_identity), with an  |
| `E2E-F-ART` | `F-ART` | slack | core | — | — | yes | Artifacts: post_file PNG + HTML attach + describe_image (attachment trusted fetch, sec-15 live twin) |
| `E2E-F-QA-REPO` | `F-QA-REPO` | slack | core | — | — | yes | Repo-backed browser QA: checkout_repo → the repo's own dev server → browser screenshot → describe_image on the shot → post_file to the thread, heading derived per run (OPE-2404) |
| `E2E-F-EDIT` | `F-EDIT` | slack | core | — | — | yes | Message-EDIT wake (<previous-body>): an xoxp edit of an engaged message wakes an edit-aware reply (live primary-model wa |
| `E2E-F-SEC` | `F-SEC` | slack | security | — | — | yes | Security probes: untrusted-content decline-or-disclose (P0-4, model-judgment — the old tainted-remember→card mechanism i |
| `E2E-J-SUP` | `J-SUP` | slack | core | — | — | — | Ambient supervisor smoke: plain non-mention → in-channel reply; no self-loop; off-topic → silence (THE pending live-smok |
| `E2E-J-UNIFIED` | `J-UNIFIED` | slack | core | — | — | yes | Unified cross-surface supervisor, Slack-only live path: unified-audit route contract + flag detection, ONE domain sessio |
| `E2E-J-UNI-X` | `J-UNI-X` | cross | core | — | — | yes | Unified cross-surface MONEY-SHOT (runnable pending a live cross-surface fixture): a Slack decision recalled on a GitHub  |
| `E2E-J-PR` | `J-PR` | cross | core | — | — | yes | Consequential PR write: Slack ask → open_pull_request → EITHER a pr.open card (nothing published pre-consent → admin app |
| `E2E-S-PR-SESSION` | `S-PR-SESSION` | cross | core | — | — | — | PR no-grant (OPE-2363): a pr.open card in a thread offers Approve and Reject only; after an approve, a second identical propose in the SAME thread gets a fresh card or a judge verdict, never a grant skip; teardown
| `E2E-S-PR-BOUNDARY` | `S-PR-BOUNDARY` | slack | security | — | — | yes | PR grant boundary: an ask to open a PR against an UNGRANTED repo is refused with no card (the fail-closed grant check ho |
| `E2E-S-AWS-BOUNDARY` | `S-AWS-BOUNDARY` | slack | security | — | — | yes | AWS grant boundary: an ungranted seat asking for `aws sts get-caller-identity` is refused fail-closed — no host executio |
| `E2E-J-WORKFLOW` | `J-WORKFLOW` | cross | core | — | — | yes | \"Someone at work\" chain: catch-up read → open a small PR (approve) → remember the decision → fresh-thread recall of it |
| `E2E-S-NOTION-WRITE` | `S-NOTION-WRITE` | notion | core | — | — | yes | Notion connector WRITE: create/update a page → the eve-native write approval gates (optional — needs the connector-write |
| `E2E-S-CONNECTOR-TIER` | `S-CONNECTOR-TIER` | notion | core | — | — | yes | Connector op tiering, live: a READ (notion__search) sails through with NO prompt while a WRITE (notion__create_page) pro |
| `E2E-S-DM-NOTION` | `S-DM-NOTION` | notion | core | — | — | yes | DM personal-Notion journey: a real DM through the front door wakes the seat on a Notion ask → real answer about the user |
| `E2E-S-PROVENANCE-DM` | `S-PROVENANCE-DM` | notion | core | — | — | — | Reply provenance, live (OPE-1717): a DM turn that READS through the Notion connector posts a reply whose footer names th |
| `E2E-S-EVE-CARD` | `S-EVE-CARD` | notion | core | — | — | — | the connector-write CARD, live (OPE-2340/OPE-2361): a DM connector WRITE never parks on eve's native `tool-approval`; it posts an OE `op.connector` card |
| `E2E-S-EVE-BRIDGE` | `S-EVE-BRIDGE` | notion | core | — | — | — | a bridged eve approval settled over TEXT (OPE-1721): a DM connector WRITE parks on eve's `tool-approval`, the unified qu |
| `E2E-S-CONNECT-CARD` | `S-CONNECT-CARD` | notion | core | — | — | — | Channel connector card: (A) a 'connect notion here' ask posts a card that is now API-KEY ONLY — the 'Set API key' button |
| `E2E-S-APIKEY-INTAKE` | `S-APIKEY-INTAKE` | notion | core | — | — | yes | API-key intake, live: under the db broker a 'connect notion with an API key' ask offers 'Set API key' → a forged admin o |
| `E2E-S-TAINT-DRYRUN` | `S-TAINT-DRYRUN` | slack | core | — | — | — | Taint source-tier table, ENFORCED (OPE-324): drive the divergent read shapes and assert `taint.verdict` rows land, appli |
| `E2E-S-TAINT-ROUTE-LIVE` | `S-TAINT-ROUTE-LIVE` | slack | core | — | yes | — | OPE-439/OPE-470/OPE-844: a REAL ingestion route (web_fetch, Notion, Linear, GitHub PR feedback) reaches the live approve |
| `E2E-S-TAINT-UNATTENDED-DENY` | `S-TAINT-UNATTENDED-DENY` | slack | core | — | — | — | OPE-452: a REAL unattended routine fire tries a gated action ⇒ the OPE-273 presence fence refuses it before the approval |
| `E2E-S-ROUTINE-CONNECTOR-WRITE` | `S-ROUTINE-CONNECTOR-WRITE` | notion | core | — | — | — | OPE-1328: an unattended routine fire attempts a CONNECTOR WRITE ⇒ the unattended connector fence refuses it (connector.r |
| `E2E-S-DISCORD-GRANT` | `S-DISCORD-GRANT` | discord | core | — | — | — | OPE-1310: a credential-grant ask raised to a DISCORD-owned account — the fixture the Discord grant-tap surface needs, plus |
| `E2E-J-ENGAGED-slack` | `J-ENGAGED-slack` | slack | core | — | — | — | Slack ADDRESSED-ONLY journey: mention → plain follow-up wakes → stand_down marks the row → audited silence (+ name-drop) |
| `E2E-J-ENGAGED-discord` | `J-ENGAGED-discord` | discord | core | — | — | — | Discord ADDRESSED-ONLY journey: mention → auto-thread → plain follow-up wakes → stand_down marks the row → audited silen |
| `E2E-J-ENGAGED-github` | `J-ENGAGED-github` | github | core | — | — | — | GitHub ADDRESSED-ONLY journey — mention engages the issue, a plain follow-up wakes, stand_down stops it |
| `E2E-J-ENGAGED-linear` | `J-ENGAGED-linear` | linear | core | — | — | — | Linear ADDRESSED-ONLY journey — the mention engages the issue and the plain-comment path carries the follow-up |
| `E2E-J-ENGAGED-notion` | `J-ENGAGED-notion` | notion | core | — | — | — | Notion ADDRESSED-ONLY journey — the name-drop is the address, and it engages the page |

## H. What the sweep found beside the rows

Three classes, each checked against the code at the base sha. A claim here names what was run.

### H.1 Contradictions — a page or a card says what the code does not do

**H.1.1 The parity roster sent a `post_file` reader to the wrong section. RESOLVED.**
`post_file` declared `section: "§4.11"`, which the contract gives as *What an UNATTENDED wake holds*
— the `JOB_WAKE_TOOLS` allow-list, not the file attach. Because §7.2's table is GENERATED from the
roster, the published table printed `` `post_file` §4.11 `` and the mis-citation reached every
reader. `packages/core/agent/identity/surface-parity.ts:147` now declares `section: "§7.4"` and
`docs/extending/chat-surface-contract.md:1173` prints `` `post_file` §7.4 ``. OPE-1799 also added
the dangling-pointer check to `scripts/surface-parity.ts`, so a roster row naming a heading the
contract does not have reds the gate instead of publishing. Filed as OPE-1799.

**H.1.2 The context-line slot was admission-policed on Slack only. RESOLVED (OPE-1800, OPE-1838).**
`docs/deploy/configuration-reference.md:206` states that `members-only` "admits only people the
trust plane vouched … keeping a guest's or a Connect stranger's words out of the seat", and that
admission "decides what the seat **reads** on a wake it is already taking". That read has two
halves, and they used to differ.

The SEAT CATCH-UP half is policed on all six surfaces. Every bundle passes
`admit: seatAdmissionFor(...)` into `seatCatchUp`, and `npm run test:seat-catch-up-parity` pins both
the registration and the call site per surface.

The CONTEXT-LINE half is policed by `admitContextLines`
(`packages/core/agent/channels/seat-admission.ts:101`), which had ONE production caller when this
sweep ran. OPE-1800 put Discord's two hydration roads and the GitHub and Linear supervisor wakes on
the same seam, so all four surfaces that fill the slot now pour through it; Teams and Notion fill no
context-line slot at all, so neither has a gap. OPE-1838 added what keeps it that way: the
`PAR-seat-context-admission` row above, where each surface declares its position, and
`npm run test:seat-admission-parity`, which asserts FILL implies CALL on every surface — a bundle
that pours into the slot without the road reds it. Filed as OPE-1800.

**H.1.3 The purge card promises an erasure a git-backed silo does not deliver.**
`packages/core/agent/tools/purge_memory.ts:178` puts this line in front of the approver: "This
ERASES the line(s) everywhere they are stored. It cannot be undone."
`packages/core/agent/memory/store.ts:136-138` and
`packages/core/agent/memory/purge-redaction.ts:2` both say the opposite for the git provider — the
pre-purge bytes stay in commit history, and "true erasure needs the SQL backings".
`docs/capabilities/memory.md:471` says purge "**erases** facts" and scopes its redaction promise to
the audit log only. The page does carry a backing-specific caveat at `docs/capabilities/memory.md:627`,
but it is the NOTION one — a writable Notion silo cannot be erased. The git-history caveat is the
one that reaches the reader nowhere. This is the retention-request path, so the approver is the
person who most needs the true answer. Filed as OPE-1801.

### H.2 Behaviour that is wired but cannot fire today

Not defects — each is a deliberate state the code states about itself — but each reads as a live
guarantee from the outside, so a docs author should know before writing it up.

| What | Why it cannot fire | Code |
|---|---|---|
| The `no-edit-arm` reply refusal | Every one of the six post arms defines `editMessage`, so no shipped surface can draw it. The gap moved to the LOCUS: `replyEditLocus` answers `null` for a Linear mention target and a workspace-less Notion target. `post-arms.ts`'s own "Two absences are PLATFORM LIMITS" sentence describes a registry state that no longer exists. | `packages/core/agent/channels/reply-edit.ts:31`, `packages/core/agent/channels/post-arms.ts:159` |
| The should-be-edit fold policy, per-surface half | The per-surface `reply` records its posts with no wake id, so every ring row is a target whose wake is unknown, and an unknown target never folds. The verdict on such a seat is always "no fold". | `packages/core/agent/tools/reply.ts:679`, `packages/core/agent/channels/reply-fold.ts:79` |
| `CHECK_IN_START_MS` / `CHECK_IN_CAP_MS` | No code path enforces the 1-minute floor or the 5-minute ceiling; the values reach the model only through the `CHECK_IN_DOCTRINE` prose. The dispatcher's own 10-minute tick cannot deliver a 1-minute check-in either. | `packages/core/agent/routines/check-in.ts:38` |

### H.3 Exports with no production caller outside their own module

Criterion, run at the base sha: `rg -l "\bSYMBOL\b" --glob '*.ts'` over the tree, minus `dist`,
minus `node_modules`, minus any path matching `test`, minus the `adapter-api.ts` barrel. These seven
are then mentioned exactly ONCE in their own file — the declaration — so nothing in this repo calls
them. Two of the seven, `classifyParticipation` and `isRegisteredReactionSurface`, are still
re-exported on the `adapter-api.ts` barrel, so an out-of-repo bundle can still reach them.
`npm run lint:dead` and `npm run lint:export-reach` accept all seven today, so this is a finding
about reach, not a broken gate.

| Symbol | File |
|---|---|
| `classifyParticipation` | `packages/core/agent/channels/engagement.ts:240` |
| `unifiedActionCapablePlatforms` | `packages/core/agent/channels/post-arms.ts:233` |
| `peekStandDownSilenceThisTurn` | `packages/core/agent/channels/stand-down-silence.ts:67` |
| `isRegisteredReactionSurface` | `packages/core/agent/channels/reaction-ingest.ts:73` |
| `effectiveEveToken` | `packages/core/agent/channels/unified-supervisor.ts:26` |
| `listProposals` | `packages/core/agent/memory/dream/proposal.ts:81` |
| `humanEditedAt` | `packages/core/agent/memory/provenance.ts:16` |

A second set is used inside its own file but reaches no other module: `approxMessageTokens`,
`foldTargetInTail`, `graphToJSON`, `formatDmSeatToken`, `isDmAnchoredTaskToken`,
`WEBHOOK_REPLAY_KEY_PREFIX`, `COLLECTED_BLOCK_TAG`, `FIRE_ATTRS_SEEN_ACTION`,
`unifiedSupervisorSentinel`, `domainFromSessionKey`. Each is an export a test needs; none is dead
code.

### H.4 Two pointers worth tightening

- The parity roster files `ancillary-ops` at `§4.9`, the `ack` section. `SurfaceMessageOps` is
  defined in **§5, The ancillary ops registry**, which is where a reader should land. §4.9 mentions
  the registry only in passing.
- Nine registration seams are universal across the six bundles but named in no cross-surface
  ledger: `registerProviderEvents`, `registerProviderDocs` and `registerSeatCatchUp` among them
  (section A.2). The parity roster names ten seam capabilities; the other twenty-nine seams a
  bundle can wire have no row anywhere, so an asymmetry in them is invisible until someone reads
  six `register.ts` files side by side. `registerRoutineDispatch` (discord, teams only) and
  `registerWebhookVerifier` (slack, github, notion only) are the two widest.

