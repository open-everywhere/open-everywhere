import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-stand-down-trailing-prose-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { registerSlackTestBridge, registerSlackFixtureManifest, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");

const posted: { channel: string; text: string }[] = [];
registerSlackTestBridge({
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
    return { ok: true, ts: `ts-${posted.length}` } as never;
  },
} as never);
registerSlackFixtureManifest();
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();

const standDownTool = (await import("../agent/tools/stand_down.js")).default as unknown as {
  readonly execute: (input: { reason?: string }, ctx: unknown) => Promise<{ standingDown: boolean; note: string }>;
};
const noReplyTool = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly execute: (input: { reason: string }, ctx: unknown) => Promise<{ acknowledged: boolean; note: string }>;
};
const replyTool = (await import("../agent/tools/reply.js")).default;

const { finalMessageActionForTurn } = await import("../agent/channels/turn-delivery.js");
const {
  markStandDownSilenceThisTurn,
  peekStandDownSilenceThisTurn,
  consumeStandDownSilenceThisTurn,
  STAND_DOWN_SILENCE_REASON,
  REPLY_STAND_DOWN_ACK_ACTION,
} = await import("../agent/channels/stand-down-silence.js");
const { markDeliveryArm, NO_REPLY_AFTER_STAND_DOWN_ACTION } = await import("../agent/channels/reply-signal.js");
const { peekNoReplyThisTurn, markNoReplyThisTurn } = await import("../agent/channels/no-reply-signal.js");
const { markSilentRoutineTurn, SILENT_ROUTINE_DROP_REASON } = await import("../agent/routines/report.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { isThreadStopped } = await import("../agent/channels/engagement.js");
const { readAudit } = await import("../agent/audit/audit.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const store = getOperationalStore();
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

function threadCtx(channelId: string, threadTs: string, turnId: string, sessionId = "stand-down-trailing-prose") {
  return {
    channel: { kind: "slack" },
    session: {
      id: sessionId,
      turn: { id: turnId },
      auth: {
        current: {
          attributes: { team_id: "T_TP", channel_id: channelId, thread_ts: threadTs, channel_type: "channel", user_id: "U_TP" },
          principalId: "U_TP",
          principalType: "slack-user",
        },
      },
    },
  };
}

async function enrol(ctx: unknown, threadTs: string): Promise<void> {
  const p = resolvePartition(ctx as never);
  await store.markEngaged(p.org, p.surfaceKey, threadTs, "2026-09-09T09:40:00Z", { participating: true });
}

type Armed = { execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown> } | null;
const arm = (ctx: unknown): Armed =>
  (replyTool as unknown as { events: Record<string, (a: unknown, c: unknown) => unknown> }).events["session.started"]({}, ctx) as Armed;

async function callReply(ctx: unknown, text: string): Promise<{ posted?: boolean; error?: string }> {
  const armed = arm(ctx);
  if (!armed) return { error: "reply did not arm" };
  return armed
    .execute({ text }, ctx)
    .then((r) => r as { posted?: boolean })
    .catch((e: unknown) => ({ error: String(e) }));
}

const ackRowsAll = async (): Promise<readonly { readonly detail?: Record<string, unknown> | null }[]> =>
  (await readAudit({ org: "default", action: REPLY_STAND_DOWN_ACK_ACTION })) as never;
const ackRows = async (): Promise<number> => (await ackRowsAll()).length;

{
  await inSession(async () => {
    const clean = finalMessageActionForTurn("stop", "here is the answer you asked for", "turn_1");
    ok(clean.kind === "post", "§1(a)/CONTROL: with no latch set, the turn's final text POSTS — the ordinary turn is untouched");

    ok(peekStandDownSilenceThisTurn("turn_1") === false, "§1(b): a fresh turn carries no latch");
    markStandDownSilenceThisTurn("turn_1");
    ok(peekStandDownSilenceThisTurn("turn_1") === true, "§1(b): …and the mark is readable without consuming it");
    const silenced = finalMessageActionForTurn("stop", "ok", "turn_1");
    ok(silenced.kind === "silent", "🔴 §1(b): THE FIX — a turn that already spoke into the stopped conversation ends SILENT");
    ok(silenced.kind === "silent" && silenced.reason === STAND_DOWN_SILENCE_REASON, "§1(b): …under its own reason, tellable from a judged silence");

    const after = finalMessageActionForTurn("stop", "a later answer", "turn_1");
    ok(after.kind === "post", "§1(c): the latch is read-and-reset — it silences ONE terminal decision, not the session");
  });

  await inSession(async () => {
    markStandDownSilenceThisTurn("turn_1");
    const other = finalMessageActionForTurn("stop", "an answer owed to a different conversation", "turn_2");
    ok(other.kind === "post", "🔴 §1(d): a latch set under turn_1 does NOT silence turn_2");
    ok(peekStandDownSilenceThisTurn("turn_1") === false, "§1(d): …and reading it cleared it anyway, so it can never outlive its turn");
  });

  await inSession(async () => {
    markStandDownSilenceThisTurn("turn_1");
    const anon = finalMessageActionForTurn("stop", "prose from a caller that cannot name its turn", undefined);
    ok(anon.kind === "post", "🔴 §1(e): a caller passing NO turn id is never silenced on another turn's latch");
    ok(peekStandDownSilenceThisTurn("turn_1") === false, "§1(e): …and that read still cleared the latch");
  });

  await inSession(async () => {
    markStandDownSilenceThisTurn("turn_1");
    const buffered = finalMessageActionForTurn("tool-calls", null, "turn_1");
    ok(buffered.kind === "buffer-tool-status", "§1(f): an intermediate step is untouched");
    ok(peekStandDownSilenceThisTurn("turn_1") === true, "🔴 §1(f): …and it did NOT consume the latch");
    ok(finalMessageActionForTurn("stop", "ok", "turn_1").kind === "silent", "§1(f): so the real terminal call still reads it");
  });

  await inSession(async () => {
    markStandDownSilenceThisTurn("turn_1");
    markNoReplyThisTurn("user_requested_silence");
    const both = finalMessageActionForTurn("stop", "ok", "turn_1");
    ok(both.kind === "silent" && both.reason === STAND_DOWN_SILENCE_REASON, "§1(g): the stand-down reason wins over the `no_reply` one — the stop says more about the turn");
    ok(peekNoReplyThisTurn() === null, "§1(g): …and the no-reply signal was still consumed, so it cannot bleed either");
  });
  await inSession(async () => {
    markStandDownSilenceThisTurn("turn_1");
    markSilentRoutineTurn();
    const both = finalMessageActionForTurn("stop", "ok", "turn_1");
    ok(both.kind === "silent" && both.reason === SILENT_ROUTINE_DROP_REASON, "🔴 §1(g): the SILENT-ROUTINE verdict keeps its win — this change adds an arm, it does not reorder the existing ones");
    ok(peekStandDownSilenceThisTurn("turn_1") === false, "§1(g): …and the latch was consumed on the way past, so it never reaches a later turn");
  });

  ok(consumeStandDownSilenceThisTurn("turn_1") === false, "§1(h): outside an eve session the latch reads FALSE rather than throwing");
  ok(peekStandDownSilenceThisTurn("turn_1") === false, "§1(h): …and so does the peek");
  markStandDownSilenceThisTurn("turn_1");
  ok(finalMessageActionForTurn("stop", "prose with no session at all", "turn_1").kind === "post", "🔴 §1(h): a contextless turn POSTS — losing an answer is the worse failure");
}

{
  const THREAD = "1757648022.000100";
  await inSession(async () => {
    const ctx = threadCtx("C_ENGAGED", THREAD, "turn_187");
    await enrol(ctx, THREAD);
    markDeliveryArm("dual-mode");
    const partition = resolvePartition(ctx as never);
    ok((await isThreadStopped(partition, THREAD)) === false, "§2/CONTROL: the thread is NOT stopped before the verb runs");

    const before = posted.length;
    const ackRowsBefore = await ackRows();

    const stop = await standDownTool.execute({ reason: "asked me to stop following this thread" }, ctx);
    ok(stop.standingDown === true, "§2/WIRING: the real `stand_down` marked the thread");
    ok((await isThreadStopped(partition, THREAD)) === true, "§2/WIRING: …and the reply path's own reader sees the stored flag");

    const noReplyRowsBefore = (await readAudit({ org: "default", action: NO_REPLY_AFTER_STAND_DOWN_ACTION })).length;
    let refusal = "";
    try {
      await noReplyTool.execute({ reason: "user_requested_silence" }, ctx);
    } catch (err) {
      refusal = (err as Error).message;
    }
    ok(refusal.length > 0, "§2: `no_reply` is REFUSED while the acknowledgement is owed");
    await settle();
    ok(
      (await readAudit({ org: "default", action: NO_REPLY_AFTER_STAND_DOWN_ACTION })).length - noReplyRowsBefore === 1,
      "§2: …and it writes the `reply.no_reply_after_stand_down` row the ship saw",
    );
    ok(peekNoReplyThisTurn() === null, "🔴 §2/ROOT CAUSE: the refused call records NO silence — this is why the trailing prose had nothing stopping it");

    const ack = await callReply(ctx, "Standing down here — I'll stay quiet unless someone @mentions me again.");
    ok(ack.posted === true, "§2: the ONE acknowledgement the stop asks for still POSTS");
    ok(posted.length === before + 1, "§2/ROOM: …and it reached the room");
    await settle();
    ok((await ackRows()) - ackRowsBefore === 1, "🔴 §2/AUDIT: the post carries a `reply.stand_down_ack` row — the separator the plane was missing");
    const ackRow = (await ackRowsAll()).at(-1);
    ok(ackRow?.detail?.["anchor"] === THREAD, "🔴 §2/AUDIT: …carrying the ENGAGEMENT ANCHOR, which is what joins it to `engagement.stood_down` and to the post beside it");
    ok(ackRow?.detail?.["sessionId"] === "stand-down-trailing-prose", "§2/AUDIT: …and the session, so the row reaches its own transcript");
    ok(ackRow?.detail?.["arm"] === "per-surface", "§2/AUDIT: …and names the arm under `arm`, not `route`");
    ok(ackRow?.detail?.["route"] === undefined, "🔴 §2/AUDIT: …and writes NO `route` key — that name belongs to the tool/terminal/bridge vocabulary");

    const trailing = finalMessageActionForTurn("stop", "ok", "turn_187");
    ok(trailing.kind === "silent", "🔴 §2: THE DEFECT — the turn's trailing final text is now DROPPED, not posted");
    ok(trailing.kind === "silent" && trailing.reason === STAND_DOWN_SILENCE_REASON, "§2: …naming the stop as the reason it went quiet");
    ok(posted.length === before + 1, "🔴 §2/ROOM: NOTHING further reached the room. This is the assertion the 2-character post exists for");
  });
}

{
  const OPEN = "1757648080.000200";
  await inSession(async () => {
    const ctx = threadCtx("C_OPEN", OPEN, "turn_open");
    await enrol(ctx, OPEN);
    markDeliveryArm("dual-mode");
    const partition = resolvePartition(ctx as never);
    ok((await isThreadStopped(partition, OPEN)) === false, "§3(a)/WIRING: this conversation carries NO stored stop — what makes it a real control");

    const before = posted.length;
    const rowsBefore = await ackRows();
    const answer = await callReply(ctx, "12 * 12 is 144.");
    ok(answer.posted === true, "§3(a): an ordinary reply posts");
    ok(posted.length === before + 1, "§3(a)/ROOM: …and reaches the room");
    await settle();
    ok((await ackRows()) === rowsBefore, "§3(a)/AUDIT: no `reply.stand_down_ack` row — the separator is written only where a stop was read");
    const trailing = finalMessageActionForTurn("stop", "Anything else?", "turn_open");
    ok(trailing.kind === "post", "🔴 §3(a): and the turn's trailing text POSTS — an ordinary turn is completely untouched");
    ok(trailing.kind === "post" && trailing.text === "Anything else?", "§3(a): …unchanged");
  });

  const CLOSING = "1757648130.000300";
  await inSession(async () => {
    const ctx = threadCtx("C_CLOSING", CLOSING, "turn_closing");
    await enrol(ctx, CLOSING);
    markDeliveryArm("closing-text");
    const partition = resolvePartition(ctx as never);
    const stop = await standDownTool.execute({ reason: "asked me to stop following" }, ctx);
    ok(stop.standingDown === true, "§3(b)/WIRING: the stand-down really ran on this seat too");
    ok((await isThreadStopped(partition, CLOSING)) === true, "§3(b)/WIRING: …and the conversation IS stopped, so the latch had every chance to fire");
    ok(peekStandDownSilenceThisTurn("turn_closing") === false, "🔴 §3(b): the stand-down alone sets NO latch — it latches on the POST, never on the verb");

    const ack = finalMessageActionForTurn("stop", "Understood — I'll stop following this thread.", "turn_closing");
    ok(ack.kind === "post", "🔴 §3(b): so this seat's acknowledgement, which IS its final text, still POSTS");
    ok(ack.kind === "post" && ack.text.includes("stop following"), "§3(b): …verbatim, as the person is owed");
  });

  await inSession(async () => {
    const empty = finalMessageActionForTurn("stop", "", "turn_x");
    ok(empty.kind === "silent" && empty.reason === "empty final message", "§3(c): an empty completion still reads as such");
    markNoReplyThisTurn("nothing_to_add");
    const declined = finalMessageActionForTurn("stop", "trailing narration", "turn_x");
    ok(declined.kind === "silent" && declined.reason === "no_reply tool: nothing_to_add", "§3(c): an accepted `no_reply` still wins over trailing narration, under its own reason");
  });
}

{
  const surfaces: readonly (readonly [string, string])[] = [
    ["../../providers/slack/agent/channels/slack.ts", "Slack"],
    ["../../providers/teams/agent/channels/teams.ts", "Teams"],
    ["../../providers/discord/agent/channels/discord.ts", "Discord (Interactions)"],
    ["../../providers/linear/agent/channels/linear.ts", "Linear (native arm)"],
    ["../../providers/github/agent/channels/github.ts", "GitHub (native arm)"],
  ];
  const withTurnId = /finalMessageActionForTurn\(\s*data\.finishReason,\s*data\.message,/;
  const anyCall = /finalMessageActionForTurn\s*\(/;
  for (const [rel, label] of surfaces) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    ok(anyCall.test(src), `§4/CONTROL: ${label} really calls finalMessageActionForTurn — the guard below is reading the right file`);
    ok(withTurnId.test(src), `🔴 §4: ${label} passes its TURN ID — without it the latch is consumed and discarded, and the fix disarms on this surface with every gate still green`);
  }
}

console.log(`stand-down trailing prose: ${n} assertions passed`);
