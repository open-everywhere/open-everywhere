import type { CancelAnchoredTurnInput, CancelResult } from "@open-everywhere/core/agent/adapter-api.js";
import { __setTestValveForTest, testValveArmed } from "@open-everywhere/core/agent/adapter-api.js";
import { readdirSync, readFileSync } from "node:fs";
import {
  AGENT_SESSION_STOPPED_EVENT,
  parseAgentSessionStopped,
  routeAgentSessionStop,
  slackSurfaceSessionAnswerer,
  slackSurfaceSessionSetter,
  slackWorkingSignsOf,
  _resetSignWarningsForTest,
} from "../agent/channels/slack-agent-session.js";
import { isSlackStatusLineRequest, slackFetchWithoutStatusLine, SLACK_STATUS_LINE_METHOD } from "../agent/channels/slack-working-signs.js";
import { classifyEnvelope } from "../agent/channels/slack-front.js";
import { slackAppManifestTemplate } from "../agent/app-manifest.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const eq = (a: unknown, b: unknown, label: string): void => ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

function recorder(): { readonly sent: { method: string; body: URLSearchParams }[]; readonly form: (method: string, body: string) => Promise<Record<string, unknown>> } {
  const sent: { method: string; body: URLSearchParams }[] = [];
  return {
    sent,
    form: async (method, body) => {
      sent.push({ method, body: new URLSearchParams(body) });
      return { ok: true };
    },
  };
}
const reactions = (sent: readonly { method: string; body: URLSearchParams }[]) =>
  sent.map((c) => [c.method, c.body.get("channel"), c.body.get("timestamp"), c.body.get("name")]);
const eyesOn = (sent: readonly { method: string; body: URLSearchParams }[]): boolean =>
  sent.filter((c) => c.body.get("name") === "eyes").at(-1)?.method === "reactions.add";

console.log("§1 the Stop event");
{
  const forge = readFileSync(new URL("../../../core/scripts/e2e/synthetic.ts", import.meta.url), "utf8");
  ok(forge.includes(`AGENT_SESSION_STOPPED_EVENT_TYPE = "${AGENT_SESSION_STOPPED_EVENT}"`), "the e2e forge names the same event as the product");
  const env = {
    type: "event_callback",
    team_id: "T0TEAM",
    event_id: "EvStop1",
    event: { type: AGENT_SESSION_STOPPED_EVENT, channel: "D0STOP", thread_ts: "1700159720.000100", user: "U0PERSON", event_ts: "1700159820.000000", streaming_message_ts: [] },
  };
  const parsed = parseAgentSessionStopped(env as never);
  eq(parsed, { channelId: "D0STOP", threadTs: "1700159720.000100", userId: "U0PERSON", teamId: "T0TEAM", eventTs: "1700159820.000000" }, "the parse reads the session, the person and the envelope's team");
  eq(parseAgentSessionStopped({ type: "event_callback", event: { type: AGENT_SESSION_STOPPED_EVENT, channel: "D1", user: "U1" } } as never), null, "no thread, no stop");
  eq(parseAgentSessionStopped({ type: "event_callback", event: { type: "reaction_added", channel: "D1", thread_ts: "1.1", user: "U1" } } as never), null, "another event is not a stop");
  eq(classifyEnvelope(JSON.stringify(env), "application/json").kind, "session-stop", "the front route classifies the press as ours");
  const manifest = JSON.parse(slackAppManifestTemplate()) as { settings: { event_subscriptions: { bot_events: string[] } } };
  ok(manifest.settings.event_subscriptions.bot_events.includes(AGENT_SESSION_STOPPED_EVENT), "the manifest still subscribes agent_session_stopped, so a press that arrives still stops its turn");
}

console.log("§2 the Stop route");
{
  const run = async (channelId: string, answer: CancelResult) => {
    const cancels: CancelAnchoredTurnInput[] = [];
    const sent: string[] = [];
    const result = await routeAgentSessionStop(
      { channelId, threadTs: "1700159720.000100", userId: "U0PERSON", teamId: "T0TEAM" },
      {
        attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
        cancel: async (input) => {
          cancels.push(input);
          return answer;
        },
      },
    );
    return { result, cancels, sent };
  };
  const dm = await run("D0STOP", { outcome: "requested", message: "Standing down" });
  eq(dm.cancels.length, 1, "one press, one cancel");
  const c = dm.cancels[0]!;
  eq([c.platform, c.via, c.requestedBy], ["slack", "stop-button", "U0PERSON"], "the cancel names Slack, the Stop button and the person who pressed it");
  eq(c.query.anchorKey, "slack:D0STOP:1700159720.000100", "the session's thread is the first key — the key the ✋ arm uses for a thread root");
  eq(c.query.channelKey, "slack:D0STOP", "in the person's DM the newest turn of the DM is the fallback");
  eq(dm.result.outcome, "requested", "the route hands back the cancel's receipt");
  eq(dm.sent.length, 0, "the route sends no session call: OE sets no agent-session state (OPE-2668)");

  const room = await run("C0ROOM", { outcome: "no_turn_found", message: "Nothing running" });
  eq(room.cancels[0]!.query.channelKey, undefined, "in a shared channel there is no channel fallback — another thread's turn is never a guess");

  const thrown = await routeAgentSessionStop(
    { channelId: "D0STOP", threadTs: "1.1", userId: "U0PERSON" },
    {
      attachSession: () => ({ cancel: async () => undefined }),
      cancel: async () => {
        throw new Error("store down");
      },
    },
  );
  eq(thrown.outcome, "error", "a cancel that throws is an error receipt, never a throw out of the route");
}

