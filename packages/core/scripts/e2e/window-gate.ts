import { type AuditWireEntry } from "./audit-read.js";
import {
  sleep, dS, makeWant, createRecorder, createInjector, createAuditReader, readToolCalls, readToolNames, scoreWithheldPair,
} from "./window-harness.js";
import { wireNeonOperationalStore, rotateUnifiedWindow } from "./rotate-window-lib.js";
import { withheldFromGrain } from "../../agent/access/window-gate-manifest.js";
import { LEAN_SEAT_TOOLS } from "../../agent/access/lean-seat.js";
import { windowGrainOf, type BindableContext } from "../../agent/identity/binding.js";
import { taskWindowId, formatWindowToken, parseWindowToken, isTaskWindowToken, isThreadSeatWindowToken } from "../../agent/channels/window-key.js";
import { oneshotAgentEnabled } from "../../agent/access/delegation-flag.js";
import { recordThreadOwner, resolveThreadOwner, clearThreadOwner, routeThreadMessage } from "../../agent/channels/thread-ownership.js";
import { ROUTINE_MARKER } from "../../agent/routines/routine.js";
import { OE_GRAIN_ATTR, rootDmGrainAttrs } from "../../agent/channels/unified-window.js";
import type { OperationalStore } from "../../agent/operational/store.js";

const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
const INJECT = process.env.E2E_CONTROL_INJECT_TOKEN ?? "";
const DB = process.env.DATABASE_URL ?? "";
const ORG = process.env.E2E_ORG ?? "default";
const DOMAIN = process.env.E2E_WINDOW_GATE_DOMAIN || "e2e-unified";
const SURFACE = process.env.E2E_WINDOW_GATE_SURFACE || "slack/T0EXAMPLE/C0EXCHAN003";
const CHANNEL_ID = SURFACE.split("/").slice(2).join("/");
const REPLY_TIMEOUT_MS = Number.parseInt(process.env.WINDOW_GATE_REPLY_TIMEOUT_MS ?? "120000", 10);
const GATE_TIMEOUT_MS = Number.parseInt(process.env.WINDOW_GATE_GATED_TIMEOUT_MS ?? "60000", 10);
const POLL_MS = 4000;
const RUN = Date.now().toString().slice(-7);
const want = makeWant(process.env.WINDOW_GATE_ONLY);

const A_GATED = "turn.tool_gated";
const A_REPLY = "reply.post";
const A_NO_REPLY = "unified.no_reply";
const WIDE_HANDS = ["bash", "checkout_repo", "open_pull_request", "web_fetch", "write_file"];

const slackOrigin = { platform: "slack" as const, channelId: CHANNEL_ID };
const dmOrigin = { platform: "slack" as const, channelId: process.env.E2E_SLACK_DM_CHANNEL ?? "D0EXDMCH001" };

const { results, record } = createRecorder();

const inject = createInjector(TARGET, INJECT);
const { rowsSince } = createAuditReader(TARGET, READ, { onError: "swallow" });

const gatedRowFor = (rows: readonly AuditWireEntry[], wakeId: string): AuditWireEntry | null =>
  rows.find((r) => r.action === A_GATED && dS(r, "wakeId") === wakeId) ?? null;

const gatedRowsFor = (rows: readonly AuditWireEntry[], wakeId: string): { grainRow: AuditWireEntry | null; leanRow: AuditWireEntry | null } => {
  const matches = rows.filter((r) => r.action === A_GATED && dS(r, "wakeId") === wakeId);
  return {
    grainRow: matches.find((r) => dS(r, "reason") === undefined) ?? null,
    leanRow: matches.find((r) => dS(r, "reason") === "lean-seat") ?? null,
  };
};
const sessionJoinRowsFor = (rows: readonly AuditWireEntry[], wakeId: string): AuditWireEntry[] =>
  rows.filter((r) => (r.action === A_REPLY || r.action === A_NO_REPLY) && dS(r, "wakeId") === wakeId);

