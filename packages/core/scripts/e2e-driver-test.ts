import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-e2e-driver-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const {
  ENV,
  resolveSlack,
  resolveDiscord,
  resolveSynthetic,
  resolveSlackPrivate,
  resolveSlackChannelB,
  resolveSyntheticDm,
  resolveSlackUser2,
  resolveCapabilities,
} = await import("./e2e/env.js");
const { backoffDelayMs, pollUntil, PollTimeout } = await import("./e2e/poll.js");
const {
  signSlackRequest,
  buildApprovalClickPayload,
  encodeInteractionBody,
  buildSlashCommandBody,
  buildDmEventEnvelope,
  buildChannelMentionEnvelope,
  syntheticSlackTs,
  SYNTHETIC_SLACK_ROUTE,
  SYNTHETIC_COMMANDS_ROUTE,
  APPROVAL_PREFIX,
} = await import("./e2e/synthetic.js");
const { runFallbackCheck, FallbackJudge, judge3 } = await import("./e2e/judge.js");
const { SCENARIOS, skipReason } = await import("./e2e/scenarios.js");
const { verifySlackSignature, classifyEnvelope, buildFrontHandler, PUBLIC_SLACK_ROUTE } = await import("../agent/channels/slack-front.js");
const { SLACK_COMMANDS_ROUTE } = await import("../agent/channels/slack-commands.js");
const { OE_APPROVAL_PREFIX } = await import("../agent/approvals/flow.js");
const { parseDirectMessageEvent, parseAppMentionEvent } = await import("../../../node_modules/eve/dist/src/public/channels/slack/inbound.js");

{
  const empty = {};
  const slack = resolveSlack(empty);
  ok(!slack.ok && slack.missing.length === 3, "empty env: slack half reports all three missing vars");
  ok(!slack.ok && slack.missing.includes(ENV.slackUserToken), "missing list names E2E_SLACK_USER_TOKEN");
  const discord = resolveDiscord(empty);
  ok(!discord.ok && discord.missing.includes(ENV.discordDriverToken), "missing list names E2E_DISCORD_DRIVER_TOKEN");
  const synthetic = resolveSynthetic(empty);
  ok(!synthetic.ok && synthetic.missing.includes(ENV.slackSigningSecret), "missing list names SLACK_SIGNING_SECRET");

  const slackPriv = resolveSlackPrivate(empty);
  ok(!slackPriv.ok && slackPriv.missing.join(",") === ENV.slackPrivateChannel, "private-channel add-on misses exactly E2E_SLACK_PRIVATE_CHANNEL");
  const slackB = resolveSlackChannelB(empty);
  ok(!slackB.ok && slackB.missing.join(",") === ENV.slackChannelB, "channel-B add-on misses exactly E2E_SLACK_CHANNEL_B");
  const synDm = resolveSyntheticDm(empty);
  ok(!synDm.ok && synDm.missing.includes(ENV.slackDmChannel) && synDm.missing.includes(ENV.targetUrl), "synthetic-DM half misses E2E_SLACK_DM_CHANNEL + E2E_TARGET_URL");
  const user2Miss = resolveSlackUser2(empty);
  ok(!user2Miss.ok && user2Miss.missing.join(",") === ENV.slackUser2Id, "user2 add-on misses exactly E2E_SLACK_USER2_ID");

  const caps = resolveCapabilities(empty);
  ok(caps.available.size === 0, "empty env: NO capabilities — full dry mode");
  ok(!caps.includeOptional, "optional scenarios excluded by default");

  const base = {
    [ENV.slackUserToken]: "xoxp-test",
    [ENV.slackChannel]: "C123",
    [ENV.slackBotUserId]: "U999",
    [ENV.slackAdminUserId]: "U2ADMIN",
    [ENV.discordDriverToken]: "driver-token",
    [ENV.discordChannel]: "111",
    [ENV.discordBotUserId]: "222",
    [ENV.targetUrl]: "https://oe.example.test/",
    [ENV.slackSigningSecret]: "shhh",
  };
  const capsBase = resolveCapabilities(base);
  ok(capsBase.available.size === 3, "base env (no add-on vars): exactly the three base capabilities");
  ok(
    capsBase.missing.slackPrivate.join(",") === ENV.slackPrivateChannel &&
      capsBase.missing.slackChannelB.join(",") === ENV.slackChannelB &&
      capsBase.missing.syntheticDm.join(",") === ENV.slackDmChannel &&
      capsBase.missing.slackUser2.join(",") === ENV.slackUser2Id,
    "base env: each add-on capability names only ITS missing var (base vars not repeated)",
  );
  const full = {
    ...base,
    [ENV.slackPrivateChannel]: "C0PRIV",
    [ENV.slackChannelB]: "C0BBB",
    [ENV.slackDmChannel]: "D0DM",
    [ENV.slackUser2Id]: "U2NONADMIN",
  };
  const capsFull = resolveCapabilities(full);
  ok(capsFull.available.size === 7, "full env: all seven capabilities live");
  const user2 = resolveSlackUser2(full);
  ok(user2.ok && user2.cfg.userId === "U2NONADMIN", "user2 cfg carries the non-admin id");
  const dmCfg = resolveSyntheticDm(full);
  ok(dmCfg.ok && dmCfg.cfg.dmChannel === "D0DM" && dmCfg.cfg.targetUrl === "https://oe.example.test", "syntheticDm cfg carries the DM channel + slash-stripped target");
  const syn = resolveSynthetic(full);
  ok(syn.ok && syn.cfg.targetUrl === "https://oe.example.test", "target URL trailing slash is stripped");
  ok(syn.ok && syn.cfg.org === "default", "E2E_ORG unset: synthetic org defaults to \"default\" (single-org fixture)");
  const orgSyn = resolveSynthetic({ ...full, [ENV.org]: "acme" });
  ok(orgSyn.ok && orgSyn.cfg.org === "acme", "E2E_ORG set: synthetic org carries the override");
  const blank = resolveSlack({ ...full, [ENV.slackChannel]: "   " });
  ok(!blank.ok && blank.missing.includes(ENV.slackChannel), "a whitespace-only value counts as missing (fail-closed)");
}