console.log("§3 the 👀 rule on the DM door (OPE-2668)");
{
  _resetSignWarningsForTest();
  const ROOT = "1700159720.000200";
  const dm = { team_id: "T1", channel_id: "D0EYES", channel_type: "im", user_id: "U7", working_signs_ts: ROOT };
  eq(slackWorkingSignsOf(dm), { channelId: "D0EYES", threadTs: ROOT, teamId: "T1" }, "a stamped 1:1 delivery names the message its sign rides");

  const r = recorder();
  const setter = slackSurfaceSessionSetter(r.form);
  const answerer = slackSurfaceSessionAnswerer(r.form);
  eq(await setter(dm, "processing"), `D0EYES:${ROOT}`, "the setter answers the message the sign rides");
  eq(
    reactions(r.sent),
    [
      ["reactions.add", "D0EYES", ROOT, "eyes"],
      ["reactions.remove", "D0EYES", ROOT, "octagonal_sign"],
    ],
    "the start adds 👀 on the person's message and takes any old 🛑 off — and sends no other call",
  );
  r.sent.length = 0;
  eq(await answerer(dm), `D0EYES:${ROOT}`, "the answerer answers the message it cleared, so core can record it");
  eq(reactions(r.sent), [["reactions.remove", "D0EYES", ROOT, "eyes"], ["reactions.remove", "D0EYES", ROOT, "octagonal_sign"]], "the final reply takes 👀 off, and puts nothing else on");
  ok(!eyesOn(r.sent), "after the final reply no 👀 is left");
  for (const status of ["active", "suspended"] as const) {
    r.sent.length = 0;
    await setter(dm, status);
    eq(reactions(r.sent).map((c) => [c[0], c[3]]), [["reactions.remove", "eyes"], ["reactions.remove", "octagonal_sign"]], `the park (${status}) leaves no sign`);
  }
  r.sent.length = 0;
  await setter(dm, "active", { failed: true });
  eq(reactions(r.sent).map((c) => [c[0], c[3]]), [["reactions.remove", "eyes"], ["reactions.add", "octagonal_sign"]], "a failed turn ends with 👀 off and 🛑 on");

  const group = { channel_id: "G0GROUP", channel_type: "mpim", working_signs_ts: "1700159720.000300" };
  const g = recorder();
  await slackSurfaceSessionSetter(g.form)(group, "processing");
  ok(eyesOn(g.sent), "a group DM turn puts 👀 on the person's message");
  await slackSurfaceSessionAnswerer(g.form)(group);
  ok(!eyesOn(g.sent) && g.sent.every((c) => c.body.get("channel") === "G0GROUP" && c.body.get("timestamp") === "1700159720.000300"), "the group DM's final reply takes it off, on the same message");

  const n = recorder();
  eq(await slackSurfaceSessionSetter(n.form)({ channel_id: "C0ROOM", channel_type: "channel", thread_ts: "9.9", working_signs_ts: "9.9" }, "processing"), undefined, "a channel delivery names nothing (the mention door draws its own 👀)");
  eq(await slackSurfaceSessionSetter(n.form)({ channel_id: "D0EYES", channel_type: "im" }, "processing"), undefined, "an unstamped 1:1 delivery (a shortcut) names nothing");
  eq(await slackSurfaceSessionAnswerer(n.form)({ channel_id: "D0EYES", channel_type: "im" }), undefined, "and its answer clears nothing");
  eq(n.sent.length, 0, "none of them sends a call");

  const spoofWas = testValveArmed("egress-spoof");
  __setTestValveForTest("egress-spoof", true);
  try {
    const sp = recorder();
    eq(await slackSurfaceSessionAnswerer(sp.form)(dm), `D0EYES:${ROOT}`, "under the egress spoof the answerer still names the message");
    eq(sp.sent.length, 0, "…and sends no call");
  } finally {
    __setTestValveForTest("egress-spoof", spoofWas);
  }

  const register = readFileSync(new URL("../agent/register.ts", import.meta.url), "utf8");
  const regBody = /export function registerSlackProvider\(\)[\s\S]*?\n\}/.exec(register)?.[0] ?? "";
  ok(regBody.length > 0, "scan sanity: registerSlackProvider's body is found");
  ok(
    /registerSurfaceSessionState\("slack", slackSurfaceSessionSetter\(\), undefined, undefined, slackSurfaceSessionAnswerer\(\)\)/.test(regBody),
    "registerSlackProvider registers the setter and the answerer, and no pinner or stepper: OE sets no session state and no status line",
  );
  _resetSignWarningsForTest();
}

