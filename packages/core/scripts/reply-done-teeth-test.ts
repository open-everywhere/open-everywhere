// proves: reply.forced
// proves: REPLY-23

import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-reply-done-teeth-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { seedTailWindow, tailWindow, tailWindowFor } = await import("../agent/channels/session-tail-record.js");
const { secondMessageValve, FORCED_OVERRIDE_TURN_LIMIT, noteForcedOverrideThisTurn, REPLY_FORCED_LOOP_REASON } = await import(
  "../agent/channels/reply-signal.js"
);
const { turnCloseoutFor } = await import("../agent/model/turn-closeout.js");
const { notePendingDelegation, noteDelegationSettled } = await import("../agent/access/pending-delegation-signal.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);

const posted: { channel: string; text: string }[] = [];
registerSlackTestBridge({
  channel: { __fixture: "slack" } as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
    return { ok: true, ts: `ts-${posted.length}` } as never;
  },
});
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: DOMAIN, reach: [SURFACE], ambientSupervisor: true, mode: "unified" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === CHAN ? [DOMAIN] : []),
});

const store = getOperationalStore();

const replyTool = (await import("../agent/tools/reply.js")).default;
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const arm = (ctx: unknown): Armed | null => (replyTool as unknown as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as Armed | null;

function ctxFor(turnWake: string, turnId: string): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: "reply-done-teeth-test",
      turn: { id: turnId },
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_wake_id: turnWake, oe_window_token: TOKEN, channel_id: CHAN, team_id: "T1" },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
  } as unknown as BindableContext;
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function newSession(): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "reply-done-teeth-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(
  turnWake: string,
  turnId: string,
  wake: string,
  text: string,
  done: boolean,
): Promise<{ posted?: boolean; note?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done }, ctx)
    .then((r) => r as { posted?: boolean; note?: string })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function callReplyForced(
  turnWake: string,
  turnId: string,
  wake: string,
  text: string,
  done: boolean,
): Promise<{ posted?: boolean; note?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done, force: true }, ctx)
    .then((r) => r as { posted?: boolean; note?: string })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function wake(channelId: string): Promise<string> {
  const id = mintWakeId();
  await registerUnifiedWakeTarget(store, ORG, id, { platform: "slack", channelId }, new Date().toISOString(), TOKEN);
  return id;
}

const refusedRows = async (): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action: "reply.refused" })).map((r) => (r.detail ?? {}) as Record<string, unknown>);
const postRows = async (): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action: "reply.post" })).map((r) => (r.detail ?? {}) as Record<string, unknown>);

{
  const inTurn = newSession();
  const w = await wake("C_DUP");

  const first = await inTurn(() => callReply(w, "turn_16", w, "Here is the full answer, with a closing sentence.", true));
  ok(first.posted === true, "§1: the first `done:true` reply POSTS — the guard must never cost the real answer");
  ok(posted.length === 1, "§1/ROOM: exactly one message reached the room");
  ok(
    typeof first.note === "string" && first.note.includes("ANSWERED") && first.note.includes("do not reply to it again"),
    "§1/NOTE: the success note states the wake is answered and that a second call is refused — the contract is taught at the moment of compliance, not only by the refusal",
  );

  const second = await inTurn(() => callReply(w, "turn_16", w, "Here is the full answer.", true));
  ok(typeof second.error === "string", "§1: the SECOND call on the same wake in the same turn is REFUSED");
  ok(second.posted !== true, "§1: …and it reports no post");
  ok(second.error!.includes("you already replied to wake-id"), "§1: refused with the `answered` steer, not some incidental error");
  ok(second.error!.includes("NOTHING was posted"), "§1: the copy tells the model its retry posted nothing, so it does not retry again believing the first post failed");
  ok(second.error!.includes("done:false"), "§1/INSTRUCTIVE: the copy teaches the legitimate multi-part route — this is the whole reason the refusal is not silent");
  ok(
    second.error!.includes("A second message is DISCOURAGED, not blocked"),
    "§1/VALVE: the refusal names itself as DISCOURAGED, never as a wall",
  );
  ok(second.error!.includes("`force: true`"), "§1/VALVE: …and names the flag that overrides it, which this variant does hold");
  ok(
    second.error!.includes("costs the room a near-duplicate"),
    "§1/VALVE: …and states the COST, so the valve is not read as an invitation",
  );
  ok(
    !second.error!.includes("anyway"),
    "§1/VALVE: negative control — never the plain 'post it as a new message anyway' instruction OPE-1422 removed",
  );
  ok(posted.length === 1, "§1/ROOM: STILL exactly one message — the duplicate never left. This is the assertion OPE-568 exists for");

  ok(posted[0].text.endsWith("with a closing sentence."), "§1: the message that survived is the FIRST, complete one");

  const refused = await refusedRows();
  ok(refused.length === 1, "§1/AUDIT: the refusal is a ROW, not an absence");
  ok(refused[0]["reason"] === "answered-this-turn", "§1/AUDIT: under its own reason, so the double-post habit is countable apart from a cross-turn answered wake");
  ok(refused[0]["wakeId"] === w, "§1/AUDIT: naming the wake it refused");
  ok(refused[0]["route"] === "tool", "§1/AUDIT: route stamped, matching the reply.post join shape");
  ok(!JSON.stringify(refused[0]).includes("Here is the full answer"), "§1/AUDIT: the attempted TEXT never reaches the audit detail");
  ok((await postRows()).filter((d) => d["wakeId"] === w).length === 1, "§1/AUDIT: one reply.post row for this wake, matching the room");
}

