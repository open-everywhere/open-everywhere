import assert from "node:assert/strict";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
registerLinearProvider();
import {
  linearEngagementAnchor,
  linearPromptReAddress,
  linearSeamPartition,
  linearStandDownHolds,
  linearStandDownVerdict,
  markLinearEngaged,
  resolveLinearEngagement,
  type LinearEngagementDeps,
  type LinearSeamFacts,
} from "../agent/channels/linear-engagement.js";
import type { EngagementRow, Partition } from "@open-everywhere/core/agent/adapter-api.js";

import { tmpdir as __oeTmpdir } from "node:os";
import { join as __oeJoin } from "node:path";
import { rmSync as __oeRmSync } from "node:fs";
const __oeSuiteStoreDir = __oeJoin(__oeTmpdir(), `open-everywhere-suite-linear-engagement-${process.pid}`);
__oeRmSync(__oeSuiteStoreDir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = __oeJoin(__oeSuiteStoreDir, "ops.sqlite3");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const FACTS: LinearSeamFacts = {
  organizationId: "ORG_L",
  teamId: "TEAM_L",
  issueId: "ISSUE_L",
  principalId: "u_l",
  isPrivate: true,
};

function stubDeps(row: EngagementRow | null): LinearEngagementDeps & { reads: string[]; writes: { key: string; at: string }[]; seen: string[] } {
  const reads: string[] = [];
  const writes: { key: string; at: string }[] = [];
  const seen: string[] = [];
  return {
    reads,
    writes,
    seen,
    getEngagement: async (_p: Partition, key: string) => {
      reads.push(key);
      return row;
    },
    markEngaged: async (_p: Partition, key: string, atIso: string) => {
      writes.push({ key, at: atIso });
    },
    markEventSeen: async (_org: string, key: string) => {
      const first = !seen.includes(key);
      seen.push(key);
      return first;
    },
    now: () => "2026-05-12T11:30:00.000Z",
  };
}

const engagedRow = (over: Partial<EngagementRow> = {}): EngagementRow => ({
  org: "oe",
  surfaceKey: "linear/ORG_L/TEAM_L",
  threadTs: "ISSUE_L",
  engagedAt: "2026-09-07T10:00:00.000Z",
  lastTurnAt: "2026-09-07T11:00:00.000Z",
  participating: true,
  silentStreak: 0,
  stopped: false,
  kind: "thread" as const,
  ...over,
});

ok(linearEngagementAnchor(FACTS) === "ISSUE_L", "1a: the anchor is the ISSUE id — the container a Linear conversation is, and the value the mapper publishes as `engagementKey`");
ok(linearEngagementAnchor({ ...FACTS, issueId: undefined }) === undefined, "1b: NEGATIVE CONTROL — no issue, no anchor");
ok(linearEngagementAnchor({ ...FACTS, issueId: "" }) === undefined, "1c: NEGATIVE CONTROL — an empty issue id is not an anchor either");

{
  const p = linearSeamPartition(FACTS);
  ok(p !== null && p.surfaceKey === "linear/ORG_L/TEAM_L", "🔴 1d: the partition is the TEAM grain — the key `resolvePartition` gives a bound Linear turn, and therefore the one `stand_down` writes under");
  ok(linearSeamPartition({ ...FACTS, teamId: undefined }) === null, "1e: NEGATIVE CONTROL — no team, no partition (the caller then keeps today's path)");
  ok(linearSeamPartition({ ...FACTS, organizationId: undefined }) === null, "1f: NEGATIVE CONTROL — no workspace, no partition");
}

{
  const deps = stubDeps(null);
  const v = await resolveLinearEngagement(FACTS, false, deps);
  ok(v.kind === "hold" && v.stopped === false, "2a: a plain comment on an UN-ENGAGED issue HOLDS, and not as a stop — the domain opt-in then decides, exactly as before this seam");
  ok(deps.reads.length === 1 && deps.reads[0] === "ISSUE_L", "2b: …after ONE read, at the issue anchor");
}

{
  const v = await resolveLinearEngagement(FACTS, false, stubDeps(engagedRow()));
  ok(v.kind === "deliver", "🔴 2c: a plain comment on an ENGAGED issue DELIVERS — this is the follow-up Linear's one-shot mention flow cannot carry");
}

{
  const v = await resolveLinearEngagement(FACTS, false, stubDeps(engagedRow({ stopped: true })));
  ok(v.kind === "hold" && v.stopped === true, "🔴 2d: …unless the agent was asked to stand down on that issue, which HOLDS with `stopped: true`");
}

{
  const v = await resolveLinearEngagement(FACTS, true, stubDeps(engagedRow()));
  ok(v.kind === "hold" && v.stopped === false, "🔴 2e: a machine-authored comment in an engaged issue never delivers — the loop guard outranks engagement");
}

{
  const v = await resolveLinearEngagement({ ...FACTS, issueId: undefined }, false, stubDeps(engagedRow()));
  ok(v.kind === "unanchored", "2f: a delivery naming no issue is UNANCHORED even with a row present");
}

{
  const v = await resolveLinearEngagement({ ...FACTS, teamId: undefined }, false, stubDeps(engagedRow()));
  ok(v.kind === "unanchored", "2g: …and so is one whose team cannot be resolved, because the partition is half the key");
}

{
  const deps = stubDeps(null);
  const anchor = await markLinearEngaged(FACTS, "sess-1", deps);
  ok(anchor === "ISSUE_L", "3a: the mention leg's mark returns the issue it enrolled");
  ok(deps.writes.length === 1 && deps.writes[0]!.key === "ISSUE_L", "🔴 3b: …and writes the SAME key the comment leg reads — the two legs' join, and the thing a per-comment-thread mark would break");
  ok(deps.writes[0]!.at === "2026-05-12T11:30:00.000Z", "3c: …stamped with the injected clock");
}

{
  const deps = stubDeps(null);
  await markLinearEngaged({ ...FACTS, issueId: undefined }, "sess-1", deps);
  ok(deps.writes.length === 0, "3d: NEGATIVE CONTROL — an unanchored delivery writes nothing");
}

{
  const deps = stubDeps(null);
  await markLinearEngaged({ ...FACTS, organizationId: undefined }, "sess-1", deps);
  ok(deps.writes.length === 0, "3e: NEGATIVE CONTROL — and neither does one with no resolvable partition");
}

{
  const deps = stubDeps(null);
  await markLinearEngaged(FACTS, "sess-1", deps);
  await markLinearEngaged(FACTS, "sess-1", deps);
  ok(deps.writes.length === 1, "🔴 3f: a REDELIVERED Agent Session event marks NOTHING the second time — the guard keys on the session id");
  ok(deps.seen.filter((k) => k === "linear-engage:ISSUE_L:sess-1").length === 2, "3g: …and it asked the once-guard both times, so the dedupe is what refused rather than a missing call");
}

{
  const deps = stubDeps(null);
  await markLinearEngaged(FACTS, "sess-1", deps);
  await markLinearEngaged(FACTS, "sess-2", deps);
  ok(deps.writes.length === 2, "🔴 3h: NEGATIVE CONTROL — a SECOND, different Agent Session marks again, so a real re-invitation still lands and still lifts a stop");
}

{
  const deps = { ...stubDeps(null), markEventSeen: async () => true };
  const writes: string[] = [];
  const anchor = await markLinearEngaged(FACTS, "sess-1", {
    ...deps,
    markEngaged: async (_p: Partition, key: string) => {
      writes.push(key);
    },
  });
  ok(anchor === "ISSUE_L" && writes.length === 1, "3i: a guard that answers 'not seen' MARKS — the polarity, pinned. The store-error fail-open in `liveMarkEngageSeen` is unreached by any offline test");
}

{
  ok((await linearStandDownHolds(FACTS, stubDeps(engagedRow({ stopped: true })))) === "ISSUE_L", "🔴 4a: a STOPPED row answers with the anchor — this is what silences a reply in the agent's own thread");
  ok((await linearStandDownHolds(FACTS, stubDeps(engagedRow({ stopped: false })))) === null, "4b: NEGATIVE CONTROL — an engaged, un-stopped issue holds no stop, so the follow-up dispatches");
  ok((await linearStandDownHolds(FACTS, stubDeps(null))) === null, "4c: NEGATIVE CONTROL — an issue with NO row holds no stop either");

  const readsNull: LinearEngagementDeps = { getEngagement: async () => null };
  ok((await linearStandDownHolds(FACTS, readsNull)) === null, "4d: a read that answers `null` reads as NOT stopped — the polarity the fail-open rests on. The store-error catch itself is in core's `getThreadEngagement` and is unreached by any offline assertion here");

  ok((await linearStandDownHolds({ ...FACTS, issueId: undefined }, stubDeps(engagedRow({ stopped: true })))) === null, "4e: NEGATIVE CONTROL — no issue, no anchor, so nothing to have been stopped");
  ok((await linearStandDownHolds({ ...FACTS, teamId: undefined }, stubDeps(engagedRow({ stopped: true })))) === null, "4f: NEGATIVE CONTROL — no team, no partition, so no row to read");
}

{
  ok(linearPromptReAddress("@OpenEverywhere which token was posted?", "OpenEverywhere") === "mention", "🔴 5a: an explicit @mention of the app reads as `mention` — this is the act the stand-down ack promises brings the agent back");
  ok(linearPromptReAddress("and what's that plus 6?", "OpenEverywhere") === "none", "5b: NEGATIVE CONTROL — a comment that addresses nobody reads as `none`, so a plain follow-up still meets the stop");
  ok(linearPromptReAddress("@openeverywhere, please", "OpenEverywhere") === "mention", "5c: the match is case-insensitive — Linear renders the handle as the member typed it");
  ok(linearPromptReAddress("@OpenEverywhereElse ping", "OpenEverywhere") === "none", "🔴 5d: NEGATIVE CONTROL — a LONGER handle that merely starts with the app's name is NOT this app; without the word-boundary guard this reads `mention` and a stranger's handle lifts our stop");
  ok(linearPromptReAddress("mail openeverywhere@example.com", "OpenEverywhere") === "none", "5e: NEGATIVE CONTROL — the name without a leading `@` is not a mention");
  ok(linearPromptReAddress(undefined, "OpenEverywhere") === "unreadable", "🔴 5f: an unread comment body is `unreadable`, never `none` — the gate cannot report a question it did not ask");
  ok(linearPromptReAddress("", "OpenEverywhere") === "unreadable", "5g: an EMPTY body is unreadable for the same reason");
  ok(linearPromptReAddress("@OpenEverywhere hello", undefined) === "unreadable", "🔴 5h: no resolved app name is `unreadable` — nothing can detect a mention without the name to look for, the same precondition the ambient classifier states");
}

{
  const verdict = (action: string | undefined, anchor: string | null, reAddress: "mention" | "none" | "unreadable") => linearStandDownVerdict({ action, anchor, reAddress }).kind;

  ok(verdict("prompted", "ISSUE_L", "mention") === "lift", "🔴 6a: THE DEFECT ROW — a `prompted` delivery whose own comment @mentions the app LIFTS the stand-down. A live run suppressed exactly this and answered the member with the ack that told them to do it");
  ok(verdict("prompted", "ISSUE_L", "none") === "suppress", "🔴 6b: NEGATIVE CONTROL — a `prompted` follow-up that addresses nobody is still SUPPRESSED, so the lift is driven by the comment and not by the action");
  ok(verdict("prompted", "ISSUE_L", "unreadable") === "suppress", "🔴 6c: an UNREADABLE comment suppresses — lifting on an unanswered question would empty `stand_down` of meaning for as long as the comment read is broken");
  ok(verdict("prompted", null, "none") === "pass-through", "6d: NEGATIVE CONTROL — no stored stop, nothing to suppress; the delivery keeps its own path");
  ok(verdict("prompted", null, "mention") === "pass-through", "6e: NEGATIVE CONTROL — a mention on a LIVE issue is a pass-through, not a lift: there is no stop to clear");
  ok(verdict("created", "ISSUE_L", "none") === "pass-through", "🔴 6f: a `created` event is never gated here, stop or no stop — it marks on its own leg, and gating it would leave the surface no way back in at all");
  ok(verdict("updated", "ISSUE_L", "none") === "pass-through", "6g: NEGATIVE CONTROL — an unclassified future action stays ungated, the limit the parity cell records");
  ok(verdict(undefined, "ISSUE_L", "mention") === "pass-through", "6h: NEGATIVE CONTROL — an action-less delivery is not a `prompted` follow-up");
}

console.log(
  `✓ linear-engagement: ${n} assertions passed (issue anchor + team partition + the decision table with a negative control on every boolean + the mention leg's mark landing on the comment leg's key + the mark's redelivery guard + the agent-session legs' stop predicate and its null-reads-as-live polarity + the re-address read and the stand-down table that lifts on an explicit @mention)`,
);
