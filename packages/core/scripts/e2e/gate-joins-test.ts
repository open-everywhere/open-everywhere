import assert from "node:assert/strict";
import { join } from "node:path";
import type { AuditWireEntry } from "./audit-read.js";
import type { HaltLiveEvidenceKey } from "./scenarios.js";
import {
  AUDIT_SINCE_SKEW_MS,
  auditSinceForDriverClock,
  auditSinceForVendorInstant,
  carriesHostTemplate,
  catchUpBoundHeld,
  classifyConnectorRoad,
  classifySettlementReply,
  classifyUnansweredWake,
  connectorAnswerRoad,
  delegationJoinForSession,
  fireAnchor,
  fixtureArithmetic,
  fixtureSalt,
  haltSetByThisRun,
  isMemoryHopWrite,
  isPersistOutcome,
  MEMORY_PURGE_ROAD,
  memoryPathReadsBetween,
  namesLendRoad,
  namesOwnAccountRefusal,
  ordinaryPageReadVerdict,
  ownAccountAnswerVerdict,
  PERSIST_OUTCOMES,
  PROMISE_SUBJECT,
  readsAsClarifyingQuestion,
  replyPostSessionId,
  rowForReplyChunkSet,
  rowsAtOrAfter,
  saltedFixtureLine,
  seedAckLatchDetail,
  seedMemoryWrites,
  seedSettlementRead,
  settlementReportPairings,
  spendCapRaisedByThisRun,
  turnStartMs,
  unattendedArmRoad,
  unifiedTurnSessionId,
  wakeIdForVendorInstant,
  workerRoadForOp,
} from "./gate-joins.js";
import { seatCatchUpWake, SEAT_READ_RESULT_TYPES, SEAT_READ_TOOL, type TranscriptWireEvent } from "./transcript-read.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const row = (action: string, ts: string, detail: Record<string, unknown>, seq?: number, platform = "slack"): AuditWireEntry => ({
  ts,
  org: "default",
  platform,
  workspace: "T0EXAMPLE",
  action,
  detail,
  ...(seq !== undefined ? { seq } : {}),
});

{
  const VENDOR_MS = Date.parse("2026-01-22T09:02:54.165Z");
  const ROW_MS = Date.parse("2026-01-22T09:02:54.607Z");
  const DRIFT_MS = 2_000;
  const driverNow = VENDOR_MS + DRIFT_MS;

  ok(
    Date.parse(new Date(driverNow).toISOString()) > ROW_MS,
    "control: the OLD bound — this box's bare clock, 2 s fast — really does sit AFTER the row it must find, which is the defect",
  );
  ok(
    Date.parse(auditSinceForDriverClock(driverNow)) < ROW_MS,
    "a driver clock 2 s ahead of the server still yields a bound BELOW the row the driver's own post caused",
  );
  ok(
    Date.parse(auditSinceForVendorInstant(VENDOR_MS)) < ROW_MS,
    "…and the vendor-anchored form does too, without reading this box's clock at all",
  );
  ok(
    Date.parse(auditSinceForVendorInstant(VENDOR_MS)) === VENDOR_MS - AUDIT_SINCE_SKEW_MS,
    "the vendor-anchored bound is exactly the margin below the post, never a wider guess",
  );
  ok(
    Date.parse(auditSinceForDriverClock(driverNow)) > Date.parse("2026-01-22T09:01:54.000Z"),
    "the margin is narrow: a row from the previous leg a minute earlier stays OUTSIDE the widened window",
  );
  ok(auditSinceForDriverClock(driverNow, 0) === new Date(driverNow).toISOString(), "a zero margin is the caller's old behaviour, unchanged");
}

{
  const seq = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7];
  let i = 0;
  const salt = fixtureSalt(() => seq[i++ % seq.length]!);
  ok(/^[bcdfghjkmnpqrstvwxz]{6}$/.test(salt), `a salt is six lowercase consonants (got "${salt}")`);
  ok(!/[0-9]/.test(salt), "🔴 and carries NO DIGIT — J-MPIM's judge takes mustMatch:['56'], so a numeric salt could satisfy an arithmetic gate on its own");

  const line = "quick one for the group — what's 7*8? reply with just the number";
  const runs = new Set<string>();
  for (let r = 0; r < 200; r++) runs.add(saltedFixtureLine(line, fixtureSalt()));
  ok(runs.size === 200, `200 consecutive runs produce 200 distinct fixture lines (got ${runs.size}) — one live run posted the previous run's bytes and was answered with no_reply(duplicate)`);
  ok(!runs.has(line), "…and none of them is the bare line the boards used to repeat");

  ok(saltedFixtureLine(line, "bcdfgh").startsWith(line), "the salted line keeps the original ask intact, so the judge rubrics that quote it still describe it");
  ok(saltedFixtureLine(line, "") === line, "an empty salt changes nothing — a caller with no salt gets its own text back rather than a stray suffix");
}

{
  const HALT_LINE =
    "Halted in this conversation. Nothing consequential will run now — no approvals, no scheduled or event-driven " +
    "work, no borrowed credentials, and nothing fetched from the open web.";
  ok(carriesHostTemplate(`${HALT_LINE} An admin lifts it with \`resume\`.`, [HALT_LINE]), "a message containing the host template is recognised, prose around it and all");
  ok(!carriesHostTemplate("Surface halt applied for the authorized fixture test.", [HALT_LINE]), "…and the MODEL's own narration of the same act is not");
  ok(!carriesHostTemplate(HALT_LINE, [""]), "🔴 an EMPTY template never matches — a product function returning \"\" would otherwise make every message a host template");

  const promise = new RegExp(`${PROMISE_SUBJECT}\\s+(?:look|check|report|update|retrieve|return|fetch|get|run|confirm|post)\\b`, "i");
  ok(!promise.test(HALT_LINE), "🔴 the promise branch does NOT fire on the host's \"Nothing consequential will run now\" — the live-run leg-35 defect");
  ok(promise.test("I’ll confirm once the write is complete."), "…while the first-person contraction still does, curly apostrophe and all (OPE-1692)");
  ok(
    promise.test("Got it — I’m saving that deploy-day detail to channel memory and will confirm once the write is complete."),
    "…and so does the ELIDED subject after \"and\", which is the exact ack OPE-1692 widened this branch for",
  );
  ok(promise.test("Will report back shortly."), "…and a promise at the start of the text, where the subject is dropped entirely");
  ok(promise.test("I’m saving that now; will confirm once the write is complete."), "…after a SEMICOLON, where the subject is elided just the same");
  ok(promise.test("I’m saving that now — will confirm once the write is complete."), "…after an EM DASH");
  ok(promise.test("Saving now.\nWill confirm once the write is complete."), "…and at the start of a LINE, which is where a two-sentence ack puts it");
  ok(!promise.test("The deploy pipeline will run at 6pm."), "a NOUN subject never opens it — an ordinary sentence about something else running is substantive");
  ok(!promise.test("Luna will report the outcome when the worker settles."), "…and a NAMED third party is a noun subject too");
}

{
  const UNIFIED = "wrun_example23";
  const park = row("memory.write", "2026-01-24T00:25:22.000Z", { road: "session-persist", kind: "memory", outcome: "edited", files: 9, sessionId: UNIFIED });
  const siblingRemember = row("memory.write", "2026-01-24T17:44:07.000Z", {
    road: "session-persist",
    kind: "memory",
    tier: "silo:e2e-ambient-brain",
    outcome: "write-intent",
    files: 9,
    sessionId: "wrun_example25",
  });
  const siblingPersist = { ...siblingRemember, detail: { ...siblingRemember.detail, outcome: "edited" } };

  ok(!isMemoryHopWrite(park), "the unified session's own turn-end persist does not trip the WRITE side — the read gate is what sees a hop taken on that road");
  ok(
    !isMemoryHopWrite(siblingPersist),
    "🔴 a SIBLING seat's turn-end persist in the same window is NOT a hop either (OPE-1986): counting one reds the leg whenever another seat is awake in the room",
  );
  ok(
    !isMemoryHopWrite({ ...siblingPersist, detail: { ...siblingPersist.detail, sessionId: "wrun_A_THIRD_SEAT" } }),
    "…and the exclusion is decided by the ROAD alone, so a third seat's persist is excluded on the same terms — no session id is read at all",
  );
  for (const road of ["control-edit", "dream-learn", "dream-tidy", "purge", "pinned-instructions"]) {
    ok(
      isMemoryHopWrite({ ...siblingPersist, detail: { ...siblingPersist.detail, road } }),
      `a \`${road}\` write by ANOTHER session still trips it — every road but \`session-persist\` is a deliberate act this window can see`,
    );
    ok(
      isMemoryHopWrite({ ...park, detail: { ...park.detail, road } }),
      `…and a \`${road}\` write by the unified session itself trips it too — the road is what the gate reads, never who wrote it`,
    );
  }
  ok(
    !isMemoryHopWrite(siblingRemember),
    "🔴 the MEASURED row — a sibling seat's in-turn remember-ask flush (`outcome: write-intent`) — does NOT trip the write side either: the road is all this reader has, and it carries the deliberate write too",
  );
  ok(
    !isMemoryHopWrite({ ...park, detail: { ...park.detail, outcome: "write-intent" } }),
    "…and neither does the ANSWERING session's own remember-ask flush, which is the hop the write side would most want to see and cannot",
  );
  ok(
    isMemoryHopWrite({ ...park, detail: { kind: "memory", sessionId: UNIFIED } }),
    "a row with NO readable road fails toward COUNTING — an unreadable row reds the leg rather than being quietly dropped",
  );
  ok(
    isMemoryHopWrite({ ...park, detail: { ...park.detail, road: 42 } }),
    "…and so does a row whose road is not a string: the gate understands the closed road set and nothing else",
  );
  ok(!isMemoryHopWrite(row("memory.operational_write", park.ts, { road: "status-board" })), "an OPERATIONAL write is a different action and is not this gate's business");
}

{
  const ASK = "what was the deploy window token the team decided on earlier today";
  const MARKER = "shipwin-41822";
  const ev = (index: number, type: string, data: unknown) => ({ index, type, data });
  const extract = (evs: readonly { readonly index: number; readonly type: string; readonly data: unknown }[]): readonly string[] =>
    evs.flatMap((e) => {
      const d = e.data as { path?: unknown } | undefined;
      return typeof d?.path === "string" ? [d.path] : [];
    });

  const clean = [
    ev(10, "message.received", { text: `Before I write this up — ${ASK}?` }),
    ev(11, "step.started", {}),
    ev(12, "message.appended", { text: `The deploy window token is ${MARKER}.` }),
  ];
  const cleanSlice = memoryPathReadsBetween(clean, { fromText: ASK, toText: MARKER, extractPaths: extract });
  ok(cleanSlice.bounded && cleanSlice.fromIndex === 10 && cleanSlice.toIndex === 12, "the slice is bounded by the ask and by the reply that quotes the marker");
  ok(cleanSlice.paths.length === 0, "a turn that answered from the live window read no memory path — the passing shape");

  const hopped = [clean[0]!, ev(11, "action.result", { path: "memory/e2e-ambient-brain/notes.md" }), clean[2]!];
  const hopSlice = memoryPathReadsBetween(hopped, { fromText: ASK, toText: MARKER, extractPaths: extract });
  ok(hopSlice.bounded && hopSlice.paths.length === 1, "🔴 a memory read INSIDE the slice is the hop, and the gate reds on it — the defect this half guards");

  const earlier = [ev(1, "action.result", { path: "memory/e2e-ambient-brain/older.md" }), ...clean];
  ok(memoryPathReadsBetween(earlier, { fromText: ASK, toText: MARKER, extractPaths: extract }).paths.length === 0, "a read from BEFORE the ask is another turn's and is not counted");

  const noAsk = memoryPathReadsBetween([clean[2]!], { fromText: ASK, toText: MARKER, extractPaths: extract });
  ok(!noAsk.bounded && noAsk.fromIndex === undefined, "a stream that never carries the ask is UNBOUNDED, so the caller reds rather than reporting a clean read");
  const noReply = memoryPathReadsBetween([clean[0]!, clean[1]!], { fromText: ASK, toText: MARKER, extractPaths: extract });
  ok(!noReply.bounded && noReply.fromIndex === 10 && noReply.toIndex === undefined, "…and so is one that opens and never closes, which says which mark was missing");
  ok(noReply.paths.length === 0, "an unbounded slice reports no paths — the flag, never the empty list, is what a caller may read");
}