{
  const inTurn = newSession();
  const w = await wake("C_MULTI");
  const before = posted.length;

  const part1 = await inTurn(() => callReply(w, "turn_20", w, "Working on it — the search is running.", false));
  ok(part1.posted === true, "§2: the progress part posts");
  ok(
    typeof part1.note === "string" && part1.note.includes("stays OPEN"),
    "§2/NOTE: a `done:false` post says the wake stays OPEN — the same note must not tell a multi-part answer it is finished",
  );
  const part2 = await inTurn(() => callReply(w, "turn_20", w, "Done: the search found three matches.", true));
  ok(part2.posted === true, "§2: and the final part posts too — `done:false` records nothing, so the guard stays out of the way");
  ok(posted.length === before + 2, "§2/ROOM: BOTH parts reached the room. A blanket one-reply-per-turn rule would fail here");

  const third = await inTurn(() => callReply(w, "turn_20", w, "Done: the search found three matches, and one is stale.", true));
  ok(typeof third.error === "string" && third.error.includes("you already replied to wake-id"), "§2: a THIRD call after the `done:true` part is refused — the mark is what arms the guard, not the call count");
  ok(posted.length === before + 2, "§2/ROOM: still two parts");
}

{
  const inTurn = newSession();
  const wA = await wake("C_A");
  const wB = await wake("C_B");
  const before = posted.length;

  const a = await inTurn(() => callReply(wA, "turn_30", wA, "Answer for conversation A.", true));
  ok(a.posted === true, "§3: this turn's own wake posts");
  const b = await inTurn(() => callReply(wA, "turn_30", wB, "Answer for conversation B.", true));
  ok(b.posted === true, "§3: a SIBLING pending wake on the same window still posts — the coalesced-turn competence the pending arm exists for is untouched");
  ok(posted.length === before + 2, "§3/ROOM: both conversations got their answer");

  const bAgain = await inTurn(() => callReply(wA, "turn_30", wB, "Answer for conversation B, again.", true));
  ok(typeof bAgain.error === "string" && bAgain.error.includes("you already replied to wake-id"), "§3: and the sibling gets the same teeth once it is done");
  ok(posted.length === before + 2, "§3/ROOM: no third message");
}

{
  const inSession = newSession();
  const w = await wake("C_CROSS");
  const before = posted.length;

  const t1 = await inSession(() => callReply(w, "turn_40", w, "First turn's answer.", true));
  ok(t1.posted === true, "§4: turn 40 answers and marks the wake done");

  const t2 = await inSession(() => callReply(w, "turn_41", w, "Second turn's answer, after the human wrote again.", true));
  ok(t2.posted === true, "§4: a NEW turn replying to the SAME wake still POSTS — arm 2 of the fence is untouched, and the turn-local record did not bleed");
  ok(posted.length === before + 2, "§4/ROOM: both turns spoke");

  const t2Again = await inSession(() => callReply(w, "turn_41", w, "Second turn's answer, repeated.", true));
  ok(typeof t2Again.error === "string" && t2Again.error.includes("you already replied to wake-id"), "§4: and the new turn grows its OWN teeth");
  ok(posted.length === before + 2, "§4/ROOM: no duplicate in the second turn either");
}

