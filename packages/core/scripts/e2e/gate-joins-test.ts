import assert from "node:assert/strict";
import type { AuditWireEntry } from "./audit-read.js";
import {
  AUDIT_SINCE_SKEW_MS,
  auditSinceForDriverClock,
  auditSinceForVendorInstant,
  carriesHostTemplate,
  classifyConnectorRoad,
  classifyUnansweredWake,
  fireAnchor,
  fixtureSalt,
  isMemoryHopWrite,
  memoryPathReadsBetween,
  PROMISE_SUBJECT,
  replyPostSessionId,
  rowsAtOrAfter,
  saltedFixtureLine,
  settlementReportMessageIds,
  wakeIdForVendorInstant,
  workerRoadForOp,
} from "./gate-joins.js";
import { seatCatchUpWake, SEAT_READ_RESULT_TYPES, SEAT_READ_TOOL, type TranscriptWireEvent } from "./transcript-read.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const row = (action: string, ts: string, detail: Record<string, unknown>, seq?: number): AuditWireEntry => ({
  ts,
  org: "default",
  platform: "slack",
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
  const ids = settlementReportMessageIds(rows);
  ok(ids.has(REPORT), "the message that carried the settlement report is named — by POSITION, since the row itself names only the task and the wake");
  ok(!ids.has(ANSWER), "🔴 and the answer posted AFTER it is not: a pairing that took the newest post would skip the very reply the leg is waiting for");

  const foreign = [...rows, row("reply.post", "2026-01-27T00:33:24.000Z", { id: "1769474004.000000", wakeId: "some-other-wake", chars: 40 }, 9)];
  ok(!settlementReportMessageIds(foreign).has("1769474004.000000"), "a post from ANOTHER wake is never paired with this settlement row, however close it sits");

  ok(settlementReportMessageIds([rows[1]!]).size === 0, "a settlement row whose wake no reply.post names contributes nothing — there is no message to skip, and inventing one would skip a real answer");
  ok(settlementReportMessageIds([rows[0]!, rows[2]!]).size === 0, "reply.post rows with no settlement row beside them name nothing: an ordinary turn skips nothing at all");

  const noSeq = rows.map((r) => ({ ts: r.ts, org: r.org, platform: r.platform, workspace: r.workspace, action: r.action, detail: r.detail }));
  ok(settlementReportMessageIds(noSeq).has(REPORT), "with no `seq` on the wire the pairing falls back to `ts` and still finds the report");

  ok(replyPostSessionId(rows, REPORT) === "wrun_A", "replyPostSessionId names the session that posted a message the leg holds");
  ok(replyPostSessionId(rows, "1769384956.000000") === undefined, "…and answers nothing for a message no reply.post row names");
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

console.log(`✓ ${n} gate-joins assertions passed`);
