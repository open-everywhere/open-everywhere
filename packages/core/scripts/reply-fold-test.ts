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
  opts: { readonly force?: boolean; readonly done?: boolean } = {},
): Promise<{ id?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = armOf(replyTool, ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done: opts.done ?? true, force: opts.force ?? false }, ctx)
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

async function wakeFor(channelId: string, agoMs = 60_000): Promise<string> {
  const id = mintWakeId();
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId };
  await registerUnifiedWakeTarget(store, ORG, id, origin, new Date(Date.now() - agoMs).toISOString(), TOKEN, true);
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
  await roomSaid(Date.now());
  const seed = await inTurn(() => callReply(w, "turn_4_seed", w, "The first part of the answer."));
  ok(typeof seed.id === "string", "§4 precondition: our own post on THIS wake is the newest message in the room");

  const refused = await inTurn(() => callReply(w, "turn_4", w, "Something genuinely new."));
  ok(refused.id === undefined, "§4: the first attempt is refused");
  const before = posted.length;
  const again = await inTurn(() => callReply(w, "turn_4", w, "Something genuinely new."));
  ok(typeof again.id === "string", "🔴 §4: the SAME call in the SAME turn POSTS — the policy refuses at most once per room per turn");
  ok(posted.length === before + 1, "§4/ROOM: and the message really reached the room");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);
  await roomSaid(Date.now());
  const seed = await inTurn(() => callReply(w, "turn_5_seed", w, "The first part of the answer."));
  ok(typeof seed.id === "string", "§5 precondition: our own post on THIS wake is the newest message in the room");
  const before = posted.length;

  const forced = await inTurn(() => callReply(w, "turn_5", w, "This one has to notify.", { force: true }));
  ok(typeof forced.id === "string", "§5: `force: true` posts through a fold verdict");
  ok(posted.length === before + 1, "§5/ROOM: the forced message reached the room");
  const rows = await rowsFor("reply.forced", w);
  ok(rows.length === 1 && rows[0]["reason"] === REPLY_FOLD_FORCED_AUDIT_REASON, "§5/AUDIT: one `reply.forced` row, reason `should-be-edit-forced`");
  ok((await rowsFor("reply.refused", w)).length === 0, "§5/AUDIT: a forced send is an override, never also a refusal");

  const w2 = await wakeFor(CHAN);
  await roomSaid(Date.now());
  const clean = await inTurn(() => callReply(w2, "turn_5b", w2, "Nothing to override here.", { force: true }));
  ok(typeof clean.id === "string", "§5/CONTROL: the reply posts");
  ok((await rowsFor("reply.forced", w2)).length === 0, "🔴 §5/CONTROL: …and writes NO `reply.forced` row — a force on a clean room overrode nothing");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);
  await roomSaid(Date.now());
  const seed = await inTurn(() => callReply(w, "turn_6a", w, "The first message.", { done: false }));
  ok(typeof seed.id === "string", "§6 precondition: the fold target posted");
  ok(!(await store.getUnifiedWakeRecord(ORG, w))?.answeredAt, "§6 precondition: a `done: false` post leaves the wake UNANSWERED, which is what the assertion below measures against");

  const text = "The message the policy refuses.";
  const refused = await inTurn(() => callReply(w, "turn_6b", w, text));
  ok(refused.id === undefined, "§6: the post is refused");
  const answeredAfterRefusal = await store.getUnifiedWakeRecord(ORG, w);
  ok(!answeredAfterRefusal?.answeredAt, "🔴 §6/WAKE: the refusal did NOT mark the wake answered — the turn still owes this conversation an answer");

  const before = posted.length;
  const forced = await inTurn(() => callReply(w, "turn_6c", w, text, { force: true }));
  ok(forced.id !== undefined && forced.id !== REPLY_DEDUPE_SKIPPED_ID, "🔴 §6/DEDUPE: the SAME text posts with a real platform id — the refusal never claimed the post-once key");
  ok(posted.length === before + 1, "§6/ROOM: and it genuinely reached the room, rather than being suppressed as a duplicate");
}