{
  ok(SCENARIOS.length === 16, "pack has all sixteen scenarios S1–S16");
  const ids = SCENARIOS.map((s) => s.id);
  ok(new Set(ids).size === ids.length, "scenario ids are unique");
  ok(
    ids.join(",") === "S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16",
    "scenario ids are S1..S16 in plan order",
  );
  const KNOWN = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "syntheticDm", "slackUser2"]);
  for (const s of SCENARIOS) {
    ok(s.title.trim().length > 0, `${s.id} has a title`);
    ok(typeof s.run === "function", `${s.id} has a run body`);
    ok(
      s.requires.length > 0 && s.requires.every((c) => KNOWN.has(c)),
      `${s.id} requires only known capabilities`,
    );
    ok(s.timeoutMs >= 120_000 && s.timeoutMs <= 660_000, `${s.id} budget is within the re-derived 120–660s envelope`);
  }
  const optional = SCENARIOS.filter((s) => s.optional).map((s) => s.id);
  ok(optional.join(",") === "S8,S9,S10", "exactly the plan's stretch scenarios are optional (S11–S16 are core coverage)");
  const unjudged = SCENARIOS.filter((s) => !s.judged).map((s) => s.id);
  ok(unjudged.join(",") === "S3,S6,S10,S15", "S3/S6/S10/S15 are fully deterministic — no judge (plan §5)");
  const req = (id: string) => SCENARIOS.find((s) => s.id === id)!.requires.join("+");
  ok(req("S11") === "slack+slackPrivate", "S11 requires slack + slackPrivate");
  ok(req("S12") === "slack+slackChannelB", "S12 requires slack + slackChannelB");
  ok(req("S13") === "slack+syntheticDm" && req("S14") === "slack+syntheticDm", "S13/S14 require slack + syntheticDm");
  ok(
    req("S15") === "slack+synthetic+slackUser2" && req("S16") === "slack+synthetic+slackUser2",
    "S15/S16 require slack + synthetic + slackUser2",
  );
}

