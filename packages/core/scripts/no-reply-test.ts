// proves: auditSilencesEnabled, reply.no_reply, reply.no_reply_duplicate_refused, reply.no_reply_observed, reply.no_reply_redundant, turn.bare_stop
// proves: REPLY-45

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
// eve 1.x's channel wrapper reads the session view from the adapter context, or else from a live
// projection. A direct call carries an empty view.
const v27Completed = (adapter: object) => async (event: unknown, ctx: unknown): Promise<void> => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const eveRoot = createRequire(import.meta.url).resolve("eve/package.json").replace(/package\.json$/u, "");
  const fold = (await import(pathToFileURL(`${eveRoot}dist/src/protocol/session-projection/fold.js`).href)) as { emptySessionView: () => unknown };
  const handler = (adapter as Record<string, (e: unknown, c: unknown) => Promise<unknown>>)["content.completed"]!;
  await handler(event, { ...(ctx as object), view: fold.emptySessionView() });
};
// eve 1.x delivers a final message as `content.completed` (a text part in the "reply" phase).
const asV27Content = (f: { readonly finishReason: string; readonly message: string | null; readonly turnId?: string }) => ({
  type: "content.completed" as const,
  ...(f.turnId !== undefined ? { scope: { turnId: f.turnId } } : {}),
  data: { partId: "part-1", kind: "text", phase: f.finishReason === "stop" ? "reply" : "narration", value: f.message ?? "" },
});


