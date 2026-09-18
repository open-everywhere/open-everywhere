import assert from "node:assert/strict";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
registerNotionProvider();
import {
  firstNotionDispatchOfComment,
  markNotionEngaged,
  notionEngagementAnchor,
  notionSeamPartition,
  notionDispatchJoinDetail,
  notionWakeAddressing,
  notionWakeAuditDetail,
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

{
  ok(
    notionWakeAddressing("channel-watch", true) === "thread-follow",
    "🔴 4a: an ENGAGED follow-up reports `thread-follow` — the one value that tells an engaged wake from ambient chatter in the audit trail",
  );
  ok(
    notionWakeAddressing("channel-watch", undefined) === "channel-watch",
    "🔴 4b: NEGATIVE CONTROL — the SAME classifier value with no seam verdict stays `channel-watch`, so ambient chatter is never dressed as a follow-up",
  );
  ok(
    notionWakeAddressing("channel-watch", false) === "channel-watch",
    "4c: NEGATIVE CONTROL — an explicit `false` reads like an absent one, so a caller that always passes the field cannot promote by accident",
  );
  ok(
    notionWakeAddressing("direct", undefined) === "direct",
    "4d: an ADDRESSED comment reports `direct` — the value `reportedDirectMention` accepts for the name-drop leg",
  );
  ok(
    notionWakeAddressing("direct", true) === "direct",
    "🔴 4e: NEGATIVE CONTROL — the flag cannot demote an ADDRESSED comment to a follow-up, which is what would silently lose the name-drop leg's own evidence",
  );
}

{
  ok(
    notionWakeAuditDetail("direct", undefined, "container").via === "container",
    "🔴 5a: a name-drop admitted by a CONTAINER entry reports `container` — the one field that says the operator enumerated no page",
  );
  ok(
    notionWakeAuditDetail("direct", undefined, "roster").via === "roster",
    "🔴 5b: NEGATIVE CONTROL — the SAME name-drop on a LISTED page reports `roster`, so 5a measured the claim and not the addressing",
  );
  ok(
    notionWakeAuditDetail("channel-watch", true, "roster").via === "roster",
    "5c: an ENGAGED follow-up carries the origin too — the seam does not erase how the page was declared",
  );
  ok(
    notionWakeAuditDetail("channel-watch", true, undefined).via === "none",
    "🔴 5d: an ABSENT origin reads `none` — the conservative word, so a caller that omits the field cannot claim a declaration it never made",
  );
  ok(
    notionWakeAuditDetail("channel-watch", true, "container").addressing === "thread-follow",
    "🔴 5e: NEGATIVE CONTROL — the origin does not disturb what woke it, so the `thread-follow` leg still reads as before",
  );
  ok(
    notionWakeAuditDetail("direct", undefined, "none").addressing === "direct" && notionWakeAuditDetail("direct", undefined, "none").via === "none",
    "🔴 5f: NEGATIVE CONTROL — and an addressed wake on a page NO domain holds reports both words plainly, which is the row an operator reads as `step 8b let it through`",
  );
}

{
  const deps = stubDeps(null);
  ok(await firstNotionDispatchOfComment(FACTS, "cmt-1", deps), "6a: the FIRST sighting of a comment id admits the wake");
  ok(!(await firstNotionDispatchOfComment(FACTS, "cmt-1", deps)), "🔴 6b: the SAME comment id, again, refuses it — one comment, one turn");
  ok(await firstNotionDispatchOfComment(FACTS, "cmt-2", deps), "6c: NEGATIVE CONTROL — a DIFFERENT comment id still admits, so the guard is not a blanket refusal");
  ok(deps.seen.includes("notion-dispatch:cmt-1"), "6d: the key is the COMMENT id under its own prefix — a globally-unique id needs no anchor");
  ok(!deps.seen.includes("notion-engage:WS_N/PAGE_N:cmt-1"), "🔴 6e: …and it is NOT the engage mark's key, so the two guards cannot consume each other's mark");
}
{
  const deps = stubDeps(null);
  await markNotionEngaged(FACTS, "cmt-9", deps);
  ok(await firstNotionDispatchOfComment(FACTS, "cmt-9", deps), "🔴 6f: a comment whose ENGAGE mark is already spent still wakes — the prefixes keep the two guards apart");
}
{
  const deps = stubDeps(null);
  ok(await firstNotionDispatchOfComment({ ...FACTS, workspaceId: undefined }, "cmt-3", deps), "6g: no resolvable partition -> admit (fail open, today's path)");
  ok(await firstNotionDispatchOfComment(FACTS, undefined, deps), "6h: a delivery with no comment id -> admit (nothing to key on)");
  ok(await firstNotionDispatchOfComment(FACTS, "", deps), "6i: an EMPTY comment id -> admit, never one shared key every delivery would collide on");
  const throwing: NotionEngagementDeps = { markEventSeen: async () => { throw new Error("store down"); } };
  ok(await firstNotionDispatchOfComment(FACTS, "cmt-4", throwing), "🔴 6j: an unreachable store -> admit (fail open) — a duplicate turn beats a deaf page");
}

{
  const full = notionDispatchJoinDetail({ deliveryId: "evt-1", commentId: "c-1", wakeId: "w-1" });
  ok(full.deliveryId === "evt-1" && full.commentId === "c-1" && full.wakeId === "w-1", "OPE-1907: the dispatch row carries the delivery, the comment and the wake — the three hops of the join");
  ok(Object.keys(full).length === 3, "…and nothing else: the builder adds ids, never a comment body, an author name or a page title");

  const perDoc = notionDispatchJoinDetail({ commentId: "c-1" });
  ok(perDoc.commentId === "c-1", "a per-doc delivery still names its comment");
  ok(!("wakeId" in perDoc) && !("deliveryId" in perDoc), "🔴 an absent id is OMITTED from the row, never written as an empty key");
  ok(Object.keys(notionDispatchJoinDetail({})).length === 0, "🔴 NEGATIVE CONTROL: with nothing to say the builder adds nothing at all, so the row is byte-identical to before this existed");
  ok(Object.keys(notionDispatchJoinDetail({ deliveryId: "", commentId: "", wakeId: "" })).length === 0, "an EMPTY id is not an id — a blank string is dropped, never recorded as a join key that can never match");
}

console.log(
  `✓ notion-engagement: ${n} assertions passed (page anchor + its grain pinned against the discussion + the decision table with a negative control on every boolean + the name-drop mark + its redelivery guard + the dispatch row's addressing and its domain origin + the wake once-guard + the dispatch row's exact-join ids)`,
);
