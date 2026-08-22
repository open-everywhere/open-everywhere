
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-react-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;

const { registerSlackTestBridge, registerSlackFixtureMapper, registerSlackFixtureManifest } = await import("./_slack-test-stubs.js");
registerSlackTestBridge();
registerSlackFixtureMapper();
registerSlackFixtureManifest();

const react = (await import("../agent/tools/react.js")).default;
const { readAudit } = await import("../agent/audit/audit.js");
const { markReactedThisTurn, consumeReactedThisTurn } = await import("../agent/channels/react-signal.js");
const { renderNoiseDoctrine } = await import("../agent/instructions/access.js");

const { registerCapabilityManifest } = await import("../agent/identity/capabilities.js");
const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");

const FIXTURE_PLATFORM = "fixture-ticket";
registerCapabilityManifest(FIXTURE_PLATFORM, { midTurnPost: true, reactions: true });
registerIdentityMapper(FIXTURE_PLATFORM, (c) => {
  const a = (c.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
  const issueId = a["issue_id"];
  return { workspace: "acme", surface: issueId, mode: "channel", visibility: "private", target: issueId ? { issueId } : undefined };
});
let fixtureReactCalls: { issueId: string; emoji: string }[] = [];
let fixtureReactOutcome: "ok" | "unresolvable" | "throws" = "ok";
registerPostArm({
  platform: FIXTURE_PLATFORM,
  resolveReactTarget: (bag) => {
    if (fixtureReactOutcome === "unresolvable") return null;
    const issueId = bag.str("issueId");
    return issueId ? ({ platform: FIXTURE_PLATFORM, issueId } as never) : null;
  },
  react: async (target, emoji) => {
    if (fixtureReactOutcome === "throws") throw new Error("fixture platform refused the reaction");
    fixtureReactCalls.push({ issueId: (target as { issueId: string }).issueId, emoji });
  },
});

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

interface ArmedTool {
  readonly description: string;
  readonly inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } };
  readonly execute: (input: { emoji: string; ts?: string; reason?: "ack" | "noise" }, ctx: unknown) => Promise<{ reacted: boolean; emoji: string; ts: string }>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const armEvent = (react as unknown as { events: Record<string, Handler> }).events["session.started"];
const armed = (await armEvent({}, { channel: { kind: "slack" } })) as ArmedTool;
ok(armed !== null && typeof armed.execute === "function", "react arms on a Slack session");

ok((await armEvent({}, { channel: { kind: "discord" } })) === null, "react stays hidden on a Discord session (manifest reactions=false — presence gate unchanged)");
ok((await armEvent({}, { channel: { kind: "notion" } })) === null, "react stays hidden on a Notion session (presence gate unchanged)");

const unifiedArmed = (await armEvent({}, { channel: { kind: "unified" } })) as ArmedTool;
ok(unifiedArmed !== null && typeof unifiedArmed.execute === "function", "react arms on a unified session (per-turn fence, not a presence gate)");
ok(
  (await armEvent({}, {
    channel: { kind: "unified" },
    session: { auth: { current: { attributes: { oe_platform: "notion" }, principalId: "U1", principalType: "notion-user" } } },
  })) !== null,
  "react arms on a unified session even when the OPENER's origin (notion) has no reaction primitive",
);

ok(armed.inputSchema.safeParse({ emoji: "thumbsup" }).success, "valid bare emoji name accepted");
ok(armed.inputSchema.safeParse({ emoji: "white_check_mark" }).success, "underscored emoji name accepted");
ok(armed.inputSchema.safeParse({ emoji: "+1" }).success, "Slack's +1 shortcode (digits/+ only) accepted");
ok(!armed.inputSchema.safeParse({ emoji: ":thumbsup:" }).success, "colon-wrapped emoji name rejected");
ok(!armed.inputSchema.safeParse({ emoji: "ThumbsUp" }).success, "uppercase emoji name rejected");
ok(!armed.inputSchema.safeParse({ emoji: "" }).success, "empty emoji name rejected");
ok(!armed.inputSchema.safeParse({ emoji: "thumbs up" }).success, "emoji name with a space rejected");
ok(armed.inputSchema.safeParse({ emoji: "thumbsup", reason: "ack" }).success, "react reason=ack accepted");
ok(armed.inputSchema.safeParse({ emoji: "thumbsup", reason: "noise" }).success, "react reason=noise accepted");
ok(armed.inputSchema.safeParse({ emoji: "thumbsup" }).success, "react reason omitted accepted (optional)");
ok(!armed.inputSchema.safeParse({ emoji: "thumbsup", reason: "bogus" }).success, "out-of-vocabulary react reason rejected by the enum");
{
  const res = armed.inputSchema.safeParse({ emoji: ":x:" });
  ok(!res.success && (res.error?.issues[0]?.message.includes("no colons") ?? false), "rejection message names the colon rule");
}