const dir = join(tmpdir(), `open-everywhere-no-reply-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
const { setSilenceAuditForTest } = await import("../agent/audit/audit.js");
setSilenceAuditForTest(true);

const noReply = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly description: string;
  readonly inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  readonly execute: (input: { reason: string; explanation?: string }, ctx: unknown) => Promise<{ acknowledged: boolean; reason: string }>;
};
const { NO_REPLY_REASONS } = await import("../agent/tools/no_reply.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { markNoReplyThisTurn, consumeNoReplyThisTurn, peekNoReplyThisTurn } = await import("../agent/channels/no-reply-signal.js");
const { markReactedThisTurn } = await import("../agent/channels/react-signal.js");
const { finalMessageActionForTurn, isBareStop, isNoReply, NO_REPLY_SENTINEL } = await import("../agent/channels/turn-delivery.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
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

ok(
  noReply.description.includes("`duplicate` — the room already has the ANSWER"),
  "no_reply: the duplicate reason says the room already has the ANSWER",
);
ok(
  noReply.description.includes("A question asked again that nobody answered is not covered; answer it"),
  "no_reply: the duplicate reason says an unanswered repeat is not covered",
);
ok(
  noReply.description.includes("already covered by an earlier reply") === false,
  "no_reply: the old 'already covered by an earlier reply' wording is gone",
);

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

  const observed = await readAudit({ org: "default", action: "reply.no_reply_observed" });
  ok(observed.length === 1 && observed[0]?.detail?.reason === "awaiting_context", "no_reply: audits exactly one reply.no_reply_observed row with the reason");
  ok(observed[0]?.detail?.explanation === undefined, "no_reply: reply.no_reply_observed carries no explanation field — minimal by design");
});

await inSession(async () => {
  setSilenceAuditForTest(false);
  try {
    const before = (await readAudit({ org: "default", action: "reply.no_reply" })).length;
    const beforeObserved = (await readAudit({ org: "default", action: "reply.no_reply_observed" })).length;
    const res = await noReply.execute({ reason: "nothing_to_add" }, ctx());
    ok(res.acknowledged === true, "no_reply: flag OFF still acknowledges (turn termination unaffected)");
    ok(consumeNoReplyThisTurn() === "nothing_to_add", "no_reply: flag OFF still marks the silence signal");
    const after = (await readAudit({ org: "default", action: "reply.no_reply" })).length;
    ok(after === before, "no_reply: flag OFF (actions-only) writes NO reply.no_reply row");
    const afterObserved = await readAudit({ org: "default", action: "reply.no_reply_observed" });
    ok(afterObserved.length - beforeObserved === 1, "no_reply: flag OFF still writes ONE reply.no_reply_observed row — this is the observability fix");
    ok(afterObserved[0]?.detail?.reason === "nothing_to_add", "no_reply: the flag-OFF reply.no_reply_observed row carries the real reason (newest-first read)");
  } finally {
    setSilenceAuditForTest(true);
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
      threw = String(e).includes("call it and read the error");
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

{
  const { answeredRepeatOnRing } = await import("../agent/channels/session-tail.js");
  const { seedTailWindow } = await import("../agent/channels/session-tail-record.js");
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const { NO_REPLY_DUPLICATE_UNANSWERED_ACTION } = await import("../agent/tools/no_reply.js");
  type Row = Parameters<typeof answeredRepeatOnRing>[0][number];
  const ROOM = "slack/T1/C1";
  const ASK = "<@UBOT> tell me here when a new issue is opened in acme/repo.";
  const wake = (at: string, text: string, container = ROOM): Row => ({ kind: "wake", at, from: "human", trust: "peer", refuted: false, author: "U1", authorId: "U1", container, text });
  const post = (at: string, text = "On it, I will set up that watch."): Row => ({ kind: "post", at, from: "self", trust: "relay", refuted: false, author: "self", container: ROOM, text });
  const t = (s: number) => new Date(Date.UTC(2026, 9, 19, 1, 51, s)).toISOString();

  ok(answeredRepeatOnRing([wake(t(1), ASK)]) === false, "OPE-2623 ring: a fresh window holding only the trigger has no answered copy");
  ok(answeredRepeatOnRing([]) === false, "OPE-2623 ring: an empty ring (trigger not recorded yet) has no answered copy");
  ok(answeredRepeatOnRing([wake(t(1), ASK), post(t(2)), wake(t(3), "tell me here when a new issue is opened in acme/repo")]) === true, "OPE-2623 ring: an earlier copy the seat answered in this window is a true repeat (mention and punctuation ignored)");
  ok(answeredRepeatOnRing([wake(t(1), ASK), wake(t(3), ASK)]) === false, "OPE-2623 ring: an earlier copy nobody answered is not a repeat");
  ok(answeredRepeatOnRing([post(t(0)), wake(t(1), ASK), wake(t(3), ASK)]) === false, "OPE-2623 ring: a seat post BEFORE the earlier copy answers nothing");
  ok(answeredRepeatOnRing([wake(t(1), "what's our deploy day?"), post(t(2)), wake(t(3), ASK)]) === false, "OPE-2623 ring: an answered DIFFERENT ask does not make this one a repeat");
  ok(answeredRepeatOnRing([wake(t(1), ASK), post(t(2)), wake(t(3), ASK), post(t(4))]) === false, "OPE-2623 ring: a trigger the seat already posted after is not this turn's trigger");
  ok(answeredRepeatOnRing([wake(t(1), ASK, "slack/T1/C2"), post(t(2)), wake(t(3), ASK)], ROOM) === false, "OPE-2623 ring: a copy answered in ANOTHER room of a cross-surface window does not count");
  ok(answeredRepeatOnRing([wake(t(1), "<@UBOT> summarize <#C111|eng>"), post(t(2)), wake(t(3), "<@UBOT> summarize <#C222|sales>")]) === false, "OPE-2623 ring: two asks that differ only by the channel they name are two asks");
  ok(answeredRepeatOnRing([wake(t(1), "<@UBOT> ping <@U1> about it"), post(t(2)), wake(t(3), "<@UBOT> ping <@U2> about it")]) === false, "OPE-2623 ring: two asks that differ only by the person they name are two asks");
  ok(answeredRepeatOnRing([wake(t(1), ASK), wake(t(2), "what's our deploy day?"), post(t(3)), wake(t(4), ASK)]) === false, "OPE-2623 ring: a post that answered a DIFFERENT, later wake did not answer the earlier copy");
  ok(answeredRepeatOnRing([wake(t(1), ASK), post(t(2)), wake(t(3), "<@UBOT> what's our deploy day?"), wake(t(4), ASK)]) === false, "🔴 OPE-2623 ring: a later answered repeat landing mid-turn does not cover an unanswered trigger before it");
  ok(answeredRepeatOnRing([wake(t(1), ASK), wake(t(2), "<@UBOT> what's our deploy day?"), post(t(3)), wake(t(4), "<@UBOT> what's our deploy day?")]) === false, "🔴 OPE-2623 ring: a message sent while the seat composed another answer is not marked answered by that post");
  ok(answeredRepeatOnRing([wake(t(1), ASK), wake(t(2), ASK), post(t(3)), wake(t(4), ASK)]) === true, "OPE-2623 ring: a post after two copies of the same ask answers that ask");
  ok(answeredRepeatOnRing([wake(t(1), "thanks"), post(t(2)), wake(t(3), ASK), post(t(4)), wake(t(5), "thanks"), wake(t(6), ASK)]) === true, "OPE-2623 ring: every waiting message an answered repeat is a true repeat");

  const addressedCtx = () => ({
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", oe_addressed: "1" }, principalId: "U1", principalType: "slack-user" } } },
  });
  const refusedRows = async () => (await readAudit({ org: "default", action: NO_REPLY_DUPLICATE_UNANSWERED_ACTION })).length;
  const store = getOperationalStore();
  const window = (token: string) => ({ org: "default", registryKey: "oe-dom:e2e-unified", token, platform: "slack", container: ROOM });

  await inSession(async () => {
    const w = window("oe-dom:e2e-unified:oe-sup:g2-aaaaaa");
    await store.appendSessionTail(w.org, w.registryKey, w.token, wake(t(1), ASK));
    seedTailWindow(w);
    const before = await refusedRows();
    let threw: unknown;
    try {
      await noReply.execute({ reason: "duplicate" }, addressedCtx());
    } catch (err) {
      threw = err;
    }
    ok(threw instanceof Error && threw.message.includes("`duplicate` is not available on this wake"), "🔴 OPE-2623: `duplicate` on an addressed wake with no answered copy in the window is REFUSED");
    ok(peekNoReplyThisTurn() === null, "OPE-2623: the refused call records no silence, so the reply stays owed");
    ok((await refusedRows()) - before === 1, "OPE-2623: the refusal writes ONE reply.no_reply_duplicate_refused row");
    const r = await noReply.execute({ reason: "nothing_to_add" }, addressedCtx());
    ok(r.acknowledged === true, "OPE-2623: every other reason stays available after the refusal");
  });

  await inSession(async () => {
    const before = (await readAudit({ org: "default", action: NO_REPLY_DUPLICATE_UNANSWERED_ACTION })).filter((r: { detail?: { window?: string } }) => r.detail?.window === "unread").length;
    let threw: unknown;
    try {
      await noReply.execute({ reason: "duplicate" }, addressedCtx());
    } catch (err) {
      threw = err;
    }
    ok(threw instanceof Error && threw.message.includes("`duplicate` is not available on this wake"), "OPE-2623: an addressed `duplicate` with no window to prove it is refused BY THIS GUARD");
    const after = (await readAudit({ org: "default", action: NO_REPLY_DUPLICATE_UNANSWERED_ACTION })).filter((r: { detail?: { window?: string } }) => r.detail?.window === "unread").length;
    ok(after - before === 1, "OPE-2623: the no-window refusal writes ONE row with window \"unread\"");
  });

  await inSession(async () => {
    const w = window("oe-dom:e2e-unified:oe-sup:g3-bbbbbb");
    for (const row of [wake(t(1), ASK), post(t(2)), wake(t(3), ASK)]) await store.appendSessionTail(w.org, w.registryKey, w.token, row);
    seedTailWindow(w);
    const r = await noReply.execute({ reason: "duplicate" }, addressedCtx());
    ok(r.acknowledged === true && peekNoReplyThisTurn() === "duplicate", "OPE-2623 NEGATIVE CONTROL: an addressed ask the seat already answered in this window may still end as `duplicate`");
  });

  await inSession(async () => {
    const r = await noReply.execute({ reason: "duplicate" }, ctx());
    ok(r.acknowledged === true && peekNoReplyThisTurn() === "duplicate", "OPE-2623 NEGATIVE CONTROL: `duplicate` on an unaddressed wake is untouched");
  });
}

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

{
  const unified = (await import("../agent/channels/unified.js")).default as unknown as {
    readonly adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
  };
  const onCompleted = v27Completed(unified.adapter);
  const WINDOW_TOKEN = "oe-dom:e2e-unified:oe-sup:g1-bd552c";
  const windowChannel = { continuation: { token: WINDOW_TOKEN }, state: {} };
  const inWindowTurn = (sessionId: string, wakeId: string, turnId: string) => {
    const c = new ContextContainer();
    c.set(SessionKey, {
      sessionId,
      auth: { current: { attributes: { oe_platform: "slack", oe_wake_id: wakeId, oe_window_token: WINDOW_TOKEN } }, initiator: null },
      turn: { id: turnId },
      parent: undefined,
    });
    return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
  };

  await inWindowTurn("wrun_bare", "wake-bare-1", "turn-bare")(async () => {
    setSilenceAuditForTest(false);
    try {
      const before = (await readAudit({ org: "default", action: "turn.bare_stop" })).length;
      await onCompleted(asV27Content({ finishReason: "stop", message: "" }), windowChannel);
      const rows = await readAudit({ org: "default", action: "turn.bare_stop" });
      ok(rows.length - before === 1, "unified bare stop: an empty final message with no reply/react/no_reply writes ONE turn.bare_stop row with the silence-audit switch OFF");
      ok(rows[0]?.detail?.sessionId === "wrun_bare", "unified bare stop: the row names the session so it joins to the transcript");
      ok(rows[0]?.detail?.wakeId === "wake-bare-1", "unified bare stop: the row names the wake that went unanswered");
      ok((await readAudit({ org: "default", action: "unified.no_reply" })).length === 0, "unified bare stop: the gated judged-silence row still writes nothing on the actions-only posture");
    } finally {
      setSilenceAuditForTest(true);
    }
  });

  await inWindowTurn("wrun_reacted", "wake-reacted-1", "turn-reacted")(async () => {
    const before = (await readAudit({ org: "default", action: "turn.bare_stop" })).length;
    markReactedThisTurn();
    await onCompleted(asV27Content({ finishReason: "stop", message: "" }), windowChannel);
    const after = (await readAudit({ org: "default", action: "turn.bare_stop" })).length;
    ok(after === before, "unified bare stop: a turn that reacted is NOT a bare stop — no row");
  });

  await inWindowTurn("wrun_sentinel", "wake-sentinel-1", "turn-sentinel")(async () => {
    const before = (await readAudit({ org: "default", action: "turn.bare_stop" })).length;
    await onCompleted(asV27Content({ finishReason: "stop", message: NO_REPLY_SENTINEL }), windowChannel);
    const after = (await readAudit({ org: "default", action: "turn.bare_stop" })).length;
    ok(after === before, "unified bare stop: the NO_REPLY sentinel route is a stated silence — no row");
  });
}

{
  const { readdirSync, readFileSync } = await import("node:fs");
  const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
  const CALL = /\bsetSilenceAuditForTest\b|audit\.silence-rows\.test/;
  const HOME = join("packages", "core", "agent", "audit", "audit.ts");
  const agentTrees = [join(repoRoot, "agent"), join(repoRoot, "packages", "core", "agent")];
  for (const group of [join(repoRoot, "packages", "providers"), join(repoRoot, "packages")]) {
    for (const e of readdirSync(group, { withFileTypes: true })) if (e.isDirectory()) agentTrees.push(join(group, e.name, "agent"));
  }
  const offenders: string[] = [];
  let scanned = 0;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/[-.]test\.tsx?$/.test(e.name)) {
        scanned++;
        const rel = p.slice(repoRoot.length + 1);
        if (rel !== HOME && CALL.test(readFileSync(p, "utf8"))) offenders.push(rel);
      }
    }
  };
  for (const t of agentTrees) walk(t);
  ok(scanned > 100, `silence-audit scan: it read the agent trees (${scanned} files) — a wrong root would pass vacuously`);
  assert.deepEqual(offenders, [], "🔴 no committed production module names setSilenceAuditForTest or its slot — none arms the switch");
  n++;
  ok(CALL.test("  setSilenceAuditForTest(true);"), "silence-audit scan: NEGATIVE CONTROL — the pattern does match a real call");
  ok(CALL.test('import { setSilenceAuditForTest as arm } from "../audit/audit.js";'), "silence-audit scan: NEGATIVE CONTROL — an aliased import is caught");
  ok(CALL.test('processRegistrySlot<boolean>("audit.silence-rows.test.v1").set(true);'), "silence-audit scan: NEGATIVE CONTROL — a direct slot write is caught");
}

ok(isNoReply(`${NO_REPLY_SENTINEL} trailing rationale`), "isNoReply: prefix match still holds for the legacy sentinel");
n++;

console.log(`\n✓ no-reply: ${n} assertions passed (reason enum, signal, execute, suppression parity, bare-stop)\n`);

// proves: TOOL-no_reply
