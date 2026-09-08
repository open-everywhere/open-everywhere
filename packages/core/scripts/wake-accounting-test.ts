
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

const dir = join(tmpdir(), `open-everywhere-wake-accounting-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId, WAKE_TARGET_TTL_MS } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const {
  addressingClassOf,
  unaccountedWakes,
  loadUnaccountedWakeCandidates,
  settleWakeAccounting,
  MAX_ACCOUNTING_WAKES,
} = await import("../agent/channels/wake-accounting.js");
const { repliedWakesThisTurn, declinedWakesThisTurn, markWakeRepliedThisTurn, markWakeDeclinedThisTurn } = await import(
  "../agent/channels/reply-signal.js"
);

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type PendingUnifiedWake = import("../agent/channels/unified-window.js").PendingUnifiedWake;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
let TOKEN = unifiedSupervisorToken(DOMAIN, 1);

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
const noReplyTool = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly execute: (input: { reason: string; explanation?: string }, ctx: unknown) => Promise<{ acknowledged: boolean; note: string }>;
};
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const arm = (ctx: unknown): Armed | null => (replyTool as unknown as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as Armed | null;

function ctxFor(turnWake: string, turnId: string): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: "wake-accounting-test",
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
  c.set(SessionKey, { sessionId: "wake-accounting-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(
  turnWake: string,
  turnId: string,
  wake: string,
  text: string,
  opts: { readonly done?: boolean } = {},
): Promise<{ posted?: boolean; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done: opts.done ?? true, force: false }, ctx)
    .then((r) => r as { posted?: boolean })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function callNoReply(turnWake: string, turnId: string): Promise<{ note?: string; error?: string }> {
  return noReplyTool
    .execute({ reason: "not_relevant" }, ctxFor(turnWake, turnId))
    .then((r) => ({ note: r.note }))
    .catch((e: unknown) => ({ error: String(e) }));
}

async function wakeAt(channelId: string, atIso: string, opts: { readonly addressing?: "direct-mention" } = {}): Promise<string> {
  const id = mintWakeId();
  await registerUnifiedWakeTarget(store, ORG, id, { platform: "slack", channelId }, atIso, TOKEN, true, opts.addressing);
  return id;
}

const t = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

{
  ok(addressingClassOf(JSON.stringify({ platform: "slack", channelId: "C1", addressing: "direct-mention" })) === "addressed",
    "§1: a wake stamped `direct-mention` reads ADDRESSED");
  ok(addressingClassOf(JSON.stringify({ platform: "slack", channelId: "C1" })) === "ambient",
    "§1: a wake with no addressing stamp at all reads AMBIENT — the safe default");
  ok(addressingClassOf(JSON.stringify({ platform: "slack", channelId: "C1", addressing: "channel-watch" })) === "ambient",
    "§1: any addressing value OTHER than the one positive stamp reads AMBIENT, never a guessed third state");
  ok(addressingClassOf("{not json") === "ambient", "§1: malformed JSON reads AMBIENT rather than throwing");
}

{
  const rows: PendingUnifiedWake[] = [
    { wakeId: "w1", targetJson: JSON.stringify({ platform: "slack", channelId: "C1", addressing: "direct-mention" }), createdAt: t(-3000) },
    { wakeId: "w2", targetJson: JSON.stringify({ platform: "slack", channelId: "C1" }), createdAt: t(-2000) },
    { wakeId: "w3", targetJson: JSON.stringify({ platform: "slack", channelId: "C1" }), createdAt: t(-1000) },
  ];
  const out = unaccountedWakes(rows, new Set(["w2"]));
  ok(out.length === 2, "§2: the accounted wake is removed, the other two stay");
  ok(out.some((w) => w.wakeId === "w1" && w.addressing === "addressed"), "§2: w1 (unaccounted, direct-mention) is ADDRESSED");
  ok(out.some((w) => w.wakeId === "w3" && w.addressing === "ambient"), "§2: w3 (unaccounted, no stamp) is AMBIENT");
  ok(!out.some((w) => w.wakeId === "w2"), "§2/NEGATIVE CONTROL: the accounted wake w2 is genuinely absent, not merely unflagged");

  const fullyAccounted = unaccountedWakes(rows, new Set(["w1", "w2", "w3"]));
  ok(fullyAccounted.length === 0, "§2/NEGATIVE CONTROL: every row accounted ⇒ EMPTY diff");
}

{
  TOKEN = unifiedSupervisorToken(DOMAIN, 3);
  const older = await wakeAt("C_ANCHOR", t(-10000));
  const turnWake = await wakeAt("C_ANCHOR", t(-5000));
  const newer = await wakeAt("C_ANCHOR", t(-1000));

  const candidates = await loadUnaccountedWakeCandidates(store, ORG, TOKEN, turnWake);
  const ids = candidates.map((c) => c.wakeId);
  ok(ids.includes(older), "§3: a coalesced SIBLING registered before this turn's own wake is a candidate");
  ok(ids.includes(turnWake), "§3: this turn's OWN wake is itself a candidate until something accounts for it");
  ok(!ids.includes(newer), "§3: a wake registered AFTER this turn's own wake is excluded — it is not this turn's to answer");

  const ancientAnchor = await wakeAt("C_TTL", new Date(0).toISOString());
  const ancientCandidate = await wakeAt("C_TTL", new Date(1000).toISOString());
  const nowFarLater = WAKE_TARGET_TTL_MS * 2;
  const ttlCandidates = await loadUnaccountedWakeCandidates(store, ORG, TOKEN, ancientAnchor, nowFarLater);
  ok(!ttlCandidates.some((c) => c.wakeId === ancientCandidate), "§3/TTL: a row past the read-time TTL bound is excluded");

  const unknown = await loadUnaccountedWakeCandidates(store, ORG, TOKEN, "no-such-wake-id");
  ok(unknown.length === 0, "§3/FAIL-OPEN: an anchor wake this store never saw answers EMPTY, not an error");
}

{
  TOKEN = unifiedSupervisorToken(DOMAIN, 4);
  const inTurn = newSession();
  const turnId = "turn_400";
  const ignored = await wakeAt("C_TURN4", t(-3000), { addressing: "direct-mention" });
  const turnWake = await wakeAt("C_TURN4", t(-1000));

  await inTurn(async () => {
    const out = await callReply(turnWake, turnId, turnWake, "Working on it, more soon.", { done: false });
    ok(out.posted === true, "§4/CONTROL: the hand-off reply posts");

    const accounted = new Set<string>([...repliedWakesThisTurn(turnId), ...declinedWakesThisTurn(turnId)]);
    ok(accounted.has(turnWake), "§4: the turn's own wake is accounted for by §REPLIED, even with done:false");
    ok(!accounted.has(ignored), "§4/CONTROL: the ignored wake is NOT in the accounted set");

    const result = await settleWakeAccounting(store, ORG, { windowToken: TOKEN, turnWake }, accounted);
    ok(result.length === 1, "§4: exactly ONE wake is unaccounted — the one the turn never touched");
    ok(result[0]?.wakeId === ignored, "§4: …and it NAMES the ignored wake, not any other id");
    ok(result[0]?.addressing === "addressed", "§4: …carrying its addressing class — this wake was `direct-mention`");
  });
}

{
  TOKEN = unifiedSupervisorToken(DOMAIN, 5);
  const inTurn = newSession();
  const turnId = "turn_500";
  const answered = await wakeAt("C_TURN5A", t(-3000));
  const turnWake = await wakeAt("C_TURN5B", t(-1000));

  await inTurn(async () => {
    const out1 = await callReply(answered, turnId, answered, "Handled.", { done: true });
    ok(out1.posted === true, "§5/CONTROL: the first reply posts");
    const out2 = await callNoReply(turnWake, turnId);
    ok(out2.error === undefined, "§5/CONTROL: no_reply on the turn's own wake succeeds");

    const accounted = new Set<string>([...repliedWakesThisTurn(turnId), ...declinedWakesThisTurn(turnId)]);
    const result = await settleWakeAccounting(store, ORG, { windowToken: TOKEN, turnWake }, accounted);
    ok(result.length === 0, "§5/NEGATIVE CONTROL: every shown wake accounted for ⇒ the row is EMPTY — nothing to audit");
  });
}

{
  const inTurn = newSession();
  const turnId = "turn_600";
  const w = await wakeAt("C_TURN6", t(-1000));
  const { isWakeDoneThisTurn } = await import("../agent/channels/reply-signal.js");

  await inTurn(async () => {
    await callReply(w, turnId, w, "Progress note.", { done: false });
    ok(isWakeDoneThisTurn(turnId, w) === false, "§6/CONTROL: a done:false reply does NOT enter §DONE — that is §DONE's own contract");
    ok(repliedWakesThisTurn(turnId).includes(w), "§6: …but it DOES enter §REPLIED, which is the set the accounting audit reads");
  });
}

{
  const inTurn = newSession();
  const turnId = "turn_700";
  await inTurn(async () => {
    markWakeRepliedThisTurn(turnId, "w-replied");
    markWakeDeclinedThisTurn(turnId, "w-declined");
    const first = [...repliedWakesThisTurn(turnId), ...declinedWakesThisTurn(turnId)];
    const second = [...repliedWakesThisTurn(turnId), ...declinedWakesThisTurn(turnId)];
    ok(first.length === 2 && second.length === 2, "§7: reading both sets TWICE returns the same size both times — no read-and-reset");
    ok(JSON.stringify(first) === JSON.stringify(second), "§7: …and the exact same contents, byte for byte");
  });
  markWakeRepliedThisTurn(undefined, "w-orphan");
  ok(repliedWakesThisTurn(undefined).length === 0, "§7/FAIL-SOFT: no turn id ⇒ no-op, never a guess");
}

{
  ok(MAX_ACCOUNTING_WAKES > 0 && MAX_ACCOUNTING_WAKES < 1000, "§8: the cap is a real, sane bound (sanity check on the constant itself)");
}

{
  TOKEN = unifiedSupervisorToken(DOMAIN, 9);
  const ignored = await wakeAt("C_TURN9", t(-9000));
  const turnWakeA = await wakeAt("C_TURN9", t(-8000));

  const first = await settleWakeAccounting(store, ORG, { windowToken: TOKEN, turnWake: turnWakeA }, new Set([turnWakeA]));
  ok(first.some((w) => w.wakeId === ignored), "§9: turn A reports the wake nothing answered");

  const turnWakeB = await wakeAt("C_TURN9", t(-2000));
  const second = await settleWakeAccounting(store, ORG, { windowToken: TOKEN, turnWake: turnWakeB }, new Set([turnWakeB]));
  ok(!second.some((w) => w.wakeId === ignored), "🔴 §9: turn B does NOT re-report it — a wake is reported unaccounted AT MOST ONCE");
  ok(second.length === 0, "§9: …and turn B's row is empty outright, so no aggregate over these rows counts the same wake twice");

  const stillPending = await store.listPendingUnifiedWakes(ORG, TOKEN, EPOCH_ISO, 50);
  ok(stillPending.some((r) => r.wakeId === ignored), "🔴 §9: the audited wake is STILL PENDING — the horizon never retires a row from the freshness gate's population");
  ok((await store.getUnifiedWakeRecord(ORG, ignored))?.auditedAt !== undefined, "§9: …and the row carries its `auditedAt` stamp, which is what the next turn skips on");
}

{
  TOKEN = unifiedSupervisorToken(DOMAIN, 10);
  const inTurnA = newSession();
  const turnWakeA = await wakeAt("C_TURN10", t(-6000), { addressing: "direct-mention" });

  await inTurnA(async () => {
    const out = await callNoReply(turnWakeA, "turn_1000");
    ok(out.error === undefined, "§10/CONTROL: no_reply on the turn's own addressed wake succeeds");
    const accounted = new Set<string>([...repliedWakesThisTurn("turn_1000"), ...declinedWakesThisTurn("turn_1000")]);
    ok(accounted.has(turnWakeA), "§10/CONTROL: …and the wake is in turn A's accounted set");
    const result = await settleWakeAccounting(store, ORG, { windowToken: TOKEN, turnWake: turnWakeA }, accounted);
    ok(result.length === 0, "§10/CONTROL: turn A itself reports nothing — it accounted for every wake it was shown");
  });

  const recordA = await store.getUnifiedWakeRecord(ORG, turnWakeA);
  ok(recordA?.answeredAt === undefined, "§10/PREMISE: `no_reply` leaves the wake UNANSWERED in the store — this is why the next turn could see it");

  const inTurnB = newSession();
  const turnWakeB = await wakeAt("C_TURN10", t(-1000));
  await inTurnB(async () => {
    const accounted = new Set<string>([...repliedWakesThisTurn("turn_1001"), ...declinedWakesThisTurn("turn_1001")]);
    const result = await settleWakeAccounting(store, ORG, { windowToken: TOKEN, turnWake: turnWakeB }, accounted);
    ok(!result.some((w) => w.wakeId === turnWakeA), "🔴 §10: turn B never re-reports turn A's own answered wake");
    ok(result.some((w) => w.wakeId === turnWakeB), "§10/POSITIVE CONTROL: turn B DOES report its OWN ignored wake — the diff is live, not silenced wholesale");
  });
}

{
  TOKEN = unifiedSupervisorToken(DOMAIN, 11);
  const w = await wakeAt("C_TURN11", t(-4000));
  const other = await wakeAt("C_TURN11", t(-3000));
  const stampOf = async (id: string): Promise<string | undefined> => (await store.getUnifiedWakeRecord(ORG, id))?.auditedAt;
  const unauditedIds = async (): Promise<string[]> => (await store.listUnauditedUnifiedWakes(ORG, TOKEN, 50)).map((r) => r.wakeId);

  ok((await stampOf(w)) === undefined, "§11: a freshly registered wake carries NO audited stamp");
  ok((await unauditedIds()).includes(w), "§11/CONTROL: …so it IS in the accounting listing");

  await store.markUnifiedWakesAudited(ORG, [w], "2026-08-19T10:00:00.000Z");
  ok((await stampOf(w)) === "2026-08-19T10:00:00.000Z", "§11: the mark stamps the row");
  ok(!(await unauditedIds()).includes(w), "🔴 §11: the audited row LEAVES the accounting listing — the cap now bounds only wakes still to consider");
  ok((await unauditedIds()).includes(other), "§11/NEGATIVE CONTROL: an unaudited sibling on the same window stays in the listing — the mark is per row, not per window");

  await store.markUnifiedWakesAudited(ORG, [w], "2026-08-19T11:00:00.000Z");
  ok((await stampOf(w)) === "2026-08-19T10:00:00.000Z", "§11: FIRST STAMP WINS — a re-run cannot move the horizon");

  await store.markUnifiedWakesAudited(ORG, ["no-such-wake-id"], "2026-01-16T13:12:00.000Z");
  ok((await store.getUnifiedWakeRecord(ORG, "no-such-wake-id")) === null, "§11: marking an ABSENT wake inserts nothing (UPDATE-only)");
  await store.markUnifiedWakesAudited(ORG, [], "2026-01-16T13:12:00.000Z");
  ok((await stampOf(other)) === undefined, "§11: an EMPTY batch writes nothing");

  await store.markUnifiedWakesAudited("globex", [other], "2026-08-19T13:00:00.000Z");
  ok((await stampOf(other)) === undefined, "🔴 §11: the mark is org-partitioned — another org cannot stamp this row");

  await registerUnifiedWakeTarget(store, ORG, w, { platform: "slack", channelId: "C_TURN11" }, t(-4000), TOKEN, true);
  ok((await stampOf(w)) === "2026-08-19T10:00:00.000Z", "🔴 §11: re-registering the SAME wake id (redrive/retry) does NOT clear its horizon stamp");

  const pendingIds = (await store.listPendingUnifiedWakes(ORG, TOKEN, EPOCH_ISO, 50)).map((r) => r.wakeId);
  ok(pendingIds.includes(w) && pendingIds.includes(other), "🔴 §11: listPendingUnifiedWakes returns the audited row too — the two listings are separate on purpose");
}

console.log(`✓ wake-accounting: ${passed} assertions passed`);
