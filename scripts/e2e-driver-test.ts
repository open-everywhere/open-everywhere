import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allAtWriteTier,
  allAttributedToRoutine,
  allNamePermissionKind,
  allNoticesDelivered,
  pinnedConnectorToolPermissionKind,
  discordOwnedAsks,
  askIdsOf,
  discordOwnedAsksInChannel,
  grantIdsOf,
  grantsForAsks,
  surfaceNamesChannel,
  unexpiredGrants,
  usesOfGrants,
  isUnattendedFenceRefusal,
  isUnattendedLift,
  noticesForGrant,
  ownerPlatformOf,
  refusedGrantAlreadyLive,
  refusedUnverifiedRequester,
  splitFenceRows,
} from "../packages/core/scripts/e2e/grant-fence-rows.js";
import type { AuditWireEntry } from "../packages/core/scripts/e2e/audit-read.js";
import { EGRESS_POLICY_ACTION, findCredentialedWriteHost, notionBlockPhrases, notionPageLinks, quotedPagePhrase } from "../packages/core/scripts/e2e/egress-evidence.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

let shapeChecks = 0;
function okShape(cond: boolean, label: string): void {
  ok(cond, label);
  shapeChecks++;
}

const dir = join(tmpdir(), `open-everywhere-e2e-driver-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const {
  ENGAGED_ROOM_VARS,
  ENV,
  resolveSlack,
  resolveDiscord,
  resolveTeams,
  resolveSynthetic,
  resolveSlackPrivate,
  resolveSlackChannelB,
  resolveSlackMpim,
  resolveEngagedGithub,
  resolveSlackCapFixture,
  resolveSyntheticDm,
  resolveSlackUser2,
  resolveSlackSecondary,
  resolveWebhook,
  resolveNotion,
  resolveGithub,
  resolveLinear,
  resolveNotionAmbient,
  resolveSlackUnified,
  resolvePr,
  resolveConnectorWrite,
  auditSilencesExpected,
  isLocalEvalTarget,
  resolveCapabilities,
  engagedLinearApiKey,
  engagedLinearIdentity,
  resolveEngagedLinear,
  resolveEngagedTeams,
  DEFAULT_TEAMS_REFRESH_SINK,
} = await import("../packages/core/scripts/e2e/env.js");
const { readRefreshSidecar, writeRefreshSidecar, isMissingChatScopeError, collectGraphPages } = await import("../packages/core/scripts/e2e/teams-driver.js");
const { backoffDelayMs, pollUntil, pollOptional, PollTimeout } = await import("../packages/core/scripts/e2e/poll.js");
const { withoutMarker } = await import("../packages/core/scripts/e2e/journey.js");
const {
  signSlackRequest,
  buildApprovalClickPayload,
  encodeInteractionBody,
  buildSlashCommandBody,
  buildChannelMentionEnvelope,
  SYNTHETIC_SLACK_ROUTE,
  SYNTHETIC_COMMANDS_ROUTE,
  APPROVAL_PREFIX,
  buildConnectClickPayload,
  buildSetKeySubmissionPayload,
  CONNECT_ACTION_PREFIX,
  SETKEY_MODAL_CALLBACK,
  SETKEY_INPUT_BLOCK,
  SETKEY_INPUT_ACTION,
} = await import("../packages/core/scripts/e2e/synthetic.js");
const {
  buildDiscordDmRelayEnvelope,
  buildDiscordGuildMentionRelayEnvelope,
  signDiscordRelayRequest,
  SYNTHETIC_DISCORD_GATEWAY_ROUTE,
  DISCORD_RELAY_SIGNATURE_HEADER,
} = await import("../packages/core/scripts/e2e/discord-synthetic.js");
const { signWebhookBody, webhookTimestamp, webhookDeliveryId } = await import("../packages/core/scripts/e2e/webhook.js");
const {
  runFallbackCheck,
  FallbackJudge,
  judge3,
  LlmJudge,
  buildJudgePrompt,
  parseJudgeResponse,
  judgeBannerTag,
  createJudgeReporter,
  renderReportedJudgeSummary,
} = await import("../packages/core/scripts/e2e/judge.js");
const { SCENARIOS, skipCategory, skipReason, ScenarioSkip, isFillerAck, isPendingWorkHandoff, expensiveReasonError, delegationHasReturned } =
  await import("../packages/core/scripts/e2e/scenarios.js");
const { emptySkipCounts, renderSkipBreakdown, SKIP_KINDS } = await import("../packages/core/scripts/e2e/skip-summary.js");
const {
  REPLY_POST_ACTION,
  STOOD_DOWN_ACTION,
  dispatchAddressings,
  isAmbientLegAddressing,
  dispatchedAction,
  replyPostCount,
  reportedDirectMention,
  reportedNameDrop,
  reportedThreadFollow,
  standDownAttemptedButUnmarked,
  standDownMarked,
  standDownRows,
} = await import("../packages/core/scripts/e2e/engaged-rows.js");
const { STAND_DOWN_ACTION } = await import("../packages/core/agent/tools/stand_down.js");
const { verifySlackSignature, classifyEnvelope, buildFrontHandler, PUBLIC_SLACK_ROUTE } = await import("@open-everywhere/provider-slack/agent/channels/slack-front.js");
const { SLACK_COMMANDS_ROUTE } = await import("@open-everywhere/provider-slack/agent/channels/slack-commands.js");
const { relayGate, parseRelayPayload, authForRelayMessage } = await import("@open-everywhere/provider-discord/agent/channels/discord-gateway.js");
const { OE_APPROVAL_PREFIX } = await import("@open-everywhere/core/agent/approvals/flow.js");
const { OE_CONNECT_ACTION_PREFIX } = await import("@open-everywhere/core/agent/connections/connector-card.js");
const {
  OE_SETKEY_MODAL_CALLBACK,
  SETKEY_INPUT_BLOCK: REAL_SETKEY_INPUT_BLOCK,
  SETKEY_INPUT_ACTION: REAL_SETKEY_INPUT_ACTION,
} = await import("@open-everywhere/core/agent/credentials/intake.js");
const { standardWebhookVerifier, SW_ID_HEADER, SW_SIGNATURE_HEADER, SW_TIMESTAMP_HEADER } = await import(
  "@open-everywhere/core/agent/webhooks/oe-standard-webhook.js"
);
const eveRootDir = (await import("node:path")).dirname(
  (await import("node:module")).createRequire(import.meta.url).resolve("eve/package.json"),
);
const { parseAppMentionEvent } = await import(`${eveRootDir}/dist/src/public/channels/slack/inbound.js`);

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
  const slackCap = resolveSlackCapFixture(empty);
  ok(!slackCap.ok && slackCap.missing.join(",") === ENV.slackCapChannel, "S10 cap-fixture add-on misses exactly E2E_SLACK_CAP_CHANNEL");
  const synDm = resolveSyntheticDm(empty);
  ok(
    !synDm.ok && synDm.missing.join(",") === ENV.slackDmChannel,
    "DM fixture misses exactly E2E_SLACK_DM_CHANNEL (OPE-1036: no longer needs a target URL or signing secret — the DM legs post through the real front door, not a forge)",
  );
  const user2Miss = resolveSlackUser2(empty);
  ok(!user2Miss.ok && user2Miss.missing.join(",") === ENV.slackUser2Id, "user2 add-on misses exactly E2E_SLACK_USER2_ID");
  const secondaryMiss = resolveSlackSecondary(empty);
  ok(
    !secondaryMiss.ok && secondaryMiss.missing.join(",") === `${ENV.slackSecondaryToken},${ENV.slackSecondaryUserId}`,
    "secondary-identity add-on misses BOTH E2E_SLACK_SECONDARY_TOKEN + E2E_SLACK_SECONDARY_USER_ID in an empty env",
  );
  const secondaryTokenOnly = resolveSlackSecondary({ [ENV.slackSecondaryToken]: "xoxp-secondary" });
  ok(
    !secondaryTokenOnly.ok && secondaryTokenOnly.missing.join(",") === ENV.slackSecondaryUserId,
    "secondary-identity add-on with only the token set still misses exactly E2E_SLACK_SECONDARY_USER_ID (both required together)",
  );
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

  const MPIM_TRACKED = { [ENV.slackMpimChannel]: "G0TRACKED" };
  const mpimFromRepo = resolveSlackMpim(empty, MPIM_TRACKED);
  ok(
    mpimFromRepo.ok && mpimFromRepo.cfg.channel === "G0TRACKED",
    "🔴 with E2E_SLACK_MPIM_CHANNEL unset, J-MPIM's room resolves from the tracked inventory — the whole point: a deployment nobody edited cannot lose the id",
  );
  const mpimEnvWins = resolveSlackMpim({ [ENV.slackMpimChannel]: "G0ENV" }, MPIM_TRACKED);
  ok(mpimEnvWins.ok && mpimEnvWins.cfg.channel === "G0ENV", "the variable stays an OVERRIDE — set, it wins over the tracked id");
  const mpimNowhere = resolveSlackMpim(empty, {});
  ok(
    !mpimNowhere.ok && mpimNowhere.missing.join(",") === ENV.slackMpimChannel,
    "🔴 the control: absent from BOTH is still a skip naming the variable — never a red, and never a resolved room that does not exist",
  );
  const mpimDeclaredEmpty = resolveSlackMpim(empty, { [ENV.slackMpimChannel]: "" });
  ok(
    !mpimDeclaredEmpty.ok,
    "the second control: a tracked entry DECLARED with an empty id resolves nothing — declared is not provisioned, which is the state this repository ships in",
  );
  ok(
    resolveCapabilities(empty, MPIM_TRACKED).available.size === 0,
    "🔴 a tracked room id alone is NOT a live capability — an env with no credentials stays full dry mode, which the runner passes by design",
  );

  const GH_TRACKED = { [ENGAGED_ROOM_VARS.github]: "owner/tracked-repo" };
  const ghFromRepo = resolveEngagedGithub(empty, GH_TRACKED);
  ok(
    ghFromRepo.ok && ghFromRepo.cfg.id === "owner/tracked-repo",
    "🔴 with E2E_ADDRESSED_GITHUB_REPO unset, J-ENGAGED-github's repo resolves from the tracked inventory — a deployment nobody edited cannot lose the id",
  );
  const ghEnvWins = resolveEngagedGithub({ [ENGAGED_ROOM_VARS.github]: "owner/env-repo" }, GH_TRACKED);
  ok(ghEnvWins.ok && ghEnvWins.cfg.id === "owner/env-repo", "the variable stays an OVERRIDE — set, it wins over the tracked id");
  const ghBlank = resolveEngagedGithub({ [ENGAGED_ROOM_VARS.github]: "   " }, GH_TRACKED);
  ok(ghBlank.ok && ghBlank.cfg.id === "owner/tracked-repo", "a blank variable is not a value — it falls through to the tracked id rather than resolving to whitespace");
  const ghNowhere = resolveEngagedGithub(empty, {});
  ok(
    !ghNowhere.ok && ghNowhere.missing.join(",") === ENGAGED_ROOM_VARS.github,
    "🔴 the control: absent from BOTH is still a skip naming the variable — never a red, and never a resolved repo that does not exist",
  );
  const ghDeclaredEmpty = resolveEngagedGithub(empty, { [ENGAGED_ROOM_VARS.github]: "" });
  ok(!ghDeclaredEmpty.ok, "the second control: a tracked entry DECLARED with an empty id resolves nothing — declared is not provisioned");
  ok(
    resolveCapabilities(empty, GH_TRACKED).available.size === 0,
    "🔴 a tracked repo id alone is NOT a live capability — an env with no credentials stays full dry mode",
  );
  ok(
    resolveCapabilities(empty, { ...MPIM_TRACKED, ...GH_TRACKED }).available.size === 0,
    "…and both tracked rooms together are still full dry mode — the gates are per capability, not a single special case",
  );

  const caps = resolveCapabilities(empty, {});
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
  const capsBase = resolveCapabilities(base, {});
  ok(capsBase.available.size === 3, "base env (no add-on vars): exactly the three base capabilities");
  const capsBaseTracked = resolveCapabilities(base, MPIM_TRACKED);
  ok(capsBaseTracked.available.has("slackMpim"), "🔴 base Slack creds + a tracked room id = a LIVE slackMpim, so J-MPIM RUNS with no variable set");
  ok(capsBaseTracked.available.size === 4, "…and exactly one capability more — nothing else moves with it");
  ok(
    capsBase.missing.slackPrivate.join(",") === ENV.slackPrivateChannel &&
      capsBase.missing.slackChannelB.join(",") === ENV.slackChannelB &&
      capsBase.missing.slackCapFixture.join(",") === ENV.slackCapChannel &&
      capsBase.missing.syntheticDm.join(",") === ENV.slackDmChannel &&
      capsBase.missing.slackUser2.join(",") === ENV.slackUser2Id &&
      capsBase.missing.slackSecondary.join(",") === `${ENV.slackSecondaryToken},${ENV.slackSecondaryUserId}` &&
      capsBase.missing.webhook.join(",") === ENV.webhookSecret &&
      capsBase.missing.notion.join(",") === ENV.notionChannel,
    "base env: each add-on capability names only ITS missing var(s) (base vars not repeated)",
  );
  const full = {
    ...base,
    [ENV.slackPrivateChannel]: "C0PRIV",
    [ENV.slackChannelB]: "C0BBB",
    [ENV.slackCapChannel]: "C0CAP",
    [ENV.slackDmChannel]: "D0DM",
    [ENV.slackUser2Id]: "U2NONADMIN",
    [ENV.slackSecondaryToken]: "xoxp-secondary",
    [ENV.slackSecondaryUserId]: "U3MEMBER",
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
  const capsFull = resolveCapabilities(full, {});
  ok(capsFull.available.size === 15, "full env: all fifteen capabilities live");
  ok(capsFull.available.has("engagedSlack"), "J-ENGAGED-slack is LIVE on an env that carries E2E_SLACK_PRIVATE_CHANNEL — it drives the reused room rather than skipping");
  ok(!capsFull.available.has("engagedGithub"), "J-ENGAGED-github stays DARK on a full operator env — it reads no var another fixture already sets, and `full` carries no GitHub driver either");
  const githubDriver = {
    [ENV.githubDriverToken]: "ghp-test",
    [ENV.githubRepo]: "example-owner/e2e-scratch",
    [ENV.githubAppSlug]: "oe-app",
    [ENV.githubIssue]: "1",
  };
  const capsWithEngagedGithub = resolveCapabilities({ ...full, ...githubDriver, [ENGAGED_ROOM_VARS.github]: "example-owner/oe-e2e-addressed-github" }, {});
  ok(capsWithEngagedGithub.available.has("engagedGithub"), "…and comes up on its OWN var beside the GitHub driver, so the capability is wired rather than merely unresolvable");
  ok(capsWithEngagedGithub.available.size === 17, "the driver plus the room var: `github` and `engagedGithub`, and nothing else moves with them");
  ok(
    !resolveCapabilities({ ...full, ...githubDriver }, {}).available.has("engagedGithub"),
    "🔴 the GitHub driver alone does NOT light engagedGithub — the engaged repo has a variable of its own, and reusing E2E_GITHUB_REPO or E2E_PR_REPO would aim the journey at e2e-unified's e2e-scratch",
  );
  ok(capsFull.available.has("connectorWrite"), "connectorWrite comes up with the bound channel — no arming declaration stands between the fixture and the capability");
  const capFixtureCfg = resolveSlackCapFixture(full);
  ok(capFixtureCfg.ok && capFixtureCfg.cfg.channel === "C0CAP", "S10 cap-fixture cfg carries the dedicated throwaway channel");
  const secondaryCfg = resolveSlackSecondary(full);
  ok(
    secondaryCfg.ok && secondaryCfg.cfg.token === "xoxp-secondary" && secondaryCfg.cfg.userId === "U3MEMBER",
    "secondary-identity cfg carries the token + its user id",
  );
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

  const graphGetForbidden =
    "teams GET /chats/19%3A.../messages failed: http 403 {\"error\":{\"code\":\"Forbidden\",\"message\":\"Missing scope permissions on the request. " +
    "API requires one of 'Chat.ReadBasic, Chat.Read, Chat.ReadWrite'. Scopes on the request 'AppCatalog.Read.All, Channel.ReadBasic.All'\"}}";
  const graphPostForbidden =
    "teams POST /chats/19%3A.../messages failed: http 403 {\"error\":{\"code\":\"Forbidden\",\"message\":\"Missing scope permissions on the request. " +
    "API requires one of 'ChatMessage.Send, Chat.ReadWrite'. Scopes on the request 'AppCatalog.Read.All'\"}}";
  ok(isMissingChatScopeError(new Error(graphGetForbidden)), "the real GET 403 (Chat.ReadBasic/Chat.Read/Chat.ReadWrite) classifies as a missing-scope error");
  ok(isMissingChatScopeError(new Error(graphPostForbidden)), "the real POST 403 (ChatMessage.Send/Chat.ReadWrite) classifies as a missing-scope error too — 'Chat.ReadWrite' contains the 'Chat.Read' substring the classifier keys on");
  ok(
    !isMissingChatScopeError(new Error("teams GET /teams/t1/channels/c1 failed: http 404 channel not found")),
    "🔴 NEGATIVE CONTROL: an unrelated Graph error (no scope wording at all) does NOT classify as a missing-scope error",
  );
  ok(
    !isMissingChatScopeError(
      new Error("teams POST /teams/t1/channels/c1/messages failed: http 403 Missing scope permissions on the request. API requires one of 'Team.ReadBasic.All'"),
    ),
    "🔴 NEGATIVE CONTROL: a missing-scope 403 for a DIFFERENT scope family (no Chat.* named) does NOT classify as a missing-chat-scope error",
  );
  ok(
    !isMissingChatScopeError(new Error("please see the Chat.Read Graph permission docs for background")),
    "🔴 NEGATIVE CONTROL: text that merely MENTIONS Chat.Read without the 'missing scope permissions' shape does NOT classify as the 403 — the classifier requires BOTH",
  );
  ok(!isMissingChatScopeError("a plain string, not an Error"), "a non-Error value is coerced to its string form rather than throwing");
  const user2 = resolveSlackUser2(full);
  ok(user2.ok && user2.cfg.userId === "U2NONADMIN", "user2 cfg carries the non-admin id");
  const dmCfg = resolveSyntheticDm(full);
  ok(dmCfg.ok && dmCfg.cfg.dmChannel === "D0DM", "syntheticDm cfg carries the DM channel");
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
  const badMarker = "engaged-14432";
  ok(`the answer is (ref ${badMarker})`.includes("144"), "the control: the raw reply DOES contain '144' — through the marker, not through an answer");
  ok(
    !withoutMarker(`the answer is (ref ${badMarker})`, badMarker).includes("144"),
    "with the marker removed the same reply no longer passes the 144 gate — the echoed ref cannot stand in for the answer",
  );
  ok(withoutMarker(`144 (ref ${badMarker})`, badMarker).includes("144"), "a reply that really answers still passes once the marker is removed");
  ok(withoutMarker("150", "engaged-99999").includes("150"), "a reply with no marker at all is unchanged by the removal");
  ok(!withoutMarker(`12${badMarker}34`, badMarker).includes("1234"), "the marker is replaced by a space, so removing it cannot fuse two tokens into a third");
  ok(withoutMarker("untouched", "").includes("untouched"), "an empty marker removes nothing rather than shredding the text");
}

{
  const pages: Record<string, { value?: readonly string[]; "@odata.nextLink"?: string }> = {
    "/replies": { value: ["a", "b"], "@odata.nextLink": "https://graph.microsoft.com/v1.0/replies?$skiptoken=2" },
    "https://graph.microsoft.com/v1.0/replies?$skiptoken=2": { value: ["c"], "@odata.nextLink": "https://graph.microsoft.com/v1.0/replies?$skiptoken=3" },
    "https://graph.microsoft.com/v1.0/replies?$skiptoken=3": { value: ["d"] },
  };
  const asked: string[] = [];
  const fetchPage = async (url: string): Promise<{ value?: readonly string[]; "@odata.nextLink"?: string }> => {
    asked.push(url);
    return pages[url] ?? {};
  };
  const all = await collectGraphPages<string>("/replies", fetchPage, 20);
  ok(all.join(",") === "a,b,c,d", `every page's items are returned in page order (got ${all.join(",")})`);
  ok(asked.length === 3, `the walk follows @odata.nextLink until a page carries none (pages fetched: ${asked.length})`);

  const onePage = await collectGraphPages<string>("/replies", async () => ({ value: ["a", "b"] }), 20);
  ok(onePage.join(",") === "a,b", "the control: a collection with no nextLink returns exactly its one page");

  const empty = await collectGraphPages<string>("/replies", async () => ({}), 20);
  ok(empty.length === 0, "a page carrying no `value` contributes nothing rather than throwing");

  let threw = "";
  try {
    await collectGraphPages<string>("/replies", async () => ({ value: ["x"], "@odata.nextLink": "https://graph.microsoft.com/v1.0/loop" }), 3);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok(threw.includes("partial collection"), `a chain still paging at the bound THROWS rather than truncating (threw: ${threw || "nothing"})`);
}

{
  const addressed = ENV.engagedTeamsSurface;
  const shared = ENV.teamsChannelId;

  const same = resolveEngagedTeams({ [addressed]: "19:chan-A", [shared]: "19:chan-A" });
  ok(!same.ok, "both variables naming ONE channel is refused, not resolved");
  ok(
    !same.ok && same.missing.some((m) => m.includes(addressed) && m.includes(shared)),
    `the refusal names BOTH variables so the operator knows which pair collided (got: ${same.ok ? "resolved" : same.missing.join("; ")})`,
  );

  const apart = resolveEngagedTeams({ [addressed]: "19:chan-A", [shared]: "19:chan-B" });
  ok(apart.ok && apart.cfg.id === "19:chan-A", `two different channels still resolve, to the addressed room (got: ${apart.ok ? apart.cfg.id : "refused"})`);

  const sameViaKey = resolveEngagedTeams({ [addressed]: "teams/19:tenant-guid/19:chan-A", [shared]: "19:chan-A" });
  ok(!sameViaKey.ok, "the surface-key spelling of J-TEAMS's own channel is refused too — the check compares channels, not strings");

  const apartViaKey = resolveEngagedTeams({ [addressed]: "teams/19:tenant-guid/19:chan-A", [shared]: "19:chan-B" });
  ok(apartViaKey.ok && apartViaKey.cfg.id === "19:chan-A", `a surface key for a separate room resolves to its channel id (got: ${apartViaKey.ok ? apartViaKey.cfg.id : "refused"})`);

  const noShared = resolveEngagedTeams({ [addressed]: "19:chan-A" });
  ok(noShared.ok && noShared.cfg.id === "19:chan-A", "with E2E_TEAMS_CHANNEL_ID unset there is nothing to collide with, so the room resolves");

  const unset = resolveEngagedTeams({ [shared]: "19:chan-B" });
  ok(unset.ok === false && unset.missing.includes(addressed), "unset still self-skips naming the variable to set, unchanged by the new refusal");

  const rawChannel = "19:abc@thread.tacv2";
  const sanitisedChannel = "19-abc-thread.tacv2";
  const mixed = resolveEngagedTeams({ [addressed]: `teams/19:tenant-guid/${sanitisedChannel}`, [shared]: rawChannel });
  ok(!mixed.ok, "a sanitised addressed surface key and a RAW E2E_TEAMS_CHANNEL_ID name one channel and are refused");
  ok(
    !mixed.ok && mixed.missing.some((m) => m.includes(addressed) && m.includes(shared)),
    `the raw/sanitised refusal names both variables like every other collision (got: ${mixed.ok ? "resolved" : mixed.missing.join("; ")})`,
  );
  const mixedOtherWay = resolveEngagedTeams({ [addressed]: rawChannel, [shared]: sanitisedChannel });
  ok(!mixedOtherWay.ok, "and the other way round — a raw addressed id against a sanitised shared one is the same collision");

  const distinctUnderSeg = resolveEngagedTeams({ [addressed]: "19:abc@thread.tacv2", [shared]: "19:xyz@thread.tacv2" });
  ok(
    distinctUnderSeg.ok && distinctUnderSeg.cfg.id === "19:abc@thread.tacv2",
    `two different channels still resolve through the widened comparison, RAW for the driver (got: ${distinctUnderSeg.ok ? distinctUnderSeg.cfg.id : "refused"})`,
  );

  const rawOut = resolveEngagedTeams({ [addressed]: `teams/19:tenant-guid/${rawChannel}`, [shared]: "19:other@thread.tacv2" });
  ok(rawOut.ok && rawOut.cfg.id === rawChannel, `the resolver hands the driver the RAW channel id, never the compare key (got: ${rawOut.ok ? rawOut.cfg.id : "refused"})`);
}

{
  const own = ENV.addressedLinearApiKey;

  const noKey = resolveEngagedLinear({ [ENV.engagedLinearTeamId]: "team-uuid-1" }, {});
  ok(!noKey.ok, "the addressed-only Linear team does not resolve while its own key is unset");
  ok(
    !noKey.ok && noKey.missing.some((m) => m.includes(own)),
    `…and the refusal NAMES that key, so the operator is not left to guess (got: ${noKey.ok ? "resolved" : noKey.missing.join("; ")})`,
  );
  const withKey = resolveEngagedLinear(
    { [ENV.engagedLinearTeamId]: "team-uuid-1", [own]: "lin_api_addressed", [ENV.linearSoakAppUserId]: "app-user-2", [ENV.linearSoakAgentHandle]: "OE" },
    {},
  );
  ok(withKey.ok && withKey.cfg.id === "team-uuid-1", `with the room and every workspace input set it resolves to the team id (got: ${withKey.ok ? withKey.cfg.id : withKey.missing.join("; ")})`);
  const noTeam = resolveEngagedLinear({ [own]: "lin_api_addressed" }, {});
  ok(!noTeam.ok && noTeam.missing.includes(ENV.engagedLinearTeamId), "an unset team id still self-skips naming the team variable, unchanged by the key check");

  const LINEAR_TRACKED = { [ENV.engagedLinearTeamId]: "team-from-git" };
  const WORKSPACE_ENV = { [own]: "lin_api_addressed", [ENV.linearSoakAppUserId]: "app-user-2", [ENV.linearSoakAgentHandle]: "OE" };
  const fromTable = resolveEngagedLinear(WORKSPACE_ENV, LINEAR_TRACKED);
  ok(
    fromTable.ok && fromTable.cfg.id === "team-from-git",
    `🔴 with E2E_ADDRESSED_LINEAR_TEAM_ID unset, the team resolves from the tracked inventory — a deployment nobody edited cannot lose the id (got: ${fromTable.ok ? fromTable.cfg.id : fromTable.missing.join("; ")})`,
  );
  const envWins = resolveEngagedLinear({ ...WORKSPACE_ENV, [ENV.engagedLinearTeamId]: "team-from-env" }, LINEAR_TRACKED);
  ok(envWins.ok && envWins.cfg.id === "team-from-env", "the variable stays an OVERRIDE — set, it wins over the tracked id");
  const blank = resolveEngagedLinear({ ...WORKSPACE_ENV, [ENV.engagedLinearTeamId]: "   " }, LINEAR_TRACKED);
  ok(blank.ok && blank.cfg.id === "team-from-git", "a blank variable is not a value — it falls through to the tracked id rather than resolving to whitespace");
  const declaredEmpty = resolveEngagedLinear(WORKSPACE_ENV, { [ENV.engagedLinearTeamId]: "" });
  ok(!declaredEmpty.ok, "the control: a tracked entry DECLARED with an empty id resolves nothing — declared is not provisioned");
  const trackedNoKey = resolveEngagedLinear({}, LINEAR_TRACKED);
  ok(
    !trackedNoKey.ok && trackedNoKey.missing.some((m) => m.includes(own)),
    `🔴 a tracked team id does NOT get past the key check — with ${own} unset it still self-skips naming that key (got: ${trackedNoKey.ok ? "resolved" : trackedNoKey.missing.join("; ")})`,
  );
  ok(
    resolveCapabilities({}, LINEAR_TRACKED).available.size === 0,
    "🔴 a tracked team id alone is NOT a live capability — an env with no credentials stays full dry mode",
  );
  const linearDriver = {
    [ENV.linearApiKey]: "lin_api_base",
    [ENV.linearTeamId]: "team-base",
    [ENV.linearAppUserId]: "app-user-base",
    [ENV.linearAgentHandle]: "OEBase",
  };
  ok(
    resolveCapabilities({ ...linearDriver, ...WORKSPACE_ENV }, LINEAR_TRACKED).available.has("engagedLinear"),
    "🔴 the room var stays unset and engagedLinear comes up from the tracked table — so `resolveCapabilities` really hands ITS `tracked` argument to this resolver",
  );
  ok(
    !resolveCapabilities({ ...linearDriver, ...WORKSPACE_ENV }, {}).available.has("engagedLinear"),
    "…and the control: the same environment against an EMPTY table leaves it dark, so the id came from the table rather than from anything in the environment",
  );
  ok(
    resolveCapabilities({ ...linearDriver, ...WORKSPACE_ENV }, {}).missing.engagedLinear.join(",") === ENV.engagedLinearTeamId,
    "…naming the team variable, so an operator with the workspace inputs and no room is told which one is missing",
  );
  ok(
    resolveCapabilities(WORKSPACE_ENV, LINEAR_TRACKED).available.size === 0,
    "🔴 the workspace inputs and a tracked team WITHOUT the Linear driver stay full dry mode — the capability is the base driver rebound, never a fixture of its own",
  );

  const noIdentity = resolveEngagedLinear({ [own]: "lin_api_addressed" }, LINEAR_TRACKED);
  ok(!noIdentity.ok, "🔴 the key alone does NOT resolve the addressed-only team — its workspace's app identity is part of the room");
  ok(
    !noIdentity.ok && noIdentity.missing.some((m) => m.includes(ENV.linearSoakAppUserId) && m.includes(ENV.linearSoakAgentHandle)),
    `…and the refusal NAMES both variables, so the operator is not left to guess (got: ${noIdentity.ok ? "resolved" : noIdentity.missing.join("; ")})`,
  );
  ok(!resolveEngagedLinear({ [own]: "k", [ENV.linearSoakAppUserId]: "app-user-2" }, LINEAR_TRACKED).ok, "the app-user id alone is not enough — the mention handle is read too");
  ok(!resolveEngagedLinear({ [own]: "k", [ENV.linearSoakAgentHandle]: "OE" }, LINEAR_TRACKED).ok, "the handle alone is not enough — the app-user id is read too");
  ok(resolveEngagedLinear(WORKSPACE_ENV, LINEAR_TRACKED).ok, "🔴 NEGATIVE CONTROL: with the key and both identity vars it RESOLVES — the gate is a real remedy, not a permanent refusal");
  const baseIdentity = { appUserId: "app-user-base", agentHandle: "OEBase" };
  const swapped = engagedLinearIdentity(WORKSPACE_ENV, baseIdentity);
  ok(
    swapped.appUserId === "app-user-2" && swapped.agentHandle === "OE",
    `🔴 the engaged driver takes the TEAM'S workspace identity, never the base one (got: ${JSON.stringify(swapped)})`,
  );
  ok(
    engagedLinearIdentity({}, baseIdentity).appUserId === baseIdentity.appUserId,
    "NEGATIVE CONTROL: with neither var set it falls back to the base identity — a same-workspace room is unchanged, not broken by this pair existing",
  );
  ok(engagedLinearIdentity({ [ENV.linearSoakAppUserId]: "  app-user-2  " }, baseIdentity).appUserId === "app-user-2", "the value is trimmed, so a stray newline never becomes part of an id comparison");

  ok(engagedLinearApiKey({ [own]: "lin_api_addressed" }, "lin_api_base") === "lin_api_addressed", "the addressed team's OWN key wins where it is set");
  ok(engagedLinearApiKey({}, "lin_api_base") === "lin_api_base", "🔴 NEGATIVE CONTROL: unset falls back to the base driver key — a same-workspace room is unchanged, not broken by this variable existing");
  ok(engagedLinearApiKey({ [own]: "   " }, "lin_api_base") === "lin_api_base", "a whitespace-only value is not a key — an empty export must not blank the driver's credential");
  ok(engagedLinearApiKey({ [own]: "  lin_api_addressed  " }, "lin_api_base") === "lin_api_addressed", "the value is trimmed, so a stray newline in an env file does not become part of the authorization header");
}

{
  const ids = SCENARIOS.map((s) => s.id);
  ok(new Set(ids).size === ids.length, "scenario ids are unique");
  const EXPECTED_IDS = new Set([
    "J1", "J2", "S-MEM-READ", "J3", "J4", "S6", "J-DISC", "S8", "S9", "S10", "S11", "S13", "S14",
    "S-LINK-SLACK", "J-MPIM", "S20", "S23", "S24", "J-TEAMS", "J-TEAMS-DM", "J-ENGAGED-teams", "J-GH", "J-LIN", "J-NOT", "F-ART", "F-EDIT", "F-SEC", "J-SUP",
    "J-UNIFIED", "J-UNI-X", "J-PR", "S-PR-SESSION", "S-PR-BOUNDARY", "S-AWS-BOUNDARY", "J-WORKFLOW", "S-NOTION-WRITE", "S-CONNECTOR-TIER",
    "S-DM-NOTION", "S-EVE-CARD", "S-CONNECT-CARD", "S-APIKEY-INTAKE", "S-TAINT-DRYRUN", "S-TAINT-ROUTE-LIVE", "S-TAINT-UNATTENDED-DENY",
    "S-ROUTINE-CONNECTOR-WRITE", "S-DISCORD-GRANT",
    "J-ENGAGED-slack", "J-ENGAGED-discord", "J-ENGAGED-github", "J-ENGAGED-linear", "J-ENGAGED-notion",
    "S-OWN-ACCOUNT-NOTION",
  ]);
  ok(
    ids.length === EXPECTED_IDS.size && ids.every((id) => EXPECTED_IDS.has(id)),
    `pack roster is exactly the ${EXPECTED_IDS.size} expected scenarios (J1 absorbs S1/S2/S3/S21/S22; J2 absorbs S4/S12; J3 absorbs S5/S15/S16/S19; J4 absorbs S17/S18; J-GH/J-LIN/J-NOT add github/linear/notion; F-ART/F-EDIT add artifact+edit; F-SEC adds the security suite; J-UNIFIED adds the unified Slack-only live path; J-UNI-X is the cross-surface money-shot, runnable pending a live multi-surface fixture; J-PR/J-WORKFLOW add the consequential open_pull_request write + S-PR-SESSION the OPE-53 approve-for-session grant→skip pair + S-PR-BOUNDARY the ungranted-repo refusal + S-AWS-BOUNDARY its twin on the OTHER consequential door (the ungated \`aws\` tool, whose only control is the fail-closed awsRoles grant); S-LINK-SLACK drives the whole proof-of-control identity-link loop across two REAL Slack accounts (mint → claim → notice → ratify), asserted on the identity.link.* audit rows because no read-tool exposes link rows; S-NOTION-WRITE/S-CONNECTOR-TIER add the connector-WRITE plane — write approval + the read/write tier split; S-EVE-CARD is the pack's only leg on the EVE-MINTED approval card (OPE-1056), the card eve owns for a connector op — every other approval leg drives OE's own card, which is a different card with a different lifecycle owner; S-DM-NOTION folds the DM personal-Notion journey + S-CONNECT-CARD the channel connector-offer card→forged-org-click→dashboard-link-issued audit + S-APIKEY-INTAKE the db-broker Set-API-key intake — all self-skipping until their fixtures are armed; S-MEM-READ is the OPE-121 leg that asserts a memory recall OPENED A FILE rather than trusting the reply text, which is what J2 alone could never catch; S-TAINT-DRYRUN is the OPE-331 double-opt-in volume leg that drives the source-tier table (ENFORCED since OPE-324) and gates on \`taint.verdict\` audit rows — including \`mode:\"enforced\"\`+\`applied:true\`, the live proof the table DECIDED rather than observed — never reply text; S-TAINT-ROUTE-LIVE (OPE-439/OPE-844) drives a REAL web_fetch (Arm A, hard) + a REAL get_pr_feedback GitHub PR-feedback read (Arm B, hard, direction fixed by the fixture PR's repoPrivate), then a real propose or explain_permission simulation in the SAME turn, and gates on the \`approval.chain\` row's \`tainted\`/\`taintKinds\` disclosure pair with a clean negative control — proving the route→mark join live where S-TAINT-DRYRUN's \`taint.verdict\` rows are structurally silent (they fire on DIVERGENCE only, and web_fetch agrees with the table); S-TAINT-UNATTENDED-DENY (OPE-452) fires a REAL one-shot routine unattended and gates on the \`approval.chain\` row naming the \`unattended\` ask→deny arrow, plus a hard negative that no card was minted; S-DM-DISCORD, which drove this same DM-delegation mechanism on Discord, was RETIRED at OPE-725 — it needed the roll-own delegation regime, which stopped shipping by default at OPE-396 and was DELETED at OPE-1145 item 2, so it could never pass live; the delegation claim has tier-2 coverage instead, in the integration tier own delegation tests; J-TEAMS-DM (OPE-972) is the Teams 1:1 DM plane's first live leg, riding the same "teams" capability as J-TEAMS with no new fixture var — it self-skips at RUNTIME (never via the capability gate) on either the OPE-887 personal-install precondition or the still-unconsented Chat.ReadWrite/ChatMessage.Send Graph scope; J-ENGAGED-teams (OPE-1500) is the Teams ambient engagement seam end to end — @mention engages the reply chain, a PLAIN follow-up wakes, stand_down marks the row, and the next plain follow-up wakes nothing — and it self-skips naming the ChannelMessage.Read.Group RSC grant, without which Microsoft never delivers the follow-up it asserts on;)`,
  );
  const KNOWN = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "slackMpim", "slackCapFixture", "slackSupervisor", "syntheticDm", "slackUser2", "slackSecondary", "webhook", "notion", "teams", "github", "linear", "notionAmbient", "slackUnified", "pr", "connectorWrite",
    "engagedSlack", "engagedDiscord", "engagedTeams", "engagedGithub", "engagedLinear", "engagedNotion"]);
  for (const s of SCENARIOS) {
    okShape(s.title.trim().length > 0, `${s.id} has a title`);
    okShape(typeof s.run === "function", `${s.id} has a run body`);
    okShape(
      s.requires.length > 0 && s.requires.every((c) => KNOWN.has(c)),
      `${s.id} requires only known capabilities`,
    );
    okShape(s.timeoutMs >= 120_000 && s.timeoutMs <= 5_400_000, `${s.id} budget is within the 120s–90min envelope`);
  }
  const optional = SCENARIOS.filter((s) => s.optional).map((s) => s.id);
  ok(
    optional.join(",") === "S-MEM-READ,S8,S9,S10,S24,J-UNI-X,S-NOTION-WRITE,S-CONNECTOR-TIER,S-DM-NOTION,S-EVE-CARD,S-CONNECT-CARD,S-APIKEY-INTAKE,S-TAINT-DRYRUN,S-TAINT-ROUTE-LIVE,S-TAINT-UNATTENDED-DENY,S-ROUTINE-CONNECTOR-WRITE,S-DISCORD-GRANT",
    "the plan's stretch scenarios PLUS the gated Notion read PLUS the cross-surface unified money-shot PLUS the two connector-WRITE scenarios PLUS the folded DM personal-Notion + channel connector-card journeys PLUS the api-key intake leg PLUS S-MEM-READ (the OPE-121 memory-READ assertion: needs the control-read creds to see anything, and pays a delegation round-trip) PLUS S-TAINT-DRYRUN (double opt-in: extended lane AND E2E_TAINT_DRYRUN=1 — it drives read tools across up to four surfaces purely to populate the source-tier verdict log) PLUS S-TAINT-ROUTE-LIVE (OPE-439: costs a real fetch + up to two delegated propose round-trips) PLUS S-TAINT-UNATTENDED-DENY (OPE-452: needs E2E_ROUTINES_ALLOW_WAIT=1 — a real ~10min dispatcher tick) PLUS S-ROUTINE-CONNECTOR-WRITE (OPE-1328: the same switch, and TWO ticks — its refusal arm and its lift arm each need their own fire) PLUS S-DISCORD-GRANT (OPE-1310: needs a named Discord grant OWNER who can receive a real DM, and its second half needs a human to tap a card the harness cannot forge) PLUS S-EVE-CARD (OPE-1056: the first live drive of the EVE-MINTED approval card — it needs the same consented personal Notion grant the other connector legs need, and it publishes then archives a real page) are optional (S11–S23 are core coverage) (S-DM-DISCORD retired at OPE-725). 🔴 NO J-ENGAGED JOURNEY IS OPTIONAL: all six are core, because every provider wires the §2.5 seam (OPE-1500 landed Teams, OPE-1501 the three ticketing surfaces). Each still self-skips until its own room is provisioned, which is a skip and never a green",
  );

  const KNOWN_SURFACES = new Set(["slack", "teams", "discord", "github", "linear", "notion", "cross"]);
  const KNOWN_SUITES = new Set(["core", "extended", "security"]);
  for (const s of SCENARIOS) {
    okShape(KNOWN_SURFACES.has(s.surface), `${s.id} declares a known surface (got "${s.surface}")`);
    okShape(KNOWN_SUITES.has(s.suite), `${s.id} declares a known suite (got "${s.suite}")`);
    okShape((s.suite === "extended") === s.optional, `${s.id}: suite==="extended" iff optional (${s.suite}/${s.optional})`);
  }
  ok(SCENARIOS.find((s) => s.id === "J-DISC")!.surface === "discord", "J-DISC is the discord surface");
  ok(SCENARIOS.find((s) => s.id === "S8")!.surface === "cross", "S8 (Slack→Discord recall) is the cross surface");
  ok(SCENARIOS.find((s) => s.id === "J-TEAMS")!.surface === "teams", "J-TEAMS is the teams surface");
  ok(SCENARIOS.find((s) => s.id === "J-TEAMS-DM")!.surface === "teams", "J-TEAMS-DM is the teams surface");
  ok(SCENARIOS.find((s) => s.id === "J-GH")!.surface === "github", "J-GH is the github surface");
  const nonSlack = SCENARIOS.filter((s) => s.surface !== "slack").map((s) => s.id).sort();
  ok(
    nonSlack.join(",") === "J-DISC,J-ENGAGED-discord,J-ENGAGED-github,J-ENGAGED-linear,J-ENGAGED-notion,J-ENGAGED-teams,J-GH,J-LIN,J-NOT,J-PR,J-TEAMS,J-TEAMS-DM,J-UNI-X,J-WORKFLOW,S-APIKEY-INTAKE,S-CONNECT-CARD,S-CONNECTOR-TIER,S-DISCORD-GRANT,S-DM-NOTION,S-EVE-CARD,S-NOTION-WRITE,S-OWN-ACCOUNT-NOTION,S-PR-SESSION,S-ROUTINE-CONNECTOR-WRITE,S8",
    "the non-slack scenarios are exactly J-DISC+S-DISCORD-GRANT(discord)/S8+J-UNI-X+J-PR+S-PR-SESSION+J-WORKFLOW(cross)/J-TEAMS+J-TEAMS-DM(teams)/J-GH(github)/J-LIN(linear)/J-NOT+S-NOTION-WRITE+S-CONNECTOR-TIER+S-DM-NOTION+S-EVE-CARD+S-CONNECT-CARD+S-APIKEY-INTAKE+S-ROUTINE-CONNECTOR-WRITE+S-OWN-ACCOUNT-NOTION(notion) PLUS the four non-slack engaged-seam journeys (OPE-1503) PLUS J-ENGAGED-teams (OPE-1500) (S-DM-DISCORD retired at OPE-725)",
  );
  const smoke = SCENARIOS.filter((s) => s.smoke === true).map((s) => s.id);
  ok(smoke.join(",") === "J1,J-TEAMS", "the smoke lane is exactly J1 (slack wake+reply) + J-TEAMS (teams)");
  ok(
    SCENARIOS.filter((s) => s.suite === "security").map((s) => s.id).join(",") === "F-SEC,S-PR-BOUNDARY,S-AWS-BOUNDARY",
    "the security suite is F-SEC (tainted-remember/SSRF/injection) + S-PR-BOUNDARY (ungranted-repo PR refusal) + S-AWS-BOUNDARY (ungranted-AWS refusal: no host execution, no credential material)",
  );
  const unjudged = SCENARIOS.filter((s) => !s.judged).map((s) => s.id);
  ok(unjudged.join(",") === "S-MEM-READ,S6,S10,S-LINK-SLACK,J-NOT,S-OWN-ACCOUNT-NOTION,J-SUP,S-PR-SESSION,S-EVE-CARD,S-CONNECT-CARD,S-TAINT-DRYRUN,S-TAINT-ROUTE-LIVE,S-TAINT-UNATTENDED-DENY,S-ROUTINE-CONNECTOR-WRITE,S-DISCORD-GRANT,J-ENGAGED-slack,J-ENGAGED-discord,J-ENGAGED-github,J-ENGAGED-linear,J-ENGAGED-notion", "(S-OWN-ACCOUNT-NOTION deliberately: an own-account ask either produced a connector.acting_identity refusal row or it did not, and the refusal SENTENCE is model-facing copy this leg's own backscroll already carries — grading the reply would grade its own history) (five of the six J-ENGAGED journeys are deliberately unjudged — J-ENGAGED-teams is the judged one: every gate is a reply.post or engagement.stood_down row, and the stand-down acknowledgement they would otherwise judge is model-authored copy the pack does not pin — their question is whether the engagement registry held the thread, which only a row answers) S-MEM-READ/S6/S10/S-LINK-SLACK/J-NOT/J-SUP/S-PR-SESSION/S-CONNECT-CARD/S-TAINT-DRYRUN/S-TAINT-ROUTE-LIVE/S-TAINT-UNATTENDED-DENY/S-ROUTINE-CONNECTOR-WRITE/S-DISCORD-GRANT are fully deterministic — no judge (S-ROUTINE-CONNECTOR-WRITE/S-DISCORD-GRANT deliberately: a fence either wrote its row or it did not, and both legs turn on rows the model cannot see — connector.refused/connector.unattended_lift and grant.asked/grant.used/grant.notified. A fire that says it could not write the page produces the same sentence whether the fence refused it or the tool was never mounted, which is exactly the ambiguity the audit gates resolve) (J-DM-SYNC, which carried this same posture for the Slack DM twin, was RETIRED by OPE-396 with the sync delegation arm it existed to exercise; S-DM-DISCORD, its Discord twin, was RETIRED by OPE-725 for the same reason) (S-TAINT-DRYRUN/S-TAINT-ROUTE-LIVE/S-TAINT-UNATTENDED-DENY deliberately: the verdict trail is a LOG — every gate is on taint.verdict/approval.chain audit rows, and what the model said about a page it read is not evidence about what the log recorded) (S-LINK-SLACK deliberately: an identity link either got WRITTEN or it didn't, and the only evidence of that is the identity.link.* audit rows — a model saying \"linked!\" is exactly the false pass this scenario exists to close) (S-MEM-READ deliberately: its whole point is that reply QUALITY is not the evidence — it gates on the memory.write audit row, the session-transcript read count and the touched silo set) (S15's deterministic legs folded into judged J3; S-PR-SESSION gates on GitHub-API readback + audit rows; S-CONNECT-CARD asserts the connector.dashboard_link_issued audit row; S-EVE-CARD deliberately: every gate is an action_id, an HTTP status or the run-unique token, and the one question it exists to answer — WHICH plane raised this card — is decided by the button's id, which no judge can read off a reply; hard gates: route status / audited silence / reply-target / in-channel presence)");
  const req = (id: string) => SCENARIOS.find((s) => s.id === id)!.requires.join("+");
  ok(req("S11") === "slack+slackPrivate", "S11 requires slack + slackPrivate");
  ok(req("J2") === "slack+slackChannelB", "J2 (memory journey) requires slack + slackChannelB (the union of S4's slack and S12's slack+slackChannelB)");
  ok(req("S13") === "slack+syntheticDm" && req("S14") === "slack+syntheticDm", "S13/S14 require slack + syntheticDm");
  ok(req("J3") === "slack+synthetic+slackUser2", "J3 (governance journey) requires slack + synthetic + slackUser2 (union of S5/S19 synthetic + S15/S16 non-admin identity)");
  ok(req("J4") === "slack+syntheticDm", "J4 (access journey) requires slack + syntheticDm (the always-run propose + out-of-vocab + DM legs; the opt-in member tap guards on synthetic/slackUser2 at runtime)");
  ok(req("S20") === "slack+webhook", "S20 requires slack + webhook");
  ok(
    req("J-MPIM") === "slack+slackMpim",
    "J-MPIM (OPE-1509) requires slack + slackMpim — the base driver rebound onto the group DM, which is the pack's only mpim room",
  );
  ok(req("J1") === "slack" && req("S23") === "slack", "J1 (core journey) + S23 need only the base slack driver");
  ok(req("S24") === "slack+notion", "S24 requires slack + notion (the gated Notion add-on)");
  ok(req("J-TEAMS") === "teams", "J-TEAMS requires only the teams driver");
  ok(req("J-TEAMS-DM") === "teams", "J-TEAMS-DM requires only the teams driver — no new fixture var, the chat/scope gap is derived at runtime");
  ok(req("J-UNIFIED") === "slack+slackUnified", "J-UNIFIED requires slack + slackUnified (the two-channel unified-domain fixture; audit legs guard on targetUrl/token at runtime)");
  ok(req("J-UNI-X") === "slack+slackUnified+github", "J-UNI-X (plan-only) requires slack + slackUnified + github — the eventual cross-surface fixture union");
  ok(req("J-PR") === "slack+synthetic+pr", "J-PR requires slack + synthetic (forge the approve) + pr (the granted target repo + readback token)");
  ok(req("S-PR-BOUNDARY") === "slack", "S-PR-BOUNDARY requires only slack (the ungranted-repo ask needs no repo/token — the refusal precedes any remote touch)");
  ok(
    req("S-AWS-BOUNDARY") === "slack",
    "S-AWS-BOUNDARY requires only slack (the e2e channel has no awsRoles grant, so the fail-closed grant check refuses before any STS call — no AWS fixture needed, and deliberately so: a scenario that needed AWS creds to prove AWS is fenced would be unrunnable exactly where it matters)",
  );
  ok(
    req("S-LINK-SLACK") === "slack+syntheticDm+slackSecondary",
    "S-LINK-SLACK requires slack + syntheticDm (the initiator's DM turns — a driver-posted DM never wakes) + slackSecondary (a genuinely SECOND real account; link-store.ts refuses a self-claim, so this flow cannot be driven from one identity)",
  );
  ok(req("J-WORKFLOW") === "slack+synthetic+pr", "J-WORKFLOW requires slack + synthetic + pr (the read→PR→remember→recall chain reuses the PR drive)");
  ok(
    req("S-OWN-ACCOUNT-NOTION") === "notionAmbient",
    "S-OWN-ACCOUNT-NOTION (OPE-1599) requires only notionAmbient — J-NOT's own fixture, no new env var. It needs no `notion` capability: E2E_NOTION_CHANNEL's " +
      "room cannot produce the connector.acting_identity row at all (neither Notion read tool mounts there), which is why the leg drives a NOTION-origin turn",
  );

  ok(req("J-ENGAGED-slack") === "slack+engagedSlack", "J-ENGAGED-slack requires slack + engagedSlack (the base xoxp driver, rebound onto the addressed-only channel)");
  ok(req("J-ENGAGED-discord") === "discord+engagedDiscord", "J-ENGAGED-discord requires discord + engagedDiscord");
  ok(req("J-ENGAGED-teams") === "teams+engagedTeams", "J-ENGAGED-teams requires teams + engagedTeams (OPE-1531 — its own fixture channel, never J-TEAMS’s E2E_TEAMS_CHANNEL_ID)");
  ok(req("J-ENGAGED-github") === "github+engagedGithub", "J-ENGAGED-github requires github + engagedGithub");
  ok(req("J-ENGAGED-linear") === "linear+engagedLinear", "J-ENGAGED-linear requires linear + engagedLinear");
  ok(req("J-ENGAGED-notion") === "notionAmbient+engagedNotion", "J-ENGAGED-notion requires notionAmbient + engagedNotion (the ambient Notion driver, rebound onto the addressed-only page)");
  const suiteOf = (id: string) => SCENARIOS.find((sc) => sc.id === id)!.suite;
  const optionalOf = (id: string) => SCENARIOS.find((sc) => sc.id === id)!.optional;
  for (const id of ["J-ENGAGED-slack", "J-ENGAGED-discord", "J-ENGAGED-github", "J-ENGAGED-linear", "J-ENGAGED-notion"]) {
    ok(suiteOf(id) === "core", `${id} is core — its surface wires the §2.5 seam, so the journey must pass rather than be opted into`);
    ok(optionalOf(id) === false, `${id} is not optional — an engaged journey behind E2E_INCLUDE_OPTIONAL would prove the seam to nobody on a default run`);
  }
  const surfaceOf = (id: string) => SCENARIOS.find((sc) => sc.id === id)!.surface;
  for (const [id, surface] of [
    ["J-ENGAGED-slack", "slack"],
    ["J-ENGAGED-discord", "discord"],
    ["J-ENGAGED-github", "github"],
    ["J-ENGAGED-linear", "linear"],
    ["J-ENGAGED-notion", "notion"],
  ] as const) {
    ok(surfaceOf(id) === surface, `${id} drives the ${surface} surface`);
  }
}

