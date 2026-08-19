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

const dir = join(tmpdir(), `open-everywhere-reply-fold-test-${process.pid}`);
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
const { seedTailWindow, tailWindowFor, recordWakeTail } = await import("../agent/channels/session-tail-record.js");
const { repliedWakesThisTurn } = await import("../agent/channels/reply-signal.js");
const { REPLY_DEDUPE_SKIPPED_ID } = await import("../agent/channels/reply-post.js");
const { OWN_POST_TTL_MS } = await import("../agent/channels/own-post-ledger.js");
const { foldTargetInTail, foldIntoEditRefusalMessage, platformCanEdit, replyFoldTarget, REPLY_FOLD_REFUSAL_REASON, REPLY_FOLD_FORCED_AUDIT_REASON } =
  await import("../agent/channels/reply-fold.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type UnifiedWakeOrigin = import("../agent/channels/unified-window.js").UnifiedWakeOrigin;
type SessionTailEntry = import("../agent/channels/session-tail.js").SessionTailEntry;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);
const rawTailWindow = tailWindowFor({ org: ORG, domainKey: DOMAIN, surfaceKey: SURFACE, rawToken: `unified:${TOKEN}`, platform: "slack" });
ok(rawTailWindow !== null, "fixture sanity: the domain window token classifies as a standing generation — every ring assertion rests on this");
const TAIL_WINDOW = rawTailWindow as NonNullable<typeof rawTailWindow>;

const posted: { channel: string; text: string }[] = [];

registerSlackTestBridge({
  channel: { __fixture: "slack" } as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") {
      posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: `ts-${posted.length}` } as never;
    }
    if (method === "chat.update") return { ok: true, ts: p.get("ts") } as never;
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
      id: "reply-fold-test",
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
  c.set(SessionKey, { sessionId: "reply-fold-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(
  turnWake: string,
  turnId: string,
  wake: string,
  text: string,
  force = false,
): Promise<{ id?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = armOf(replyTool, ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done: true, force }, ctx)
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

async function wakeFor(channelId: string): Promise<string> {
  const id = mintWakeId();
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId };
  await registerUnifiedWakeTarget(store, ORG, id, origin, new Date(Date.now() - 60_000).toISOString(), TOKEN, true);
  return id;
}

async function roomSaid(atMs: number, container = SURFACE): Promise<void> {
  await recordWakeTail(TAIL_WINDOW.org, TAIL_WINDOW.registryKey, TAIL_WINDOW.token, {
    kind: "wake",
    at: new Date(atMs).toISOString(),
    from: "human",
    trust: "principal",
    author: "U1",
    authorId: "U1",
    platform: "slack",
    container,
    text: "a message from the room",
  });
}

const LOCUS = { platform: "slack", channelId: CHAN };

const rowsFor = async (action: string, wakeId: string): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action }))
    .map((r) => (r.detail ?? {}) as Record<string, unknown>)
    .filter((d) => d["wakeId"] === wakeId);

const entry = (e: Partial<SessionTailEntry> & Pick<SessionTailEntry, "kind" | "at">): SessionTailEntry =>
  ({ from: e.kind === "post" ? "self" : "human", trust: "principal", author: "x", platform: "slack", container: SURFACE, text: "t", ...e }) as SessionTailEntry;

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);
  await roomSaid(Date.now());
  const before = posted.length;

  const r = await inTurn(() => callReply(w, "turn_1", w, "Here is the answer."));
  ok(typeof r.id === "string" && r.id.length > 0, "§1: the reply posted");
  ok(posted.length === before + 1, "§1/ROOM: it reached the room — the policy is not a tax on a normal answer");
  ok((await rowsFor("reply.refused", w)).length === 0, "§1/AUDIT: no refusal row on the happy path");
}

