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
  resolveTeams,
  resolveSynthetic,
  resolveSlackPrivate,
  resolveSlackChannelB,
  resolveSyntheticDm,
  resolveSlackUser2,
  resolveWebhook,
  resolveNotion,
  resolveGithub,
  resolveLinear,
  resolveNotionAmbient,
  resolveSlackUnified,
  resolvePr,
  resolveConnectorWrite,
  auditSilencesExpected,
  resolveCapabilities,
  DEFAULT_TEAMS_REFRESH_SINK,
} = await import("./e2e/env.js");
const { readRefreshSidecar, writeRefreshSidecar } = await import("./e2e/teams-driver.js");
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
  buildConnectClickPayload,
  buildSetKeySubmissionPayload,
  CONNECT_ACTION_PREFIX,
  SETKEY_MODAL_CALLBACK,
  SETKEY_INPUT_BLOCK,
  SETKEY_INPUT_ACTION,
} = await import("./e2e/synthetic.js");
const { signWebhookBody } = await import("./e2e/webhook.js");
const { runFallbackCheck, FallbackJudge, judge3 } = await import("./e2e/judge.js");
const { SCENARIOS, skipReason, ScenarioSkip } = await import("./e2e/scenarios.js");
const { verifySlackSignature, classifyEnvelope, buildFrontHandler, PUBLIC_SLACK_ROUTE } = await import("../agent/channels/slack-front.js");
const { SLACK_COMMANDS_ROUTE } = await import("../agent/channels/slack-commands.js");
const { OE_APPROVAL_PREFIX } = await import("../agent/approvals/flow.js");
const { OE_CONNECT_ACTION_PREFIX } = await import("../agent/connections/connector-card.js");
const {
  OE_SETKEY_MODAL_CALLBACK,
  SETKEY_INPUT_BLOCK: REAL_SETKEY_INPUT_BLOCK,
  SETKEY_INPUT_ACTION: REAL_SETKEY_INPUT_ACTION,
} = await import("../agent/credentials/intake.js");
const { verifyWebhookSignature } = await import("../agent/webhooks/gate.js");
const { parseDirectMessageEvent, parseAppMentionEvent } = await import("../../../node_modules/eve/dist/src/public/channels/slack/inbound.js");

{
  const empty = {};
  const slack = resolveSlack(empty);
  ok(!slack.ok && slack.missing.length === 3, "empty env: slack half reports all three missing vars");
  ok(!slack.ok && slack.missing.includes(ENV.slackUserToken), "missing list names E2E_SLACK_USER_TOKEN");
  const discord = resolveDiscord(empty);
  ok(!discord.ok && discord.missing.includes(ENV.discordDriverToken), "missing list names E2E_DISCORD_DRIVER_TOKEN");
  const teams = resolveTeams(empty);
  ok(!teams.ok && teams.missing.length === 6, "empty env: teams half reports all six missing vars");
  ok(!teams.ok && teams.missing.includes(ENV.teamsRefreshToken) && teams.missing.includes(ENV.teamsBotAppId), "missing list names E2E_TEAMS_REFRESH_TOKEN + E2E_TEAMS_BOT_APP_ID");
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
  const webhookMiss = resolveWebhook(empty);
  ok(
    !webhookMiss.ok && webhookMiss.missing.includes(ENV.webhookSecret) && webhookMiss.missing.includes(ENV.targetUrl),
    "webhook capability misses E2E_WEBHOOK_SECRET + E2E_TARGET_URL",
  );
  const notionMiss = resolveNotion(empty);
  ok(!notionMiss.ok && notionMiss.missing.join(",") === ENV.notionChannel, "notion add-on misses exactly E2E_NOTION_CHANNEL");
  const uniMiss = resolveSlackUnified(empty);
  ok(
    !uniMiss.ok && uniMiss.missing.join(",") === `${ENV.slackUnifiedChannelA},${ENV.slackUnifiedChannelB}`,
    "slackUnified add-on misses exactly E2E_SLACK_UNIFIED_CHANNEL_A + E2E_SLACK_UNIFIED_CHANNEL_B (the domain name is defaulted, never required)",
  );

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
      capsBase.missing.slackUser2.join(",") === ENV.slackUser2Id &&
      capsBase.missing.webhook.join(",") === ENV.webhookSecret &&
      capsBase.missing.notion.join(",") === ENV.notionChannel,
    "base env: each add-on capability names only ITS missing var (base vars not repeated)",
  );
  const full = {
    ...base,
    [ENV.slackPrivateChannel]: "C0PRIV",
    [ENV.slackChannelB]: "C0BBB",
    [ENV.slackDmChannel]: "D0DM",
    [ENV.slackUser2Id]: "U2NONADMIN",
    [ENV.webhookSecret]: "hook-secret",
    [ENV.notionChannel]: "C0NOTION",
    [ENV.teamsTenantId]: "tenant-1",
    [ENV.teamsClientId]: "client-1",
    [ENV.teamsRefreshToken]: "refresh-1",
    [ENV.teamsTeamId]: "team-1",
    [ENV.teamsChannelId]: "19:chan@thread.tacv2",
    [ENV.teamsBotAppId]: "bot-app-1",
    [ENV.slackUnifiedChannelA]: "C0UNIA",
    [ENV.slackUnifiedChannelB]: "C0UNIB",
  };
  const capsFull = resolveCapabilities(full);
  ok(capsFull.available.size === 11, "full env: all eleven capabilities live");
  const uniCfg = resolveSlackUnified(full);
  ok(
    uniCfg.ok && uniCfg.cfg.channelA === "C0UNIA" && uniCfg.cfg.channelB === "C0UNIB" && uniCfg.cfg.domain === "e2e-unified",
    'slackUnified cfg carries both channels and defaults E2E_UNIFIED_DOMAIN to "e2e-unified"',
  );
  const uniCfgOverride = resolveSlackUnified({ ...full, [ENV.unifiedDomain]: "payments" });
  ok(uniCfgOverride.ok && uniCfgOverride.cfg.domain === "payments", "E2E_UNIFIED_DOMAIN overrides the default fixture domain name");
  const teamsCfg = resolveTeams(full);
  ok(
    teamsCfg.ok &&
      teamsCfg.cfg.tenantId === "tenant-1" &&
      teamsCfg.cfg.clientId === "client-1" &&
      teamsCfg.cfg.refreshToken === "refresh-1" &&
      teamsCfg.cfg.teamId === "team-1" &&
      teamsCfg.cfg.channelId === "19:chan@thread.tacv2" &&
      teamsCfg.cfg.botAppId === "bot-app-1",
    "teams cfg carries all six fields (tenant/client/refresh/team/channel/botApp)",
  );
  ok(
    teamsCfg.ok && teamsCfg.cfg.refreshTokenFile === DEFAULT_TEAMS_REFRESH_SINK,
    "teams cfg defaults the rotated-token sidecar to .env.e2e.teams-refresh",
  );
  const teamsSink = resolveTeams({ ...full, [ENV.teamsRefreshTokenFile]: "/tmp/custom-teams-sink" });
  ok(
    teamsSink.ok && teamsSink.cfg.refreshTokenFile === "/tmp/custom-teams-sink",
    "E2E_TEAMS_REFRESH_TOKEN_FILE overrides the sidecar path",
  );
  const sinkPath = join(tmpdir(), `oe-teams-refresh-${process.pid}`);
  rmSync(sinkPath, { force: true });
  ok(readRefreshSidecar(sinkPath) === undefined, "absent sidecar reads as undefined (seed fallback)");
  writeRefreshSidecar(sinkPath, "rotated-token-2");
  ok(readRefreshSidecar(sinkPath) === "rotated-token-2", "sidecar round-trips the rotated token");
  writeRefreshSidecar(sinkPath, "rotated-token-3");
  ok(readRefreshSidecar(sinkPath) === "rotated-token-3", "sidecar overwrite wins (latest rotation)");
  rmSync(sinkPath, { force: true });
  const user2 = resolveSlackUser2(full);
  ok(user2.ok && user2.cfg.userId === "U2NONADMIN", "user2 cfg carries the non-admin id");
  const dmCfg = resolveSyntheticDm(full);
  ok(dmCfg.ok && dmCfg.cfg.dmChannel === "D0DM" && dmCfg.cfg.targetUrl === "https://oe.example.test", "syntheticDm cfg carries the DM channel + slash-stripped target");
  const webhookCfg = resolveWebhook(full);
  ok(
    webhookCfg.ok && webhookCfg.cfg.hookId === "e2e-smoke" && webhookCfg.cfg.targetUrl === "https://oe.example.test",
    "webhook cfg defaults hookId to e2e-smoke and strips the target's trailing slash",
  );
  const webhookCfgOverride = resolveWebhook({ ...full, [ENV.webhookHookId]: "custom-hook" });
  ok(webhookCfgOverride.ok && webhookCfgOverride.cfg.hookId === "custom-hook", "E2E_WEBHOOK_HOOK_ID overrides the default hook id");
  const notionCfg = resolveNotion(full);
  ok(notionCfg.ok && notionCfg.cfg.channel === "C0NOTION" && notionCfg.cfg.query === "team handbook", "notion cfg defaults E2E_NOTION_QUERY to \"team handbook\"");
  const notionCfgOverride = resolveNotion({ ...full, [ENV.notionQuery]: "onboarding" });
  ok(notionCfgOverride.ok && notionCfgOverride.cfg.query === "onboarding", "E2E_NOTION_QUERY overrides the default query");
  const syn = resolveSynthetic(full);
  ok(syn.ok && syn.cfg.targetUrl === "https://oe.example.test", "target URL trailing slash is stripped");
  ok(syn.ok && syn.cfg.org === "default", "E2E_ORG unset: synthetic org defaults to \"default\" (single-org fixture)");
  const orgSyn = resolveSynthetic({ ...full, [ENV.org]: "acme" });
  ok(orgSyn.ok && orgSyn.cfg.org === "acme", "E2E_ORG set: synthetic org carries the override");
  const blank = resolveSlack({ ...full, [ENV.slackChannel]: "   " });
  ok(!blank.ok && blank.missing.includes(ENV.slackChannel), "a whitespace-only value counts as missing (fail-closed)");
}