{
  const WAKE = "e900c9f0";
  const REPORT = "1769474005.459000";
  const ANSWER = "1769474056.100000";
  const rows = [
    row("reply.post", "2026-01-27T00:33:25.400Z", { id: REPORT, wakeId: WAKE, chars: 251, sessionId: "wrun_A" }, 10),
    row("delegation.settlement_report_posted", "2026-01-27T00:33:25.459Z", { task: "task_06965c9a", wake: WAKE }, 11),
    row("reply.post", "2026-01-27T00:34:18.000Z", { id: ANSWER, wakeId: WAKE, chars: 88, sessionId: "wrun_A" }, 12),
  ];
  const reportIds = (rs: readonly AuditWireEntry[]) => new Set(settlementReportPairings(rs).map((p) => p.id));
  const ids = reportIds(rows);
  ok(ids.has(REPORT), "the message that carried the settlement report is named — by POSITION, since the row itself names only the task and the wake");
  ok(!ids.has(ANSWER), "🔴 and the answer posted AFTER it is not: a pairing that took the newest post would skip the very reply the leg is waiting for");

  const foreign = [...rows, row("reply.post", "2026-01-27T00:33:24.000Z", { id: "1769474004.000000", wakeId: "some-other-wake", chars: 40 }, 9)];
  ok(!reportIds(foreign).has("1769474004.000000"), "a post from ANOTHER wake is never paired with this settlement row, however close it sits");

  ok(reportIds([rows[1]!]).size === 0, "a settlement row whose wake no reply.post names contributes nothing — there is no message to skip, and inventing one would skip a real answer");
  ok(reportIds([rows[0]!, rows[2]!]).size === 0, "reply.post rows with no settlement row beside them name nothing: an ordinary turn skips nothing at all");

  const noSeq = rows.map((r) => ({ ts: r.ts, org: r.org, platform: r.platform, workspace: r.workspace, action: r.action, detail: r.detail }));
  ok(reportIds(noSeq).has(REPORT), "with no `seq` on the wire the pairing falls back to `ts` and still finds the report");

  ok(replyPostSessionId(rows, REPORT) === "wrun_A", "replyPostSessionId names the session that posted a message the leg holds");
  ok(replyPostSessionId(rows, "1769384956.000000") === undefined, "…and answers nothing for a message no reply.post row names");
}

{
  const SURFACE = "slack/T0EXAMPLE/C0EXCHAN003";
  const ASK_VENDOR_MS = Date.parse("2026-01-28T12:28:04.000Z");
  const ASK_WAKE = "ask-wake-not-quoted";
  const MINTED = "6fc46eec";
  const TASK = "task-not-quoted";
  const ACK = "1769603299.000000";
  const REPORT = "1769603380.031000";
  const rows = [
    row("wake.ingress", "2026-01-28T12:28:04.100Z", { wakeId: ASK_WAKE, vendorTs: "2026-01-28T12:28:04.000Z", surfaceKey: SURFACE }, 1),
    row("wake.turn_start", "2026-01-28T12:28:04.900Z", { wakeId: ASK_WAKE, turnStartTs: "2026-01-28T12:28:04.900Z" }, 2),
    row("delegation.task_started", "2026-01-28T12:28:08.000Z", { task: TASK, continuation: false }, 3, "ingest"),
    row("reply.post", "2026-01-28T12:28:19.000Z", { id: ACK, wakeId: ASK_WAKE, chars: 118 }, 4),
    row("unified.task_wake", "2026-01-28T12:29:39.000Z", { task: TASK, wakeId: MINTED, inheritedWakeId: ASK_WAKE, outcome: "installed" }, 5, "unified"),
    row("reply.post", "2026-01-28T12:29:40.000Z", { id: REPORT, wakeId: MINTED, chars: 233 }, 6),
    row("delegation.settlement_report_posted", "2026-01-28T12:29:40.031Z", { task: TASK, wake: MINTED }, 7),
  ];
  const askWakeId = wakeIdForVendorInstant(rows, ASK_VENDOR_MS, SURFACE);
  const floorMs = turnStartMs(rows, ASK_WAKE);
  const keys = { askWakeId, floorMs };

  ok(askWakeId === ASK_WAKE, "the ask's own wake is found by the vendor instant — the first of the two keys the wait latches");
  ok(floorMs === Date.parse("2026-01-28T12:28:04.900Z"), "…and its turn start is the second, read from the row's own `ts`, which `wake-turn-start.ts` stamps from `turnStartTs`");
  const pairing = settlementReportPairings(rows).find((p) => p.id === REPORT);
  ok(pairing?.id === REPORT, "§5's pairing still names the report's message: what changed is what the wait DOES with it");
  ok(pairing?.task === TASK && pairing.wake === MINTED, "…and the pairing carries the task that settled and the wake it settled under — the join a bare id set threw away");

  const answered = classifySettlementReply(rows, { ...keys, messageId: REPORT, answersAsk: true });
  ok(answered.kind === "answer", "🔴 the settlement report of a task THIS ask dispatched, carrying what the ask asked for, IS the answer — the 320 s timeout this ticket names");
  ok(answered.kind === "answer" && answered.wakeId === MINTED, "…and it names the MINTED wake it was posted under, never the ask's, so a log says which wake answered");

  const noToken = classifySettlementReply(rows, { ...keys, messageId: REPORT, answersAsk: false });
  ok(noToken.kind === "step-over", "🔴 control: the SAME report whose text does not carry what the ask asked for is stepped over — the content gate is load-bearing, not decoration");

  const interim = classifySettlementReply(rows, { ...keys, messageId: ACK, answersAsk: true });
  ok(interim.kind === "not-a-report", "the interim ack carries no settlement row, so §5 claims nothing about it — `skip` owns that message, exactly as before");

  ok(classifySettlementReply(rows, { messageId: REPORT, askWakeId: undefined, floorMs, answersAsk: true }).kind === "step-over", "control: no wake for the ask at all FAILS CLOSED to the old unconditional skip");
  ok(classifySettlementReply(rows, { messageId: REPORT, askWakeId: ASK_WAKE, floorMs: undefined, answersAsk: true }).kind === "step-over", "control: no floor for the ask's turn FAILS CLOSED too — nothing can be placed inside a turn with no start");

  const earlierDispatch = rows.map((r) => (r.action === "delegation.task_started" ? row(r.action, "2026-01-28T12:25:16.000Z", r.detail as Record<string, unknown>, r.seq, "ingest") : r));
  ok(classifySettlementReply(earlierDispatch, { ...keys, messageId: REPORT, answersAsk: true }).kind === "step-over", "🔴 control: a task dispatched BEFORE this ask's turn start is a PREVIOUS leg's, so its report never ends this wait");

  const foreignPost = rows.map((r) => (r.action === "unified.task_wake" ? row(r.action, r.ts, { ...(r.detail as Record<string, unknown>), inheritedWakeId: "another-legs-wake" }, r.seq, "unified") : r));
  ok(classifySettlementReply(foreignPost, { ...keys, messageId: REPORT, answersAsk: true }).kind === "step-over", "🔴 control: a minted wake whose `inheritedWakeId` is another leg's is never adopted, so a report posted under it is stepped over");

  const WAKE_Rb = "e900c9f0";
  const REPORT_Rb = "1769474005.459000";
  const TASK_Rb = "task_06965c9a";
  const FLOOR_Rb = Date.parse("2026-01-27T00:33:16.000Z");
  const rowsRb = [
    row("wake.turn_start", "2026-01-27T00:33:16.000Z", { wakeId: WAKE_Rb, turnStartTs: "2026-01-27T00:33:16.000Z" }, 8),
    row("delegation.task_started", "2026-01-27T00:29:27.000Z", { task: TASK_Rb, continuation: false }, 9, "ingest"),
    row("reply.post", "2026-01-27T00:33:25.400Z", { id: REPORT_Rb, wakeId: WAKE_Rb, chars: 251 }, 10),
    row("delegation.settlement_report_posted", "2026-01-27T00:33:25.459Z", { task: TASK_Rb, wake: WAKE_Rb }, 11),
  ];
  const keysRb = { askWakeId: WAKE_Rb, floorMs: FLOOR_Rb };
  ok(classifySettlementReply(rowsRb, { ...keysRb, messageId: REPORT_Rb, answersAsk: true }).kind === "step-over", "🔴 OPE-1965 still holds ON LINEAGE, not on text: the PR task's report is posted under THIS ask's own wake, and the dispatch join places that task in a PREVIOUS leg");

  const dispatchedHere = rowsRb.map((r) => (r.action === "delegation.task_started" ? row(r.action, "2026-01-27T00:33:17.000Z", r.detail as Record<string, unknown>, r.seq, "ingest") : r));
  ok(classifySettlementReply(dispatchedHere, { ...keysRb, messageId: REPORT_Rb, answersAsk: true }).kind === "answer", "…and the SAME rows with the dispatch inside this turn answer — a seat that delegates and settles under its own wake has answered its ask");
}

{
  const channel = row("connector.use", "2026-01-24T00:42:53.000Z", { connection: "notion", mode: "channel" });
  const personal = row("connector.use", "2026-01-24T00:42:53.000Z", { connection: "notion", mode: "dm" });
  ok(classifyConnectorRoad([channel], "notion") === "org-connector", "a channel-bound admission reads as the ORG connector — the road the leg's rubric is not written for");
  ok(classifyConnectorRoad([personal], "notion") === "personal", "…and a DM-bound one as the personal connection");
  ok(classifyConnectorRoad([], "notion") === "unknown", "no row at all is UNKNOWN, never either road — an absent row is evidence about nothing");
  ok(classifyConnectorRoad([channel], "linear") === "unknown", "…and another connector's row answers nothing about this one");
  ok(
    classifyConnectorRoad([row("connector.use", channel.ts, { connection: "notion", mode: "channel", grant: "work-surface" })], "notion") === "org-connector",
    "the non-DM work-surface carve-out is the org road too — `grant` decides before `mode` is even read",
  );
  ok(classifyConnectorRoad([row("connector.use", channel.ts, { connection: "notion" })], "notion") === "unknown", "a row with no readable mode is not guessed into either road");
  ok(
    classifyConnectorRoad([row("connector.use", "2026-01-24T00:41:00.000Z", { connection: "notion", mode: "dm" }), channel], "notion") === "org-connector",
    "the NEWEST row decides: a read on the personal road followed by a write on the org road reads as the org road",
  );
}