console.log("§4 the setup warnings");
{
  _resetSignWarningsForTest();
  const dm = { channel_id: "D0WARN", channel_type: "im", working_signs_ts: "1.1" };
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    const refusing = async (method: string, _body: string) => (method === "reactions.add" ? { ok: false, error: "missing_scope" } : method === "reactions.remove" ? { ok: false, error: "no_reaction" } : { ok: true });
    const s2 = slackSurfaceSessionSetter(refusing);
    await s2(dm, "processing");
    await s2(dm, "processing");
    await s2(dm, "active");
  } finally {
    console.warn = realWarn;
  }
  eq(warned.length, 1, "a setup failure logs once, however many turns hit it; a no-op (`no_reaction`) logs nothing");
  ok(warned.some((w) => w.includes("reactions.add") && w.includes("reactions:write") && w.includes("manifest")), "a refused 👀 names the reactions:write scope and the manifest paste");
  warned.length = 0;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    eq(await slackSurfaceSessionSetter(async () => { throw new Error("boom"); })(dm, "processing"), "D0WARN:1.1", "a throwing transport never throws out of the setter");
  } finally {
    console.warn = realWarn;
  }
  ok(warned.some((w) => w.includes("reactions.add failed")) && !warned.some((w) => w.includes("reactions.add") && w.includes("manifest")), "a transport fault logs without a manifest fix it does not need");
  _resetSignWarningsForTest();
}

console.log("§5 no status line and no session state on any door (OPE-2668)");
{
  const r = recorder();
  const dm = { channel_id: "D0NONE", channel_type: "im", working_signs_ts: "1.1" };
  await slackSurfaceSessionSetter(r.form)(dm, "processing");
  await slackSurfaceSessionAnswerer(r.form)(dm);
  await slackSurfaceSessionSetter(r.form)(dm, "suspended");
  await slackSurfaceSessionSetter(r.form)(dm, "active", { failed: true });
  ok(r.sent.length > 0 && r.sent.every((c) => c.method === "reactions.add" || c.method === "reactions.remove"), `the DM door sends reactions and nothing else (sent: ${[...new Set(r.sent.map((c) => c.method))].join(", ")})`);

  ok(isSlackStatusLineRequest(`https://slack.com/api/${SLACK_STATUS_LINE_METHOD}`), "the fence knows a status-line call by its method");
  ok(!isSlackStatusLineRequest("https://slack.com/api/chat.postMessage") && !isSlackStatusLineRequest("not a url"), "…and nothing else");
  const realFetch = globalThis.fetch;
  const wire: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    wire.push(String(input));
    return new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 });
  }) as typeof fetch;
  try {
    const fenced = slackFetchWithoutStatusLine();
    const status = (await (await fenced(`https://slack.com/api/${SLACK_STATUS_LINE_METHOD}`, { method: "POST", body: "status=Thinking..." })).json()) as { ok?: boolean };
    ok(status.ok === true, "a status-line call is answered `ok` locally, so eve reads no failure");
    eq(wire, [], "🔴 …and never reaches the wire");
    const post = (await (await fenced(new URL("https://slack.com/api/chat.postMessage"), { method: "POST" })).json()) as { ts?: string };
    ok(post.ts === "1.2" && wire.length === 1, "any other call goes to the global fetch, read at call time");
  } finally {
    globalThis.fetch = realFetch;
  }
  const mention = readFileSync(new URL("../agent/channels/slack.ts", import.meta.url), "utf8");
  ok(/api:\s*\{\s*fetch:\s*slackFetchWithoutStatusLine\(\)\s*\}/.test(mention), "the mention door's channel sends through the fence (`api.fetch`)");

  const dir = new URL("../agent/channels/", import.meta.url);
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(new URL(f, dir), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (f !== "slack-working-signs.ts" && /assistant\.threads\.setStatus/.test(src)) offenders.push(`${f}: assistant.threads.setStatus`);
    if (/agents\.sessions\.setStatus/.test(src)) offenders.push(`${f}: agents.sessions.setStatus`);
    if (/\.startTyping\(/.test(src)) offenders.push(`${f}: startTyping`);
  }
  eq(offenders, [], "no Slack channel source calls a status method outside comments");
}

console.log(`\n✓ slack-agent-session: ${passed} checks passed`);