{
  const inTurn = newSession();
  const wTurn = await wake("C_FENCE");
  const wOld = await wake("C_OLD");
  await store.markUnifiedWakeAnswered(ORG, wOld, new Date().toISOString(), "turn_earlier");
  const wStray = mintWakeId();
  const before = posted.length;

  const old = await inTurn(() => callReply(wTurn, "turn_50", wOld, "Late answer to an old wake.", true));
  ok(typeof old.error === "string" && old.error.includes("you already replied to wake-id"), "§5: a wake an EARLIER turn answered still draws the fence's `answered` refusal");

  const stray = await inTurn(() => callReply(wTurn, "turn_50", wStray, "Answer to a wake we never held.", true));
  ok(typeof stray.error === "string" && stray.error.includes("is not a wake you can answer"), "§5: an unheld id still draws `mismatch` — the authority fence is unchanged");
  ok(posted.length === before, "§5/ROOM: neither refusal posted anything");

  const rows = await refusedRows();
  const rowFor = (id: string): Record<string, unknown> | undefined => rows.find((d) => d["wakeId"] === id);
  ok(rowFor(wOld)?.["reason"] === "answered", "§5/AUDIT: the cross-turn refusal keeps the plain `answered` reason");
  ok(rowFor(wStray)?.["reason"] === "mismatch", "§5/AUDIT: the unheld id keeps `mismatch`");
  ok(
    rowFor(wOld)?.["reason"] !== "answered-this-turn" && rowFor(wStray)?.["reason"] !== "answered-this-turn",
    "§5/AUDIT: neither fence refusal is miscounted as a double-post — `answered-this-turn` means ONLY the same-turn shape",
  );
}

{
  const w = await wake("C_NOCTX");
  const before = posted.length;

  const first = await callReply(w, "turn_60", w, "Answer with no session context.", true);
  ok(first.posted === true, "§6: the reply posts with no eve context");
  const second = await callReply(w, "turn_60", w, "Answer with no session context, again.", true);
  ok(second.posted === true, "§6/FAIL-OPEN: and so does the repeat — an unavailable signal turns the guard OFF, it never turns a delivered answer into an error");
  ok(posted.length === before + 2, "§6/ROOM: two messages, which is the honest bound on this fix: it needs the turn's own state to work");
}

const forcedRows = async (): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action: "reply.forced" })).map((r) => (r.detail ?? {}) as Record<string, unknown>);

{
  const inTurn = newSession();
  const w = await wake("C_VALVE");
  const before = posted.length;

  const first = await inTurn(() => callReply(w, "turn_70", w, "The answer, first time.", true));
  ok(first.posted === true, "§7a: the first `done:true` reply posts");

  const second = await inTurn(() => callReply(w, "turn_70", w, "The answer, and one more thing.", true));
  ok(typeof second.error === "string", "§7a: the second call on the same wake draws the refusal — the steer still fires");
  ok(posted.length === before + 1, "§7a/ROOM: and that refusal kept the duplicate out of the room");

  const third = await inTurn(() => callReply(w, "turn_70", w, "The answer, and one more thing, sent again.", true));
  ok(third.posted === true, "§7a/VALVE: sending the refused call AGAIN POSTS it — the guard refuses once per wake, it never blocks");
  ok(third.error === undefined, "§7a/VALVE: …and it is a real return, not an error the caller could mistake for a post");
  ok(posted.length === before + 2, "§7a/ROOM: the room now holds BOTH messages. This is the assertion OPE-1452 exists for");
  ok(posted[posted.length - 1].text.endsWith("sent again."), "§7a/ROOM: and the message that landed is the one the model re-sent");

  const refusedForW = (await refusedRows()).filter((d) => d["wakeId"] === w);
  ok(refusedForW.length === 1, "§7a/AUDIT: exactly ONE refusal row — the guard spent its one refusal and stood aside, it did not refuse twice");
  ok(refusedForW[0]["reason"] === "answered-this-turn", "§7a/AUDIT: under the same reason as before, so the habit stays countable");
  ok((await postRows()).filter((d) => d["wakeId"] === w).length === 2, "§7a/AUDIT: two reply.post rows for this wake, matching the room");
  ok(
    (await forcedRows()).filter((d) => d["wakeId"] === w).length === 0,
    "§7a/AUDIT: a re-send writes NO `reply.forced` row — nothing was overridden, the guard had already stepped aside",
  );
}

