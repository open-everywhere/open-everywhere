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

const dir = join(tmpdir(), `open-everywhere-terminal-failure-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

const posted: { channel: string; text: string }[] = [];
const reacted: { channel: string; name: string }[] = [];

type Outcome = "ok" | "definitive" | "ambiguous";
let postOutcome: Outcome = "ok";
let reactOutcome: Outcome = "ok";

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm, registerSlackFixtureManifest } =
  await import("./_slack-test-stubs.js");

registerSlackTestBridge({
  channel: { __fixture: "slack" } as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") {
      if (postOutcome === "ambiguous") throw new Error("the connection dropped before Slack answered");
      if (postOutcome === "definitive") return { ok: false, error: "channel_not_found" } as never;
      posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
      return { ok: true, ts: `ts-${posted.length}` } as never;
    }
    return { ok: true } as never;
  },
  readCall: (async (method: string, args: Record<string, unknown>) => {
    if (method !== "reactions.add") return { ok: true };
    if (reactOutcome === "ambiguous") throw new Error("the connection dropped before Slack answered");
    if (reactOutcome === "definitive") throw new Error("slack error: message_not_found");
    reacted.push({ channel: String(args["channel"] ?? ""), name: String(args["name"] ?? "") });
    return { ok: true };
  }) as never,
});
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();
registerSlackFixtureManifest();

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { consumeRepliedThisTurn, isWakeDoneThisTurn } = await import("../agent/channels/reply-signal.js");
const { consumeReactedThisTurn } = await import("../agent/channels/react-signal.js");
const { peekNoReplyThisTurn } = await import("../agent/channels/no-reply-signal.js");
const { turnHasTerminalAction, TURN_TERMINAL_TOOLS } = await import("../agent/channels/turn-terminal-actions.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type UnifiedWakeOrigin = import("../agent/channels/unified-window.js").UnifiedWakeOrigin;

const ORG = "acme";
const DOMAIN = "payments";
const CHAN = "C1";
const SURFACE = `slack/T1/${CHAN}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);

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
const reactTool = (await import("../agent/tools/react.js")).default;
const noReplyTool = (await import("../agent/tools/no_reply.js")).default;

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
      id: "terminal-failure-test",
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

