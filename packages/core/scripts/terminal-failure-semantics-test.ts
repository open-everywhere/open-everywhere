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
const { markNotApplied } = await import("../agent/channels/platform-failure.js");

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
    if (reactOutcome === "definitive") throw markNotApplied(new Error("slack error: message_not_found"));
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
const { REPLY_DEDUPE_SKIPPED_ID } = await import("../agent/channels/reply-post.js");
const { platformFailureClass } = await import("../agent/channels/platform-failure.js");
const { readAudit } = await import("../agent/audit/audit.js");

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

{
  const wake = { role: "user", content: "do the task" };
  const call = (name: string) => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: {} }] });
  const okResult = (name: string) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: name, output: { type: "json", value: { posted: true } } }] });
  const repliedTurn = [wake, call("reply"), okResult("reply")];

  const grainCtx = (turnWake: string, turnId: string, worker: boolean): BindableContext => {
    const base = ctxFor(turnWake, turnId) as unknown as { session: Record<string, unknown> };
    if (worker) base.session["parent"] = { sessionId: "parent-session-1" };
    return base as unknown as BindableContext;
  };

  {
    const inTurn = newSession();
    const w = await wakeNow();
    postOutcome = "ok";
    const ctx = grainCtx(w, "turn_5a", false);
    await inTurn(async () => {
      const armed = armOf(replyTool, ctx);
      await armed!.execute({ text: "the answer", wake: w, done: true, force: false }, ctx);
      ok(turnHasTerminalAction(repliedTurn) === true, "§5a: on a SEAT a confirmed `reply` still suppresses the reissue — OPE-762 is intact");
    });
  }

  {
    const inTurn = newSession();
    const w = await wakeNow();
    const ctx = grainCtx(w, "turn_5b", true);
    await inTurn(async () => {
      ok(turnHasTerminalAction(repliedTurn) === true, "§5b: before the worker speaks, the scan behaves as it always did — the gate is armed by the CALL, not by the message array");
      await (noReplyTool as unknown as Armed).execute({ reason: "nothing-to-add" }, ctx);
      ok(turnHasTerminalAction(repliedTurn) === false, "§5b: after a WORKER calls a terminal verb, the reissue is NOT suppressed — its empty final step is a failure its caller is waiting on");
    });
  }

  {
    const inTurn = newSession();
    await inTurn(async () => {
      ok(turnHasTerminalAction(repliedTurn) === true, "§5c: a FRESH session is unaffected by the worker session before it — the record is session-scoped");
    });
  }

  {
    const inTurn = newSession();
    const ctx = slackCtx("turn_5d") as unknown as { session: Record<string, unknown> };
    ctx.session["parent"] = { sessionId: "parent-session-2" };
    reactOutcome = "ok";
    await inTurn(async () => {
      const armed = armOf(reactTool, ctx);
      await armed!.execute({ emoji: "eyes" }, ctx);
      ok(turnHasTerminalAction(repliedTurn) === false, "§5d: a worker's `react` arms the gate as well — every terminal verb a worker can call must");
    });
  }

  const { readFileSync } = await import("node:fs");
  for (const verb of ["reply", "react", "no_reply", "edit_reply"]) {
    const src = readFileSync(new URL(`../agent/tools/${verb}.ts`, import.meta.url), "utf8");
    ok(src.includes("noteTerminalCallGrain("), `§5e: tools/${verb}.ts records the calling grain — the gate is only as complete as its write sites`);
  }
}