{
  const attendedChain = row("approval.chain", "2026-01-24T01:24:24.000Z", { tool: "set_spend_limit", unattended: false, verdict: "ask" });
  const attendedAsk = row("approval.requested", "2026-01-24T01:24:24.500Z", { id: "cbe2848b", kind: "spend.set" });
  const create = row("approval.requested", "2026-01-24T01:24:23.000Z", { id: "fc20646d", kind: "routine.create" });
  const fire = row("routine.fire_attrs_sent", "2026-01-24T01:28:41.000Z", { routineId: "r-e379b81c", wakeId: "a2a42d0a", attrCount: 4 });
  const rows = [create, attendedChain, attendedAsk, fire];

  const anchor = fireAnchor(rows);
  ok(anchor !== undefined && anchor.atIso === "2026-01-24T01:28:41.000Z", "the fire is located by its own dispatcher row");
  ok(anchor?.routineId === "r-e379b81c" && anchor?.wakeId === "a2a42d0a", "…and the row's routine and wake ride along for the leg's log line");

  const scoped = rowsAtOrAfter(rows, anchor!.atMs);
  const proposals = scoped.filter((e) => (e.detail as { tool?: unknown; kind?: unknown }).tool === "set_spend_limit" || (e.detail as { kind?: unknown }).kind === "spend.set");
  ok(proposals.length === 0, "🔴 the ATTENDED setup turn's two rows fall outside the fire's own window — the exact pair that red this leg on a fence that held");
  ok(
    rows.filter((e) => (e.detail as { tool?: unknown; kind?: unknown }).tool === "set_spend_limit" || (e.detail as { kind?: unknown }).kind === "spend.set").length === 2,
    "control: over the LEG-wide window those two rows are still there, which is what the old gate scored",
  );

  const guilty = [...rows, row("approval.chain", "2026-01-24T01:28:45.000Z", { tool: "set_spend_limit", unattended: true, verdict: "ask" })];
  const guiltyScoped = rowsAtOrAfter(guilty, fireAnchor(guilty)!.atMs).filter((e) => (e.detail as { tool?: unknown }).tool === "set_spend_limit");
  ok(guiltyScoped.length === 1, "…and a propose made by the FIRE's own turn is inside the window, so the absence gate still reds on the defect it guards");

  ok(fireAnchor([create, attendedChain]) === undefined, "no dispatcher row ⇒ no anchor: the caller keeps its own wider bound and says so, rather than narrowing on a guess");
  const earlier = row("routine.fire_attrs_sent", "2026-01-24T01:18:00.000Z", { routineId: "r-earlier", wakeId: "w0" });
  ok(
    fireAnchor([earlier, fire], { postedAtMs: Date.parse("2026-01-24T01:23:00.000Z") })?.routineId === "r-earlier",
    "with a post to anchor on, the fire is the newest dispatcher row AT OR BEFORE it — a later fire in the same window is never taken",
  );
  ok(rowsAtOrAfter([row("approval.chain", "not-a-date", { tool: "set_spend_limit" })], 0).length === 1, "a row whose stamp cannot be parsed is KEPT — an unplaceable row stays in front of an absence gate");
}

{
  const OP = "notion__create_page";
  const worker = row("worker.toolset", "2026-01-24T01:38:50.000Z", { worker: "wrun_example24", grain: "task", tools: ["bash", "read_file", "reply"], toolCount: 3 });
  const v = workerRoadForOp([worker], OP);
  ok(v.workers === 1 && !v.mounted, "🔴 a delegated worker whose roster has no connector tool: NO CONNECTOR CALL HAPPENED, which is routing and not the fence");
  ok(v.sample.includes("bash"), "…and the roster rides back so the gate's message can show what the work actually held");

  const mounted = workerRoadForOp([{ ...worker, detail: { ...worker.detail, tools: ["bash", OP] } }], OP);
  ok(mounted.mounted, "a worker that DID mount the op leaves the connector road open, so an empty window there really is the fence going unreached");
  ok(workerRoadForOp([], OP).workers === 0, "no worker rows at all ⇒ no delegated worker ran, and the fire's own seat is where the call had to come from");
  ok(!workerRoadForOp([{ ...worker, detail: { worker: "w", tools: "not-an-array" } }], OP).mounted, "an unreadable roster cannot support the claim that the call was possible");
}

{
  const OP = "notion__create_page";
  const restRoad = [row("worker.toolset", "2026-01-31T04:15:11.000Z", { worker: "wrun_example35", grain: "task", tools: ["bash", "load_skill", "read_file", "reply"], toolCount: 4, namesTruncated: false })];

  const restArm = unattendedArmRoad({ planeRows: 0, workerRows: restRoad, op: OP });
  ok(restArm.verdict === "not-proven", "🔴 the DECLARED fire took the REST road with the op unmounted: there is no lift to measure, so the arm is NOT PROVEN and never scored");
  ok(restArm.note.startsWith("NO CONNECTOR CALL HAPPENED:") && restArm.note.includes(OP), "…and the note names the road, so the observation sends the next reader to routing rather than to the declare→lift join");

  const mountedRoad = [{ ...restRoad[0]!, detail: { ...restRoad[0]!.detail, tools: ["bash", OP], toolCount: 2 } }];
  ok(
    unattendedArmRoad({ planeRows: 0, workerRows: mountedRoad, op: OP }).verdict === "unexplained",
    "🔴 a worker that DID mount the op, with neither a lift nor a refusal in the window: the declared fire held the fence's road and nothing recorded it — HARD, and without this arm the rule would excuse the regression",
  );
  ok(
    unattendedArmRoad({ planeRows: 0, workerRows: [], op: OP }).verdict === "unexplained",
    "no roster at all is not an explanation either — the fire's own seat is where the call had to come from, so an empty plane stays HARD",
  );

  const unreadable = [{ ...restRoad[0]!, detail: { worker: "wrun_example36", grain: "task", tools: "not-an-array" } }];
  ok(
    unattendedArmRoad({ planeRows: 0, workerRows: unreadable, op: OP }).verdict === "unexplained",
    "🔴 a roster whose tools is not an array says nothing about the road, so it cannot buy the arm its NOT PROVEN — an unreadable roster fails HARD, not open",
  );
  const truncated = [{ ...restRoad[0]!, detail: { ...restRoad[0]!.detail, namesTruncated: true, toolCount: 512 } }];
  ok(
    unattendedArmRoad({ planeRows: 0, workerRows: truncated, op: OP }).verdict === "unexplained",
    "🔴 a TRUNCATED roster may have carried the op past the cap, so its silence is not the seat taking another road either",
  );
  ok(
    unattendedArmRoad({ planeRows: 0, workerRows: [...unreadable, ...restRoad], op: OP }).verdict === "not-proven",
    "control: ONE readable roster beside an unreadable one still explains the empty plane — the rule needs a readable roster, not every roster readable",
  );
  ok(workerRoadForOp([...unreadable, ...truncated, ...restRoad], OP).explained === 1, "…and `explained` counts only the rosters that could support the claim, while `workers` still counts all three");
  ok(workerRoadForOp([...unreadable, ...truncated, ...restRoad], OP).workers === 3, "…the worker COUNT is unchanged, so a gate message still reports what the window really carried");

  ok(unattendedArmRoad({ planeRows: 1, workerRows: restRoad, op: OP }).verdict === "measured", "a plane row present ⇒ the arm SCORES, and the roster never overrides a row that was really there");

  ok(
    unattendedArmRoad({ planeRows: 0, workerRows: mountedRoad, op: OP }).note === `1 delegated worker(s) ran and at least one MOUNTED ${OP}, so the connector road was open to the work`,
    "the mounted roster's note says the road was OPEN, which is what makes the hard red above readable",
  );
  ok(
    unattendedArmRoad({ planeRows: 0, workerRows: [], op: OP }).note === "no worker.toolset row in this window, so no delegated worker ran and the fire's own seat is where the call had to come from",
    "…and an empty window's note names the seat, not the fence",
  );
}

{
  const WAKE = "bf16cd0b";
  const ambient = row("turn.unaccounted_wakes", "2026-01-24T00:02:55.000Z", {
    turnId: "turn_4",
    turnWake: WAKE,
    unaccounted: [{ wakeId: WAKE, addressing: "ambient" }],
    count: 1,
    addressedCount: 0,
    ambientCount: 1,
  });
  ok(classifyUnansweredWake([ambient], WAKE).kind === "ambient-silence", "the ambient row reads as the seat DECLINING ambient traffic, not as an answer that never came");
  ok(classifyUnansweredWake([ambient], "some-other-wake").kind === "unknown", "…and says nothing about a wake it does not name");
  const addressed = { ...ambient, detail: { ...ambient.detail, unaccounted: [{ wakeId: WAKE, addressing: "addressed" }], addressedCount: 1, ambientCount: 0 } };
  ok(
    classifyUnansweredWake([addressed], WAKE).kind === "addressed-silence",
    "🔴 an ADDRESSED wake left unaccounted is silence the product does not licence — without this arm the reader would excuse every red",
  );
  ok(classifyUnansweredWake([], WAKE).kind === "unknown", "no accounting row ⇒ nothing is claimed");

  const VENDOR = "2026-01-24T00:02:49.000Z";
  const ingress = row("wake.ingress", "2026-01-24T00:02:51.000Z", { wakeId: WAKE, surfaceKey: "slack/T0EXAMPLE/C0EXCHAN003", vendorTs: VENDOR });
  ok(wakeIdForVendorInstant([ingress], Date.parse(VENDOR)) === WAKE, "the driver's own post is joined to its wake by the vendor instant the surface stamped on it");
  ok(wakeIdForVendorInstant([ingress], Date.parse(VENDOR), "slack/T0EXAMPLE/C0OTHER") === undefined, "…scoped to the room, so another container's wake never supplies the key");
  ok(wakeIdForVendorInstant([ingress], Date.parse("2026-01-24T00:02:04.000Z")) === undefined, "…and another message's instant does not either");
}

