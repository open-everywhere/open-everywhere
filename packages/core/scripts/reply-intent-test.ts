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

const dir = join(tmpdir(), `open-everywhere-reply-intent-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerUnifiedWakeTarget, mintWakeId } = await import("../agent/channels/unified-window.js");
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { registerWakeOriginCodec } = await import("../agent/channels/wake-origin-codec.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type PostIntent = import("../agent/channels/post-arms.js").PostIntent;
type UnifiedWakeOrigin = import("../agent/channels/unified-window.js").UnifiedWakeOrigin;

const ORG = "acme";
const DOMAIN = "tickets";
const ISSUE = "issue-1";
const SURFACE = `linear/TEAM1/${ISSUE}`;
const TOKEN = unifiedSupervisorToken(DOMAIN, 1);
const SESSION = "agent-session-1";

const dispatched: { text: string; intent: PostIntent | undefined }[] = [];
const closed: string[] = [];

registerWakeOriginCodec("linear", {
  validate: (o) => typeof o.issueId === "string" && o.issueId.length > 0,
  threadRef: (origin) => ({ channelKey: `linear/${origin.issueId}`, threadKey: origin.issueId }),
  isThreadScoped: () => true,
  containerId: (origin) => origin.issueId,
});

registerPostArm({
  platform: "linear",
  dispatchUnified: async (_origin, text, _deps, _replier, intent) => {
    dispatched.push({ text, intent });
    return `activity-${dispatched.length}`;
  },
  closeUnifiedSilently: async (origin) => {
    closed.push((origin as { agentSessionId?: string }).agentSessionId ?? "none");
  },
});

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: DOMAIN, reach: [SURFACE], ambientSupervisor: true, mode: "unified" })],
  loadSilos: () => [],
  domainsForSurface: () => [DOMAIN],
});

const store = getOperationalStore();

const replyTool = (await import("../agent/tools/reply.js")).default;
interface Armed {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const arm = (ctx: unknown): Armed | null =>
  (replyTool as unknown as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as Armed | null;

const unifiedChannel = (await import("../agent/channels/unified.js")).default as unknown as {
  adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
};

function ctxFor(turnWake: string, turnId: string): BindableContext {
  return {
    channel: { kind: "channel:unified", continuationToken: `unified:${TOKEN}` },
    session: {
      id: "reply-intent-test",
      turn: { id: turnId },
      auth: {
        current: {
          attributes: { oe_platform: "linear", oe_wake_id: turnWake, oe_window_token: TOKEN, issue_id: ISSUE },
          principalId: "U1",
          principalType: "linear-user",
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
function newSession(turnWake: string, turnId: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, {
    sessionId: "reply-intent-test",
    auth: { current: { attributes: { oe_platform: "linear", oe_wake_id: turnWake, oe_window_token: TOKEN, issue_id: ISSUE } }, initiator: null },
    turn: { id: turnId },
    parent: undefined,
  });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function callReply(turnWake: string, turnId: string, text: string, done: boolean): Promise<{ posted?: boolean; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake: turnWake, done }, ctx)
    .then((r) => r as { posted?: boolean })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function callReplyForced(turnWake: string, turnId: string, text: string, done: boolean): Promise<{ posted?: boolean; error?: string }> {
  const ctx = ctxFor(turnWake, turnId);
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text, wake: turnWake, done, force: true }, ctx)
    .then((r) => r as { posted?: boolean })
    .catch((e: unknown) => ({ error: String(e) }));
}

async function completeSilently(): Promise<void> {
  await unifiedChannel.adapter["message.completed"]!(
    { finishReason: "stop", message: "NO_REPLY" },
    { session: { continuation: { token: `unified:${TOKEN}` } }, state: {} },
  );
}

async function mentionWake(): Promise<string> {
  const id = mintWakeId();
  const origin = { platform: "linear", issueId: ISSUE, agentSessionId: SESSION } as unknown as UnifiedWakeOrigin;
  await registerUnifiedWakeTarget(store, ORG, id, origin, new Date().toISOString(), TOKEN);
  return id;
}

async function ambientWake(): Promise<string> {
  const id = mintWakeId();
  const origin = { platform: "linear", issueId: ISSUE, ambient: true } as unknown as UnifiedWakeOrigin;
  await registerUnifiedWakeTarget(store, ORG, id, origin, new Date().toISOString(), TOKEN);
  return id;
}

{
  const w = await mentionWake();
  const inTurn = newSession(w, "turn_1");

  const handoff = await inTurn(() => callReply(w, "turn_1", "Checking the issue — the answer follows.", false));
  ok(handoff.posted === true, "§1: the `done:false` hand-off POSTS (the fix must never cost the hand-off)");
  ok(dispatched.length === 1, "§1: exactly one dispatch reached the arm");
  ok(
    dispatched[0]!.intent?.terminal === false,
    `§1/THE FIX: a \`done:false\` reply reaches the post arm as NON-TERMINAL — got ${JSON.stringify(dispatched[0]!.intent)}`,
  );

  const answer = await inTurn(() => callReply(w, "turn_1", "Here is the grounded answer.", true));
  ok(answer.posted === true, "§1: the later `done:true` answer POSTS on the same wake in the same turn");
  ok(dispatched.length === 2, "§1: the answer reached the arm as a second dispatch");
  ok(
    dispatched[1]!.intent?.terminal === true,
    `§1/NEGATIVE CONTROL: a \`done:true\` reply reaches the arm as TERMINAL — got ${JSON.stringify(dispatched[1]!.intent)}`,
  );
}

