
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-no-reply-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const noReply = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly description: string;
  readonly inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  readonly execute: (input: { reason: string }, ctx: unknown) => Promise<{ acknowledged: boolean; reason: string }>;
};
const { NO_REPLY_REASONS } = await import("../agent/tools/no_reply.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { markNoReplyThisTurn, consumeNoReplyThisTurn } = await import("../agent/channels/no-reply-signal.js");
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
  ok(noReply.inputSchema.safeParse({ reason: r }).success, `no_reply: "${r}" is a valid reason`);
}
ok(!noReply.inputSchema.safeParse({ reason: "because" }).success, "no_reply: an out-of-enum reason is rejected");
ok(!noReply.inputSchema.safeParse({}).success, "no_reply: reason is required");

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
  ok(audit.length === 1 && audit[0]?.detail?.reason === "awaiting_context", "no_reply: audits exactly one reply.no_reply row with the reason");
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