function slackCtx(turnId: string) {
  return {
    channel: { kind: "slack" },
    session: {
      id: "terminal-failure-test",
      turn: { id: turnId },
      auth: {
        current: {
          attributes: { team_id: "T1", channel_id: CHAN, thread_ts: "111.222", channel_type: "channel" },
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
  c.set(SessionKey, { sessionId: "terminal-failure-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(wake: string, turnId: string, text: string): Promise<{ id?: string; error?: string }> {
  const ctx = ctxFor(wake, turnId);
  const armed = armOf(replyTool, ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake, done: true, force: false }, ctx)
    .then((r) => r as { id?: string })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function callReact(turnId: string): Promise<{ reacted?: boolean; error?: string }> {
  const ctx = slackCtx(turnId);
  const armed = armOf(reactTool, ctx);
  if (!armed) return { error: "react did not arm" };
  return armed
    .execute({ emoji: "eyes" }, ctx)
    .then((r) => r as { reacted?: boolean })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function wakeNow(): Promise<string> {
  const id = mintWakeId();
  const origin: UnifiedWakeOrigin = { platform: "slack", channelId: CHAN };
  await registerUnifiedWakeTarget(store, ORG, id, origin, new Date(Date.now() - 1000).toISOString(), TOKEN, true);
  return id;
}

{
  const inTurn = newSession();
  const w = await wakeNow();
  postOutcome = "ok";
  const roomBefore = posted.length;
  const r = await inTurn(() => callReply(w, "turn_1a", "the answer"));
  ok(typeof r.id === "string", "§1a: the reply posts");
  ok(posted.length === roomBefore + 1, "§1a/ROOM: the room got it");
  ok(await inTurn(async () => isWakeDoneThisTurn("turn_1a", w)), "§1a/MARK: the wake budget is SPENT — a confirmed answer closes it");
  ok(await inTurn(async () => consumeRepliedThisTurn("turn_1a")), "§1a/MARK: the bare-stop signal says this turn replied");
}
{
  const inTurn = newSession();
  const w = await wakeNow();
  postOutcome = "definitive";
  const roomBefore = posted.length;
  const r = await inTurn(() => callReply(w, "turn_1b", "the answer"));
  postOutcome = "ok";
  ok(typeof r.error === "string", "§1b: a refused post reaches the model as an error");
  ok(posted.length === roomBefore, "§1b/ROOM: nothing reached the room");
  ok(!(await inTurn(async () => isWakeDoneThisTurn("turn_1b", w))), "§1b/MARK: the wake budget stays OPEN — a failed post must never spend the answer");
  ok(!(await inTurn(async () => consumeRepliedThisTurn("turn_1b"))), "§1b/MARK: and the turn is not recorded as having replied");
  const retry = await inTurn(() => callReply(w, "turn_1b", "the answer, second attempt"));
  ok(typeof retry.id === "string", "§1b/REMEDY: the retry POSTS — the open budget is what makes a fresh answer legitimate");
  ok(posted.length === roomBefore + 1, "§1b/ROOM: and the room finally got the answer");
}
{
  const inTurn = newSession();
  const w = await wakeNow();
  postOutcome = "ambiguous";
  const roomBefore = posted.length;
  const r = await inTurn(() => callReply(w, "turn_1c", "the answer"));
  postOutcome = "ok";
  ok(typeof r.error === "string", "§1c: an unconfirmed post reaches the model as an error");
  ok(posted.length === roomBefore, "§1c/ROOM: this fixture accepted nothing");
  ok(!(await inTurn(async () => isWakeDoneThisTurn("turn_1c", w))), "§1c/MARK: the wake budget stays OPEN — `reply` fails OPEN, a duplicate beats a lost answer");
  ok(!(await inTurn(async () => consumeRepliedThisTurn("turn_1c"))), "§1c/MARK: and no bare-stop signal is recorded");
}

{
  const inTurn = newSession();
  reactOutcome = "ok";
  const before = reacted.length;
  const r = await inTurn(() => callReact("turn_2a"));
  ok((r as { reacted?: boolean }).reacted === true, "§2a: the reaction lands");
  ok(reacted.length === before + 1, "§2a/ROOM: Slack got it");
  ok(await inTurn(async () => consumeReactedThisTurn()), "§2a/MARK: the react signal is set");
}
for (const outcome of ["definitive", "ambiguous"] as const) {
  const inTurn = newSession();
  reactOutcome = outcome;
  const before = reacted.length;
  const r = await inTurn(() => callReact(`turn_2_${outcome}`));
  reactOutcome = "ok";
  ok(typeof r.error === "string", `§2/${outcome}: a failed reaction reaches the model as an error, so it can fall back to a text reply`);
  ok(reacted.length === before, `§2/${outcome}/ROOM: no reaction reached Slack`);
  ok(!(await inTurn(async () => consumeReactedThisTurn())), `§2/${outcome}/MARK: NO react signal — an unconfirmed reaction is not this turn's answer`);
}

{
  const inTurn = newSession();
  const roomBefore = posted.length;
  const reactedBefore = reacted.length;
  const ctx = ctxFor(await wakeNow(), "turn_3");
  const armed = noReplyTool as unknown as Armed;
  ok(await inTurn(async () => peekNoReplyThisTurn() === null), "§3: a fresh turn holds no silence record — the negative control for the next line");
  const res = (await inTurn(async () => {
    const r = (await armed.execute({ reason: "nothing-to-add" }, ctx)) as { acknowledged?: boolean };
    ok(peekNoReplyThisTurn() !== null, "§3/MARK: the silence IS recorded — there is no platform that could refuse it");
    return r;
  })) as { acknowledged?: boolean };
  ok(res.acknowledged === true, "§3: the call is acknowledged");
  ok(posted.length === roomBefore && reacted.length === reactedBefore, "§3: it reached NO platform — there is nothing for a platform to confirm");
}

{
  const wake = { role: "user", content: "fix the typo in your last message" };
  const call = (name: string) => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: {} }] });
  const okResult = (name: string) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: name, output: { type: "json", value: { edited: true } } }] });
  const failed = (name: string) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: name, output: { type: "error-text", value: "the platform refused" } }] });

  ok(TURN_TERMINAL_TOOLS.has("edit_reply"), "§4: `edit_reply` is in the terminal set — a correction can be the whole turn (OPE-802)");
  for (const verb of ["reply", "no_reply", "react", "edit_reply"]) {
    ok(turnHasTerminalAction([wake, call(verb), okResult(verb)]), `§4: a CONFIRMED \`${verb}\` ends the turn — no reissue nudge`);
    ok(!turnHasTerminalAction([wake, call(verb), failed(verb)]), `§4: a FAILED \`${verb}\` does NOT — the nudge is what gets the answer into the room`);
  }
  ok(
    !turnHasTerminalAction([wake, call("edit_reply")]),
    "§4: the model's own tool-call part is the REQUEST, never the platform's answer — it cannot end a turn on its own",
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ terminal-action failure semantics: ${passed} assertions passed`);
