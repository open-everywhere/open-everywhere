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

const dir = join(tmpdir(), `open-everywhere-edit-reply-test-${process.pid}`);
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
const { EDIT_NOT_OWN_REFUSAL_REASON } = await import("../agent/channels/reply-edit.js");
const { recordOwnPost, isOwnPost, ownPostKey, OWN_POST_TTL_MS } = await import("../agent/channels/own-post-ledger.js");
const { REPLY_DEDUPE_SKIPPED_ID } = await import("../agent/channels/reply-post.js");
const { seedTailWindow, tailWindowFor } = await import("../agent/channels/session-tail-record.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type UnifiedWakeOrigin = import("../agent/channels/unified-window.js").UnifiedWakeOrigin;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);
const rawTailWindow = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
ok(rawTailWindow !== null, "fixture sanity: the domain window token classifies as a standing generation — every §15-§17 assertion rests on this");
const TAIL_WINDOW = rawTailWindow as NonNullable<typeof rawTailWindow>;

const posted: { channel: string; text: string }[] = [];
const edited: { channel: string; ts: string; text: string }[] = [];
let updatesSent = 0;
let updateOutcome: "ok" | "definitive" | "ambiguous" = "ok";

registerSlackTestBridge({
  channel: { __fixture: "slack" } as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") {
      posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: `ts-${posted.length}` } as never;
    }
    if (method === "chat.update") {
      updatesSent++;
      if (updateOutcome === "ambiguous") throw new Error("the connection dropped before Slack answered");
      if (updateOutcome === "definitive") return { ok: false, error: "message_not_found" } as never;
      edited.push({ channel: p.get("channel") ?? "", ts: p.get("ts") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: p.get("ts") } as never;
    }
    return { ok: true } as never;
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
const editTool = (await import("../agent/tools/edit_reply.js")).default;
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const armOf = (tool: unknown, ctx: unknown): Armed | null =>
  (tool as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as Armed | null;

function ctxFor(turnWake: string, turnId: string): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: "edit-reply-test",
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
  c.set(SessionKey, { sessionId: "edit-reply-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(turnWake: string, turnId: string, wake: string, text: string): Promise<{ id?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = armOf(replyTool, ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done: true, force: false }, ctx)
    .then((r) => r as { id?: string })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function callEdit(turnWake: string, turnId: string, wake: string, messageId: string, text: string): Promise<{ edited?: boolean; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = armOf(editTool, ctx);
  if (!armed) return { error: "edit_reply did not arm" };
  return armed
    .execute({ text, wake, message_id: messageId }, ctx)
    .then((r) => r as { edited?: boolean })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function wakeAt(channelId: string, atIso: string): Promise<string> {
  const id = mintWakeId();
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId };
  await registerUnifiedWakeTarget(store, ORG, id, origin, atIso, TOKEN, true);
  return id;
}

const t = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

const rowsFor = async (action: string, wakeId: string): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action }))
    .map((r) => (r.detail ?? {}) as Record<string, unknown>)
    .filter((d) => d["wakeId"] === wakeId);

{
  const inTurn = newSession();
  const w = await wakeAt(CHAN, t(-1000));
  const roomBefore = posted.length;

  const r = await inTurn(() => callReply(w, "turn_1", w, "Three items: a, b, c."));
  ok(typeof r.id === "string" && r.id.length > 0, "§1: `reply` returns the platform message id the edit verb addresses");
  ok(posted.length === roomBefore + 1, "§1/ROOM: the reply reached the room");

  const editsBefore = edited.length;
  const e = await inTurn(() => callEdit(w, "turn_1", w, r.id as string, "Four items: a, b, c, d."));
  ok(e.edited === true, "§1: `edit_reply` rewrites a message this deployment posted");
  ok(edited.length === editsBefore + 1, "§1/UPDATE: exactly one chat.update reached Slack");
  ok(edited[edited.length - 1]?.ts === r.id, "§1/UPDATE: it addressed the id `reply` returned, not another message");
  ok(edited[edited.length - 1]?.channel === CHAN, "§1/UPDATE: it addressed the host-resolved channel, never a model-authored one");
  ok(edited[edited.length - 1]?.text === "Four items: a, b, c, d.", "§1/UPDATE: the replacement text is what the model passed");
  ok(posted.length === roomBefore + 1, "§1/ROOM: the edit added NO message — an edit is not a delivery channel");
  ok((await rowsFor("reply.edit", w)).length === 1, "§1/AUDIT: one `reply.edit` row, with the same attribution `reply.post` carries");
  ok((await rowsFor("reply.edit.refused", w)).length === 0, "§1/AUDIT: no refusal row on the happy path");
}

{
  const inTurn = newSession();
  const w = await wakeAt(CHAN, t(-1000));
  const roomBefore = posted.length;
  const editsBefore = edited.length;

  const e = await inTurn(() => callEdit(w, "turn_2", w, "1755805215.999999", "I am rewriting somebody else's message."));
  ok(e.edited !== true, "§2: an id this deployment never posted is REFUSED");
  ok(typeof e.error === "string", "§2: the refusal reaches the model as an error it can act on");
  ok(edited.length === editsBefore, "§2/UPDATE: NO chat.update reached Slack — the fence decided before any byte left");
  ok(posted.length === roomBefore, "§2/ROOM: nothing was posted either");
  const refusals = await rowsFor("reply.edit.refused", w);
  ok(refusals.length === 1, "§2/AUDIT: the refusal is RECORDED — a refused edit must be countable, not merely quiet");
  ok(refusals[0]?.["reason"] === EDIT_NOT_OWN_REFUSAL_REASON, `§2/AUDIT: the row names "${EDIT_NOT_OWN_REFUSAL_REASON}"`);
}

{
  const inTurn = newSession();
  const w = await wakeAt(CHAN, t(-1000));
  const probe = "1799971319.123456";
  const e = await inTurn(() => callEdit(w, "turn_3", w, probe, "probe"));
  ok(e.edited !== true, "§3: the probe is refused");
  ok(!String(e.error).includes(probe), "§3/DISCLOSURE: the refusal does not echo the rejected id — a refusal is not a probe for which ids exist");
  ok(String(e.error).includes("reply"), "§3/RECOVERY: the copy steers to posting a new `reply` instead");
}

{
  const inTurn = newSession();
  const other = await wakeAt("C_OTHER", t(-1000));
  const here = await wakeAt(CHAN, t(-1000));

  const r = await inTurn(() => callReply(other, "turn_4a", other, "Posted over in the other channel."));
  ok(typeof r.id === "string", "§4: the reply into the OTHER conversation posted");

  const editsBefore = edited.length;
  const e = await inTurn(() => callEdit(here, "turn_4b", here, r.id as string, "Reaching across conversations."));
  ok(e.edited !== true, "§4: a message we posted in ANOTHER conversation is refused HERE — the ledger is keyed on the locus, not the id alone");
  ok(edited.length === editsBefore, "§4/UPDATE: no chat.update was attempted");
}

{
  const inTurn = newSession();
  const w = await wakeAt(CHAN, t(-1000));
  const r = await inTurn(() => callReply(w, "turn_5", w, "A real post."));
  const editsBefore = edited.length;

  const e = await inTurn(() => callEdit(w, "turn_5", "wake-that-does-not-exist", r.id as string, "Steered at an unheld wake."));
  ok(e.edited !== true, "§5: an unknown wake id is refused — the edit path inherits `reply`'s authority fence");
  ok(edited.length === editsBefore, "§5/UPDATE: no chat.update was attempted");
}

{
  const locus = { platform: "slack", channelId: CHAN };
  const old = "1700159720.000001";
  await recordOwnPost(ORG, locus, old, { now: () => Date.now() - OWN_POST_TTL_MS * 2 });
  ok((await isOwnPost(ORG, locus, old)) === false, "§6: a post older than OWN_POST_TTL_MS is no longer editable — the verb is about a RECENT post");

  const fresh = "1700159720.000002";
  await recordOwnPost(ORG, locus, fresh);
  ok((await isOwnPost(ORG, locus, fresh)) === true, "§6/CONTROL: a post inside the window IS editable — §6 measures the TTL, not a broken write");
}

{
  const locus = { platform: "slack", channelId: CHAN };
  const id = "1700159720.000003";
  await recordOwnPost(ORG, locus, id);
  ok((await isOwnPost(ORG, locus, id)) === true, "§7/CONTROL: the row is genuinely there when the store works");
  const answer = await isOwnPost(ORG, locus, id, {
    hasEventSeen: async () => {
      throw new Error("store down");
    },
  });
  ok(answer === false, "§7: a throwing store answers FALSE — the inverse of post-once's fail-open, because this decides a write over an existing message");
  ok((await isOwnPost(undefined, locus, id)) === false, "§7: no resolvable org answers FALSE too");
}

{
  const locus = { platform: "slack", channelId: CHAN };
  await recordOwnPost(ORG, locus, REPLY_DEDUPE_SKIPPED_ID);
  ok(
    (await isOwnPost(ORG, locus, REPLY_DEDUPE_SKIPPED_ID)) === false,
    "§8: the suppressed-repost sentinel never enters the ledger — it is not a platform id and addresses nothing",
  );
  ok(REPLY_DEDUPE_SKIPPED_ID === "deduped:reply", "§8/PIN: the sentinel string the ledger hard-codes still matches the one reply-post.ts exports");
  await recordOwnPost(ORG, locus, "1700159720.000004");
  ok((await isOwnPost(ORG, locus, "1700159720.000004")) === true, "§8/CONTROL: an ordinary id at the same locus DOES record");
}

{
  const inTurn = newSession();
  const w = await wakeAt(CHAN, t(-1000));
  const r = await inTurn(() => callReply(w, "turn_9", w, "Answer, marked done."));
  ok(typeof r.id === "string", "§9: the reply posted and marked the wake answered");

  const second = await inTurn(() => callReply(w, "turn_9", w, "A second answer."));
  ok(second.error !== undefined, "§9/CONTROL: a second `reply` to the answered wake IS refused — the guard is live in this turn");

  const editsBefore = edited.length;
  const e = await inTurn(() => callEdit(w, "turn_9", w, r.id as string, "Answer, corrected."));
  ok(e.edited === true, "§9: the EDIT still goes through — an edit always happens after the answer, so `done` must not refuse it");
  ok(edited.length === editsBefore + 1, "§9/UPDATE: the correction reached Slack");
}

{
  const a = ownPostKey({ platform: "slack", channelId: "C1" }, "m1");
  ok(a !== ownPostKey({ platform: "slack", channelId: "C2" }, "m1"), "§10: a different channel is a different key");
  ok(a !== ownPostKey({ platform: "discord", channelId: "C1" }, "m1"), "§10: a different platform is a different key");
  ok(a !== ownPostKey({ platform: "slack", channelId: "C1" }, "m2"), "§10: a different message id is a different key");
  ok(a === ownPostKey({ platform: "slack", channelId: "C1" }, "m1"), "§10: the key is stable for the same three parts");
}

{
  const armed = armOf(editTool, { session: { id: "edit-reply-test" } } as unknown as BindableContext);
  ok(armed !== null, "§11: the tool MOUNTS even where an edit primitive cannot be resolved — an absent verb teaches the model nothing");

  const { editPostedMessage, EDIT_NO_ARM_REFUSAL_REASON } = await import("../agent/channels/reply-edit.js");
  const audit = { org: ORG, platform: "notion", workspace: "W1", route: "tool" as const, wakeId: "wake-notion-probe" };
  let refusal: string | undefined;
  await editPostedMessage({ platform: "notion", channelId: "D1" }, "comment-1", "corrected", audit)
    .then(() => undefined)
    .catch((e: unknown) => {
      refusal = String(e);
    });
  ok(refusal !== undefined, "§11: a surface with no edit arm ERRORS — never a silent no-op");
  ok(refusal?.includes("notion") === true, "§11/COPY: the error NAMES the surface, so the model knows the limit is the platform's");
  ok(refusal?.includes("reply") === true, "§11/RECOVERY: it steers to posting a new `reply` instead");
  const rows = await rowsFor("reply.edit.refused", "wake-notion-probe");
  ok(rows.length === 1 && rows[0]?.["reason"] === EDIT_NO_ARM_REFUSAL_REASON, "§11/AUDIT: the refusal is recorded as `no-edit-arm`");
}

{
  const inTurn = newSession();
  const w = await wakeAt(CHAN, t(-1000));
  const r = await inTurn(() => callReply(w, "turn_12", w, "Three items: a, b, c."));
  const roomAfterReply = posted.length;
  const editsBefore = edited.length;
  const sentBefore = updatesSent;

  updateOutcome = "definitive";
  const e = await inTurn(() => callEdit(w, "turn_12", w, r.id as string, "Four items: a, b, c, d."));
  updateOutcome = "ok";

  ok(e.edited !== true, "§12: a definitive platform failure is NOT reported as an edit");
  ok(typeof e.error === "string", "§12: it reaches the model as an ERROR — the turn stays open and a fresh `reply` is the remedy");
  ok(updatesSent === sentBefore + 1, "§12: the arm did call the platform — this leg measures the platform's answer, not a host fence");
  ok(edited.length === editsBefore, "§12/ROOM: no message changed");
  ok(posted.length === roomAfterReply, "§12/ROOM: and nothing was posted in its place by the host");
  const rows = await rowsFor("reply.edit.refused", w);
  ok(rows.length === 1 && rows[0]?.["reason"] === "platform-error", "§12/AUDIT: the failure is recorded as `platform-error`");
  ok(rows[0]?.["failure"] === "definitive", "§12/AUDIT: the row carries the CLASS the host acted on");
}

{
  const inTurn = newSession();
  const w = await wakeAt(CHAN, t(-1000));
  const r = await inTurn(() => callReply(w, "turn_13", w, "Three items: a, b, c."));
  const roomAfterReply = posted.length;
  const editsBefore = edited.length;
  const sentBefore = updatesSent;

  updateOutcome = "ambiguous";
  const e = (await inTurn(() => callEdit(w, "turn_13", w, r.id as string, "Four items: a, b, c, d."))) as {
    edited?: boolean;
    note?: string;
    error?: string;
  };
  updateOutcome = "ok";

  ok(e.error === undefined, "§13: an ambiguous failure does NOT reach the model as an error — an error re-opens the turn, and this one must not");
  ok(e.edited === false, "§13: the result says the edit was NOT confirmed");
  ok(updatesSent === sentBefore + 1, "§13: the arm did call the platform");
  ok(edited.length === editsBefore, "§13/ROOM: the fixture accepted nothing, so nothing changed in the room");
  ok(posted.length === roomAfterReply, "§13/ROOM: and no message was posted in its place");
  ok(String(e.note).includes("did not confirm"), "§13/NOTE: it names the one thing the model cannot see — the platform never answered");
  ok(/edit_reply` again/.test(String(e.note)), "§13/NOTE: the recovery it offers is a REPEAT EDIT, which is safe either way");
  ok(/Do NOT post a new reply/.test(String(e.note)), "§13/NOTE: negative control — it forbids the fresh post, the loss direction the rule names");
  const rows = await rowsFor("reply.edit.refused", w);
  ok(rows.length === 1 && rows[0]?.["reason"] === "platform-error", "§13/AUDIT: a returned result hides NOTHING from the trail — the row is still written");
  ok(rows[0]?.["failure"] === "ambiguous", "§13/AUDIT: and it names the class, so an operator can count the turns that ended without a correction");
}

{
  const { platformFailureClass, markNotApplied } = await import("../agent/channels/platform-failure.js");
  ok(platformFailureClass(markNotApplied(new Error("slack said ok:false"))) === "definitive", "§14: an arm that says `applied:false` is DEFINITIVE");
  ok(platformFailureClass(Object.assign(new Error("discord 404"), { status: 404 })) === "definitive", "§14: a 404 is DEFINITIVE — the platform read the request and refused it");
  ok(platformFailureClass(Object.assign(new Error("discord 403"), { status: 403 })) === "definitive", "§14: so is a 403");
  ok(platformFailureClass(Object.assign(new Error("discord 500"), { status: 500 })) === "ambiguous", "§14: a 5xx is AMBIGUOUS — the platform may have applied it and failed afterwards");
  ok(platformFailureClass(Object.assign(new Error("rate limited"), { status: 429 })) === "ambiguous", "§14: 429 is AMBIGUOUS — it says nothing about an earlier attempt");
  ok(platformFailureClass(Object.assign(new Error("timeout"), { status: 408 })) === "ambiguous", "§14: 408 is AMBIGUOUS for the same reason");
  ok(platformFailureClass(new Error("the socket closed")) === "ambiguous", "§14: an error with NEITHER signal fails CLOSED — an unknown cannot prove the edit failed");
  ok(platformFailureClass(undefined) === "ambiguous", "§14: and so does a non-error throw, without throwing here");

  const { carryFailureSignals } = await import("../agent/channels/platform-failure.js");
  const rewrapped = carryFailureSignals(markNotApplied(new Error("slack said ok:false")), new Error("react failed — …"));
  ok(platformFailureClass(rewrapped) === "definitive", "§14/CARRY: `applied:false` survives a re-wrap");
  ok(platformFailureClass(carryFailureSignals(Object.assign(new Error("404"), { status: 404 }), new Error("wrapped"))) === "definitive", "§14/CARRY: so does the status");
  ok((carryFailureSignals(Object.assign(new Error("404"), { status: 404 }), new Error("wrapped")) as { status?: number }).status === 404, "§14/CARRY: and the NUMBER itself travels, for the audit row");
  ok(
    platformFailureClass(carryFailureSignals(new Error("the socket closed"), new Error("wrapped"))) === "ambiguous",
    "§14/CARRY: NEGATIVE CONTROL — a wrap of an unsignalled error stays AMBIGUOUS; the carry invents nothing",
  );
  ok(
    platformFailureClass(carryFailureSignals(undefined, new Error("wrapped"))) === "ambiguous",
    "§14/CARRY: and a non-error source does not throw here either",
  );
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeAt(CHAN, t(-1000));

  const r = await inTurn(() => callReply(w, "turn_15", w, "Three items: a, b, c."));
  ok(typeof r.id === "string" && r.id.length > 0, "§15: the reply posted");

  const ring = await store.readSessionTail(TAIL_WINDOW.org, TAIL_WINDOW.registryKey, TAIL_WINDOW.token);
  const row = ring.find((e) => e.kind === "post" && e.text === "Three items: a, b, c.");
  ok(row !== undefined, "§15: the landed post is recorded on the ring");
  ok(row?.id === r.id, "🔴 §15: …and it carries the SAME platform message id `reply` returned — the precondition edit_reply's ring rewrite needs");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeAt(CHAN, t(-1000));

  const r = await inTurn(() => callReply(w, "turn_16", w, "Three items: a, b, c."));
  const e = await inTurn(() => callEdit(w, "turn_16", w, r.id as string, "Four items: a, b, c, d."));
  ok(e.edited === true, "§16: the edit was confirmed");

  const ring = await store.readSessionTail(TAIL_WINDOW.org, TAIL_WINDOW.registryKey, TAIL_WINDOW.token);
  const row = ring.find((entry) => entry.id === r.id);
  ok(row !== undefined, "§16: the ring row is still there, under the same id");
  ok(row?.text === "Four items: a, b, c, d.", "🔴 §16: …and its TEXT is REWRITTEN to the corrected message — the ring shows what the room now shows");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeAt(CHAN, t(-1000));
  const r = await inTurn(() => callReply(w, "turn_17", w, "Original text, unedited."));

  updateOutcome = "definitive";
  const eDef = await inTurn(() => callEdit(w, "turn_17", w, r.id as string, "This must not land on the ring."));
  updateOutcome = "ok";
  ok(eDef.edited !== true, "§17/DEFINITIVE: the edit was refused, as §12 already proves");
  let ring = await store.readSessionTail(TAIL_WINDOW.org, TAIL_WINDOW.registryKey, TAIL_WINDOW.token);
  let row = ring.find((entry) => entry.id === r.id);
  ok(row?.text === "Original text, unedited.", "🔴 §17/DEFINITIVE: the ring row is UNTOUCHED — a definitive failure proves nothing changed at the platform");

  updateOutcome = "ambiguous";
  const eAmb = (await inTurn(() => callEdit(w, "turn_17", w, r.id as string, "This must not land on the ring either."))) as { edited?: boolean };
  updateOutcome = "ok";
  ok(eAmb.edited === false, "§17/AMBIGUOUS: the edit was reported unconfirmed, as §13 already proves");
  ring = await store.readSessionTail(TAIL_WINDOW.org, TAIL_WINDOW.registryKey, TAIL_WINDOW.token);
  row = ring.find((entry) => entry.id === r.id);
  ok(
    row?.text === "Original text, unedited.",
    "🔴 §17/AMBIGUOUS: the ring row is STILL UNTOUCHED — an unconfirmed outcome must not claim the room changed, the same reasoning the ambiguous NOTE itself states to the model",
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ edit_reply own-post fence: ${passed} assertions passed`);