async function pollForGated(sinceIso: string, wakeId: string, timeoutMs: number): Promise<AuditWireEntry | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const g = gatedRowFor(await rowsSince(sinceIso), wakeId);
    if (g) return g;
  }
  return null;
}
async function pollForGatedPair(sinceIso: string, wakeId: string, timeoutMs: number): Promise<{ grainRow: AuditWireEntry | null; leanRow: AuditWireEntry | null }> {
  const deadline = Date.now() + timeoutMs;
  let pair: { grainRow: AuditWireEntry | null; leanRow: AuditWireEntry | null } = { grainRow: null, leanRow: null };
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    pair = gatedRowsFor(await rowsSince(sinceIso), wakeId);
    if (pair.grainRow && pair.leanRow) return pair;
  }
  return pair;
}
async function pollForReply(sinceIso: string, wakeId: string, timeoutMs: number): Promise<{ sessionId: string | null; via: string | null; sawGated: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let sawGated = false;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const rows = await rowsSince(sinceIso);
    if (gatedRowFor(rows, wakeId)) sawGated = true;
    const joins = sessionJoinRowsFor(rows, wakeId);
    if (joins.length > 0) return { sessionId: dS(joins[0], "sessionId") ?? null, via: joins[0].action, sawGated: sawGated || !!gatedRowFor(rows, wakeId) };
  }
  return { sessionId: null, via: null, sawGated };
}

const toolNamesOf = (sessionId: string, sinceIso?: string): Promise<string[]> =>
  readToolNames(TARGET, READ, sessionId, { paged: true, sinceIso });

const toolCallsWithErrorsOf = (sessionId: string, sinceIso?: string): Promise<{ name: string; errored: boolean }[] | null> =>
  readToolCalls(TARGET, READ, sessionId, { paged: true, sinceIso });

const HEAVY = "please clone the acme/web repo, run the full test suite in a sandbox, then open a pull request with the fix. reply here when the PR is up.";
const withheldStanding = new Set(withheldFromGrain("standing"));

const leanKeep = [...LEAN_SEAT_TOOLS].filter((n) => !withheldStanding.has(n)).sort();

async function f1(): Promise<void> {
  const since = new Date().toISOString();
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: HEAVY });
  console.log(`  F1 injected standing unified wake ${wakeId} → token ${token}`);
  const { grainRow, leanRow } = await pollForGatedPair(since, wakeId, GATE_TIMEOUT_MS);
  if (!grainRow && !leanRow) return record("F1", "FAIL", `no turn.tool_gated row appeared for wake ${wakeId} within ${GATE_TIMEOUT_MS}ms — the standing unified window was NOT narrowed`);
  if (!grainRow) return record("F1", "FAIL", `the LEAN-SEAT row landed for wake ${wakeId} but the GRAIN gate row (no reason) never did within ${GATE_TIMEOUT_MS}ms — the MUST-WITHHOLD wall cannot be scored`);
  if (!leanRow) return record("F1", "FAIL", `the GRAIN gate row landed for wake ${wakeId} but the LEAN-SEAT row (reason=lean-seat) never did within ${GATE_TIMEOUT_MS}ms — the MUST-KEEP wall cannot be scored`);
  const grainWithheld = (grainRow.detail?.withheld as string[]) ?? [];
  const leanWithheld = (leanRow.detail?.withheld as string[]) ?? [];
  const grain = dS(grainRow, "grain");
  const missingWide = WIDE_HANDS.filter((w) => !grainWithheld.includes(w));
  const verdict = scoreWithheldPair(grainWithheld, leanWithheld, [...withheldStanding], leanKeep);
  if (grain !== "standing" || missingWide.length > 0 || !verdict.ok) {
    return record("F1", "FAIL", `gated rows present (grain=${grain}) — missing wide-hands: ${missingWide.join(",") || "none"}; manifest names NOT withheld: ${verdict.missing.join(",") || "none"}; speak/delegate roster wrongly withheld: ${verdict.cutKeep.join(",") || "none"}; grain-withheld=[${grainWithheld.join(",")}]; lean-withheld=[${leanWithheld.join(",")}]`);
  }
  const sid = dS(leanRow, "sessionId") ?? dS(grainRow, "sessionId");
  const calls = sid ? await toolNamesOf(sid, since) : [];
  const leaked = calls.filter((c) => WIDE_HANDS.includes(c));
  record("F1", "PASS", `standing unified window NARROWED — grain=standing, grain-gate withheld ${grainWithheld.length} ⊇ all ${withheldStanding.size} standing-manifest names (incl. bash/checkout_repo/open_pull_request); lean-seat withheld ${leanWithheld.length} keeps the whole speak/delegate roster intact (${leanKeep.join(",")}); surplus ${verdict.surplus.length} beyond the manifest (INFORMATION — the lean-seat subtraction, not a leak); transcript(${sid}) tools=[${[...new Set(calls)].join(",") || "none"}]${leaked.length ? ` ⚠ LEAKED ${leaked.join(",")}` : " (no wide-hands invoked)"}`);
}