interface FetchCall {
  readonly url: string;
  readonly body: string;
}
let calls: FetchCall[] = [];
let nextResponse: Record<string, unknown> = { ok: true };
const realFetch = globalThis.fetch;
function fakeSlack(): void {
  globalThis.fetch = (async (url: unknown, init: { body?: unknown }) => {
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => nextResponse } as Response;
  }) as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

function slackCtx(channelId: string | undefined, threadTs?: string) {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: {
            team_id: "T1",
            ...(channelId ? { channel_id: channelId } : {}),
            ...(threadTs ? { thread_ts: threadTs } : {}),
            channel_type: "channel",
          },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
  };
}

{
  markReactedThisTurn();
  ok(consumeReactedThisTurn() === false, "react-signal: outside an Eve context, mark/consume are no-ops (fail-soft, never false-positive)");

  await inSession(async () => {
    markReactedThisTurn();
    ok(consumeReactedThisTurn() === true, "react-signal: mark then consume in the SAME session reads true");
  });
  await inSession(async () => {
    ok(consumeReactedThisTurn() === false, "react-signal: a different session never sees a previous session's mark");
  });
}

{
  const slackDoctrine = renderNoiseDoctrine({ channel: { kind: "slack" } } as never);
  ok(slackDoctrine.includes("react") && slackDoctrine.toLowerCase().includes("busy"), "noise doctrine mentions react + busy threads on Slack");

  registerCapabilityManifest("discord", { midTurnPost: true, reactions: true });
  const discordDoctrine = renderNoiseDoctrine({ channel: { kind: "discord" } } as never);
  assert.strictEqual(discordDoctrine, slackDoctrine, "🔴 OPE-997: a Discord seat with manifest reactions:true reads the SAME noise doctrine bytes as Slack, not \"\"");
  registerCapabilityManifest("discord", { midTurnPost: true, reactions: false });

  const notionDoctrine = renderNoiseDoctrine({ channel: { kind: "notion" } } as never);
  ok(notionDoctrine === "", "negative control: noise doctrine stays absent where the manifest's reactions flag is false");

  assert.strictEqual(
    slackDoctrine,
    "## Busy threads: a react instead of a low-content reply\n" +
      "On a message that did NOT address you, a single emoji `react` CAN BE your whole response — " +
      'prefer it over a low-content text reply (a bare "got it" or "on it") that would just add ' +
      "another line.\n\n" +
      "When someone DOES address you, the react is your fast acknowledgement and never the answer. " +
      "React first if you want them to know you saw it, then post ONE short `reply` before the turn " +
      "ends — including when you hand the work to a delegated session.",
    "🔴 negative control: Slack's rendering is byte-unchanged by the OPE-997 gate switch",
  );

  ok(slackDoctrine.includes("did NOT address you"), "🔴 the react-alone case is scoped to an UNADDRESSED message");
  ok(slackDoctrine.includes("post ONE short `reply` before the turn"), "🔴 …and an addressed message is owed one short reply");
  ok(slackDoctrine.includes("including when you hand the work to a delegated session"), "🔴 …which delegating does not discharge");
  ok(!slackDoctrine.includes("react over reply"), "🔴 negative control: the unconditional 'react over reply' heading is gone");
}

await inSession(async () => {
  await assert.rejects(
    () => armed.execute({ emoji: "eyes" }, slackCtx(undefined, "123.1")),
    /couldn't resolve this Slack channel's id/,
    "react throws when the channel id can't be resolved",
  );
  await assert.rejects(
    () => armed.execute({ emoji: "eyes" }, slackCtx("C1", undefined)),
    /needs a message ts/,
    "react throws when no ts is given and none can be inferred",
  );
});