let foldedMessageId = "";
{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);
  await roomSaid(Date.now());

  const first = await inTurn(() => callReply(w, "turn_2", w, "Part one of what I found."));
  ok(typeof first.id === "string", "§2: the first reply posted, and is now the newest message in the room");
  foldedMessageId = first.id as string;
  const before = posted.length;

  const second = await inTurn(() => callReply(w, "turn_2b", w, "Part two, stacked underneath."));
  ok(second.id === undefined && typeof second.error === "string", "🔴 §2: the SECOND post is REFUSED");
  ok(posted.length === before, "🔴 §2/ROOM: NOTHING reached the room — the verdict is taken before the choke point");
  const refusals = await rowsFor("reply.refused", w);
  ok(refusals.length === 1 && refusals[0]["reason"] === REPLY_FOLD_REFUSAL_REASON, "§2/AUDIT: one `reply.refused` row, reason `should-be-edit`");
  const copy = String(second.error);
  ok(copy.includes(foldedMessageId), "§2/COPY: it names the message id to fold into — the model needs it to call `edit_reply`");
  ok(copy.includes("edit_reply"), "§2/COPY: …and names the verb");
  ok(/REPLACES/.test(copy), "🔴 §2/COPY: it warns that an edit REPLACES the message — the one way this policy can lose what the room already read");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);
  await roomSaid(Date.now());
  const before = posted.length;

  const r = await inTurn(() => callReply(w, "turn_3", w, "Answering the new message."));
  ok(typeof r.id === "string", "🔴 §3: a message from the room since our post means this is NOT a fold — it POSTS");
  ok(posted.length === before + 1, "§3/ROOM: it reached the room");
  ok((await rowsFor("reply.refused", w)).length === 0, "§3/AUDIT: and nothing was refused");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);

  const refused = await inTurn(() => callReply(w, "turn_4", w, "Something genuinely new."));
  ok(refused.id === undefined, "§4: the first attempt is refused (§3's post is the newest message)");
  const before = posted.length;
  const again = await inTurn(() => callReply(w, "turn_4", w, "Something genuinely new."));
  ok(typeof again.id === "string", "🔴 §4: the SAME call in the SAME turn POSTS — the policy refuses at most once per room per turn");
  ok(posted.length === before + 1, "§4/ROOM: and the message really reached the room");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);
  const before = posted.length;

  const forced = await inTurn(() => callReply(w, "turn_5", w, "This one has to notify.", true));
  ok(typeof forced.id === "string", "§5: `force: true` posts through a fold verdict");
  ok(posted.length === before + 1, "§5/ROOM: the forced message reached the room");
  const rows = await rowsFor("reply.forced", w);
  ok(rows.length === 1 && rows[0]["reason"] === REPLY_FOLD_FORCED_AUDIT_REASON, "§5/AUDIT: one `reply.forced` row, reason `should-be-edit-forced`");
  ok((await rowsFor("reply.refused", w)).length === 0, "§5/AUDIT: a forced send is an override, never also a refusal");

  const w2 = await wakeFor(CHAN);
  await roomSaid(Date.now());
  const clean = await inTurn(() => callReply(w2, "turn_5b", w2, "Nothing to override here.", true));
  ok(typeof clean.id === "string", "§5/CONTROL: the reply posts");
  ok((await rowsFor("reply.forced", w2)).length === 0, "🔴 §5/CONTROL: …and writes NO `reply.forced` row — a force on a clean room overrode nothing");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);
  await roomSaid(Date.now());
  await inTurn(() => callReply(w, "turn_6a", w, "The first message."));

  const w2 = await wakeFor(CHAN);
  const text = "The message the policy refuses.";
  const refused = await inTurn(() => callReply(w2, "turn_6b", w2, text));
  ok(refused.id === undefined, "§6: the post is refused");
  const answeredAfterRefusal = await store.getUnifiedWakeRecord(ORG, w2);
  ok(!answeredAfterRefusal?.answeredAt, "🔴 §6/WAKE: the refusal did NOT mark the wake answered — the turn still owes this conversation an answer");

  const before = posted.length;
  const forced = await inTurn(() => callReply(w2, "turn_6c", w2, text, true));
  ok(forced.id !== undefined && forced.id !== REPLY_DEDUPE_SKIPPED_ID, "🔴 §6/DEDUPE: the SAME text posts with a real platform id — the refusal never claimed the post-once key");
  ok(posted.length === before + 1, "§6/ROOM: and it genuinely reached the room, rather than being suppressed as a duplicate");
}

{
  ok(platformCanEdit("slack") === true, "§7: the registry says slack can edit (its arm carries `editMessage`)");
  ok(platformCanEdit("notion") === false, "🔴 §7: …and notion cannot — no comment-update endpoint exists, so there is no arm");
  ok(platformCanEdit("no-such-surface") === false, "§7: an unregistered platform cannot edit either");

  const ring = [entry({ kind: "post", at: new Date().toISOString(), id: "m1" })];
  ok(foldTargetInTail(ring, { container: SURFACE, platform: "slack", canEdit: () => true })?.messageId === "m1", "§7: with an edit arm, our own last post IS the fold target");
  ok(foldTargetInTail(ring, { container: SURFACE, platform: "slack", canEdit: () => false }) === null, "🔴 §7: without one, there is NO fold target and the post goes through");
}

{
  const now = Date.now();
  const fresh = [entry({ kind: "post", at: new Date(now - 60_000).toISOString(), id: "m1" })];
  const stale = [entry({ kind: "post", at: new Date(now - OWN_POST_TTL_MS - 60_000).toISOString(), id: "m1" })];
  ok(foldTargetInTail(fresh, { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now })?.messageId === "m1", "§8: a post inside the edit window folds");
  ok(foldTargetInTail(stale, { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now }) === null, "🔴 §8: a post past the edit window does NOT — the redirect must land somewhere that works");
  ok(
    foldTargetInTail([entry({ kind: "post", at: "not-a-date", id: "m1" })], { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now }) === null,
    "§8: an unparseable timestamp answers no-fold — fail-open, like every other unknown",
  );
  ok(
    foldTargetInTail([entry({ kind: "post", at: new Date(now).toISOString() })], { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now }) === null,
    "§8: a post with no recorded platform id answers no-fold — there is no id to name to `edit_reply`",
  );
}