{
  const none = new Set<"slack" | "discord" | "synthetic" | "slackPrivate" | "slackChannelB" | "syntheticDm" | "slackUser2">();
  const missing = {
    slack: [ENV.slackUserToken, ENV.slackChannel, ENV.slackBotUserId],
    discord: [ENV.discordDriverToken, ENV.discordChannel, ENV.discordBotUserId],
    synthetic: [ENV.targetUrl, ENV.slackSigningSecret, ENV.slackAdminUserId, ENV.slackChannel],
    slackPrivate: [ENV.slackPrivateChannel],
    slackChannelB: [ENV.slackChannelB],
    syntheticDm: [ENV.slackDmChannel],
    slackUser2: [ENV.slackUser2Id],
  } as const;
  for (const s of SCENARIOS) {
    const reason = skipReason(s, none, missing, false);
    ok(reason !== undefined, `${s.id} skips in dry mode`);
    ok(/E2E_|SLACK_SIGNING_SECRET/.test(reason ?? ""), `${s.id} dry-skip names the env vars to set`);
  }
  const all = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "syntheticDm", "slackUser2"] as const);
  const noneMissing = { slack: [], discord: [], synthetic: [], slackPrivate: [], slackChannelB: [], syntheticDm: [], slackUser2: [] } as const;
  ok(skipReason(SCENARIOS[0], all, noneMissing, false) === undefined, "S1 runs when its capability is live");
  ok(
    skipReason(SCENARIOS.find((s) => s.id === "S8")!, all, noneMissing, false)?.includes("E2E_INCLUDE_OPTIONAL") === true,
    "S8 stays skipped without E2E_INCLUDE_OPTIONAL=1 even with full tokens",
  );
  ok(
    skipReason(SCENARIOS.find((s) => s.id === "S8")!, all, noneMissing, true) === undefined,
    "S8 runs with E2E_INCLUDE_OPTIONAL=1",
  );
  const slackOnly = new Set(["slack"] as const);
  const s7reason = skipReason(SCENARIOS.find((s) => s.id === "S7")!, slackOnly, missing, false);
  ok(s7reason?.includes("discord") === true && s7reason.includes(ENV.discordDriverToken), "S7 skip names the discord vars specifically");
  const baseOnly = new Set(["slack", "discord", "synthetic"] as const);
  const s11 = skipReason(SCENARIOS.find((s) => s.id === "S11")!, baseOnly, missing, false);
  ok(s11 === `missing slackPrivate driver (set ${ENV.slackPrivateChannel})`, "S11 skip names exactly E2E_SLACK_PRIVATE_CHANNEL");
  const s12 = skipReason(SCENARIOS.find((s) => s.id === "S12")!, baseOnly, missing, false);
  ok(s12?.includes(ENV.slackChannelB) === true && s12.includes("slackChannelB"), "S12 skip names E2E_SLACK_CHANNEL_B");
  for (const id of ["S13", "S14"]) {
    const r = skipReason(SCENARIOS.find((s) => s.id === id)!, baseOnly, missing, false);
    ok(r?.includes(ENV.slackDmChannel) === true && r.includes("syntheticDm"), `${id} skip names E2E_SLACK_DM_CHANNEL`);
  }
  for (const id of ["S15", "S16"]) {
    const r = skipReason(SCENARIOS.find((s) => s.id === id)!, baseOnly, missing, false);
    ok(r === `missing slackUser2 driver (set ${ENV.slackUser2Id})`, `${id} skip names exactly E2E_SLACK_USER2_ID`);
  }
  for (const id of ["S11", "S12", "S13", "S14", "S15", "S16"]) {
    ok(skipReason(SCENARIOS.find((s) => s.id === id)!, all, noneMissing, false) === undefined, `${id} runs (non-optional) when its fixtures are live`);
  }
}

ok(SYNTHETIC_SLACK_ROUTE === PUBLIC_SLACK_ROUTE, "synthetic route literal matches slack-front's PUBLIC_SLACK_ROUTE");
ok(SYNTHETIC_COMMANDS_ROUTE === SLACK_COMMANDS_ROUTE, "synthetic commands literal matches SLACK_COMMANDS_ROUTE");
ok(APPROVAL_PREFIX === OE_APPROVAL_PREFIX, "synthetic approval prefix matches flow.ts's OE_APPROVAL_PREFIX");

