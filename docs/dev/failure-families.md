# Failure families

Every defect ticket carries one `family`. The family says what KIND of failure the trajectory shows.
It is not the component, the surface, or the severity.

The families exist so two readers can count. A defect tracker can count open defects per family and
say "the tool-use family has six". No such reader exists in this tree yet. The eval lane mines
failed turns per family, and that one does: see
[evals mined from transcripts](./transcript-mined-evals.md).

🔴 **Nothing back-fills the tickets filed before this page.** They carry no family and none is added
to them. A per-family count is therefore a count of tickets filed since this convention landed, not
a count of the whole backlog. Say which when you report one.

**Never accept "the model got it wrong".** Read the failed trajectory and name the point that broke.
The family name is that second sentence.

## The list is evidence-only

Each family below names a real ticket or a real ship red on this repository, and quotes what was
measured. **Never add a family from priors.** A failure kind another product reports is not a family
here until a red on this repo shows it. The section "Families this repo does not have" at the end
records the two that did not earn a place, and why.

Every example describes a RED AS IT WAS MEASURED. Most are fixed. A family example is a specimen of
a failure shape, never a claim about how the product behaves today.

## The seven families

### `wake`

The door decided wrong, or it admitted the event and handed the turn a wake that misdescribes it.
An event that should have started a turn started none; an event that should have been dropped woke
one; or the wake reached the turn stripped of a fact the turn needed to judge it. Read the
`surface.wake_dropped` rows, which only Slack writes. There is no general admission row:
`surface.wake_admitted` fires only for the Slack DM-driver carve-out, which a real deployment leaves
off (`packages/core/agent/settings/settings.ts` calls it "TEST BEDS ONLY").

Example: OPE-1673, both halves. In a live run an `xoxp` edit of an engaged message produced no reply
in 180 s — the edit wake reached no turn. In a live run the wake did reach the turn and carried no
enrolment fact, so the seat declined the follow-up and its edit as `no_reply reason:"not_relevant"`
while the engagement row sat in the store the whole time
(`packages/providers/slack/scripts/slack-engagement-test.ts`).

### `delivery`

The reader got nothing and should have got something. The closing prose was dropped, the post
failed, the host refused it, or it arrived after the reader stopped waiting. This is the
`memberOutcome: "broken"` shape the soak rubric already scores. (`none` is the operator-only
outcome the phase-8 rotation claims; `packages/core/scripts/soak/soak-run-lib.ts:681` refuses it on
any surface but `operator`.)

Example: OPE-1704, group C. The 2026-09-10 cadence pack carried four 180 s reply-timeout reds —
J-GH, F-SEC, J-UNI-X and F-EDIT — worth 952 s of one run. Two waited on a GitHub issue and two on a
Slack thread. The ticket records the cause as unestablished: "load vs stall not measured". The
member outcome is not in doubt, and that is what the family counts.

`turn.supervisor_prose_dropped` counts the clearest member of this family, and it does not count it
cleanly. The row is written whenever a turn's closing text is structurally dropped on a supervisor
or unified channel. Its `replied: false` detail marks the real drop; `replied: true` is narration
after a real reply, which is benign and common (`packages/core/agent/channels/unified.ts:176`).
Read the detail, never the row count.

### `tool-use`

The model's tool call was wrong, or the tool contract it was given cannot express the job. A wrong
argument, a wrong reference, a wrong verb, or a tool whose result drops a field the caller needs.

Example: OPE-1686. `describe_image` ran in a live run and its audit row landed
`{"ok":false,"reason":"unknown-attachment","ref":"attachment:probe.png"}` — the ref the model passed
named no registry entry.

### `grounding`

A claim that no state supports. The reply asserts a success, an execution or a reason that no row
proves, or a tracked document asserts a property the code does not have. This is the fabrication
class, and the soak rubric already scores it: a confident claim the evidence does not support is a
`defect`, and an honest "I have no record of that" is `clean`.

Examples: OPE-1688 and OPE-1692, which this repo treats as ONE defect — the honest-ack rule in
`packages/core/agent/instructions/seat-prompt.ts:245` (`HONEST_ACK_SECTION`). Four measured reds are one defect, and the
shared defect is tense and source. S-AWS-BOUNDARY is the sharpest of the
four: the seat said "I've started the AWS identity check and will paste the complete output once it
returns", on a turn
that made no such execution and gets no later step. Second example, on the document side: OPE-1690 —
`docs/capabilities/connectors-and-providers.md` claimed "seven call sites" for GitHub reads and the
real count was eight.

### `containment`