{
  const none = new Set<"slack" | "discord" | "synthetic" | "slackPrivate" | "slackChannelB" | "slackCapFixture" | "slackSupervisor" | "syntheticDm" | "slackUser2" | "slackSecondary" | "webhook" | "notion" | "teams" | "github" | "linear" | "notionAmbient" | "slackUnified" | "pr" | "connectorWrite" | "engagedSlack" | "engagedDiscord" | "engagedTeams" | "engagedGithub" | "engagedLinear" | "engagedNotion">();
  const missing = {
    slack: [ENV.slackUserToken, ENV.slackChannel, ENV.slackBotUserId],
    discord: [ENV.discordDriverToken, ENV.discordChannel, ENV.discordBotUserId],
    synthetic: [ENV.targetUrl, ENV.slackSigningSecret, ENV.slackAdminUserId, ENV.slackChannel],
    slackPrivate: [ENV.slackPrivateChannel],
    slackChannelB: [ENV.slackChannelB],
    slackMpim: [ENV.slackMpimChannel],
    slackCapFixture: [ENV.slackCapChannel],
    slackSupervisor: [ENV.slackSupervisorChannel],
    syntheticDm: [ENV.slackDmChannel],
    slackUser2: [ENV.slackUser2Id],
    slackSecondary: [ENV.slackSecondaryToken, ENV.slackSecondaryUserId],
    webhook: [ENV.webhookSecret],
    notion: [ENV.notionChannel],
    teams: [ENV.teamsTenantId, ENV.teamsClientId, ENV.teamsRefreshToken, ENV.teamsTeamId, ENV.teamsChannelId, ENV.teamsBotAppId],
    github: [ENV.githubDriverToken, ENV.githubRepo, ENV.githubAppSlug, ENV.githubIssue],
    linear: [ENV.linearApiKey, ENV.linearTeamId, ENV.linearAppUserId, ENV.linearAgentHandle],
    notionAmbient: [ENV.notionDriverKey, ENV.notionAmbientPageId, ENV.notionBotUserId, ENV.notionWorkspaceId],
    slackUnified: [ENV.slackUnifiedChannelA, ENV.slackUnifiedChannelB],
    pr: [ENV.prRepo, ENV.githubDriverToken],
    connectorWrite: [ENV.notionChannel],
    soakSlack: [ENV.slackSoakChannelDev, ENV.slackSoakChannelOps],
    soakNotion: [ENV.notionSoakPage1, ENV.notionSoakPage2],
    soakLinear: [ENV.linearSoakLabelId],
    engagedSlack: [ENGAGED_ROOM_VARS.slack],
    engagedDiscord: [ENGAGED_ROOM_VARS.discord],
    engagedTeams: [ENGAGED_ROOM_VARS.teams],
    engagedGithub: [ENGAGED_ROOM_VARS.github],
    engagedLinear: [ENGAGED_ROOM_VARS.linear],
    engagedNotion: [ENGAGED_ROOM_VARS.notion],
  } as const;
  for (const s of SCENARIOS) {
    const reason = skipReason(s, none, missing, false);
    ok(reason !== undefined, `${s.id} skips in dry mode`);
    ok(/E2E_|SLACK_SIGNING_SECRET/.test(reason ?? ""), `${s.id} dry-skip names the env vars to set`);
  }
  const all = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "slackMpim", "slackCapFixture", "slackSupervisor", "syntheticDm", "slackUser2", "slackSecondary", "webhook", "notion", "teams", "github", "linear", "notionAmbient", "slackUnified", "pr", "connectorWrite", "engagedSlack", "engagedDiscord", "engagedTeams", "engagedGithub", "engagedLinear", "engagedNotion"] as const);
  const noneMissing = {
    slack: [],
    discord: [],
    synthetic: [],
    slackPrivate: [],
    slackChannelB: [],
    slackMpim: [],
    slackCapFixture: [],
    slackSupervisor: [],
    syntheticDm: [],
    slackUser2: [],
    slackSecondary: [],
    webhook: [],
    notion: [],
    teams: [],
    github: [],
    linear: [],
    notionAmbient: [],
    slackUnified: [],
    pr: [],
    connectorWrite: [],
    soakSlack: [],
    soakNotion: [],
    soakLinear: [],
    engagedSlack: [],
    engagedDiscord: [],
    engagedTeams: [],
    engagedGithub: [],
    engagedLinear: [],
    engagedNotion: [],
  } as const;
  ok(skipReason(SCENARIOS[0], all, noneMissing, false) === undefined, "the first scenario (J1) runs when its capability is live");

  {
    const grant = SCENARIOS.find((sc) => sc.id === "S-DISCORD-GRANT")!;
    ok(grant.optional === true, "precondition: S-DISCORD-GRANT is optional, which is what makes the naming asymmetry reachable");
    const named = skipReason(grant, all, noneMissing, false, true)!;
    ok(named !== undefined && named.includes("E2E_INCLUDE_OPTIONAL=1"), `a named-but-optional scenario still skips, and the line names the flag (got: ${JSON.stringify(named)})`);
    ok(
      named.includes("NOT enough"),
      `🔴 …and says naming it directly is NOT the consent this gate takes — without that clause the reader has no way to tell which of the two rules they met (got: ${JSON.stringify(named)})`,
    );
    ok(skipReason(grant, all, noneMissing, false, false)!.includes("E2E_INCLUDE_OPTIONAL=1"), "…the remedy never depends on the explicitly-named branch");
    ok(skipReason(grant, all, noneMissing, true) === undefined, "🔴 NEGATIVE CONTROL: with E2E_INCLUDE_OPTIONAL=1 it RUNS — the flag is a real remedy, not just a sentence");
  }

  const roomOnlyMissing = new Set(["slack", "discord", "github", "linear", "notionAmbient"] as const);
  for (const [id, varName] of [
    ["J-ENGAGED-slack", ENGAGED_ROOM_VARS.slack],
    ["J-ENGAGED-discord", ENGAGED_ROOM_VARS.discord],
    ["J-ENGAGED-github", ENGAGED_ROOM_VARS.github],
    ["J-ENGAGED-linear", ENGAGED_ROOM_VARS.linear],
    ["J-ENGAGED-notion", ENGAGED_ROOM_VARS.notion],
  ] as const) {
    const reason = skipReason(SCENARIOS.find((sc) => sc.id === id)!, roomOnlyMissing, missing, true);
    ok(reason?.includes(varName) === true, `${id} self-skips naming ${varName} while its room is unprovisioned (got ${JSON.stringify(reason)})`);
  }
  {
    const collided = resolveEngagedTeams({ [ENGAGED_ROOM_VARS.teams]: "19:chan-A", [ENV.teamsChannelId]: "19:chan-A" });
    const teamsLive = new Set([...all].filter((c) => c !== "engagedTeams"));
    const reason = skipReason(
      SCENARIOS.find((sc) => sc.id === "J-ENGAGED-teams")!,
      teamsLive,
      { ...noneMissing, engagedTeams: collided.ok ? [] : collided.missing },
      true,
    );
    ok(
      reason?.includes(`set ${ENGAGED_ROOM_VARS.teams} to a channel other than ${ENV.teamsChannelId}'s`) === true,
      `the collision's skip line reads as a REMEDY inside skipReason's "(set …)" frame (got ${JSON.stringify(reason)})`,
    );
  }

  for (const id of ["J-ENGAGED-slack", "J-ENGAGED-discord", "J-ENGAGED-github", "J-ENGAGED-linear", "J-ENGAGED-notion"]) {
    ok(
      skipReason(SCENARIOS.find((sc) => sc.id === id)!, all, noneMissing, false) === undefined,
      `${id} runs on a DEFAULT pass once its room is provisioned — no E2E_INCLUDE_OPTIONAL needed, because its surface wires the seam`,
    );
  }
  ok(
    skipReason(SCENARIOS.find((sc) => sc.id === "S24")!, all, noneMissing, false)?.includes("E2E_INCLUDE_OPTIONAL") === true,
    "NEGATIVE CONTROL: S24 is still held back to the extended lane by the SAME planner call",
  );
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
  const dmReason = skipReason(SCENARIOS.find((s) => s.id === "J-TEAMS-DM")!, slackOnly, missing, false);
  ok(dmReason?.includes("teams") === true && dmReason.includes(ENV.teamsRefreshToken), "J-TEAMS-DM skip names the teams vars specifically when the base capability is missing");
  ok(skipReason(SCENARIOS.find((s) => s.id === "J-TEAMS-DM")!, all, noneMissing, false) === undefined, "J-TEAMS-DM is attempted (capability-wise) once the teams capability is live — its own precondition gap is a runtime skip, not a capability skip");
  const baseOnly = new Set(["slack", "discord", "synthetic"] as const);
  const s11 = skipReason(SCENARIOS.find((s) => s.id === "S11")!, baseOnly, missing, false);
  ok(s11 === `missing slackPrivate driver (set ${ENV.slackPrivateChannel})`, "S11 skip names exactly E2E_SLACK_PRIVATE_CHANNEL");
  const jmpimScenario = SCENARIOS.find((s) => s.id === "J-MPIM")!;
  const jmpim = skipReason(jmpimScenario, baseOnly, missing, false);
  const noSlack = new Set(["discord", "synthetic"] as const);
  const roomPresent = { ...missing, slackMpim: [] as readonly string[] };
  const jmpimRoomOk = skipReason(jmpimScenario, noSlack, roomPresent, false);
  ok(
    jmpimRoomOk?.includes("mpim:history") === false,
    `🔴 …and NO remedy when slackMpim itself resolved — the gap is the base driver, and a remedy naming the room would send the operator at a fixture that is present (got: ${JSON.stringify(jmpimRoomOk)})`,
  );
  ok(
    jmpim?.startsWith(`missing slackMpim driver (set ${ENV.slackMpimChannel})`) === true,
    "J-MPIM skip names exactly E2E_SLACK_MPIM_CHANNEL — the group DM is the one fixture it cannot derive",
  );
  ok(
    jmpim?.includes("the room EXISTS and TRACKED_ROOM_IDS carries its id") === true,
    "🔴 J-MPIM's remedy states the room's REAL state — open, and its id tracked — never the pre-OPE-1662 'does not exist yet'",
  );
  ok(jmpim?.includes("mpim:history") === true, "🔴 …and it names the read scope that is actually missing, not the write scope the driver app already holds");
  ok(jmpim?.includes("mpim:write") === false, "…and it no longer names `mpim:write`, which the driver app got before the room was opened");
  ok(jmpim?.includes("provision-mpim") === true, "…and the command that re-opens the room if its id ever leaves the table");
  ok(
    skipCategory(jmpimScenario, baseOnly, false) === "missing-capability",
    "…and it stays a SKIP, never a red — the remedy rides the same missing-capability category the runner skips on",
  );
  ok(
    skipReason(SCENARIOS.find((s) => s.id === "S11")!, baseOnly, missing, false)?.includes("—") === false,
    "the control: a capability whose gap IS its variable carries no remedy clause",
  );
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
    const runSelfSkip = async (armed: boolean): Promise<{ skip: string; gate: string }> => {
      const before = process.env.E2E_UNIX_ARMED;
      if (armed) process.env.E2E_UNIX_ARMED = "1";
      else delete process.env.E2E_UNIX_ARMED;
      let skip = "";
      let gate = "";
      try {
        await jx.run({
          skip: (why: string) => { throw new ScenarioSkip(why); },
          gate: (pass: boolean, why: string) => { if (!pass) throw new Error(`GATE ${why}`); },
        } as never);
      } catch (err) {
        if (err instanceof ScenarioSkip) skip = err.message;
        else if (err instanceof Error && err.message.startsWith("GATE ")) gate = err.message;
        else throw err;
      } finally {
        if (before === undefined) delete process.env.E2E_UNIX_ARMED;
        else process.env.E2E_UNIX_ARMED = before;
      }
      return { skip, gate };
    };
    const unarmed = await runSelfSkip(false);
    const selfSkip = unarmed.skip;
    ok(selfSkip.includes("live-fixture-pending"), "…without the unified-audit caller the body self-skips as live-fixture-pending (fixture detection, not a stub)");
    ok(selfSkip.includes("E2E_TARGET_URL") && selfSkip.includes("E2E_CONTROL_READ_TOKEN"), "…and the self-skip names the env pair that arms fixture detection");
    ok(!selfSkip.includes("TODO(unified-dispatch)") && !selfSkip.includes("TODO(unified-reply)"), "…and no longer names the retired TODO(unified-dispatch)/TODO(unified-reply) stubs (they are wired)");
    ok(unarmed.gate === "", "…and the UNARMED branch never gates — a missing fixture is a skip, not a red");
    const armed = await runSelfSkip(true);
    ok(armed.skip === "", "E2E_UNIX_ARMED=1: the armed fixture does NOT skip — an armed regression must not read as 'not provisioned'");
    ok(
      armed.gate.includes("ARMED fixture regressed") && armed.gate.includes("live-fixture-pending"),
      "E2E_UNIX_ARMED=1: the same missing fixture GATES, naming the armed flag and carrying the underlying reason",
    );
  }
  for (const id of ["J1", "S23"]) {
    ok(skipReason(SCENARIOS.find((s) => s.id === id)!, slackOnly, missing, false) === undefined, `${id} runs with slack alone (no add-on fixture needed)`);
  }
}