{
  ok(platformCanEdit("slack") === true, "§7: the registry says slack can edit (its arm carries `editMessage`)");
  ok(platformCanEdit("no-such-surface") === false, "§7: an unregistered platform cannot edit");
  ok(platformCanEdit("another-unregistered-surface") === false, "§7: …and neither can a second one — the predicate is the registry lookup, not a hardcoded list");

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
  ok((await replyFoldTarget({ store, window: null, platform: "slack", locus: LOCUS })) === null, "§10: NO TAIL WINDOW (a worker, a task session, a native seat) ⇒ no fold");
  ok((await replyFoldTarget({ store, window: TAIL_WINDOW, platform: "slack", locus: null })) === null, "§10: NO EDITABLE ADDRESS for this surface ⇒ no fold");
  ok(
    foldTargetInTail([entry({ kind: "post", at: new Date(now).toISOString(), id: "m1" })], { container: undefined, platform: "slack", canEdit: () => true, nowMs: now }) === null,
    "§10: NO CONTAINER ⇒ the rooms cannot be told apart ⇒ no fold",
  );
  ok(foldTargetInTail([], { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now }) === null, "§10: an EMPTY ring ⇒ no fold");
  const brokenStore = { readSessionTail: async (): Promise<SessionTailEntry[]> => { throw new Error("store down"); } };
  ok(
    (await replyFoldTarget({ store: brokenStore, window: TAIL_WINDOW, platform: "slack", locus: LOCUS })) === null,
    "🔴 §10: an UNREADABLE store ⇒ no fold, and the reply posts",
  );
  const tied = [entry({ kind: "post", at: new Date(now).toISOString(), id: "m1" }), entry({ kind: "wake", at: new Date(now).toISOString() })];
  ok(foldTargetInTail(tied, { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now }) === null, "§10: a same-millisecond TIE reads as 'the room spoke' ⇒ no fold");
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const w = await wakeFor(CHAN);
  await roomSaid(Date.now());
  const first = await inTurn(() => callReply(w, "turn_11a", w, "The message that will be folded into.", { done: false }));
  ok(typeof first.id === "string", "§11: the first reply posted");

  const acted = await inTurn(async () => {
    const refused = await callReply(w, "turn_11b", w, "The part that should fold in.");
    ok(refused.id === undefined, "§11: the second post is refused, as §2 proves");
    const e = await callEdit(w, "turn_11b", w, first.id as string, "The whole message, both parts.");
    ok(e.edited === true, "§11: the model folds via `edit_reply`, and the platform confirms");
    return repliedWakesThisTurn("turn_11b");
  });
  ok(acted.includes(w), "🔴 §11: the folded wake is in the turn's ACTED-ON set — a compliance is not a dropped wake");

  const control = await inTurn(async () => repliedWakesThisTurn("turn_11_never_ran"));
  ok(!control.includes(w), "§11/CONTROL: a turn that did nothing holds an EMPTY acted-on set — the mark is not ambient");
}

{
  const target = { messageId: "ts-9", platform: "slack" };
  const unified = foldIntoEditRefusalMessage(target, true);
  const perSurface = foldIntoEditRefusalMessage(target, false);
  ok(unified.includes("force: true"), "§12: the unified copy names the `force` valve it actually has");
  ok(!perSurface.includes("force"), "🔴 §12: the per-surface copy does NOT — that variant takes no `force` input, and naming one would teach a call that fails");
  ok(perSurface.includes("send this same call again"), "§12: …it names the valve it does have");
  for (const [name, copy] of [
    ["unified", unified],
    ["per-surface", perSurface],
  ] as const) {
    ok(copy.includes("DISCOURAGED, not blocked"), `🔴 §12/${name}: the valve is named as DISCOURAGED, never as a plain instruction`);
    ok(copy.includes("reads as noise"), `🔴 §12/${name}: …and the copy says WHY — the room already holds the answer`);
    ok(copy.includes("costs the room a near-duplicate"), `🔴 §12/${name}: …and what a second post COSTS`);
    ok(!copy.includes("anyway"), `🔴 §12/${name}: the pre-ruling invitation wording ("…to post it as a new message anyway") is GONE`);
  }
  ok(unified.includes("the override is recorded"), "🔴 §12/unified: …and the force valve says its own extra cost — the override is written to the audit");
}

{
  const ringOnly: SessionTailEntry[] = [entry({ kind: "post", at: new Date().toISOString(), id: "never-in-the-ledger" })];
  const fakeStore = { readSessionTail: async (): Promise<SessionTailEntry[]> => ringOnly };
  ok(
    (await replyFoldTarget({ store: fakeStore, window: TAIL_WINDOW, platform: "slack", locus: LOCUS })) === null,
    "🔴 §13: a ring row with NO ledger row is NOT a fold target — the redirect must land somewhere `edit_reply` accepts",
  );
  ok(
    (await replyFoldTarget({ store: fakeStore, window: TAIL_WINDOW, platform: "slack", locus: LOCUS, ledgerDeps: { hasEventSeen: async () => true } }))
      ?.messageId === "never-in-the-ledger",
    "§13/CONTROL: with the ledger confirming, the SAME ring row IS the fold target — the ledger read is the only difference",
  );
}