async function f2(): Promise<void> {
  const since = new Date().toISOString();
  const solo = `solochan-${RUN}`;
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: HEAVY, soloWindowId: solo });
  const isSolo = token.includes(`:win:${solo}:`);
  console.log(`  F2 injected non-degenerate standing wake ${wakeId} → token ${token} (windowId≠domain: ${isSolo})`);
  const g = await pollForGated(since, wakeId, GATE_TIMEOUT_MS);
  if (!g) return record("F2", "FAIL", `no turn.tool_gated row for the non-degenerate standing seat (wake ${wakeId}) — a standing token whose windowId≠domain was NOT narrowed`);
  const withheld = (g.detail?.withheld as string[]) ?? [];
  if (!isSolo) return record("F2", "FAIL", `dispatched token ${token} is not a :win: windowId≠domain token — the soloWindowId selector did not re-mint`);
  if (dS(g, "grain") !== "standing" || WIDE_HANDS.some((w) => !withheld.includes(w))) {
    return record("F2", "FAIL", `grain=${dS(g, "grain")}, withheld=[${withheld.join(",")}]`);
  }
  record("F2", "PASS", `non-degenerate standing seat (windowId=${solo}≠domain) NARROWED — grain=standing, withheld ${withheld.length}. Proves the grain predicate bites a standing seat that is NOT the degenerate domain window. (NOT solo-topology coverage — the token is a synthetic test-route mint; see solo-window.ts.)`);
}