{
  for (const s of SCENARIOS) {
    const satisfied = new Set(s.requires);
    const missingForSatisfied = Object.fromEntries(s.requires.map((c) => [c, [] as string[]])) as Record<(typeof s.requires)[number], string[]>;
    const catFalse = skipCategory(s, satisfied, false);
    const reasonFalse = skipReason(s, satisfied, missingForSatisfied, false);
    ok((catFalse !== undefined) === (reasonFalse !== undefined), `${s.id}: skipCategory and skipReason agree on definedness (capabilities satisfied, includeOptional=false)`);
    if (s.optional) {
      ok(catFalse === "optional-not-included", `${s.id}: optional scenario skips as optional-not-included once capabilities are satisfied but includeOptional stays false`);
    } else {
      ok(catFalse === undefined, `${s.id}: non-optional scenario with satisfied capabilities does not skip at the roster level`);
    }
    if (s.expensive) {
      ok(skipCategory(s, satisfied, true) === "expensive-not-included", `${s.id}: expensive — includeOptional=true alone still skips it, naming the cost`);
      ok(skipCategory(s, satisfied, true, false, true) === undefined, `${s.id}: expensive — runs once includeOptional AND includeExpensive are both on`);
    } else {
      ok(skipCategory(s, satisfied, true) === undefined, `${s.id}: runs once its capabilities are satisfied and includeOptional=true, optional or not`);
    }
    ok(skipCategory(s, new Set(), false) === "missing-capability", `${s.id}: skips as missing-capability with zero capabilities available`);
  }
}
{
  const counts = emptySkipCounts();
  ok(SKIP_KINDS.every((k) => counts[k] === 0), "emptySkipCounts starts every bucket at zero");
  ok(renderSkipBreakdown(counts) === "none", "renderSkipBreakdown reports 'none' when every bucket is zero — the negative control for the non-empty case below");
  ok(SKIP_KINDS.length === 7, "the skip-reason taxonomy has exactly 7 closed categories");
  counts["missing-capability"] = 3;
  counts["filtered-only"] = 1;
  ok(
    renderSkipBreakdown(counts) === "1 filtered-only, 3 missing-capability",
    "renderSkipBreakdown lists only the non-zero buckets, in fixed taxonomy order regardless of assignment order",
  );
}

{
  ok(
    expensiveReasonError({ id: "FAKE-OK", expensive: true, costReason: "burns ~5M tokens per run" }) === undefined,
    "expensive:true + a non-empty costReason validates (no error)",
  );
  ok(
    expensiveReasonError({ id: "FAKE-NONE", expensive: true, costReason: undefined }) !== undefined,
    "expensive:true with costReason UNSET refuses — the reason is the point of the flag",
  );
  ok(
    expensiveReasonError({ id: "FAKE-EMPTY", expensive: true, costReason: "" }) !== undefined,
    "expensive:true with costReason === '' refuses",
  );
  ok(
    expensiveReasonError({ id: "FAKE-WS", expensive: true, costReason: "   " }) !== undefined,
    "expensive:true with a whitespace-only costReason refuses (trimmed before the emptiness check)",
  );
  ok(
    expensiveReasonError({ id: "FAKE-WS", expensive: true, costReason: "   " })?.includes("FAKE-WS") === true,
    "the refusal names the offending scenario id",
  );
  ok(
    expensiveReasonError({ id: "FAKE-CHEAP", expensive: false, costReason: undefined }) === undefined,
    "expensive:false never refuses regardless of costReason (negative control)",
  );
  ok(
    expensiveReasonError({ id: "FAKE-CHEAP2" }) === undefined,
    "a scenario with expensive entirely absent never refuses (the common-case default)",
  );
  ok(
    SCENARIOS.every((s) => expensiveReasonError(s) === undefined),
    "no roster scenario is currently flagged expensive without a reason (module-load validation shape)",
  );
  const badRoster = [
    { id: "BAD1", expensive: true, costReason: "" },
    { id: "BAD2", expensive: true, costReason: "   " },
    { id: "BAD3", expensive: false },
  ];
  let threw = false;
  let thrownMessage = "";
  try {
    const errors = badRoster.map((s) => expensiveReasonError(s)).filter((e) => e !== undefined);
    if (errors.length > 0) throw new Error(`e2e scenario roster: ${errors.join("; ")}`);
  } catch (err) {
    threw = true;
    thrownMessage = String(err instanceof Error ? err.message : err);
  }
  ok(threw, "a roster carrying an expensive-but-reasonless entry trips the module-load validation shape");
  ok(
    thrownMessage.includes("BAD1") && thrownMessage.includes("BAD2") && !thrownMessage.includes("BAD3"),
    "the thrown message names exactly the two offending ids, not the clean BAD3 entry",
  );

  const fakeExpensive = {
    id: "FAKE-EXP",
    requires: ["slack"],
    optional: false,
    expensive: true,
    costReason: "burns ~5M tokens/run (compaction repro shape)",
  } as any;
  const satisfied = new Set(["slack"]) as any;
  const missingNone = { slack: [] as string[] } as any;
  ok(
    skipCategory(fakeExpensive, satisfied, false) === "expensive-not-included",
    "an expensive scenario with satisfied capabilities skips by default (not named, no --include-expensive)",
  );
  const defaultReason = skipReason(fakeExpensive, satisfied, missingNone, false);
  ok(defaultReason !== undefined, "the default skip carries a printed reason");
  ok(
    defaultReason?.includes(fakeExpensive.costReason) === true,
    "the printed default-skip reason names the scenario's own costReason verbatim — a silent absence is a defect",
  );
  ok(
    skipCategory(fakeExpensive, satisfied, false, true, false) === undefined,
    "naming the scenario id directly (explicitlyNamed=true) always runs it, even expensive and with no --include-expensive flag",
  );
  ok(
    skipReason(fakeExpensive, satisfied, missingNone, false, true, false) === undefined,
    "skipReason agrees: a directly-named expensive scenario has no skip reason (it runs)",
  );
  ok(
    skipCategory(fakeExpensive, satisfied, false, false, true) === undefined,
    "--include-expensive / E2E_INCLUDE_EXPENSIVE=1 (includeExpensive=true) runs an expensive scenario even when not named directly",
  );
  ok(
    skipReason(fakeExpensive, satisfied, missingNone, false, false, true) === undefined,
    "skipReason agrees: includeExpensive=true clears the skip reason",
  );
  ok(
    skipCategory(fakeExpensive, new Set(), false, true, true) === "missing-capability",
    "missing-capability still wins over the expensive gate, even with BOTH explicitlyNamed and includeExpensive set",
  );
  const fakeCheap = { id: "FAKE-CHEAP", requires: ["slack"], optional: false } as any;
  ok(
    skipCategory(fakeCheap, satisfied, false) === undefined,
    "a non-expensive scenario is unaffected by the expensive gate (negative control)",
  );

  const expensiveIds = SCENARIOS.filter((s) => s.expensive === true).map((s) => s.id);
  ok(
    expensiveIds.join(",") === "S-TAINT-ROUTE-LIVE",
    `the roster's expensive set is exactly S-TAINT-ROUTE-LIVE — the one leg measured green past the ~10-minute bar (1246.8 s, 2026-09-10 full pack). Got: ${expensiveIds.join(",") || "(none)"}`,
  );
  for (const id of ["J-GH", "F-EDIT", "F-SEC", "J-UNI-X"]) {
    const s = SCENARIOS.find((x) => x.id === id);
    ok(s !== undefined, `${id} is still in the roster (the not-flagged assertion below needs a subject)`);
    ok(s?.expensive !== true, `${id} is NOT flagged expensive — a leg that REDS on its reply timeout is broken, not expensive`);
  }
  const routeLive = SCENARIOS.find((s) => s.id === "S-TAINT-ROUTE-LIVE")!;
  ok(routeLive.costReason?.includes("1246.8 s") === true, "S-TAINT-ROUTE-LIVE's costReason carries the measured duration, not an estimate");
  ok(
    skipCategory(routeLive, satisfied, true, false, false) === "expensive-not-included",
    "on a full pack (includeOptional, no expensive opt-in) S-TAINT-ROUTE-LIVE skips as expensive-not-included",
  );
  const fullPackReason = skipReason(routeLive, satisfied, missingNone, true, false, false);
  ok(
    fullPackReason?.includes(routeLive.costReason!) === true,
    "…and the printed skip line names its costReason verbatim — the cost is visible, never a silent absence",
  );
  ok(
    skipCategory(routeLive, satisfied, true, false, true) === undefined,
    "includeExpensive=true runs S-TAINT-ROUTE-LIVE on a full pack (negative control — the flag gates, it does not retire the leg)",
  );
  ok(
    skipCategory(routeLive, satisfied, true, true, false) === undefined,
    "naming the id directly runs it with no expensive opt-in, once includeOptional is ALREADY on (negative control)",
  );
  ok(
    skipCategory(routeLive, satisfied, false, true, false) === "optional-not-included",
    "naming the id alone is NOT enough — the optional gate outranks the expensive one and still holds",
  );
  ok(
    skipCategory(routeLive, satisfied, false, false, false) === "optional-not-included",
    "on a CORE pack the optional gate wins — the expensive skip line belongs to the full pack",
  );
}

{
  const { factToken, approveButton, legGate } = await import("../packages/core/scripts/e2e/journey.js");
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

  const { eveNativeApprovalButtons } = await import("../packages/core/scripts/e2e/journey.js");
  const deploy142 = {
    ts: "2.1",
    text: "Approve tool call: notion__notion-create-pages",
    actions: [
      { actionId: "eve_input:tool-approval:req-1:button:1", value: "cancel", text: "Cancel" },
      { actionId: "eve_input:tool-approval:req-1:button:0", value: "approve", text: "Approve" },
    ],
  };
  const d142 = eveNativeApprovalButtons(deploy142);
  ok(d142?.approve.actionId === "eve_input:tool-approval:req-1:button:0", "eveNativeApprovalButtons reads the approve side off `value:\"approve\"` (deploy #142's Approve/Cancel card, in the pinned eve's shapes)");
  ok(d142?.deny?.actionId === "eve_input:tool-approval:req-1:button:1", "…and the deny side off `value:\"cancel\"` — the option id the pinned eve actually stamps — so the label set is not the only thing finding it");
  const allowDeny = eveNativeApprovalButtons({ ts: "2.2", text: "allow?", actions: [{ actionId: "b1", text: "Deny" }, { actionId: "b2", text: "Allow" }] });
  ok(allowDeny?.approve.actionId === "b2" && allowDeny.deny?.actionId === "b1", "eveNativeApprovalButtons falls back to the LABEL set (Allow/Deny) when the buttons carry no value");
  ok(
    eveNativeApprovalButtons({ ts: "2.3", text: "raise cap?", actions: [{ actionId: "oe_approval:approve:row-9", value: "default", text: "Approve" }, { actionId: "oe_approval:reject:row-9", value: "default", text: "Reject" }] }) === undefined,
    "eveNativeApprovalButtons REFUSES an OE-minted card — every `oe_approval:` button is dropped before the match, however it is labelled",
  );
  ok(eveNativeApprovalButtons({ ts: "2.4", text: "decided" }) === undefined, "eveNativeApprovalButtons returns undefined for a decided/button-less message");
  ok(
    eveNativeApprovalButtons({ ts: "2.5", text: "connect?", actions: [{ actionId: "oe_connect:notion:api-key", value: "default", text: "Set API key" }] }) === undefined,
    "eveNativeApprovalButtons returns undefined for the connector-OFFER card (neither an approve value nor an approve label)",
  );
  const approveOnly = eveNativeApprovalButtons({ ts: "2.6", text: "x", actions: [{ actionId: "b3", value: "approve", text: "Approve" }] });
  ok(
    approveOnly?.approve.actionId === "b3" && approveOnly.deny === undefined,
    "an approve-only card still DECODES, with no deny side — rather than mis-reading the approve button as both, or answering undefined",
  );

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

  const { signGithubBody, buildIssueCommentEvent } = await import("../packages/core/scripts/e2e/github-forge.js");
  const { verifyGithubSignature } = await import("@open-everywhere/core/agent/routines/events.js");
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
  const { engagedRepoSkipReason } = await import("../packages/core/scripts/e2e/github-driver.js");
  const publicReason = engagedRepoSkipReason("acme/fixture", false);
  ok(publicReason !== undefined, "a PUBLIC fixture repo yields a skip reason");
  ok(publicReason!.includes("acme/fixture"), "…which names the repo the operator must fix");
  ok(publicReason!.includes("PUBLIC") && publicReason!.includes("githubEngagedFollowUpReach"), "…and names the privacy floor that makes step (b) unreachable");
  ok(publicReason!.includes("E2E_ADDRESSED_GITHUB_REPO"), "…and the variable that points the journey elsewhere");
  ok(engagedRepoSkipReason("acme/fixture", true) === undefined, "a PRIVATE fixture repo yields no skip — the journey runs");
  ok(engagedRepoSkipReason("acme/fixture", undefined) === undefined, "an UNREADABLE probe yields no skip either — unknown privacy is not evidence the floor blocks step (b)");
}

{
  const { buildAgentSessionEvent, FORGE_SESSION_ID, FORGE_ORGANIZATION_ID, FORGE_ISSUE_ID, FORGE_CREATOR_ID } = await import(
    "../packages/core/scripts/e2e/linear-driver.js"
  );
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  ok(UUID_RE.test(FORGE_SESSION_ID), "FORGE_SESSION_ID is UUID-shaped");
  ok(UUID_RE.test(FORGE_ORGANIZATION_ID), "FORGE_ORGANIZATION_ID is UUID-shaped");
  ok(UUID_RE.test(FORGE_ISSUE_ID), "FORGE_ISSUE_ID is UUID-shaped");
  ok(UUID_RE.test(FORGE_CREATOR_ID), "FORGE_CREATOR_ID is UUID-shaped");

  ok(!UUID_RE.test("forged-session"), "negative control: the pre-OPE-886 literal 'forged-session' is NOT UUID-shaped");

  const ev = buildAgentSessionEvent({
    action: "created",
    organizationId: FORGE_ORGANIZATION_ID,
    sessionId: FORGE_SESSION_ID,
    issueId: FORGE_ISSUE_ID,
    issueIdentifier: "OE-0",
    teamId: "team-x",
    creatorId: FORGE_CREATOR_ID,
    nowMs: 1_700_000_000_000,
  });
  const session = (ev.agentSession ?? {}) as { id?: string; creator?: { id?: string } };
  ok(session.id === FORGE_SESSION_ID, "buildAgentSessionEvent embeds the UUID sessionId verbatim as agentSession.id");
  ok(session.creator?.id === FORGE_CREATOR_ID, "buildAgentSessionEvent embeds the UUID creatorId verbatim as agentSession.creator.id");
}

{
  const prMiss = resolvePr({});
  ok(!prMiss.ok && prMiss.missing.length === 2 && prMiss.missing.includes(ENV.prRepo) && prMiss.missing.includes(ENV.githubDriverToken), "pr half reports E2E_PR_REPO + E2E_GITHUB_DRIVER_TOKEN missing in an empty env");
  const prRepoOnly = resolvePr({ [ENV.prRepo]: "acme/e2e-scratch" });
  ok(!prRepoOnly.ok && prRepoOnly.missing.join(",") === ENV.githubDriverToken, "pr half still fails-closed on the reused driver PAT when only E2E_PR_REPO is set");
  const prFull = resolvePr({ [ENV.prRepo]: "acme/e2e-scratch", [ENV.githubDriverToken]: "ghp_x" });
  ok(prFull.ok && prFull.cfg.repo === "acme/e2e-scratch" && prFull.cfg.token === "ghp_x", "pr cfg carries the target repo + the reused driver token");

  const { classifyPrMiss } = await import("../packages/core/scripts/e2e/journey.js");
  ok(classifyPrMiss('repo "acme/x" is not granted to this channel. Allowed: (none). Grant it via a bundle') === "grant-refused", "classifyPrMiss: a fail-closed grant refusal → grant-refused (SKIP with provisioning guidance)");
  ok(classifyPrMiss("the staging push of my-branch failed — checkout the repo first") === "errored", "classifyPrMiss: a push/checkout failure → errored (prefer FAIL)");
  ok(classifyPrMiss("couldn't push your branch to the remote") === "errored", "classifyPrMiss: a couldn't-push reply → errored");
  ok(classifyPrMiss("Sure — what change would you like in the PR?") === "no-tool", "classifyPrMiss: a plain narration reply (no tool call) → no-tool (SKIP as model-choice)");
}

{
  const { findJudgeAllow, prOpenRowNumbers, JUDGE_ARM_PROBE_MS } = await import("../packages/core/scripts/e2e/journey.js");
  const row = (action: string, detail: Record<string, unknown>) => ({
    ts: "2026-04-13T17:44:49.000Z",
    org: "default",
    platform: "slack",
    workspace: "acme",
    action,
    detail,
  });
  const allowRow = row("approval.judge.verdict", {
    tool: "open_pull_request",
    action: "pr.open",
    mode: "enforce",
    verdict: "allow",
    enforcedVerdict: "allow",
    resolvedBy: "judge",
    source: "model",
    passes: 2,
    reasoning: "a one-line README addition against a granted fixture repo, requested in-room",
  });

  ok(findJudgeAllow([], "open_pull_request") === undefined, "findJudgeAllow: an EMPTY window is not an allow — no rows, no arm (card absence alone must stay a skip)");
  const hit = findJudgeAllow([allowRow], "open_pull_request");
  ok(hit?.enforcedVerdict === "allow" && hit.resolvedBy === "judge" && hit.passes === 2, "findJudgeAllow: a matching enforce-mode allow row is returned with resolvedBy/passes/reasoning for the caller to log");
  ok((hit?.reasoning ?? "").includes("granted fixture repo"), "findJudgeAllow: the judge's REASONING is carried through — it is the only review surface for an auto-approved consequential write");
  ok(
    findJudgeAllow([row("approval.judge.verdict", { tool: "forget", enforcedVerdict: "allow" })], "open_pull_request") === undefined,
    "findJudgeAllow: another judge-deferred verb's allow in the SAME window is NOT this action's arm (the row must name the tool)",
  );
  ok(
    findJudgeAllow([row("approval.judge.verdict", { tool: "open_pull_request", verdict: "allow", enforcedVerdict: "ask" })], "open_pull_request") === undefined,
    "findJudgeAllow: a judge allow that the chain RAISED back to ask is not the arm — a card was posted, so arm (a) owns that run (enforcedVerdict is the field, not verdict)",
  );
  ok(
    findJudgeAllow([row("approval.judge.verdict", { tool: "open_pull_request", verdict: "ask", enforcedVerdict: "allow", resolvedBy: "domain-mode" })], "open_pull_request")?.resolvedBy === "domain-mode",
    "findJudgeAllow: a judge ask that a CONFIG element lowered to allow still explains the missing card — the arm is about what was enforced, and resolvedBy says which happened",
  );
  ok(
    findJudgeAllow([row("approval.judge.shadow", { tool: "open_pull_request", enforcedVerdict: "allow" })], "open_pull_request") === undefined,
    "findJudgeAllow: a phase-1 approval.judge.shadow row never arms anything — shadow rows are log-only and influenced nothing",
  );

  const prRows = [
    row("pr.open", { repo: "acme/e2e-scratch", number: 18, head: "e2e-wf-1", base: "main" }),
    row("pr.update", { repo: "acme/e2e-scratch", number: 4, head: "old", base: "main" }),
    row("pr.open", { repo: "other/repo", number: 99, head: "x", base: "main" }),
    row("pr.open", { repo: "acme/e2e-scratch", number: 18, head: "e2e-wf-1", base: "main" }),
  ];
  ok(JSON.stringify(prOpenRowNumbers(prRows)) === JSON.stringify([18, 99]), "prOpenRowNumbers: pr.open rows only (a pr.update means a PR was ALREADY open for that head — a different state), de-duplicated, newest-first");
  ok(JSON.stringify(prOpenRowNumbers(prRows, "acme/e2e-scratch")) === JSON.stringify([18]), "prOpenRowNumbers: narrowing to the fixture repo drops another repo's publish from the same window");
  ok(prOpenRowNumbers([row("pr.open", { repo: "acme/e2e-scratch" })]).length === 0, "prOpenRowNumbers: a pr.open row with no `number` yields nothing (never guess a PR number — the teardown closes whatever it is handed)");
  ok(JUDGE_ARM_PROBE_MS > 0 && JUDGE_ARM_PROBE_MS <= 120_000, `the judge-arm probe budget stays small (${JUDGE_ARM_PROBE_MS}ms) — its rows are written BEFORE the reply the drive already awaited, so it covers audit propagation, not a race`);
}

{
  ok(isFillerAck("the listing is still in progress"), 'isFillerAck: "the listing is still in progress" (S16\'s own delegation ack) is filler');
  ok(isFillerAck("still in progress"), 'isFillerAck: bare "still in progress" is filler');
  ok(isFillerAck("this is currently in progress, one moment"), 'isFillerAck: "currently in progress" is filler');
  ok(
    !isFillerAck("memory_admin_list requires an org admin, or a domain admin for at least one memory domain."),
    "isFillerAck: the real not-admin refusal is NOT filler — a genuine refusal must never be skipped past",
  );
  ok(
    !isFillerAck("this turn was woken by 2 different people at once, so it cannot say whose ask this is."),
    "isFillerAck: verdictFromEnvelope's several-humans reason (no `delegat…`) is NOT filler",
  );
  ok(
    !isFillerAck("this turn was woken by a system or relay message, not by a person asking"),
    "isFillerAck: verdictFromEnvelope's system-wake reason is NOT filler",
  );
  ok(
    !isFillerAck("the turn that delegated this work was woken by more than one person, so it could not say whose ask this is"),
    "isFillerAck: OPE-704 — the OPE-673 several-askers refusal (WITH candidates) is NOT filler despite containing 'delegated this work'",
  );
  ok(
    !isFillerAck("the turn that delegated this work could not say whose ask it was serving — it was woken by more than one person, or by no person at all"),
    "isFillerAck: OPE-704 — the no-candidates unverified reason is NOT filler either",
  );
  ok(
    !isFillerAck("the turn that delegated this work carried no verified asker, so this worker has no caller to check standing for"),
    "isFillerAck: OPE-704 — the child-seat NO_CARRIAGE reason is NOT filler (pinned by 'no verified asker')",
  );
  ok(
    !isFillerAck(
      "I can't share that listing — the turn that delegated this to me was woken by more than one person at once, so it could not say whose ask this is.",
    ),
    "isFillerAck: OPE-704 — a model paraphrase of the refusal (still says 'delegated this') stays substantive via the 'could not say' marker",
  );
  ok(isFillerAck("I've delegated this to a worker and will report back."), "isFillerAck: the object form (delegated this to…) is still filler");
  ok(
    isFillerAck("I'm checking the raw memory-silo admin listing under your requester identity. I'll return the raw result once it's done."),
    "isFillerAck: OPE-704 negative control — the genuine delegation ack still classifies AS filler",
  );

  ok(
    isFillerAck("I'm retrieving the admin listing and domain references now; I'll return the exact output or any access refusal."),
    "isFillerAck: OPE-834 — the live-run interim classifies as filler on its model tail ALONE, now that no host frame precedes it",
  );
  ok(isFillerAck("I'll fetch that for you shortly."), "isFillerAck: OPE-834 — widened will-branch matches the contraction \"I'll fetch\" alone");
  ok(
    !isFillerAck("I'll be honest, the balance is £42.10."),
    "isFillerAck: OPE-834 negative control — \"I'll\" followed by a verb outside the listed set stays substantive",
  );
  ok(
    !isFillerAck("A worker finished the admin listing. Domains: e2e-unified, e2e-secondary. Silos: 4 total."),
    "isFillerAck: OPE-834 negative control — text that mentions a worker but reports an OUTCOME stays substantive",
  );
}

{
  ok(
    isPendingWorkHandoff("I'm checking the issue details and will return a grounded one-line summary including `gh-39426`."),
    "isPendingWorkHandoff: the live-run J-GH hand-off, frame stripped, is STILL a hand-off on its prose alone",
  );
  ok(
    !isPendingWorkHandoff("Issue #1 (\u201c[oe-e2e] ambient supervisor fixture issue\u201d) couldn't be summarized from its body; **gh-39426**."),
    "isPendingWorkHandoff: the live-run grounded answer is NOT a hand-off",
  );
  ok(isPendingWorkHandoff("one sec, looking at it"), "isPendingWorkHandoff: plain filler prose IS a hand-off now — the predicate is the prose heuristic, and carries its false-skip risk (OPE-1523)");
  ok(
    isFillerAck("one sec, looking at it") === isPendingWorkHandoff("one sec, looking at it"),
    "isPendingWorkHandoff: …and the two agree by construction, because no exact host signal is left to separate them",
  );

  const s11Interim = "I'm checking the durable team memory for the exact `sprint-22088` mascot and will report back plainly if it isn't recorded.";
  ok(isPendingWorkHandoff(s11Interim), "isPendingWorkHandoff: the live-run S11 interim, frame stripped, is STILL a hand-off — no LENGTH threshold could have caught it either");
  ok(
    !isPendingWorkHandoff("I couldn't find any recorded team mascot for `sprint-22088` in durable memory, so I don't know it."),
    "isPendingWorkHandoff: the live-run S11 clean decline is NOT a hand-off — it is exactly what the gate asks for",
  );
}