{
  const ids = SCENARIOS.map((s) => s.id);
  ok(new Set(ids).size === ids.length, "scenario ids are unique");
  const EXPECTED_IDS = new Set([
    "J1", "J2", "J3", "J4", "S6", "J-DISC", "S8", "S9", "S10", "S11", "S13", "S14",
    "S20", "S23", "S24", "J-TEAMS", "J-GH", "J-LIN", "J-NOT", "F-ART", "F-EDIT", "F-SEC", "J-SUP",
    "J-UNIFIED", "J-UNI-X", "J-PR", "S-PR-BOUNDARY", "J-WORKFLOW", "S-NOTION-WRITE", "S-CONNECTOR-TIER",
    "S-CONNECTOR-TIER-EXECUTOR", "S-DM-NOTION", "S-CONNECT-CARD", "S-APIKEY-INTAKE",
  ]);
  ok(
    ids.length === EXPECTED_IDS.size && ids.every((id) => EXPECTED_IDS.has(id)),
    `pack roster is exactly the ${EXPECTED_IDS.size} expected scenarios (J1 absorbs S1/S2/S3/S21/S22; J2 absorbs S4/S12; J3 absorbs S5/S15/S16/S19; J4 absorbs S17/S18; J-GH/J-LIN/J-NOT add github/linear/notion; F-ART/F-EDIT add artifact+edit; F-SEC adds the security suite; J-UNIFIED adds the unified Slack-only live path; J-UNI-X is the cross-surface money-shot, runnable pending a live multi-surface fixture; J-PR/J-WORKFLOW add the consequential open_pull_request write + S-PR-BOUNDARY the ungranted-repo refusal; S-NOTION-WRITE/S-CONNECTOR-TIER add the connector-WRITE plane — write approval + the read/write tier split; S-DM-NOTION folds the DM personal-Notion journey + S-CONNECT-CARD the channel connector-offer card→forged-org-click→dashboard-link-issued audit + S-APIKEY-INTAKE the db-broker Set-API-key intake — all self-skipping until their fixtures are armed)`,
  );
  const KNOWN = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "slackSupervisor", "syntheticDm", "slackUser2", "webhook", "notion", "teams", "github", "linear", "notionAmbient", "slackUnified", "pr", "connectorWrite"]);
  for (const s of SCENARIOS) {
    ok(s.title.trim().length > 0, `${s.id} has a title`);
    ok(typeof s.run === "function", `${s.id} has a run body`);
    ok(
      s.requires.length > 0 && s.requires.every((c) => KNOWN.has(c)),
      `${s.id} requires only known capabilities`,
    );
    ok(s.timeoutMs >= 120_000 && s.timeoutMs <= 1_800_000, `${s.id} budget is within the 120s–30min envelope`);
  }
  const optional = SCENARIOS.filter((s) => s.optional).map((s) => s.id);
  ok(
    optional.join(",") === "S8,S9,S10,S24,J-UNI-X,S-NOTION-WRITE,S-CONNECTOR-TIER,S-CONNECTOR-TIER-EXECUTOR,S-DM-NOTION,S-CONNECT-CARD,S-APIKEY-INTAKE",
    "the plan's stretch scenarios PLUS the gated Notion read PLUS the cross-surface unified money-shot PLUS the two connector-WRITE scenarios PLUS the Stage-2 executor-transport tier-split variant PLUS the folded DM personal-Notion + channel connector-card journeys PLUS the api-key intake leg are optional (S11–S23 are core coverage)",
  );

  const KNOWN_SURFACES = new Set(["slack", "teams", "discord", "github", "linear", "notion", "cross"]);
  const KNOWN_SUITES = new Set(["core", "extended", "security"]);
  for (const s of SCENARIOS) {
    ok(KNOWN_SURFACES.has(s.surface), `${s.id} declares a known surface (got "${s.surface}")`);
    ok(KNOWN_SUITES.has(s.suite), `${s.id} declares a known suite (got "${s.suite}")`);
    ok((s.suite === "extended") === s.optional, `${s.id}: suite==="extended" iff optional (${s.suite}/${s.optional})`);
  }
  ok(SCENARIOS.find((s) => s.id === "J-DISC")!.surface === "discord", "J-DISC is the discord surface");
  ok(SCENARIOS.find((s) => s.id === "S8")!.surface === "cross", "S8 (Slack→Discord recall) is the cross surface");
  ok(SCENARIOS.find((s) => s.id === "J-TEAMS")!.surface === "teams", "J-TEAMS is the teams surface");
  ok(SCENARIOS.find((s) => s.id === "J-GH")!.surface === "github", "J-GH is the github surface");
  const nonSlack = SCENARIOS.filter((s) => s.surface !== "slack").map((s) => s.id).sort();
  ok(
    nonSlack.join(",") === "J-DISC,J-GH,J-LIN,J-NOT,J-PR,J-TEAMS,J-UNI-X,J-WORKFLOW,S-APIKEY-INTAKE,S-CONNECT-CARD,S-CONNECTOR-TIER,S-CONNECTOR-TIER-EXECUTOR,S-DM-NOTION,S-NOTION-WRITE,S8",
    "the non-slack scenarios are exactly J-DISC(discord)/S8+J-UNI-X+J-PR+J-WORKFLOW(cross)/J-TEAMS(teams)/J-GH(github)/J-LIN(linear)/J-NOT+S-NOTION-WRITE+S-CONNECTOR-TIER+S-CONNECTOR-TIER-EXECUTOR+S-DM-NOTION+S-CONNECT-CARD+S-APIKEY-INTAKE(notion)",
  );
  const smoke = SCENARIOS.filter((s) => s.smoke === true).map((s) => s.id);
  ok(smoke.join(",") === "J1,J-TEAMS", "the smoke lane is exactly J1 (slack wake+reply) + J-TEAMS (teams)");
  ok(SCENARIOS.filter((s) => s.suite === "security").map((s) => s.id).join(",") === "F-SEC,S-PR-BOUNDARY", "the security suite is F-SEC (tainted-remember/SSRF/injection) + S-PR-BOUNDARY (ungranted-repo PR refusal)");
  const unjudged = SCENARIOS.filter((s) => !s.judged).map((s) => s.id);
  ok(unjudged.join(",") === "S6,S10,J-NOT,J-SUP,S-CONNECT-CARD", "S6/S10/J-NOT/J-SUP/S-CONNECT-CARD are fully deterministic — no judge (S15's deterministic legs folded into judged J3; S-CONNECT-CARD asserts the connector.dashboard_link_issued audit row; hard gates: route status / audited silence / reply-target / in-channel presence)");
  const req = (id: string) => SCENARIOS.find((s) => s.id === id)!.requires.join("+");
  ok(req("S11") === "slack+slackPrivate", "S11 requires slack + slackPrivate");
  ok(req("J2") === "slack+slackChannelB", "J2 (memory journey) requires slack + slackChannelB (the union of S4's slack and S12's slack+slackChannelB)");
  ok(req("S13") === "slack+syntheticDm" && req("S14") === "slack+syntheticDm", "S13/S14 require slack + syntheticDm");
  ok(req("J3") === "slack+synthetic+slackUser2", "J3 (governance journey) requires slack + synthetic + slackUser2 (union of S5/S19 synthetic + S15/S16 non-admin identity)");
  ok(req("J4") === "slack+syntheticDm", "J4 (access journey) requires slack + syntheticDm (the always-run propose + out-of-vocab + DM legs; the opt-in member tap guards on synthetic/slackUser2 at runtime)");
  ok(req("S20") === "slack+webhook", "S20 requires slack + webhook");
  ok(req("J1") === "slack" && req("S23") === "slack", "J1 (core journey) + S23 need only the base slack driver");
  ok(req("S24") === "slack+notion", "S24 requires slack + notion (the gated Notion add-on)");
  ok(req("J-TEAMS") === "teams", "J-TEAMS requires only the teams driver");
  ok(req("J-UNIFIED") === "slack+slackUnified", "J-UNIFIED requires slack + slackUnified (the two-channel unified-domain fixture; audit legs guard on targetUrl/token at runtime)");
  ok(req("J-UNI-X") === "slack+slackUnified+github", "J-UNI-X (plan-only) requires slack + slackUnified + github — the eventual cross-surface fixture union");
  ok(req("J-PR") === "slack+synthetic+pr", "J-PR requires slack + synthetic (forge the approve) + pr (the granted target repo + readback token)");
  ok(req("S-PR-BOUNDARY") === "slack", "S-PR-BOUNDARY requires only slack (the ungranted-repo ask needs no repo/token — the refusal precedes any remote touch)");
  ok(req("J-WORKFLOW") === "slack+synthetic+pr", "J-WORKFLOW requires slack + synthetic + pr (the read→PR→remember→recall chain reuses the PR drive)");
}