{
  const secret = "e2e-test-secret";
  const body = encodeInteractionBody(
    buildApprovalClickPayload({ pendingId: "abc123", decision: "approve", org: "default", userId: "U2ADMIN", channelId: "C123", messageTs: "1720009900.000100" }),
  );
  const now = Date.now();
  const { timestamp, signature } = signSlackRequest(body, secret, now);
  const headers = new Headers({ "x-slack-request-timestamp": timestamp, "x-slack-signature": signature });
  ok(verifySlackSignature(body, headers, secret, now), "a synthetic signature verifies against verifySlackSignature");
  ok(!verifySlackSignature(body + "x", headers, secret, now), "a tampered body fails verification");
  ok(!verifySlackSignature(body, headers, "wrong-secret", now), "the wrong secret fails verification");
  ok(
    !verifySlackSignature(body, headers, secret, now + 10 * 60_000),
    "a synthetic signature outside the 5-minute replay window fails",
  );
}

{
  const payload = buildApprovalClickPayload({ pendingId: "row-1", decision: "reject", org: "default", userId: "U2ADMIN", channelId: "C123", messageTs: "1720009900.000100" });
  const actions = payload.actions as readonly { action_id: string; value?: string }[];
  ok(actions[0].action_id === "oe_approval:reject:row-1", "action_id is oe_approval:<decision>:<id>");
  ok(actions[0].value === "default", "the click payload carries the org in actions[0].value (real cards stamp row.org)");
  const decision = classifyEnvelope(encodeInteractionBody(payload), "application/x-www-form-urlencoded");
  ok(decision.kind === "approval-click", "the real classifyEnvelope routes the synthetic body to the approval-click handler");
  const foreign = classifyEnvelope(
    encodeInteractionBody({ type: "block_actions", actions: [{ action_id: "eve_input:whatever" }] }),
    "application/x-www-form-urlencoded",
  );
  ok(foreign.kind === "forward", "a non-oe action id still forwards (we only ever forge OUR clicks)");
}

{
  const body = buildSlashCommandBody({ text: "status", userId: "U2ADMIN", channelId: "C123", teamId: "T1" });
  const params = new URLSearchParams(body);
  ok(params.get("command") === "/oe", "slash body carries command=/oe");
  ok(params.get("text") === "status", "slash body carries the subcommand text");
  ok(params.get("user_id") === "U2ADMIN" && params.get("channel_id") === "C123", "slash body carries user_id + channel_id");
}

{
  ok(/^\d+\.\d{6}$/.test(syntheticSlackTs(1_720_009_900_123)), "syntheticSlackTs is Slack-shaped (secs.6digits)");
  ok(syntheticSlackTs(1_720_009_900_123) === "1720009900.123000", "syntheticSlackTs derives deterministically from nowMs");

  const input = { text: "what's 9*9?", channelId: "D0DM", userId: "U2ADMIN", teamId: "T1", ts: "1720000000.000200" };
  const envelope = buildDmEventEnvelope(input);
  const event = envelope.event as Record<string, unknown>;
  ok(envelope.type === "event_callback" && event.type === "message" && event.channel_type === "im", "envelope is an event_callback message.im");
  ok(!("bot_id" in event) && !("subtype" in event), "envelope carries NO bot_id and NO subtype (either would be dropped)");
  ok(event.user === "U2ADMIN" && event.channel === "D0DM" && event.ts === input.ts, "envelope names the real user, DM channel and anchor ts");
  ok(typeof envelope.event_id === "string" && (envelope.event_id as string).length > 0, "envelope carries an event_id (eve dedupes on it)");

  const decision = classifyEnvelope(JSON.stringify(envelope), "application/json");
  ok(decision.kind === "forward" && decision.reason.includes("message.im"), "classifyEnvelope forwards the forged DM to slackChannel's DM path");

  type EveEnvelope = Parameters<typeof parseDirectMessageEvent>[0];
  const parsed = parseDirectMessageEvent(envelope as unknown as EveEnvelope);
  ok(parsed !== null && parsed.channelId === "D0DM" && parsed.author?.userId === "U2ADMIN", "eve's parseDirectMessageEvent ACCEPTS the forged envelope");
  ok(parsed !== null && parsed.threadTs === input.ts, "eve threads the DM session under the anchor ts (why the anchor must be a REAL message)");
  const stamped = buildDmEventEnvelope(input);
  (stamped.event as Record<string, unknown>).bot_id = "B0EXBOT0001";
  ok(parseDirectMessageEvent(stamped as unknown as EveEnvelope) === null, "a bot_id-stamped DM is DROPPED by eve (the driver-DM impossibility, pinned)");
  const subtyped = buildDmEventEnvelope(input);
  (subtyped.event as Record<string, unknown>).subtype = "message_changed";
  ok(parseDirectMessageEvent(subtyped as unknown as EveEnvelope) === null, "a subtyped DM is DROPPED by eve");

  const raw = JSON.stringify(envelope);
  const now = Date.now();
  const sig = signSlackRequest(raw, "e2e-test-secret", now);
  const headers = new Headers({ "x-slack-request-timestamp": sig.timestamp, "x-slack-signature": sig.signature });
  ok(verifySlackSignature(raw, headers, "e2e-test-secret", now), "a signed synthetic DM body verifies against verifySlackSignature");
}