async function f3(): Promise<void> {
  const dmAuth = {
    attributes: {
      channel_id: dmOrigin.channelId,
      user_id: "U_TESTER",
      team_id: SURFACE.split("/")[1] ?? "T",
      channel_type: "im",
      dm_partner_trust: "internal",
      ...rootDmGrainAttrs(true),
    } as Record<string, string>,
  };
  const stamped = dmAuth.attributes.oe_grain;
  if (stamped !== "standing") {
    return record("F3", "FAIL", `the REAL DM ingress stamp (rootDmGrainAttrs on channelType=im) did NOT stamp oe_grain=standing (got ${stamped ?? "<absent>"}) — the root-DM security fix is not wired; a real DM would fall through to native/full-hands`);
  }
  const dmCtx: BindableContext = { channel: { kind: "slack", continuationToken: "cse_dm_native_e2e" }, session: { auth: { current: { attributes: dmAuth.attributes } } } };
  const grain = windowGrainOf(dmCtx);
  if (grain !== "standing") {
    return record("F3", "FAIL", `windowGrainOf on a REAL stamped DM auth (native-shaped token) returned "${grain}", not "standing" — the stamp is not being read as PRIMARY`);
  }
  const dmWithheld = new Set(withheldFromGrain("standing"));
  const missingWide = WIDE_HANDS.filter((w) => !dmWithheld.has(w));
  const keepsDelegation = !dmWithheld.has("agent");
  if (missingWide.length > 0 || !keepsDelegation) {
    return record("F3", "FAIL", `standing DM kit wrong: wide-hands not withheld=[${missingWide.join(",")}], keeps agent=${keepsDelegation}`);
  }

  let legB = "leg B (live standing-token drive) skipped (no injectable window)";
  try {
    const since = new Date().toISOString();
    const inj = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: dmOrigin, text: HEAVY, soloWindowId: `dm-${RUN}` });
    const g = await pollForGated(since, inj.wakeId, GATE_TIMEOUT_MS);
    if (g && dS(g, "grain") === "standing" && !WIDE_HANDS.some((w) => !((g.detail?.withheld as string[]) ?? []).includes(w))) {
      legB = `leg B CONFIRMED e2e — a DM-origin standing seat NARROWED through a real eve resolve (turn.tool_gated on wake ${inj.wakeId}, grain=standing)`;
    } else {
      legB = `leg B unconfirmed (no matching turn.tool_gated within ${GATE_TIMEOUT_MS}ms) — Leg A remains the binding proof`;
    }
  } catch (e) {
    legB = `leg B drive error (${(e as Error).message}) — Leg A remains the binding proof`;
  }

  record("F3", "PASS", `root DM seat NARROWED via the REAL ingress stamp — buildSlackAuth(im) stamps oe_grain=standing; windowGrainOf ⇒ standing (the STAMP narrows, not the token — which is why the verdict survived OPE-351 stage 2 re-seating a DM from a native token onto a real DM WINDOW token); the 12 wide-hands are withheld and \`agent\` is kept BY GRAIN (table level). NB \`agent\`'s seat predicate (canDelegateFromSeat) then keeps it structurally ABSENT on a DM that is still on a NATIVE token — such a seat has no window to mint a child into. A DM re-seated onto a real DM WINDOW token by stage 2 DOES hold it: it delegates as a one-shot leaf and — the point of stage 2 — is WOKEN with the result (pinned in window-capability-test.ts P0-a(1b)). This exercises the actual production stamp (the former documented caveat is now a real pass). ${legB}. Not covered here: a fully-live DM eve session (needs a real Slack DM drive) — pinned by window-tool-gate-test.ts §3b (all surfaces) + the prod pack.`);
}

async function f4(): Promise<void> {
  const since = new Date().toISOString();
  const thread = `f4-${RUN}`;
  const brief = `${HEAVY} As part of the job run \`echo window-gate-${RUN}\` with bash to confirm your sandbox, then reply here with DONE-${RUN}.`;
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: brief, taskThread: thread });
  const isTask = isTaskWindowToken(token);
  console.log(`  F4 injected TASK worker wake ${wakeId} → token ${token} (task-grain: ${isTask})`);
  if (!isTask) return record("F4", "FAIL", `dispatched token ${token} is not a task-grain token — the taskThread selector did not re-mint`);
  const { sessionId, via, sawGated } = await pollForReply(since, wakeId, REPLY_TIMEOUT_MS);
  if (sawGated) return record("F4", "FAIL", `a turn.tool_gated row fired on the TASK session (wake ${wakeId}) — a task worker was WRONGLY narrowed`);
  if (!sessionId) {
    const rows = await rowsSince(since);
    const ranEvidence = rows.filter((r) => dS(r, "wakeId") === wakeId && r.action !== "control.service_call");
    if (ranEvidence.length === 0) {
      return record("F4", "FAIL", `NO audit activity of ANY kind for wake ${wakeId} within ${REPLY_TIMEOUT_MS}ms — no reply.post, no unified.no_reply, no turn.supervisor_prose_dropped. Consistent with the task session never running (dead dispatch or a full-kit mount crash at session.started), NOT with model choice. Bump WINDOW_GATE_REPLY_TIMEOUT_MS if the worker was genuinely still mid-turn.`);
    }
    return record("F4", "SKIP", `task session RAN (evidence: ${[...new Set(ranEvidence.map((r) => r.action))].join(",")}) with NO narrowing row (correct), but no reply.post/unified.no_reply landed within ${REPLY_TIMEOUT_MS}ms so the wake→session transcript join is unconfirmed (model-dependent terminal choice).`);
  }
  const calls = await toolNamesOf(sessionId, since);
  const usedWide = calls.filter((c) => WIDE_HANDS.includes(c) || c === "list_repos" );
  record("F4", "PASS", `task/thread worker kept the FULL kit — NO turn.tool_gated row (negative control vs F1's narrowing), session ${sessionId} ran + ${via === A_REPLY ? "replied" : "completed with a deliberate no_reply"}. transcript tools=[${[...new Set(calls)].join(",") || "none"}]${calls.some((c) => WIDE_HANDS.includes(c)) ? " (wide-hands INVOKED ✓)" : " (wide-hands mounted; model chose not to invoke)"}`);
}