{
  const wq = await mentionWake();
  const quiet = newSession(wq, "turn_quiet");
  await quiet(() => completeSilently());
  ok(closed.length === 1, `§2/NEGATIVE CONTROL: a turn that posted NOTHING still closes the open session — got ${closed.length} close(s)`);
  ok(closed[0] === SESSION, "§2/NEGATIVE CONTROL: it closed THIS wake's own agent session");

  const ws = await mentionWake();
  const spoke = newSession(ws, "turn_spoke");
  const handoff = await spoke(() => callReply(ws, "turn_spoke", "Checking — the answer follows.", false));
  ok(handoff.posted === true, "§2: the hand-off posted, so this turn genuinely spoke");
  await spoke(() => completeSilently());
  ok(
    closed.length === 1,
    `§2/THE FIX: a turn that ANSWERED THIS WAKE does not close its session — expected the count to stay at 1, got ${closed.length}`,
  );

  const wSibling = await mentionWake();
  const wTurn = await mentionWake();
  const coalesced = newSession(wTurn, "turn_coalesced");
  const sibling = await coalesced(() => callReply(wSibling, "turn_coalesced", "Answering the other conversation.", true));
  ok(sibling.posted === true, "§2/DISCRIMINATOR precondition: the turn answered the SIBLING wake");
  await coalesced(() => completeSilently());
  ok(
    closed.length === 2 && closed[1] === SESSION,
    `§2/DISCRIMINATOR: the wake this turn did NOT answer still gets its session closed — expected 2 closes, got ${closed.length}`,
  );
}

{
  const w = await mentionWake();
  const inTurn = newSession(w, "turn_wall");
  const before = dispatched.length;

  const first = await inTurn(() => callReply(w, "turn_wall", "The grounded answer.", true));
  ok(first.posted === true, "§3: the first `done:true` answer posts — the wall must never cost the real answer");
  ok(dispatched.length === before + 1, "§3: one dispatch reached the arm");

  const second = await inTurn(() => callReply(w, "turn_wall", "The grounded answer, with one more line.", true));
  ok(typeof second.error === "string", "§3/WALL: the second `done:true` call on the same wake is REFUSED");
  ok(second.error!.includes("you already replied to wake-id"), "§3/WALL: …with the `answered` copy, not some incidental error");
  ok(
    !second.error!.includes("DISCOURAGED"),
    "§3/WALL: …and WITHOUT the valve sentence. The copy must not tell the model a re-send posts when this session is already closed",
  );

  const third = await inTurn(() => callReply(w, "turn_wall", "The grounded answer, sent again.", true));
  ok(typeof third.error === "string", "§3/WALL: RE-SENDING is refused again — a wall refuses every time, where the valve stands aside after one");

  const forced = await inTurn(() => callReplyForced(w, "turn_wall", "The grounded answer, forced.", true));
  ok(typeof forced.error === "string", "§3/WALL: and `force: true` does NOT open it — the flag overrides a matter of style, never an impossibility");

  ok(
    dispatched.length === before + 1,
    `§3/ROOM: still exactly ONE dispatch reached the arm across all four calls — expected ${before + 1}, got ${dispatched.length}`,
  );

  const wOpen = await mentionWake();
  const openTurn = newSession(wOpen, "turn_open");
  const partA = await openTurn(() => callReply(wOpen, "turn_open", "Checking — part one.", false));
  const partB = await openTurn(() => callReply(wOpen, "turn_open", "Checking — part two.", false));
  ok(
    partA.posted === true && partB.posted === true,
    "§3/CONTROL: two `done:false` parts both post on a mention wake — the wall arms on the answered mark, never on the surface",
  );

  const wAmb = await ambientWake();
  const ambTurn = newSession(wAmb, "turn_ambient");
  const beforeAmb = dispatched.length;

  const amb1 = await ambTurn(() => callReply(wAmb, "turn_ambient", "The ambient answer.", true));
  ok(amb1.posted === true, "§3/DISCRIMINATOR: the first ambient `done:true` answer posts");

  const amb2 = await ambTurn(() => callReply(wAmb, "turn_ambient", "The ambient answer, with one more line.", true));
  ok(
    typeof amb2.error === "string" && amb2.error.includes("DISCOURAGED"),
    "§3/DISCRIMINATOR: the second draws the VALVE copy — on this route a duplicate is discouraged, not impossible",
  );

  const amb3 = await ambTurn(() => callReply(wAmb, "turn_ambient", "The ambient answer, sent again.", true));
  ok(amb3.posted === true, "§3/DISCRIMINATOR: and the re-send POSTS, where the same re-send on a mention wake is refused");
  ok(
    dispatched.length === beforeAmb + 2,
    `§3/DISCRIMINATOR/ROOM: two dispatches reached the arm on the ambient route — expected ${beforeAmb + 2}, got ${dispatched.length}`,
  );
}

console.log(`✓ reply-intent-test: ${passed} assertions passed`);