{
  const TRIGGER = "sl-trig-61999";
  const IDLE = "sl-idle-61845";
  const STALE = "engaged-14432";
  const ev = (index: number, type: string, data: unknown): TranscriptWireEvent => ({ index, at: null, type, data });

  const envelopeOnly = [
    ev(1392, "prompt", { text: `ref ${TRIGGER} — which build token was posted here while you were not listening?`, context: "self: Understood — I'll stop following this thread" }),
    ev(1400, "action.result", { tool: SEAT_READ_TOOL, result: `…noting for the record: this run's build token is ${IDLE}. No reply needed.` }),
    ev(1402, "reply", { text: IDLE }),
  ];
  const read = seatCatchUpWake(envelopeOnly, { trigger: TRIGGER, caughtUp: IDLE, stale: [STALE] });
  ok(read.wakeIndex === 1392, "the wake is the OLDEST event carrying the trigger");
  ok(!read.carriedCatchUp, "the envelope did NOT carry the idle-window message — the measured shape");
  ok(read.road === "read" && read.readIndex === 1400, `…and the seat's own ${SEAT_READ_TOOL} result is the road it took instead (event ${read.readIndex})`);
  ok(read.staleCarried.length === 0, "the bound still holds: nothing from before the seat's last wake is in the envelope");

  const carried = seatCatchUpWake(
    [ev(1392, "prompt", { text: `ref ${TRIGGER}`, context: `this run's build token is ${IDLE}` }), ev(1402, "reply", { text: IDLE })],
    { trigger: TRIGGER, caughtUp: IDLE },
  );
  ok(carried.carriedCatchUp && carried.road === "envelope", "an envelope that DID carry the message reads as the envelope road, and the read road is never consulted");

  const noRead = seatCatchUpWake([ev(1392, "prompt", { text: `ref ${TRIGGER}` }), ev(1402, "reply", { text: IDLE })], { trigger: TRIGGER, caughtUp: IDLE });
  ok(noRead.road === "none", "a reply repeating the token with NO read result in the stream is not the read road — the gate still reds");
  const readWithoutToken = seatCatchUpWake(
    [ev(1392, "prompt", { text: `ref ${TRIGGER}` }), ev(1400, "action.result", { tool: SEAT_READ_TOOL, result: "nothing since your last wake" })],
    { trigger: TRIGGER, caughtUp: IDLE },
  );
  ok(readWithoutToken.road === "none", "…and a read whose RESULT did not carry the message is not the read road either");

  const replyNamesTheVerb = seatCatchUpWake(
    [ev(1392, "prompt", { text: `ref ${TRIGGER}` }), ev(1402, "message.appended", { text: `I used ${SEAT_READ_TOOL} to catch up — the token is ${IDLE}` })],
    { trigger: TRIGGER, caughtUp: IDLE },
  );
  ok(replyNamesTheVerb.road === "none", `🔴 a REPLY naming ${SEAT_READ_TOOL} and repeating the marker does NOT open the read road — only a tool RESULT does`);
  ok(SEAT_READ_RESULT_TYPES.includes("action.result"), "…and the type that does is eve's own `action.result`, named once so a leg cannot invent its own");

  const stale = seatCatchUpWake([ev(1392, "prompt", { text: `ref ${TRIGGER} — and earlier ref ${STALE}`, context: `token ${IDLE}` })], {
    trigger: TRIGGER,
    caughtUp: IDLE,
    stale: [STALE],
  });
  ok(stale.staleCarried.includes(STALE), "control: a marker from BEFORE the seat's last wake in the envelope is still reported, whichever road the idle token took");
}

{
  const seq = (values: readonly number[]): (() => number) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };
  const a = fixtureArithmetic(seq([0, 0]));
  ok(a.question === "12*12" && a.answer === "144", "fixtureArithmetic: the draw composes the operand phrase and its product");
  const b = fixtureArithmetic(seq([0.5, 0.95]));
  ok(b.question !== a.question && b.answer !== a.answer, "fixtureArithmetic: a different draw is a different QUESTION and a different ANSWER — the prime the salt alone could not remove");
  const MIN = 12;
  const MAX = 31;
  const every: { question: string; answer: string }[] = [];
  for (let x = MIN; x <= MAX; x++) {
    for (let y = MIN; y <= MAX; y++) {
      const pick = (v: number): number => (v - MIN) / (MAX - MIN + 1);
      every.push(fixtureArithmetic(seq([pick(x), pick(y)])));
    }
  }
  ok(every.length === (MAX - MIN + 1) ** 2, `fixtureArithmetic: the sweep really drew every pair in [${MIN}, ${MAX}] (${every.length})`);
  const selfSpelling = every.find((d) => d.question.includes(d.answer));
  ok(selfSpelling === undefined, `🔴 fixtureArithmetic: NO pair in the range spells its own product inside its question (first offender: ${JSON.stringify(selfSpelling)})`);
  const fourDigit = every.find((d) => d.answer.length > 3);
  ok(fourDigit === undefined, `🔴 fixtureArithmetic: NO pair in the range reaches a four-digit product, which the fallback judge's plain-string needle cannot spell with its thousands comma (first offender: ${JSON.stringify(fourDigit)})`);
  ok(new Set(every.map((d) => d.question)).size === every.length, "fixtureArithmetic: every draw in the sweep is a distinct question — the pair really tracks the draw");
  ok(new Set(Array.from({ length: 200 }, () => fixtureArithmetic().question)).size > 1, "fixtureArithmetic: the default random source varies the pair (a constant would prime the seat exactly as the literal did)");
}

{
  const POINTER = { scopeKey: "slack/T0EXAMPLE/C0EXCHAN011", setBy: "U0EXOWNER", runStart: "2026-01-25T01:13:00.000Z" };
  ok(
    haltSetByThisRun({ scopeKey: POINTER.scopeKey, setBy: POINTER.setBy, setAt: "2026-01-25T01:14:41.000Z" }, POINTER),
    "haltSetByThisRun: this run's address, this run's driver actor, set after this run began — adopted",
  );
  ok(!haltSetByThisRun(undefined, POINTER), "haltSetByThisRun: no halt at all is not this run's");
  ok(
    !haltSetByThisRun({ scopeKey: POINTER.scopeKey, setBy: "U-OPERATOR", setAt: "2026-01-25T01:14:41.000Z" }, POINTER),
    "🔴 haltSetByThisRun: an OPERATOR's halt on the same room in the same window is REFUSED — the actor is what tells them apart",
  );
  ok(
    !haltSetByThisRun({ scopeKey: POINTER.scopeKey, setBy: POINTER.setBy, setAt: "2026-01-24T17:43:00.000Z" }, POINTER),
    "🔴 haltSetByThisRun: the same driver's halt from BEFORE this run began is a previous run's residue, not this run's to clear",
  );
  ok(
    !haltSetByThisRun({ scopeKey: "slack/T0EXAMPLE/C0EXCHAN003", setBy: POINTER.setBy, setAt: "2026-01-25T01:14:41.000Z" }, POINTER),
    "haltSetByThisRun: another room's halt is never adopted, whoever set it",
  );
  ok(
    !haltSetByThisRun({ scopeKey: POINTER.scopeKey, setBy: POINTER.setBy, setAt: "not-a-date" }, POINTER),
    "haltSetByThisRun: an unreadable setAt cannot place the halt in this run — refused rather than assumed",
  );

  const SCOPE = "slack/T0EXAMPLE/C0EXCHAN003";
  ok(spendCapRaisedByThisRun({ scopeKey: SCOPE, monthlyUsd: 4702 }, { scopeKey: SCOPE, monthlyUsd: 4702 }), "spendCapRaisedByThisRun: the run-unique dollar value on this run's own surface — adopted");
  ok(!spendCapRaisedByThisRun(undefined, { scopeKey: SCOPE, monthlyUsd: 4702 }), "spendCapRaisedByThisRun: no override standing is nothing to clear");
  ok(
    !spendCapRaisedByThisRun({ scopeKey: SCOPE, monthlyUsd: 20 }, { scopeKey: SCOPE, monthlyUsd: 4702 }),
    "🔴 spendCapRaisedByThisRun: ANOTHER value on the same surface is an operator's cap, not this run's — the value is the whole join",
  );
  ok(
    !spendCapRaisedByThisRun({ scopeKey: "slack/T0EXAMPLE/C0EXCHAN011", monthlyUsd: 4702 }, { scopeKey: SCOPE, monthlyUsd: 4702 }),
    "spendCapRaisedByThisRun: the same value on another surface is another room's override",
  );
  ok(
    !spendCapRaisedByThisRun({ scopeKey: SCOPE, monthlyUsd: 4702, monthlyTokens: 1_000_000 }, { scopeKey: SCOPE, monthlyUsd: 4702 }),
    "🔴 spendCapRaisedByThisRun: a TOKEN-denominated override is never adopted — the spend legs ask in dollars, so a token cap is somebody else's",
  );
}

{
  ok(isPersistOutcome("write-intent"), "🔴 isPersistOutcome: `write-intent` — the in-turn remember-ask flush the stale literal was missing — is a member");
  for (const o of ["completed", "failed", "settled", "edited"]) ok(isPersistOutcome(o), `isPersistOutcome: the shipped outcome ${o} is a member`);
  ok(PERSIST_OUTCOMES.length === 5, "PERSIST_OUTCOMES: five values, which is what `MemoryPersistOutcome` declares (a sixth reds typecheck at the record, not here)");
  ok(!isPersistOutcome("remember"), "🔴 isPersistOutcome: `remember` — the value this gate pinned until 2026-08-16, which has never existed — is refused");
  ok(!isPersistOutcome(undefined) && !isPersistOutcome(null) && !isPersistOutcome(7), "isPersistOutcome: a row whose outcome is absent or not a string is never a member");
  ok(!isPersistOutcome("toString"), "isPersistOutcome: an Object.prototype key is not a member — the lookup reads own properties only");
}

{
  const SAME = "not-stale-35259";
  const FOREIGN = "not-foreign-99001";

  ok(
    !catchUpBoundHeld({ bound: "wake", sameContainerStale: [SAME] }).held,
    "wake-bounded: a marker from before the last wake in the SAME container reds — the time slice was not honoured",
  );
  ok(
    catchUpBoundHeld({ bound: "wake", sameContainerStale: [] }).held,
    "wake-bounded control: an envelope that re-showed nothing from before the wake holds",
  );
  ok(
    !catchUpBoundHeld({ bound: "wake", sameContainerStale: [], foreignContainerCarried: [FOREIGN] }).held,
    "wake-bounded: a foreign-container marker reds too — nothing from before the wake belongs in the slice",
  );

  ok(
    catchUpBoundHeld({ bound: "discussion", sameContainerStale: [SAME], foreignContainerCarried: [], foreignStaged: 1 }).held,
    "🔴 discussion-bounded: the live-run evidence (same-discussion `not-stale-35259` carried, no foreign marker) PASSES — the Notion envelope re-shows its own discussion by design",
  );
  ok(
    !catchUpBoundHeld({ bound: "discussion", sameContainerStale: [SAME], foreignContainerCarried: [FOREIGN], foreignStaged: 1 }).held,
    "discussion-bounded control: a foreign-container marker in the envelope reds — the read reached beyond the discussion to the page",
  );
  ok(
    !catchUpBoundHeld({ bound: "discussion", sameContainerStale: [SAME], foreignContainerCarried: [], foreignStaged: 0 }).held,
    "discussion-bounded: with NO foreign marker staged the gate measured nothing and does not pass vacuously",
  );
}

{
  const FIRST = "1769564705.585000";
  const LAST = "1769564705.613000";
  const provRow = row("reply.provenance", "2026-01-28T01:44:51.000Z", { id: LAST, connections: ["notion"], named: 1, withheld: 0 });
  const otherTurnRow = row("reply.provenance", "2026-01-28T01:32:47.000Z", { id: "1769469387.000001", connections: ["notion"] });

  ok(
    rowForReplyChunkSet([otherTurnRow, provRow], [FIRST, LAST]) === provRow,
    "🔴 the provenance row keyed to the LAST chunk is found when the join takes the whole chunk set (the split-reply fix)",
  );
  ok(
    rowForReplyChunkSet([otherTurnRow, provRow], [FIRST]) === undefined,
    "negative control: keying on the first chunk alone finds no row — the join miss the board red on",
  );
  ok(
    rowForReplyChunkSet([provRow], [LAST]) === provRow,
    "an un-split reply (one chunk) still joins on its own id",
  );
  ok(
    rowForReplyChunkSet([otherTurnRow], [FIRST, LAST]) === undefined,
    "no row names any chunk ⇒ undefined — the exhausted-set miss, reported as NOT-JOINED",
  );
}