{
  const inTurn = newSession();
  const w = await wake("C_FORCE");
  const before = posted.length;

  const first = await inTurn(() => callReply(w, "turn_71", w, "The answer.", true));
  ok(first.posted === true, "§7b: the first `done:true` reply posts");

  const forced = await inTurn(() => callReplyForced(w, "turn_71", w, "A time-critical correction the room must be notified of.", true));
  ok(forced.posted === true, "§7b/FORCE: `force: true` posts the second answer with no refusal at all");
  ok(posted.length === before + 2, "§7b/ROOM: both messages reached the room");

  ok(
    (await refusedRows()).filter((d) => d["wakeId"] === w).length === 0,
    "§7b/AUDIT: NO refusal row — the override was taken before the refusal, not after one",
  );
  const forcedForW = (await forcedRows()).filter((d) => d["wakeId"] === w);
  ok(forcedForW.length === 1, "§7b/AUDIT: the override is a ROW, so (refusals, overrides) says whether the steer works");
  ok(
    forcedForW[0]["reason"] === "answered-this-turn-forced",
    "§7b/AUDIT: under its OWN reason — a should-be-edit or staleness override counts a different decision",
  );
  ok(forcedForW[0]["route"] === "tool", "§7b/AUDIT: route stamped, matching the reply.post join shape");
  ok(!JSON.stringify(forcedForW[0]).includes("time-critical correction"), "§7b/AUDIT: the forced TEXT never reaches the audit detail either");
}

{
  const inTurn = newSession();
  const w = await wake("C_REFUSE_THEN_FORCE");
  const before = posted.length;

  const first = await inTurn(() => callReply(w, "turn_73", w, "The answer.", true));
  ok(first.posted === true, "§7d: the first `done:true` reply posts");

  const refused = await inTurn(() => callReply(w, "turn_73", w, "The answer, with more.", true));
  ok(typeof refused.error === "string", "§7d: the second call draws the refusal that names `force: true`");
  ok(refused.error!.includes("the override is recorded"), "§7d: …and that refusal PROMISES the override is recorded — the promise these assertions hold to account");

  const forced = await inTurn(() => callReplyForced(w, "turn_73", w, "The answer, with more — this one has to notify.", true));
  ok(forced.posted === true, "§7d: passing `force: true` after the refusal POSTS");
  ok(posted.length === before + 2, "§7d/ROOM: both messages reached the room");

  const forcedForW = (await forcedRows()).filter((d) => d["wakeId"] === w);
  ok(
    forcedForW.length === 1,
    `§7d/AUDIT: …and it writes ONE \`reply.forced\` row, so the refusal's own promise is true — expected 1, got ${forcedForW.length}`,
  );
  ok(forcedForW[0]["reason"] === "answered-this-turn-forced", "§7d/AUDIT: under this arm's own override reason");
  ok(
    (await refusedRows()).filter((d) => d["wakeId"] === w).length === 1,
    "§7d/AUDIT: exactly one refusal row — the force did not draw a second one on its way through",
  );
}