An access, grant, fence or tenancy decision came out wrong. A pass that should have refused, or a
refusal that should have passed. A carve-in that routes but does not contain sits here too. ("Decision"
is deliberate: `docs/glossary.md` reserves "verdict" for the approver chain's four answers.)

Example: OPE-1680. Before the fence landed, the Slack interactivity CLICK branches read no tenant, so
a foreign workspace's approval click aliased an admitted approver.

### `lifecycle`

The host's own turn or session state machine lost a decision, raced, or spent an arm it still needed.
The model behaved; the machinery around the turn did not.

Example: OPE-1664. The fold gate used to count nothing once its refusal was spent, so a
refused-then-forced reply loop escaped the fourth arming arm.

### `harness`

The measuring apparatus failed, not the product. The gate read too early, the driver used a fixed
window, the fixture ran out of budget, or the sandbox recipe hung. A red in this family proves
nothing about the deployment.

Example: OPE-1682. The e2e J-MPIM gate read the `reply.post` row before it landed. The shipper read
the audit route and the row existed with the right key. The ticket says it plainly: "Not a product
red."

🔴 **This family is bigger than it looks, and it hides inside product-shaped reds.** OPE-1692's own
gate is the case to learn from: the `memory.write` row is appended at the PARENT turn's end and the
seat's ack is posted mid-turn, so a single read taken the instant the ack arrives "can therefore see
zero rows behind a write that really happened, which reds this gate on a healthy deployment"
(`packages/core/scripts/e2e/scenarios.ts`). The same red carried a real grounding defect underneath.
**A red can hold one of each. File the product half, and fix the instrument.**

## Choosing one family

A defect carries exactly ONE family. Read the trajectory, then take the first row that matches:

1. The measuring apparatus failed → `harness`.
2. An access, grant, fence or tenancy decision came out wrong → `containment`.
3. The host's turn or session state machine lost or mis-ordered a decision → `lifecycle`.
4. The door decided wrong, or the wake misdescribed the event → `wake`.
5. A tool call or a tool contract failed → `tool-use`.
6. A claim has no state behind it → `grounding`.
7. The reader got nothing and should have got something → `delivery`.

First match wins. The order is deliberate: `harness` comes first because a red from a broken
instrument says nothing about the product, and `delivery` comes last because it is the outcome every
earlier failure also produces.

**`family:unclassified` is allowed only while the trajectory is unread.** The TRIAGE stamp that
closes triage names a real family. A permanent "unknown" bucket is the habit this page removes.

## Which families the eval lane can mine

The eval lane mines seat transcripts ([the recipe](./transcript-mined-evals.md)). Only a family whose
failure happens inside a turn leaves one:

| Family | A seat transcript exists | Mine it for evals |
|---|---|---|
| `wake` | partly — the live-run half reached a turn, the live-run half did not | only the half a turn saw |
| `delivery` | yes | yes |
| `tool-use` | yes | yes |
| `grounding` | yes | yes |
| `containment` | sometimes — a wrong decision may be host-side only | only where a turn saw it |
| `lifecycle` | partly — the decision is lost outside the turn | no |
| `harness` | no — the defect is in the instrument | no |

## Where the family is written

- **The defect ticket body** carries `family: <name>` as its first line — one space after the colon.
  The maintainer's issue template carries it.
- **The TRIAGE stamp** carries a `family:<name>` clause immediately before `seq:` — no space, because
  the stamp's fields are pipe-separated and each is one token.
- **The soak cold review** carries the family on every RED row. A `concern` or a `defect` sets
  `family` to one of the seven above; `soak-review.ts blind` refuses any other word, refuses a
  family on a `clean` or `unscoreable` row, and refuses a red with no family. The run's report then
  carries `familyCounts` — one count per family plus `unclassified` — so a per-family count is a
  lookup rather than a human read. `packages/core/scripts/soak/soak-review-types.ts` holds the field
  and `packages/core/scripts/soak/oe-soak-reviewer.agent.md` holds the reviewer's rule.
- **The e2e red report** does not classify its reds yet. That half is NOT done — see below.

## What this page does not yet reach

The e2e red report still reports each red as free text, so only the soak tests' reds join the
tickets' per-family count. A red row written before OPE-1787 reads back as `family: "unclassified"`
and the soak report raises a `family-unclassified` protocol finding for it, so a legacy run
directory stays reviewable without its reds quietly leaving the count.

## Families this repo does not have

Both were candidates. Neither earned a place, and the reason is recorded so nobody re-proposes them
from memory.

**Search and synthesis / recall.** The two candidate tickets both closed STALE after passing three
consecutive core packs with no fix landed: OPE-1671 (DM personal-silo recall missed the taught token,
S14 red in a live run) and OPE-1672 (one mind across containers, J-UNIFIED red on the same ship). Both
reds were intermittent. **Add the family the day a recall red reproduces**, and cite that red here.

**Phrasing — a judged wording red where the product did the work.** This looks like a family and this
repo has already ruled it is not one. `packages/core/agent/instructions/seat-prompt.ts` folds the
four judged reply reds of two live runs into the honest-ack rule, in one block, "because four
measured reds are one defect": the shared defect is tense and source, not tone. So a reply the judge
refuses is `grounding` when the words outrun what the turn did, and `harness` when the judge read a fixture
artefact — OPE-1704 group A is that second case, where seven judged reply-quality reds all traced to a
budget-warning prefix on an over-cap e2e channel. **A judged red is never a family of its own; find
which of those two it is.**