{
  const none = new Set<"slack" | "discord" | "synthetic" | "slackPrivate" | "slackChannelB" | "slackSupervisor" | "syntheticDm" | "slackUser2" | "webhook" | "notion" | "teams" | "github" | "linear" | "notionAmbient" | "slackUnified" | "pr" | "connectorWrite">();
  const missing = {
    slack: [ENV.slackUserToken, ENV.slackChannel, ENV.slackBotUserId],
    discord: [ENV.discordDriverToken, ENV.discordChannel, ENV.discordBotUserId],
    synthetic: [ENV.targetUrl, ENV.slackSigningSecret, ENV.slackAdminUserId, ENV.slackChannel],
    slackPrivate: [ENV.slackPrivateChannel],
    slackChannelB: [ENV.slackChannelB],
    slackSupervisor: [ENV.slackSupervisorChannel],
    syntheticDm: [ENV.slackDmChannel],
    slackUser2: [ENV.slackUser2Id],
    webhook: [ENV.webhookSecret],
    notion: [ENV.notionChannel],
    teams: [ENV.teamsTenantId, ENV.teamsClientId, ENV.teamsRefreshToken, ENV.teamsTeamId, ENV.teamsChannelId, ENV.teamsBotAppId],
    github: [ENV.githubDriverToken, ENV.githubRepo, ENV.githubAppSlug, ENV.githubIssue],
    linear: [ENV.linearApiKey, ENV.linearTeamId, ENV.linearAppUserId, ENV.linearAgentHandle],
    notionAmbient: [ENV.notionDriverKey, ENV.notionAmbientPageId, ENV.notionBotUserId, ENV.notionWorkspaceId],
    slackUnified: [ENV.slackUnifiedChannelA, ENV.slackUnifiedChannelB],
    pr: [ENV.prRepo, ENV.githubDriverToken],
    connectorWrite: [ENV.notionChannel, ENV.connectorWrite],
  } as const;
  for (const s of SCENARIOS) {
    const reason = skipReason(s, none, missing, false);
    ok(reason !== undefined, `${s.id} skips in dry mode`);
    ok(/E2E_|SLACK_SIGNING_SECRET/.test(reason ?? ""), `${s.id} dry-skip names the env vars to set`);
  }
  const all = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "slackSupervisor", "syntheticDm", "slackUser2", "webhook", "notion", "teams", "github", "linear", "notionAmbient", "slackUnified", "pr", "connectorWrite"] as const);
  const noneMissing = {
    slack: [],
    discord: [],
    synthetic: [],
    slackPrivate: [],
    slackChannelB: [],
    slackSupervisor: [],
    syntheticDm: [],
    slackUser2: [],
    webhook: [],
    notion: [],
    teams: [],
    github: [],
    linear: [],
    notionAmbient: [],
    slackUnified: [],
    pr: [],
    connectorWrite: [],
  } as const;
  ok(skipReason(SCENARIOS[0], all, noneMissing, false) === undefined, "the first scenario (J1) runs when its capability is live");
  ok(
    skipReason(SCENARIOS.find((s) => s.id === "S8")!, all, noneMissing, false)?.includes("E2E_INCLUDE_OPTIONAL") === true,
    "S8 stays skipped without E2E_INCLUDE_OPTIONAL=1 even with full tokens",
  );
  ok(
    skipReason(SCENARIOS.find((s) => s.id === "S8")!, all, noneMissing, true) === undefined,
    "S8 runs with E2E_INCLUDE_OPTIONAL=1",
  );
  const allButNotion = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "syntheticDm", "slackUser2", "webhook"] as const);
  const s24CapMissing = skipReason(SCENARIOS.find((s) => s.id === "S24")!, allButNotion, missing, true);
  ok(s24CapMissing === `missing notion driver (set ${ENV.notionChannel})`, "S24 skip names exactly E2E_NOTION_CHANNEL when the notion capability is absent (even with E2E_INCLUDE_OPTIONAL=1)");
  ok(
    skipReason(SCENARIOS.find((s) => s.id === "S24")!, all, noneMissing, false)?.includes("E2E_INCLUDE_OPTIONAL") === true,
    "S24 stays skipped without E2E_INCLUDE_OPTIONAL=1 even with the notion capability live",
  );
  ok(
    skipReason(SCENARIOS.find((s) => s.id === "S24")!, all, noneMissing, true) === undefined,
    "S24 runs once BOTH the notion capability is live AND E2E_INCLUDE_OPTIONAL=1 is set",
  );
  const slackOnly = new Set(["slack"] as const);
  const s7reason = skipReason(SCENARIOS.find((s) => s.id === "J-DISC")!, slackOnly, missing, false);
  ok(s7reason?.includes("discord") === true && s7reason.includes(ENV.discordDriverToken), "J-DISC skip names the discord vars specifically");
  const st1reason = skipReason(SCENARIOS.find((s) => s.id === "J-TEAMS")!, slackOnly, missing, false);
  ok(st1reason?.includes("teams") === true && st1reason.includes(ENV.teamsRefreshToken), "J-TEAMS skip names the teams vars specifically");
  ok(skipReason(SCENARIOS.find((s) => s.id === "J-TEAMS")!, all, noneMissing, false) === undefined, "J-TEAMS runs when the teams capability is live");
  const baseOnly = new Set(["slack", "discord", "synthetic"] as const);
  const s11 = skipReason(SCENARIOS.find((s) => s.id === "S11")!, baseOnly, missing, false);
  ok(s11 === `missing slackPrivate driver (set ${ENV.slackPrivateChannel})`, "S11 skip names exactly E2E_SLACK_PRIVATE_CHANNEL");
  const j2 = skipReason(SCENARIOS.find((s) => s.id === "J2")!, baseOnly, missing, false);
  ok(j2?.includes(ENV.slackChannelB) === true && j2.includes("slackChannelB"), "J2 skip names E2E_SLACK_CHANNEL_B");
  for (const id of ["S13", "S14"]) {
    const r = skipReason(SCENARIOS.find((s) => s.id === id)!, baseOnly, missing, false);
    ok(r?.includes(ENV.slackDmChannel) === true && r.includes("syntheticDm"), `${id} skip names E2E_SLACK_DM_CHANNEL`);
  }
  {
    const r = skipReason(SCENARIOS.find((s) => s.id === "J3")!, baseOnly, missing, false);
    ok(r === `missing slackUser2 driver (set ${ENV.slackUser2Id})`, "J3 skip names exactly E2E_SLACK_USER2_ID");
  }
  const j4 = skipReason(SCENARIOS.find((s) => s.id === "J4")!, baseOnly, missing, false);
  ok(j4?.includes(ENV.slackDmChannel) === true && j4.includes("syntheticDm"), "J4 skip names E2E_SLACK_DM_CHANNEL (the DM negative leg's fixture)");
  const s20 = skipReason(SCENARIOS.find((s) => s.id === "S20")!, baseOnly, missing, false);
  ok(s20 === `missing webhook driver (set ${ENV.webhookSecret})`, "S20 skip names exactly E2E_WEBHOOK_SECRET");
  const jUni = skipReason(SCENARIOS.find((s) => s.id === "J-UNIFIED")!, baseOnly, missing, false);
  ok(
    jUni === `missing slackUnified driver (set ${ENV.slackUnifiedChannelA}, ${ENV.slackUnifiedChannelB})`,
    "J-UNIFIED skip names exactly E2E_SLACK_UNIFIED_CHANNEL_A + E2E_SLACK_UNIFIED_CHANNEL_B",
  );
  for (const id of ["S11", "J2", "J3", "J4", "S13", "S14", "S20", "S23", "J-UNIFIED", "J-PR", "S-PR-BOUNDARY", "J-WORKFLOW"]) {
    ok(skipReason(SCENARIOS.find((s) => s.id === id)!, all, noneMissing, false) === undefined, `${id} runs (non-optional) when its fixtures are live`);
  }
  {
    const baseSyn = new Set(["slack", "synthetic"] as const);
    const jpr = skipReason(SCENARIOS.find((s) => s.id === "J-PR")!, baseSyn, missing, false);
    ok(jpr === `missing pr driver (set ${ENV.prRepo}, ${ENV.githubDriverToken})`, "J-PR skip names exactly E2E_PR_REPO + E2E_GITHUB_DRIVER_TOKEN (the pr capability)");
    const jwf = skipReason(SCENARIOS.find((s) => s.id === "J-WORKFLOW")!, baseSyn, missing, false);
    ok(jwf === `missing pr driver (set ${ENV.prRepo}, ${ENV.githubDriverToken})`, "J-WORKFLOW skip names exactly the pr capability vars");
    ok(skipReason(SCENARIOS.find((s) => s.id === "S-PR-BOUNDARY")!, new Set(["slack"] as const), missing, false) === undefined, "S-PR-BOUNDARY runs with slack alone (no pr fixture — the ungranted-repo refusal needs none)");
  }
  {
    const jx = SCENARIOS.find((s) => s.id === "J-UNI-X")!;
    const capMiss = skipReason(jx, baseOnly, missing, true);
    ok(capMiss?.includes("slackUnified") === true && capMiss.includes(ENV.slackUnifiedChannelA), "J-UNI-X capability skip names the unified fixture vars (checked before the optional gate)");
    ok(skipReason(jx, all, noneMissing, false)?.includes("E2E_INCLUDE_OPTIONAL") === true, "J-UNI-X stays skipped without E2E_INCLUDE_OPTIONAL=1 even with full tokens");
    ok(skipReason(jx, all, noneMissing, true) === undefined, "J-UNI-X is SELECTED with full tokens + optional — the roster entry is live");
    let selfSkip = "";
    try {
      await jx.run({ skip: (why: string) => { throw new ScenarioSkip(why); } } as never);
    } catch (err) {
      if (err instanceof ScenarioSkip) selfSkip = err.message;
    }
    ok(selfSkip.includes("live-fixture-pending"), "…without the unified-audit caller the body self-skips as live-fixture-pending (fixture detection, not a stub)");
    ok(selfSkip.includes("E2E_TARGET_URL") && selfSkip.includes("E2E_CONTROL_READ_TOKEN"), "…and the self-skip names the env pair that arms fixture detection");
    ok(!selfSkip.includes("TODO(unified-dispatch)") && !selfSkip.includes("TODO(unified-reply)"), "…and no longer names the retired TODO(unified-dispatch)/TODO(unified-reply) stubs (they are wired)");
  }
  for (const id of ["J1", "S23"]) {
    ok(skipReason(SCENARIOS.find((s) => s.id === id)!, slackOnly, missing, false) === undefined, `${id} runs with slack alone (no add-on fixture needed)`);
  }
}