{
  const inTurn = newSession();
  const w = await wakeNow();
  postOutcome = "ok";
  const roomBefore = posted.length;
  const first = await inTurn(() => callReply(w, "turn_6a", "one curated answer"));
  ok(typeof first.id === "string" && first.id !== REPLY_DEDUPE_SKIPPED_ID, "§6a: the post lands");
  const again = await inTurn(() => callReply(w, "turn_6a_retry", "one curated answer"));
  ok(again.id === REPLY_DEDUPE_SKIPPED_ID, "§6a: an identical repost after a SUCCESS is still suppressed — the claim is untouched on the happy path");
  ok(posted.length === roomBefore + 1, "§6a/ROOM: the room got the answer exactly once");
}
{
  const inTurn = newSession();
  const w = await wakeNow();
  postOutcome = "definitive";
  const roomBefore = posted.length;
  const first = await inTurn(() => callReply(w, "turn_6b", "the answer, verbatim"));
  postOutcome = "ok";
  ok(typeof first.error === "string", "§6b: the refused post reaches the model as an error");
  ok(posted.length === roomBefore, "§6b/ROOM: nothing reached the room");
  const retry = await inTurn(() => callReply(w, "turn_6b", "the answer, verbatim"));
  ok(
    typeof retry.id === "string" && retry.id !== REPLY_DEDUPE_SKIPPED_ID,
    "§6b: the IDENTICAL retry POSTS — a definitive failure gives the dedupe claim back, so the answer is not silently swallowed",
  );
  ok(posted.length === roomBefore + 1, "§6b/ROOM: and the room finally got it");
}
{
  const inTurn = newSession();
  const w = await wakeNow();
  postOutcome = "ambiguous";
  const roomBefore = posted.length;
  const first = await inTurn(() => callReply(w, "turn_6c", "the unconfirmed answer"));
  postOutcome = "ok";
  ok(typeof first.error === "string", "§6c: the unconfirmed post reaches the model as an error");
  const retry = await inTurn(() => callReply(w, "turn_6c", "the unconfirmed answer"));
  ok(retry.id === REPLY_DEDUPE_SKIPPED_ID, "§6c: the IDENTICAL retry is SUPPRESSED — an ambiguous failure may already be in the room");
  ok(posted.length === roomBefore, "§6c/ROOM: the room did not get it twice");
}
{
  const inTurn = newSession();
  const w = await wakeNow();
  postOutcome = "ambiguous";
  const roomBefore = posted.length;
  const first = await inTurn(() => callReply(w, "turn_6d", "the unconfirmed answer"));
  postOutcome = "ok";
  ok(typeof first.error === "string", "§6d: the unconfirmed post reaches the model as an error");
  const reworded = await inTurn(() => callReply(w, "turn_6d", "the unconfirmed answer, put another way"));
  ok(typeof reworded.id === "string" && reworded.id !== REPLY_DEDUPE_SKIPPED_ID, "§6d/REMEDY: a re-worded reply still posts — only the identical repost is held");
  ok(posted.length === roomBefore + 1, "§6d/ROOM: and it reached the room");
}

{
  const failedRows = async (wakeId: string): Promise<Record<string, unknown>[]> =>
    (await readAudit({ org: ORG, action: "reply.post.failed" }))
      .map((r) => (r.detail ?? {}) as Record<string, unknown>)
      .filter((d) => d["wakeId"] === wakeId);

  const inTurn = newSession();
  const wDef = await wakeNow();
  postOutcome = "definitive";
  await inTurn(() => callReply(wDef, "turn_7a", "audited definitive"));
  postOutcome = "ok";
  const defRows = await failedRows(wDef);
  ok(defRows.length === 1, "§7a/AUDIT: a failed post leaves EXACTLY ONE `reply.post.failed` row — no silent hole");
  ok(defRows[0]?.["failure"] === "definitive", "§7a/AUDIT: the row names the CLASS the spine acted on");
  ok(defRows[0]?.["reason"] === "platform-error", "§7a/AUDIT: and the reason, matching `reply.edit.refused`'s vocabulary");

  const wAmb = await wakeNow();
  postOutcome = "ambiguous";
  await inTurn(() => callReply(wAmb, "turn_7b", "audited ambiguous"));
  postOutcome = "ok";
  const ambRows = await failedRows(wAmb);
  ok(ambRows.length === 1, "§7b/AUDIT: the ambiguous failure is recorded too");
  ok(ambRows[0]?.["failure"] === "ambiguous", "§7b/AUDIT: and it is counted apart from the definitive one");

  const wOk = await wakeNow();
  postOutcome = "ok";
  await inTurn(() => callReply(wOk, "turn_7c", "audited success"));
  ok((await failedRows(wOk)).length === 0, "§7c/AUDIT: a delivered reply writes NO failure row");
  const postRows = (await readAudit({ org: ORG, action: "reply.post" }))
    .map((r) => (r.detail ?? {}) as Record<string, unknown>)
    .filter((d) => d["wakeId"] === wOk);
  ok(postRows.length === 1, "§7c/AUDIT: the delivered reply's own `reply.post` row is untouched — the failure row never inflates the count the scorers join on");
  ok((await readAudit({ org: ORG, action: "reply.post" })).every((r) => ((r.detail ?? {}) as Record<string, unknown>)["wakeId"] !== wDef), "§7c/AUDIT: and a FAILED post never wrote one");
}