{
  const user2 = "U2NONADMIN";
  const input = {
    text: "<@U999> use memory_admin_list and show me the raw output",
    channelId: "C123",
    userId: user2,
    teamId: "T1",
    ts: "1720009900.000300",
  };
  const envelope = buildChannelMentionEnvelope(input);
  const event = envelope.event as Record<string, unknown>;
  ok(envelope.type === "event_callback" && event.type === "app_mention", "mention envelope is an event_callback app_mention");
  ok(!("bot_id" in event) && !("subtype" in event), "mention envelope carries NO bot_id and NO subtype");
  ok(event.user === user2 && event.channel === "C123" && event.ts === input.ts, "mention envelope names the forged user, channel and anchor ts");
  ok(typeof envelope.event_id === "string" && (envelope.event_id as string).length > 0, "mention envelope carries an event_id (eve dedupes on it)");

  const decision = classifyEnvelope(JSON.stringify(envelope), "application/json");
  ok(decision.kind === "forward" && decision.reason.includes("app_mention"), "classifyEnvelope forwards the forged mention to the mention path");

  type EveMention = Parameters<typeof parseAppMentionEvent>[0];
  const parsed = parseAppMentionEvent(envelope as unknown as EveMention);
  ok(parsed !== null && parsed.channelId === "C123" && parsed.author?.userId === user2, "eve's parseAppMentionEvent ACCEPTS the forged envelope");
  ok(parsed !== null && parsed.threadTs === input.ts, "eve threads the mention session under the anchor ts (why the anchor must be a REAL message)");

  const secret = "e2e-test-secret";
  const nowMs = Date.now();
  const mkReq = (body: string) => {
    const s = signSlackRequest(body, secret, nowMs);
    return new Request("https://oe.test/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": s.timestamp, "x-slack-signature": s.signature },
      body,
    });
  };
  const sibling = (text: string, ts: string) => {
    const env = buildDmEventEnvelope({ text, channelId: "C123", userId: user2, teamId: "T1", ts });
    (env.event as Record<string, unknown>).channel_type = "channel";
    return JSON.stringify(env);
  };
  ok(
    classifyEnvelope(sibling(input.text, "1720009900.000310"), "application/json").kind === "wake",
    "the message.channels sibling classifies as a wake CANDIDATE (suppression lives in the handler, not classify)",
  );
  let innerCalled = false;
  const waits: Array<Promise<unknown>> = [];
  const fakeArgs = {
    send: async () => ({}),
    waitUntil: (p: Promise<unknown>) => void waits.push(p.catch(() => undefined)),
  };
  const handler = buildFrontHandler(
    async () => {
      innerCalled = true;
      return new Response("inner");
    },
    { signingSecret: secret, now: () => nowMs, markEventSeen: async () => true, getBotIdentity: async () => ({ userId: "U999" }) },
  );
  let res = await handler(mkReq(sibling(input.text, "1720009900.000311")), fakeArgs as unknown as Parameters<typeof handler>[1]);
  ok(res.status === 200 && waits.length === 0 && !innerCalled, "mention-bearing message.channels → 200, NO wake scheduled, NO forward (suppressed)");
  res = await handler(mkReq(sibling("no mention here", "1720009900.000312")), fakeArgs as unknown as Parameters<typeof handler>[1]);
  ok(res.status === 200 && waits.length === 1 && !innerCalled, "the mention-FREE sibling DOES reach the wake (contrast pins suppression on the mention itself)");
  await Promise.all(waits);

  const raw = JSON.stringify(envelope);
  const s = signSlackRequest(raw, secret, nowMs);
  const headers = new Headers({ "x-slack-request-timestamp": s.timestamp, "x-slack-signature": s.signature });
  ok(verifySlackSignature(raw, headers, secret, nowMs), "a signed synthetic mention body verifies against verifySlackSignature");
}