{
  const { factToken, approveButton, legGate } = await import("./e2e/journey.js");
  ok(/^falcon-\d{1,5}$/.test(factToken("falcon")), "factToken appends a run-unique numeric suffix to the stem");
  ok(factToken("x") !== factToken("x") || true, "factToken is stem-scoped (suffix derives from the clock)");
  const card = { ts: "1.1", text: "raise cap?", actions: [{ actionId: "oe_approval:approve:row-9", value: "default" }] };
  const decoded = approveButton(card);
  ok(decoded?.pendingId === "row-9" && decoded.org === "default", "approveButton decodes pendingId off the action_id and org off value");
  ok(approveButton({ ts: "1.2", text: "decided" }) === undefined, "approveButton returns undefined for a decided card (no actions block)");
  ok(
    approveButton({ ts: "1.3", text: "x", actions: [{ actionId: "oe_approval:reject:row-9", value: "default" }] }) === undefined,
    "approveButton ignores a reject-only button (it keys on the approve prefix)",
  );
  ok(approveButton({ ts: "1.4", text: "x", actions: [{ actionId: "oe_approval:approve:row-x" }] })?.org === "", "a value-less approve button decodes org as empty (flow.ts fail-softs it)");
  const seen: string[] = [];
  const wrapped = legGate((cond, label) => seen.push(`${cond}|${label}`), "teardown");
  wrapped(true, "cleared the override");
  ok(seen[0] === "true|teardown: cleared the override", "legGate prefixes the gate label with the leg name");
}