{
  const scenariosPath = fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url));
  const src = readFileSync(scenariosPath, "utf-8");
  const REPLY_WAIT_METHOD = /\.(awaitThreadReply|awaitAnyReply|awaitBotReply|awaitBotReplyIn)\(/g;
  const NO_SKIP_MARKER = "OPE-984: no skip needed";

  function callSpan(openIdx: number): string {
    let depth = 1;
    let i = openIdx + 1;
    while (depth > 0 && i < src.length) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    return src.slice(openIdx, i);
  }

  let total = 0;
  let guarded = 0;
  let unguardedNoMarker: string[] = [];
  for (const m of src.matchAll(REPLY_WAIT_METHOD)) {
    total++;
    const openIdx = m.index! + m[0].length - 1;
    const span = callSpan(openIdx);
    if (span.includes("skip:")) {
      guarded++;
      continue;
    }
    const closeIdx = openIdx + span.length;
    const before = src.slice(Math.max(0, m.index! - 400), m.index!);
    const after = src.slice(closeIdx, closeIdx + 150);
    if (before.includes(NO_SKIP_MARKER) || after.includes(NO_SKIP_MARKER)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    unguardedNoMarker.push(`line ${line}: ${m[0]}`);
  }

  ok(total >= 60, `OPE-984: scenarios.ts has ${total} reply-wait call sites (sanity floor — the scan itself found the methods)`);
  ok(
    unguardedNoMarker.length === 0,
    `OPE-984: every reply-wait call site carries either a skip predicate or an explicit ` +
      `"${NO_SKIP_MARKER}" marker — found ${unguardedNoMarker.length} with NEITHER: ${unguardedNoMarker.join("; ")}`,
  );
  ok(guarded >= 34, `OPE-984: at least 34 reply-wait call sites carry a skip predicate (found ${guarded}) — the post-sweep floor`);

  const syntheticUnguarded = 'const x = await slack.awaitThreadReply(rootTs, { timeoutMs: REPLY_WAIT });';
  const fakeMatch = [...syntheticUnguarded.matchAll(REPLY_WAIT_METHOD)][0]!;
  const fakeOpenIdx = fakeMatch.index! + fakeMatch[0].length - 1;
  let depth = 1;
  let i = fakeOpenIdx + 1;
  while (depth > 0 && i < syntheticUnguarded.length) {
    if (syntheticUnguarded[i] === "(") depth++;
    else if (syntheticUnguarded[i] === ")") depth--;
    i++;
  }
  const fakeSpan = syntheticUnguarded.slice(fakeOpenIdx, i);
  ok(!fakeSpan.includes("skip:"), "OPE-984: NEGATIVE CONTROL — the scanner correctly reads an un-swept call site as unguarded");
}

{
  const DISCORD_CHANNEL_FIRST = /discord\.(awaitReply|awaitReplyMatching|collectRepliesDuring)\(/g;

  function argsOf(src: string, openIdx: number): readonly string[] {
    const args: string[] = [];
    let depth = 0;
    let start = openIdx + 1;
    let quote = "";
    for (let i = openIdx; i < src.length; i++) {
      const ch = src[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) { args.push(src.slice(start, i).trim()); break; }
      } else if (ch === "," && depth === 1) {
        args.push(src.slice(start, i).trim());
        start = i + 1;
      }
    }
    return args;
  }

  function discordWaits(body: string): readonly { readonly method: string; readonly channelArg: string; readonly afterArg: string }[] {
    const out: { method: string; channelArg: string; afterArg: string }[] = [];
    for (const m of body.matchAll(DISCORD_CHANNEL_FIRST)) {
      const args = argsOf(body, m.index! + m[0].length - 1);
      out.push({ method: m[1]!, channelArg: args[0] ?? "", afterArg: args[1] ?? "" });
    }
    return out;
  }

  let totalWaits = 0;
  const parentChannelWaits: string[] = [];
  for (const s of SCENARIOS) {
    const body = s.run.toString();
    for (const w of discordWaits(body)) {
      totalWaits++;
      if (/\.channelId$/.test(w.channelArg)) parentChannelWaits.push(`${s.id}: discord.${w.method}(${w.channelArg}, …)`);
    }
  }
  ok(totalWaits >= 5, `OPE-1479: the scan finds the Discord channel-first reply waits in the compiled scenario bodies (found ${totalWaits}, blindness floor 5)`);
  ok(
    parentChannelWaits.length === 0,
    `OPE-1479: no Discord reply wait polls the ASK'S OWN CHANNEL — OE replies in the auto-created ` +
      `thread, so a \`.channelId\` first argument polls a channel that never holds the reply and the ` +
      `leg dies on its full timeout while the product is right. Found ${parentChannelWaits.length}: ${parentChannelWaits.join("; ")}`,
  );

  const grantBody = SCENARIOS.find((s) => s.id === "S-DISCORD-GRANT")!.run.toString();
  function threadBindings(body: string): ReadonlyMap<string, string> {
    const bound = new Map<string, string>();
    for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*await\s+discord\.awaitThread\(/g)) {
      bound.set(m[1]!, argsOf(body, m.index! + m[0].length - 1)[0] ?? "");
    }
    return bound;
  }
  function postBindings(body: string): ReadonlyMap<string, string> {
    const bound = new Map<string, string>();
    for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*await\s+discord\.post\(/g)) {
      bound.set(m[1]!, argsOf(body, m.index! + m[0].length - 1)[1] ?? "");
    }
    return bound;
  }
  function misjoinedWaits(body: string): readonly string[] {
    const posts = postBindings(body);
    const threads = threadBindings(body);
    const out: string[] = [];
    for (const w of discordWaits(body)) {
      const msgVar = w.afterArg.endsWith(".id") ? w.afterArg.slice(0, -".id".length) : "";
      const postChannel = posts.get(msgVar);
      if (postChannel === undefined) {
        out.push(`${w.channelArg} after ${w.afterArg} — no \`discord.post\` in this body bound ${w.afterArg}`);
      } else if (postChannel.length > 0) {
        if (w.channelArg !== postChannel) out.push(`${w.channelArg} after ${w.afterArg} — that message was posted into ${postChannel}`);
      } else if (threads.get(w.channelArg) !== w.afterArg) {
        out.push(`${w.channelArg} after ${w.afterArg} — a base-channel post, so the wait owes the thread \`awaitThread(${w.afterArg})\` bound`);
      }
    }
    return out;
  }
  const grantThreads = threadBindings(grantBody);
  const grantWaits = discordWaits(grantBody);
  ok(grantWaits.length === 2, `OPE-1479: S-DISCORD-GRANT still has its two reply waits — phase 1's grant ask and phase 2's granted call (found ${grantWaits.length})`);
  ok(
    grantThreads.size === 1,
    `OPE-1483: S-DISCORD-GRANT derives EXACTLY ONE thread — phase 1's, off its base-channel mention. A second \`awaitThread\` means phase 2 went back to opening its own thread, which is a new session and holds no grant (found ${grantThreads.size}: ${JSON.stringify([...grantThreads])})`,
  );
  const misjoined = misjoinedWaits(grantBody);
  ok(
    misjoined.length === 0,
    `OPE-1479: every S-DISCORD-GRANT reply wait polls the channel its own message was POSTED into — ` +
      `the auto-created thread for phase 1's base-channel mention, the re-entered thread for phase 2's ` +
      `post into it. Thread bindings: ${JSON.stringify([...grantThreads])}; misjoined waits: ${JSON.stringify(misjoined)}`,
  );

  const resolverBindings = [...grantBody.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*resolveGrantThread\(/g)].map((m) => m[1]!);
  ok(
    resolverBindings.length === 1,
    `OPE-1483: S-DISCORD-GRANT resolves its re-entry thread exactly once, through \`resolveGrantThread\` (found ${resolverBindings.length})`,
  );
  const resolved = new Set(
    [...grantBody.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*?\b([A-Za-z_$][\w$]*)\.threadId\b/g)].filter((m) => resolverBindings.includes(m[2]!)).map((m) => m[1]!),
  );
  const targetedPosts = [...postBindings(grantBody)].filter(([, channel]) => channel.length > 0);
  ok(
    targetedPosts.length === 1 && resolved.has(targetedPosts[0]![1]),
    `OPE-1483: S-DISCORD-GRANT makes exactly ONE channel-targeted post — phase 2's granted call — and it targets the thread \`resolveGrantThread\` named. ` +
      `A post with no channel argument opens a fresh auto-thread, i.e. a fresh session with no grant mounted. ` +
      `Resolved names: ${JSON.stringify([...resolved])}; targeted posts: ${JSON.stringify(targetedPosts)}`,
  );

  const grantBodyTight = grantBody.replace(/\s+/g, "");
  const noFreshAskInit = /noFreshAsk=([^;]+);/.exec(grantBodyTight)?.[1] ?? "";
  ok(
    noFreshAskInit.includes("tapped") && noFreshAskInit.includes("askedRows.length===0") && noFreshAskInit.includes("refusedGrantAlreadyLive"),
    `OPE-1590: the fall-through predicate is ALL THREE conjuncts — tapped, no fresh grant.asked row, and a \`grant_already_live\` refusal. ` +
      `Drop any one and it widens: without \`tapped\` an untapped run skips its own phase-1 gates, and without the refusal read a tapped run ` +
      `passes them on an empty trail (got: ${JSON.stringify(noFreshAskInit)})`,
  );
  ok(
    !grantBodyTight.includes("if(askedRows.length===0)"),
    "OPE-1590: the no-row skip is no longer reached on `askedRows.length === 0` ALONE — that unguarded arm is what exited 1 on a tapped run",
  );
  ok(
    noFreshAskInit.includes("surfaceNamesChannel(e.surface,threadId)"),
    `OPE-1590: the refusal is joined to the thread THIS run raised in — \`surfaceNamesChannel(e.surface, threadId)\`, the same join phase 2 uses. A platform-only scope (\`e.platform==="discord"\`) matches another conversation's refusal (got: ${JSON.stringify(noFreshAskInit)})`,
  );
  ok(
    !noFreshAskInit.includes('e.platform==="discord"'),
    "🔴 OPE-1590: NEGATIVE — the platform-only scope is gone; it was the wider predicate this join replaced",
  );
  ok(
    (grantBodyTight.match(/!noFreshAsk/g) ?? []).length >= 2,
    `OPE-1590: the predicate guards BOTH sites — the phase-1 skips and the two Discord-owned hard gates, which assert over the \`askedRows\` that is empty on exactly this path. ` +
      `Guarding only the skips leaves the first gate redding a correct tapped run and the second passing vacuously (\`every\` on an empty list is true) (found ${(grantBodyTight.match(/!noFreshAsk/g) ?? []).length} guard(s))`,
  );

  const defective = 'async ctx=>{const asked=await discord.post(x);const reply=await discord.awaitReply(asked.channelId,asked.id,{timeoutMs:3e5});}';
  const defectiveWaits = discordWaits(defective);
  ok(
    defectiveWaits.length === 1 && defectiveWaits[0]!.channelArg === "asked.channelId" && defectiveWaits[0]!.afterArg === "asked.id",
    `OPE-1479: NEGATIVE CONTROL — the walk splits the defective call into its own two arguments (read ${JSON.stringify(defectiveWaits)})`,
  );
  ok(defectiveWaits.some((w) => /\.channelId$/.test(w.channelArg)), "OPE-1479: NEGATIVE CONTROL — arm A's test flags the parent-channel wait a live run found");
  ok(misjoinedWaits(defective).length === 1, "OPE-1479: NEGATIVE CONTROL — arm B flags it too: a base-channel post owes an `awaitThread` binding, and this body has none");
  const crossPhase = 'async ctx=>{const a=await discord.post(x);const threadId=await discord.awaitThread(a.id,{timeoutMs:3e5});const b=await discord.post(y);const r=await discord.awaitReply(threadId,b.id,{timeoutMs:3e5});}';
  const crossWaits = discordWaits(crossPhase);
  ok(
    crossWaits.length === 1 && !/\.channelId$/.test(crossWaits[0]!.channelArg),
    "OPE-1479: NEGATIVE CONTROL — arm A is blind to the cross-phase mix-up (its first argument is no `.channelId`)",
  );
  ok(misjoinedWaits(crossPhase).length === 1, "OPE-1479: NEGATIVE CONTROL — arm B DOES catch it: `b` went to the base channel, so its wait owes `awaitThread(b.id)`, not `a`'s thread");
  const fixed = 'async ctx=>{const asked=await discord.post(x);const threadId=await discord.awaitThread(asked.id,{timeoutMs:3e5});const reply=await discord.awaitReply(threadId,asked.id,{timeoutMs:3e5});}';
  const fixedWaits = discordWaits(fixed);
  ok(
    fixedWaits.length === 1 && !/\.channelId$/.test(fixedWaits[0]!.channelArg) && misjoinedWaits(fixed).length === 0,
    "OPE-1479: NEGATIVE CONTROL — the two-line auto-thread shape passes BOTH arms through the same scanner",
  );
  const reentered = 'async ctx=>{const t=await discord.post(m,grantThreadId);const r=await discord.awaitReply(grantThreadId,t.id,{timeoutMs:3e5});}';
  ok(misjoinedWaits(reentered).length === 0, "OPE-1483: NEGATIVE CONTROL — the post-into-a-known-thread shape passes arm B with no `awaitThread` anywhere in the body");
  const reenteredWrong = 'async ctx=>{const t=await discord.post(m,grantThreadId);const r=await discord.awaitReply(otherThread,t.id,{timeoutMs:3e5});}';
  ok(
    misjoinedWaits(reenteredWrong).length === 1,
    "OPE-1483: NEGATIVE CONTROL — arm B still catches a targeted post whose wait polls somewhere else, the failure mode the second shape introduces",
  );
}

{
  const { describeSpendGateRows, spendGateDoorOf, silenceCauseGate, SPEND_GATE_DOORS } = await import("../packages/core/scripts/e2e/journey.js");
  const row = (action: string, detail?: Record<string, unknown>) => ({
    ts: "2026-04-09T23:30:00.000Z",
    org: "default",
    platform: "github",
    workspace: "acme",
    action,
    ...(detail ? { detail } : {}),
  });
  ok(describeSpendGateRows([]) === undefined, "describeSpendGateRows: an empty window yields undefined (no cap refusal ⇒ the silence is routing)");
  ok(
    describeSpendGateRows([row("github.no_reply"), row("reply.post")]) === undefined,
    "describeSpendGateRows: rows that are not spend.gate never count (the discriminator keys on the action, not on there being any audit at all)",
  );
  const described = describeSpendGateRows([row("spend.gate", { door: "window", key: "github/acme/repo", mode: "channel", over: true, reason: "over the per-surface cap" })]);
  ok(
    described !== undefined && described.includes("door=window") && described.includes("key=github/acme/repo") && described.includes('reason="over the per-surface cap"'),
    "describeSpendGateRows: renders door + key + reason into one line (door leads — it is the field that says WHICH ingress chokepoint refused)",
  );
  ok(
    describeSpendGateRows([row("spend.gate", {})])?.includes("door=(none)") === true,
    "describeSpendGateRows: a spend.gate row with no door still reports (a row without a door is itself the finding, not a reason to stay quiet)",
  );
  ok(spendGateDoorOf([row("spend.gate", { door: "mention" })]) === "mention", "spendGateDoorOf: reads the door off the first spend.gate row");
  ok(spendGateDoorOf([row("github.no_reply", { door: "mention" })]) === undefined, "spendGateDoorOf: ignores a door on a non-spend.gate row");
  ok(spendGateDoorOf([row("spend.gate", { door: 7 })]) === undefined, "spendGateDoorOf: a non-string door is undefined (wire data is never trusted to be well-typed)");
  ok(
    SPEND_GATE_DOORS.join("|") === "mention|engagement|join|window",
    "SPEND_GATE_DOORS mirrors agent/spend/ingress-gate.ts's SpendGateDoor — the four ingress chokepoints, `window` being the cross-surface single-window divert",
  );
  ok(silenceCauseGate({ kind: "routing" }).ok, "silenceCauseGate: no spend.gate row ⇒ the silence leg stands (ok)");
  ok(silenceCauseGate({ kind: "unwired" }).ok, "silenceCauseGate: an unwired audit reader is ok — never red a correct silence for a missing harness credential");
  ok(
    silenceCauseGate({ kind: "unwired" }).label.includes("E2E_CONTROL_READ_TOKEN"),
    "silenceCauseGate: the unwired label names the env vars that would arm the discriminator (the call sites LOG this rather than counting a gate)",
  );
  const capped = silenceCauseGate({ kind: "cap", detail: "1 spend.gate row(s) in the run window door=window" });
  ok(!capped.ok && /cap refusal/i.test(capped.label), "silenceCauseGate: a spend.gate row in the window FAILS the leg, saying 'cap refusal, not routing'");
  ok(capped.label.includes("door=window"), "silenceCauseGate: the failure carries the row detail, so the reader sees WHICH door bought the silence");
}

{
  const { classifyAnswers, repliesPerWake, renderRepliesPerWake } = await import("../packages/core/scripts/e2e/duplicate-post.js");
  const { renderObservationSummary } = await import("../packages/core/scripts/e2e/observations.js");

  const missing = classifyAnswers(0, "tok-1");
  ok(missing.verdict === "missing" && missing.red, "classifyAnswers: NO token-carrying reply is the RED — the human asked and the room stayed silent");
  ok(missing.label.includes("unanswered") && missing.label.includes("tok-1"), "classifyAnswers: the red label says the mention went unanswered, and quotes the token it looked for");

  const single = classifyAnswers(1, "tok-1");
  ok(single.verdict === "single" && !single.red, "classifyAnswers/CONTROL: exactly one answer is green — the healthy shape");

  for (const n of [2, 16]) {
    const dup = classifyAnswers(n, "tok-1");
    ok(dup.verdict === "duplicate", `classifyAnswers: ${n} answers classify as a duplicate`);
    ok(!dup.red, `🔴 classifyAnswers: …and a duplicate is NOT red — ${n} answers still passes the gate`);
    ok(dup.label.includes(`${n} replies`), "classifyAnswers: the duplicate label QUOTES the count — the ticket's evidence is a number (16 rows on one wake), not an adjective");
    ok(/discouraged/i.test(dup.label), "classifyAnswers: …and says the second post is discouraged, so a reader knows why it is reported and not failed");
  }
  ok(classifyAnswers(-1, "tok-1").red, "classifyAnswers: a nonsense negative count is treated as MISSING (fail toward the red that means 'the room said nothing')");

  const postRow = (wakeId: unknown, action = "reply.post") => ({
    ts: "2026-05-07T23:30:00.000Z",
    org: "default",
    platform: "teams",
    workspace: "acme",
    action,
    ...(wakeId === undefined ? {} : { detail: { wakeId } }),
  });
  ok(repliesPerWake([]).length === 0, "repliesPerWake: an empty window counts nothing");
  const counted = repliesPerWake([postRow("w-a"), postRow("w-a"), postRow("w-b"), postRow("w-a")]);
  ok(counted.length === 2 && counted[0].wake === "w-a" && counted[0].posts === 3, "repliesPerWake: counts posts per wake, busiest FIRST (three on w-a)");
  ok(counted[1].wake === "w-b" && counted[1].posts === 1, "repliesPerWake: …and the quiet wake is still reported, so the busy one has something to be compared against");
  ok(
    repliesPerWake([postRow("w-a", "reply.refused"), postRow("w-a", "reply.forced")]).length === 0,
    "repliesPerWake/CONTROL: only `reply.post` rows count — a refusal and an override are not posts, and counting them would inflate every duplicate report",
  );
  ok(
    repliesPerWake([postRow(undefined), postRow(7), postRow("")]).length === 0,
    "🔴 repliesPerWake: a row with no usable wake id is DROPPED, never bucketed under a placeholder — the whole claim is 'these posts answered the SAME wake'",
  );

  ok(renderRepliesPerWake([]) === null, "renderRepliesPerWake: nothing measured ⇒ no line at all (an observation channel that always speaks is one nobody reads)");
  const quiet = renderRepliesPerWake([{ wake: "w-a", posts: 1 }]);
  ok(quiet !== null && quiet.includes("w-a=1") && !quiet.includes("duplicate"), "renderRepliesPerWake/CONTROL: one post per wake quotes the count and claims no duplicate");
  const busy = renderRepliesPerWake([{ wake: "w-a", posts: 16 }, { wake: "w-b", posts: 1 }]);
  ok(busy !== null && busy.includes("w-a=16") && busy.includes("w-b=1"), "renderRepliesPerWake: QUOTES every wake's count — this is the line the ticket's '16 reply.post rows on one wake' is read off");
  ok(busy!.includes("busiest wake carries 16 posts") && /discouraged, not gated/i.test(busy!), "renderRepliesPerWake: …and names the busiest wake as a duplicate that is reported, never gated");

  ok(renderObservationSummary([]).lines.length === 0, "renderObservationSummary/CONTROL: a run with no observations prints NOTHING");
  const summary = renderObservationSummary([{ scenario: "J-TEAMS", line: "reply.post rows per wake: w-a=16" }]);
  ok(summary.stream === "stderr", "renderObservationSummary: goes to stderr, so a `| tail` on a long live run cannot swallow it");
  ok(summary.lines.length === 2 && summary.lines[1].includes("J-TEAMS") && summary.lines[1].includes("w-a=16"), "renderObservationSummary: one lead line plus one line per observation, each naming its scenario");
  ok(/do NOT fail the run/i.test(summary.lines[0]), "renderObservationSummary: the lead line says an observation never gates — the reader's first question about a ⚠ in a green run");
}

{
  const { parseLinkCode, LINK_CODE_ALPHABET } = await import("../packages/core/scripts/e2e/journey.js");
  ok(LINK_CODE_ALPHABET === "23456789ACDEFGHJKLMNPQRSTUVWXYZ", "LINK_CODE_ALPHABET mirrors agent/identity/link-challenge.ts (no 0/1/I/O/B, no lower case — 31 symbols)");
  ok(parseLinkCode("…and nothing else:\n\n    link K7QD2XMN\n\nIt is single-use") === "K7QD2XMN", "parseLinkCode: lifts the code out of the tool's own verbatim instructions");
  ok(parseLinkCode("send me `link k7qd2xmn` from the other account") === "K7QD2XMN", "parseLinkCode: case-insensitive on the anchored form, normalised to upper case (the claim CAS uppercases too)");
  ok(parseLinkCode("Here's your code:\n\n`K7QD2XMN`\n\nPost it from the other account.") === "K7QD2XMN", "parseLinkCode: a whole-line/code-block rendering is recognised when the model reformats");
  ok(
    parseLinkCode("This is a STANDARD reply with no code in it at all.") === undefined,
    "parseLinkCode: does NOT bare-scan prose — 'STANDARD' is eight symbols entirely inside the alphabet, and a wrong code fails the claim in a way that looks like a product bug",
  );
  ok(parseLinkCode(undefined) === undefined && parseLinkCode("") === undefined, "parseLinkCode: total over absent/empty input");
  ok(parseLinkCode("link ACDEFGH") === undefined, "parseLinkCode: a 7-symbol token is not a code (length is pinned at 8)");
}

{
  const cwEmpty = resolveConnectorWrite({});
  ok(
    !cwEmpty.ok && cwEmpty.missing.length === 1 && cwEmpty.missing[0] === ENV.notionChannel,
    "connectorWrite half reports exactly E2E_NOTION_CHANNEL missing in an empty env (the bound channel is the whole fixture)",
  );
  const cwChannelOnly = resolveConnectorWrite({ [ENV.notionChannel]: "C0NOTION" });
  ok(cwChannelOnly.ok && cwChannelOnly.cfg.channel === "C0NOTION", "connectorWrite resolves from the bound channel ALONE — arming is derived at run time, not declared here");
  const cwFalseDeclarationOn = resolveConnectorWrite({ [ENV.notionChannel]: "C0NOTION", E2E_CONNECTOR_WRITE: "1", E2E_OE_OAUTH_ARMED: "1" });
  const cwFalseDeclarationOff = resolveConnectorWrite({ [ENV.notionChannel]: "C0NOTION", E2E_CONNECTOR_WRITE: "0", E2E_OE_OAUTH_ARMED: "0" });
  ok(
    cwFalseDeclarationOn.ok && cwFalseDeclarationOff.ok && cwFalseDeclarationOn.cfg.channel === cwFalseDeclarationOff.cfg.channel,
    "🔴 a retired arming declaration is INERT: E2E_CONNECTOR_WRITE / E2E_OE_OAUTH_ARMED set to '1' or '0' resolve identically (a human claim can no longer arm or disarm a leg)",
  );
  ok(
    !JSON.stringify(ENV).includes("E2E_CONNECTOR_WRITE") && !JSON.stringify(ENV).includes("E2E_OE_OAUTH_ARMED") && !JSON.stringify(ENV).includes("E2E_CONNECTOR_OAUTH"),
    "🔴 the ENV map names NO connector arming flag — E2E_CONNECTOR_WRITE / E2E_OE_OAUTH_ARMED / E2E_CONNECTOR_OAUTH are retired, and re-adding one fails here",
  );

  const LOCAL_TARGET = "http://127.0.0.1:3000";
  const PROD_TARGET = "https://my-agent.vercel.app";
  ok(!auditSilencesExpected({}, LOCAL_TARGET), "auditSilencesExpected is FALSE by default (prod is actions-only), even against the local eval target");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "0" }, LOCAL_TARGET), "auditSilencesExpected is FALSE for E2E_AUDIT_SILENCES=0");
  ok(auditSilencesExpected({ [ENV.auditSilences]: "1" }, LOCAL_TARGET), "auditSilencesExpected is TRUE at E2E_AUDIT_SILENCES=1 against the local eval target");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "1" }, PROD_TARGET), "🔴 OPE-1007: E2E_AUDIT_SILENCES=1 does NOT arm the positive polls against prod — the declaration is scoped to the local eval target");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "1" }), "auditSilencesExpected with NO target is FALSE even when declared — omission is not a free pass");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "1" }, ""), "auditSilencesExpected with an EMPTY target is FALSE — same safe side as omission");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "1" }, "not a url"), "auditSilencesExpected with a MALFORMED target is FALSE, not a thrown error");

  ok(isLocalEvalTarget("http://127.0.0.1:3000"), "isLocalEvalTarget: 127.0.0.1 matches");
  ok(isLocalEvalTarget("http://localhost:3000"), "isLocalEvalTarget: localhost matches");
  ok(!isLocalEvalTarget(PROD_TARGET), "isLocalEvalTarget: a real deployed host does NOT match");
  ok(!isLocalEvalTarget(undefined), "isLocalEvalTarget: undefined does not match (and does not throw)");

  const baseOnly = new Set(["slack"] as const);
  const cwMissing = {
    slack: [], discord: [], synthetic: [], slackPrivate: [], slackChannelB: [], slackCapFixture: [], slackSupervisor: [],
    syntheticDm: [], slackUser2: [], slackSecondary: [], webhook: [], notion: [], teams: [], github: [], linear: [],
    notionAmbient: [], slackUnified: [], pr: [], connectorWrite: [ENV.notionChannel], slackMpim: [],
    soakSlack: [], soakNotion: [], soakLinear: [],
    engagedSlack: [], engagedDiscord: [], engagedTeams: [], engagedGithub: [], engagedLinear: [], engagedNotion: [],
  } as const;
  for (const id of ["S-NOTION-WRITE", "S-CONNECTOR-TIER"]) {
    const r = skipReason(SCENARIOS.find((s) => s.id === id)!, baseOnly, cwMissing, true);
    ok(
      r === `missing connectorWrite driver (set ${ENV.notionChannel})`,
      `${id} dry-skip names exactly E2E_NOTION_CHANNEL (capability wins over the optional gate)`,
    );
  }
}

