import assert from "node:assert/strict";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
registerNotionProvider();
import {
  markNotionEngaged,
  notionEngagementAnchor,
  notionSeamPartition,
  resolveNotionEngagement,
  type NotionEngagementDeps,
  type NotionSeamFacts,
} from "../agent/channels/notion-engagement.js";
import type { EngagementRow, Partition } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const FACTS: NotionSeamFacts = {
  workspaceId: "WS_N",
  pageId: "PAGE_N",
  principalId: "u_n",
  credentialId: "cred-1",
};

function stubDeps(row: EngagementRow | null): NotionEngagementDeps & { reads: string[]; writes: { key: string; at: string }[]; seen: string[] } {
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
  surfaceKey: "notion/WS_N/PAGE_N",
  threadTs: "WS_N/PAGE_N",
  engagedAt: "2026-09-07T10:00:00.000Z",
  lastTurnAt: "2026-09-07T11:00:00.000Z",
  participating: true,
  silentStreak: 0,
  stopped: false,
  kind: "thread" as const,
  ...over,
});

ok(notionEngagementAnchor(FACTS) === "WS_N/PAGE_N", "1a: the anchor is `<workspace>/<page>` — the SAME derivation the mapper publishes as `anchorChannelId` and `engagementKey`");
ok(notionEngagementAnchor({ ...FACTS, pageId: undefined }) === undefined, "1b: NEGATIVE CONTROL — no page, no anchor (a partial key would let two under-identified deliveries collide)");
ok(notionEngagementAnchor({ ...FACTS, workspaceId: undefined }) === undefined, "1c: NEGATIVE CONTROL — no workspace, no anchor");

{
  const p = notionSeamPartition(FACTS);
  ok(p !== null && p.surfaceKey === "notion/WS_N/PAGE_N", "1d: the partition is the page surface key `resolvePartition` gives a bound Notion turn, which is what `stand_down` writes under");
  ok(notionSeamPartition({ ...FACTS, pageId: undefined }) === null, "1e: NEGATIVE CONTROL — no page, no partition");
}

{
  const a = notionEngagementAnchor(FACTS);
  const b = notionEngagementAnchor({ ...FACTS, principalId: "someone-else" });
  ok(a === b, "🔴 1f: the anchor does not vary with the commenter — it names the PAGE, so every discussion on it shares one engagement row");
  ok(notionEngagementAnchor({ ...FACTS, pageId: "PAGE_OTHER" }) !== a, "1g: NEGATIVE CONTROL — a different page is a different row, so the grain is the page and not the workspace");
}

{
  const deps = stubDeps(null);
  const v = await resolveNotionEngagement(FACTS, false, deps);
  ok(v.kind === "hold" && v.stopped === false, "2a: a plain comment on an UN-ENGAGED page HOLDS, and not as a stop — the domain opt-in then decides, exactly as before this seam");
  ok(deps.reads.length === 1 && deps.reads[0] === "WS_N/PAGE_N", "2b: …after ONE read, at the page anchor");
}

{
  const v = await resolveNotionEngagement(FACTS, false, stubDeps(engagedRow()));
  ok(v.kind === "deliver", "🔴 2c: a plain comment on an ENGAGED page DELIVERS — the follow-up that needs no second name-drop");
}

{
  const v = await resolveNotionEngagement(FACTS, false, stubDeps(engagedRow({ stopped: true })));
  ok(v.kind === "hold" && v.stopped === true, "🔴 2d: …unless the agent was asked to stand down on that page, which HOLDS with `stopped: true`");
}

{
  const v = await resolveNotionEngagement(FACTS, true, stubDeps(engagedRow()));
  ok(v.kind === "hold" && v.stopped === false, "🔴 2e: a machine-authored comment in an engaged page never delivers — the loop guard outranks engagement, and Notion's is load-bearing because the agent reads its own replies");
}

{
  const v = await resolveNotionEngagement({ ...FACTS, pageId: undefined }, false, stubDeps(engagedRow()));
  ok(v.kind === "unanchored", "2f: a delivery naming no page is UNANCHORED even with a row present");
}

{
  const deps = stubDeps(null);
  const anchor = await markNotionEngaged(FACTS, "cmt-1", deps);
  ok(anchor === "WS_N/PAGE_N", "3a: an addressed (name-drop) comment enrols the page and the mark returns its anchor");
  ok(deps.writes.length === 1 && deps.writes[0]!.key === "WS_N/PAGE_N", "🔴 3b: …writing the SAME key the read half asks for");
  ok(deps.writes[0]!.at === "2026-05-12T11:30:00.000Z", "3c: …stamped with the injected clock");
}

{
  const deps = stubDeps(null);
  await markNotionEngaged({ ...FACTS, pageId: undefined }, "cmt-1", deps);
  ok(deps.writes.length === 0, "3d: NEGATIVE CONTROL — an unanchored delivery writes nothing");
}

{
  const deps = stubDeps(null);
  await markNotionEngaged(FACTS, "cmt-1", deps);
  await markNotionEngaged(FACTS, "cmt-1", deps);
  ok(deps.writes.length === 1, "🔴 3e: a REDELIVERED comment marks NOTHING the second time — the guard keys on the comment id");
  ok(deps.seen.filter((k) => k === "notion-engage:WS_N/PAGE_N:cmt-1").length === 2, "3f: …and it asked the once-guard both times, so the dedupe is what refused rather than a missing call");
}

{
  const deps = stubDeps(null);
  await markNotionEngaged(FACTS, "cmt-1", deps);
  await markNotionEngaged(FACTS, "cmt-2", deps);
  ok(deps.writes.length === 2, "🔴 3g: NEGATIVE CONTROL — a SECOND, different comment marks again, so a real re-invitation still lands and still lifts a stop");
}

console.log(
  `✓ notion-engagement: ${n} assertions passed (page anchor + its grain pinned against the discussion + the decision table with a negative control on every boolean + the name-drop mark + its redelivery guard)`,
);
