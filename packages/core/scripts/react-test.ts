
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

const react = (await import("../agent/tools/react.js")).default;
const { readAudit } = await import("../agent/audit/audit.js");
const { markReactedThisTurn, consumeReactedThisTurn } = await import("../agent/channels/react-signal.js");
const { renderNoiseDoctrine } = await import("../agent/instructions/access.js");

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
  readonly execute: (input: { emoji: string; ts?: string }, ctx: unknown) => Promise<{ reacted: boolean; emoji: string; ts: string }>;
}
type Handler = (event: unknown, ctx: unknown) => unknown;
const armEvent = (react as unknown as { events: Record<string, Handler> }).events["session.started"];
const armed = (await armEvent({}, { channel: { kind: "slack" } })) as ArmedTool;
ok(armed !== null && typeof armed.execute === "function", "react arms on a Slack session");

ok(armed.inputSchema.safeParse({ emoji: "thumbsup" }).success, "valid bare emoji name accepted");
ok(armed.inputSchema.safeParse({ emoji: "white_check_mark" }).success, "underscored emoji name accepted");
ok(armed.inputSchema.safeParse({ emoji: "+1" }).success, "Slack's +1 shortcode (digits/+ only) accepted");
ok(!armed.inputSchema.safeParse({ emoji: ":thumbsup:" }).success, "colon-wrapped emoji name rejected");
ok(!armed.inputSchema.safeParse({ emoji: "ThumbsUp" }).success, "uppercase emoji name rejected");
ok(!armed.inputSchema.safeParse({ emoji: "" }).success, "empty emoji name rejected");
ok(!armed.inputSchema.safeParse({ emoji: "thumbs up" }).success, "emoji name with a space rejected");
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
    return { json: async () => nextResponse } as Response;
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
  const discordDoctrine = renderNoiseDoctrine({ channel: { kind: "discord" } } as never);
  ok(discordDoctrine === "", "noise doctrine renders nothing off Slack (react doesn't exist there)");
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
});
restoreFetch();

calls = [];
nextResponse = { ok: true };
fakeSlack();
await inSession(async () => {
  const res = await armed.execute({ emoji: "thumbsup", ts: "999.888" }, slackCtx("C1", "111.222"));
  ok(res.ts === "999.888", "react: an explicit ts overrides the triggering message's ts");
  const params = new URLSearchParams(calls[0].body);
  ok(params.get("timestamp") === "999.888", "react: posts the OVERRIDE ts, not the thread root");
});
restoreFetch();

calls = [];
nextResponse = { ok: false, error: "already_reacted" };
fakeSlack();
await inSession(async () => {
  const res = await armed.execute({ emoji: "eyes" }, slackCtx("C1", "111.222"));
  ok(res.reacted === true, "react: already_reacted resolves as a successful no-op, not a thrown error");
  ok(consumeReactedThisTurn() === true, "react-signal: already_reacted still marks the signal — the model DID choose to react");
});
restoreFetch();

calls = [];
nextResponse = { ok: false, error: "invalid_name" };
fakeSlack();
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
restoreFetch();

console.log(`\n✓ react: ${n} assertions passed (gate, validation, execute, react-signal, audit)\n`);