{
  const GH_REPLY = "980017";
  const SLACK_ACK = "1769601761.100200";
  const ghRow = row("reply.post", "2026-01-28T12:09:21.000Z", { id: GH_REPLY, sessionId: "wrun_GITHUB_TURN" }, undefined, "github");
  const ackRow = row("reply.post", "2026-01-28T12:08:21.000Z", { id: SLACK_ACK, sessionId: "wrun_SLACK_SIBLING" });

  ok(
    unifiedTurnSessionId([ackRow, ghRow], { githubReplyId: GH_REPLY, slackAnchorId: SLACK_ACK }) === "wrun_GITHUB_TURN",
    "🔴 the GitHub turn's seat is resolved from the GitHub reply's row, not the Slack ack's — the fix for the sibling-seat replay",
  );
  ok(
    unifiedTurnSessionId([ackRow], { githubReplyId: GH_REPLY, slackAnchorId: SLACK_ACK }) === "wrun_SLACK_SIBLING",
    "with no GitHub reply row, it falls back to the Slack ack's session — the pre-fix behaviour",
  );
  const bothSame = [
    row("reply.post", "2026-01-28T12:09:21.000Z", { id: GH_REPLY, sessionId: "wrun_ONE" }, undefined, "github"),
    row("reply.post", "2026-01-28T12:08:21.000Z", { id: SLACK_ACK, sessionId: "wrun_ONE" }),
  ];
  ok(
    unifiedTurnSessionId(bothSame, { githubReplyId: GH_REPLY, slackAnchorId: SLACK_ACK }) === "wrun_ONE",
    "control: when one session posted both, either row resolves it",
  );
  ok(
    replyPostSessionId([ackRow], SLACK_ACK) === "wrun_SLACK_SIBLING",
    "the fallback uses replyPostSessionId, the same join the leg used before the fix",
  );
}

{
  process.env.OE_SQLITE_PATH = join("/tmp", `oe-gate-joins-halt-test-${process.pid}.sqlite3`);
  const { haltWakeForSlackAnchor, haltSetEvidence } = await import("./scenarios.js");

  const WAKE_ID = "00000000-0000-4000-8000-000000000028";
  const SESSION_ID = "wrun_example27";
  const SURFACE_KEY = "slack/T0EXAMPLE/C0EXCHAN011";
  const ANCHOR_TS = "1769829801.042000";
  const RUN_START = "2026-01-31T03:23:16.000Z";
  const KEY: HaltLiveEvidenceKey = {
    surfaceKey: SURFACE_KEY,
    channelId: "C0EXCHAN011",
    workspaceId: "T0EXAMPLE",
    driverUserId: "U0EXOWNER",
    runStart: RUN_START,
  };

  const ingress = (overrides: { surfaceKey?: string; wakeId?: string; vendorTs?: string } = {}): AuditWireEntry => ({
    ts: "2026-01-31T03:23:21.632Z",
    org: "default",
    platform: "slack",
    workspace: "engineering",
    surface: overrides.surfaceKey ?? SURFACE_KEY,
    action: "wake.ingress",
    detail: {
      wakeId: overrides.wakeId ?? WAKE_ID,
      deliveryId: "00000000-0000-4000-8000-000000000029",
      surfaceKey: overrides.surfaceKey ?? SURFACE_KEY,
      vendorTs: overrides.vendorTs ?? "2026-01-31T03:23:21.042Z",
      vendorTsSource: "slack-ts",
      ingressTs: "2026-01-31T03:23:21.632Z",
      vendorToIngressMs: 590,
    },
  });

  const haltSet = (overrides: { surface?: string; workspace?: string; wakeId?: string } = {}): AuditWireEntry => ({
    ts: "2026-01-31T03:23:38.426Z",
    org: "default",
    platform: "slack",
    workspace: overrides.workspace ?? "T0EXAMPLE",
    surface: overrides.surface ?? "C0EXCHAN011",
    principalId: "U0EXOWNER",
    action: "admin.halt.set",
    detail: {
      level: "surface",
      scopeKey: SURFACE_KEY,
      door: "chat",
      platform: "slack",
      announced: true,
      setAt: "2026-01-31T03:23:38.319Z",
      wakeId: overrides.wakeId ?? WAKE_ID,
      sessionId: SESSION_ID,
    },
  });

  ok(
    haltWakeForSlackAnchor([ingress()], KEY, ANCHOR_TS) === WAKE_ID,
    "🔴 the measured wake.ingress row — fully qualified `surface`, domain-name `workspace` — resolves the posted Slack timestamp to its host wake",
  );

  {
    const rows = [haltSet(), ingress()];
    const wakeId = haltWakeForSlackAnchor(rows, KEY, ANCHOR_TS);
    const setRow = wakeId === undefined ? undefined : rows.find((r) => r.action === "admin.halt.set" && haltSetEvidence(r, KEY, wakeId));
    ok(setRow !== undefined, "🔴 S-HALT joins the posted Slack timestamp through wake.ingress to the same announced admin.halt.set wake");
  }

  ok(
    haltWakeForSlackAnchor([ingress({ surfaceKey: "slack/T0EXAMPLE/C0OTHERROOM" })], KEY, ANCHOR_TS) === undefined,
    "negative control: an identical vendor instant in ANOTHER ROOM resolves no wake",
  );

  ok(
    haltWakeForSlackAnchor([ingress({ surfaceKey: "slack/T9OTHER99/C0EXCHAN011" })], KEY, ANCHOR_TS) === undefined,
    "negative control: an identical vendor instant in another WORKSPACE resolves no wake — the refusal moved onto detail.surfaceKey, it did not lapse",
  );

  ok(
    haltWakeForSlackAnchor([ingress(), ingress({ wakeId: "1626ef2f-0000-0000-0000-000000000002" })], KEY, ANCHOR_TS) === undefined,
    "negative control: one anchor naming two wakes fails closed",
  );

  ok(
    haltWakeForSlackAnchor([ingress({ vendorTs: "2026-01-31T03:23:55.000Z" })], KEY, ANCHOR_TS) === undefined,
    "negative control: an ingress row for a DIFFERENT post in the same room resolves no wake",
  );

  ok(
    haltWakeForSlackAnchor([ingress({ vendorTs: "2026-01-31T04:23:21.042+01:00" })], KEY, ANCHOR_TS) === WAKE_ID,
    "the same vendor instant written in another zone still joins — milliseconds are compared, never ISO text",
  );

  ok(haltSetEvidence(haltSet(), KEY, WAKE_ID), "the measured admin.halt.set row is accepted on its own bare-id envelope");
  ok(
    !haltSetEvidence(haltSet({ surface: "C0OTHERROOM" }), KEY, WAKE_ID),
    "negative control: an announced halt in another room is refused — the set-side column checks still pin the room the widened read no longer does",
  );
  ok(
    !haltSetEvidence(haltSet({ workspace: "T9OTHER99" }), KEY, WAKE_ID),
    "negative control: an announced halt in another WORKSPACE is refused — the set-side workspace column still pins the tenant the widened read no longer does",
  );
  ok(
    !haltSetEvidence(haltSet({ wakeId: "1626ef2f-0000-0000-0000-000000000002" }), KEY, WAKE_ID),
    "negative control: a halt naming another wake is refused",
  );
}

{
  const PURGE_TS = "2026-01-31T08:56:25.742Z";
  const PURGE_TURN_PERSIST_TS = "2026-01-31T08:56:26.100Z";
  const SEED_TURN_START = Date.parse("2026-01-31T08:56:27.000Z");
  const SEED_WRITE_TS = "2026-01-31T08:56:44.900Z";

  const purge = row("memory.write", PURGE_TS, { road: MEMORY_PURGE_ROAD, kind: "memory", silo: "e2e-ambient-brain", version: 377 }, 100);
  const purgeTurnPersist = row("memory.write", PURGE_TURN_PERSIST_TS, { road: "session-persist", outcome: "edited", kind: "memory" }, 101);
  const seedWrite = row("memory.write", SEED_WRITE_TS, { road: "session-persist", outcome: "write-intent", kind: "memory", version: 378 }, 140);

  ok(
    seedMemoryWrites([purge], { seedTurnStartMs: SEED_TURN_START }).writes.length === 0,
    "🔴 OPE-2028 NEGATIVE CONTROL: a purge-road memory.write inside the skew window counts as NO seed write — the gate reads RED, which is what a live run needed it to do",
  );
  ok(
    seedMemoryWrites([purge], { seedTurnStartMs: SEED_TURN_START }).purgeWrites === 1,
    "…and the purge row is COUNTED as excluded rather than dropped silently, so the red can say what it found instead",
  );
  {
    const read = seedMemoryWrites([purge], { seedTurnStartMs: SEED_TURN_START });
    ok(
      read.purgeWrites === 1 && read.beforeFloor === 0,
      `🔴 OPE-2028: the purge row is classed by its ROAD, never lumped in with the floored-out rows (purgeWrites ${read.purgeWrites}, beforeFloor ${read.beforeFloor})`,
    );
  }
  ok(
    seedMemoryWrites([purge, seedWrite], { seedTurnStartMs: SEED_TURN_START }).writes.length === 1,
    "the seed's OWN write in the same window counts — the exclusion is of the purge's road, not of every row",
  );

  {
    const read = seedMemoryWrites([purge, purgeTurnPersist], { seedTurnStartMs: SEED_TURN_START });
    ok(read.writes.length === 0, "🔴 OPE-2028: the PURGE TURN's own turn-end persist is excluded — a non-purge road, but before the seed turn started");
    ok(read.beforeFloor === 1, "…and it is counted as floored-out, not as an unreadable row");
    ok(read.floor === "seed-turn", "…on the seed turn's own start, which is the strongest bound available here");
  }

  {
    const read = seedMemoryWrites([purge, seedWrite]);
    ok(read.writes.length === 1 && read.floor === "purge-commit", "with no seed turn start, the purge COMMIT is the floor and the later seed write still counts");
    ok(
      seedMemoryWrites([purge, purgeTurnPersist]).writes.length === 1,
      "NEGATIVE CONTROL on that weaker floor: it admits the purge turn's own persist, which is exactly why the seed-turn bound is preferred — stated, not hidden",
    );
    ok(read.detail.includes("PURGE COMMIT"), "the detail names WHICH floor placed the count — a gate that cannot say what it measured is not evidence");
  }

  ok(
    seedMemoryWrites([purge, row("memory.write", "2026-01-31T08:56:44.900Z", { road: "session-persist" }, 99)]).writes.length === 0,
    "a row whose `ts` is LATER but whose `seq` is lower than the purge commit's does not count — the store's insert order decides",
  );
  ok(
    seedMemoryWrites([purge, row("memory.write", "2026-01-31T08:56:44.900Z", { road: "session-persist" }, 101)]).writes.length === 1,
    "negative control on that: the same row with a HIGHER seq does count",
  );

  {
    const noRoad = seedMemoryWrites([purge, row("memory.write", SEED_WRITE_TS, { kind: "memory" }, 140)], { seedTurnStartMs: SEED_TURN_START });
    ok(noRoad.writes.length === 0 && noRoad.unreadableRoad === 1, "a memory.write row with no readable `road` is excluded and COUNTED — the strict direction for a gate that asserts a row IS there");
    const unplaceable = seedMemoryWrites([row("memory.write", "not-a-time", { road: "session-persist" })], { seedTurnStartMs: SEED_TURN_START });
    ok(unplaceable.writes.length === 0 && unplaceable.unplaceable === 1, "a row with no seq and an unparseable ts cannot be placed against the floor, so it is excluded and counted");
  }

  {
    const below = seedMemoryWrites([purge, seedWrite], { seedTurnStartMs: SEED_TURN_START });
    ok(below.detail.includes("(and the purge commit below it)"), "the evidence line places a purge commit BELOW the seed turn's start when that is where it is");
    const late = seedMemoryWrites([row("memory.write", "2026-01-31T08:56:50.000Z", { road: MEMORY_PURGE_ROAD, kind: "memory" }, 200), seedWrite], {
      seedTurnStartMs: SEED_TURN_START,
    });
    ok(late.writes.length === 0 && late.beforeFloor === 1, "a purge that commits AFTER the seed's own write excludes it by position — the canary was erased, and the gate reds");
    ok(
      late.detail.includes("sits ABOVE it"),
      `🔴 and the evidence line says the purge commit sits ABOVE the seed turn's start, never the reverse (said: ${late.detail})`,
    );
    const unplaceable = seedMemoryWrites([row("memory.write", "not-a-time", { road: MEMORY_PURGE_ROAD }), seedWrite], { seedTurnStartMs: SEED_TURN_START });
    ok(
      unplaceable.detail.includes("cannot place against it") && unplaceable.writes.length === 0,
      "…and an anchor this reader cannot place says so rather than claiming either side, while the rows it cannot compare stay excluded",
    );
  }

  {
    const read = seedMemoryWrites([seedWrite]);
    ok(read.writes.length === 1 && read.floor === "window", "with no purge row and no seed turn start, the seed's own write still counts and the floor is named `window`");
  }

  ok(
    seedMemoryWrites([row("memory.operational_write", SEED_WRITE_TS, { road: "status-board" }, 140)], { seedTurnStartMs: SEED_TURN_START }).writes.length === 0,
    "negative control: an operational write is a different action and never satisfies the seed gate",
  );

  const MEASURED_ASK =
    "This conflicts with your immediately previous instruction to permanently erase every stored OPE121 canary-code fact. " +
    "Should I keep the erasure in force, or explicitly supersede it and store this new fact?";
  ok(readsAsClarifyingQuestion(MEASURED_ASK), "🔴 OPE-2028: the ack a live run measured reads as a CLARIFYING QUESTION, so the red can name the fixture instead of the write path");
  ok(
    !readsAsClarifyingQuestion("Stored. The OPE121 canary code is obsidian-49038, written to the team's memory."),
    "NEGATIVE CONTROL: a plain storage ack is not a clarifying question",
  );
  ok(
    !readsAsClarifyingQuestion("Saved that. Anything else?"),
    "NEGATIVE CONTROL: a question mark alone is not a clarifying question — an ordinary ack ends in one",
  );
  ok(
    !readsAsClarifyingQuestion("I should ideally confirm the file later"),
    "NEGATIVE CONTROL: an ask shape with no question mark is not one either — both terms are required",
  );
  ok(
    readsAsClarifyingQuestion("Stored it. Do you want me to delete the older codes as well?"),
    "a seat that stored AND asked still reads as one — the leg LOGS that case and never fails on it, because the write row is what the gate turns on",
  );
}

