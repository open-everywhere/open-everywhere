import type { CancelAnchoredTurnInput, CancelResult } from "@open-everywhere/core/agent/adapter-api.js";
import { readFileSync } from "node:fs";
import {
  AGENT_SESSION_STOPPED_EVENT,
  parseAgentSessionStopped,
  routeAgentSessionStop,
  setSlackSessionStatus,
  slackAgentSessionOf,
  slackSurfaceSessionPin,
  slackSurfaceSessionSetter,
  slackSessionStatusForm,
  slackSessionTitle,
  SLACK_DM_WORKING_STATUS,
  SLACK_SESSION_TITLE_MAX,
  _resetSignWarningsForTest,
  type SlackSessionStatusCall,
} from "../agent/channels/slack-agent-session.js";
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

console.log("§1 the title");
{
  eq(slackSessionTitle("Plan the launch review for Friday"), "Plan the launch review for Friday", "a short first line is the title as written");
  eq(slackSessionTitle("<@U0BOT123> what did <#C0ROOM1|launch> decide?"), "what did #launch decide?", "a member mention is dropped and a channel renders as its name — no raw id");
  eq(slackSessionTitle("see <https://example.com/doc|the spec> and <https://example.com/raw>"), "see the spec and https://example.com/raw", "a link renders as its label, else its address");
  eq(slackSessionTitle("<!here> *urgent*: fix `oe_config`"), "urgent: fix oe_config", "a special mention and the emphasis marks go; `_` in an identifier stays");
  eq(slackSessionTitle("\n\n  first real line \nsecond line"), "first real line", "the first non-empty line, trimmed");
  eq(slackSessionTitle("Q&amp;A on &lt;tags&gt;"), "Q&A on <tags>", "Slack's escaped characters are decoded");
  const long = slackSessionTitle("Please read every open pull request in the payments repository and summarise the risky ones for me");
  ok(long !== undefined && long.length <= SLACK_SESSION_TITLE_MAX, `a long line is clipped to at most ${SLACK_SESSION_TITLE_MAX} characters (got ${long?.length})`);
  ok(long?.endsWith("…") === true && !long.includes("  "), "a clipped title ends with … at a word");
  eq(slackSessionTitle("<@U0BOT123>"), undefined, "a message with nothing readable left gives no title");
  eq(slackSessionTitle(undefined), undefined, "no text gives no title");
}

console.log("§2 the status call");
{
  const form = new URLSearchParams(slackSessionStatusForm({ channelId: "D1", threadTs: "1.1", status: "active", title: "Plan it" }));
  eq([form.get("channel_id"), form.get("thread_ts"), form.get("status"), form.get("title")], ["D1", "1.1", "active", "Plan it"], "the form names the session, the status and the title");
  eq(new URLSearchParams(slackSessionStatusForm({ channelId: "D1", threadTs: "1.1", status: "suspended" })).has("title"), false, "no title, no title field");
  const seen: string[] = [];
  const okCall = await setSlackSessionStatus({ channelId: "D1", threadTs: "1.1", status: "suspended" }, async (method) => {
    seen.push(method);
    return { ok: true };
  });
  ok(okCall && seen[0] === "agents.sessions.setStatus", "the call goes to agents.sessions.setStatus and answers true on ok");
  ok((await setSlackSessionStatus({ channelId: "D1", threadTs: "1.1", status: "active" }, async () => ({ ok: false, error: "feature_disabled" }))) === false, "a refusal answers false");
  ok((await setSlackSessionStatus({ channelId: "D1", threadTs: "1.1", status: "active" }, async () => { throw new Error("boom"); })) === false, "a throw answers false and never escapes");
}

console.log("§3 the Stop event");
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
  ok(manifest.settings.event_subscriptions.bot_events.includes(AGENT_SESSION_STOPPED_EVENT), "the manifest subscribes agent_session_stopped, without which Slack shows no Stop button");
}