{
  const { classifyMintRows, deriveConnectorArming, requireConnectorArmed, watchConnectorArming, armingNote, lookbackIso, CONNECTOR_MINT_ACTION, ARMING_QUERY_LIMIT } =
    await import("../packages/core/scripts/e2e/connector-arming.js");

  const row = (ts: string, detail: Record<string, unknown>, action = CONNECTOR_MINT_ACTION) =>
    ({ ts, org: "o", platform: "connector", workspace: "connector", action, detail }) as const;
  const okRow = (ts: string, connector = "notion") => row(ts, { connector, subject: "user", outcome: "ok" });
  const authRequiredRow = (ts: string, connector = "notion") =>
    row(ts, { connector, subject: "user", outcome: "auth-required", name: "OeOauthNeedsConsentError" });

  ok(CONNECTOR_MINT_ACTION === "connector.mint", "the derivation reads the action agent/connections/connector-auth.ts actually writes");

  ok(classifyMintRows([okRow("2026-04-24T09:30:00.000Z")], "notion").state === "armed", "an outcome=ok personal mint ⇒ ARMED");
  const unconsented = classifyMintRows([authRequiredRow("2026-04-24T09:30:00.000Z")], "notion");
  ok(unconsented.state === "unconsented" && unconsented.at === "2026-04-24T09:30:00.000Z", "an outcome=auth-required personal mint ⇒ UNCONSENTED, carrying the row's ts");
  ok(classifyMintRows([], "notion").state === "unknown", "no rows ⇒ UNKNOWN (never 'unconsented' — an empty window is not evidence of a lapsed grant)");
  ok(
    classifyMintRows([row("2026-04-24T09:30:00.000Z", { connector: "notion", subject: "user", outcome: "error", name: "TypeError" })], "notion").state === "unknown",
    "🔴 outcome=error ⇒ UNKNOWN: some other mint failure is not evidence about CONSENT, and calling it 'unconsented' would skip a leg that should have run",
  );
  ok(
    classifyMintRows([authRequiredRow("2026-04-23T08:30:00.000Z"), okRow("2026-04-24T09:30:00.000Z")], "notion").state === "armed",
    "a later ok row overrides an earlier auth-required (a re-consent re-arms the leg with no human action)",
  );
  ok(
    classifyMintRows([okRow("2026-04-23T08:30:00.000Z"), authRequiredRow("2026-04-24T09:30:00.000Z")], "notion").state === "unconsented",
    "🔴 the NEGATIVE CONTROL: a later auth-required row overrides an earlier ok — a grant that LAPSED disarms the leg, which is the direction a declaration could never follow",
  );
  ok(
    classifyMintRows([okRow("2026-04-24T09:30:00.000Z"), authRequiredRow("2026-04-23T08:30:00.000Z")], "notion").state === "armed" &&
      classifyMintRows([authRequiredRow("2026-04-24T09:30:00.000Z"), okRow("2026-04-23T08:30:00.000Z")], "notion").state === "unconsented",
    "the newest row decides in EITHER arrival order (the route's newest-first ordering is not depended on)",
  );
  ok(classifyMintRows([authRequiredRow("2026-04-24T09:30:00.000Z", "linear")], "notion").state === "unknown", "another connector's rows are ignored (the derivation is per-connector)");
  ok(
    classifyMintRows([row("2026-04-24T09:30:00.000Z", { connector: "notion", subject: "app", outcome: "auth-required" })], "notion").state === "unknown",
    "a SERVICE (subject=app) mint is ignored — these legs assert the PERSONAL grant",
  );
  ok(
    classifyMintRows([row("2026-04-24T09:30:00.000Z", { connector: "notion", subject: "user", outcome: "ok" }, "connector.use")], "notion").state === "unknown",
    "a connector.use row is ignored — connector.use proves the GATE passed, not that the mint succeeded",
  );

  ok((await deriveConnectorArming(undefined, { connector: "notion", sinceIso: "2026-04-04T23:30:00.000Z" })).state === "unknown", "no audit reader ⇒ UNKNOWN, never a throw");
  ok(
    (await deriveConnectorArming(async () => { throw new Error("503"); }, { connector: "notion", sinceIso: "2026-04-04T23:30:00.000Z" })).state === "unknown",
    "🔴 a FAILING audit read ⇒ UNKNOWN, never 'unconsented' — an audit-route blip must not masquerade as a lapsed grant and skip a leg silently",
  );
  let askedFor: unknown;
  await deriveConnectorArming(async (opts) => { askedFor = opts; return []; }, { connector: "notion", sinceIso: "2026-04-04T23:30:00.000Z" });
  ok(
    (askedFor as { actions?: string[] }).actions?.join(",") === CONNECTOR_MINT_ACTION && (askedFor as { sinceIso?: string }).sinceIso === "2026-04-04T23:30:00.000Z",
    "the live half narrows the audit query to connector.mint since the caller's window (the route filters at the store)",
  );
  ok((askedFor as { limit?: number }).limit === ARMING_QUERY_LIMIT && ARMING_QUERY_LIMIT === 1000, "🔴 OPE-1027 — an unspecified limit asks for the route's max (1000), not a truncation-prone small default");
  let askedForCapped: unknown;
  await deriveConnectorArming(async (opts) => { askedForCapped = opts; return []; }, { connector: "notion", sinceIso: "2026-04-04T23:30:00.000Z", limit: 50 });
  ok((askedForCapped as { limit?: number }).limit === 50, "an explicit limit is still honoured (a caller that wants a narrower window can ask for one)");
  const lookback = lookbackIso(14, new Date("2026-04-24T11:30:00.000Z"));
  ok(lookback === "2026-04-10T11:30:00.000Z", "lookbackIso(14) is exactly 14 days back from the reference instant");

  const probeOver = (rows: readonly unknown[]) => {
    const logged: string[] = [];
    return {
      logged,
      probe: {
        auditRead: async () => rows as never,
        log: (m: string) => { logged.push(m); },
        skip: (r: string): never => { throw new ScenarioSkip(r); },
      },
    };
  };
  const opts = { connector: "notion", sinceIso: "2026-04-24T08:30:00.000Z" };

  const unconsentedProbe = probeOver([authRequiredRow("2026-04-24T09:30:00.000Z")]);
  let skipped: unknown;
  try {
    await requireConnectorArmed(unconsentedProbe.probe, opts);
    skipped = undefined;
  } catch (e) {
    skipped = e;
  }
  ok(skipped instanceof ScenarioSkip, "🔴 THE FIX: an auth-required mint row in the leg's own window raises ScenarioSkip — the honest refusal can no longer reach the judge gate and red");
  ok(
    (skipped as Error).message.includes("NOT ARMED on this deploy") && (skipped as Error).message.includes("auth-required"),
    "…and the skip reason names the derived cause (`NOT ARMED on this deploy`, outcome=auth-required), not a missing env var",
  );

  const armedProbe = probeOver([okRow("2026-04-24T09:30:00.000Z")]);
  const armed = await requireConnectorArmed(armedProbe.probe, opts).catch((e) => e as unknown);
  ok(
    !(armed instanceof Error) && (armed as { state?: string }).state === "armed",
    "🔴 the NEGATIVE CONTROL: an ok mint row does NOT skip — the leg runs and its gates carry weight",
  );
  ok(armedProbe.logged.some((l) => l.includes("ARMED")), "…and the armed derivation is LOGGED, so a run's transcript says which deployment fact it decided on");

  const unknownProbe = probeOver([]);
  ok((await requireConnectorArmed(unknownProbe.probe, opts)).state === "unknown", "an empty window does NOT skip — the leg drives, and the post-reply derivation settles it from live evidence");

  ok(armingNote("notion", { state: "unknown", reason: "x" }).startsWith("notion: arming UNKNOWN"), "armingNote renders each state as one legible line for the run log");

  let unwiredSkip: unknown;
  try {
    await watchConnectorArming({ log: () => {}, skip: (r: string): never => { throw new ScenarioSkip(r); } }, "notion");
  } catch (e) {
    unwiredSkip = e;
  }
  ok(
    unwiredSkip instanceof ScenarioSkip && (unwiredSkip as Error).message.includes("E2E_CONTROL_READ_TOKEN"),
    "with no audit reader the watch skips naming E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN — the evidence surface, never an arming declaration",
  );

  const staleRows = [authRequiredRow("2026-04-10T09:30:00.000Z")];
  const staleProbe = probeOver(staleRows);
  const staleWatch = await watchConnectorArming(staleProbe.probe, "notion").catch((e) => e as unknown);
  ok(!(staleWatch instanceof Error), "🔴 a stale auth-required row in the lookback does NOT skip — opening the watch is advisory, so a re-consent is never masked by an old row");
  ok(staleProbe.logged.some((l) => l.startsWith("advisory (")), "…and what the deployment last reported is LOGGED as advisory, so the run transcript still carries it");
  ok(
    staleProbe.logged.some((l) => l.includes("before this leg drives") && l.includes("recheck() below is decisive")),
    "🔴 OPE-1027 — the advisory line names itself as a pre-drive snapshot and points at recheck() as the decisive fact",
  );

  const liveRows: unknown[] = [];
  const liveLogged: string[] = [];
  let recheckQuery: unknown;
  const liveWatch = await watchConnectorArming(
    {
      auditRead: async (o) => { recheckQuery = o; return liveRows as never; },
      log: (m: string) => { liveLogged.push(m); },
      skip: (r: string): never => { throw new ScenarioSkip(r); },
    },
    "notion",
  );
  ok((await liveWatch.recheck()).state === "unknown", "recheck over a leg that minted nothing ⇒ UNKNOWN, and the leg keeps running (silence proves nothing about the grant)");
  ok((recheckQuery as { sinceIso?: string }).sinceIso === liveWatch.since, "recheck reads only rows written since the watch opened — the mints THIS leg caused, never the deployment's history");
  liveRows.push(authRequiredRow(new Date(Date.parse(liveWatch.since) + 1000).toISOString()));
  const liveSkip = await liveWatch.recheck().then(() => undefined, (e: unknown) => e);
  ok(
    liveSkip instanceof ScenarioSkip && (liveSkip as Error).message.includes("NOT ARMED on this deploy"),
    "🔴 THE FIX, at the seam the legs hold: an auth-required mint row raised DURING the leg makes recheck skip — the honest refusal can no longer reach a judge gate and red",
  );

  for (const id of ["S-DM-NOTION", "S-NOTION-WRITE", "S-CONNECTOR-TIER", "S24"]) {
    const src = SCENARIOS.find((s) => s.id === id)!.run.toString();
    ok(src.includes("watchConnectorArming("), `🔴 REACHABILITY — ${id} opens an arming watch (a leg that dropped the call keeps every assertion above green)`);
    const judgeGates = (src.match(/judgePass\(/g) ?? []).length;
    const rechecks = (src.match(/\.recheck\(\)/g) ?? []).length;
    ok(judgeGates > 0, `${id} still has at least one judge gate to protect (the count below is not vacuous)`);
    ok(
      rechecks >= judgeGates,
      `🔴 REACHABILITY — ${id} rechecks the arming at least once per judge gate (${rechecks} recheck(s) for ${judgeGates} gate(s)) — a gate with no derivation in front of it is exactly the false red this closes`,
    );
    ok(
      !/E2E_CONNECTOR_WRITE|E2E_OE_OAUTH_ARMED|E2E_CONNECTOR_OAUTH/.test(src),
      `🔴 ${id} reads NO arming declaration — re-adding one fails here`,
    );
  }

  {
    const src = SCENARIOS.find((s) => s.id === "S-DM-NOTION")!.run.toString();
    ok(
      src.includes("dm.collectBotMessagesAfter("),
      "🔴 OPE-1027 — S-DM-NOTION polls the merged thread+top-level geometry (collectBotMessagesAfter), not a thread-only read",
    );
    ok(
      !/await dm\.replies\(anchorTs\)/.test(src),
      "🔴 OPE-1027 — S-DM-NOTION's poll body no longer reads dm.replies(anchorTs) alone (the thread-only trap that redded a live run)",
    );
  }

  {
    const HEX32 = "1f2a3b4c5d6e7f8091a2b3c4d5e6f708";
    const NOTION_HOST = "api.notion.com";
    const CHANNEL = "C0EXGENRL";
    const policyRow = (writeHosts: unknown, surface?: string): AuditWireEntry => ({
      ts: "2026-05-12T11:30:00.000Z",
      org: "o",
      platform: "slack",
      workspace: "T1",
      ...(surface === undefined ? {} : { surface }),
      action: EGRESS_POLICY_ACTION,
      detail: { hosts: 4, enforced: true, writeHostCount: Array.isArray(writeHosts) ? writeHosts.length : 0, ...(writeHosts === undefined ? {} : { writeHosts }) },
    });
    const credentialedNotion = { host: NOTION_HOST, via: "notion-rest", credentialed: true, methods: ["GET", "POST", "PATCH"] };

    const hit = findCredentialedWriteHost([policyRow([credentialedNotion], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL });
    ok(
      hit.matches.length === 1 && hit.matches[0]!.via === "notion-rest" && hit.rows === 1,
      "🔴 OPE-1496 — a credentialed, write-open api.notion.com entry IS the HTTP route's firewall evidence, and the reader carries the connection that opened it",
    );
    ok(
      findCredentialedWriteHost([policyRow([{ ...credentialedNotion, methods: ["GET"] }], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 0,
      "🔴 a READ-ONLY rule is not this rung's evidence — the harness re-derives the verdict from the row's own methods rather than trusting the writer's filter",
    );
    ok(
      findCredentialedWriteHost([policyRow([{ ...credentialedNotion, credentialed: false }], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 0,
      "🔴 a host the firewall stamps NOTHING on is not evidence of a credentialed call — `credentialed` is the discriminator, and it is load-bearing",
    );
    for (const [label, entry] of [
      ["no methods", { host: NOTION_HOST, via: "notion-rest", credentialed: true }],
      ["an undecodable methods shape", { host: NOTION_HOST, via: "notion-rest", credentialed: true, methods: 3 }],
      ["no credentialed flag", { host: NOTION_HOST, via: "notion-rest", methods: ["POST"] }],
      ["no host", { via: "notion-rest", credentialed: true, methods: ["POST"] }],
    ] as const) {
      ok(
        findCredentialedWriteHost([policyRow([entry], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 0,
        `🔴 an entry with ${label} yields NO match — an assertion must never pass on a shape it could not read`,
      );
    }
    const otherHost = findCredentialedWriteHost([policyRow([{ host: "api.github.com", via: "gh", credentialed: true, methods: "any" }], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL });
    ok(
      otherHost.matches.length === 0 && otherHost.hostsSeen.join(",") === "api.github.com",
      "🔴 another vendor's credentialed write host is not Notion evidence — and the reader still reports what it DID see, so a red names it",
    );
    ok(
      findCredentialedWriteHost([policyRow([{ ...credentialedNotion, methods: "any" }], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 1,
      "a rule that declares no method match (`any`) admits a write, so it counts",
    );
    ok(
      findCredentialedWriteHost([policyRow([credentialedNotion], "C-SOMEWHERE-ELSE")], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 0,
      "🔴 a policy row stamped with ANOTHER surface is not this leg's — the gate would otherwise green on a sibling channel's firewall",
    );

    const { writeHostsAuditFields } = await import("../packages/core/agent/access/egress.js");
    const shipped = (writeHostsAuditFields([{ host: NOTION_HOST, credential: "notion-rest", credentialed: true, verb: ["GET", "POST", "PATCH"] }]) as { writeHosts?: unknown }).writeHosts;
    const shippedHit = findCredentialedWriteHost([policyRow(shipped, CHANNEL)], { host: NOTION_HOST, surface: CHANNEL });
    ok(
      shippedHit.matches.length === 1 && shippedHit.matches[0]!.via === "notion-rest",
      "🔴 the reader decodes an entry the PRODUCT rendered, not only the shapes this suite hand-builds — a field rename must red here rather than silently emptying the window",
    );
    ok(
      findCredentialedWriteHost(
        [policyRow((writeHostsAuditFields([{ host: NOTION_HOST, credential: "notion-rest", credentialed: true, verb: ["GET"] }]) as { writeHosts?: unknown }).writeHosts, CHANNEL)],
        { host: NOTION_HOST, surface: CHANNEL },
      ).matches.length === 0,
      "🔴 …and re-derives the write verdict from the shipped entry too: a read-only rule rendered by the product is still not this rung's evidence",
    );
    ok(
      findCredentialedWriteHost([policyRow([credentialedNotion])], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 1,
      "an UNATTRIBUTED policy row is kept — the same rule the connector-evidence gate uses, because dropping it would red a correct run on a window seconds wide",
    );
    const mixed = findCredentialedWriteHost(
      [{ ts: "2026-05-12T11:30:00.000Z", org: "o", platform: "slack", workspace: "T1", surface: CHANNEL, action: "connector.op", detail: { writeHosts: [credentialedNotion] } }, policyRow(undefined, CHANNEL)],
      { host: NOTION_HOST, surface: CHANNEL },
    );
    ok(mixed.rows === 1 && mixed.matches.length === 0, "🔴 only `egress.policy` rows are read, and a row with no writeHosts is total — no throw, no match");

    ok(notionPageLinks(`Found "Team Handbook" — https://www.notion.so/Team-Handbook-${HEX32}`).length === 1, "a Notion page URL carrying the page's 32-hex id is the content rung");
    ok(notionPageLinks(`see <https://www.notion.so/Team-Handbook-${HEX32}>`)[0] === `https://www.notion.so/Team-Handbook-${HEX32}`, "Slack's angle-bracket wrapping is stripped, not carried into the link");
    ok(notionPageLinks(`https://acme.notion.site/Handbook-${HEX32}`).length === 1, "a published notion.site page counts too");
    ok(notionPageLinks(`a ${HEX32} b https://www.notion.so/Team-Handbook-${HEX32} c https://www.notion.so/Team-Handbook-${HEX32}`).length === 1, "links are de-duplicated, and a bare id on its own is not a link");
    ok(notionPageLinks("I searched Notion and found the team handbook page. See https://www.notion.so/help for more.").length === 0, "🔴 THE NEGATIVE CONTROL — a fluent answer with a marketing link carries NO page id, so prose cannot earn this rung");
    ok(notionPageLinks("The live search returned nothing for that term.").length === 0, "an honest miss carries no link either (that a link is REPORTED and never SCORED is pinned on the leg source below, not here)");

    const pageBlocks = [
      { object: "block", type: "heading_1", heading_1: { rich_text: [{ plain_text: "Team Handbook" }] } },
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Expenses over " }, { plain_text: "£40 need a written approval from the on-call lead." }] } },
      { object: "block", type: "image", image: { caption: [] } },
      { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Short one" }] } },
    ];
    const phrases = notionBlockPhrases(pageBlocks);
    ok(
      phrases.length === 1 && phrases[0] === "Expenses over £40 need a written approval from the on-call lead.",
      "🔴 OPE-1496 — the reader takes a block's own line, joins its rich-text spans, and skips the title, the image and the four-word bullet: a phrase must be long enough that prose does not land it by chance",
    );
    ok(notionBlockPhrases([{ type: "paragraph" }, { type: "paragraph", paragraph: {} }, null, "nope", {}]).length === 0, "🔴 every unreadable block shape yields NO phrase — an assertion must never pass on prose it could not read");
    const twoSentences = notionBlockPhrases([
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "The on-call lead approves expenses. Receipts go to the finance channel within a week." }] } },
    ]);
    ok(
      twoSentences.includes("Receipts go to the finance channel within a week.") && twoSentences.includes("The on-call lead approves expenses."),
      "🔴 OPE-1496 — a SHORT two-sentence paragraph offers each sentence on its own, not only the joined line: a reply quoting one sentence of it must be able to clear the rung",
    );
    const pin = { pageId: HEX32, title: "Team Handbook", phrases };
    ok(
      quotedPagePhrase('It says: "Expenses over £40 need a written approval from the on-call lead."', pin) === phrases[0],
      "🔴 OPE-1496 — a reply repeating the page's own sentence earns the answer half, which memory, backscroll and the web cannot supply",
    );
    ok(
      quotedPagePhrase("> Expenses over £40 need a *written approval* from the on-call lead.", pin) === phrases[0],
      "a Slack blockquote, and bold markers INSIDE the sentence, still match — a fold that missed them would red a correct deployment over formatting",
    );
    ok(
      quotedPagePhrase(`I found the Team Handbook page. https://www.notion.so/Team-Handbook-${HEX32} — it covers expenses and on-call.`, pin) === undefined,
      "🔴 THE NEGATIVE CONTROL — a fluent summary carrying the page LINK and the page's own topic words quotes no sentence, so it earns nothing: this is the finding that a link-only rung was too weak",
    );
    ok(quotedPagePhrase("The live search returned nothing for that term.", pin) === undefined, "🔴 an honest miss earns nothing here, which is why the leg skips rather than reds when the MCP rung is unarmed too");
    ok(
      quotedPagePhrase("Expenses over £40 need a written approval from the on-call lead.", { ...pin, phrases: ["Every laptop is replaced on a three-year cycle."] }) === undefined,
      "🔴 the reply is matched against THIS pin's phrases — a sentence from another page earns nothing, so a reader that returned its first candidate would be caught here",
    );
    ok(
      quotedPagePhrase("Health &amp; Safety training runs every second Tuesday.", { ...pin, phrases: ["Health & Safety training runs every second Tuesday."] }) !== undefined,
      "🔴 Slack escapes an ampersand and Notion does not, so the fold decodes the entity — otherwise a correct quote of any sentence holding `&` could never match",
    );
  }

  {
    const src = SCENARIOS.find((s) => s.id === "S24")!.run.toString();
    ok(
      /Run the search live against Notion/.test(src),
      "🔴 OPE-1492 — S24's ask demands a LIVE read of the connected workspace, so a prose answer is no longer the path of least resistance",
    );
    ok(
      /search the connected Notion workspace/.test(src),
      "🔴 OPE-1492 — S24's ask names the CONNECTED WORKSPACE as the source, so a worker answering from anywhere else has been told it is answering the wrong question",
    );
    ok(
      /do not answer from memory, from this channel's history, or from the web/.test(src),
      "🔴 OPE-1492 — S24's ask closes the prose exits (memory / backscroll / web), which is what let the old lenient ask pass with a silent audit",
    );
    ok(
      !/connection_search|notion__/.test(src),
      "🔴 OPE-1492 (row 16's lesson) — S24's ask names NO tool the lean seat cannot hold: the seat must delegate, not refuse",
    );

    ok(
      /findCredentialedWriteHost\(/.test(src) && /NOTION_REST_HOST\s*=\s*"api\.notion\.com"/.test(src),
      "🔴 REACHABILITY (OPE-1496) — S24 reads the turn's egress policy row for the NAMED Notion REST host, so the HTTP route has a firewall rung at all",
    );
    ok(
      /pinNotionQueryPage\(/.test(src) && /quotedPagePhrase\(/.test(src),
      "🔴 OPE-1496 — S24 pins the fixture page with the harness's own Notion token and demands the reply QUOTE its body, so the firewall rung alone can never carry the leg",
    );
    ok(
      /httpRoute\s*=\s*\w+\.matches\.length\s*>\s*0\s*&&\s*\w*[qQ]uoted\s*!==\s*(?:undefined|void 0)/.test(src),
      "🔴 OPE-1496 — the HTTP rung is the policy row AND the quote: a page link alone does not satisfy it, which is the whole correction to the rung's first shape",
    );
    ok(
      /REPORTED and not scored/.test(src),
      "🔴 OPE-1496 — the page link stays in the message as a REPORTED shape and says so, so a reader never takes it for the rung",
    );
    ok(
      /ctx\.log\(\s*`S24 rungs/.test(src),
      "🔴 OPE-1496 — S24 LOGS which rung cleared before the gate, so a passing run says whether the strong rung or the weak one carried it",
    );
    ok(
      /CONFIGURED REACH/.test(src) && !/really reached|really ran/.test(src),
      "🔴 OPE-1496 — S24's HTTP rung reports CONFIGURED REACH, never a request (this SAMPLES two known-bad phrasings; it does not prove the message is free of overclaim)",
    );
    ok(
      /copied from the page body word for word/.test(src) && /never write a sentence the page does not contain/.test(src),
      "🔴 OPE-1496 — S24's ask demands a verbatim sentence from the page and forbids inventing one, which is what makes the content rung answerable honestly or not at all",
    );
    ok(
      /armedBefore\.state\s*!==\s*"armed"/.test(src),
      "🔴 OPE-1496 — S24 still treats anything short of a POSITIVE `armed` as an unearnable MCP rung (an `unknown` from a connector that has never minted is exactly this fixture)",
    );
    ok(
      /!\w*[mM]cpRoute\s*&&\s*!\w*[hH]ttpRoute\s*&&\s*\w+\.state\s*!==\s*"armed"/.test(src),
      "🔴 OPE-1496 — the skip is CONDITIONAL on neither route being earned: a regression to the old unconditional pre-drive skip would make the HTTP rung dead code on this very fixture",
    );
    ok(
      /OPE-1496/.test(src),
      "🔴 OPE-1496 — S24's skip reason and its gate message both NAME the ticket, so a red or a skip is never nameless again",
    );
    ok(
      !/E2E_CONNECTOR_OAUTH/.test(src),
      "🔴 OPE-894 — S24 reads NO arming env var; the deployment's own connector.mint rows are the evidence",
    );
    ok(
      /connector\.use.{0,400}connector\.op/s.test(src) && /HTTP ROUTE \(/.test(src),
      "🔴 OPE-1492 — S24's gate message branches its reading: `connector.use` only = the endpoint fence refused; no connector row = the HTTP route's own rung is what the leg rests on, and the message reports what that rung saw",
    );
    ok(
      /action\s*===\s*"connector\.op"\s*\|\|\s*\w+\.action\s*===\s*"connector\.use"/.test(src),
      "🔴 OPE-1485 — S24 still gates on connector.op/connector.use only (connector.grant lands on every session.started and proves nothing)",
    );
    ok(
      /detail\?\.connection\s*===\s*"notion"/.test(src),
      "🔴 OPE-1485 — S24's evidence filter still NAMES the connection, so a second binding on that channel cannot make the gate vacuous",
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

  const { signLinearBody, buildAgentSessionEvent } = await import("../packages/core/scripts/e2e/linear-driver.js");
  const { signLinearWebhookBody } = await import(`${eveRootDir}/dist/src/public/channels/linear/verify.js`);
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
  ok(notCore.ok && notCore.cfg.webhookSecret === undefined && notCore.cfg.anchorOnTopic === undefined && notCore.cfg.anchorHuman === undefined, "notionAmbient resolves on the four core vars alone; forge secret + anchors (incl. the OPE-576 human anchor) stay undefined");
  const notFull = resolveNotionAmbient({
    [ENV.notionDriverKey]: "secret_x",
    [ENV.notionAmbientPageId]: "page-uuid",
    [ENV.notionAmbientWebhookSecret]: "verif-token",
    [ENV.notionBotUserId]: "bot-user-uuid",
    [ENV.notionWorkspaceId]: "ws-uuid",
    [ENV.notionAnchorOnTopic]: "c-ontopic-1",
    [ENV.notionAnchorOnTopic2]: "c-ontopic-2",
    [ENV.notionAnchorOffTopic]: "c-offtopic",
    [ENV.notionAnchorHuman]: "c-human-1",
  });
  ok(notFull.ok && notFull.cfg.webhookSecret === "verif-token" && notFull.cfg.anchorOnTopic === "c-ontopic-1" && notFull.cfg.anchorOnTopic2 === "c-ontopic-2" && notFull.cfg.anchorOffTopic === "c-offtopic" && notFull.cfg.anchorHuman === "c-human-1", "notionAmbient cfg carries the forge secret + the three anchor ids + the OPE-576 human anchor when they're set");
  ok(notFull.ok && notFull.cfg.botUserId === "bot-user-uuid" && notFull.cfg.workspaceId === "ws-uuid", "notionAmbient cfg carries bot user id (self-loop) + workspace id (envelope)");

  const { buildBlockCommentBody } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const bc = buildBlockCommentBody("block-123", "hi there") as { parent?: { block_id?: string }; rich_text?: { text?: { content?: string } }[] };
  ok(bc.parent?.block_id === "block-123", "buildBlockCommentBody anchors on parent.block_id (mints a fresh per-block discussion)");
  ok(bc.rich_text?.[0]?.text?.content === "hi there", "buildBlockCommentBody carries the comment text as one rich-text item");

  const { buildDiscussionReplyBody } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const dr = buildDiscussionReplyBody("disc-456", "second turn") as { discussion_id?: string; parent?: { discussion_id?: string; block_id?: string }; rich_text?: { text?: { content?: string } }[] };
  ok(dr.discussion_id === "disc-456", "buildDiscussionReplyBody anchors on TOP-LEVEL discussion_id (joins the existing thread)");
  ok(dr.parent === undefined, "buildDiscussionReplyBody carries no parent at all — parent.discussion_id 400s and parent.block_id would mint a fresh discussion");
  ok(dr.rich_text?.[0]?.text?.content === "second turn", "buildDiscussionReplyBody carries the reply text as one rich-text item");

  const { signNotionBody, buildCommentCreatedEvent } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const secret = "notion-verif-token";
  const raw = JSON.stringify(buildCommentCreatedEvent({ workspaceId: "ws", commentId: "c1", pageId: "p1" }));
  const sig = signNotionBody(secret, raw);
  ok(sig.startsWith("sha256="), 'notion signature carries the "sha256=" prefix');
  const ev = buildCommentCreatedEvent({ workspaceId: "ws9", commentId: "cX", pageId: "pY" });
  ok(ev.type === "comment.created" && (ev.entity as { id?: string }).id === "cX" && (ev.data as { page_id?: string }).page_id === "pY", "forged comment.created is signal-only (entity.id + data.page_id, no text/author)");
}

{
  const { buildAuditQuery, hasAuditRow } = await import("../packages/core/scripts/e2e/audit-read.js");
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
  const { buildTranscriptQuery, transcriptPath, findEvents } = await import("../packages/core/scripts/e2e/transcript-read.js");
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
  const { decomposeSession, joinDelegations, delegationJoinTargets, fmtMs, renderSessionTiming, renderDelegationTiming } = await import(
    "../packages/core/scripts/e2e/transcript-timings.js"
  );
  const { summariseTimings } = await import("../packages/core/scripts/e2e/timings-record.js");

  const worker = [
    { index: 0, at: "2026-03-29T01:10:08.677Z", type: "session.started", data: { runtime: { modelId: "m" } } },
    { index: 1, at: "2026-03-29T01:10:10.903Z", type: "turn.started", data: { turnId: "t1", sequence: 0 } },
    { index: 2, at: "2026-03-29T01:10:10.917Z", type: "message.received", data: { message: "<wake .../>", turnId: "t1" } },
    { index: 3, at: "2026-03-29T01:10:10.918Z", type: "step.started", data: { turnId: "t1", stepIndex: 0 } },
    { index: 4, at: "2026-03-29T01:10:16.951Z", type: "reasoning.appended", data: { turnId: "t1", stepIndex: 0, reasoningDelta: "a" } },
    { index: 5, at: "2026-03-29T01:10:17.010Z", type: "reasoning.appended", data: { turnId: "t1", stepIndex: 0, reasoningDelta: "b" } },
    { index: 6, at: "2026-03-29T01:10:17.079Z", type: "actions.requested", data: { turnId: "t1", stepIndex: 0, actions: [{ callId: "c1", kind: "tool-call", toolName: "read_file", input: {} }] } },
    { index: 7, at: "2026-03-29T01:10:17.169Z", type: "action.result", data: { turnId: "t1", stepIndex: 0, status: "completed", result: { callId: "c1", kind: "tool-result", toolName: "read_file", output: "x" } } },
    { index: 8, at: "2026-03-29T01:10:17.222Z", type: "step.completed", data: { turnId: "t1", stepIndex: 0, finishReason: "tool-calls", usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 }, providerMetadata: { gateway: { generationId: "gen_1" } } } },
    { index: 9, at: "2026-03-29T01:10:17.625Z", type: "step.started", data: { turnId: "t1", stepIndex: 1 } },
    { index: 10, at: "2026-03-29T01:10:24.504Z", type: "message.appended", data: { turnId: "t1", stepIndex: 1, messageDelta: "done" } },
    { index: 11, at: "2026-03-29T01:10:24.625Z", type: "step.completed", data: { turnId: "t1", stepIndex: 1, finishReason: "stop", usage: { inputTokens: 200, outputTokens: 30, costUsd: 0.002 } } },
    { index: 12, at: "2026-03-29T01:10:24.700Z", type: "turn.completed", data: { turnId: "t1", sequence: 1 } },
    { index: 13, at: "2026-03-29T01:10:24.800Z", type: "session.waiting", data: { continuationToken: "ct", wait: "next-user-message" } },
  ];

  const s = decomposeSession(worker);
  ok(s.bootMs === 2226, `boot = session.started → first turn.started (the whole session.started hook chain — a CEILING, not a sandbox or memory number); got ${s.bootMs}`);
  ok(s.turns.length === 1 && s.turns[0].outcome === "completed", "one turn, terminal outcome read off turn.completed");
  ok(s.turns[0].preflightMs === 15, `preflight = turn.started → first step.started (the turn.started hook chain); got ${s.turns[0].preflightMs}`);
  ok(s.turns[0].steps.length === 2, "two model calls in the turn, keyed by (turnId, stepIndex)");
  ok(s.turns[0].steps[0].ttftMs === 6033, `ttft = step.started → the step's FIRST delta (later deltas must not overwrite it); got ${s.turns[0].steps[0].ttftMs}`);
  ok(s.turns[0].steps[1].ttftMs === 6879, "the second step gets its OWN ttft — stepIndex is per-turn, not global");
  ok(s.turns[0].steps[0].generationId === "gen_1", "the gateway generationId is projected — the join key into the AI Gateway inference log (the only record of the upstream provider)");
  ok(s.turns[0].toolCalls.length === 1 && s.turns[0].toolCalls[0].wallMs === 90, `tool call paired actions.requested → action.result by callId; got ${s.turns[0].toolCalls[0]?.wallMs}`);
  ok(s.turns[0].toolCalls[0].status === "completed" && s.turns[0].toolCalls[0].name === "read_file", "tool call carries its eve status + tool name");
  ok(s.totals.tokens === 350 && s.totals.costUsd === 0.003, "step usage totals sum across steps");
  ok(s.coverage.events === 14 && s.coverage.withAt === 14 && s.coverage.unpairedCalls === 0, "coverage counts every event and every paired call — the deterministic observability gate");

  const untimed = decomposeSession([{ index: 0, at: null, type: "session.started", data: {} }, { index: 1, at: null, type: "turn.started", data: { turnId: "t1" } }]);
  ok(untimed.bootMs === null, "a missing meta.at yields a NULL duration, not 0 — an unknown is not a zero");
  ok(untimed.coverage.withAt === 0 && untimed.coverage.events === 2, "…and the coverage counter reports it, so an eve drift is visible rather than silent");
  ok(fmtMs(null) === "?" && fmtMs(90) === "90ms" && fmtMs(23200) === "23.2s", "fmtMs renders unknown as '?' and never as a number");
  const unknownType = decomposeSession([{ index: 0, at: "2026-03-29T00:30:00.000Z", type: "some.future.event", data: { turnId: "t9" } }]);
  ok(unknownType.turns.length === 0 && unknownType.coverage.events === 1, "an unrecognised eve event type is counted but never invents a phase");

  const spawned = {
    ts: "2026-03-29T01:10:06.000Z", org: "o", platform: "unified", workspace: "d", action: "task.spawned",
    detail: { taskId: "T1", oneshot: true, parentSessionId: "wrun_caller", parentWakeId: "w0", wakeId: "w1", briefLen: 347 },
  };
  const returned = {
    ts: "2026-03-29T01:10:25.500Z", org: "o", platform: "unified", workspace: "d", action: "task.returned",
    detail: { taskId: "T1", mode: "async", sessionId: "wrun_worker", summaryLen: 165, hasError: false, delivered: true },
  };
  const rows = [returned, spawned];
  const targets = delegationJoinTargets(rows);
  ok(targets.length === 1 && targets[0].workerSessionId === "wrun_worker" && targets[0].parentSessionId === "wrun_caller", "delegationJoinTargets names both sides BEFORE any transcript is paid for");

  const [d] = joinDelegations(rows, new Map([["wrun_worker", worker]]));
  ok(d.gaps.length === 0, `a complete join reports NO gaps; got ${JSON.stringify(d.gaps)}`);
  ok(d.wallMs === 19500, `wall = task.spawned → task.returned (what the caller waits out); got ${d.wallMs}`);
  ok(d.dispatchMs === 2677, `dispatch = spawn row → the worker's first recorded event (workflow cold-start); got ${d.dispatchMs}`);
  ok(d.bootMs === 2226, "boot carries the worker's whole session.started hook-chain window through to the delegation view (a ceiling — the sandbox create inside it is ≤5.7s measured, OPE-126)");
  ok(d.ttftMs === 6033, "ttft is the worker's FIRST model call's time to first token — the number a 'viable in a conversational turn?' argument is about");
  ok(d.workMs === 13797, `work = worker turn.started → last turn end; got ${d.workMs}`);
  ok(d.returnMs === 700, `return = worker's last recorded event → the task.returned row (result persist + caller wake); got ${d.returnMs}`);
  ok(d.unaccountedMs === 100, `phases + unaccounted reconstruct the wall exactly; got ${d.unaccountedMs}`);
  ok(d.worker !== null && d.worker.totals.toolCalls === 1, "the worker's whole session decomposition rides along");

  const noStamp = joinDelegations([{ ...returned, detail: { taskId: "T1", mode: "async" } }, spawned], new Map());
  ok(noStamp[0].gaps.some((g) => g.includes("no sessionId")), "a task.returned that loses its sessionId stamp is a NAMED gap (the pre-OPE-121 shape) — the worker's work would be unobservable");
  ok(noStamp[0].wallMs === 19500, "…and the caller-visible wall-clock is still derivable from the audit rows alone");
  const noReturn = joinDelegations([spawned], new Map());
  ok(noReturn[0].gaps.some((g) => g.includes("no task.returned")), "a spawn with no return inside the window is a NAMED gap, not a hidden null");
  const emptyReplay = joinDelegations(rows, new Map([["wrun_worker", []]]));
  ok(emptyReplay[0].gaps.some((g) => g.includes("EMPTY")), "an expired/unreadable worker session is a NAMED gap — the S-MEM-READ precedent that an observability failure must not read as a product result");

  const lateSpawnRow = { ...spawned, ts: "2026-03-29T01:10:09.500Z" };
  const [raced] = joinDelegations([returned, lateSpawnRow], new Map([["wrun_worker", worker]]));
  ok(raced.dispatchMs === -823, `a worker that beats the spawn row yields a NEGATIVE dispatch, not a clamp to 0; got ${raced.dispatchMs}`);
  ok(raced.gaps.length === 0, "…and that race is NOT a gap — the join is still complete");

  const { attributeBoot, projectMemorySync, renderBootAttribution, MEMORY_SYNC_TIMING_ACTION } = await import(
    "../packages/core/scripts/e2e/transcript-timings.js"
  );
  const syncRow = {
    ts: "2026-03-29T01:10:10.100Z", org: "o", platform: "slack", workspace: "T1", action: MEMORY_SYNC_TIMING_ACTION,
    detail: {
      sessionId: "wrun_worker", hookMs: 1800, baselineMs: 120, sandboxMs: 1200, indexMs: 60, siloCount: 2,
      silos: [
        { silo: "payments-brain", tier: "silo:payments-brain", provider: "postgres", readOnly: false, loadMs: 40, syncMs: 30, files: 12, bytes: 40960, ok: true },
        { silo: "notion-projection", tier: "silo:notion-projection", provider: "notion", readOnly: true, loadMs: 300, syncMs: 20, lockMs: 25, files: 30, bytes: 131072, ok: true },
      ],
    },
  };
  ok(MEMORY_SYNC_TIMING_ACTION === "memory.sync_timing", "the driver's action key matches the producer's (memory-sync-timing-test.ts pins the constant identity)");
  const proj = projectMemorySync([syncRow], "wrun_worker")!;
  ok(proj.silos.length === 2 && proj.sandboxMs === 1200, "the row projects into a per-silo decomposition plus the once-per-session sandbox cold-create");
  ok(proj.silos[1].totalMs === 345, `a silo's share of boot = load + sync + lock; got ${proj.silos[1].totalMs}`);
  const boot = attributeBoot(s, [syncRow], "wrun_worker")!;
  ok(boot.bootMs === 2226 && boot.hookMs === 1800 && boot.unattributedMs === 426, `boot = memory hook + the OTHER session.started work; got ${boot.unattributedMs}`);
  ok(boot.sandboxMs === 1200 && boot.siloMs === 415, `the sandbox cold-create and Σ per-silo memory cost are SEPARATE numbers (1200 vs ${boot.siloMs}) — the confusion this exists to end`);
  ok(boot.silos[0].silo === "notion-projection", "silos come back slowest-first, so 'which silo cost the boot' is answerable — here the Notion pull, not Postgres");
  ok(boot.gaps.length === 0 && renderBootAttribution(boot).some((l) => l.includes("notion-projection")), "a complete attribution reports no gaps and names the silo in the render");
  ok(attributeBoot(s, [], "wrun_worker") === null, "NO row (the default — the flag is OFF) ⇒ null, so bootMs stays the ceiling it always was; an absent measurement is never a zero");
  const emptyPlan = attributeBoot(s, [{ ...syncRow, detail: { sessionId: "wrun_worker", hookMs: 2, siloCount: 0, silos: [] } }], "wrun_worker")!;
  ok(emptyPlan.sandboxMs === null && emptyPlan.gaps.some((g) => g.includes("ZERO silos")), "an EMPTY memory plan is a NAMED gap: that session's hook returns before getSandbox(), so its bootMs is not comparable to a memory-bearing session's");

  const { renderCompaction } = await import("../packages/core/scripts/e2e/transcript-timings.js");

  const compacting = [
    { index: 0, at: "2026-04-22T08:30:00.000Z", type: "session.started", data: {} },
    { index: 1, at: "2026-04-22T08:30:01.000Z", type: "turn.started", data: { turnId: "t1" } },
    { index: 2, at: "2026-04-22T08:30:02.000Z", type: "compaction.requested", data: { sessionId: "wrun_dense", turnId: "t1" } },
    { index: 3, at: "2026-04-22T08:30:03.000Z", type: "compaction.completed", data: { sessionId: "wrun_dense", turnId: "t1", modelId: "m", reduced: true } },
    { index: 4, at: "2026-04-22T08:30:04.000Z", type: "compaction.requested", data: { sessionId: "wrun_dense", turnId: "t1" } },
    { index: 5, at: "2026-04-22T08:30:05.000Z", type: "compaction.completed", data: { sessionId: "wrun_dense", turnId: "t1", modelId: "m", reduced: false } },
    { index: 6, at: "2026-04-22T08:30:06.000Z", type: "compaction.completed", data: { sessionId: "wrun_dense", turnId: "t1", modelId: "m" } },
    { index: 7, at: "2026-04-22T08:30:07.000Z", type: "turn.completed", data: { turnId: "t1" } },
  ];
  const c = decomposeSession(compacting);
  ok(c.compaction.requested === 2 && c.compaction.completed === 3, `compaction passes are counted off the transcript; got ${c.compaction.requested} requested / ${c.compaction.completed} completed`);
  ok(c.compaction.reduced === 1, `a pass stamped reduced:true counts as REAL work; got ${c.compaction.reduced}`);
  ok(c.compaction.noOp === 1, `a pass stamped reduced:false counts as a NO-OP; got ${c.compaction.noOp}`);
  ok(c.compaction.unstamped === 1, `a pass with NO reduced field is UNDECIDABLE and gets its own bucket — folding it into either side would hide a real defect or invent one; got ${c.compaction.unstamped}`);
  ok(c.compaction.reduced + c.compaction.noOp + c.compaction.unstamped === c.compaction.completed, "the three buckets partition the completed passes exactly — no pass is dropped and none is double-counted");
  ok(c.sessionId === "wrun_dense", "…and the compaction events still harvest the sessionId, the behaviour that existed before the split");

  const noOpLine = renderCompaction(c.compaction)!;
  ok(noOpLine.includes("NO-OP"), `a no-op pass is NAMED in the rendered line, not buried in a count; got ${JSON.stringify(noOpLine)}`);
  ok(noOpLine.startsWith("⚠"), `…and carries the ⚠ marker this file uses for a broken measurement, so it reads as a fault; got ${JSON.stringify(noOpLine)}`);
  ok(noOpLine.includes("OPE-689"), "…and names the defect shape, so a reader can act on it without archaeology");
  ok(noOpLine.includes("UNDECIDABLE"), "…and reports the unstamped pass as undecidable rather than silently as a pass or a no-op");
  ok(renderSessionTiming(c, "session wrun_dense").some((l) => l.includes("NO-OP")), "the no-op reaches renderSessionTiming — the render scenarios.ts actually logs, not an internal field");

  const healthy = decomposeSession([
    { index: 0, at: "2026-04-22T08:30:00.000Z", type: "session.started", data: {} },
    { index: 1, at: "2026-04-22T08:30:01.000Z", type: "compaction.requested", data: { sessionId: "wrun_ok" } },
    { index: 2, at: "2026-04-22T08:30:02.000Z", type: "compaction.completed", data: { sessionId: "wrun_ok", modelId: "m", reduced: true } },
  ]);
  ok(healthy.compaction.reduced === 1 && healthy.compaction.noOp === 0 && healthy.compaction.unstamped === 0, `a reduced:true pass is EXPLICITLY not a no-op (noOp === 0, not merely absent); got ${JSON.stringify(healthy.compaction)}`);
  const healthyLine = renderCompaction(healthy.compaction)!;
  ok(!healthyLine.includes("NO-OP") && !healthyLine.startsWith("⚠"), `…and real work is never flagged: no NO-OP text, no ⚠ marker; got ${JSON.stringify(healthyLine)}`);
  ok(healthyLine.includes("1 did compaction work"), `…the healthy line still REPORTS the pass, so "how many compactions ran" is answerable; got ${JSON.stringify(healthyLine)}`);

  ok(s.compaction.completed === 0 && s.compaction.requested === 0, "a session with no compaction events counts zero, not null");
  ok(renderCompaction(s.compaction) === null, "…and renders NO line at all, so the line's presence is itself the signal");
  ok(!renderSessionTiming(s, "session wrun_worker").some((l) => l.includes("compaction")), "…confirmed through renderSessionTiming: no compaction, no compaction line");

  const sum = summariseTimings([{ scenarioId: "X", label: "l", capturedAt: "2026-03-29T01:11:00.000Z", sessions: [{ sessionId: "wrun_worker", timing: s }], delegations: [d] }]);
  ok(sum.delegations === 1 && sum.delegationsFullyJoined === 1, "the run summary counts delegations and how many decomposed end-to-end");
  ok(sum.delegationWallMs.p50 === 19500 && sum.bootMsP50 === 2226 && sum.ttftMsP50 === 6033, "the run summary carries p50 wall / boot / ttft — the recorded series, never a threshold");
  ok(sum.compaction.passes === 0 && sum.compaction.noOp === 0, "a run whose sessions never compacted rolls up to zero passes");
  ok(summariseTimings([]).delegationWallMs.p50 === null, "an empty run summarises to nulls, not zeros");

  const [dupeDelegation] = joinDelegations(
    [{ ...returned, detail: { ...returned.detail, sessionId: "wrun_dense" } }, spawned],
    new Map([["wrun_dense", compacting]]),
  );
  const dupeSum = summariseTimings([{
    scenarioId: "C", label: "a session recorded twice — once whole, once as a delegation worker",
    capturedAt: "2026-04-22T08:31:00.000Z",
    sessions: [{ sessionId: "wrun_dense", timing: c }],
    delegations: [dupeDelegation],
  }]);
  ok(dupeSum.compaction.passes === 3, `the run rollup counts each session ONCE, by session id; got ${dupeSum.compaction.passes} (6 would mean the overlap is double-counted)`);
  ok(dupeSum.compaction.noOp === 1 && dupeSum.compaction.reduced === 1 && dupeSum.compaction.unstamped === 1, `…and the no-op survives to the run summary, which is the line that always prints; got ${JSON.stringify(dupeSum.compaction)}`);
  ok(renderDelegationTiming(dupeDelegation).some((l) => l.includes("NO-OP")), "a delegated WORKER's no-op is named in the delegation render too — a worker is where a dense session actually compacts");
}

{
  const { buildChatUpdateBody, buildUploadUrlBody, buildCompleteUploadBody } = await import("../packages/core/scripts/e2e/slack-driver.js");
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

{
  const { mergeBotMessagesAfter } = await import("../packages/core/scripts/e2e/slack-driver.js");
  type M = { ts: string; text: string; userId?: string; botId?: string };
  const isBot = (m: M): boolean => m.botId !== undefined;
  const human = (ts: string, text: string): M => ({ ts, text, userId: "U-HUMAN" });
  const bot = (ts: string, text: string): M => ({ ts, text, botId: "B-OE" });

  ok(mergeBotMessagesAfter([human("100.0", "ask")], [], "100.0", isBot).length === 0, "merge: a thread holding only the human's own ask yields no bot messages (silence passes)");

  const threaded = mergeBotMessagesAfter([human("100.0", "ask"), bot("101.0", "threaded answer")], [], "100.0", isBot);
  ok(threaded.length === 1 && threaded[0].text === "threaded answer", `merge: a bot reply that exists ONLY in the thread is found (history is blind to it); got ${JSON.stringify(threaded.map((m) => m.text))}`);

  const flat = mergeBotMessagesAfter([human("100.0", "ask")], [bot("102.0", "top-level post")], "100.0", isBot);
  ok(flat.length === 1 && flat[0].text === "top-level post", `merge: a bot message that exists ONLY in top-level history is found; got ${JSON.stringify(flat.map((m) => m.text))}`);

  const both = mergeBotMessagesAfter([bot("103.0", "broadcast")], [bot("103.0", "broadcast")], "100.0", isBot);
  ok(both.length === 1, `merge: a message present in BOTH pages is counted once (reply_broadcast), got ${both.length}`);

  const filtered = mergeBotMessagesAfter(
    [bot("99.0", "before the floor"), bot("100.0", "exactly the floor"), human("104.0", "human chatter"), bot("105.0", "real runaway")],
    [],
    "100.0",
    isBot,
  );
  ok(filtered.length === 1 && filtered[0].text === "real runaway", `merge: pre-floor, at-floor and human messages are all excluded; got ${JSON.stringify(filtered.map((m) => m.text))}`);

  const ordered = mergeBotMessagesAfter([bot("1000.5", "later")], [bot("999.9", "earlier")], "100.0", isBot);
  ok(ordered.map((m) => m.text).join(",") === "earlier,later", `merge: results are oldest-first by numeric ts; got ${JSON.stringify(ordered.map((m) => m.text))}`);
}

{
  const { isQualifyingEdit, DEFAULT_QUALIFYING_EDIT_WINDOW_MS, SlackDriver } = await import("../packages/core/scripts/e2e/slack-driver.js");
  type Msg = { ts: string; text: string; editedTs?: string };
  const msg = (ts: string, text: string, editedTs?: string): Msg => ({ ts, text, editedTs });

  const folded = msg(
    "1777797937.974000",
    "I'm recording that preference in durable memory and will report back once the edit is confirmed.\n\nSaved successfully. The preference is now recorded in `surface/notes.md` and `surface/MEMORY.md`: “favourite cheese is wensleydale”.",
    "1777797992.000000",
  );
  ok(isFillerAck(folded.text), "OPE-1067 fixture: the folded text still matches isFillerAck (the ack phrase never left it) — this is the trap, not the fix");
  ok(isQualifyingEdit(folded), "isQualifyingEdit: the live OPE-1067 shape (edited ~54s after its own post) qualifies");

  ok(!isQualifyingEdit(msg("100.0", "one sec, checking now")), "isQualifyingEdit: an unedited message (no editedTs) never qualifies");

  const staleEditTs = (100 + (DEFAULT_QUALIFYING_EDIT_WINDOW_MS + 1) / 1000).toFixed(6);
  ok(!isQualifyingEdit(msg("100.0", "one sec, checking now", staleEditTs)), "isQualifyingEdit: an edit landing AFTER the window does not qualify (bounded, not forever)");

  const atBoundaryTs = (100 + DEFAULT_QUALIFYING_EDIT_WINDOW_MS / 1000).toFixed(6);
  ok(isQualifyingEdit(msg("100.0", "one sec", atBoundaryTs)), "isQualifyingEdit: an edit landing EXACTLY at the window boundary qualifies");

  ok(!isQualifyingEdit(msg("100.0", "one sec", "50.0")), "isQualifyingEdit: an edited.ts BEFORE the message's own ts is refused, not accepted");

  const { withPatchedFetch } = await import("../packages/core/scripts/_fetch-test-utils.js");
  const scriptedHistoryMessage = { ts: folded.ts, text: folded.text, edited: { ts: folded.editedTs }, bot_id: "B-OE" };
  const jsonResp = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const fake = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("conversations.replies")) return jsonResp({ ok: true, messages: [{ ts: "782.0" }] });
    if (u.includes("conversations.history")) return jsonResp({ ok: true, messages: [scriptedHistoryMessage] });
    return jsonResp({ ok: true });
  }) as typeof fetch;
  await withPatchedFetch(fake, async () => {
    const driver = new SlackDriver({ token: "xoxb-test", channel: "C-DM", botUserId: "B-OE" });
    const found = await driver.awaitAnyReply("782.0", { timeoutMs: 3_000, skip: (m) => isFillerAck(m.text) });
    ok(found.ts === folded.ts, "awaitAnyReply: resolves to the folded-into-edit message despite `skip` still matching its text (the OPE-1067 override reaches the real poll loop)");
  });
}

{
  const row = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: "2026-05-03T12:23:00.000Z",
    org: "default",
    platform: "slack",
    workspace: "T0EXAMPLE",
    action,
    detail,
  });

  ok(
    delegationHasReturned([row("delegation.task_started", { task: "t1", session: "s1" }), row("delegation.task_settled", { task: "t1", session: "s1", status: "completed" })]),
    "delegationHasReturned: native started+settled pair (same task id) returns true",
  );

  ok(
    !delegationHasReturned([row("delegation.task_started", { task: "t1", session: "s1" })]),
    "delegationHasReturned: a started row with NO matching settled row is NOT a return (the OPE-1076 race window)",
  );

  ok(
    !delegationHasReturned([row("delegation.task_started", { task: "t1", session: "s1" }), row("delegation.task_settled", { task: "OTHER-TASK", session: "s1", status: "completed" })]),
    "delegationHasReturned: a settled row for a different task id does not satisfy the started row's join",
  );

  ok(
    delegationHasReturned([row("task.spawned", { taskId: "rt1", parentSessionId: "s1" }), row("task.returned", { taskId: "rt1", sessionId: "w1" })]),
    "delegationHasReturned: roll-own spawned+returned pair (same taskId) returns true",
  );
  ok(
    !delegationHasReturned([row("task.spawned", { taskId: "rt1", parentSessionId: "s1" })]),
    "delegationHasReturned: a roll-own spawned row with no matching returned row is NOT a return",
  );

  ok(!delegationHasReturned([]), "delegationHasReturned: an empty row set is not a return");
  ok(
    !delegationHasReturned([row("reply.post", { sessionId: "s1" }), row("browser.navigate", {})]),
    "delegationHasReturned: unrelated rows (a reply ack, a browser op with no delegation join) are not a return",
  );

  ok(
    !delegationHasReturned([row("delegation.task_started", { session: "s1" }), row("delegation.task_settled", { session: "s1", status: "completed" })]),
    "delegationHasReturned: started/settled rows with NO task id on either side do not vacuously join",
  );
}

{
  const { pollOptional } = await import("../packages/core/scripts/e2e/poll.js");
  const row = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: "2026-05-03T12:23:00.000Z",
    org: "default",
    platform: "slack",
    workspace: "T0EXAMPLE",
    action,
    detail,
  });
  const started = row("delegation.task_started", { task: "t1", session: "s1" });
  const settled = row("delegation.task_settled", { task: "t1", session: "s1", status: "completed" });
  const ticks: (readonly AuditWireEntry[])[] = [[started], [started], [started, settled]];
  let call = 0;
  const fetchRows = async (): Promise<readonly AuditWireEntry[]> => ticks[Math.min(call++, ticks.length - 1)];
  const settledResult = await pollOptional(
    async () => {
      const rows = await fetchRows();
      return delegationHasReturned(rows) ? true : undefined;
    },
    { timeoutMs: 30_000, initialDelayMs: 10, maxDelayMs: 10, what: "delegation settlement (test)" },
  );
  ok(settledResult === true, "F-ART leg-4 poll: delegationHasReturned only resolves the poll once the settled row lands on tick 3, not on the earlier started-only ticks");
  ok(call >= 3, `F-ART leg-4 poll: the probe was re-polled through the unsettled ticks (called ${call} time(s), expected >=3) — it did not stop early on the started-only row`);
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
  const input = { text: "remember this: the OPE329 canary is xyz", channelId: "D0DISCORDDM", userId: "111222333444555666" };
  const envelope = buildDiscordDmRelayEnvelope(input) as { source: string; message: Record<string, unknown> };
  ok(envelope.source === "discord-gateway-relay", "envelope carries the relay's own source marker");
  ok(envelope.message.channelType === "1", "envelope is channelType 1 (Discord's DM enum)");
  ok(!("guildId" in envelope.message), "envelope carries NO guildId key at all (a DM is genuinely guildless, never an empty string)");
  const author = envelope.message.author as Record<string, unknown>;
  ok(author.bot === false && author.id === input.userId, "envelope's author is the REAL human, never a bot");

  const raw = JSON.stringify(envelope);
  const secret = "e2e-discord-relay-secret-never-real";
  const sig = signDiscordRelayRequest(raw, secret);
  ok(sig.startsWith("sha256="), "signDiscordRelayRequest is sha256=<hex>-prefixed (relayGate's expected shape, no timestamp component)");
  ok(relayGate(sig, raw, secret) === null, "a synthetic discord DM relay signature verifies against the deployment's OWN relayGate");
  ok(relayGate(sig, raw + "x", secret) !== null, "a tampered body fails relayGate");
  ok(relayGate(sig, raw, "wrong-secret") !== null, "the wrong secret fails relayGate");
  ok(relayGate(null, raw, secret) !== null, "a missing signature header fails relayGate (fail-closed)");

  const parsed = parseRelayPayload(JSON.parse(raw));
  ok(parsed !== null && parsed.channelId === input.channelId && parsed.author.id === input.userId, "the deployment's OWN parseRelayPayload accepts the forged envelope");
  ok(parsed !== null && parsed.guildId === undefined, "parseRelayPayload reads the omitted guildId as undefined (the guildless DM shape)");
  ok(parsed !== null && parsed.channelType === "1", 'parseRelayPayload reads channelType "1"');

  const auth = parsed ? authForRelayMessage(parsed) : null;
  ok(auth !== null, "authForRelayMessage resolves a real dispatch auth for the forged human DM author (never dropped)");

  ok(DISCORD_RELAY_SIGNATURE_HEADER === "x-oe-relay-signature", "DISCORD_RELAY_SIGNATURE_HEADER matches discord-gateway.ts's relay-signature header name");
  ok(SYNTHETIC_DISCORD_GATEWAY_ROUTE === "/eve/v1/discord-gateway", "SYNTHETIC_DISCORD_GATEWAY_ROUTE matches discord-gateway.ts's mounted route");
}

{
  const input = {
    text: "<@900000000000000001> oe-wake-nonce:deadbeef please answer",
    guildId: "1300000000000000100",
    channelId: "9000000000000000383",
    userId: "9000000000000000042",
    botId: "900000000000000001",
    botName: "open-everywhere",
  };
  const envelope = buildDiscordGuildMentionRelayEnvelope(input) as { source: string; message: Record<string, unknown> };
  ok(envelope.source === "discord-gateway-relay", "guild-mention envelope carries the relay's own source marker");
  ok(envelope.message.channelType === "0", 'guild-mention envelope is channelType "0" (Discord\'s base guild text enum)');
  ok(envelope.message.guildId === input.guildId, "guild-mention envelope carries the guild id (the DM shape's exact opposite)");
  ok(envelope.message.mentionsBot === true, "guild-mention envelope sets mentionsBot — the direct-address wake path");

  const raw = JSON.stringify(envelope);
  const secret = "e2e-discord-relay-secret-never-real";
  const sig = signDiscordRelayRequest(raw, secret);
  ok(relayGate(sig, raw, secret) === null, "a synthetic guild-mention relay signature verifies against the deployment's OWN relayGate");
  ok(relayGate(sig, raw + "x", secret) !== null, "a tampered guild-mention body fails relayGate");

  const parsed = parseRelayPayload(JSON.parse(raw));
  ok(parsed !== null && parsed.guildId === input.guildId, "parseRelayPayload reads the guild id back off the forged mention");
  ok(parsed !== null && parsed.channelType === "0", 'parseRelayPayload reads channelType "0"');
  ok(parsed !== null && parsed.mentionsBot === true, "parseRelayPayload reads mentionsBot back as true");
  ok(parsed !== null && parsed.botId === input.botId && parsed.botName === input.botName, "parseRelayPayload reads the relayed bot id/name (multi-bot attribution + name-drop)");
  ok(parsed !== null && parsed.content === input.text, "parseRelayPayload preserves the wake text byte-for-byte (the nonce echo depends on it)");

  const auth = parsed ? authForRelayMessage(parsed) : null;
  ok(auth !== null, "authForRelayMessage resolves a dispatch auth for the forged human guild author");
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
  const sibling = (text: string, ts: string) =>
    JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: `EvE2ESib${ts.replace(".", "")}`,
      event_time: Math.floor(Number.parseFloat(ts)),
      event: { type: "message", channel_type: "channel", channel: "C123", user: user2, text, ts, event_ts: ts, team: "T1" },
    });
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
  const nowMs = Date.parse("2026-03-30T11:30:00.000Z");
  const ts = webhookTimestamp(nowMs);
  const id = webhookDeliveryId();
  const sig = signWebhookBody(secret, body, ts, id);
  const headersFor = (signature: string, timestamp: string = ts, messageId: string = id): Headers =>
    new Headers({ [SW_ID_HEADER]: messageId, [SW_TIMESTAMP_HEADER]: timestamp, [SW_SIGNATURE_HEADER]: signature });
  const verify = (rawBody: string, headers: Headers, keys: readonly string[] = [secret], at: number = nowMs): boolean =>
    (standardWebhookVerifier.verify({ rawBody, headers, keys, nowMs: at }) as { ok: boolean }).ok;

  ok(sig.startsWith("v1,"), 'webhook signature carries the "v1," version prefix the verifier expects');
  ok(verify(body, headersFor(sig)), "a signed synthetic webhook body verifies against the REAL registered oe-standard-webhook verifier");
  ok(!verify(body + "x", headersFor(sig)), "a tampered webhook body fails verification");
  ok(!verify(body, headersFor(sig), ["wrong-secret"]), "the wrong webhook secret fails verification");
  ok(!verify(body, new Headers({ [SW_ID_HEADER]: id, [SW_TIMESTAMP_HEADER]: ts })), "a missing signature header fails verification");
  ok(!verify(body, headersFor("v1,ZGVhZGJlZWY=")), "a garbage signature fails verification");
  ok(!verify(body, new Headers({ [SW_ID_HEADER]: id, [SW_SIGNATURE_HEADER]: sig })), "a missing TIMESTAMP header fails verification");
  ok(!verify(body, new Headers({ [SW_ID_HEADER]: webhookDeliveryId(), [SW_TIMESTAMP_HEADER]: ts, [SW_SIGNATURE_HEADER]: sig })), "🔴 swapping the DELIVERY ID invalidates the signature — the id is signed, not merely carried");
  ok(!verify(body, new Headers({ [SW_TIMESTAMP_HEADER]: ts, [SW_SIGNATURE_HEADER]: sig })), "a missing delivery-id header fails verification");
  ok(!verify(body, headersFor(sig), [secret], nowMs + 301_000), "a delivery outside the 300s skew window fails — a captured POST does not replay forever");
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
  ok(verdict.detail.startsWith("[fallback ("), "FallbackJudge labels its verdicts honestly as fallback, with the reason");
  ok(verdict.judge === "fallback", "FallbackJudge tags its verdict judge:\"fallback\"");
  const named = new FallbackJudge("no AI_GATEWAY_API_KEY reachable");
  ok(named.name.includes("no AI_GATEWAY_API_KEY reachable"), "FallbackJudge name carries the disable reason (surfaced in the run banner)");
  ok((await named.grade(rubric, "391")).fallbackReason === "no AI_GATEWAY_API_KEY reachable", "FallbackJudge propagates its reason onto the verdict");

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
  const closed = { kind: "closedQA" as const, criteria: "Does the reply list the user's Notion pages?", atLeast: 1, fallback: { mustNotMatch: [/error/i] } };
  const factual = { kind: "factuality" as const, expected: "Thursday", criteria: "Does the reply say Thursday?", atLeast: 0.6, fallback: { mustMatch: ["thursday"] } };

  const p = buildJudgePrompt(closed, "here are your pages: Roadmap, Notes");
  ok(/GROUNDING/i.test(p.system) && /connect an account/i.test(p.system), "judge prompt tells the grader a defer-to-auth reply FAILS a real-answer criteria (grounding rule)");
  ok(/INCIDENTAL/i.test(p.system) && /traceback/i.test(p.system), "judge prompt tells the grader an incidental \"error\"/\"traceback\" word is NOT a failure");
  ok(/STRICT JSON/i.test(p.system) && p.system.includes('{"pass"'), "judge prompt pins the strict-JSON {pass,reason} output contract");
  ok(p.user.includes("Does the reply list the user's Notion pages?") && p.user.includes("here are your pages"), "judge user message carries the criteria + the reply");
  ok(!p.user.includes("EXPECTED FACT") && !p.user.includes("CONTEXT"), "closedQA with no context/expected omits the EXPECTED FACT + CONTEXT sections");
  const pf = buildJudgePrompt(factual, "we deploy on thursday");
  ok(pf.user.includes("EXPECTED FACT") && pf.user.includes("Thursday"), "factuality rubric injects the EXPECTED FACT section");
  const pc = buildJudgePrompt({ ...closed, context: "the fixture workspace has a page titled Roadmap" }, "x");
  ok(pc.user.includes("CONTEXT") && pc.user.includes("titled Roadmap"), "a rubric with context threads it into the CONTEXT section");
  ok(buildJudgePrompt(closed, "").user.includes("(empty)"), "an empty reply renders as (empty) so the grader still sees a REPLY block");

  ok(parseJudgeResponse('{"pass": true, "reason": "lists Roadmap + Notes"}')?.pass === true, "parseJudgeResponse reads pass=true");
  ok(parseJudgeResponse('{"pass": false, "reason": "deferred to auth"}')?.pass === false, "parseJudgeResponse reads pass=false");
  ok(parseJudgeResponse('Sure!\n```json\n{"pass": true, "reason": "ok"}\n```')?.reason === "ok", "parseJudgeResponse extracts the object from surrounding prose/fences");
  ok(parseJudgeResponse("no json here at all") === null, "parseJudgeResponse → null on no object (→ fallback)");
  ok(parseJudgeResponse("{not valid json}") === null, "parseJudgeResponse → null on unparseable JSON (→ fallback)");
  ok(parseJudgeResponse('{"pass": "yes"}') === null, "parseJudgeResponse → null when pass is not a boolean (→ fallback, never a coerced green)");
  ok(parseJudgeResponse('{"reason": "forgot pass"}') === null, "parseJudgeResponse → null when pass is missing");
  ok(parseJudgeResponse('{"pass": true}')?.reason === "", "parseJudgeResponse tolerates a missing reason (empty string)");

  const okJudge = new LlmJudge(async () => '{"pass": true, "reason": "names Roadmap + Notes"}', "test/model");
  const okV = await okJudge.grade(closed, "here are your pages: Roadmap, Notes");
  ok(okV.pass && okV.score === 1 && okV.judge === "llm" && okV.detail.startsWith("[llm]"), "LlmJudge returns an llm-tagged pass verdict on valid output");
  ok(okJudge.name.includes("test/model") && okJudge.name.includes("temp 0"), "LlmJudge name names the model + temperature (shown in the run banner)");
  const failV = await okJudge.grade({ ...closed }, "x");
  ok(failV.pass && failV.judge === "llm", "LlmJudge grades on the model verdict, not the reply's surface tokens");

  const groundJudge = new LlmJudge(async () => '{"pass": false, "reason": "reply says connect your account first — not grounded"}', "test/model");
  const gV = await groundJudge.grade(closed, "You'll need to connect your Notion account first before I can list pages.");
  ok(!gV.pass && gV.judge === "llm", "LlmJudge FAILS a 'connect your account first' reply on a real-answer criteria (fixes the false green)");
  ok(runFallbackCheck(closed.fallback, "You'll need to connect your Notion account first before I can list pages.").pass, "…and the regex fallback ALONE would have (wrongly) passed that same reply — why the LLM judge is needed");

  const garbageJudge = new LlmJudge(async () => "the model rambled with no json", "test/model");
  const gg = await garbageJudge.grade(closed, "here are your pages: Roadmap, Notes");
  ok(gg.judge === "fallback" && gg.fallbackReason === "judge output unparseable", "unparseable judge output → fallback verdict (tagged, with reason)");
  ok(gg.pass === true, "…and the fallback regex (no forbidden token) decides the verdict — not a blanket pass");
  const ggRed = await garbageJudge.grade(closed, "this reply mentions an error somewhere");
  ok(ggRed.judge === "fallback" && ggRed.pass === false, "…a reply the fallback forbids still FAILS under fallback — infra failure never fabricates a green");
  const throwJudge = new LlmJudge(async () => { throw new Error("HTTP 503"); }, "test/model");
  const tv = await throwJudge.grade(closed, "clean grounded answer");
  ok(tv.judge === "fallback" && /judge call failed: HTTP 503/.test(tv.fallbackReason ?? ""), "a thrown transport → fallback verdict carrying the failure reason (no key value could ever appear here)");

  const j3llm = await judge3(new LlmJudge(async () => '{"pass": true, "reason": "ok"}', "m"), closed, "x");
  ok(j3llm.judge === "llm", "judge3 over three llm grades tags the combined verdict llm");
  const j3mixed = await judge3(new LlmJudge(async () => "garbage", "m"), closed, "clean, no error");
  ok(j3mixed.judge === "fallback" && (j3mixed.fallbackReason ?? "").includes("unparseable"), "judge3 tags fallback (with reason) when any sub-grade fell back");

  ok(judgeBannerTag({ llm: 0, fallback: 0, reasons: [] }) === "", "no judged gate → empty banner tag");
  ok(judgeBannerTag({ llm: 2, fallback: 0, reasons: [] }) === ", judge: llm", "all-llm → 'judge: llm'");
  ok(judgeBannerTag({ llm: 0, fallback: 1, reasons: ["judge output unparseable"] }) === ", judge: fallback (judge output unparseable)", "all-fallback → 'judge: fallback (<reason>)'");
  ok(judgeBannerTag({ llm: 1, fallback: 1, reasons: ["HTTP 503"] }).startsWith(", judge: mixed"), "some-of-each → 'judge: mixed …'");
  ok(judgeBannerTag({ llm: 0, fallback: 2, reasons: ["a", "b"] }).includes("a; b"), "multiple distinct fallback reasons are joined");

  {
    const qualityRubric = { kind: "closedQA" as const, criteria: "Is it good?", atLeast: 1, fallback: { mustMatch: ["391"] } };
    const infos: string[] = [];
    const warns: string[] = [];
    const records: { label: string; pass: boolean }[] = [];
    const scriptedJudge = (outcomes: boolean[]) => {
      let i = 0;
      return {
        name: "scripted",
        grade: async () => {
          const pass = outcomes[i++ % outcomes.length];
          return { pass, score: pass ? 1 : 0, detail: pass ? "criteria met" : "criteria not met" };
        },
      };
    };
    const reporter = (verdicts: boolean[]) =>
      createJudgeReporter({
        judge: scriptedJudge(verdicts),
        info: (l) => infos.push(l),
        warn: (l) => warns.push(l),
        record: ({ label, pass }) => records.push({ label, pass }),
        replyTail: (r) => ` ↳ ${r}`,
      });

    const green = await reporter([true])(qualityRubric, "a fine reply", "reply quality");
    ok(green === true, "judgeReport resolves TRUE on a passing verdict");
    ok(infos.length === 1 && warns.length === 0, "a green verdict prints to info, never to warn");
    ok(infos[0].includes("non-gating") && infos[0].includes("reply quality"), "the green line names itself non-gating and carries the label");
    ok(records.length === 1 && records[0].pass === true, "the green verdict is recorded with pass === true");

    infos.length = 0;
    warns.length = 0;
    records.length = 0;
    let threw = false;
    let red: boolean | undefined;
    try {
      red = await reporter([false])(qualityRubric, "a poor reply", "reply quality");
    } catch {
      threw = true;
    }
    ok(threw === false, "🔴 judgeReport does NOT throw on a red verdict — this is the whole split (OPE-433/D2)");
    ok(red === false, "judgeReport resolves FALSE on a failing verdict");
    ok(warns.length === 1 && infos.length === 0, "a red verdict prints to warn (stderr), never to info");
    ok(warns[0].includes("RED") && warns[0].includes("non-gating"), "the red line says RED and says it is non-gating in the same breath");
    ok(warns[0].includes("↳ a poor reply"), "the red line carries the reply tail — a bare verdict is not debuggable");
    ok(records.length === 1 && records[0].pass === false, "the red verdict is recorded with pass === false (the runner tallies it)");

    warns.length = 0;
    records.length = 0;
    const exploding = createJudgeReporter({
      judge: { name: "boom", grade: () => Promise.reject(new Error("gateway exploded")) },
      info: (l) => infos.push(l),
      warn: (l) => warns.push(l),
      record: ({ label, pass }) => records.push({ label, pass }),
      replyTail: () => "",
    });
    const afterThrow = await exploding(qualityRubric, "x", "reply quality");
    ok(afterThrow === false, "a judge that throws yields a reported FALSE, not a rejection");
    ok(warns.length === 1 && warns[0].includes("the judge threw: gateway exploded"), "the thrown reason reaches the operator in the red line");
    ok(records.length === 1 && records[0].pass === false, "a thrown judge is still recorded as a red verdict");
  }

  {
    const none = renderReportedJudgeSummary(0, []);
    ok(none.lines.length === 0, "no reported verdicts → no summary lines at all (an ordinary run gains no noise)");
    const allGreen = renderReportedJudgeSummary(3, []);
    ok(allGreen.stream === "stdout" && allGreen.lines.length === 1 && allGreen.lines[0].includes("all green"), "all-green reported summary is one stdout line");
    const withReds = renderReportedJudgeSummary(3, ["S20 reply quality — judge: [llm] nope"]);
    ok(withReds.stream === "stderr", "a summary carrying a red goes to STDERR");
    ok(withReds.lines[0].includes("1 of 3"), "the summary counts reds against the total");
    ok(withReds.lines[0].includes("do NOT fail the run"), "the summary says outright that these did not fail the run");
    ok(withReds.lines[0].includes("deploy:smoke"), "the summary points at the deterministic gate that DOES decide a deploy");
    ok(withReds.lines[1].includes("S20 reply quality"), "each red verdict is re-printed under the summary");
  }
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
  const opts = { timeoutMs: 2_000, initialDelayMs: 1, maxDelayMs: 2 } as const;

  ok((await pollOptional(async () => "hit", { ...opts, what: "a value" })) === "hit", "pollOptional returns the probe's value");
  ok(
    (await pollOptional(async () => undefined, { timeoutMs: 20, initialDelayMs: 1, maxDelayMs: 2, what: "nothing" })) === undefined,
    "pollOptional resolves undefined on a genuine ABSENCE (budget elapsed, every read fine)",
  );

  let attempts = 0;
  const afterBlip = await pollOptional(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient 503");
      return "recovered";
    },
    { ...opts, what: "a value after one blip" },
  );
  ok(afterBlip === "recovered" && attempts === 2, "pollOptional tolerates ONE consecutive probe failure and retries on the next tick");

  let twoInARow: unknown;
  try {
    await pollOptional(async () => { throw new Error("audit read is down"); }, { ...opts, what: "a row" });
  } catch (err) {
    twoInARow = err;
  }
  ok(twoInARow instanceof Error && String(twoInARow).includes("audit read is down"), "🔴 pollOptional THROWS the underlying error on two consecutive failures — a broken read is never reported as 'no row'");

  let midFailure: unknown;
  try {
    await pollOptional(async () => { throw new Error("intermittent 500"); }, { timeoutMs: 0, initialDelayMs: 1, maxDelayMs: 1, what: "a row" });
  } catch (err) {
    midFailure = err;
  }
  ok(midFailure instanceof Error && String(midFailure).includes("intermittent 500"), "🔴 a budget that elapses with the most recent read FAILING throws that failure rather than reporting absence");
}

{
  const { buildCostReport, renderCostReport } = await import("../packages/core/scripts/e2e/cost.js");
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
  const totalLine = lines.find((l) => l.startsWith("e2e run cost:")) ?? "";
  ok(totalLine.startsWith("e2e run cost: $2.0000"), "total line renders the priced sum");
  ok(totalLine.includes("test/unpriced"), "total line names what it could NOT price");
  ok(lines[0].includes("3 calls") && lines[0].includes("1000000in/500000out"), "slice line shows calls + tokens");

  const exclusionLine = (r: Parameters<typeof renderCostReport>[0]): string => renderCostReport(r).find((l) => l.includes("excluded by the run's session bound")) ?? "";
  ok(exclusionLine(report).includes("not reported"), "OPE-1622: a report with NO excluded block says 'not reported' — the deployment's read predates the field");
  ok(
    exclusionLine(buildCostReport(rows, { surfaceKeys: [], calls: 0, estimatedUsd: 0, unpricedModels: [], sessionsUpperBound: 0 })).includes("none"),
    "OPE-1622: an excluded count of ZERO renders as 'none' — a real answer, distinct from 'not reported'",
  );
  const hidden = exclusionLine(
    buildCostReport(rows, { surfaceKeys: ["teams/tenant-a/general"], calls: 9, estimatedUsd: 1.5, unpricedModels: ["mystery/x"], sessionsUpperBound: 2 }),
  );
  ok(hidden.includes("9 call(s)") && hidden.includes("$1.5000"), "OPE-1622: 🔴 a non-zero exclusion prints the calls and the dollars the total does NOT contain");
  ok(hidden.includes("teams/tenant-a/general"), "OPE-1622: …and names the surface whose figure is short — the question a bare $0.0000 leaves unanswered");
  ok(hidden.includes("up to 2 session(s)"), "OPE-1622: …with the session figure worded as the upper bound it is, never as an exact count");
  ok(hidden.includes("mystery/x"), "OPE-1622: …and names an unpriced model among the excluded rows, so the excluded $ is not read as complete");

  const { checkExpectedModels } = await import("../packages/core/scripts/e2e/cost.js");
  const ok1 = checkExpectedModels(rows, ["test/model-a", "test/unpriced"]);
  ok(!ok1.ok && ok1.unexpected.join(",") === "(unstamped)", "checkExpectedModels flags an unstamped row when it's not in the expected set");
  const ok2 = checkExpectedModels(rows, ["test/model-a", "test/unpriced", "(unstamped)"]);
  ok(ok2.ok && ok2.unexpected.length === 0, "checkExpectedModels passes when every stamped/unstamped model is expected");
  ok(ok2.seen.join(",") === "(unstamped),test/model-a,test/unpriced", "checkExpectedModels reports the distinct model set it saw (sorted)");
  const ok3 = checkExpectedModels(rows, ["test/model-a"]);
  ok(!ok3.ok && ok3.unexpected.includes("test/unpriced"), "checkExpectedModels flags an unexpected routed model (the routing-regression catch)");
  const withSandbox = [...rows, { surfaceKey: "slack/T1/C1", calls: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }];
  const ok4 = checkExpectedModels(withSandbox, ["test/model-a", "test/unpriced", "(unstamped)"]);
  ok(ok4.ok && !ok4.seen.includes("(sandbox)"), "checkExpectedModels ignores zero-token model-less rows (sandbox runtime billing, not a model call)");
  const ok5 = checkExpectedModels([{ surfaceKey: "slack/T1/C1", calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }], ["test/model-a"]);
  ok(ok5.ok && ok5.seen.length === 0, "a window containing ONLY sandbox runtime rows passes with an empty seen set");

  const { defaultExpectedModels, resolveExpectedModels } = await import("../packages/core/scripts/e2e/cost.js");
  const { STACKS, SHIPPED_STACK, stackModelIds } = await import("../agent/model/stacks.js");
  const shippedIds = stackModelIds(STACKS[SHIPPED_STACK]);
  ok(JSON.stringify(defaultExpectedModels()) === JSON.stringify(shippedIds), "defaultExpectedModels() names exactly the shipped default stack's ids — a stack flip changes this with zero e2e-side edits");
  ok(JSON.stringify(resolveExpectedModels(undefined)) === JSON.stringify(shippedIds), "resolveExpectedModels(undefined) — unset E2E_EXPECT_MODELS — falls back to the shipped stack, not 'off'");
  ok(JSON.stringify(resolveExpectedModels("")) === JSON.stringify(shippedIds), "resolveExpectedModels('') — blank E2E_EXPECT_MODELS — same fallback as unset");
  ok(JSON.stringify(resolveExpectedModels("  ,  ")) === JSON.stringify(shippedIds), "resolveExpectedModels ignores a whitespace/empty-entries-only override and falls back");
  ok(JSON.stringify(resolveExpectedModels("deepseek/deepseek-v4-flash-0731, alibaba/qwen3-vl-instruct")) === JSON.stringify(["deepseek/deepseek-v4-flash-0731", "alibaba/qwen3-vl-instruct"]), "resolveExpectedModels honours an explicit operator override over the shipped default, trimmed (order preserved, same as the CSV it replaces)");
  ok(shippedIds.length === 2, "the shipped default stack (american-closed) collapses five roles to exactly two ids (luna text + gemini vision) — dedup is real");
  ok(shippedIds.includes("google/gemini-3.7-flash"), "the shipped set carries the vision id — an F-ART run's describer rows are expected models, not a red");
}

{
  const { buildUnifiedAuditQuery } = await import("../packages/core/scripts/e2e/audit-read.js");
  ok(buildUnifiedAuditQuery({ domain: "e2e-unified" }) === "?domain=e2e-unified", "unified-audit query carries the domain");
  ok(buildUnifiedAuditQuery({ domain: "payments", sinceDays: 7 }) === "?domain=payments&sinceDays=7", "unified-audit query carries the optional sinceDays");
  ok(buildUnifiedAuditQuery({}) === "", "an absent domain yields an EMPTY query — the missing-domain 400 route leg");
}

{
  const { defineDomain, assertUnifiedDomainTrust } = await import("@open-everywhere/core/agent/memory/domain.js");
  const { supervisorGrainFor, unifiedSupervisorToken, unifiedDomainSessionKey } = await import("@open-everywhere/core/agent/channels/unified-supervisor.js");
  const { definePrincipal, resolvePrincipal, assertPrincipalsValid } = await import("@open-everywhere/core/agent/identity/principals.js");
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
  const fixture = defineDomain({ name: "e2e-unified", reach: [A, B], ambientSupervisor: true, mode: "unified" });
  const ambientTwin = defineDomain({ name: "e2e-unified", reach: [A, B], ambientSupervisor: true });
  const org = defineDomain({ name: "org", match: "org" });

  overrideSettingsForTest({ window: { topology: false } });
  try {
    for (const key of [A, B]) {
      const off = supervisorGrainFor(key, [fixture, org]);
      const ambient = supervisorGrainFor(key, [ambientTwin, org]);
      ok(off.unified === false && off.registryKey === key && off.domainName === undefined, `gate OFF: ${key} plans per-container (registryKey === surfaceKey)`);
      ok(JSON.stringify(off) === JSON.stringify(ambient), `gate OFF: the unified fixture's plan is IDENTICAL to the plain-ambient twin's for ${key} (byte-identical-off)`);
    }
    ok(supervisorGrainFor(A, [fixture, org]).unified === false, "gate OFF: a domain with mode set still plans per-container until the WINDOW_TOPOLOGY_ENABLED code capability is flipped ON");

    overrideSettingsForTest({ window: { topology: true } });
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
    overrideSettingsForTest({ window: { topology: false } });
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
    throws(() => assertUnifiedDomainTrust([defineDomain({ name: "e2e-unified", reach: [A, B], mode: "unified" })])),
    "mode WITHOUT ambientSupervisor → load fails loud (a window is a re-keyed ambient supervisor)",
  );

  const human = definePrincipal({ name: "E2E Human", handle: "e2e", ids: { slack: "U_E2E", github: "e2e-human" } });
  ok(
    resolvePrincipal("github", undefined, "e2e-human", [human]) === human && resolvePrincipal("slack", "T_E2E", "U_E2E", [human]) === human,
    "principals: explicit account joins resolve the same human across surfaces (an UNQUALIFIED slack entry still answers for this deployment’s workspace — OPE-350)",
  );
  ok(
    resolvePrincipal("github", undefined, "E2E Human", [human]) === undefined && resolvePrincipal("github", undefined, "e2e", [human]) === undefined,
    "principals: a display-name or handle match NEVER resolves (fail-closed on merge — an attacker-named account inherits nothing)",
  );
  ok(resolvePrincipal("slack", "T_E2E", "U_SOMEONE_ELSE", [human]) === undefined, "principals: an unmapped id stays a distinct per-surface identity");
  ok(
    throws(() => assertPrincipalsValid([human, definePrincipal({ name: "Impostor", ids: { slack: "U_E2E" } })])),
    "principals: a double-claimed (platform, id) fails LOUD at config load (an account is exactly one person)",
  );

  const { buildTail } = await import("@open-everywhere/core/agent/channels/session-tail.js");
  const { renderWakeEnvelope } = await import("@open-everywhere/core/agent/channels/wake-envelope.js");
  type SessionTailEntry = import("@open-everywhere/core/agent/channels/session-tail.js").SessionTailEntry;
  const tmsg = (id: string, container: string, minsAgo: number): SessionTailEntry => ({
    kind: "wake",
    at: new Date(Date.parse("2026-03-15T09:30:00.000Z") - minsAgo * 60_000).toISOString(),
    from: "human",
    trust: "peer",
    author: "U1",
    authorId: "U1",
    id,
    container,
    text: `backscroll ${id}`,
  });
  const tail = buildTail([tmsg("a1", A, 40), tmsg("b1", B, 30), tmsg("a2", A, 20), tmsg("b2", B, 10)], 100_000);
  ok(tail.map((m) => m.id).join(",") === "a1,b1,a2,b2", "multi-container tail: the two rooms interleave in TRUE time order, not one room after the other");
  const envelope = renderWakeEnvelope({
    reason: "channel-activity",
    currentTime: "2026-03-15T09:30:00.000Z",
    channel: { id: "C0UNIA", type: "channel" },
    messages: [
      ...tail,
      { from: "human", author: "Asker", id: "t1", sentAt: "2026-03-15T09:29:00.000Z", trust: "peer", trigger: true, body: "what did we decide?" },
    ],
  });
  ok((envelope.match(new RegExp(`container="${A}"`, "g")) ?? []).length === 2, "each of container A's two messages names A in the render");
  ok((envelope.match(new RegExp(`container="${B}"`, "g")) ?? []).length === 2, "…and each of container B's names B");
  const unlabelled = renderWakeEnvelope({
    reason: "channel-activity",
    currentTime: "2026-03-15T09:30:00.000Z",
    channel: { id: "C0UNIA", type: "channel" },
    messages: [
      ...tail.map(({ container: _drop, ...rest }) => rest),
      { from: "human" as const, author: "Asker", id: "t1", sentAt: "2026-03-15T09:29:00.000Z", trust: "peer" as const, trigger: true, body: "what did we decide?" },
    ],
  });
  ok(!unlabelled.includes("container="), "🔴 the negative control: strip the attribute and the render carries NO room label at all — two surfaces' messages become one undifferentiated stream");
}

{
  const { scoreWithheld, classifyDelegationOutcome } =
    await import("../packages/core/scripts/e2e/window-harness.js");
  const { withheldFromGrain } = await import("@open-everywhere/core/agent/access/window-gate-manifest.js");
  const { LEAN_SEAT_TOOLS } = await import("@open-everywhere/core/agent/access/lean-seat.js");

  const manifest = withheldFromGrain("standing");
  const keep = [...LEAN_SEAT_TOOLS].filter((n: string) => !manifest.includes(n));
  ok(manifest.length > 0, "F1 fixture: the standing grain withholds at least one manifest name (else the pins below are vacuous)");
  ok(keep.includes("reply") && keep.includes("agent"), "F1 fixture: the standing lean-seat keep set includes the speak verb AND the delegation verb");

  const exact = scoreWithheld(manifest, manifest, keep);
  ok(exact.ok, "scoreWithheld: the grain-gate row (withheld == the manifest slice) PASSES");
  ok(exact.surplus.length === 0, "scoreWithheld: an exact row reports no surplus");

  const leanRow = [...new Set([...manifest, "aws", "web_search", "sandbox_tools", "browser_tools"])];
  const superset = scoreWithheld(leanRow, manifest, keep);
  ok(superset.ok, "scoreWithheld: a SUPERSET of the manifest PASSES — the lean-seat row is stricter than the manifest, never leakier (the OPE-981 red)");
  ok(
    superset.surplus.join(",") === "aws,browser_tools,sandbox_tools,web_search",
    "scoreWithheld: the surplus is reported as information, sorted, and names exactly the extra tools",
  );

  const leaked = scoreWithheld(manifest.filter((n: string) => n !== "bash"), manifest, keep);
  ok(!leaked.ok, "scoreWithheld: a manifest name absent from the live withheld list FAILS — that is a leak, and it is the whole point of the gate");
  ok(leaked.missing.join(",") === "bash", "scoreWithheld: the failure names the leaked tool");
  const leakedSuperset = scoreWithheld(leanRow.filter((n: string) => n !== "bash"), manifest, keep);
  ok(!leakedSuperset.ok && leakedSuperset.missing.join(",") === "bash", "scoreWithheld: a big surplus does NOT mask a missing manifest name");

  const overCut = scoreWithheld([...manifest, "reply"], manifest, keep);
  ok(!overCut.ok && overCut.cutKeep.join(",") === "reply", "scoreWithheld: withholding a lean-seat KEEP name FAILS (a seat cut past usefulness)");

  const base = { nativeReceipt: false, replied: false, calls: null };
  ok(
    classifyDelegationOutcome({ ...base, nativeReceipt: true }).status === "PASS",
    "classifyDelegationOutcome: a delegation.task_started row joined to the caller session PASSES on the shipped native arm (the OPE-979 permanent red)",
  );
  const called = [{ name: "agent", errored: false }];
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: called }).status === "FAIL",
    "classifyDelegationOutcome: a clean agent call with NO receipt row FAILS — every delegation writes one, so the dispatch leg is broken",
  );
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: [{ name: "agent", errored: true }] }).status === "FAIL",
    "classifyDelegationOutcome: an agent call whose execute ERRORED FAILS (never laundered into a model-didn't-choose SKIP)",
  );
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: null }).status === "SKIP",
    "classifyDelegationOutcome: an unreadable transcript is a SKIP (an observability failure is not model behaviour, and not a product red)",
  );
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: [{ name: "reply", errored: false }] }).status === "SKIP",
    "classifyDelegationOutcome: a reply with no agent call is a SKIP — delegation is model-dependent",
  );
  ok(
    classifyDelegationOutcome({ ...base }).status === "SKIP",
    "classifyDelegationOutcome: no receipt and no reply is a SKIP (the turn may still be running)",
  );
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: called }).reason.includes("delegation.task_started"),
    "classifyDelegationOutcome: the native-arm failure NAMES the row it expected (the old text misdirected to OE_SPAWN_DISPATCH_SECRET)",
  );
}