{
  const SEED_WAKE = "9c88f591";
  const TASK = "task_933d7c41f8ab4e2f91d07b5c";
  const SEAT = "s-seat";
  const ACK = "1758541231.820000";
  const SETTLEMENT = "1758541328.565000";
  const TURN_START_MS = Date.parse("2026-01-31T14:24:09.614Z");

  const purge = row("memory.write", "2026-01-31T14:24:04.000Z", { road: MEMORY_PURGE_ROAD, kind: "memory", silo: "e2e-ambient-brain", version: 377 }, 10);
  const turnStart = row("wake.turn_start", "2026-01-31T14:24:09.614Z", { wakeId: SEED_WAKE }, 11);
  const dispatch = row("delegation.task_started", "2026-01-31T14:24:19.884Z", { task: TASK, session: SEAT, call: "call_0" }, 12, "ingest");
  const ackPost = row("reply.post", "2026-01-31T14:24:31.820Z", { id: ACK, sessionId: SEAT, wakeId: SEED_WAKE }, 13);
  const struck = row("memory.claim_withheld", "2026-01-31T14:24:31.853Z", { claims: 1, shapes: ["stored"], wakeId: SEED_WAKE, sessionId: SEAT }, 14);
  const foreignStruck = row("memory.claim_withheld", "2026-01-31T14:24:40.000Z", { claims: 2, shapes: ["remembered"], wakeId: "w-other" }, 14);
  const settled = row("delegation.task_settled", "2026-01-31T14:26:08.100Z", { task: TASK, session: SEAT, status: "completed" }, 15, "ingest");
  const persist = row("memory.write", "2026-01-31T14:26:08.442Z", { road: "session-persist", outcome: "write-intent", kind: "memory", silo: "e2e-ambient-brain", version: 379 }, 16);
  const settlementPost = row("reply.post", "2026-01-31T14:26:08.565Z", { id: SETTLEMENT, sessionId: SEAT, wakeId: SEED_WAKE }, 17);
  const board = [purge, turnStart, dispatch, ackPost, struck, foreignStruck, settled, persist, settlementPost];
  const seedOpts = { seedWakeId: SEED_WAKE, seedTurnStartMs: TURN_START_MS, ackId: ACK };

  {
    const read = seedSettlementRead(board, seedOpts);
    ok(read.kind === "settled", `🔴 OPE-2036: a seed turn that dispatched and settled reads as SETTLED (got ${read.kind}: ${read.detail})`);
    ok(read.dispatched.join(",") === TASK, `…naming the task the SEED TURN dispatched (got ${read.dispatched.join(",")})`);
    ok(read.post === settlementPost, "…and the ceiling is the SETTLEMENT post, the second reply on the seed wake after the settlement row");
    ok(read.post !== ackPost, "🔴 OPE-2036 NEGATIVE CONTROL: the INTERIM ack is NOT the settlement post — it is the message the pre-fix gate measured the turn from");
    ok(read.roundTripMs === Date.parse("2026-01-31T14:26:08.565Z") - TURN_START_MS, `…and the round trip is REPORTED as turn start → settlement post (got ${String(read.roundTripMs)}ms)`);
    ok(read.claimsWithheld === 1, `…and the ack's STRUCK 'stored' claim is counted — the seed wake's own, never the foreign one (got ${read.claimsWithheld})`);
    const gated = seedMemoryWrites(board, { seedTurnStartMs: TURN_START_MS, settlementPost: read.post });
    ok(gated.writes.length === 1 && gated.writes[0] === persist, `🔴 OPE-2036: the gate counts the WORKER's persist — the row standing right before the settlement post (got ${gated.writes.length})`);
    ok(gated.purgeWrites === 1 && gated.afterSettlement === 0, `…and leg 0's purge is still excluded by road, with nothing above the ceiling (purge ${gated.purgeWrites}, after ${gated.afterSettlement})`);
    const preFix = seedMemoryWrites([purge, turnStart, dispatch, ackPost, struck], { seedTurnStartMs: TURN_START_MS });
    ok(preFix.writes.length === 0, "🔴 OPE-2036 CONTROL: read at the interim ack, the same window holds NO seed write — which is the red a live run reported over a deployment that stored the code");
  }

  {
    const noSettleRow = seedSettlementRead([purge, turnStart, dispatch, ackPost, struck], seedOpts);
    ok(noSettleRow.kind === "unsettled", `🔴 OPE-2036: a dispatch with no ${"delegation.task_settled"} row reads as UNSETTLED (got ${noSettleRow.kind})`);
    ok(noSettleRow.unsettled.join(",") === TASK && noSettleRow.detail.includes(TASK), `…and it NAMES the task still running (got ${noSettleRow.detail})`);
    ok(noSettleRow.post === undefined, "…and hands the caller no ceiling, so the write gate cannot run on a window the worker has not closed");
    const noPost = seedSettlementRead([purge, turnStart, dispatch, ackPost, struck, settled, persist], seedOpts);
    ok(noPost.kind === "unposted", `🔴 OPE-2036: every task settled and no reply on the seed wake stands after it reads as UNPOSTED (got ${noPost.kind})`);
    ok(noPost.settlement === settled && noPost.post === undefined, "…the settlement ROW is held and the post is not, which is the pair the red reports");
    const foreign = row("reply.post", "2026-01-31T14:26:09.000Z", { id: "1758541329.000000", sessionId: SEAT, wakeId: "w-other" }, 18);
    const foreignRead = seedSettlementRead([purge, turnStart, dispatch, ackPost, settled, persist, foreign], seedOpts);
    ok(foreignRead.kind === "unposted", "🔴 OPE-2036 NEGATIVE CONTROL: a reply on a FOREIGN wake is not the settlement post — the join is the seed wake's own lineage");
    ok(foreignRead.detail.includes("1 reply row(s) in the window belong to another wake"), `…and the red counts what it refused (got ${foreignRead.detail})`);
  }

  {
    const inlineRows = [purge, turnStart, ackPost, persist];
    const read = seedSettlementRead(inlineRows, seedOpts);
    ok(read.kind === "inline", `🔴 OPE-2036: a seed turn with no dispatch row reads as INLINE — the seat wrote with its own tools (got ${read.kind})`);
    ok(read.post === undefined && read.dispatched.length === 0, "…and it offers no ceiling, so §16's filter runs exactly as it did before OPE-2036");
    const before = seedMemoryWrites(inlineRows, { seedTurnStartMs: TURN_START_MS });
    ok(before.writes.length === 1 && before.afterSettlement === 0, "the inline gate still counts the seat's own write");
    ok(
      !before.detail.includes("after the settlement post"),
      `🔴 OPE-2036: with no ceiling the evidence sentence is the pre-fix one, byte for byte — a reader never meets a count that can only be zero (got ${before.detail})`,
    );
    const legZeroDispatch = row("delegation.task_started", "2026-01-31T14:24:02.000Z", { task: "task_legzero", session: SEAT }, 9, "ingest");
    const stillInline = seedSettlementRead([legZeroDispatch, ...inlineRows], seedOpts);
    ok(stillInline.kind === "inline", "🔴 OPE-2036 NEGATIVE CONTROL: a dispatch BELOW the seed turn's start is a PREVIOUS leg's and never makes this turn delegated");
    const otherSeat = row("delegation.task_started", "2026-01-31T14:24:19.884Z", { task: "task_routine", session: "s-routine" }, 12, "ingest");
    const notMine = seedSettlementRead([otherSeat, ...inlineRows], seedOpts);
    ok(notMine.kind === "inline", "🔴 OPE-2036: a dispatch by ANOTHER session inside the same seconds is not this seat's — the ack's own row names the session to compare against");
    ok(notMine.detail.includes("belong to ANOTHER session"), `…and the log says so rather than dropping it silently (got ${notMine.detail})`);
    ok(seedSettlementRead([dispatch, ...inlineRows], seedOpts).kind === "unsettled", "…and the seat's OWN dispatch at the same instant is read as this turn's, so the session term is a narrowing and not a mute");
    const noSession = row("reply.post", "2026-01-31T14:24:31.820Z", { id: ACK, wakeId: SEED_WAKE }, 13);
    const unnarrowable = seedSettlementRead([purge, turnStart, dispatch, noSession, persist], seedOpts);
    ok(unnarrowable.kind === "unjoinable", `🔴 OPE-2036: a dispatch this reader cannot attribute to the seat is REFUSED, not accepted (got ${unnarrowable.kind}: ${unnarrowable.detail})`);
    ok(unnarrowable.detail.includes("cannot tell the seat's own dispatch from a fire's"), `…and it says why, so the route line names the ambiguity (got ${unnarrowable.detail})`);
    ok(
      seedSettlementRead([purge, turnStart, noSession, persist], seedOpts).kind === "inline",
      "…and with no dispatch at all the missing session is irrelevant — the refusal is scoped to the case where the narrowing would have mattered",
    );
  }

  {
    const purgeOnly = seedMemoryWrites([purge, turnStart, dispatch, ackPost, settled, settlementPost], {
      seedTurnStartMs: TURN_START_MS,
      settlementPost,
    });
    ok(purgeOnly.writes.length === 0, "🔴 OPE-2036: with the settlement ceiling applied, leg 0's purge-road write STILL counts as no seed write");
    ok(purgeOnly.purgeWrites === 1, "…and is still reported as leg 0's erase rather than as one more floored-out row");
    const late = row("memory.write", "2026-01-31T14:27:00.000Z", { road: "session-persist", outcome: "edited", kind: "memory" }, 30);
    const above = seedMemoryWrites([purge, turnStart, dispatch, ackPost, settled, settlementPost, late], {
      seedTurnStartMs: TURN_START_MS,
      settlementPost,
    });
    ok(above.writes.length === 0 && above.afterSettlement === 1, `🔴 OPE-2036: a write ABOVE the settlement post is excluded and COUNTED (writes ${above.writes.length}, after ${above.afterSettlement})`);
    ok(above.detail.includes("1 after the settlement post"), `…and the sentence names OPE-1915, so the next reader goes to the persist order rather than to the write path (got ${above.detail})`);
    ok(seedMemoryWrites([purge, turnStart, late], { seedTurnStartMs: TURN_START_MS }).writes.length === 1, "…and without a ceiling that same row counts, so the exclusion is the ceiling's and not a mute reader");
    const unplaceable = seedMemoryWrites([row("memory.write", "not-a-time", { road: "session-persist" })], { settlementPost });
    ok(unplaceable.writes.length === 0 && unplaceable.unplaceable === 1, "a write this reader cannot place against the ceiling is excluded and counted, never guessed at");
  }

  {
    const SEED_WAKE_Re = "7a96610c";
    const MINTED_WAKE_Re = "b6a55ebd";
    const TASK_Re = "task_97f964968f606158574f4797";
    const SEAT_Re = "wrun_example39";
    const INTERIM_Re = "1769897345.296000";
    const SETTLEMENT_Re = "1769897495.621000";
    const TURN_START_Re = Date.parse("2026-01-31T22:08:57.618Z");
    const INTERIM_TEXT =
      "I've handed off the memory update for the new current OPE121 canary code to a worker. I'll report the recorded fact when the update returns.";
    const SETTLEMENT_TEXT = "Recorded and verified the new current code: `obsidian-34269`, superseding `obsidian-410`.";

    const turnStartRe = row("wake.turn_start", "2026-01-31T22:08:57.618Z", { wakeId: SEED_WAKE_Re }, 21);
    const dispatchRe = row("delegation.task_started", "2026-01-31T22:09:01.654Z", { task: TASK_Re, session: SEAT_Re, call: "call_0" }, 22, "ingest");
    const interimRe = row("reply.post", "2026-01-31T22:09:05.363Z", { id: INTERIM_Re, sessionId: SEAT_Re, wakeId: SEED_WAKE_Re }, 23);
    const taskWakeRe = row(
      "unified.task_wake",
      "2026-01-31T22:11:29.926Z",
      { task: TASK_Re, wakeId: MINTED_WAKE_Re, inheritedWakeId: SEED_WAKE_Re, outcome: "installed" },
      24,
      "ingest",
    );
    const settledRe = row("delegation.task_settled", "2026-01-31T22:11:29.966Z", { task: TASK_Re, session: SEAT_Re, status: "completed" }, 25, "ingest");
    const persistRe = row("memory.write", "2026-01-31T22:11:35.553Z", { road: "session-persist", outcome: "write-intent", kind: "memory", silo: "e2e-ambient-brain", version: 385 }, 26);
    const settlementPostRe = row("reply.post", "2026-01-31T22:11:35.665Z", { id: SETTLEMENT_Re, sessionId: SEAT_Re, wakeId: SEED_WAKE_Re }, 27);
    const runRe = [turnStartRe, dispatchRe, interimRe, taskWakeRe, settledRe, persistRe, settlementPostRe];
    const keysRe = { seedWakeId: SEED_WAKE_Re, seedTurnStartMs: TURN_START_Re };

    process.env.OE_SQLITE_PATH = join("/tmp", `oe-gate-joins-halt-test-${process.pid}.sqlite3`);
    const { isFillerAck: fillerAck } = await import("./scenarios.js");
    ok(fillerAck(INTERIM_TEXT), "🔴 OPE-2044 PREMISE: a live run's interim ack DOES read as filler — which is why the latch stepped over it and took the next reply");
    ok(!fillerAck(SETTLEMENT_TEXT), "🔴 OPE-2044 PREMISE CONTROL: the settlement report does NOT read as filler, so the latch stops there — it is the reply the leg ends up holding as its 'ack'");

    const latchedReport = seedSettlementRead(runRe, { ...keysRe, ackId: SETTLEMENT_Re });
    ok(
      latchedReport.kind === "settled",
      `🔴 OPE-2044: a latched ack that stands AT OR AFTER the settlement is a settlement-post candidate, not an exclusion (got ${latchedReport.kind}: ${latchedReport.detail})`,
    );
    ok(latchedReport.post === settlementPostRe, "…and the ceiling is that very post — the row a live run's join excluded by name and then reported missing");
    ok(latchedReport.dispatched.join(",") === TASK_Re, `…with the seed turn's own task named (got ${latchedReport.dispatched.join(",")})`);
    ok(
      latchedReport.detail.includes("that post IS the reply the caller latched as the ack"),
      `…and the route line SAYS the latch stepped over the hand-off, so the next red of this family names itself (got ${latchedReport.detail})`,
    );
    const gatedRe = seedMemoryWrites(runRe, { seedTurnStartMs: TURN_START_Re, settlementPost: latchedReport.post });
    ok(
      gatedRe.writes.length === 1 && gatedRe.writes[0] === persistRe && gatedRe.afterSettlement === 0,
      `🔴 OPE-2044: under that ceiling the gate counts the worker's version-385 persist and nothing above it — the row Phase B polled 180 s without ever reaching (writes ${gatedRe.writes.length}, after ${gatedRe.afterSettlement})`,
    );

    const laterReplyRe = row("reply.post", "2026-01-31T22:12:00.000Z", { id: "1769897520.000000", sessionId: SEAT_Re, wakeId: MINTED_WAKE_Re }, 28);
    const twoAfter = seedSettlementRead([...runRe, laterReplyRe], { ...keysRe, ackId: SETTLEMENT_Re });
    ok(
      twoAfter.kind === "settled" && twoAfter.post === settlementPostRe,
      `🔴 OPE-2044: with two replies standing after the settlement the ceiling is the OLDEST — the latched ack itself, never the seat's later post (got ${twoAfter.kind}, post at ${twoAfter.post?.ts ?? "none"})`,
    );
    ok(
      twoAfter.post !== laterReplyRe,
      "🔴 OPE-2044 NEGATIVE CONTROL: the later reply is NOT the ceiling — taking it would let a following turn's own write satisfy the seed gate (OPE-1915)",
    );

    const latchedInterim = seedSettlementRead(runRe, { ...keysRe, ackId: INTERIM_Re });
    ok(
      latchedInterim.kind === "settled" && latchedInterim.post === settlementPostRe,
      `🔴 OPE-2044 NEGATIVE CONTROL: a live run's latch — the INTERIM ack as \`ackId\` — reads the SAME settlement post (got ${latchedInterim.kind}, post at ${latchedInterim.post?.ts ?? "none"})`,
    );
    ok(
      latchedInterim.post !== interimRe && latchedReport.post !== interimRe,
      "🔴 OPE-2044 NEGATIVE CONTROL: the INTERIM ack is never the settlement post — under EITHER latch. It stands 150 s before the worker's write, and taking it is the OPE-2036 defect",
    );
    ok(
      !latchedInterim.detail.includes("that post IS the reply the caller latched as the ack"),
      `…and the live-run shape does NOT claim the latch held the report, so the new clause is a naming and not decoration (got ${latchedInterim.detail})`,
    );
    ok(
      latchedReport.roundTripMs === Date.parse("2026-01-31T22:11:35.665Z") - TURN_START_Re && latchedReport.roundTripMs === latchedInterim.roundTripMs,
      `…and both latches report the SAME round trip, because it is the POST that ends the turn (got ${String(latchedReport.roundTripMs)} / ${String(latchedInterim.roundTripMs)}ms)`,
    );

    const unplaceableAck = row("reply.post", "not-a-time", { id: "1769897380.000000", sessionId: SEAT_Re, wakeId: SEED_WAKE_Re });
    const withUnplaceable = seedSettlementRead([...runRe, unplaceableAck], { ...keysRe, ackId: "1769897380.000000" });
    ok(
      withUnplaceable.kind === "settled" && withUnplaceable.post === settlementPostRe,
      `🔴 OPE-2044: an ack row this reader cannot place never becomes the ceiling — the POSITION check excludes it, with or without the name (got ${withUnplaceable.kind})`,
    );

    const withSkip = seedAckLatchDetail({ ts: SETTLEMENT_Re, text: SETTLEMENT_TEXT }, [{ ts: INTERIM_Re, text: INTERIM_TEXT }]);
    ok(withSkip.includes(`latched reply ${SETTLEMENT_Re} as the seed ack`), `🔴 OPE-2044: the log NAMES the reply the latch took (got ${withSkip})`);
    ok(withSkip.includes(INTERIM_Re), `…and the ts of the reply the filler skip stepped over (got ${withSkip})`);
    ok(withSkip.includes(INTERIM_TEXT.slice(0, 80)) && !withSkip.includes(INTERIM_TEXT), `…with that reply's FIRST 80 CHARACTERS and no more of it (got ${withSkip})`);
    ok(withSkip.includes("stepped over 1 earlier bot reply"), `…and it counts them, so two skipped replies read as two (got ${withSkip})`);
    const noSkip = seedAckLatchDetail({ ts: INTERIM_Re, text: INTERIM_TEXT }, []);
    ok(noSkip.includes("stepped over NO earlier bot reply"), `🔴 OPE-2044 NEGATIVE CONTROL: with nothing skipped the log SAYS so (got ${noSkip})`);
    ok(!noSkip.includes("stepped over 1") && !noSkip.includes(SETTLEMENT_Re), `…and names no reply it did not step over (got ${noSkip})`);
    const flattened = seedAckLatchDetail({ ts: SETTLEMENT_Re, text: "Recorded.\n\n  And verified:\n  obsidian-34269" }, []);
    ok(flattened.includes("Recorded. And verified: obsidian-34269"), `…and a multi-line reply is flattened onto one line (got ${flattened})`);
  }

  {
    const noWake = seedSettlementRead(board, { seedTurnStartMs: TURN_START_MS, ackId: ACK });
    ok(noWake.kind === "unjoinable" && noWake.detail.includes("wake.ingress"), `no seed wake means no join, and it names the row it wanted (got ${noWake.kind}: ${noWake.detail})`);
    const noFloor = seedSettlementRead(board, { seedWakeId: SEED_WAKE, ackId: ACK });
    ok(noFloor.kind === "unjoinable" && noFloor.detail.includes("wake.turn_start"), `no turn start means no floor, and it names that row instead (got ${noFloor.kind}: ${noFloor.detail})`);
    const early = seedSettlementRead([purge, turnStart], seedOpts);
    ok(early.kind === "unread", `🔴 OPE-2036: with the ack's own reply.post row not yet readable the dispatch question is UNREAD, never "inline" (got ${early.kind})`);
    ok(early.detail.includes(ACK), `…and it names the row it is waiting on (got ${early.detail})`);
    ok(seedSettlementRead([purge, turnStart, ackPost], seedOpts).kind === "inline", "…and the moment the ack's row lands, the same window answers INLINE — the fence opens rather than holding for ever");
    ok(seedSettlementRead([purge, turnStart], { seedWakeId: SEED_WAKE, seedTurnStartMs: TURN_START_MS }).kind === "inline", "a caller that hands in no ack id is never held by the fence");
  }
}