{
  const inTurn = newSession();
  const w = await wake("C_STANDING");
  const before = posted.length;

  const seat = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
  ok(seat !== null, "§7e/CONTROL: the fixture's token really is a STANDING seat — the only grain that files a ring");

  const errors = await inTurn(async () => {
    seedTailWindow(seat);
    ok(tailWindow() !== null, "§7e/CONTROL: the tail window is seeded, so the fold gate is LIVE for this turn — the state every leg above lacks");

    const first = await callReply(w, "turn_75", w, "The answer, first time.", true);
    ok(first.posted === true, "§7e: the first `done:true` reply posts");

    const second = await callReply(w, "turn_75", w, "The answer, and one more thing.", true);
    const third = await callReply(w, "turn_75", w, "The answer, and one more thing, sent again.", true);
    const fourth = await callReply(w, "turn_75", w, "The answer, and one more thing, sent a third time.", true);
    return { second, third, fourth };
  });

  ok(typeof errors.second.error === "string", "§7e: call 2 draws the same-turn `done` refusal");
  ok(typeof errors.third.error === "string", "§7e: 🔴 call 3 is refused TOO — the bare re-send reached the fold gate, which is a second refusal the old copy did not account for");
  ok(errors.third.error !== errors.second.error, "§7e: …and it is a DIFFERENT refusal, not the same gate firing twice");
  ok(/edit_reply/.test(errors.third.error!), "§7e: the second refusal is the should-be-edit one, which steers at `edit_reply`");
  ok(errors.fourth.posted === true, "§7e: call 4 posts — two gates, each refusing once, then standing aside. NOTHING is blocked");
  ok(posted.length === before + 2, "§7e/ROOM: the room holds the first answer and the fourth call's message, and neither refused call reached it");

  ok(/pass `force: true` and it posts/.test(errors.second.error!), "§7e/COPY: the valve sentence promises `force: true` as the route that posts");
  ok(
    /this check will not refuse it twice, though a later one still can/.test(errors.second.error!),
    "§7e/COPY: 🔴 …and a bare re-send is promised only what THIS check will do — the old sentence promised a post, which this leg has just shown to be false for a standing seat",
  );
  ok(
    !/send this same call again, or pass `force: true`, and it posts/.test(errors.second.error!),
    "§7e/COPY: the retired sentence is gone — it named a cost of one step where this seat pays two",
  );
  ok(
    secondMessageValve(false).includes("send this same call again and it posts"),
    "§7e/COPY: 🔴 the per-surface branch is UNCHANGED — the fix is narrowed to the branch that stacks, and true copy is not weakened to match a sibling's defect",
  );

  const inTurn2 = newSession();
  const w2 = await wake("C_STANDING_FORCE");
  const forceBefore = posted.length;
  const forced = await inTurn2(async () => {
    seedTailWindow(seat);
    const first = await callReply(w2, "turn_76", w2, "The answer.", true);
    ok(first.posted === true, "§7e/FORCE: the first reply posts");
    return await callReplyForced(w2, "turn_76", w2, "A time-critical correction the room must be notified of.", true);
  });
  ok(forced.posted === true, "§7e/FORCE: 🔴 `force: true` posts in ONE call — it passes BOTH gates, which is exactly what the copy now promises");
  ok(posted.length === forceBefore + 2, "§7e/FORCE/ROOM: both messages reached the room");
}

{
  const inTurn = newSession();
  const wTurn = await wake("C_FORCE_FENCE");
  const wStray = mintWakeId();
  const before = posted.length;

  const stray = await inTurn(() => callReplyForced(wTurn, "turn_72", wStray, "Forced answer to a wake we never held.", true));
  ok(
    typeof stray.error === "string" && stray.error.includes("is not a wake you can answer"),
    "§7c: `force: true` does NOT override the authority fence — an unheld id still draws `mismatch`",
  );
  ok(posted.length === before, "§7c/ROOM: and nothing was posted. The valve opens a style gate, never a security one");

  const part = await inTurn(() => callReply(wTurn, "turn_72", wTurn, "Working on it.", false));
  ok(part.posted === true, "§7c: a `done:false` part posts");
  ok(
    (await refusedRows()).filter((d) => d["wakeId"] === wTurn).length === 0 &&
      (await forcedRows()).filter((d) => d["wakeId"] === wTurn).length === 0,
    "§7c/AUDIT: a multi-part answer draws neither a refusal nor an override — the guard stays out of its way entirely",
  );
}

