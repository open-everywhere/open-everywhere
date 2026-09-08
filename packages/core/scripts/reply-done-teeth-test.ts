import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

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
process.env.OE_ORG = "acme";

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { seedTailWindow, tailWindow, tailWindowFor } = await import("../agent/channels/session-tail-record.js");
const { secondMessageValve } = await import("../agent/channels/reply-signal.js");

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
  loadDomains: () => [defineDomain({ name: DOMAIN, channels: [SURFACE], ambientSupervisor: true, mode: "unified" })],
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

console.log(`✓ reply-done-teeth: ${passed} assertions passed`);