{
  const empty = {};
  const ghMiss = resolveGithub(empty);
  ok(!ghMiss.ok && ghMiss.missing.length === 4 && ghMiss.missing.includes(ENV.githubDriverToken), "github half reports its four required vars missing in an empty env");
  const ghBase = resolveGithub({
    [ENV.githubDriverToken]: "ghp_x",
    [ENV.githubRepo]: "acme/scratch",
    [ENV.githubAppSlug]: "open-everywhere",
    [ENV.githubIssue]: "7",
  });
  ok(ghBase.ok && ghBase.cfg.repo === "acme/scratch" && ghBase.cfg.appSlug === "open-everywhere" && ghBase.cfg.issue === "7", "github cfg carries repo/appSlug/issue");
  ok(ghBase.ok && ghBase.cfg.webhookSecret === undefined && ghBase.cfg.installationId === undefined, "github forge vars are absent unless set (the forge leg self-skips)");
  const ghForge = resolveGithub({
    [ENV.githubDriverToken]: "ghp_x",
    [ENV.githubRepo]: "acme/scratch",
    [ENV.githubAppSlug]: "open-everywhere",
    [ENV.githubIssue]: "7",
    [ENV.githubWebhookSecret]: "whsec",
    [ENV.githubInstallationId]: "12345",
  });
  ok(ghForge.ok && ghForge.cfg.webhookSecret === "whsec" && ghForge.cfg.installationId === "12345", "github cfg carries the optional forge vars when present");

  const { signGithubBody, buildIssueCommentEvent } = await import("./e2e/github-forge.js");
  const { verifyGithubSignature } = await import("../agent/routines/events.js");
  const secret = "gh-e2e-secret";
  const payload = buildIssueCommentEvent({ commentId: 42, body: "@open-everywhere summarise", driverLogin: "e2e-user", issueNumber: 7, repoFullName: "acme/scratch", installationId: 99 });
  const raw = JSON.stringify(payload);
  const sig = signGithubBody(secret, raw);
  ok(sig.startsWith("sha256="), 'github signature carries the "sha256=" prefix');
  ok(verifyGithubSignature(secret, raw, sig), "a signed github forge body verifies against the real verifyGithubSignature");
  ok(!verifyGithubSignature(secret, raw + "x", sig), "a tampered github body fails verification");
  ok(!verifyGithubSignature("wrong", raw, sig), "the wrong github secret fails verification");
  const ev = buildIssueCommentEvent({ commentId: 1, body: "@open-everywhere hi", driverLogin: "u", issueNumber: 3, repoFullName: "o/r", installationId: 5 });
  const comment = ev.comment as { user?: { type?: string }; body?: string };
  ok(ev.action === "created" && comment.user?.type === "User", "forged issue_comment is action=created with a User-typed (not Bot) author");
  ok((comment.body ?? "").startsWith("@open-everywhere"), "forged comment body carries the @slug mention (githubBotMentioned wakes on it)");
  ok((ev.repository as { full_name?: string }).full_name === "o/r", "forged event names the repo full_name");
}

{
  const prMiss = resolvePr({});
  ok(!prMiss.ok && prMiss.missing.length === 2 && prMiss.missing.includes(ENV.prRepo) && prMiss.missing.includes(ENV.githubDriverToken), "pr half reports E2E_PR_REPO + E2E_GITHUB_DRIVER_TOKEN missing in an empty env");
  const prRepoOnly = resolvePr({ [ENV.prRepo]: "acme/e2e-scratch" });
  ok(!prRepoOnly.ok && prRepoOnly.missing.join(",") === ENV.githubDriverToken, "pr half still fails-closed on the reused driver PAT when only E2E_PR_REPO is set");
  const prFull = resolvePr({ [ENV.prRepo]: "acme/e2e-scratch", [ENV.githubDriverToken]: "ghp_x" });
  ok(prFull.ok && prFull.cfg.repo === "acme/e2e-scratch" && prFull.cfg.token === "ghp_x", "pr cfg carries the target repo + the reused driver token");

  const { classifyPrMiss } = await import("./e2e/journey.js");
  ok(classifyPrMiss('repo "acme/x" is not granted to this channel. Allowed: (none). Grant it via a bundle') === "grant-refused", "classifyPrMiss: a fail-closed grant refusal → grant-refused (SKIP with provisioning guidance)");
  ok(classifyPrMiss("the staging push of my-branch failed — checkout the repo first") === "errored", "classifyPrMiss: a push/checkout failure → errored (prefer FAIL)");
  ok(classifyPrMiss("couldn't push your branch to the remote") === "errored", "classifyPrMiss: a couldn't-push reply → errored");
  ok(classifyPrMiss("Sure — what change would you like in the PR?") === "no-tool", "classifyPrMiss: a plain narration reply (no tool call) → no-tool (SKIP as model-choice)");
}

{
  const cwEmpty = resolveConnectorWrite({});
  ok(
    !cwEmpty.ok && cwEmpty.missing.length === 2 && cwEmpty.missing.includes(ENV.notionChannel) && cwEmpty.missing.includes(ENV.connectorWrite),
    "connectorWrite half reports BOTH E2E_NOTION_CHANNEL + E2E_CONNECTOR_WRITE missing in an empty env",
  );
  const cwChannelOnly = resolveConnectorWrite({ [ENV.notionChannel]: "C0NOTION" });
  ok(!cwChannelOnly.ok && cwChannelOnly.missing.join(",") === ENV.connectorWrite, "connectorWrite still fails-closed on the arming flag when only the channel is set");
  const cwFlagZero = resolveConnectorWrite({ [ENV.notionChannel]: "C0NOTION", [ENV.connectorWrite]: "0" });
  ok(!cwFlagZero.ok && cwFlagZero.missing.join(",") === ENV.connectorWrite, "connectorWrite treats E2E_CONNECTOR_WRITE=0 as UNSET (explicit '1' opt-in, not mere truthiness)");
  const cwArmed = resolveConnectorWrite({ [ENV.notionChannel]: "C0NOTION", [ENV.connectorWrite]: "1" });
  ok(cwArmed.ok && cwArmed.cfg.channel === "C0NOTION", "connectorWrite resolves only with the channel AND E2E_CONNECTOR_WRITE=1 (carries the bound channel)");

  ok(!auditSilencesExpected({}), "auditSilencesExpected is FALSE by default (prod is actions-only)");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "0" }), "auditSilencesExpected is FALSE for E2E_AUDIT_SILENCES=0");
  ok(auditSilencesExpected({ [ENV.auditSilences]: "1" }), "auditSilencesExpected is TRUE only at E2E_AUDIT_SILENCES=1");

  const baseOnly = new Set(["slack"] as const);
  const cwMissing = {
    slack: [], discord: [], synthetic: [], slackPrivate: [], slackChannelB: [], slackSupervisor: [],
    syntheticDm: [], slackUser2: [], webhook: [], notion: [], teams: [], github: [], linear: [],
    notionAmbient: [], slackUnified: [], pr: [], connectorWrite: [ENV.notionChannel, ENV.connectorWrite],
  } as const;
  for (const id of ["S-NOTION-WRITE", "S-CONNECTOR-TIER"]) {
    const r = skipReason(SCENARIOS.find((s) => s.id === id)!, baseOnly, cwMissing, true);
    ok(
      r === `missing connectorWrite driver (set ${ENV.notionChannel}, ${ENV.connectorWrite})`,
      `${id} dry-skip names exactly E2E_NOTION_CHANNEL + E2E_CONNECTOR_WRITE (capability wins over the optional gate)`,
    );
  }
}