{
  const rawReact = async (turnId: string): Promise<unknown> => {
    const ctx = slackCtx(turnId);
    const armed = armOf(reactTool, ctx);
    if (!armed) return new Error("react did not arm");
    return armed.execute({ emoji: "eyes" }, ctx).then(() => undefined).catch((e: unknown) => e);
  };
  const reactRows = async (): Promise<Record<string, unknown>[]> =>
    (await readAudit({ org: ORG, action: "slack.react.failed" })).map((r) => (r.detail ?? {}) as Record<string, unknown>);

  const before = (await reactRows()).length;
  const inTurn = newSession();

  reactOutcome = "definitive";
  const def = await inTurn(() => rawReact("turn_8a"));
  reactOutcome = "ok";
  ok(def instanceof Error && def.message.startsWith("react failed —"), "§8a: the tool's own copy still reaches the model");
  ok(platformFailureClass(def) === "definitive", "§8a: and the CLASS survives the re-wrap — a refused reaction is definitive at the tool layer");

  reactOutcome = "ambiguous";
  const amb = await inTurn(() => rawReact("turn_8b"));
  reactOutcome = "ok";
  ok(amb instanceof Error, "§8b: an unconfirmed reaction also reaches the model as an error");
  ok(platformFailureClass(amb) === "ambiguous", "§8b: NEGATIVE CONTROL — it is NOT definitive; a dropped connection proves nothing");

  const rows = (await reactRows()).slice(before);
  ok(rows.length === 2, "§8/AUDIT: each failed reaction leaves one `slack.react.failed` row");
  const classes = rows.map((d) => d["failure"]).sort();
  ok(classes.length === 2 && classes[0] === "ambiguous" && classes[1] === "definitive", "§8/AUDIT: carrying the two classes apart");

  reactOutcome = "ok";
  await inTurn(() => callReact("turn_8c"));
  ok((await reactRows()).length === before + 2, "§8/AUDIT: a landed reaction writes NO failure row");
}

{
  const wake = { role: "user", content: "@bot please react to this" };
  const call = (name: string) => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: {} }] });
  const okResult = (name: string) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: name, output: { type: "json", value: { reacted: true } } }] });
  const reactedTurn = [wake, call("react"), okResult("react")];

  const addressedSlackCtx = (turnId: string): BindableContext => {
    const base = slackCtx(turnId) as unknown as { session: { auth: { current: { attributes: Record<string, unknown> } } } };
    base.session.auth.current.attributes["oe_addressed"] = "true";
    return base as unknown as BindableContext;
  };

  {
    const inTurn = newSession();
    reactOutcome = "ok";
    const ctx = slackCtx("turn_9a");
    await inTurn(async () => {
      const armed = armOf(reactTool, ctx);
      await armed!.execute({ emoji: "eyes" }, ctx);
      ok(turnHasTerminalAction(reactedTurn) === true, "§9a: an UNADDRESSED react still discharges the turn alone — OPE-762 stays intact, and the negative control for §9b");
    });
  }

  {
    const inTurn = newSession();
    reactOutcome = "ok";
    const ctx = addressedSlackCtx("turn_9b");
    await inTurn(async () => {
      const armed = armOf(reactTool, ctx);
      const r = (await armed!.execute({ emoji: "eyes" }, ctx)) as { reacted?: boolean };
      ok(r.reacted === true, "§9b: the reaction still lands — the tool's own behaviour is unchanged");
      ok(turnHasTerminalAction(reactedTurn) === false, "§9b/FIX: an ADDRESSED react does NOT suppress the reissue — the owed `reply` still gets nudged");
    });
  }

  {
    const inTurn = newSession();
    await inTurn(async () => {
      ok(turnHasTerminalAction(reactedTurn) === true, "§9c: a FRESH session reads as unaddressed — the exemption doesn't leak across sessions");
    });
  }

  {
    const inTurn = newSession();
    postOutcome = "ok";
    reactOutcome = "ok";
    const w = await wakeNow();
    const ctx = addressedSlackCtx("turn_9d");
    await inTurn(async () => {
      const armed = armOf(reactTool, ctx);
      await armed!.execute({ emoji: "eyes" }, ctx);
      await callReply(w, "turn_9d", "the actual answer");
      const both = [wake, call("react"), okResult("react"), call("reply"), okResult("reply")];
      ok(turnHasTerminalAction(both) === true, "§9d: a `reply` elsewhere in the window still discharges the turn, addressed react or not");
    });
  }

  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL(`../agent/tools/react.ts`, import.meta.url), "utf8");
    const hits = (src.match(/noteReactCallAddressed\(/g) ?? []).length;
    ok(hits === 2, `§9e: tools/react.ts records addressedness on BOTH branches (registry dispatch + Slack) — got ${hits}`);
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ terminal-action failure semantics: ${passed} assertions passed`);