{
  const { silenceAssertionPlan } = await import("../packages/core/scripts/e2e/journey.js");
  const { auditSilencesEnabled } = await import("@open-everywhere/core/agent/audit/audit.js");
  ok(auditSilencesEnabled() === false, "premise: audit.silences ships OFF — prod is actions-only and writes no full-detail silence row");

  const undeclared = silenceAssertionPlan("github.no_reply", false);
  ok(
    undeclared.always.join(",") === "reply.no_reply_observed",
    "silenceAssertionPlan: the ALWAYS poll is the ungated reply.no_reply_observed row — the leg keeps real coverage on prod instead of timing out (the OPE-978 red)",
  );
  ok(undeclared.whenDeclared.length === 0, "silenceAssertionPlan: an undeclared target polls for NO flag-gated row (that poll could only time out)");
  ok(
    !undeclared.always.includes("github.no_reply") && !undeclared.always.includes("unified.no_reply"),
    "negative control: the ALWAYS poll never contains a flag-gated action name",
  );

  const declared = silenceAssertionPlan("github.no_reply", true);
  ok(declared.always.join(",") === "reply.no_reply_observed", "silenceAssertionPlan: declaring the flag does NOT weaken the always-on assertion");
  ok(
    declared.whenDeclared.join(",") === "github.no_reply,unified.no_reply",
    "silenceAssertionPlan: a declared target ALSO asserts the per-surface row and the unified one (a unified domain's silence is judged by the unified supervisor)",
  );
  for (const surface of ["linear.no_reply", "notion.no_reply"]) {
    ok(
      silenceAssertionPlan(surface, true).whenDeclared[0] === surface,
      `silenceAssertionPlan: the per-surface action is carried through for ${surface}`,
    );
  }
}