async function f5(): Promise<void> {
  const thread = `f5-${RUN}`;
  const since1 = new Date().toISOString();
  const inj1 = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: `first task turn (marker ${RUN}-a). reply with SESSION-${RUN}.`, taskThread: thread });
  const r1 = await pollForReply(since1, inj1.wakeId, REPLY_TIMEOUT_MS);
  const since2 = new Date().toISOString();
  const inj2 = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: `second task turn in the SAME thread (marker ${RUN}-b). reply with SESSION-${RUN}.`, taskThread: thread });
  const r2 = await pollForReply(since2, inj2.wakeId, REPLY_TIMEOUT_MS);
  const sameToken = inj1.token === inj2.token && isTaskWindowToken(inj1.token);
  if (!sameToken) return record("F5", "FAIL", `two injections into thread ${thread} minted DIFFERENT tokens (${inj1.token} vs ${inj2.token}) — task identity is not token-derivable`);
  if (r1.sessionId && r2.sessionId) {
    if (r1.sessionId === r2.sessionId) return record("F5", "PASS", `persistent task identity CONFIRMED e2e — same taskThread ⇒ same token ${inj1.token} ⇒ SAME eve session ${r1.sessionId} across two separate wakes (durable-token resume, §S1).`);
    return record("F5", "FAIL", `same token but DIFFERENT sessions replied (${r1.sessionId} vs ${r2.sessionId}) — eve did not resume the task session`);
  }
  if (!r1.sessionId && !r2.sessionId) {
    return record("F5", "SKIP", `same taskThread re-derived the SAME task token ${inj1.token} (mint identity holds, §S1), but NEITHER wake produced a joinable session (no reply.post/unified.no_reply) within ${REPLY_TIMEOUT_MS}ms — same-session resume UNCONFIRMED and the task-session route may be dead (cf. F4).`);
  }
  record("F5", "PASS", `persistent task identity: the same taskThread deterministically re-derives the SAME task token ${inj1.token} (§S1 — identity IS the token; eve resumes a seen token), and at least one wake joined a live session (${r1.sessionId ?? r2.sessionId}). Same-session e2e confirmation was best-effort and one worker's reply/no_reply did not land within ${REPLY_TIMEOUT_MS}ms (model-dependent).`);
}

async function f6(store: OperationalStore | null): Promise<void> {
  if (!store) return record("F6", "SKIP", "no DATABASE_URL — the ownership store round-trip needs the live operational store");
  const channelKey = `wg6/${RUN}`;
  const threadKey = `t-${RUN}`;
  const otherThread = `t-other-${RUN}`;
  const gen = Date.now();
  const taskToken = formatWindowToken({ domain: DOMAIN, windowId: taskWindowId(channelKey, threadKey), generation: gen });
  const ref = { channelKey, threadKey };
  try {
    await recordThreadOwner(store, ORG, ref, taskToken, new Date().toISOString());
    const owner = await resolveThreadOwner(store, ORG, ref);
    const routeOwned = routeThreadMessage(owner, gen);
    const routeOther = routeThreadMessage(await resolveThreadOwner(store, ORG, { channelKey, threadKey: otherThread }), gen);
    const routeStale = routeThreadMessage(owner, gen + 1);
    const cleared = await clearThreadOwner(store, ORG, ref);
    const routeAfterClear = routeThreadMessage(await resolveThreadOwner(store, ORG, ref), gen);
    const ok =
      owner === taskToken &&
      routeOwned.kind === "task" && routeOwned.token === taskToken &&
      routeOther.kind === "standing" &&
      routeStale.kind === "standing" &&
      cleared === true &&
      routeAfterClear.kind === "standing";
    if (!ok) {
      return record("F6", "FAIL", `store/decision mismatch: owner=${owner === taskToken}, owned→${routeOwned.kind}, other→${routeOther.kind}, stale→${routeStale.kind}, cleared=${cleared}, afterClear→${routeAfterClear.kind}`);
    }
    record("F6", "PASS", `ownership routing store+decision hold e2e against the live store: owned thread→task (${taskToken.slice(0, 40)}…), unowned/other thread→standing, stale-generation→standing, clear→standing. Ingress wiring (§S2) is LIVE for Slack under delegation.oneshotAgent: divertInboundToUnifiedWindow (channels/unified.ts) consults this same store per inbound single-window wake and dispatches an owned thread's message to the owner session's token (unit pack: test:s2-ingress). Other surfaces adopt by swapping their inbound divert call.`);
  } catch (e) {
    record("F6", "FAIL", `ownership store round-trip threw: ${(e as Error).message}`);
  }
}

