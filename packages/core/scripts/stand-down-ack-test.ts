import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-stand-down-ack-${process.pid}`);
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

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const standDown = (await import("../agent/tools/stand_down.js")).default as unknown as {
  readonly description: string;
  readonly execute: (input: { reason?: string }, ctx: unknown) => Promise<{ standingDown: boolean; note: string }>;
};
const noReply = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly execute: (input: { reason: string; explanation?: string }, ctx: unknown) => Promise<{ acknowledged: boolean; note: string }>;
};
const { standDownAckRoute } = await import("../agent/tools/stand_down.js");
const { standDownAckSentence } = await import("../agent/instructions/seat-prompt.js");
const {
  markDeliveryArm,
  markStoodDownThisTurn,
  markStoppedAckThisTurn,
  markRepliedThisTurn,
  peekDeliveryArm,
  standDownAckOwedThisTurn,
  wasStoodDownThisTurn,
  NO_REPLY_AFTER_STAND_DOWN_ACTION,
} = await import("../agent/channels/reply-signal.js");
const { peekNoReplyThisTurn } = await import("../agent/channels/no-reply-signal.js");
const { renderSupervisorPersona } = await import("../agent/instructions/access.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { readAudit } = await import("../agent/audit/audit.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const store = getOperationalStore();

function threadCtx(channelId: string, threadTs: string, turnId: string) {
  return {
    channel: { kind: "slack" },
    session: {
      turn: { id: turnId },
      auth: {
        current: {
          attributes: { team_id: "T_ACK", channel_id: channelId, thread_ts: threadTs, channel_type: "channel", user_id: "U_ACK" },
          principalId: "U_ACK",
          principalType: "slack-user",
        },
      },
    },
  };
}

async function enrol(ctx: unknown, threadTs: string): Promise<void> {
  const p = resolvePartition(ctx as never);
  await store.markEngaged(p.org, p.surfaceKey, threadTs, "2026-09-08T10:00:00Z", { participating: true });
}

{
  await inSession(async () => {
    ok(peekDeliveryArm() === null, "§ARM: a fresh session has resolved no arm — the seam starts empty");
    ok(
      standDownAckRoute() === standDownAckSentence("dual-mode"),
      "🔴 an unstamped session reads the `dual-mode` sentence — the fail direction is the seat that POSTS its closing text",
    );
    markDeliveryArm("wake-addressed");
    ok(standDownAckRoute() === standDownAckSentence("wake-addressed"), "a stamped arm is what the tool renders");
    markDeliveryArm("nonsense-arm");
    ok(
      standDownAckRoute() === standDownAckSentence("dual-mode"),
      "🔴 NEGATIVE CONTROL: an unrecognised arm name is not cast into the union — it falls to the default",
    );
  });
}

{
  await inSession(async () => {
    const unifiedSeat = {
      channel: { kind: "unified", continuationToken: "oe-dom:ack-dom:oe-sup:g1" },
      session: { auth: { current: { attributes: { team_id: "T_ACK", channel_id: "C_ACK" }, principalId: "U_ACK", principalType: "slack-user" } } },
    };
    const persona = renderSupervisorPersona(unifiedSeat as never, { messageToolOnly: true });
    ok(persona.length > 0, "the unified seat renders a persona (the render that resolves the arm actually ran)");
    ok(peekDeliveryArm() === "wake-addressed", "🔴 resolveDeliveryArm STAMPED arm 1 — this is the seam a tool-execute context cannot read for itself");
    ok(
      standDownAckRoute() === standDownAckSentence("wake-addressed"),
      "…so `stand_down` names the wake-addressed route on that seat, without the tool inspecting a channel it does not have",
    );
  });
  await inSession(async () => {
    const threadSeat = { channel: { kind: "slack", continuationToken: "C_ACK:oe-sup:g1" }, session: { auth: { current: { attributes: {}, principalId: "U", principalType: "slack-user" } } } };
    renderSupervisorPersona(threadSeat as never);
    ok(peekDeliveryArm() === "closing-text", "🔴 NEGATIVE CONTROL: a per-surface supervisor seat stamps its OWN arm — a present, non-arm-1 answer");
  });
}

{
  const wakeAddressed = await inSession(async () => {
    markDeliveryArm("wake-addressed");
    const ctx = threadCtx("C_ARM1", "1700.1", "turn_1");
    await enrol(ctx, "1700.1");
    return (await standDown.execute({ reason: "asked me to stop following" }, ctx)).note;
  });
  const dualMode = await inSession(async () => {
    markDeliveryArm("dual-mode");
    const ctx = threadCtx("C_ARM4", "1700.2", "turn_1");
    await enrol(ctx, "1700.2");
    return (await standDown.execute({ reason: "asked me to stop following" }, ctx)).note;
  });

  ok(wakeAddressed.includes(standDownAckSentence("wake-addressed")), "the note on a wake-addressed seat carries THAT arm's route sentence");
  ok(dualMode.includes(standDownAckSentence("dual-mode")), "the note on a dual-mode seat carries THAT arm's route sentence");
  ok(wakeAddressed !== dualMode, "the two seats read different notes — the arm reaches the model, not a house average");

  ok(!/discard/i.test(dualMode), "🔴 the dual-mode note never claims prose is discarded — that claim is what lost the acknowledgement");
  ok(!/`reply`/.test(dualMode), "🔴 the dual-mode note names ONE route — it does not offer `reply` beside the final text");
  ok(!/as your final text/i.test(wakeAddressed), "🔴 the wake-addressed note never OFFERS the turn-final text as the route");
  ok(/discarded/.test(wakeAddressed), "…it says that text is discarded there, which is the fact that seat needs");
  ok(/wake-id/.test(wakeAddressed), "the wake-addressed note names the address its `reply` needs");
  ok(/one-line acknowledgement/.test(dualMode) && /one-line acknowledgement/.test(wakeAddressed), "both notes still say what is owed: one line");

  ok(!/discard/i.test(standDown.description), "🔴 the tool DESCRIPTION asserts no delivery contract — the false clause is gone");
  ok(/this tool's own result/.test(standDown.description), "…it points at the result note, which is where the arm is knowable");
}

{
  await inSession(async () => {
    const ctx = threadCtx("C_OWED", "1800.1", "turn_1");
    await enrol(ctx, "1800.1");
    markDeliveryArm("dual-mode");
    const res = await standDown.execute({ reason: "asked me to stop following" }, ctx);
    ok(res.standingDown === true, "the stand-down itself succeeds");
    ok(wasStoodDownThisTurn("turn_1"), "§STOOD-DOWN: the success path marked the turn");
    ok(standDownAckOwedThisTurn("turn_1"), "…and the acknowledgement is owed, because nothing has left the turn yet");

    const before = (await readAudit({ org: "default", action: NO_REPLY_AFTER_STAND_DOWN_ACTION })).length;
    let message = "";
    try {
      await noReply.execute({ reason: "user_requested_silence" }, ctx);
    } catch (err) {
      message = (err as Error).message;
    }
    ok(message.length > 0, "🔴 `no_reply` in the same turn as the stand-down is REFUSED, not accepted");
    ok(message.includes("still owes the one-line acknowledgement"), "…with a named reason: this turn still owes the acknowledgement");
    ok(message.includes(standDownAckSentence("dual-mode")), "…and it says what to do instead, in this seat's OWN route sentence");
    ok(!/no_reply` and end the turn|end the turn now/i.test(message), "🔴 the refusal does not end the turn — the acknowledgement still has to leave it");
    ok(peekNoReplyThisTurn() === null, "🔴 THE WHOLE DEFECT: the refused call records NO silence, so the reply obligation stays open");
    const after = await readAudit({ org: "default", action: NO_REPLY_AFTER_STAND_DOWN_ACTION });
    ok(after.length - before === 1, "the refusal writes exactly one reply.no_reply_after_stand_down row");
    ok(after[0]?.detail?.reason === "user_requested_silence", "…carrying the reason the model gave");
  });
}

