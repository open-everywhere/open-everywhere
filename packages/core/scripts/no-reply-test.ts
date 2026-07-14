
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-no-reply-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_AUDIT_SILENCES = "1";

const noReply = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly description: string;
  readonly inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  readonly execute: (input: { reason: string; explanation?: string }, ctx: unknown) => Promise<{ acknowledged: boolean; reason: string }>;
};
const { NO_REPLY_REASONS } = await import("../agent/tools/no_reply.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { markNoReplyThisTurn, consumeNoReplyThisTurn, peekNoReplyThisTurn } = await import("../agent/channels/no-reply-signal.js");
const { markReactedThisTurn } = await import("../agent/channels/react-signal.js");
const { finalMessageActionForTurn, isBareStop, isNoReply, NO_REPLY_SENTINEL } = await import("../agent/channels/slack-events.js");

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

ok(NO_REPLY_REASONS.length === 8, "no_reply: exactly 8 reasons in the closed enum (no noise_reduction)");
for (const r of NO_REPLY_REASONS) {
  if (r === "other") continue;
  ok(noReply.inputSchema.safeParse({ reason: r }).success, `no_reply: "${r}" is a valid reason`);
}
ok(!noReply.inputSchema.safeParse({ reason: "because" }).success, "no_reply: an out-of-enum reason is rejected");
ok(!noReply.inputSchema.safeParse({}).success, "no_reply: reason is required");

ok(!noReply.inputSchema.safeParse({ reason: "other" }).success, 'no_reply: bare "other" is rejected — an explanation is required');
ok(!noReply.inputSchema.safeParse({ reason: "other", explanation: "short" }).success, 'no_reply: a sub-10-char "other" explanation is rejected');
ok(
  noReply.inputSchema.safeParse({ reason: "other", explanation: "the thread resolved itself while I was reading it" }).success,
  'no_reply: "other" with a real explanation parses',
);
ok(
  noReply.inputSchema.safeParse({ reason: "nothing_to_add", explanation: "they already have the answer" }).success,
  "no_reply: named reasons may still carry an optional explanation",
);

function ctx() {
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1" }, principalId: "U1", principalType: "slack-user" } } },
  };
}

{
  markNoReplyThisTurn("nothing_to_add");
  ok(consumeNoReplyThisTurn() === null, "no-reply-signal: outside an Eve context, mark/consume are no-ops (fail-soft)");

  await inSession(async () => {
    ok(consumeNoReplyThisTurn() === null, "no-reply-signal: a fresh session starts unset");
    markNoReplyThisTurn("duplicate");
    ok(consumeNoReplyThisTurn() === "duplicate", "no-reply-signal: mark then consume returns the reason");
    ok(consumeNoReplyThisTurn() === null, "no-reply-signal: consuming resets it (next read is null)");
  });
  await inSession(async () => {
    ok(consumeNoReplyThisTurn() === null, "no-reply-signal: a different session never sees a previous session's mark");
  });
}

await inSession(async () => {
  const res = await noReply.execute({ reason: "awaiting_context" }, ctx());
  ok(res.acknowledged === true && res.reason === "awaiting_context", "no_reply: execute() acknowledges with the given reason");
  ok(consumeNoReplyThisTurn() === "awaiting_context", "no_reply: execute() marks the signal for message.completed to consume");

  const audit = await readAudit({ org: "default", action: "reply.no_reply" });
  ok(audit.length === 1 && audit[0]?.detail?.reason === "awaiting_context", "no_reply: audits exactly one reply.no_reply row with the reason (flag ON)");
});

await inSession(async () => {
  delete process.env.OE_AUDIT_SILENCES;
  try {
    const before = (await readAudit({ org: "default", action: "reply.no_reply" })).length;
    const res = await noReply.execute({ reason: "nothing_to_add" }, ctx());
    ok(res.acknowledged === true, "no_reply: flag OFF still acknowledges (turn termination unaffected)");
    ok(consumeNoReplyThisTurn() === "nothing_to_add", "no_reply: flag OFF still marks the silence signal");
    const after = (await readAudit({ org: "default", action: "reply.no_reply" })).length;
    ok(after === before, "no_reply: flag OFF (actions-only) writes NO reply.no_reply row");
  } finally {
    process.env.OE_AUDIT_SILENCES = "1";
  }
});

await inSession(async () => {
  for (const bad of [
    "the reply tool isn't available on this Notion surface",
    "reply is unavailable for channel-watch wakes",
    "I can't reply to this wake",
    "there is no way to reply on this surface",
  ]) {
    let threw = false;
    try {
      await noReply.execute({ reason: "other", explanation: bad }, ctx());
    } catch (e) {
      threw = String(e).includes("IS in your toolset");
    }
    ok(threw, `no_reply: confabulated-unavailability explanation is refused with the corrective ("${bad.slice(0, 32)}…")`);
  }
  ok(consumeNoReplyThisTurn() === null, "no_reply: a fenced call never marks the silence signal");

  const res = await noReply.execute({ reason: "other", explanation: "the question was rhetorical and already answered itself" }, ctx());
  ok(res.acknowledged === true, 'no_reply: a legitimate "other" explanation is accepted');
  ok(consumeNoReplyThisTurn() === "other", 'no_reply: legitimate "other" marks the signal');
  const audit2 = await readAudit({ org: "default", action: "reply.no_reply" });
  const withExplanation = audit2.find((r: { detail?: { explanation?: string } }) => typeof r.detail?.explanation === "string");
  ok(
    withExplanation?.detail?.explanation === "the question was rhetorical and already answered itself",
    "no_reply: the explanation is preserved verbatim in the audit row",
  );
});