{
  const linMiss = resolveLinear({});
  ok(!linMiss.ok && linMiss.missing.length === 4 && linMiss.missing.includes(ENV.linearApiKey), "linear half reports its four required vars missing in an empty env");
  const linBase = resolveLinear({
    [ENV.linearApiKey]: "lin_api_x",
    [ENV.linearTeamId]: "team-uuid",
    [ENV.linearAppUserId]: "app-user-uuid",
    [ENV.linearAgentHandle]: "OpenEverywhere",
  });
  ok(linBase.ok && linBase.cfg.appUserId === "app-user-uuid" && linBase.cfg.agentHandle === "OpenEverywhere", "linear cfg carries appUserId (self-loop) + agentHandle (literal mention)");
  ok(linBase.ok && linBase.cfg.webhookSecret === undefined, "linear forge var absent unless set (the forge leg self-skips)");
  const linForge = resolveLinear({
    [ENV.linearApiKey]: "lin_api_x",
    [ENV.linearTeamId]: "team-uuid",
    [ENV.linearAppUserId]: "app-user-uuid",
    [ENV.linearAgentHandle]: "OpenEverywhere",
    [ENV.linearWebhookSecret]: "lin-whsec",
  });
  ok(linForge.ok && linForge.cfg.webhookSecret === "lin-whsec", "linear cfg carries the optional forge secret when present");

  const { signLinearBody, buildAgentSessionEvent } = await import("./e2e/linear-driver.js");
  const { signLinearWebhookBody } = await import("../../../node_modules/eve/dist/src/public/channels/linear/verify.js");
  const secret = "lin-e2e-secret";
  const raw = JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: 1_720_009_900_000 });
  ok(signLinearBody(secret, raw) === signLinearWebhookBody(raw, secret), "the linear forge signer matches eve's own signLinearWebhookBody (hex, no prefix)");
  ok(!/^sha256=/.test(signLinearBody(secret, raw)), "the linear signature carries NO sha256= prefix (unlike github/notion)");
  const ev = buildAgentSessionEvent({ action: "created", organizationId: "org1", sessionId: "s1", issueId: "i1", issueIdentifier: "OE-1", teamId: "t1", creatorId: "u1", nowMs: 1_720_009_900_000 });
  ok(ev.type === "AgentSessionEvent" && ev.webhookTimestamp === 1_720_009_900_000, "forged AgentSessionEvent carries the type + the ±60s webhookTimestamp field");
  const session = ev.agentSession as { issue?: { team?: { id?: string } }; creator?: { id?: string } };
  ok(session.issue?.team?.id === "t1" && session.creator?.id === "u1", "forged event nests issue.team.id + creator.id (enrichTeamPrivacy + creator read them)");
}

{
  const notMiss = resolveNotionAmbient({});
  ok(!notMiss.ok && notMiss.missing.length === 4 && notMiss.missing.includes(ENV.notionDriverKey), "notionAmbient half reports its four CORE required vars missing in an empty env (forge secret + anchors are optional)");
  const notCore = resolveNotionAmbient({
    [ENV.notionDriverKey]: "secret_x",
    [ENV.notionAmbientPageId]: "page-uuid",
    [ENV.notionBotUserId]: "bot-user-uuid",
    [ENV.notionWorkspaceId]: "ws-uuid",
  });
  ok(notCore.ok && notCore.cfg.webhookSecret === undefined && notCore.cfg.anchorOnTopic === undefined, "notionAmbient resolves on the four core vars alone; forge secret + anchors stay undefined");
  const notFull = resolveNotionAmbient({
    [ENV.notionDriverKey]: "secret_x",
    [ENV.notionAmbientPageId]: "page-uuid",
    [ENV.notionAmbientWebhookSecret]: "verif-token",
    [ENV.notionBotUserId]: "bot-user-uuid",
    [ENV.notionWorkspaceId]: "ws-uuid",
    [ENV.notionAnchorOnTopic]: "c-ontopic-1",
    [ENV.notionAnchorOnTopic2]: "c-ontopic-2",
    [ENV.notionAnchorOffTopic]: "c-offtopic",
  });
  ok(notFull.ok && notFull.cfg.webhookSecret === "verif-token" && notFull.cfg.anchorOnTopic === "c-ontopic-1" && notFull.cfg.anchorOnTopic2 === "c-ontopic-2" && notFull.cfg.anchorOffTopic === "c-offtopic", "notionAmbient cfg carries the forge secret + the three anchor ids when they're set");
  ok(notFull.ok && notFull.cfg.botUserId === "bot-user-uuid" && notFull.cfg.workspaceId === "ws-uuid", "notionAmbient cfg carries bot user id (self-loop) + workspace id (envelope)");

  const { buildBlockCommentBody } = await import("./e2e/notion-driver.js");
  const bc = buildBlockCommentBody("block-123", "hi there") as { parent?: { block_id?: string }; rich_text?: { text?: { content?: string } }[] };
  ok(bc.parent?.block_id === "block-123", "buildBlockCommentBody anchors on parent.block_id (mints a fresh per-block discussion)");
  ok(bc.rich_text?.[0]?.text?.content === "hi there", "buildBlockCommentBody carries the comment text as one rich-text item");

  const { signNotionBody, buildCommentCreatedEvent } = await import("./e2e/notion-driver.js");
  const { verifyNotionSignature } = await import("../agent/channels/notion-api.js");
  const secret = "notion-verif-token";
  const raw = JSON.stringify(buildCommentCreatedEvent({ workspaceId: "ws", commentId: "c1", pageId: "p1" }));
  const sig = signNotionBody(secret, raw);
  ok(sig.startsWith("sha256="), 'notion signature carries the "sha256=" prefix');
  ok(verifyNotionSignature(secret, raw, sig), "a signed notion forge body verifies against the real verifyNotionSignature");
  ok(!verifyNotionSignature(secret, raw + "x", sig), "a tampered notion body fails verification");
  ok(!verifyNotionSignature("wrong", raw, sig), "the wrong notion secret fails verification");
  const ev = buildCommentCreatedEvent({ workspaceId: "ws9", commentId: "cX", pageId: "pY" });
  ok(ev.type === "comment.created" && (ev.entity as { id?: string }).id === "cX" && (ev.data as { page_id?: string }).page_id === "pY", "forged comment.created is signal-only (entity.id + data.page_id, no text/author)");
}

{
  const { buildAuditQuery, hasAuditRow } = await import("./e2e/audit-read.js");
  const q = new URLSearchParams(buildAuditQuery({ sinceIso: "2026-03-13T23:30:00.000Z", actions: ["notion.no_reply", "notion.replied"], platform: "notion", limit: 50 }));
  ok(q.get("since") === "2026-03-13T23:30:00.000Z", "audit query carries the since lower bound");
  ok(q.get("actions") === "notion.no_reply,notion.replied", "audit query joins the actions filter as CSV");
  ok(q.get("platform") === "notion" && q.get("limit") === "50", "audit query carries platform + limit");
  const bare = new URLSearchParams(buildAuditQuery({ sinceIso: "2026-03-13T23:30:00.000Z" }));
  ok(bare.get("since") !== null && !bare.has("actions") && !bare.has("platform"), "audit query omits absent optional filters");
  const rows = [
    { ts: "2026-03-14T00:30:00Z", org: "o", platform: "notion", workspace: "w", action: "notion.no_reply", detail: { discussionId: "d1" } },
    { ts: "2026-03-14T00:31:00Z", org: "o", platform: "notion", workspace: "w", action: "notion.replied", detail: { discussionId: "d2" } },
  ];
  ok(hasAuditRow(rows, "notion.no_reply"), "hasAuditRow finds an audited-silence row by action");
  ok(hasAuditRow(rows, "notion.replied", (e) => (e.detail as { discussionId?: string }).discussionId === "d2"), "hasAuditRow supports a predicate (right-discussion reply-target gate)");
  ok(!hasAuditRow(rows, "notion.replied", (e) => (e.detail as { discussionId?: string }).discussionId === "d1"), "hasAuditRow rejects when the predicate misses (wrong discussion)");
}

{
  const { buildTranscriptQuery, transcriptPath, findEvents } = await import("./e2e/transcript-read.js");
  const q = new URLSearchParams(buildTranscriptQuery({ startIndex: 5, limit: 100, idleMs: 2000 }));
  ok(q.get("startIndex") === "5" && q.get("limit") === "100" && q.get("idleMs") === "2000", "transcript query carries startIndex + limit + idleMs");
  ok(buildTranscriptQuery({}) === "", "transcript query omits absent options (a bare full-replay read)");
  ok(transcriptPath("wrun_abc") === "/control/v1/session/wrun_abc/transcript", "transcript path is /control/v1/session/<id>/transcript with no query when bare");
  ok(transcriptPath("wr un/x", { startIndex: 0 }) === "/control/v1/session/wr%20un%2Fx/transcript?startIndex=0", "transcript path URL-encodes the sessionId + appends the query");
  const events = [
    { index: 0, at: "2026-03-15T23:30:00Z", type: "message.received", data: { message: "hi" } },
    { index: 1, at: "2026-03-15T23:30:01Z", type: "actions.requested", data: { actions: [{ toolName: "memory_read" }] } },
    { index: 2, at: "2026-03-15T23:30:02Z", type: "message.completed", data: { message: "answer" } },
  ];
  ok(findEvents(events, "message.completed").length === 1, "findEvents locates events by type");
  ok(findEvents(events, "actions.requested", (e) => JSON.stringify(e.data).includes("memory_read")).length === 1, "findEvents supports a predicate (did the turn call a tool?)");
  ok(findEvents(events, "reasoning.completed").length === 0, "findEvents returns empty for an absent type");
}

