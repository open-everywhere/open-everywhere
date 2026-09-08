
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

const dir = join(tmpdir(), `open-everywhere-reply-declined-teeth-test-${process.pid}`);
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
const { NO_REPLY_NOTE } = await import("../agent/tools/no_reply.js");
const { isNoReply, NO_REPLY_SENTINEL } = await import("../agent/channels/turn-delivery.js");
const { isWakeDeclinedThisTurn, WAKE_DECLINED_REFUSAL_REASON } = await import("../agent/channels/reply-signal.js");

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
      id: "reply-declined-teeth-test",
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
  c.set(SessionKey, { sessionId: "reply-declined-teeth-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callNoReply(turnWake: string, turnId: string): Promise<{ note?: string; error?: string }> {
  return noReplyTool
    .execute({ reason: "not_relevant" }, ctxFor(turnWake, turnId))
    .then((r) => ({ note: r.note }))
    .catch((e: unknown) => ({ error: String(e) }));
}

async function callReply(turnWake: string, turnId: string, wake: string, text: string): Promise<{ posted?: boolean; note?: string; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done: true }, ctx)
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

{
  const inTurn = newSession();
  const w = await wake("C_DECLINED");
  const before = posted.length;

  await inTurn(async () => {
    ok(isWakeDeclinedThisTurn("turn_100", w) === false, "§1/CONTROL: before `no_reply` runs, the wake is NOT recorded as declined");
  });

  const silence = await inTurn(() => callNoReply(w, "turn_100"));
  ok(silence.error === undefined, "§1: the real `no_reply` executes cleanly on a unified turn");
  await inTurn(async () => {
    ok(isWakeDeclinedThisTurn("turn_100", w) === true, "§1/WIRING: `no_reply`'s execute RECORDED the declined wake — the guard is reachable from the shipped tool, not only from its helper");
  });

  const overReply = await inTurn(() => callReply(w, "turn_100", w, "Noted — the sync is moving to 3:30."));
  ok(typeof overReply.error === "string", "§1: the reply on the DECLINED wake is REFUSED");
  ok(overReply.posted !== true, "§1: …and it reports no post");
  ok(overReply.error!.includes("already called `no_reply`"), "§1: refused with the decline steer, not some incidental error");
  ok(overReply.error!.includes("nothing was posted"), "§1: the copy tells the model its reply posted nothing, so it does not retry believing the post failed");
  ok(overReply.error!.includes(NO_REPLY_SENTINEL), "§1/INSTRUCTIVE: the copy names the ONE way out — end the turn — because the message the model just read told it to answer now");
  ok(posted.length === before, "§1/ROOM: NOTHING reached the room. This is the assertion OPE-748 exists for");

  const refused = await refusedRows();
  const mine = refused.filter((d) => d["wakeId"] === w);
  ok(mine.length === 1, "§1/AUDIT: the refusal is a ROW, not an absence");
  ok(mine[0]["reason"] === WAKE_DECLINED_REFUSAL_REASON, "§1/AUDIT: under its own reason, so a nudge-driven over-reply is countable apart from every other refusal shape");
  ok(mine[0]["route"] === "tool", "§1/AUDIT: route stamped, matching the reply.post join shape");
  ok(!JSON.stringify(mine[0]).includes("3:30"), "§1/AUDIT: the attempted TEXT never reaches the audit detail");
}

{
  const inTurn = newSession();
  const ambient = await wake("C_AMBIENT");
  const addressed = await wake("C_ADDRESSED");
  const before = posted.length;

  await inTurn(() => callNoReply(ambient, "turn_200"));
  const answer = await inTurn(() => callReply(ambient, "turn_200", addressed, "17 plus 25 is 42."));
  ok(answer.posted === true, "§2: the ADDRESSED wake still posts after the ambient one was declined — a coalesced turn keeps working");
  ok(posted.length === before + 1, "§2/ROOM: the answer reached the room");
  ok(posted[posted.length - 1].text.includes("42"), "§2/ROOM: and it is the answer, not some other message");
}

{
  const inSession = newSession();
  const w = await wake("C_CROSS");
  const before = posted.length;

  await inSession(() => callNoReply(w, "turn_300"));
  const refusedSameTurn = await inSession(() => callReply(w, "turn_300", w, "Same turn, should be refused."));
  ok(typeof refusedSameTurn.error === "string", "§3: the same turn is still refused");

  const nextTurn = await inSession(() => callReply(w, "turn_301", w, "A later turn answers properly."));
  ok(nextTurn.posted === true, "§3: a NEW turn on the SAME wake POSTS — a slot that bled would silence the redrive path forever");
  ok(posted.length === before + 1, "§3/ROOM: exactly the later turn's message");
}

{
  const w = await wake("C_FAILOPEN");
  const before = posted.length;

  await callNoReply(w, "turn_400");
  const out = await callReply(w, "turn_400", w, "Posted because the guard could not read its slot.");
  ok(out.posted === true, "§4: with no eve context the guard is OFF and the reply POSTS — never a lost answer");
  ok(posted.length === before + 1, "§4/ROOM: the message reached the room");
  ok(isWakeDeclinedThisTurn("turn_400", w) === false, "§4: and the reader answers false rather than throwing");
}

{
  ok(NO_REPLY_NOTE.includes(NO_REPLY_SENTINEL), "§5: `no_reply`'s success note NAMES the terminal output, which is what stops eve's empty step");
  ok(/end the turn/i.test(NO_REPLY_NOTE), "§5: …as an instruction to END the turn, not as an aside");
  ok(isNoReply(NO_REPLY_SENTINEL), "§5: and the channel SWALLOWS that sentinel — an instruction to emit text the channel would POST is worse than no instruction");
  ok(!isNoReply("Noted — the sync is moving to 3:30."), "§5/CONTROL: an ordinary reply is NOT swallowed, so the sentinel check is doing real work");
}

console.log(`✓ reply declined-wake teeth: ${passed} assertions passed`);