{
  const inTurn = newSession();
  const w = await wake("C_FORCED_ONCE");
  const before = posted.length;
  const seat = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
  ok(seat !== null, "§8/CONTROL: the fixture's token is a STANDING seat, so the should-be-edit gate is live alongside the `done` teeth");

  const notes = await inTurn(async () => {
    seedTailWindow(seat);
    const first = await callReply(w, "turn_80", w, "The answer, first time.", true);
    ok(first.posted === true, "§8: the first `done:true` reply posts");
    const second = await callReplyForced(w, "turn_80", w, "The answer, forced a second time.", true);
    const third = await callReplyForced(w, "turn_80", w, "The answer, forced a third time.", true);
    const fourth = await callReplyForced(w, "turn_80", w, "The answer, forced a fourth time.", true);
    return { second, third, fourth };
  });

  ok(notes.second.posted === true, "§8: the second call OVERRIDES both verdicts and posts");
  ok(notes.third.posted === true, "§8: 🔴 so does the third — the fix records less, it never blocks more");
  ok(notes.fourth.posted === true, "§8: …and the fourth. The rule is untouched");
  ok(posted.length === before + 4, "§8/ROOM: all four messages reached the room — nothing here is a duplicate-post block");

  const forcedForW = (await forcedRows()).filter((d) => d["wakeId"] === w);
  const reasons = forcedForW.map((d) => String(d["reason"])).sort();
  ok(
    reasons.filter((r) => r === "answered-this-turn-forced").length === 1,
    `§8/AUDIT: 🔴 exactly ONE \`answered-this-turn-forced\` row for this wake in this turn — three forced calls drew it live 100 times (saw ${reasons.length} rows: ${reasons.join(", ")})`,
  );
  ok(
    reasons.filter((r) => r === "should-be-edit-forced").length === 1,
    "§8/AUDIT: 🔴 and exactly ONE `should-be-edit-forced` row — the second gate is recorded once per ROOM per turn, the key its own refusal record uses",
  );
  ok(reasons.length === 2, "§8/AUDIT: and nothing else — two overrides, two rows, whatever the model does afterwards");

  ok(
    typeof notes.second.note === "string" && notes.second.note.includes("edit_reply"),
    "§8/NOTE: an overriding post is told to correct its own message with `edit_reply` rather than post again",
  );
  ok(notes.second.note!.includes("no_reply"), "§8/NOTE: …and that finishing the turn is the other way out");
  ok(
    !notes.second.note!.includes("a second call is refused"),
    "§8/NOTE: 🔴 …and it no longer promises a refusal the model has just proved false — a host whose words do not track what it does teaches nothing",
  );
  ok(
    notes.third.note!.includes("this turn ENDS after your next step"),
    `§8/NOTE: past ${FORCED_OVERRIDE_TURN_LIMIT} overrides the note says the turn is ending — the loop terminator is announced, not silent (turn-closeout-test §17 proves it fires)`,
  );
  ok(
    !notes.second.note!.includes("this turn ENDS after your next step"),
    "§8/NOTE/CONTROL: the FIRST override says no such thing — one override is a judgement the ruling keeps possible",
  );
  ok(
    !notes.third.note!.includes("Keep working if needed"),
    "§8/NOTE: 🔴 …and a note that says the turn is ending does not also say 'keep working' — two sentences pulling opposite ways teach nothing",
  );
  ok(
    notes.second.note!.includes("Keep working if needed"),
    "§8/NOTE/CONTROL: a turn that is NOT ending still reads the ordinary tail",
  );
}

{
  const inTurn = newSession();
  const w = await wake("C_NO_OVERRIDE");
  const seat = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
  const first = await inTurn(async () => {
    seedTailWindow(seat);
    return await callReply(w, "turn_81", w, "One ordinary answer.", true);
  });
  ok(first.posted === true, "§8b/CONTROL: the ordinary reply posts");
  ok((await forcedRows()).filter((d) => d["wakeId"] === w).length === 0, "§8b/CONTROL: and draws NO override row");
  ok(
    first.note!.includes("a second call is refused") && !first.note!.includes("edit_reply"),
    "§8b/CONTROL: …and reads the plain note — the override copy rides only a call that really overrode a verdict",
  );
}