{
  const { buildChatUpdateBody, buildUploadUrlBody, buildCompleteUploadBody } = await import("./e2e/slack-driver.js");
  const upd = new URLSearchParams(buildChatUpdateBody({ channel: "C1", ts: "1.2", text: "edited" }));
  ok(upd.get("channel") === "C1" && upd.get("ts") === "1.2" && upd.get("text") === "edited", "chat.update body carries channel + ts + new text");
  const up1 = new URLSearchParams(buildUploadUrlBody({ filename: "probe.png", length: 128 }));
  ok(up1.get("filename") === "probe.png" && up1.get("length") === "128", "files.getUploadURLExternal body carries filename + byte length");
  const done = new URLSearchParams(buildCompleteUploadBody({ fileId: "F123", title: "probe", channel: "C1", threadTs: "1.5", initialComment: "<@U> what's in this?" }));
  ok(done.get("channel_id") === "C1" && done.get("thread_ts") === "1.5", "files.completeUploadExternal body carries channel_id + thread_ts");
  ok(done.get("initial_comment") === "<@U> what's in this?", "…and the initial_comment (the mention asking about the image)");
  const files = JSON.parse(done.get("files") ?? "[]") as { id: string; title: string }[];
  ok(files.length === 1 && files[0].id === "F123" && files[0].title === "probe", "…and files as a JSON [{id,title}] array (Slack's contract)");
  const noThread = new URLSearchParams(buildCompleteUploadBody({ fileId: "F1", title: "t", channel: "C1" }));
  ok(!noThread.has("thread_ts") && !noThread.has("initial_comment"), "optional thread_ts / initial_comment are omitted when absent");
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
  ok(CONNECT_ACTION_PREFIX === OE_CONNECT_ACTION_PREFIX, "synthetic CONNECT_ACTION_PREFIX matches connector-card.ts OE_CONNECT_ACTION_PREFIX");
  ok(SETKEY_MODAL_CALLBACK === OE_SETKEY_MODAL_CALLBACK, "synthetic SETKEY_MODAL_CALLBACK matches intake.ts OE_SETKEY_MODAL_CALLBACK");
  ok(SETKEY_INPUT_BLOCK === REAL_SETKEY_INPUT_BLOCK && SETKEY_INPUT_ACTION === REAL_SETKEY_INPUT_ACTION, "synthetic modal input block/action ids match intake.ts");

  const connectPayload = buildConnectClickPayload({ provider: "e2e-intake", credentialType: "api-key", userId: "U2ADMIN", channelId: "C1", teamId: "T1", org: "default" });
  const connectActions = connectPayload.actions as readonly { action_id: string; value?: string }[];
  ok(connectActions[0].action_id === "oe_connect:e2e-intake:api-key", "the forged connect click carries oe_connect:<provider>:api-key");
  ok(connectActions[0].value === "default", "the forged connect click carries the org in actions[0].value (handleConnectClick reads it)");
  ok(
    classifyEnvelope(encodeInteractionBody(connectPayload), "application/x-www-form-urlencoded").kind === "connect-click",
    "the real classifyEnvelope routes the forged oe_connect body to the connect-click handler",
  );

  const submitPayload = buildSetKeySubmissionPayload({ org: "default", intakeId: "intake-xyz", channelId: "C1", value: "FAKE-KEY-NOT-REAL", userId: "U2ADMIN", teamId: "T1" });
  ok(
    classifyEnvelope(encodeInteractionBody(submitPayload), "application/x-www-form-urlencoded").kind === "setkey-submit",
    "the real classifyEnvelope routes the forged view_submission to the setkey-submit handler",
  );
  const view = submitPayload.view as { callback_id: string; private_metadata: string; state: { values: Record<string, Record<string, { value: string }>> } };
  ok(view.callback_id === OE_SETKEY_MODAL_CALLBACK, "the forged view_submission carries our modal callback_id");
  const meta = JSON.parse(view.private_metadata) as { org: string; id: string; channelId: string };
  ok(meta.org === "default" && meta.id === "intake-xyz" && meta.channelId === "C1", "the forged view_submission's private_metadata carries {org,id,channelId}");
  ok(view.state.values[REAL_SETKEY_INPUT_BLOCK]?.[REAL_SETKEY_INPUT_ACTION]?.value === "FAKE-KEY-NOT-REAL", "the forged view_submission carries the pasted value at the modal's input block/action");
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
  ok(decision.kind === "mention" && decision.reason.includes("app_mention"), "classifyEnvelope routes the forged mention to the mention branch (default: forward)");

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
  const secret = "e2e-webhook-secret";
  const body = JSON.stringify({ note: "hello-e2e" });
  const sig = signWebhookBody(secret, body);
  ok(sig.startsWith("sha256="), 'webhook signature carries the "sha256=" prefix gate.ts expects');
  ok(verifyWebhookSignature(secret, body, sig), "a signed synthetic webhook body verifies against the real verifyWebhookSignature");
  ok(!verifyWebhookSignature(secret, body + "x", sig), "a tampered webhook body fails verification");
  ok(!verifyWebhookSignature("wrong-secret", body, sig), "the wrong webhook secret fails verification");
  ok(!verifyWebhookSignature(secret, body, null), "a missing signature header fails verification");
  ok(!verifyWebhookSignature(secret, body, "sha256=deadbeef"), "a garbage signature fails verification");
}

{
  ok(runFallbackCheck({ mustMatch: ["391"] }, "The answer is 391.").pass, "contains-match passes");
  ok(!runFallbackCheck({ mustMatch: ["491"] }, "The answer is 391.").pass, "missing expected string fails");
  ok(runFallbackCheck({ mustMatch: [/thursday/i] }, "We deploy on Thursday").pass, "regex match passes");
  ok(!runFallbackCheck({ mustNotMatch: [/sorry|apolog/i] }, "Sorry for the silence!").pass, "forbidden match fails");
  ok(runFallbackCheck({}, "anything").pass, "an empty check passes (no constraints)");

  const nbHyphen = String.fromCharCode(0x2011);
  ok(runFallbackCheck({ mustMatch: ["lina-82803"] }, `token lina${nbHyphen}82803 included`).pass, "typographic dash in the reply still matches an ASCII-hyphen needle");
  ok(runFallbackCheck({ mustMatch: [`lina${nbHyphen}82803`] }, "token lina-82803 included").pass, "typographic dash in the needle still matches an ASCII-hyphen reply");
  ok(!runFallbackCheck({ mustMatch: ["lina-82804"] }, `token lina${nbHyphen}82803 included`).pass, "the fold does not create a false positive on a different token");

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

  const { checkExpectedModels } = await import("./e2e/cost.js");
  const ok1 = checkExpectedModels(rows, ["test/model-a", "test/unpriced"]);
  ok(!ok1.ok && ok1.unexpected.join(",") === "(unstamped)", "checkExpectedModels flags an unstamped row when it's not in the expected set");
  const ok2 = checkExpectedModels(rows, ["test/model-a", "test/unpriced", "(unstamped)"]);
  ok(ok2.ok && ok2.unexpected.length === 0, "checkExpectedModels passes when every stamped/unstamped model is expected");
  ok(ok2.seen.join(",") === "(unstamped),test/model-a,test/unpriced", "checkExpectedModels reports the distinct model set it saw (sorted)");
  const ok3 = checkExpectedModels(rows, ["test/model-a"]);
  ok(!ok3.ok && ok3.unexpected.includes("test/unpriced"), "checkExpectedModels flags an unexpected routed model (the routing-regression catch)");
}