calls = [];
nextResponse = { ok: true };
fakeSlack();
try {
await inSession(async () => {
  ok(consumeReactedThisTurn() === false, "react-signal: a fresh session starts unreacted");
  const res = await armed.execute({ emoji: "eyes" }, slackCtx("C1", "111.222"));
  ok(res.reacted === true && res.emoji === "eyes" && res.ts === "111.222", "react: default ts is the triggering message (thread_ts)");
  ok(calls.length === 1 && calls[0].url.endsWith("/reactions.add"), "react: calls reactions.add");
  const params = new URLSearchParams(calls[0].body);
  ok(params.get("channel") === "C1" && params.get("name") === "eyes" && params.get("timestamp") === "111.222", "react: posts channel/name/timestamp");
  ok(consumeReactedThisTurn() === true, "react-signal: a successful react marks the per-turn signal");
  ok(consumeReactedThisTurn() === false, "react-signal: consuming resets it (next read is false)");

  const audit = await readAudit({ org: "default", action: "slack.react" });
  ok(audit.length === 1, "react: audits exactly one slack.react row");
  ok(audit[0]?.detail?.emoji === "eyes" && audit[0]?.detail?.ts === "111.222", "react: audit row carries the emoji + ts");
  ok(audit[0]?.detail?.reason === "ack", "react: audit row carries the decision reason, defaulting to ack when omitted (OPE-40)");
});
} finally {
  restoreFetch();
}

calls = [];
nextResponse = { ok: true };
fakeSlack();
try {
await inSession(async () => {
  const before = (await readAudit({ org: "default", action: "slack.react" })).length;
  await armed.execute({ emoji: "eyes", reason: "noise" }, slackCtx("C1", "111.222"));
  const audit = await readAudit({ org: "default", action: "slack.react" });
  ok(audit.length === before + 1, "react: an explicit-reason react audits one new row");
  ok(audit.some((r) => r?.detail?.reason === "noise"), "react: an explicit reason=noise is carried into the audit detail");
});
} finally {
  restoreFetch();
}

calls = [];
nextResponse = { ok: true };
fakeSlack();
try {
await inSession(async () => {
  const res = await armed.execute({ emoji: "thumbsup", ts: "999.888" }, slackCtx("C1", "111.222"));
  ok(res.ts === "999.888", "react: an explicit ts overrides the triggering message's ts");
  const params = new URLSearchParams(calls[0].body);
  ok(params.get("timestamp") === "999.888", "react: posts the OVERRIDE ts, not the thread root");
});
} finally {
  restoreFetch();
}

calls = [];
nextResponse = { ok: false, error: "already_reacted" };
fakeSlack();
try {
await inSession(async () => {
  const res = await armed.execute({ emoji: "eyes" }, slackCtx("C1", "111.222"));
  ok(res.reacted === true, "react: already_reacted resolves as a successful no-op, not a thrown error");
  ok(consumeReactedThisTurn() === true, "react-signal: already_reacted still marks the signal — the model DID choose to react");
});
} finally {
  restoreFetch();
}

calls = [];
nextResponse = { ok: false, error: "invalid_name" };
fakeSlack();
try {
await inSession(async () => {
  const before = (await readAudit({ org: "default", action: "slack.react" })).length;
  await assert.rejects(
    () => armed.execute({ emoji: "notarealemoji" }, slackCtx("C1", "111.222")),
    /react failed.*invalid_name/,
    "react: a real Slack error surfaces honestly (fail-soft error text, not a swallowed failure)",
  );
  n++;
  ok(consumeReactedThisTurn() === false, "react-signal: a failed react never marks the signal");
  const after = (await readAudit({ org: "default", action: "slack.react" })).length;
  ok(after === before, "react: a failed react is never audited (row count unchanged)");
});
} finally {
  restoreFetch();
}

function unifiedCtx(originPlatform: string, extra: Record<string, string> = {}) {
  return {
    channel: { kind: "unified" },
    session: {
      auth: {
        current: { attributes: { oe_platform: originPlatform, ...extra }, principalId: "U1", principalType: `${originPlatform}-user` },
      },
    },
  };
}

await inSession(async () => {
  await assert.rejects(
    () => unifiedArmed.execute({ emoji: "eyes" }, unifiedCtx("notion", { workspace_id: "W1", page_id: "P1", discussion_id: "disc-1" })),
    (err: unknown) =>
      err instanceof Error &&
      /came from notion/.test(err.message) &&
      err.message.includes("no reaction primitive") &&
      err.message.includes("`reply`") &&
      err.message.includes("`no_reply`"),
    "react: a unified notion-origin turn throws an instructive error naming the origin + the reply/no_reply alternatives",
  );
  n++;
  await assert.rejects(
    () => unifiedArmed.execute({ emoji: "eyes" }, unifiedCtx("discord", { guild_id: "G1", channel_id: "D1", channel_type: "0" })),
    /came from discord.*no reaction primitive/,
    "react: a unified discord-origin turn is fenced too (manifest reactions=false there — no widening of what react can do)",
  );
  n++;
});