{
  const inTurn = newSession();
  const w = await wake("C_FORCED_REFUSED");
  const before = posted.length;

  const out = await inTurn(async () => {
    const first = await callReply(w, "turn_82", w, "The answer, before the worker.", true);
    ok(first.posted === true, "§8c: the first `done:true` reply posts and marks the wake answered");
    notePendingDelegation("turn_82", "task_8c", w);
    const refused = await callReplyForced(w, "turn_82", w, "A forced second answer over the running worker.", true);
    return { refused };
  });
  ok(typeof out.refused.error === "string", "§8c/CONTROL: the forced call is REFUSED by the delegation gate — `force` does not open it");
  ok(out.refused.posted !== true, "§8c/CONTROL: …and it reports no post");
  ok(posted.length === before + 1, "§8c/ROOM: the room holds only the first answer");
  ok(
    (await forcedRows()).filter((d) => d["wakeId"] === w).length === 0,
    "§8c/AUDIT: 🔴 and NO `reply.forced` row — an override recorded for a message the room never saw is a false row",
  );

  const later = await inTurn(async () => {
    noteDelegationSettled("turn_82", "task_8c");
    return await callReplyForced(w, "turn_82", w, "The worker reported; here is the real answer.", true);
  });
  ok(later.posted === true, "§8c: with nothing owing, the forced call posts");
  ok(
    (await forcedRows()).filter((d) => d["wakeId"] === w && d["reason"] === "answered-this-turn-forced").length === 1,
    "§8c/AUDIT: 🔴 …and it is the FIRST recorded override for this wake — the refused call spent none of the turn's two",
  );
  ok(
    !later.note!.includes("this turn ENDS after your next step"),
    "§8c: 🔴 so the turn is NOT ended. A refused call that stole an override would have ended it here, on the first real one",
  );
}

{
  const inTurn = newSession();
  const w = await wake("C_FOLD_ONLY");
  const seat = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
  const out = await inTurn(async () => {
    seedTailWindow(seat);
    const part = await callReply(w, "turn_83", w, "Working on it — the first part.", false);
    ok(part.posted === true, "§8d/CONTROL: a `done:false` part posts and records nothing in the done set");
    ok(
      part.note!.includes("This wake stays OPEN"),
      "§8d/CONTROL: …and reads the open-wake note, so the teeth have provably not fired for this wake",
    );
    return await callReplyForced(w, "turn_83", w, "And here is the full answer.", true);
  });
  ok(out.posted === true, "§8d: the first `done:true` answer posts");
  const rows = (await forcedRows()).filter((d) => d["wakeId"] === w).map((d) => String(d["reason"]));
  ok(
    rows.includes("should-be-edit-forced") && !rows.includes("answered-this-turn-forced"),
    `§8d/CONTROL: 🔴 it overrode the FOLD verdict and not the done teeth — the state finding 1 needs (saw ${rows.join(", ") || "no rows"})`,
  );
  ok(
    out.note!.includes("This wake is now ANSWERED") && out.note!.includes("a second call is refused"),
    "§8d: 🔴 so the note reads the FIRST-ANSWER copy — the teeth WILL refuse the next call, and the note must say so",
  );
  ok(
    !out.note!.includes("was already ANSWERED"),
    "§8d: 🔴 …and never 'was already ANSWERED', which is false on a first answer. Branching this sentence on the turn-wide max is what made it false",
  );
  ok(
    out.note!.includes("edit_reply"),
    "§8d/CONTROL: the override note still rides — the fix narrows ONE sentence, it does not drop the steer",
  );
}

{
  const inTurn = newSession();
  const wA = await wake("C_SIB_A");
  const wB = await wake("C_SIB_B");
  const before = posted.length;
  const notes = await inTurn(async () => {
    await callReply(wA, "turn_84", wA, "Answer to A.", true);
    await callReply(wB, "turn_84", wB, "Answer to B.", true);
    const a = await callReplyForced(wA, "turn_84", wA, "A, forced once more.", true);
    const b = await callReplyForced(wB, "turn_84", wB, "B, forced once more.", true);
    return { a, b };
  });
  ok(notes.a.posted === true && notes.b.posted === true, "§8e: both forced siblings post");
  ok(posted.length === before + 4, "§8e/ROOM: all four messages reached the room");
  const rowsA = (await forcedRows()).filter((d) => d["wakeId"] === wA && d["reason"] === "answered-this-turn-forced");
  const rowsB = (await forcedRows()).filter((d) => d["wakeId"] === wB && d["reason"] === "answered-this-turn-forced");
  ok(
    rowsA.length === 1 && rowsB.length === 1,
    `§8e/AUDIT: 🔴 ONE row per WAKE, so a coalesced turn writes one PER conversation, not one in total (A=${rowsA.length}, B=${rowsB.length})`,
  );
  ok(
    !notes.a.note!.includes("this turn ENDS after your next step") && !notes.b.note!.includes("this turn ENDS after your next step"),
    "§8e: 🔴 …and neither sibling's FIRST override ends the turn — the limit is per verdict per wake, never a turn-wide sum",
  );
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    const R = "answered-this-turn-forced";
    for (let i = 0; i < 40; i++) ok(noteForcedOverrideThisTurn("turn_85", R, `wake-${i}`) === 1, `§8f/CONTROL: key ${i} is a first override`);
    ok(
      noteForcedOverrideThisTurn("turn_85", R, "wake-39") === 2,
      "§8f: 🔴 past the cap a key REPEATED in place still reaches 2, so a turn that repeats one key stays bounded",
    );
    ok(noteForcedOverrideThisTurn("turn_85", R, "wake-39") === 3, "§8f: …and keeps counting, so the latch stays armed");
    ok(
      noteForcedOverrideThisTurn("turn_85", R, "wake-0") === 1,
      "§8f: 🔴 the OLDEST key was evicted, so it restarts at 1 — one extra row and one extra override, never an unbounded loop",
    );
    ok(noteForcedOverrideThisTurn("turn_86", R, "wake-39") === 1, "§8f/CONTROL: a different turn starts its own record");
  });
}