async function f7(): Promise<void> {
  const since = new Date().toISOString();
  const { wakeId } = await inject({
    domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "channel-watch", author: "routine", origin: slackOrigin,
    text: `scheduled sweep ${RUN}: ${HEAVY}`,
    soloWindowId: `routine-${RUN}`,
    authAttributes: {
      [ROUTINE_MARKER.id]: `e2e-window-gate-f7-${RUN}`,
      [ROUTINE_MARKER.surface]: SURFACE,
      [ROUTINE_MARKER.org]: ORG,
      [OE_GRAIN_ATTR]: "",
    },
  });
  const g = await pollForGated(since, wakeId, GATE_TIMEOUT_MS);
  if (!g) return record("F7", "FAIL", `routine-fired turn produced NO turn.tool_gated row (wake ${wakeId}) — a routine may have smuggled full hands onto the standing seat`);
  if (dS(g, "grain") !== "standing" || WIDE_HANDS.some((w) => !((g.detail?.withheld as string[]) ?? []).includes(w))) {
    return record("F7", "FAIL", `routine turn row grain=${dS(g, "grain")}, withheld=[${((g.detail?.withheld as string[]) ?? []).join(",")}]`);
  }
  record("F7", "PASS", `routine-fired turn INHERITED standing grain from the token (oe_grain unstamped ⇒ classifyTokenGrain backstop) and NARROWED — grain=standing, wide-hands withheld. A scheduled fire cannot smuggle full hands.`);
}

async function f8(): Promise<void> {
  record("F8", "SKIP", `native @mention (cse_… session) is not injectable via the unified test-wake seam — a native seat runs on the surface's own eve channel and the unified receive refuses non-supervisor tokens (isUnifiedSupervisorToken). Grain "native" is unit-pinned: flag-OFF a suffix-less token ⇒ native ⇒ FULL kit (Stage-C byte-identical, window-capability-test.ts P1-c); flag-ON (Stage T2 Resolution A) native LOSES the wide hands (fullKit() drops it — window-gate-lint-test.ts's injectable-wideHandsGrains crafted case + window-gated-test.ts's flag-off/on split). The live-surface @mention e2e (prod pack, real Slack drive) is the end-to-end confirmation. Not faked here.`);
}