console.log("§4 the Stop route");
{
  const run = async (channelId: string, answer: CancelResult) => {
    const cancels: CancelAnchoredTurnInput[] = [];
    const statuses: SlackSessionStatusCall[] = [];
    const result = await routeAgentSessionStop(
      { channelId, threadTs: "1700159720.000100", userId: "U0PERSON", teamId: "T0TEAM" },
      {
        attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
        cancel: async (input) => {
          cancels.push(input);
          return answer;
        },
        setStatus: async (call) => {
          statuses.push(call);
          return true;
        },
      },
    );
    return { result, cancels, statuses };
  };
  const dm = await run("D0STOP", { outcome: "requested", message: "Standing down" });
  eq(dm.cancels.length, 1, "one press, one cancel");
  const c = dm.cancels[0]!;
  eq([c.platform, c.via, c.requestedBy], ["slack", "stop-button", "U0PERSON"], "the cancel names Slack, the Stop button and the person who pressed it");
  eq(c.query.anchorKey, "slack:D0STOP:1700159720.000100", "the session's thread is the first key — the key the ✋ arm uses for a thread root");
  eq(c.query.channelKey, "slack:D0STOP", "in the person's DM the newest turn of the DM is the fallback");
  eq(dm.statuses, [{ channelId: "D0STOP", threadTs: "1700159720.000100", status: "active" }], "the session is set active after the press: Slack does not move it");
  eq(dm.result.outcome, "requested", "the route hands back the cancel's receipt");

  const room = await run("C0ROOM", { outcome: "no_turn_found", message: "Nothing running" });
  eq(room.cancels[0]!.query.channelKey, undefined, "in a shared channel there is no channel fallback — another thread's turn is never a guess");
  eq(room.statuses.length, 1, "a press that found nothing running still clears the spinner");

  const thrown = await routeAgentSessionStop(
    { channelId: "D0STOP", threadTs: "1.1", userId: "U0PERSON" },
    {
      attachSession: () => ({ cancel: async () => undefined }),
      cancel: async () => {
        throw new Error("store down");
      },
      setStatus: async () => true,
    },
  );
  eq(thrown.outcome, "error", "a cancel that throws is an error receipt, never a throw out of the route");
}

console.log("§5 the state setter");
{
  eq(
    slackAgentSessionOf({ channel_id: "D0PARK", channel_type: "im", agent_session_ts: "1700159720.000100" }),
    { channelId: "D0PARK", threadTs: "1700159720.000100" },
    "a 1:1 DM wake names its session by the stamped thread root",
  );
  eq(slackAgentSessionOf({ channel_id: "D0PARK", channel_type: "im", thread_ts: "1.1" }), undefined, "an unstamped DM delivery (a threaded message shortcut) names no session, though it carries a thread");
  eq(slackAgentSessionOf({ channel_id: "D0PARK", channel_type: "im" }), undefined, "no thread at all, no session");
  eq(slackAgentSessionOf({ channel_id: "G0GROUP", channel_type: "mpim", agent_session_ts: "1.1" }), undefined, "a group DM has no agent session");
  eq(slackAgentSessionOf({ channel_id: "C0ROOM", channel_type: "channel", thread_ts: "1.1" }), undefined, "a channel thread gets no state from OE");

  const sent: { method: string; body: URLSearchParams }[] = [];
  const recorder = async (method: string, body: string) => {
    sent.push({ method, body: new URLSearchParams(body) });
    return { ok: true };
  };
  const named = await slackSurfaceSessionSetter(recorder)({ channel_id: "D0PARK", channel_type: "im", agent_session_ts: "9.9" }, "suspended");
  eq(named, "D0PARK:9.9", "the setter answers the conversation it named, so core can tell two conversations apart");
  eq(
    sent.filter((c) => c.method === "agents.sessions.setStatus").map((c) => [c.body.get("channel_id"), c.body.get("thread_ts"), c.body.get("status")]),
    [["D0PARK", "9.9", "suspended"]],
    "the setter sets that session's state",
  );
  sent.length = 0;
  eq(await slackSurfaceSessionSetter(recorder)({ channel_id: "C0ROOM", channel_type: "channel", thread_ts: "9.9" }, "processing"), undefined, "a delivery that names no session answers undefined");
  eq(sent.length, 0, "the setter makes no call for a session it does not name");

  const register = readFileSync(new URL("../agent/register.ts", import.meta.url), "utf8");
  const body = /export function registerSlackProvider\(\)[\s\S]*?\n\}/.exec(register)?.[0] ?? "";
  ok(body.length > 0, "scan sanity: registerSlackProvider's body is found");
  ok(/registerSurfaceSessionState\("slack", slackSurfaceSessionSetter\(\), slackSurfaceSessionPin\)/.test(body), "registerSlackProvider registers the Slack session setter AND its pinner with core");

  const pin = slackSurfaceSessionPin({ team_id: "T1", channel_id: "D0PARK", channel_type: "im", user_id: "U7", agent_session_ts: "9.9", oe_wake: "w-1" });
  eq(
    pin,
    { id: "D0PARK:9.9", attributes: { channel_id: "D0PARK", channel_type: "im", agent_session_ts: "9.9", oe_session_pin: "1" } },
    "the pin is the setter's id, three ids and the pin mark: no wake stamp, no person id",
  );
  eq(await slackSurfaceSessionSetter(recorder)(pin!.attributes, "suspended"), pin!.id, "the pinned bag names the same session to the setter");
  eq(slackSurfaceSessionPin({ channel_id: "C0ROOM", channel_type: "channel", thread_ts: "9.9" }), undefined, "a channel thread pins nothing");
  eq(slackSurfaceSessionPin({ channel_id: "D0PARK", channel_type: "im", oe_work_result: "r-1" }), undefined, "a result wake's bag names no session, so it pins nothing");
}