{
  const unifiedAdapter = ((await import("../agent/channels/unified.js")).default as unknown as {
    adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
  }).adapter;
  ok(typeof unifiedAdapter["message.completed"] === "function", "🔴 §14 REACHABILITY: the unified channel really registers message.completed — the bridge lives inside it");

  const adapterCtx = { session: { continuation: { token: `unified:${TOKEN}` } } };
  const endTurnWithProse = (text: string): Promise<void> =>
    unifiedAdapter["message.completed"]!({ finishReason: "stop", message: text }, adapterCtx);

  function bridgeSession(turnWake: string, turnId: string): <T>(fn: () => Promise<T>) => Promise<T> {
    const c = new ContextContainer();
    c.set(SessionKey, {
      sessionId: "reply-fold-test",
      auth: {
        current: {
          attributes: {
            oe_platform: "slack",
            oe_grain: "standing",
            oe_addressing: "direct-mention",
            oe_wake_id: turnWake,
            oe_window_token: TOKEN,
            channel_id: CHAN,
            team_id: "T1",
          },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
      turn: { id: turnId, sequence: 1 },
      parent: undefined,
    });
    return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
  }

  const dropRows = async (wakeId: string): Promise<Record<string, unknown>[]> => rowsFor("turn.supervisor_prose_dropped", wakeId);
  const PROSE = "Part two, said out loud instead of folded.";

  {
    const w = await wakeFor(CHAN);
    const inTurn = bridgeSession(w, "turn_842a");
    await inTurn(async () => seedTailWindow(TAIL_WINDOW));
    await roomSaid(Date.now());
    const first = await inTurn(() => callReply(w, "turn_842_seed", w, "Part one of what I found."));
    ok(typeof first.id === "string", "§14a precondition: our own post is now the newest message in the room");

    const before = posted.length;
    await inTurn(async () => {
      const refused = await callReply(w, "turn_842a", w, PROSE);
      ok(refused.id === undefined && typeof refused.error === "string", "§14a precondition: the reply tool refuses the second post");
      ok(posted.length === before, "§14a precondition: the tool posted nothing, which is the state the bridge fires in");
      await endTurnWithProse(PROSE);
    });

    ok(posted.length === before, "🔴 §14a/ROOM: the bridge posted NOTHING — a host refusal is a decision, and the bridge must not overturn it");
    const rows = await dropRows(w);
    ok(rows.length === 1, "🔴 §14a/AUDIT: the withheld answer is RECORDED — a silent suppression would be indistinguishable from a turn that had nothing to say");
    ok(rows[0]!["reason"] === `refused:${REPLY_FOLD_REFUSAL_REASON}`, "🔴 §14a/AUDIT: …under the refusal that withheld it, not the generic `no-reply-call`");
    ok(rows[0]!["addressing"] === "direct-mention", "§14a/AUDIT: …and it still reads as an ADDRESSED turn, so an owed-but-withheld answer stays countable apart from an ambient drop");
    ok(rows[0]!["replied"] === false, "§14a/AUDIT: …on a turn whose reply tool posted nothing");
  }

  {
    const w = await wakeFor(CHAN);
    const inTurn = bridgeSession(w, "turn_842b");
    await inTurn(async () => seedTailWindow(TAIL_WINDOW));
    await roomSaid(Date.now());
    const before = posted.length;

    await inTurn(async () => endTurnWithProse("An ordinary answer, narrated instead of posted."));

    ok(posted.length === before + 1, "🔴 §14b/ROOM: with no refusal the bridge STILL POSTS — the fix suppresses a refused turn, it does not delete the bridge");
    ok(posted[posted.length - 1]!.text.includes("An ordinary answer"), "§14b/ROOM: …and what it posted is the model's own text");
    ok((await dropRows(w)).length === 0, "§14b/AUDIT: a delivered bridge writes no drop row");
  }

  {
    const w = await wakeFor(CHAN);
    const inTurn = bridgeSession(w, "turn_842c");
    await inTurn(async () => seedTailWindow(TAIL_WINDOW));
    await roomSaid(Date.now());
    const seed = await inTurn(() => callReply(w, "turn_842_seed2", w, "Part one again."));
    ok(typeof seed.id === "string", "§14c precondition: our own post is the newest message again");

    const before = posted.length;
    await inTurn(async () => {
      const refused = await callReply(w, "turn_842c", w, "Part two.");
      ok(refused.id === undefined, "§14c precondition: the first attempt draws the refusal");
      const forced = await callReply(w, "turn_842c", w, "Part two, sent anyway.", { force: true });
      ok(typeof forced.id === "string", "🔴 §14c: a turn that overrides the verdict still DELIVERS — the refusal record never blocks the reply path itself");
      await endTurnWithProse("And that is what I did.");
    });

    ok(posted.length === before + 1, "🔴 §14c/ROOM: exactly ONE message reached the room — the forced reply, and no bridged duplicate behind it");
    const rows = await dropRows(w);
    ok(rows.length === 1 && rows[0]!["reason"] === "narration-after-reply", "🔴 §14c/AUDIT: the trailing prose drops as ordinary narration — a turn that DID post is not reported as one the host withheld");
  }
}

{
  const now = Date.now();
  const at = new Date(now - 1_000).toISOString();
  const base = { container: SURFACE, platform: "slack", canEdit: () => true, nowMs: now } as const;
  const ringA: SessionTailEntry[] = [entry({ kind: "post", at, id: "mA", wake: "wk-A" })];

  ok(
    foldTargetInTail(ringA, { ...base, answeringWake: "wk-B" }) === null,
    "🔴 §15: a post that answered wake A is NOT a fold target for the answer to wake B",
  );
  const same = foldTargetInTail(ringA, { ...base, answeringWake: "wk-A" });
  ok(same !== null && same.messageId === "mA", "🔴 §15/CONTROL: the SAME ring answering the SAME wake still folds, onto that exact message");

  const burst: SessionTailEntry[] = [
    entry({ kind: "wake", at: new Date(now - 3_000).toISOString() }),
    entry({ kind: "wake", at: new Date(now - 2_500).toISOString() }),
    entry({ kind: "post", at, id: "mA", wake: "wk-A" }),
  ];
  ok(
    foldTargetInTail(burst, { ...base, answeringWake: "wk-B" }) === null,
    "🔴 §15/BURST: with two wakes pending, the answer to the second does NOT fold into the answer to the first",
  );
  ok(
    foldTargetInTail(burst, { ...base, answeringWake: "wk-A" })?.messageId === "mA",
    "§15/BURST/CONTROL: the SAME burst ring answering wake A still folds — the wake id is the only variable",
  );

  ok(
    foldTargetInTail([entry({ kind: "post", at, id: "mLegacy" })], { ...base, answeringWake: "wk-B" })?.messageId === "mLegacy",
    "🔴 §15/LEGACY: a ring row written before the wake was recorded still folds — a pre-change ring does not change behaviour",
  );
  ok(
    foldTargetInTail(ringA, { ...base, answeringWake: undefined })?.messageId === "mA",
    "🔴 §15/PER-SURFACE: a caller with NO wake (the per-surface `reply`) compares nothing and folds exactly as before",
  );
}

{
  const inTurn = newSession();
  await inTurn(async () => seedTailWindow(TAIL_WINDOW));
  const wA = await wakeFor(CHAN, 10_000);
  const wB = await wakeFor(CHAN, 20_000);
  await roomSaid(Date.now());

  const first = await inTurn(() => callReply(wA, "turn_16a", wA, "The answer to the first question."));
  ok(typeof first.id === "string", "§16 precondition: the answer to wake A is now the newest message in the room");

  const before = posted.length;
  const second = await inTurn(() => callReply(wB, "turn_16b", wB, "The answer to the SECOND question."));
  ok(typeof second.id === "string", "🔴 §16: the answer to wake B POSTS — it answers a different question, so it is not a continuation");
  ok(posted.length === before + 1, "§16/ROOM: and it really reached the room");
  ok((await rowsFor("reply.refused", wB)).length === 0, "🔴 §16/AUDIT: NO `should-be-edit` row — the verdict the model declined 9 of 9 times is no longer drawn");

  const third = await inTurn(() => callReply(wB, "turn_16c", wB, "More about the second question."));
  ok(third.id === undefined && typeof third.error === "string", "🔴 §16/CONTROL: a second post on wake B IS refused — the policy is alive on this exact ring");
  const refusals = await rowsFor("reply.refused", wB);
  ok(refusals.length === 1 && refusals[0]!["reason"] === REPLY_FOLD_REFUSAL_REASON, "§16/CONTROL/AUDIT: one `should-be-edit` row, and it names wake B");
  ok(String(third.error).includes(second.id as string), "🔴 §16/CONTROL/COPY: …and it steers at wake B's OWN post, not at wake A's");
}

console.log(`✓ reply-fold: ${passed} assertions passed`);