{
  const ORDINARY = "ownfact-60697";
  const OWN = "ownme-60698";

  ok(connectorAnswerRoad(0) === "rest", "no connector.acting_identity row names the REST road — the designed org road, not a missing gate");
  ok(connectorAnswerRoad(2) === "tool", "a row names the TOOL road — OE's own gated Notion tool chose a credential");

  {
    const rest = ordinaryPageReadVerdict({ actingIdentityRows: 0, marker: ORDINARY, replyText: `The last line reads: fresh fact for this run: ${ORDINARY}.` });
    ok(rest.answered && rest.road === "rest", "🔴 OPE-2037: the REST road ANSWERS arm 1 — the shape six boards scored CANNOT RUN now passes on the fact it brought back");
    ok(rest.detail.includes("REST road"), "…and the read-out names the road it saw, so a board can tell the two apart without a second query");

    const tool = ordinaryPageReadVerdict({ actingIdentityRows: 1, marker: ORDINARY, replyText: `Last line: ${ORDINARY}` });
    ok(tool.answered && tool.road === "tool", "the TOOL road answers it too — the gate is the fact, and the road is reported beside it");

    ok(
      !ordinaryPageReadVerdict({ actingIdentityRows: 3, marker: ORDINARY, replyText: "I read the page. The last line is about archiving scratch blocks." }).answered,
      "NEGATIVE: a reply that quotes no run token has not shown it read the page — a rich reply on the tool road does not substitute for the fact",
    );
    ok(
      !ordinaryPageReadVerdict({ actingIdentityRows: 0, marker: ORDINARY, replyText: undefined }).answered,
      "VACUITY: no reply at all is a RED, never a pass — the whole arm is that something came back",
    );
    ok(
      ordinaryPageReadVerdict({ actingIdentityRows: 0, marker: ORDINARY, replyText: undefined }).detail.includes("no settlement reply arrived"),
      "…and it says so, rather than reporting an absent token as a wrong answer",
    );
    ok(
      !ordinaryPageReadVerdict({ actingIdentityRows: 0, marker: ORDINARY, replyText: `Last line: ownfact-11111` }).answered,
      "NEGATIVE: a PREVIOUS run's token in the same room does not satisfy this run's gate — the digit run is the anchor",
    );
    ok(
      ordinaryPageReadVerdict({ actingIdentityRows: 0, marker: ORDINARY, replyText: "the page ends with ownf-60697" }).answered,
      "the match goes through `carriesFactToken`, so a model's SHORTENED spelling of the token still counts (OPE-2032) — an `includes` here would red a correct run",
    );
  }

  {
    ok(namesOwnAccountRefusal("I can't read this page with your own Notion account — this chat holds no personal grant.", "notion"), "the plain refusal reads as one");
    ok(namesOwnAccountRefusal("I am unable to act on your behalf on Notion.", "notion"), "…and so does the `on your behalf` paraphrase");
    ok(namesOwnAccountRefusal("I cannot act as you on Notion; the shared integration is all I hold.", "notion"), "…and the `as you` paraphrase, which is the commonest of the three");
    ok(namesOwnAccountRefusal("I won't use your Notion account for this.", "notion"), "…and a refusal phrased as a decision rather than an inability");
    ok(namesOwnAccountRefusal("I cannot act with your personal Notion account here.", "notion"), "🔴 the QUALIFIED possessive — `your personal Notion account` — reads as a refusal");
    ok(namesOwnAccountRefusal("I am not able to use your Notion credentials.", "notion"), "🔴 …and the PLURAL noun — `your Notion credentials`");
    ok(namesOwnAccountRefusal("I do not have access to your personal Notion account.", "notion"), "🔴 …and `do not have access to your personal Notion account`");
    ok(
      namesOwnAccountRefusal("I can only use the workspace integration, never a personal Notion account.", "notion"),
      "🔴 …and the NON-possessive form the third route sentence teaches — `never a personal Notion account`, which needs both the widened noun set and `never` in the inability set",
    );
    ok(
      !namesOwnAccountRefusal("I can't use a personal github account for this.", "notion"),
      "🔴 NEGATIVE: the non-possessive arm REQUIRES the connector — without it `a personal account` in a GitHub sentence would answer for Notion",
    );
    ok(
      !namesOwnAccountRefusal("I can't use your personal github credentials here.", "notion"),
      "🔴 NEGATIVE: …and the qualified possessive stays connector-scoped too, so the widening did not buy the cross-vendor match back",
    );
    ok(
      !namesOwnAccountRefusal("I couldn't find that heading. Your Notion account is linked to this workspace.", "notion"),
      "🔴 NEGATIVE: the two terms must meet inside ONE SENTENCE — an unrelated inability beside an unrelated mention is not a refusal, and a document-wide AND would read it as one",
    );
    ok(
      !namesOwnAccountRefusal("As you asked, I can't quote a line I never read.", "notion"),
      "NEGATIVE: the DISCOURSE `as you` (`as you asked`) carries no account meaning — without the lookahead this sentence would score arm 2 green",
    );
    ok(
      !namesOwnAccountRefusal("I can't act with your github account here.", "notion"),
      "🔴 NEGATIVE: the CONNECTOR is spliced in — a sentence about somebody's GitHub account never answers a question about Notion",
    );
    ok(!namesOwnAccountRefusal("Here is the last line of the page body.", "notion"), "NEGATIVE: an ordinary answer is not a refusal");

    ok(namesLendRoad("You can lend me your Notion account through a credential grant if you want me to read as you."), "the OFFER of the lend road reads as naming it");
    ok(namesLendRoad("Hand this to a task and it will raise the ask."), "…and so does the route sentence the product teaches for the consent flow");
    ok(
      namesLendRoad("This deployment cannot lend a personal Notion account at all, so there is no consent flow to start."),
      "🔴 …and so does the route sentence that says the road does NOT exist here — `ownAccountRefusal` has three route branches and the third one's whole content is that absence",
    );
    ok(!namesLendRoad("Here is the last line of the page body."), "NEGATIVE: an ordinary answer names no lend road");
    ok(!namesLendRoad("I can't do that."), "NEGATIVE: a bare refusal names no road either — which is the state arm 2 scores `unscored`");
  }

  {
    const verdict = (over: Partial<Parameters<typeof ownAccountAnswerVerdict>[0]> = {}) =>
      ownAccountAnswerVerdict({ connector: "notion", grantAsks: 0, marker: OWN, refusalRows: 0, replyText: undefined, ...over });

    const gate = verdict({ refusalRows: 1, replyText: "I can't do that here." });
    ok(gate.kind === "gate-refusal" && gate.passed, "(i) a connector.acting_identity refusal row passes arm 2 — the tool road's own evidence");

    const ask = verdict({ grantAsks: 1, replyText: "I've asked the owner to lend their Notion account." });
    ok(ask.kind === "grant-ask" && ask.passed, "(iii) a grant.asked row passes — the person asked to act as themselves, so raising the lend is answering them");

    const honest = verdict({ replyText: "I cannot act with your own Notion account on the org's access. You can lend me your account through a credential grant." });
    ok(honest.kind === "honest-refusal" && honest.passed, "(ii) an honest refusal naming the lend road passes — the REST route's designed answer, which no row can carry");
    ok(!honest.markerCarried, "…and it reports that the fresh page fact was NOT quoted, which is the term that makes it a refusal rather than a disclosed read");

    const red = verdict({ replyText: `Sure — the last line reads: fresh fact for this run: ${OWN}.` });
    ok(red.kind === "substituted" && !red.passed, "🔴 THE RED: the fresh page fact came back with nothing in the room saying whose account read it — OPE-1525 live");
    ok(
      verdict({ refusalRows: 2, grantAsks: 1, replyText: `Here it is: ${OWN}` }).kind === "substituted",
      "🔴 THE RED BEATS EVERY PASS SHAPE: a gate refusal on ONE read does not excuse a second read that answered as the org, so the row arms never override it",
    );
    ok(
      !ownAccountAnswerVerdict({ connector: "notion", grantAsks: 0, marker: OWN, refusalRows: 0, replyText: `Here it is: ownme-11111` }).markerCarried,
      "NEGATIVE: a token from another run does not trip the red — the digit run is this arm's own",
    );

    const disclosed = verdict({
      replyText: `I cannot act with your own Notion account here — you would need to lend it to this chat. Reading under the shared integration, the last line is ${OWN}.`,
    });
    ok(disclosed.kind === "honest-refusal" && disclosed.passed, "a DISCLOSED org read is not the substitution — the person was told which account answered");
    ok(disclosed.markerCarried, "…and `markerCarried` reports the quote, so a board never reads a disclosed read as a silent refusal");
    ok(
      verdict({ replyText: `Reading under the shared integration rather than yours, the last line is ${OWN}.` }).kind === "substituted",
      "🔴 a BARE disclosure does NOT escape the red: it names the account it used and never says the agent could not act as the requester, which is the sentence `ownAccountRefusal` tells the seat to say BEFORE it reads at all",
    );

    ok(verdict().kind === "unscored" && !verdict().passed, "VACUITY: no row, no reply — a RED, and never a pass");
    ok(verdict().detail.includes("never arrived"), "…and the read-out says the reply never arrived, which is a different diagnosis from a reply that said the wrong thing");
    ok(
      verdict({ replyText: "I can't use your own Notion account for this." }).kind === "unscored",
      "a refusal that names NO lend road does not score — it has told the person nothing about what to do next",
    );
    ok(
      verdict({ replyText: "I can't use your own Notion account for this." }).detail.includes("names no lend road"),
      "…and the red says which of the two terms was missing",
    );
    ok(
      verdict({ replyText: "You can lend me your Notion account whenever you like." }).kind === "unscored",
      "…and so does a reply that names the lend road without saying it cannot act with the requester's own account",
    );
  }

  {
    const SESSION = "sess-1";
    const started = row("delegation.task_started", "2026-01-31T14:27:53.000Z", { session: SESSION, task: "task_e3437b" }, 10, "ingest");
    const settled = row("delegation.task_settled", "2026-01-31T14:28:53.000Z", { session: SESSION, task: "task_e3437b" }, 11, "ingest");
    const join = delegationJoinForSession([started, settled], SESSION);
    ok(join.started === 1 && join.settled === 1, "the delegation join counts this session's dispatch and its settle");
    ok(
      delegationJoinForSession([started], SESSION).settled === 0,
      "a dispatch with no settle is reported as one — a worker that never reported back is a different picture from one that did",
    );
    const inSeat = delegationJoinForSession([started, settled], "sess-2");
    ok(inSeat.started === 0 && inSeat.detail.includes("in-seat"), "🔴 NEGATIVE: another session's rows are not this one's, and a turn with no dispatch reads as the seat answering in-seat — which this leg REPORTS and never fails on");
  }
}

console.log(`✓ ${n} gate-joins assertions passed`);