console.log("§6 the working signs (OPE-2629): the 👀 and the status line on a DM turn");
{
  _resetSignWarningsForTest();
  const sent: { method: string; body: URLSearchParams }[] = [];
  const recorder = async (method: string, body: string) => {
    sent.push({ method, body: new URLSearchParams(body) });
    return { ok: true };
  };
  const setter = slackSurfaceSessionSetter(recorder);
  const dm = { team_id: "T1", channel_id: "D0EYES", channel_type: "im", user_id: "U7", agent_session_ts: "1700159720.000200" };
  const signs = () =>
    sent
      .filter((c) => c.method !== "agents.sessions.setStatus")
      .map((c) => [c.method, c.body.get("channel") ?? c.body.get("channel_id"), c.body.get("timestamp") ?? c.body.get("thread_ts"), c.body.get("name") ?? c.body.get("status")]);

  await setter(dm, "processing");
  eq(
    signs(),
    [
      ["reactions.add", "D0EYES", "1700159720.000200", "eyes"],
      ["assistant.threads.setStatus", "D0EYES", "1700159720.000200", SLACK_DM_WORKING_STATUS],
    ],
    "a DM turn's start adds 👀 on the session root (the message itself when top-level) and shows the status line there",
  );
  sent.length = 0;
  await setter(dm, "active");
  eq(
    signs(),
    [
      ["reactions.remove", "D0EYES", "1700159720.000200", "eyes"],
      ["assistant.threads.setStatus", "D0EYES", "1700159720.000200", ""],
    ],
    "the park removes the 👀 and clears the status line: absence is the done signal",
  );
  sent.length = 0;
  await setter(dm, "suspended");
  eq(signs().map((s) => [s[0], s[3]]), [["reactions.remove", "eyes"], ["assistant.threads.setStatus", ""]], "a park that waits on the person clears the signs too: the turn no longer works");

  sent.length = 0;
  await setter({ channel_id: "C0ROOM", channel_type: "channel", thread_ts: "9.9" }, "processing");
  await setter({ channel_id: "G0GROUP", channel_type: "mpim", agent_session_ts: "9.9" }, "processing");
  eq(sent.length, 0, "a channel thread and a group DM get no DM sign and no session call");

  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    const refusing = async (method: string, _body: string) =>
      method === "reactions.add" ? { ok: false, error: "missing_scope" } : method === "assistant.threads.setStatus" ? { ok: false, error: "not_allowed_token_type" } : method === "reactions.remove" ? { ok: false, error: "no_reaction" } : { ok: true };
    const s2 = slackSurfaceSessionSetter(refusing);
    await s2(dm, "processing");
    await s2(dm, "processing");
    await s2(dm, "active");
  } finally {
    console.warn = realWarn;
  }
  eq(warned.length, 2, "two distinct setup failures log once each, however many turns hit them; a no-op logs nothing");
  ok(warned.some((w) => w.includes("reactions.add") && w.includes("reactions:write") && w.includes("manifest")), "a refused 👀 names the reactions:write scope and the manifest paste");
  ok(warned.some((w) => w.includes("assistant.threads.setStatus") && w.includes("assistant:write") && w.includes("agent_view")), "a refused status line names assistant:write, the agent view and the manifest paste");

  sent.length = 0;
  const pinned = slackSurfaceSessionPin(dm)!;
  eq(await setter(pinned.attributes, "suspended"), pinned.id, "a pinned bag still names the session");
  eq(sent.map((c) => c.method), ["agents.sessions.setStatus"], "a job's settlement (a pinned bag) sets the session state and sends no 👀 or status-line call");
  sent.length = 0;
  await setter(pinned.attributes, "active");
  eq(sent.map((c) => c.method), ["agents.sessions.setStatus"], "a job that moves on (a pinned bag) sends no sign call either");

  warned.length = 0;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    eq(await slackSurfaceSessionSetter(async () => { throw new Error("boom"); })(dm, "processing"), "D0EYES:1700000000.000200", "a throwing transport never throws out of the setter");
  } finally {
    console.warn = realWarn;
  }
  ok(warned.some((w) => w.includes("reactions.add failed")) && !warned.some((w) => w.includes("reactions.add") && w.includes("manifest")), "a transport fault logs without a manifest fix it does not need");

  const scopes = (JSON.parse(slackAppManifestTemplate()) as { oauth_config: { scopes: { bot: string[] } } }).oauth_config.scopes.bot;
  ok(scopes.includes("reactions:write") && scopes.includes("assistant:write"), "the manifest grants reactions:write and assistant:write");
  _resetSignWarningsForTest();
}

console.log(`\n✓ slack-agent-session: ${passed} checks passed`);