{
  const inTurn = newSession();
  const w = await wake("C_FOLD_LOOP");
  const before = posted.length;
  const seat = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
  ok(seat !== null, "§8g/CONTROL: the fixture's token is a STANDING seat, so the fold gate is live");

  const out = await inTurn(async () => {
    seedTailWindow(seat);
    const first = await callReply(w, "turn_87", w, "Part one of the answer.", false);
    ok(first.posted === true, "§8g/CONTROL: the first `done:false` part posts");
    const refused = await callReply(w, "turn_87", w, "Part two, stacked under part one.", false);
    ok(typeof refused.error === "string" && /edit_reply/.test(refused.error), "§8g/CONTROL: the second part draws the FOLD refusal, which spends it for this room");
    const forced1 = await callReplyForced(w, "turn_87", w, "Part two, forced.", false);
    const armedAfterOne = turnCloseoutFor("reply-done-teeth-test", "turn_87");
    const forced2 = await callReplyForced(w, "turn_87", w, "Part three, forced.", false);
    const forced3 = await callReplyForced(w, "turn_87", w, "Part four, forced.", false);
    return { forced1, forced2, forced3, armedAfterOne };
  });

  ok(out.forced1.posted === true && out.forced2.posted === true && out.forced3.posted === true, "§8g: every forced call POSTS — the fix counts more, it never blocks more");
  ok(posted.length === before + 4, "§8g/ROOM: the room holds the first part and the three forced ones; the refused call reached nobody");

  const rows = (await forcedRows()).filter((d) => d["wakeId"] === w).map((d) => String(d["reason"]));
  ok(
    rows.filter((r) => r === "should-be-edit-forced").length === 1,
    `§8g/AUDIT: 🔴 the spent refusal no longer swallows the override — ONE \`should-be-edit-forced\` row, where the old code wrote none (saw ${rows.join(", ") || "no rows"})`,
  );
  ok(
    rows.filter((r) => r === "answered-this-turn-forced").length === 0,
    "§8g/CONTROL: 🔴 and NO `answered-this-turn-forced` row — every call is `done:false`, so this leg is the fold gate alone and no sibling gate can carry its pass",
  );

  ok(
    out.armedAfterOne === undefined,
    "§8g/CONTROL: 🔴 the FIRST override arms nothing — one override is a judgement the rule keeps possible",
  );
  ok(
    !out.forced1.note!.includes("this turn ENDS after your next step"),
    "§8g/CONTROL: …and its note says no such thing either",
  );
  ok(
    out.forced2.note!.includes("this turn ENDS after your next step"),
    `§8g: 🔴 the SECOND override reaches ${FORCED_OVERRIDE_TURN_LIMIT} and the note announces the turn's end — the old code counted 0 here and said nothing`,
  );
  const latch = turnCloseoutFor("reply-done-teeth-test", "turn_87");
  ok(
    latch?.reason === REPLY_FORCED_LOOP_REASON,
    `§8g: 🔴 …and the closeout latch is ARMED under the forced-loop reason, so the next model round-trip ends the turn (saw ${latch?.reason ?? "nothing"})`,
  );
}

console.log(`✓ reply-done-teeth: ${passed} assertions passed`);