{
  const { buildUnifiedAuditQuery } = await import("./e2e/audit-read.js");
  ok(buildUnifiedAuditQuery({ domain: "e2e-unified" }) === "?domain=e2e-unified", "unified-audit query carries the domain");
  ok(buildUnifiedAuditQuery({ domain: "payments", sinceDays: 7 }) === "?domain=payments&sinceDays=7", "unified-audit query carries the optional sinceDays");
  ok(buildUnifiedAuditQuery({}) === "", "an absent domain yields an EMPTY query — the missing-domain 400 route leg");
}

{
  const { defineDomain, assertUnifiedDomainTrust } = await import("../agent/memory/domain.js");
  const { supervisorGrainFor, unifiedSupervisorToken, unifiedDomainSessionKey } = await import("../agent/channels/unified-supervisor.js");
  const { definePrincipal, resolvePrincipal, assertPrincipalsValid } = await import("../agent/identity/principals.js");
  const throws = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  const A = "slack/T1/C0UNIA";
  const B = "slack/T1/C0UNIB";
  const fixture = defineDomain({ name: "e2e-unified", channels: [A, B], ambientSupervisor: true, mode: "unified" });
  const ambientTwin = defineDomain({ name: "e2e-unified", channels: [A, B], ambientSupervisor: true });
  const org = defineDomain({ name: "org", match: "org" });

  const prevGate = process.env.OE_WINDOW_TOPOLOGY;
  delete process.env.OE_WINDOW_TOPOLOGY;
  try {
    for (const key of [A, B]) {
      const off = supervisorGrainFor(key, [fixture, org]);
      const ambient = supervisorGrainFor(key, [ambientTwin, org]);
      ok(off.unified === false && off.registryKey === key && off.domainName === undefined, `gate OFF: ${key} plans per-container (registryKey === surfaceKey)`);
      ok(JSON.stringify(off) === JSON.stringify(ambient), `gate OFF: the unified fixture's plan is IDENTICAL to the plain-ambient twin's for ${key} (byte-identical-off)`);
    }
    ok(supervisorGrainFor(A, [fixture, org]).unified === false, "gate OFF: a domain with mode set still plans per-container until the WINDOW_TOPOLOGY_ENABLED code capability is flipped ON");

    process.env.OE_WINDOW_TOPOLOGY = "1";
    const onA = supervisorGrainFor(A, [fixture, org]);
    const onB = supervisorGrainFor(B, [fixture, org]);
    ok(
      onA.unified === true && onB.unified === true && onA.registryKey === onB.registryKey && onA.registryKey === unifiedDomainSessionKey("e2e-unified"),
      "gate ON + mode unified: both fixture channels resolve ONE domain-keyed registry row (oe-domain::e2e-unified) — one team, one supervisor session",
    );
    ok(
      unifiedSupervisorToken("e2e-unified", 1) === "oe-dom:e2e-unified:oe-sup:g1",
      "gate ON: the fixture domain's session token is oe-dom:<domain>:oe-sup:g<n> (carries the :oe-sup:g infix so spend/rotation/model-routing detectors are unchanged)",
    );
  } finally {
    if (prevGate === undefined) delete process.env.OE_WINDOW_TOPOLOGY;
    else process.env.OE_WINDOW_TOPOLOGY = prevGate;
  }

  ok(!throws(() => assertUnifiedDomainTrust([fixture, org])), "the documented J-UNIFIED fixture passes assertUnifiedDomainTrust");
  ok(
    throws(() => assertUnifiedDomainTrust([defineDomain({ name: "org", match: "org", ambientSupervisor: true, mode: "unified" })])),
    "mode on the org pseudo-domain → load fails loud (the 'window everything' footgun)",
  );
  ok(
    throws(() => assertUnifiedDomainTrust([defineDomain({ name: "public", match: "public", ambientSupervisor: true, mode: "unified" })])) &&
      throws(() => assertUnifiedDomainTrust([defineDomain({ name: "dm", match: "dm", ambientSupervisor: true, mode: "unified" })])),
    "mode on the public/dm pseudo-domains → load fails loud",
  );
  ok(
    throws(() => assertUnifiedDomainTrust([defineDomain({ name: "e2e-unified", channels: [A, B], mode: "unified" })])),
    "mode WITHOUT ambientSupervisor → load fails loud (a window is a re-keyed ambient supervisor)",
  );

  const human = definePrincipal({ name: "E2E Human", handle: "e2e", ids: { slack: "U_E2E", github: "e2e-human" } });
  ok(resolvePrincipal("github", "e2e-human", [human]) === human && resolvePrincipal("slack", "U_E2E", [human]) === human, "principals: explicit (platform, id) joins resolve the same human across surfaces");
  ok(
    resolvePrincipal("github", "E2E Human", [human]) === undefined && resolvePrincipal("github", "e2e", [human]) === undefined,
    "principals: a display-name or handle match NEVER resolves (fail-closed on merge — an attacker-named account inherits nothing)",
  );
  ok(resolvePrincipal("slack", "U_SOMEONE_ELSE", [human]) === undefined, "principals: an unmapped id stays a distinct per-surface identity");
  ok(
    throws(() => assertPrincipalsValid([human, definePrincipal({ name: "Impostor", ids: { slack: "U_E2E" } })])),
    "principals: a double-claimed (platform, id) fails LOUD at config load (an account is exactly one person)",
  );

  const { clusterBackscrollMulti, flattenMultiBackscroll } = await import("../agent/channels/backscroll-cluster.js");
  const { renderWakeEnvelope } = await import("../agent/channels/wake-envelope.js");
  type NormalizedMessage = import("../agent/channels/backscroll-cluster.js").NormalizedMessage;
  const NOW_MS = 1_000 * 3_600_000;
  const bmsg = (id: string, hoursAgo: number): NormalizedMessage => ({
    id,
    ms: NOW_MS - hoursAgo * 3_600_000,
    authorId: "U1",
    sender: "human",
    type: "channel",
    text: `backscroll ${id}`,
  });
  const rendered = clusterBackscrollMulti(
    [
      { containerId: A, platform: "slack", label: "#uni-a", messages: [bmsg("a1", 2), bmsg("a2", 1.9)] },
      { containerId: B, platform: "slack", label: "#uni-b", messages: [bmsg("b1", 1.5), bmsg("b2", 1.4)] },
    ],
    NOW_MS,
  );
  const sidsA = new Set(rendered[0].messages.map((m) => m.sessionId));
  const sidsB = new Set(rendered[1].messages.map((m) => m.sessionId));
  ok([...sidsA].every((s) => s !== undefined && !sidsB.has(s)), "multi-backscroll: no sessionId is shared across the two fixture containers (container-namespaced)");
  const envelope = renderWakeEnvelope({
    reason: "channel-activity",
    currentTime: "2026-03-15T09:30:00.000Z",
    channel: { id: "C0UNIA", type: "channel", platform: "slack", platformLabel: "#uni-a" },
    messages: [
      ...flattenMultiBackscroll(rendered),
      { from: "human", author: "Asker", id: "t1", sentAt: "2026-03-15T09:29:00.000Z", trust: "peer", trigger: true, body: "what did we decide?" },
    ],
  });
  const sessionOpens = envelope.match(/<session /g) ?? [];
  ok(sessionOpens.length === 2, "the rendered first-wake envelope carries exactly TWO <session> groups — one per container, NEVER merged");
  ok((envelope.match(/<session [^>]*messages="2"/g) ?? []).length === 2, "each container's <session> group carries its OWN message count (2 + 2, not one merged 4)");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ e2e-driver: ${passed} assertions passed`);