{
  await inSession(async () => {
    const ctx = threadCtx("C_PLAIN", "1810.1", "turn_1");
    const res = await noReply.execute({ reason: "nothing_to_add" }, ctx);
    ok(res.acknowledged === true, "🔴 NEGATIVE CONTROL: with no stand-down this turn, `no_reply` is accepted");
    ok(peekNoReplyThisTurn() === "nothing_to_add", "…and it records the silence, untouched by this ticket");
  });

  await inSession(async () => {
    const ctx = threadCtx("C_SPENT", "1820.1", "turn_1");
    await enrol(ctx, "1820.1");
    markDeliveryArm("wake-addressed");
    await standDown.execute({ reason: "asked me to stop following" }, ctx);
    markStoppedAckThisTurn("turn_1");
    ok(!standDownAckOwedThisTurn("turn_1"), "the spent stand-down acknowledgement discharges the debt");
    const res = await noReply.execute({ reason: "user_requested_silence" }, ctx);
    ok(res.acknowledged === true, "🔴 `no_reply` AFTER the acknowledgement is accepted — this asks for one line, it is not a cap");
    ok(peekNoReplyThisTurn() === "user_requested_silence", "…and the silence is recorded normally");
  });

  await inSession(async () => {
    const ctx = threadCtx("C_POSTED", "1830.1", "turn_1");
    await enrol(ctx, "1830.1");
    markDeliveryArm("reply-only");
    await standDown.execute({ reason: "asked me to stop following" }, ctx);
    ok(standDownAckOwedThisTurn("turn_1"), "the debt stands the moment the stand-down runs");
    markRepliedThisTurn("turn_1");
    ok(!standDownAckOwedThisTurn("turn_1"), "a post that follows the stand-down discharges it");
    const res = await noReply.execute({ reason: "user_requested_silence" }, ctx);
    ok(res.acknowledged === true, "…so its `no_reply` is accepted");
  });

  await inSession(async () => {
    const ctx = threadCtx("C_PRE", "1835.1", "turn_1");
    await enrol(ctx, "1835.1");
    markDeliveryArm("dual-mode");
    markRepliedThisTurn("turn_1");
    await standDown.execute({ reason: "asked me to stop following" }, ctx);
    ok(standDownAckOwedThisTurn("turn_1"), "🔴 a post that PRECEDED the stand-down does not discharge it");
    let message = "";
    try {
      await noReply.execute({ reason: "user_requested_silence" }, ctx);
    } catch (err) {
      message = (err as Error).message;
    }
    ok(message.includes("still owes the one-line acknowledgement"), "…so the `no_reply` is still refused, and the final text still has to be written");
    ok(peekNoReplyThisTurn() === null, "…with no silence recorded");
    markStoppedAckThisTurn("turn_1");
    ok(!standDownAckOwedThisTurn("turn_1"), "the acknowledgement that POSTED into the stopped conversation discharges it either way");
  });

  await inSession(async () => {
    const ctx = threadCtx("C_PRE_THEN_POST", "1836.1", "turn_1");
    await enrol(ctx, "1836.1");
    markDeliveryArm("wake-addressed");
    markRepliedThisTurn("turn_1");
    await standDown.execute({ reason: "asked me to stop following" }, ctx);
    ok(standDownAckOwedThisTurn("turn_1"), "the debt stands while only the PRECEDING post has landed (the (d) state)");
    markRepliedThisTurn("turn_1");
    ok(
      !standDownAckOwedThisTurn("turn_1"),
      "🔴 OPE-1596: a post that lands AFTER the stand-down discharges it even on a turn that had ALREADY posted",
    );
    const res = await noReply.execute({ reason: "user_requested_silence" }, ctx);
    ok(res.acknowledged === true, "…so the `no_reply` is accepted rather than refused for the rest of the turn");
    ok(peekNoReplyThisTurn() === "user_requested_silence", "…and the silence is recorded normally");
  });

  await inSession(async () => {
    const ctx = threadCtx("C_ARM_GATE", "1836.2", "turn_1");
    await enrol(ctx, "1836.2");
    markDeliveryArm("dual-mode");
    markRepliedThisTurn("turn_1");
    await standDown.execute({ reason: "asked me to stop following" }, ctx);
    markRepliedThisTurn("turn_1");
    ok(
      standDownAckOwedThisTurn("turn_1"),
      "🔴 a post AFTER the stand-down discharges NOTHING on a prose-posting arm — the acknowledgement there is the final text",
    );
    let message = "";
    try {
      await noReply.execute({ reason: "user_requested_silence" }, ctx);
    } catch (err) {
      message = (err as Error).message;
    }
    ok(message.includes("still owes the one-line acknowledgement"), "…so the `no_reply` is REFUSED, and the final text still has to be written");
    ok(peekNoReplyThisTurn() === null, "🔴 …with NO silence recorded — a recorded silence is what drops the final text");
  });

  await inSession(async () => {
    const ctx = threadCtx("C_PRE_TWICE", "1837.1", "turn_1");
    await enrol(ctx, "1837.1");
    markDeliveryArm("dual-mode");
    markRepliedThisTurn("turn_1");
    markRepliedThisTurn("turn_1");
    await standDown.execute({ reason: "asked me to stop following" }, ctx);
    ok(
      standDownAckOwedThisTurn("turn_1"),
      "🔴 NEGATIVE CONTROL: TWO posts that both PRECEDED the stand-down still discharge nothing — the snapshot moved with them",
    );
    let message = "";
    try {
      await noReply.execute({ reason: "user_requested_silence" }, ctx);
    } catch (err) {
      message = (err as Error).message;
    }
    ok(message.includes("still owes the one-line acknowledgement"), "…and the `no_reply` is refused, exactly as in (d)");
  });

  await inSession(async () => {
    markRepliedThisTurn("turn_1");
    markRepliedThisTurn("turn_1");
    const ctx = threadCtx("C_NEWTURN", "1838.1", "turn_2");
    await enrol(ctx, "1838.1");
    markDeliveryArm("wake-addressed");
    await standDown.execute({ reason: "asked me to stop following" }, ctx);
    ok(standDownAckOwedThisTurn("turn_2"), "the new turn owes the acknowledgement — the earlier turn's posts are not its own");
    markRepliedThisTurn("turn_2");
    ok(!standDownAckOwedThisTurn("turn_2"), "🔴 …and ONE post discharges it, so `postsThisTurn` never showed the snapshot an earlier turn's total");
  });

  await inSession(async () => {
    markStoodDownThisTurn("turn_1");
    ok(standDownAckOwedThisTurn("turn_1"), "the mark answers for the turn that set it");
    ok(!standDownAckOwedThisTurn("turn_2"), "🔴 …and for no other turn — the mark self-invalidates at the turn boundary");
    const res = await noReply.execute({ reason: "nothing_to_add" }, threadCtx("C_NEXT", "1840.1", "turn_2"));
    ok(res.acknowledged === true, "a later turn's `no_reply` is accepted with an earlier turn's stand-down on the slot");
  });

  await inSession(async () => {
    markStoodDownThisTurn(undefined);
    ok(!standDownAckOwedThisTurn(undefined), "an unidentifiable turn carries no mark, so the guard stays OFF");
    const ctx = { channel: { kind: "slack" }, session: { auth: { current: { attributes: { team_id: "T_ACK", channel_id: "C_NOTURN" }, principalId: "U_ACK", principalType: "slack-user" } } } };
    const res = await noReply.execute({ reason: "nothing_to_add" }, ctx);
    ok(res.acknowledged === true, "…and `no_reply` behaves exactly as it did before this section existed");
  });
}

console.log(
  `✓ stand-down-ack: ${n} assertions passed (the arm seam + the resolver's stamp + the tool note per arm + the owed-acknowledgement refusal + its discharges with the counted order test, its turn keying and its fail-off)`,
);