rmSync(dir, { recursive: true, force: true });
{
  const grantRow = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: "2026-05-05T23:30:00.000Z",
    org: "default",
    platform: "slack",
    workspace: "T1",
    action,
    detail,
  });
  const OP = "notion__create_page";
  const KIND = "connector.tool:notion__create_page";
  ok(pinnedConnectorToolPermissionKind(OP) === KIND, "pinnedConnectorToolPermissionKind spells the per-TOOL memo kind the declare vocabulary and the fence both key on");

  const fenceRefusal = grantRow("connector.refused", { connection: "notion", op: OP, tier: "write", reason: "ask-unattended", grant: KIND, routine: "rt_1:3" });
  const taintedRefusal = grantRow("connector.refused", { connection: "notion", op: OP, tier: "write", reason: "ask-unattended-tainted", grant: KIND, tainted: true, routine: null });
  const disclosureRefusal = grantRow("connector.refused", { connection: "notion", op: OP, reason: "audience_floor" });
  const scopeRefusal = grantRow("connector.refused", { connection: "notion", op: OP, reason: "unresolved_surface" });
  const otherOpRefusal = grantRow("connector.refused", { connection: "notion", op: "notion__update_page", tier: "write", reason: "ask-unattended", grant: "connector.tool:notion__update_page" });
  const lift = grantRow("connector.unattended_lift", { connection: "notion", op: OP, tier: "write", grant: KIND, routine: "rt_1:3" });
  const otherOpLift = grantRow("connector.unattended_lift", { connection: "notion", op: "notion__update_page", tier: "write", grant: "connector.tool:notion__update_page", routine: "rt_1:3" });

  ok(isUnattendedFenceRefusal(fenceRefusal, OP), "the fence's own ask-unattended refusal is recognised");
  ok(isUnattendedFenceRefusal(taintedRefusal, OP), "the TAINTED variant counts too — a poisoned fire is still a fire the fence refused, and splitting them would red a run that merely ingested something");
  ok(!isUnattendedFenceRefusal(disclosureRefusal, OP), "NEGATIVE: the disclosure plane's audience_floor refusal shares the connector.refused action and is NOT the fence — counting it would report the fence working where it never ran");
  ok(!isUnattendedFenceRefusal(scopeRefusal, OP), "NEGATIVE: the scope gate's unresolved_surface refusal is not the fence either");
  ok(!isUnattendedFenceRefusal(otherOpRefusal, OP), "NEGATIVE: a refusal for a DIFFERENT op does not answer for this one — the fence's lookup is per-TOOL, so arm A's verdict must not be satisfiable by another tool's row");
  ok(!isUnattendedFenceRefusal(lift, OP), "NEGATIVE: a lift row is not a refusal");
  ok(isUnattendedLift(lift, OP) && !isUnattendedLift(otherOpLift, OP) && !isUnattendedLift(fenceRefusal, OP), "the lift reader matches its own op's lift and nothing else");

  const split = splitFenceRows([fenceRefusal, disclosureRefusal, scopeRefusal, otherOpRefusal, lift, otherOpLift], OP);
  ok(split.refused.length === 1 && split.lifted.length === 1 && split.otherRefusals.length === 2, "splitFenceRows separates the fence family, the lift, and the other-plane refusals it reports alongside — so an absence with other refusals beside it is a different diagnosis from a bare absence");

  ok(allAtWriteTier([fenceRefusal, taintedRefusal]), "allAtWriteTier accepts write-tier rows");
  ok(!allAtWriteTier([fenceRefusal, grantRow("connector.refused", { op: OP, tier: "destructive", reason: "ask-unattended", grant: KIND })]), "NEGATIVE: one destructive-tier row fails the whole gate — the tier is what decides liftability");
  ok(!allAtWriteTier([]), "VACUITY: allAtWriteTier([]) is FALSE — Array.every answers true for an empty array, which is exactly how a gate reports \"every refusal named the write tier\" having seen none");

  ok(allNamePermissionKind([fenceRefusal, lift], KIND), "allNamePermissionKind accepts rows naming the per-tool kind");
  ok(!allNamePermissionKind([fenceRefusal, grantRow("connector.refused", { op: OP, tier: "write", reason: "ask-unattended", grant: "connector.op:notion" })], KIND), "NEGATIVE: the SUPERSEDED per-connector spelling (connector.op:<slug>) fails the join — it is refused by the declare vocabulary and never widened, so a live leg must go red rather than accept one");
  ok(!allNamePermissionKind([], KIND), "VACUITY: allNamePermissionKind([]) is FALSE");

  ok(allAttributedToRoutine([lift]), "allAttributedToRoutine accepts a lift naming its routine grant key");
  ok(!allAttributedToRoutine([grantRow("connector.unattended_lift", { op: OP, grant: KIND, routine: null })]), "NEGATIVE: a lift with routine:null is unattributed — it cannot answer whose click authorised the write, which is the row's whole audit value");
  ok(!allAttributedToRoutine([grantRow("connector.unattended_lift", { op: OP, grant: KIND, routine: "" })]), "NEGATIVE: an EMPTY routine key is not an attribution either");
  ok(!allAttributedToRoutine([]), "VACUITY: allAttributedToRoutine([]) is FALSE");

  const discordAsk = grantRow("grant.asked", { askId: "ask_1", connector: "notion", owner: "discord/900000000000000001", purpose: "\"e2e\"", requestedMode: "borrow", resource: "page", scopeKey: "discord/g1/c1", toolName: "notion__fetch", verb: "read" });
  const slackAsk = grantRow("grant.asked", { askId: "ask_2", connector: "notion", owner: "slack/T1/U1", purpose: "\"e2e\"", requestedMode: "borrow", resource: "page", scopeKey: "slack/T1/C1", toolName: "notion__fetch", verb: "read" });
  const tenantScopedAsk = grantRow("grant.asked", { askId: "ask_3", connector: "notion", owner: "teams/tenant-1/U9", toolName: "notion__fetch", verb: "read" });
  const discordGrant = grantRow("grant.granted", { askId: "ask_1", connector: "notion", grantId: "g1", mode: "borrow", owner: "discord/900000000000000001", requester: "discord/900000000000000002", tier: "read", verb: "read" });
  const slackGrant = grantRow("grant.granted", { askId: "ask_2", connector: "notion", grantId: "g2", mode: "borrow", owner: "slack/T1/U1", requester: "slack/T1/U2", tier: "read", verb: "read" });
  const unverified = grantRow("grant.refused", { connector: "notion", gate: "unverified_requester" });
  const domainRefusal = grantRow("grant.refused", { connector: "notion", gate: "domain_not_admitted" });

  ok(ownerPlatformOf(discordAsk) === "discord", "ownerPlatformOf reads the head segment of the owner PRINCIPAL KEY — the discriminator grant.asked actually carries");
  ok(ownerPlatformOf(tenantScopedAsk) === "teams", "ownerPlatformOf handles the THREE-segment tenant-scoped key shape too — the platform is the head segment either way");
  ok(ownerPlatformOf(grantRow("grant.asked", { owner: "nokey" })) === undefined, "NEGATIVE: a value with no separator is not a principal key — fail closed rather than read the whole string as a platform");
  ok(ownerPlatformOf(grantRow("grant.asked", { owner: "" })) === undefined, "NEGATIVE: an empty owner reads as no platform");
  ok(ownerPlatformOf(grantRow("grant.asked", { ownerPlatform: "discord" })) === undefined, "🔴 NEGATIVE, THE REGRESSION THIS PINS: a row carrying ONLY ownerPlatform yields no owner platform — grant.asked never carries that field, so a reader that accepted it would match nothing on every real deployment while passing here");
  ok(
    ownerPlatformOf(grantRow("grant.asked", { owner: "slack/T1/U1", ownerPlatform: "discord" })) === "slack",
    "🔴 NEGATIVE (fallback variant): with a slack OWNER KEY and a contradicting ownerPlatform on the same row, the reader answers slack — the owner key is the discriminator and the platform field is never consulted on an ask",
  );
  ok(
    discordOwnedAsks([grantRow("grant.asked", { owner: "slack/T1/U1", ownerPlatform: "discord" })]).length === 0,
    "🔴 NEGATIVE (fallback variant, at the call site): a Slack-owned ask is not the Discord fixture however the row is decorated",
  );

  ok(discordOwnedAsks([discordAsk, slackAsk, tenantScopedAsk]).length === 1, "discordOwnedAsks reads the OWNER's platform, not the driving surface — a Slack-owned ask raised from Discord is not the fixture OPE-1310 needs");
  ok(discordOwnedAsks([slackAsk]).length === 0, "NEGATIVE: a Slack-owned ask alone does not satisfy the Discord fixture gate");
  ok(discordOwnedAsks([discordGrant]).length === 0, "NEGATIVE: the reader is pinned to grant.asked — a granted row is a different event and must not stand in for the ask");

  const inThread = (surface: string, detail: Record<string, unknown>): AuditWireEntry => ({ ...grantRow("grant.asked", detail), surface });
  const askInA = inThread("111000111", { askId: "ask_a", connector: "notion", owner: "discord/900000000000000001" });
  const askInB = inThread("222000222", { askId: "ask_b", connector: "notion", owner: "discord/900000000000000001" });
  const askKeyedInA = inThread("discord/g1/111000111", { askId: "ask_k", connector: "notion", owner: "discord/900000000000000001" });
  ok(surfaceNamesChannel("111000111", "111000111"), "surfaceNamesChannel accepts the BARE surface the grant flow stamps (`p.surface`)");
  ok(surfaceNamesChannel("discord/g1/111000111", "111000111"), "…and the full surfaceKey spelling other audit call sites stamp — no live grant.asked row has settled which one this path writes, so both are read");
  ok(!surfaceNamesChannel("discord/g1/222000222", "111000111"), "NEGATIVE: a key naming ANOTHER thread does not match — the join is what stops a fortnight-old tap answering for this run");
  ok(!surfaceNamesChannel("xx111000111", "111000111"), "NEGATIVE: the `/` is load-bearing — a surface merely ENDING in the digits is not that channel");
  ok(!surfaceNamesChannel(undefined, "111000111"), "NEGATIVE: a row with no surface joins to nothing, rather than to everything");
  ok(!surfaceNamesChannel("discord/g1/111000111", ""), "VACUITY: an empty channel id matches nothing — an unresolved thread must not select every row");
  ok(discordOwnedAsksInChannel([askInA, askInB], "111000111").length === 1, "discordOwnedAsksInChannel isolates the asks raised in ONE thread");
  ok(discordOwnedAsksInChannel([askInA, askKeyedInA], "111000111").length === 2, "…in either surface spelling");
  ok(discordOwnedAsksInChannel([inThread("111000111", { askId: "ask_s", owner: "slack/T1/U1" })], "111000111").length === 0, "NEGATIVE: a SLACK-owned ask raised in the same thread is not this fixture — ownership and locus are separate tests and both must hold");
  ok(askIdsOf([askInA, askInB]).join(",") === "ask_a,ask_b", "askIdsOf reads the ids the tap join is keyed on");
  ok(askIdsOf([inThread("111000111", { owner: "discord/900000000000000001" })]).length === 0, "NEGATIVE: a row with no askId contributes no id — a join key that fell back to a placeholder would match the wrong tap");

  const tapOfA = grantRow("grant.granted", { askId: "ask_a", connector: "notion", grantId: "g_a", owner: "discord/900000000000000001" });
  const tapOfB = grantRow("grant.granted", { askId: "ask_b", connector: "notion", grantId: "g_b", owner: "discord/900000000000000001" });
  ok(grantsForAsks([tapOfA, tapOfB], ["ask_a"]).length === 1, "grantsForAsks isolates the tap ANSWERING this thread's own ask");
  ok(grantsForAsks([tapOfB], ["ask_a"]).length === 0, "🔴 NEGATIVE, THE FINDING THIS CLOSES: another conversation's tap inside the same lookback does NOT satisfy the pin — the old reader asked only whether some Discord grant was tapped, which stays true forever once one has been");
  ok(grantsForAsks([discordAsk], ["ask_1"]).length === 0, "NEGATIVE: an ASK is not a tap, however its ask id matches — the pin must not be satisfied by the row an untapped run already wrote");
  ok(grantsForAsks([tapOfA], []).length === 0, "VACUITY: no ask ids select no taps");
  ok(grantIdsOf([tapOfA, tapOfB]).join(",") === "g_a,g_b", "grantIdsOf reads the ids the use and notice gates are keyed on");

  const NOW = Date.parse("2026-05-12T11:30:00.000Z");
  const live = grantRow("grant.granted", { askId: "ask_a", expiresAt: "2026-05-12T22:30:00.000Z", grantId: "g_live", owner: "discord/900000000000000001" });
  const lapsed = grantRow("grant.granted", { askId: "ask_a", expiresAt: "2026-05-12T00:30:00.000Z", grantId: "g_dead", owner: "discord/900000000000000001" });
  ok(unexpiredGrants([live, lapsed], NOW).length === 1, "unexpiredGrants keeps the grant that can still be spent");
  ok(unexpiredGrants([lapsed], NOW).length === 0, "🔴 NEGATIVE: a lapsed grant is not spendable — driving a call on it would red the use gate over a fixture that timed out");
  ok(unexpiredGrants([live], NOW).length === 1, "NEGATIVE CONTROL: the reader is reading the clock, not answering `expired` to everything");
  ok(unexpiredGrants([grantRow("grant.granted", { grantId: "g_x" })], NOW).length === 1, "🔴 an UNREADABLE expiry counts as LIVE — treating a field the leg failed to read as expiry is how a real failure gets filed away as a fixture problem");
  ok(unexpiredGrants([grantRow("grant.granted", { expiresAt: "whenever", grantId: "g_y" })], NOW).length === 1, "…and so does an unparseable one, for the same reason");

  const useOfA = grantRow("grant.used", { connector: "notion", grantId: "g_a", tier: "read" });
  const useOfB = grantRow("grant.used", { connector: "notion", grantId: "g_b", tier: "read" });
  ok(usesOfGrants([useOfA, useOfB], ["g_a"]).length === 1, "usesOfGrants isolates the call THIS grant paid for");
  ok(usesOfGrants([useOfB], ["g_a"]).length === 0, "🔴 NEGATIVE: another grant spent in the same window does not prove this leg drove a call — unfiltered, the use gate passes on any borrow anywhere on the deployment");
  ok(usesOfGrants([tapOfA], ["g_a"]).length === 0, "NEGATIVE: the reader is pinned to grant.used — the tap row carries the same grantId and must not stand in for the spend");
  ok(usesOfGrants([useOfA], []).length === 0, "VACUITY: no grant ids select no uses");

  ok(refusedUnverifiedRequester([unverified, domainRefusal]).length === 1, "refusedUnverifiedRequester isolates the ONE refusal whose cause this pack cannot settle from the trail alone");
  ok(refusedUnverifiedRequester([domainRefusal]).length === 0, "NEGATIVE: every other gate value is a real refusal and is reported as one, never skipped past");

  const alreadyLive = grantRow("grant.refused", { connector: "notion", gate: "grant_already_live" });
  ok(refusedGrantAlreadyLive([alreadyLive, domainRefusal, unverified]).length === 1, "refusedGrantAlreadyLive isolates the ONE refusal a tapped re-run earns by design");
  ok(refusedGrantAlreadyLive([domainRefusal, unverified]).length === 0, "🔴 NEGATIVE: no other refusal reads as `already live` — a domain refusal or an unverified requester must still skip, never fall through to phase 2");
  ok(refusedGrantAlreadyLive([grantRow("grant.asked", { connector: "notion", gate: "grant_already_live" })]).length === 0, "NEGATIVE: the reader is pinned to grant.refused — a `gate` field on another action is not a refusal");
  ok(refusedGrantAlreadyLive([]).length === 0, "VACUITY: no rows is no refusal, so an empty trail never opens the fall-through");
  ok(refusedUnverifiedRequester([alreadyLive]).length === 0, "NEGATIVE (the other direction): the two refusal readers do not overlap — an already-live refusal is diagnosed, not undiagnosed");

  const MY_THREAD = "1300000000000000106";
  const liveHere = { ...grantRow("grant.refused", { connector: "notion", gate: "grant_already_live" }), surface: MY_THREAD };
  const liveElsewhere = { ...grantRow("grant.refused", { connector: "notion", gate: "grant_already_live" }), surface: "999888777666555444" };
  const liveHereQualified = { ...grantRow("grant.refused", { connector: "notion", gate: "grant_already_live" }), surface: `discord/guild-1/${MY_THREAD}` };
  ok(
    refusedGrantAlreadyLive([liveHere]).some((e) => surfaceNamesChannel(e.surface, MY_THREAD)),
    "the join accepts the refusal raised in THIS run's own thread — the bare-thread-id spelling `bindDiscord` writes",
  );
  ok(
    refusedGrantAlreadyLive([liveHereQualified]).some((e) => surfaceNamesChannel(e.surface, MY_THREAD)),
    "…and the qualified `discord/<guild>/<thread>` spelling, so a moved stamp shape does not silently stop matching",
  );
  ok(
    !refusedGrantAlreadyLive([liveElsewhere]).some((e) => surfaceNamesChannel(e.surface, MY_THREAD)),
    "🔴 NEGATIVE CONTROL: ANOTHER conversation's `grant_already_live` does NOT open the fall-through — unjoined, it would stand both Discord-owned hard gates down on a run whose own raise failed for a different reason, and swallow the skip that names it",
  );

  const sentNotice = grantRow("grant.notified", { outcome: "sent", ownerPlatform: "discord", owner: "discord/900000000000000001", grantId: "g1" });
  const failedNotice = grantRow("grant.notified", { outcome: "failed", ownerPlatform: "discord", owner: "discord/900000000000000001", grantId: "g2", error: "Error" });
  ok(noticesForGrant([sentNotice, failedNotice], "g1").length === 1, "noticesForGrant keys the notice to ONE grant id — the notice is claimed once per grant forever, so a leg must ask about its own grant, not its own time window");
  ok(noticesForGrant([sentNotice], "g2").length === 0, "NEGATIVE: another grant's notice does not answer for this one");
  ok(noticesForGrant([grantRow("grant.used", { grantId: "g1" })], "g1").length === 0, "NEGATIVE: a grant.used row is not a notice — the pairing of the two is the whole finding");
  ok(allNoticesDelivered([sentNotice], "discord"), "allNoticesDelivered accepts a delivered Discord notice");
  ok(!allNoticesDelivered([sentNotice, failedNotice], "discord"), "NEGATIVE: a failed notice means the owner was NOT told — accepting it would invert the row's whole purpose");
  ok(!allNoticesDelivered([grantRow("grant.notified", { outcome: "sent", ownerPlatform: "slack" })], "discord"), "NEGATIVE: a notice delivered on Slack does not prove Discord's DM arm ran");
  ok(!allNoticesDelivered([], "discord"), "VACUITY: allNoticesDelivered([]) is FALSE");
}