await inSession(async () => {
  const before = (await readAudit({ org: "default", action: "reply.no_reply" })).length;
  const beforeRedundant = (await readAudit({ org: "default", action: "reply.no_reply_redundant" })).length;

  const r1 = await noReply.execute({ reason: "nothing_to_add" }, ctx());
  ok(r1.acknowledged === true, "no_reply redundant-guard: the first call this turn acknowledges");
  ok(peekNoReplyThisTurn() === "nothing_to_add", "no_reply redundant-guard: the first call marks the signal");

  const r2 = await noReply.execute({ reason: "duplicate" }, ctx());
  ok(r2.acknowledged === true, "no_reply redundant-guard: a redundant second call still acknowledges (never throws)");
  ok((r2 as { note?: string }).note?.includes("already recorded") === true, "no_reply redundant-guard: the redundant note states silence was already recorded this turn");
  ok(peekNoReplyThisTurn() === "nothing_to_add", "no_reply redundant-guard: the redundant call does not re-mark (first reason preserved)");

  const afterNoReply = await readAudit({ org: "default", action: "reply.no_reply" });
  ok(afterNoReply.length - before === 1, "no_reply redundant-guard: exactly ONE reply.no_reply row is written for the turn");
  const afterRedundant = await readAudit({ org: "default", action: "reply.no_reply_redundant" });
  ok(afterRedundant.length - beforeRedundant === 1, "no_reply redundant-guard: the redundant call is still audited, as reply.no_reply_redundant");
  const red = afterRedundant.find((r: { detail?: { reason?: string; already?: string } }) => r.detail?.reason === "duplicate");
  ok(
    red?.detail?.reason === "duplicate" && red?.detail?.already === "nothing_to_add",
    "no_reply redundant-guard: the redundant audit row records both reasons (new reason + the already-recorded one)",
  );
});

await inSession(async () => {
  const ordinary = finalMessageActionForTurn("stop", "here's the summary you asked for");
  ok(ordinary.kind === "post" && ordinary.text === "here's the summary you asked for", "finalMessageActionForTurn: an ordinary reply posts unchanged when no_reply wasn't called");

  const sentinelOnly = finalMessageActionForTurn("stop", `${NO_REPLY_SENTINEL} — nothing for me here`);
  ok(sentinelOnly.kind === "silent" && sentinelOnly.reason.includes("NO_REPLY sentinel"), "finalMessageActionForTurn: the bare NO_REPLY sentinel route still works");

  markNoReplyThisTurn("awaiting_context");
  const toolRouteWithTrailingText = finalMessageActionForTurn("stop", "actually let me also add a note");
  ok(
    toolRouteWithTrailingText.kind === "silent" && toolRouteWithTrailingText.reason.includes("no_reply tool: awaiting_context"),
    "finalMessageActionForTurn: calling no_reply suppresses the turn even over trailing model text (tool call IS the decision)",
  );

  const nextTurnOrdinary = finalMessageActionForTurn("stop", "a completely normal later reply");
  ok(nextTurnOrdinary.kind === "post", "finalMessageActionForTurn: the no_reply signal doesn't bleed into a later turn that never called it again");

  markNoReplyThisTurn("duplicate");
  const intermediate = finalMessageActionForTurn("tool-calls", null);
  ok(intermediate.kind === "buffer-tool-status", "finalMessageActionForTurn: an intermediate tool-calls step is untouched");
  const terminalAfter = finalMessageActionForTurn("stop", null);
  ok(terminalAfter.kind === "silent" && terminalAfter.reason.includes("duplicate"), "finalMessageActionForTurn: the signal survives an intermediate buffer step and is consumed at the real terminal call");
});

{
  const emptySilent = { kind: "silent" as const, reason: "empty final message" };
  const sentinelSilent = { kind: "silent" as const, reason: "NO_REPLY sentinel — judged not warranted" };
  const toolSilent = { kind: "silent" as const, reason: "no_reply tool: nothing_to_add" };
  const posted = { kind: "post" as const, text: "hi" };

  ok(isBareStop(emptySilent, false) === true, "isBareStop: an unexplained empty completion with no react IS a bare stop");
  ok(isBareStop(emptySilent, true) === false, "isBareStop: a react on the same turn means it's NOT a bare stop, even with an empty completion");
  ok(isBareStop(sentinelSilent, false) === false, "isBareStop: the NO_REPLY sentinel already explains the silence — not a bare stop");
  ok(isBareStop(toolSilent, false) === false, "isBareStop: the no_reply tool already explains the silence — not a bare stop");
  ok(isBareStop(posted, false) === false, "isBareStop: a posted reply is never a bare stop");
  ok(typeof markReactedThisTurn === "function", "react-signal's marker is importable from the bare-stop caller's sibling module (no circular-import issue)");
}

ok(isNoReply(`${NO_REPLY_SENTINEL} trailing rationale`), "isNoReply: prefix match still holds for the legacy sentinel");
n++;

console.log(`\n✓ no-reply: ${n} assertions passed (reason enum, signal, execute, suppression parity, bare-stop)\n`);