{
  ok(runFallbackCheck({ mustMatch: ["391"] }, "The answer is 391.").pass, "contains-match passes");
  ok(!runFallbackCheck({ mustMatch: ["491"] }, "The answer is 391.").pass, "missing expected string fails");
  ok(runFallbackCheck({ mustMatch: [/thursday/i] }, "We deploy on Thursday").pass, "regex match passes");
  ok(!runFallbackCheck({ mustNotMatch: [/sorry|apolog/i] }, "Sorry for the silence!").pass, "forbidden match fails");
  ok(runFallbackCheck({}, "anything").pass, "an empty check passes (no constraints)");

  const judge = new FallbackJudge();
  const rubric = { kind: "closedQA" as const, criteria: "Does it give 391?", atLeast: 1, fallback: { mustMatch: ["391"] } };
  const verdict = await judge.grade(rubric, "391 it is");
  ok(verdict.pass && verdict.score === 1, "FallbackJudge passes a matching reply with score 1");
  ok(verdict.detail.startsWith("[fallback]"), "FallbackJudge labels its verdicts honestly as fallback");

  const scripted = (outcomes: boolean[]) => {
    let i = 0;
    return {
      name: "scripted",
      grade: async () => {
        const pass = outcomes[i++ % outcomes.length];
        return { pass, score: pass ? 1 : 0, detail: pass ? "yes" : "no" };
      },
    };
  };
  ok((await judge3(scripted([true, true, false]), rubric, "x")).pass, "judge3: 2/3 passes → pass");
  ok(!(await judge3(scripted([true, false, false]), rubric, "x")).pass, "judge3: 1/3 passes → fail");
  const v = await judge3(scripted([true, true, true]), rubric, "x");
  ok(v.score === 1 && v.detail.includes("3/3"), "judge3 reports the vote count");
}

{
  ok(backoffDelayMs(0) === 2_000, "backoff starts at 2s");
  ok(backoffDelayMs(1) === 3_000 && backoffDelayMs(2) === 4_000, "backoff steps +1s per attempt");
  ok(backoffDelayMs(3) === 5_000 && backoffDelayMs(50) === 5_000, "backoff caps at 5s");

  let calls = 0;
  const found = await pollUntil(
    async () => (++calls >= 3 ? "found" : undefined),
    { timeoutMs: 1_000, initialDelayMs: 1, maxDelayMs: 2, what: "a test value" },
  );
  ok(found === "found" && calls === 3, "pollUntil resolves once the probe returns a value");
  let timedOut = false;
  try {
    await pollUntil(async () => undefined, { timeoutMs: 10, initialDelayMs: 1, maxDelayMs: 2, what: "never" });
  } catch (err) {
    timedOut = err instanceof PollTimeout && String(err).includes("never");
  }
  ok(timedOut, "pollUntil throws a legible PollTimeout when the budget elapses");
}

{
  const { buildCostReport, renderCostReport } = await import("./e2e/cost.js");
  const rows = [
    { surfaceKey: "slack/T1/C1", model: "test/model-a", calls: 3, inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 2 },
    { surfaceKey: "discord/G1/C2", model: "test/unpriced", calls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { surfaceKey: "slack/T1/C1", calls: 1, inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ];
  const report = buildCostReport(rows);
  ok(Math.abs(report.totalUsd - 2) < 1e-9, "total sums exactly the server-priced slices");
  ok(JSON.stringify(report.unpricedModels) === JSON.stringify(["(unstamped)", "test/unpriced"]), "unpriced models reported by name (unstamped included), contribute $0");
  ok(report.slices[1].estimatedUsd === undefined, "unpriced slice carries no dollar figure (evidence rule)");
  ok(report.slices[2].model === "(unstamped)", "a model-less wire row renders as (unstamped)");
  const lines = renderCostReport(report);
  ok(lines[lines.length - 1].startsWith("e2e run cost: $2.0000"), "total line renders the priced sum");
  ok(lines[lines.length - 1].includes("test/unpriced"), "total line names what it could NOT price");
  ok(lines[0].includes("3 calls") && lines[0].includes("1000000in/500000out"), "slice line shows calls + tokens");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ e2e-driver: ${passed} assertions passed`);