{
  const now = Date.now();
  const ring = [
    entry({ kind: "post", at: new Date(now - 2000).toISOString(), id: "mine" }),
    entry({ kind: "wake", at: new Date(now - 1000).toISOString(), container: "slack/T1/C_OTHER" }),
  ];
  ok(
    foldTargetInTail(ring, { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now })?.messageId === "mine",
    "🔴 §9: a message in a SIBLING room does not clear the fold in this one",
  );
  ok(
    foldTargetInTail(ring, { container: "slack/T1/C_OTHER", platform: "slack", canEdit: () => true, nowMs: now }) === null,
    "§9: and our post in THIS room is not a fold target for a post into the sibling",
  );
  ok(
    foldTargetInTail([entry({ kind: "post", at: new Date(now).toISOString(), id: "m1", platform: "discord" })], {
      container: SURFACE,
      platform: "slack",
      canEdit: () => true,
      nowMs: now,
    }) === null,
    "§9: a fold target recorded on another SURFACE is another room too",
  );
}

{
  const now = Date.now();
  ok((await replyFoldTarget(store, null, "slack", LOCUS)) === null, "§10: NO TAIL WINDOW (a worker, a task session, a native seat) ⇒ no fold");
  ok((await replyFoldTarget(store, TAIL_WINDOW, "slack", null)) === null, "§10: NO EDITABLE ADDRESS for this surface ⇒ no fold");
  ok(
    foldTargetInTail([entry({ kind: "post", at: new Date(now).toISOString(), id: "m1" })], { container: undefined, platform: "slack", canEdit: () => true, nowMs: now }) === null,
    "§10: NO CONTAINER ⇒ the rooms cannot be told apart ⇒ no fold",
  );
  ok(foldTargetInTail([], { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now }) === null, "§10: an EMPTY ring ⇒ no fold");
  const brokenStore = { readSessionTail: async (): Promise<SessionTailEntry[]> => { throw new Error("store down"); } };
  ok((await replyFoldTarget(brokenStore, TAIL_WINDOW, "slack", LOCUS)) === null, "🔴 §10: an UNREADABLE store ⇒ no fold, and the reply posts");
  const tied = [entry({ kind: "post", at: new Date(now).toISOString(), id: "m1" }), entry({ kind: "wake", at: new Date(now).toISOString() })];
  ok(foldTargetInTail(tied, { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now }) === null, "§10: a same-millisecond TIE reads as 'the room spoke' ⇒ no fold");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);
  await roomSaid(Date.now());
  const first = await inTurn(() => callReply(w, "turn_11a", w, "The message that will be folded into."));
  ok(typeof first.id === "string", "§11: the first reply posted");

  const w2 = await wakeFor(CHAN);
  const acted = await inTurn(async () => {
    const refused = await callReply(w2, "turn_11b", w2, "The part that should fold in.");
    ok(refused.id === undefined, "§11: the second post is refused, as §2 proves");
    const e = await callEdit(w2, "turn_11b", w2, first.id as string, "The whole message, both parts.");
    ok(e.edited === true, "§11: the model folds via `edit_reply`, and the platform confirms");
    return repliedWakesThisTurn("turn_11b");
  });
  ok(acted.includes(w2), "🔴 §11: the folded wake is in the turn's ACTED-ON set — a compliance is not a dropped wake");

  const control = await inTurn(async () => repliedWakesThisTurn("turn_11_never_ran"));
  ok(!control.includes(w2), "§11/CONTROL: a turn that did nothing holds an EMPTY acted-on set — the mark is not ambient");
}

{
  const target = { messageId: "ts-9", platform: "slack" };
  ok(foldIntoEditRefusalMessage(target, true).includes("force: true"), "§12: the unified copy names the `force` valve it actually has");
  ok(!foldIntoEditRefusalMessage(target, false).includes("force"), "🔴 §12: the per-surface copy does NOT — that variant takes no `force` input, and naming one would teach a call that fails");
  ok(foldIntoEditRefusalMessage(target, false).includes("Re-send"), "§12: …it names the valve it does have");
}

{
  const ringOnly: SessionTailEntry[] = [entry({ kind: "post", at: new Date().toISOString(), id: "never-in-the-ledger" })];
  const fakeStore = { readSessionTail: async (): Promise<SessionTailEntry[]> => ringOnly };
  ok(
    (await replyFoldTarget(fakeStore, TAIL_WINDOW, "slack", LOCUS)) === null,
    "🔴 §13: a ring row with NO ledger row is NOT a fold target — the redirect must land somewhere `edit_reply` accepts",
  );
  ok(
    (await replyFoldTarget(fakeStore, TAIL_WINDOW, "slack", LOCUS, undefined, { hasEventSeen: async () => true }))?.messageId === "never-in-the-ledger",
    "§13/CONTROL: with the ledger confirming, the SAME ring row IS the fold target — the ledger read is the only difference",
  );
}

console.log(`✓ reply-fold: ${passed} assertions passed`);