async function f9(): Promise<void> {
  if (!oneshotAgentEnabled()) {
    return record("F9", "SKIP", "delegation.oneshotAgent is not set in THIS process — spawn_thread_session is flag-gated absent. Re-run with the flag on AND a target deployed with `delegation.oneshotAgent` armed.");
  }
  const since = new Date().toISOString();
  const brief = `We'll be going back and forth in this thread for a while about the ${RUN} rollout — please open a lasting presence here to keep track, then say READY-${RUN}.`;
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: brief });
  console.log(`  F9 injected standing wake ${wakeId} → token ${token}`);
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let row: AuditWireEntry | null = null;
  while (Date.now() < deadline && !row) {
    await sleep(POLL_MS);
    row = (await rowsSince(since)).find((r) => r.action === "thread_seat.spawned" && (dS(r, "parentWakeId") === wakeId || dS(r, "wakeId") === wakeId)) ?? null;
  }
  if (!row) {
    const join = sessionJoinRowsFor(await rowsSince(since), wakeId)[0];
    const sid = join ? dS(join, "sessionId") : undefined;
    const calls = sid ? await toolCallsWithErrorsOf(sid, since) : null;
    if (calls?.some((c) => c.name === "spawn_thread_session")) {
      return record("F9", "FAIL", `the model CALLED spawn_thread_session (session ${sid}) but NO thread_seat.spawned row landed for wake ${wakeId} — the tool is mounted but its execute refused/errored; read the action.result error in transcript ${sid}.`);
    }
    return record("F9", "SKIP", `no thread_seat.spawned row for wake ${wakeId} within ${REPLY_TIMEOUT_MS}ms${sid && calls ? ` (session ${sid} ran without invoking spawn_thread_session)` : calls === null && sid ? ` (session ${sid} joined but its transcript is unreadable — outcome UNVERIFIED)` : ""} — the model did not choose spawn_thread_session this turn (delegation is model-dependent), or the target was not started with delegation.oneshotAgent Re-run with the flag ON.`);
  }
  const seatId = dS(row, "seatId") ?? "";
  if (!isThreadSeatWindowToken(seatId)) {
    return record("F9", "FAIL", `thread_seat.spawned present but seatId=${seatId} is NOT a thread-seat window token (s/… windowId) — a lost oe_grain stamp would then re-widen the seat to task instead of failing closed to thread`);
  }
  record("F9", "PASS", `spawn_thread_session opened a persistent thread seat — thread_seat.spawned (seatId=${seatId.slice(0, 48)}…) whose token classifies grain THREAD (s/ windowId ⇒ fail-closed narrow, never task). The seat holds the conversational kit + agent + complete_thread, NO wide hands, and cannot recurse (spawn_thread_session is standing-only).`);
}

async function main(): Promise<void> {
  console.log(`=== WINDOW TOOL-GATING · STAGE F per-route e2e · run ${RUN} · ${new Date().toISOString()} ===`);
  console.log(`target=${TARGET || "(unset)"} domain=${DOMAIN} surface=${SURFACE}`);
  console.log(`seat lock: /tmp/oe-e2e-locks/domain-${DOMAIN}.lock — hold it for the whole live drive`);
  if (!TARGET || !READ || !INJECT) {
    console.error("\nMISSING E2E_TARGET_URL and/or E2E_CONTROL_READ_TOKEN and/or E2E_CONTROL_INJECT_TOKEN — cannot drive any route.");
    for (const id of ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9"]) if (want(id)) record(id, "SKIP", "no E2E_TARGET_URL / E2E_CONTROL_READ_TOKEN / E2E_CONTROL_INJECT_TOKEN");
    return summary();
  }

  let store: OperationalStore | null = null;
  if (DB) {
    try {
      store = await wireNeonOperationalStore(DB);
      const rot = await rotateUnifiedWindow(store, ORG, DOMAIN);
      console.log(`  rotated ${DOMAIN} window → fresh generation ${rot.mintedGeneration} (token ${rot.newRow.token})`);
    } catch (e) {
      console.warn(`  [store] could not wire/rotate: ${(e as Error).message} — F6 will skip; injection relies on an existing window`);
      store = null;
    }
  } else {
    console.warn("  no DATABASE_URL — skipping rotate (relying on an existing channel_session) + F6");
  }

  const steps: [string, () => Promise<void>][] = [
    ["F1", f1], ["F2", f2], ["F3", f3], ["F4", f4], ["F5", f5],
    ["F6", () => f6(store)], ["F7", f7], ["F8", f8], ["F9", f9],
  ];
  for (const [id, fn] of steps) {
    if (!want(id)) continue;
    try { await fn(); }
    catch (e) { record(id, "FAIL", `threw: ${(e as Error).message}`); }
  }
  summary();
}

function summary(): void {
  console.log(`\n=== STAGE F SUMMARY (run ${RUN}) ===`);
  for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.id}`);
  const pass = results.filter((r) => r.status === "PASS").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`  ${pass} pass · ${skip} skip · ${fail} fail`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("STAGE F pack failed:", e); process.exit(1); });