calls = [];
nextResponse = { ok: true };
fakeSlack();
try {
await inSession(async () => {
  const res = await unifiedArmed.execute({ emoji: "eyes" }, unifiedCtx("slack", { team_id: "T1", channel_id: "C9", thread_ts: "333.444", channel_type: "channel" }));
  ok(res.reacted === true && res.ts === "333.444", "react: a unified slack-origin turn reacts (origin capability satisfied)");
  ok(calls.length === 1 && calls[0].url.endsWith("/reactions.add"), "react: the unified slack-origin turn routes reactions.add as usual");
  const params = new URLSearchParams(calls[0].body);
  ok(params.get("channel") === "C9" && params.get("timestamp") === "333.444", "react: the unified turn targets the ORIGIN delivery's channel + ts (per-delivery binding)");
});
} finally {
  restoreFetch();
}

function fixtureCtx(issueId: string | undefined) {
  return {
    channel: { kind: FIXTURE_PLATFORM },
    session: {
      auth: {
        current: { attributes: { ...(issueId ? { issue_id: issueId } : {}) }, principalId: "U1", principalType: `${FIXTURE_PLATFORM}-user` },
      },
    },
  };
}

{
  const armEventFixture = (react as unknown as { events: Record<string, Handler> }).events["session.started"];
  const fixtureArmed = (await armEventFixture({}, fixtureCtx("ISS1"))) as ArmedTool;
  ok(fixtureArmed !== null, "react: mounts on a native session for a manifest-registered non-Slack platform (OPE-862)");

  fixtureReactCalls = [];
  fixtureReactOutcome = "ok";
  await inSession(async () => {
    ok(consumeReactedThisTurn() === false, "react-signal: a fresh session starts unreacted (fixture platform)");
    const res = await fixtureArmed.execute({ emoji: "thumbsup" }, fixtureCtx("ISS1"));
    ok(res.reacted === true && res.emoji === "thumbsup" && res.ts === "", 'react: the generic dispatch reports reacted:true with an empty ts — GitHub/Linear track no message-level target');
    ok(fixtureReactCalls.length === 1 && fixtureReactCalls[0]!.issueId === "ISS1" && fixtureReactCalls[0]!.emoji === "thumbsup", "react: the arm's react() received the resolved issue anchor and the UNCHANGED emoji name");
    ok(consumeReactedThisTurn() === true, "react-signal: a successful generic-dispatch react marks the per-turn signal too");
    const audit = await readAudit({ org: "default", action: `${FIXTURE_PLATFORM}.react` });
    ok(audit.length === 1, `react: audits exactly one ${FIXTURE_PLATFORM}.react row — the platform-named action, not a hardcoded slack.react`);
    ok(audit[0]?.detail?.emoji === "thumbsup" && audit[0]?.detail?.reason === "ack", "react: the audit row carries the emoji and the default reason");
  });

  fixtureReactOutcome = "unresolvable";
  await inSession(async () => {
    await assert.rejects(
      () => fixtureArmed.execute({ emoji: "eyes" }, fixtureCtx("ISS1")),
      /couldn't resolve this conversation/,
      "react: an arm that cannot resolve a react target throws an honest, instructive error",
    );
    n++;
  });

  fixtureReactOutcome = "throws";
  await inSession(async () => {
    const before = (await readAudit({ org: "default", action: `${FIXTURE_PLATFORM}.react` })).length;
    await assert.rejects(
      () => fixtureArmed.execute({ emoji: "eyes" }, fixtureCtx("ISS1")),
      /react failed.*fixture platform refused/,
      "react: a failed generic-dispatch react surfaces honestly, not swallowed",
    );
    n++;
    ok(consumeReactedThisTurn() === false, "react-signal: a failed generic-dispatch react never marks the signal");
    const after = (await readAudit({ org: "default", action: `${FIXTURE_PLATFORM}.react` })).length;
    ok(after === before, "react: a failed react is never audited under the success action name");
    const failedAudit = await readAudit({ org: "default", action: `${FIXTURE_PLATFORM}.react.failed` });
    ok(failedAudit.length === 1, "react: the failure is audited under its OWN action name, so it is countable apart from a successful react");
  });
  fixtureReactOutcome = "ok";
}

console.log(`\n✓ react: ${n} assertions passed (gate, validation, execute, react-signal, audit, unified fence)\n`);