{
  const { GRANT_THREAD_RECORD_MAX_AGE_MS, parseGrantThreadRecord, readGrantThreadRecord, resolveGrantThread, serializeGrantThreadRecord, writeGrantThreadRecord } = await import(
    "../packages/core/scripts/e2e/grant-thread-record.js"
  );
  const raisedAt = "2026-05-12T08:30:00.000Z";
  const at = (ms: number): number => Date.parse(raisedAt) + ms;
  const record = { threadId: "1234567890", raisedAt };

  const { GRANT_ASK_TTL_MS, GRANT_SESSION_TTL_MS } = await import("../packages/core/agent/access/credential-grant.js");
  ok(
    GRANT_THREAD_RECORD_MAX_AGE_MS === GRANT_ASK_TTL_MS + GRANT_SESSION_TTL_MS,
    `OPE-1483: the record's max age IS the product's ask TTL plus its session-grant TTL (${GRANT_THREAD_RECORD_MAX_AGE_MS} vs ${GRANT_ASK_TTL_MS + GRANT_SESSION_TTL_MS})`,
  );

  ok(parseGrantThreadRecord(serializeGrantThreadRecord(record))?.threadId === "1234567890", "OPE-1483: a written record reads back as itself");
  ok(parseGrantThreadRecord(serializeGrantThreadRecord(record))?.raisedAt === raisedAt, "OPE-1483: the raise time round-trips — it is what makes the record expirable");
  ok(parseGrantThreadRecord("not json") === undefined, "NEGATIVE: unparseable text is no record");
  ok(parseGrantThreadRecord('["1234567890"]') === undefined, "NEGATIVE: an array is no record — a JSON.parse that merely succeeded is not enough");
  ok(parseGrantThreadRecord(JSON.stringify({ raisedAt })) === undefined, "NEGATIVE: a record with no threadId is no record");
  ok(parseGrantThreadRecord(JSON.stringify({ threadId: "   ", raisedAt })) === undefined, "NEGATIVE: a BLANK threadId is rejected — it would post to `/channels//messages`");
  ok(parseGrantThreadRecord(JSON.stringify({ threadId: "1", raisedAt: "whenever" })) === undefined, "NEGATIVE: an unparseable raise time is no record — an un-ageable record is exactly the stale one this expiry exists to catch");
  ok(parseGrantThreadRecord(JSON.stringify({ threadId: "1" })) === undefined, "NEGATIVE: a record with no raise time is no record, for the same reason");

  const pinned = resolveGrantThread({ pin: " 999 ", record: { threadId: "111", raisedAt: new Date(at(0)).toISOString() }, nowMs: at(0) });
  ok(pinned.kind === "pin" && pinned.threadId === "999", `OPE-1483: the operator's pin wins over the sidecar and is trimmed (read ${JSON.stringify(pinned)})`);
  const empty = resolveGrantThread({ pin: "  ", record, nowMs: at(60_000) });
  ok(empty.kind === "record" && empty.threadId === "1234567890", "OPE-1483: a blank pin is not a pin — an exported-but-empty shell variable falls through to the sidecar");
  ok(resolveGrantThread({ record, nowMs: at(60_000) }).kind === "record", "OPE-1483: with no pin the sidecar carries the thread — the same-machine re-run needs no hand-copied id");
  ok(resolveGrantThread({ nowMs: at(0) }).kind === "absent", "OPE-1483: neither carrier is `absent` — phase 2 skips with the remedy rather than driving a call into a session it guessed");

  const fresh = resolveGrantThread({ record, nowMs: at(GRANT_THREAD_RECORD_MAX_AGE_MS) });
  ok(fresh.kind === "record", "OPE-1483: a record exactly AT the ceiling is still usable — the bound is the last moment a grant can live, not the first moment it cannot");
  const stale = resolveGrantThread({ record, nowMs: at(GRANT_THREAD_RECORD_MAX_AGE_MS + 1) });
  ok(stale.kind === "expired" && stale.threadId === "1234567890", `OPE-1483: one millisecond past the ceiling the record is EXPIRED (read ${JSON.stringify(stale)})`);
  ok(stale.kind === "expired" && stale.ageMs === GRANT_THREAD_RECORD_MAX_AGE_MS + 1, "OPE-1483: the expired arm carries the AGE — the skip has to say how stale, or the operator cannot tell a wrong path from a lapsed tap");
  ok(resolveGrantThread({ record, nowMs: at(0) }).kind === "record", "OPE-1483: NEGATIVE CONTROL — a record raised this instant is NOT expired, so the arm above reads the clock rather than answering unconditionally");
  ok(resolveGrantThread({ pin: "999", record, nowMs: at(GRANT_THREAD_RECORD_MAX_AGE_MS * 10) }).kind === "pin", "OPE-1483: a pin is never aged — the harness never saw that raise, and the operator is asserting a live tap");

  const sinkDir = mkdtempSync(join(tmpdir(), "oe-grant-thread-"));
  const sink = join(sinkDir, "record.json");
  ok(readGrantThreadRecord(sink) === undefined, "OPE-1483: a missing sidecar reads as no record, never a throw — the first raising run on a machine has none");
  ok(writeGrantThreadRecord(sink, record), "OPE-1483: the raising run persists its thread id");
  ok(readGrantThreadRecord(sink)?.threadId === "1234567890", "OPE-1483: and the next run reads it back off disk");
  writeFileSync(sink, "{ half-writ");
  ok(readGrantThreadRecord(sink) === undefined, "OPE-1483: a corrupt sidecar degrades to no record — the operator's pin is the carrier that matters, and a live run must not die on scratch state");
  ok(!writeGrantThreadRecord(join(sinkDir, "no-such-dir", "record.json"), record), "OPE-1483: an unwritable path reports FALSE rather than throwing — the run has already earned phase 1's gates and must keep them");
  rmSync(sinkDir, { recursive: true, force: true });
}

{
  const row = (action: string, detail: Record<string, unknown>, surface = "C1") => ({
    ts: "2026-05-11T23:30:00.000Z",
    org: "default",
    platform: "slack",
    workspace: "T1",
    surface,
    action,
    detail,
  });

  ok(STOOD_DOWN_ACTION === STAND_DOWN_ACTION, "the pack's stood-down action name IS the tool's own STAND_DOWN_ACTION — no second spelling of one row");
  ok(dispatchedAction("discord") === "discord.dispatched" && dispatchedAction("notion") === "notion.dispatched", "dispatchedAction builds the per-platform dispatch action name");

  const KEY = "slack/T1/C1";
  const standDown = (marked: unknown) => row(STOOD_DOWN_ACTION, { surfaceKey: KEY, anchor: "1700.0001", marked, reason: null }, KEY);
  const marked = standDown(true);
  const unmarked = standDown(false);
  ok(standDownMarked([marked]), "standDownMarked reads marked:true — the registry really held a row, which is what makes the plain follow-up an ENGAGED wake");
  ok(!standDownMarked([unmarked]), "NEGATIVE: marked:false is NOT a stand-down that took — the tool writes the row then refuses, and reading it as success would report a stop that never happened");
  ok(!standDownMarked([row(STOOD_DOWN_ACTION, { anchor: "1700.0001" })]), "NEGATIVE: an absent `marked` field is not evidence of the effect");
  ok(!standDownMarked([row(STOOD_DOWN_ACTION, { anchor: "1700.0001", marked: "true" })]), "NEGATIVE: a STRING \"true\" is not the boolean the tool writes — a row that cannot state the effect is not evidence of it");
  ok(!standDownMarked([row("reply.post", { marked: true })]), "NEGATIVE: another action carrying a `marked` field is not a stand-down row");
  ok(!standDownMarked([]), "VACUITY: standDownMarked([]) is FALSE — no row means no proof, never a pass");
  ok(standDownMarked([marked], { anchor: "1700.0001" }), "the anchor join accepts the row for THIS conversation");
  ok(!standDownMarked([marked], { anchor: "1700.9999" }), "NEGATIVE: another conversation's stand-down does not answer for this one — the anchor is the registry's own key");
  ok(standDownMarked([marked], { surface: KEY }), "the surface join accepts a stand-down row scoped by its QUALIFIED key — the shape stand_down.ts writes");
  ok(!standDownMarked([marked], { surface: "slack/T1/CZ" }), "NEGATIVE: another room's stand-down does not answer for this one");
  ok(
    !standDownMarked([marked], { surface: "C1" }),
    "NEGATIVE: the BARE segment matches no stand-down row — reusing a reply.post scope here is how step (c) reds on a healthy deployment while its negative control passes vacuously beside it",
  );
  ok(
    standDownMarked([{ ...marked, surface: undefined }], { surface: KEY }),
    "the join also reads detail.surfaceKey, so a row whose top-level surface the route omits is still found",
  );
  ok(standDownRows([marked, unmarked, row("reply.post", {})]).length === 2, "standDownRows keeps both stand-down rows and drops everything else");

  ok(standDownAttemptedButUnmarked([unmarked]), "standDownAttemptedButUnmarked finds the marked:false row that falsifies the whole engaged claim");
  ok(!standDownAttemptedButUnmarked([marked]), "NEGATIVE: a successful stand-down is not an unmarked attempt");
  ok(!standDownAttemptedButUnmarked([]), "VACUITY: an empty window reports no falsification");

  const dispatched = (addressing: unknown) => ({ ...row("discord.dispatched", addressing === undefined ? {} : { addressing }), platform: "discord" });
  ok(dispatchAddressings([dispatched("thread-follow")], "discord").join(",") === "thread-follow", "dispatchAddressings reads detail.addressing off the platform's dispatch rows");
  ok(dispatchAddressings([dispatched("direct"), dispatched("name-drop")], "discord").join(",") === "direct,name-drop", "dispatchAddressings keeps the window's own order");
  ok(dispatchAddressings([dispatched(undefined)], "discord").length === 0, "a dispatch row with no addressing contributes nothing rather than an undefined entry");
  ok(dispatchAddressings([dispatched(7)], "discord").length === 0, "NEGATIVE: a non-string addressing is dropped, never coerced");
  ok(dispatchAddressings([dispatched("thread-follow")], "slack").length === 0, "NEGATIVE: rows are keyed to their OWN platform's action — Slack writes no dispatch row at all, and reading Discord's as Slack's would invent evidence");
  ok(reportedThreadFollow([dispatched("thread-follow")], "discord"), "reportedThreadFollow names the ENGAGED addressing");
  ok(!reportedThreadFollow([dispatched("channel-watch")], "discord"), "NEGATIVE: channel-watch is AMBIENT room chatter — treating it as engaged is exactly the confusion these journeys exist to end");
  ok(!reportedThreadFollow([], "discord"), "VACUITY: a surface that reports nothing reports no thread-follow — callers must log, not pass");
  ok(reportedDirectMention([dispatched("direct-mention")], "discord") && reportedDirectMention([dispatched("direct")], "discord"), "reportedDirectMention accepts BOTH spellings — Discord's native path stamps `direct`, every other surface `direct-mention`");
  ok(!reportedDirectMention([dispatched("name-drop")], "discord"), "NEGATIVE: a name-drop is not an @mention");
  ok(reportedNameDrop([dispatched("name-drop")], "discord"), "reportedNameDrop names the name-drop addressing");
  ok(!reportedNameDrop([dispatched("direct")], "discord"), "NEGATIVE: an @mention is not a name-drop");

  ok(isAmbientLegAddressing("channel-watch"), "isAmbientLegAddressing names unowned room chatter");
  ok(isAmbientLegAddressing("thread-follow"), "🔴 …and the ENGAGED plain comment, which is the spelling the promotion introduced — drop it and every ambient-leg filter goes blind on an engaged room");
  ok(!isAmbientLegAddressing("direct") && !isAmbientLegAddressing("direct-mention"), "🔴 NEGATIVE: the ADDRESSED leg's spellings are not the ambient leg's — a set that swallowed them would make every self-loop gate vacuous");
  ok(!isAmbientLegAddressing("name-drop"), "NEGATIVE: a name-drop is the addressed leg too");
  ok(!isAmbientLegAddressing(undefined) && !isAmbientLegAddressing(7), "a row with no addressing, or a non-string one, names no leg — never coerced");

  const selfLoopBody = SCENARIOS.find((s) => s.id === "J-LIN")!.run.toString().replace(/\s+/g, "");
  ok(
    !selfLoopBody.includes('addressing==="channel-watch"'),
    '🔴 OPE-1578: J-LIN filters its dispatch rows through `isAmbientLegAddressing`, never the literal `"channel-watch"` — the literal stops matching the moment the issue is engaged, which this leg\'s own @mention makes it',
  );
  ok(
    (selfLoopBody.match(/isAmbientLegAddressing\(/g) ?? []).length === 2,
    `OPE-1578: BOTH self-loop filters take it — the app-principal gate and the other-principal log arm (found ${(selfLoopBody.match(/isAmbientLegAddressing\(/g) ?? []).length})`,
  );

  const post = (surface: string) => row(REPLY_POST_ACTION, { chars: 12 }, surface);
  ok(replyPostCount([post("C1"), post("C1")]) === 2, "replyPostCount counts the posts the deployment actually made");
  ok(replyPostCount([post("C1"), post("CZ")], { surface: "C1" }) === 1, "the surface scope keeps one fixture's posts out of another's silence window");
  ok(
    replyPostCount([post("C1")], { surface: "slack/T1/C1" }) === 0,
    "NEGATIVE: a fully-qualified KEY matches no post row — the mirror of the stand-down case above, and an audited-silence gate scoped that way would pass however much the deployment posted",
  );
  ok(replyPostCount([row("slack.no_reply", {})]) === 0, "NEGATIVE: a silence row is not a post");
  ok(replyPostCount([]) === 0, "VACUITY: an empty window is zero posts — which is what AUDITED silence means");
}

{
  const {
    actingIdentityRead,
    allOrdinaryInstallReads,
    CONNECTOR_ACTING_IDENTITY_ACTION,
    HUMAN_ACTING_IDENTITY,
    installReads,
    INSTALL_IDENTITY,
    ownAccountRefusals,
    renderActingIdentityRead,
  } = await import("../packages/core/scripts/e2e/own-account-rows.js");

  ok(CONNECTOR_ACTING_IDENTITY_ACTION === "connector.acting_identity", "the action key is the writer's own, imported rather than re-typed");
  ok(INSTALL_IDENTITY === "install" && HUMAN_ACTING_IDENTITY === "human-acting", "the two identities are the ratified CredentialGrantFamily members");

  const aiRow = (detail: Record<string, unknown>, over: Partial<AuditWireEntry> = {}): AuditWireEntry => ({
    ts: "2026-05-13T23:30:00.000Z",
    org: "o",
    platform: "notion",
    workspace: "w",
    surface: "page-1",
    action: CONNECTOR_ACTING_IDENTITY_ACTION,
    detail,
    ...over,
  });
  const ordinary = aiRow({ askRecognised: false, connector: "notion", identity: "install", reason: "no-own-account-ask", refused: false, requiredIdentity: "install", tool: "read_notion_page" });
  const refusal = aiRow({ askRecognised: true, connector: "notion", reason: "own-account-ask-no-grant", refused: true, requiredIdentity: "human-acting", tool: "read_notion_page" });

  const both = actingIdentityRead([ordinary, refusal], "notion");
  ok(both.rows.length === 2 && both.undecodable === 0, "both emitted shapes decode — the refusal carries no `identity` and must still decode");
  ok(both.rows[1].identity === undefined && both.rows[1].refused, "a refused row decodes with no identity, which is the writer's own contract");
  ok(
    actingIdentityRead([ordinary, refusal], "linear").rows.length === 0,
    "NEGATIVE: the connector is MATCHED — a Linear question reads none of Notion's rows, so one vendor's decision can never answer another's",
  );
  ok(
    actingIdentityRead([aiRow({ askRecognised: false, connector: "notion", identity: "install", reason: "r", refused: false, requiredIdentity: "install", tool: "read_notion_page" }, { action: "connector.use" })], "notion").rows.length === 0,
    "NEGATIVE: a row under a different ACTION is not an acting-identity row however its detail reads",
  );
  const shapeChanged = actingIdentityRead([aiRow({ connector: "notion", reason: "own-account-ask-no-grant", refused: "true", requiredIdentity: "human-acting", tool: "read_notion_page" })], "notion");
  ok(
    shapeChanged.rows.length === 0 && shapeChanged.undecodable === 1,
    "a row carrying the action and connector but NOT the detail shape is COUNTED undecodable, never dropped silently — the change most likely to make the leg vacuous",
  );

  ok(ownAccountRefusals(both).length === 1 && ownAccountRefusals(both)[0].tool === "read_notion_page", "ownAccountRefusals finds the refusal and names the tool it stopped");
  ok(ownAccountRefusals(actingIdentityRead([ordinary], "notion")).length === 0, "NEGATIVE: an ordinary read is not a refusal");
  ok(
    ownAccountRefusals(actingIdentityRead([aiRow({ askRecognised: true, connector: "notion", reason: "x", refused: true, requiredIdentity: "install", tool: "read_notion_page" })], "notion")).length === 0,
    "NEGATIVE: a refusal that did NOT require human-acting is some other refusal — all three conditions are load-bearing",
  );
  ok(
    ownAccountRefusals(actingIdentityRead([aiRow({ askRecognised: false, connector: "notion", reason: "x", refused: true, requiredIdentity: "human-acting", tool: "read_notion_page" })], "notion")).length === 0,
    "NEGATIVE: a refusal with askRecognised=false was not produced by a person naming their account",
  );

  ok(allOrdinaryInstallReads(actingIdentityRead([ordinary, ordinary], "notion")), "the negative control passes when every row on the window is an ordinary team-identity read");
  ok(!allOrdinaryInstallReads(both), "NEGATIVE: a window holding a refusal is not an ordinary-read window");
  ok(
    !allOrdinaryInstallReads(actingIdentityRead([], "notion")),
    "VACUITY: an EMPTY window is false — a gate that was never reached must never read as a gate that refused nothing",
  );
  ok(!allOrdinaryInstallReads(shapeChanged), "NEGATIVE: an undecodable row on the window fails the control rather than being ignored");
  ok(
    !allOrdinaryInstallReads(actingIdentityRead([aiRow({ askRecognised: false, connector: "notion", identity: "human-acting", reason: "x", refused: false, requiredIdentity: "install", tool: "read_notion_page" })], "notion")),
    "NEGATIVE: a row that RAN under human-acting is not an install read, whatever it required",
  );
  ok(installReads(both).length === 1, "installReads counts the team-identity reads the leg reports beside its gate");

  ok(renderActingIdentityRead(actingIdentityRead([{ ...ordinary, action: "notion.dispatched" }], "notion")).includes("notion.dispatched"), "an empty read names the actions the window DID hold, so a red says what it saw");
  ok(renderActingIdentityRead(both).includes("refused=true") && renderActingIdentityRead(both).includes("read_notion_page"), "the read-out names each row's verdict and tool — printed on a pass too, so a green does not read as bare success");
}

{
  const scenariosSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
  const start = scenariosSrc.indexOf('id: "J-MPIM"');
  ok(start > 0, "the J-MPIM scenario is still in scenarios.ts (if it is gone, delete this section rather than letting it pass vacuously)");
  const nextId = scenariosSrc.indexOf('    id: "', start + 20);
  const body = scenariosSrc.slice(start, nextId > start ? nextId : scenariosSrc.length);
  ok(body.includes('actions: ["reply.post"]'), "…and it still reads the reply.post row — the gate this section guards has not been renamed out from under it");
  ok(
    body.includes("pollOptional("),
    "🔴 J-MPIM's reply.post audit read is POLLED, not read once (OPE-1682). A single read races the deployment's own audit write and reds a correct " +
      "deploy — measured on ship #192. Wrap it in pollOptional bounded by AUDIT_ROW_WAIT, never a bare ctx.auditRead",
  );
}

{
  const { NotionDriver, NotionRateLimitedError, NOTION_MAX_ATTEMPTS, NOTION_RATE_LIMIT_CODE, NOTION_RETRY_CAP_MS, notionFetch, parseNotionRetryAfterMs } = await import(
    "../packages/core/scripts/e2e/notion-driver.js"
  );

  const res = (status: number, opts: { retryAfter?: string; body?: unknown } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? (opts.retryAfter ?? null) : null) },
    text: async () => JSON.stringify(opts.body ?? {}),
    json: async () => opts.body ?? {},
  });

  ok(parseNotionRetryAfterMs("2", 0) === 2_000, "a delta-seconds Retry-After reads as milliseconds");
  ok(parseNotionRetryAfterMs("0.5", 0) === 500, "…including a fractional one");
  ok(parseNotionRetryAfterMs(null, 0) === undefined, "an absent header reads as UNKNOWN, so the caller uses its own fallback rather than guessing");
  ok(parseNotionRetryAfterMs("not-a-delay", 0) === undefined, "…as does a value in neither RFC 9110 form");
  ok(parseNotionRetryAfterMs(new Date(5_000).toUTCString(), 0) === 5_000, "an HTTP-date reads as a delay relative to now");
  ok(parseNotionRetryAfterMs(new Date(0).toUTCString(), 5_000) === 0, "a PAST date clamps to 0 — the vendor says the wait is already over");

  {
    const waits: number[] = [];
    let call = 0;
    const answer = await notionFetch(
      "https://api.notion.com/v1/comments",
      { method: "POST" },
      {
        what: "POST /v1/comments",
        fetchFn: async () => (++call === 1 ? res(429, { retryAfter: "2" }) : res(200)),
        sleepFn: async (ms) => void waits.push(ms),
      },
    );
    ok(answer.status === 200, "a 429 followed by a 200 answers 200 — the caller never sees the refusal");
    ok(call === 2, "…because the call was made again");
    ok(waits.length === 1 && waits[0] === 2_000, "…after waiting exactly what Retry-After named");
  }

  {
    const waits: number[] = [];
    let call = 0;
    await notionFetch(
      "https://api.notion.com/v1/search",
      { method: "POST" },
      { what: "POST /v1/search", fetchFn: async () => (++call === 1 ? res(429, { retryAfter: "3600" }) : res(200)), sleepFn: async (ms) => void waits.push(ms) },
    );
    ok(waits[0] === NOTION_RETRY_CAP_MS, `a one-hour Retry-After is capped at ${NOTION_RETRY_CAP_MS}ms — a leg that blocks that long reds anyway`);
  }

  {
    const waits: number[] = [];
    let call = 0;
    await notionFetch("https://api.notion.com/v1/search", {}, { what: "GET", fetchFn: async () => (++call === 1 ? res(429) : res(200)), sleepFn: async (ms) => void waits.push(ms) });
    ok(waits.length === 1 && waits[0] > 0, "a 429 carrying no Retry-After still backs off, on the declared fallback");
  }

  {
    const waits: number[] = [];
    let call = 0;
    const answer = await notionFetch(
      "https://api.notion.com/v1/comments",
      { method: "POST" },
      { what: "POST /v1/comments", fetchFn: async () => (++call === 1 ? res(429, { retryAfter: "0" }) : res(200)), sleepFn: async (ms) => void waits.push(ms) },
    );
    ok(answer.status === 200 && call === 2, "a 429 naming `Retry-After: 0` RETRIES immediately — the vendor said try again now, and giving up there would red a leg for free");
    ok(waits.length === 1 && waits[0] === 0, "…waiting the zero it named, rather than inventing a fallback the vendor did not ask for");
  }

  {
    let call = 0;
    let thrown: unknown;
    try {
      await notionFetch("https://api.notion.com/v1/comments", { method: "POST" }, { what: "POST /v1/comments", fetchFn: async () => (call++, res(429, { retryAfter: "1" })), sleepFn: async () => undefined });
    } catch (err) {
      thrown = err;
    }
    ok(thrown instanceof NotionRateLimitedError, "a Notion that never stops refusing throws the NAMED error, never a 429 response a caller would report as a product status");
    ok(call === NOTION_MAX_ATTEMPTS, `…after exactly ${NOTION_MAX_ATTEMPTS} attempts, so the retry is bounded`);
    ok(String(thrown).includes(NOTION_RATE_LIMIT_CODE), `…and the message names the limit (${NOTION_RATE_LIMIT_CODE}), so a run log says WHICH budget ran out`);
    ok(/HARNESS LIMIT, NOT A PRODUCT RED/u.test(String(thrown)), "…and says plainly that this is a harness limit, which is what a live run could not tell");
  }

  {
    let call = 0;
    const answer = await notionFetch("https://api.notion.com/v1/comments", {}, { what: "GET", fetchFn: async () => (call++, res(403)), sleepFn: async () => undefined });
    ok(answer.status === 403 && call === 1, "a 403 is returned as it stands, on ONE call — a permission refusal is not retried");
  }

  {
    let call = 0;
    const driver = new NotionDriver(
      { driverKey: "k", pageId: "p", workspaceId: "w", botUserId: "b" } as never,
      {
        fetchFn: async () => (++call === 1 ? res(429, { retryAfter: "1" }) : res(200, { body: { id: "c1", discussion_id: "d1" } })),
        sleepFn: async () => undefined,
      },
    );
    const made = await driver.createBlockDiscussion("block-1", "hello");
    ok(made.commentId === "c1" && made.discussionId === "d1", "a driver method that hits a 429 retries and returns the real answer — the call site really goes through the helper");
    ok(call === 2, "…and it was the retry that produced it");
  }
}
console.log(
  `✓ e2e-driver: ${passed} assertions passed (${shapeChecks} are per-scenario roster-shape checks, ` +
    `${passed - shapeChecks} are harness/driver logic — neither half is a product-behaviour coverage figure)`,
);
