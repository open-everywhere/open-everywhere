import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-reply-freshness-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

const { gradeReplyFreshness, freshnessRefusalMessage, freshnessNoticeText } = await import("../agent/channels/reply-freshness.js");
const reply = (await import("../agent/tools/reply.js")).default;

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

function ctxAt(turnId: string, wakeId: string | undefined, addressing?: "direct-mention") {
  return {
    channel: { kind: "slack" },
    session: {
      turn: { id: turnId, sequence: 0 },
      auth: {
        current: {
          attributes: {
            team_id: "T1",
            channel_id: "C1",
            channel_type: "channel",
            ...(wakeId ? { oe_wake_id: wakeId } : {}),
            ...(addressing ? { oe_addressing: addressing } : {}),
          },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
  } as never;
}

await inSession(async () => {
  ok(gradeReplyFreshness({ channel: { kind: "slack" }, session: {} } as never, false).kind === "fresh", "no turn/wake signal ⇒ fresh (fail-open)");
  ok(gradeReplyFreshness(ctxAt("t1", undefined), false).kind === "fresh", "a turn.id with no oe_wake_id stamp ⇒ fresh (off single-window path)");
});

await inSession(async () => {
  const g = gradeReplyFreshness(ctxAt("t2", "w1", "direct-mention"), false);
  ok(g.kind === "fresh", "first call this turn is fresh even against a direct-mention wake (nothing to compare yet)");
});

await inSession(async () => {
  gradeReplyFreshness(ctxAt("t3", "w1"), false);
  const g = gradeReplyFreshness(ctxAt("t3", "w1"), false);
  ok(g.kind === "fresh", "an unchanged wakeId on a later call this turn stays fresh");
});

await inSession(async () => {
  gradeReplyFreshness(ctxAt("t4", "w1"), false);
  const g1 = gradeReplyFreshness(ctxAt("t4", "w2"), false);
  ok(g1.kind === "notice" && g1.newerCount === 1, "a newer AMBIENT wake ⇒ notice, newerCount=1");
  const g2 = gradeReplyFreshness(ctxAt("t4", "w3"), false);
  ok(g2.kind === "notice" && g2.newerCount === 2, "a further newer ambient wake ⇒ notice, newerCount advances monotonically");
});

await inSession(async () => {
  gradeReplyFreshness(ctxAt("t5", "w1"), false);
  const refused = gradeReplyFreshness(ctxAt("t5", "w2", "direct-mention"), false);
  ok(refused.kind === "refuse" && refused.newerCount === 1, "a newer DIRECT-MENTION wake ⇒ refuse (not force), newerCount=1");
  const retried = gradeReplyFreshness(ctxAt("t5", "w2", "direct-mention"), false);
  ok(retried.kind === "notice" && retried.newerCount === 1, "retrying the SAME wake-id after a refuse ⇒ notice (already nudged once, not blocked forever)");
  const settled = gradeReplyFreshness(ctxAt("t5", "w2", "direct-mention"), false);
  ok(settled.kind === "fresh", "after the retry proceeds, the SAME wake-id again reads fresh (accounted-for)");
});

await inSession(async () => {
  gradeReplyFreshness(ctxAt("t6", "w1"), false);
  const forced = gradeReplyFreshness(ctxAt("t6", "w2", "direct-mention"), true);
  ok(forced.kind === "notice" && forced.newerCount === 1, "force:true on a direct-mention newer wake ⇒ notice immediately, never refuse");
});

await inSession(async () => {
  gradeReplyFreshness(ctxAt("t7a", "w1"), false);
  gradeReplyFreshness(ctxAt("t7a", "w9", "direct-mention"), false);
  const onNewTurn = gradeReplyFreshness(ctxAt("t7b", "w9", "direct-mention"), false);
  ok(onNewTurn.kind === "fresh", "a DIFFERENT turn.id starts its own ledger (fresh), independent of another turn's history");
});

{
  const g = gradeReplyFreshness(ctxAt("t8", "w1", "direct-mention"), false);
  ok(g.kind === "fresh", "outside an eve session context, grading fails SOFT to fresh (never throws, never fabricates a block)");
}

ok(/NOT sent/.test(freshnessRefusalMessage(1)), "refusal message: Tag-parity 'NOT sent' vocabulary");
ok(/force:true/.test(freshnessRefusalMessage(1)), "refusal message: names the force:true escape hatch");
ok(/at least 1 newer, directly-addressed message has/.test(freshnessRefusalMessage(1)), "refusal message: singular grammar at count=1");
ok(/at least 3 newer, directly-addressed messages have/.test(freshnessRefusalMessage(3)), "refusal message: plural grammar at count>1");
ok(/1 newer message arrived/.test(freshnessNoticeText(1, false)), "notice text: singular grammar at count=1");
ok(/2 newer messages arrived/.test(freshnessNoticeText(2, false)), "notice text: plural grammar at count>1");
ok(/Posted anyway \(force:true\)/.test(freshnessNoticeText(1, true)), "notice text: names force:true when the post proceeded forced");
ok(!/force/i.test(freshnessNoticeText(1, false)), "notice text: no stray force mention when not forced");
n += 8;

const realFetch = globalThis.fetch;
const resp = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
let calls: Array<{ url: string }> = [];
function fakeHttp(): void {
  globalThis.fetch = (async (url: unknown) => {
    calls.push({ url: String(url) });
    return resp(200, { ok: true, ts: `${Date.now()}.000001` });
  }) as typeof fetch;
}
function restoreHttp(): void {
  globalThis.fetch = realFetch;
}

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ArmedTool {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
}
const arm = (ctx: unknown): ArmedTool => (reply as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as ArmedTool;

fakeHttp();
await inSession(async () => {
  const turnId = "int-turn-1";
  const armed = arm(ctxAt(turnId, "w1"));

  const first = await armed.execute({ text: "hello" }, ctxAt(turnId, "w1"));
  ok(first.posted === true && first.note === undefined, "integration: a fresh first reply posts with NO staleness note");

  calls = [];
  const second = await armed.execute({ text: "still working" }, ctxAt(turnId, "w2"));
  ok(second.posted === true && calls.length === 1, "integration: a stale-but-ambient second reply still posts (one HTTP call)");
  ok(typeof second.note === "string" && /newer message/.test(second.note as string), "integration: the notice note names the newer activity");

  calls = [];
  await assert.rejects(
    () => armed.execute({ text: "answer" }, ctxAt(turnId, "w3", "direct-mention")),
    /NOT sent/,
    "integration: a newer DIRECT-MENTION wake REFUSES (throws) rather than posting",
  );
  n++;
  ok(calls.length === 0, "integration: a refused reply never reaches the network (no HTTP call happened)");

  calls = [];
  const retried = await armed.execute({ text: "answer, now caught up" }, ctxAt(turnId, "w3", "direct-mention"));
  ok(retried.posted === true && calls.length === 1, "integration: retrying the SAME direct-mention wake-id after a refusal now posts");
});

await inSession(async () => {
  const turnId = "int-turn-2";
  const armed = arm(ctxAt(turnId, "w1"));
  await armed.execute({ text: "baseline" }, ctxAt(turnId, "w1"));
  calls = [];
  const forced = await armed.execute({ text: "urgent, forced", force: true }, ctxAt(turnId, "w2", "direct-mention"));
  ok(forced.posted === true && calls.length === 1, "integration: force:true posts immediately even on the FIRST sighting of a newer direct-mention wake");
});
restoreHttp();

{
  const armed = arm(ctxAt("t-upd", undefined));
  const armedObj = armed as unknown as Record<string, unknown>;
  ok(!("update_reply" in armedObj), "update_reply: not a property of the armed reply tool (verb doesn't exist, dropped 2026-07-13)");
  ok(typeof (armed as { execute?: unknown }).execute === "function", "the base reply tool arms with a single execute (no editing verb to gate)");
  n += 2;
}

console.log(`reply-freshness-test: ${n} assertions passed`);
