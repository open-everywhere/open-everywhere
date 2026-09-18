import { ROOM_VARS, TRACKED_ROOM_IDS, credentialVarFor, identityVarsFor, roomIdFor, teamsSegment } from "./fixture-inventory-lib.js";
import { resolveControlWriteConfig, type ControlWriteConfig } from "./control-write-driver.js";

export const ENV = {
  slackUserToken: "E2E_SLACK_USER_TOKEN",
  slackChannel: "E2E_SLACK_CHANNEL",
  slackBotUserId: "E2E_SLACK_BOT_USER_ID",
  slackAdminUserId: "E2E_SLACK_ADMIN_USER_ID",
  discordDriverToken: "E2E_DISCORD_DRIVER_TOKEN",
  discordChannel: "E2E_DISCORD_CHANNEL",
  discordBotUserId: "E2E_DISCORD_BOT_USER_ID",
  slackPrivateChannel: "E2E_SLACK_PRIVATE_CHANNEL",
  slackChannelB: "E2E_SLACK_CHANNEL_B",
  slackMpimChannel: "E2E_SLACK_MPIM_CHANNEL",
  slackDmChannel: "E2E_SLACK_DM_CHANNEL",
  slackUser2Id: "E2E_SLACK_USER2_ID",
  slackSecondaryToken: "E2E_SLACK_SECONDARY_TOKEN",
  slackSecondaryUserId: "E2E_SLACK_SECONDARY_USER_ID",
  org: "E2E_ORG",
  targetUrl: "E2E_TARGET_URL",
  slackSigningSecret: "SLACK_SIGNING_SECRET",
  auditSilences: "E2E_AUDIT_SILENCES",
  webhookSecret: "E2E_WEBHOOK_SECRET",
  webhookHookId: "E2E_WEBHOOK_HOOK_ID",
  slackSupervisorChannel: "E2E_SLACK_SUPERVISOR_CHANNEL",
  slackCapChannel: "E2E_SLACK_CAP_CHANNEL",
  slackHaltChannel: "E2E_SLACK_HALT_CHANNEL",
  controlLocalWrite: "E2E_CONTROL_LOCAL_WRITE",
  accessAllowSend: "E2E_ACCESS_ALLOW_SEND",
  notionChannel: "E2E_NOTION_CHANNEL",
  notionQuery: "E2E_NOTION_QUERY",
  teamsTenantId: "E2E_TEAMS_TENANT_ID",
  teamsClientId: "E2E_TEAMS_CLIENT_ID",
  teamsRefreshToken: "E2E_TEAMS_REFRESH_TOKEN",
  teamsTeamId: "E2E_TEAMS_TEAM_ID",
  teamsChannelId: "E2E_TEAMS_CHANNEL_ID",
  teamsBotAppId: "E2E_TEAMS_BOT_APP_ID",
  teamsRefreshTokenFile: "E2E_TEAMS_REFRESH_TOKEN_FILE",

  githubDriverToken: "E2E_GITHUB_DRIVER_TOKEN",
  githubRepo: "E2E_GITHUB_REPO",
  githubAppSlug: "E2E_GITHUB_APP_SLUG",
  githubIssue: "E2E_GITHUB_ISSUE",
  githubWebhookSecret: "E2E_GITHUB_WEBHOOK_SECRET",
  githubInstallationId: "E2E_GITHUB_INSTALLATION_ID",

  prRepo: "E2E_PR_REPO",
  prBase: "E2E_PR_BASE",
  prUngrantedRepo: "E2E_PR_UNGRANTED_REPO",

  linearApiKey: "E2E_LINEAR_API_KEY",
  addressedLinearApiKey: "E2E_ADDRESSED_LINEAR_API_KEY",
  linearTeamId: "E2E_LINEAR_TEAM_ID",
  linearAppUserId: "E2E_LINEAR_APP_USER_ID",
  linearAgentHandle: "E2E_LINEAR_AGENT_HANDLE",
  linearWebhookSecret: "E2E_LINEAR_WEBHOOK_SECRET",

  notionDriverKey: "E2E_NOTION_DRIVER_KEY",
  notionAmbientPageId: "E2E_NOTION_PAGE_ID",
  notionAmbientWebhookSecret: "E2E_NOTION_WEBHOOK_SECRET",
  notionBotUserId: "E2E_NOTION_BOT_USER_ID",
  notionWorkspaceId: "E2E_NOTION_WORKSPACE_ID",
  notionAnchorOnTopic: "E2E_NOTION_ANCHOR_ONTOPIC",
  notionAnchorOnTopic2: "E2E_NOTION_ANCHOR_ONTOPIC2",
  notionAnchorOffTopic: "E2E_NOTION_ANCHOR_OFFTOPIC",
  notionAnchorHuman: "E2E_NOTION_ANCHOR_HUMAN",

  slackUnifiedChannelA: "E2E_SLACK_UNIFIED_CHANNEL_A",
  slackUnifiedChannelB: "E2E_SLACK_UNIFIED_CHANNEL_B",
  unifiedDomain: "E2E_UNIFIED_DOMAIN",

  slackSoakChannelDev: "E2E_SLACK_SOAK_CHANNEL_DEV",
  slackSoakChannelOps: "E2E_SLACK_SOAK_CHANNEL_OPS",
  notionSoakPage1: "E2E_NOTION_SOAK_PAGE_1",
  notionSoakPage2: "E2E_NOTION_SOAK_PAGE_2",
  linearSoakLabelId: "E2E_SOAK_LINEAR_LABEL_ID",
  linearSoakDriverKey: "E2E_LINEAR_SOAK_DRIVER_KEY",
  linearSoakTeamId: "E2E_SOAK_LINEAR_TEAM_ID",
  linearSoakAppUserId: "E2E_SOAK_LINEAR_APP_USER_ID",
  linearSoakAgentHandle: "E2E_SOAK_LINEAR_AGENT_HANDLE",
  githubSoakRepo: "E2E_GITHUB_SOAK_REPO",
  soakDomain: "E2E_SOAK_DOMAIN",

  engagedGithubRepo: "E2E_ADDRESSED_GITHUB_REPO",
  engagedDiscordChannel: "E2E_ADDRESSED_DISCORD_CHANNEL",
  engagedLinearTeamId: "E2E_ADDRESSED_LINEAR_TEAM_ID",
  engagedNotionPageId: "E2E_ADDRESSED_NOTION_PAGE_ID",
  engagedTeamsSurface: "E2E_ADDRESSED_TEAMS_SURFACE",

  expectUnified: "E2E_EXPECT_UNIFIED",
  unixArmed: "E2E_UNIX_ARMED",
  spendGateDoor: "E2E_SPEND_GATE_DOOR",
  accessPersonalFixture: "E2E_ACCESS_PERSONAL_FIXTURE",
  discordGrantOwner: "E2E_DISCORD_GRANT_OWNER",
  discordGrantTapped: "E2E_DISCORD_GRANT_TAPPED",
  discordGrantThread: "E2E_DISCORD_GRANT_THREAD",
  discordGrantThreadFile: "E2E_DISCORD_GRANT_THREAD_FILE",
  expectModels: "E2E_EXPECT_MODELS",
  expectModelsRequired: "E2E_EXPECT_MODELS_REQUIRED",
} as const;

export type Capability =
  | "slack"
  | "discord"
  | "synthetic"
  | "slackPrivate"
  | "slackChannelB"
  | "slackMpim"
  | "slackCapFixture"
  | "slackHalt"
  | "controlWrite"
  | "syntheticDm"
  | "slackUser2"
  | "slackSecondary"
  | "webhook"
  | "notion"
  | "slackSupervisor"
  | "teams"
  | "github"
  | "linear"
  | "notionAmbient"
  | "slackUnified"
  | "pr"
  | "connectorWrite"
  | "soakSlack"
  | "soakNotion"
  | "soakLinear"
  | "engagedSlack"
  | "engagedDiscord"
  | "engagedTeams"
  | "engagedGithub"
  | "engagedLinear"
  | "engagedNotion";

export const CAPABILITY_REMEDY: Partial<Record<Capability, string>> = {
  slackMpim:
    "the room EXISTS and TRACKED_ROOM_IDS carries its id, so this capability needs no variable — reaching this line means the id left that table. " +
    "`npm run e2e:fixtures -- provision-mpim` re-opens the same group DM and prints the id to put back (Slack answers the same channel for the same member set). " +
    "Opening the room is not reading it: the leg needs the `mpim:history` and `mpim:read` scopes on the driver app for `conversations.history` and `conversations.info`, " +
    "and the OE app needs both on the deployment side, which no command here can check",
};

export interface SlackDriverConfig {
  readonly token: string;
  readonly channel: string;
  readonly botUserId: string;
}

export interface DiscordDriverConfig {
  readonly token: string;
  readonly channel: string;
  readonly botUserId: string;
}

export interface TeamsDriverConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly refreshTokenFile: string;
  readonly botAppId: string;
}

export interface SyntheticConfig {
  readonly targetUrl: string;
  readonly signingSecret: string;
  readonly adminUserId: string;
  readonly channel: string;
  readonly org: string;
}

export interface SlackExtraChannelConfig {
  readonly channel: string;
}

export interface SlackUser2Config {
  readonly userId: string;
}

export interface SlackSecondaryConfig {
  readonly token: string;
  readonly userId: string;
}

export interface WebhookConfig {
  readonly targetUrl: string;
  readonly secret: string;
  readonly hookId: string;
}

export interface NotionConfig {
  readonly channel: string;
  readonly query: string;
}

export interface SyntheticDmConfig {
  readonly dmChannel: string;
}

export interface GithubDriverConfig {
  readonly token: string;
  readonly repo: string;
  readonly appSlug: string;
  readonly issue: string;
  readonly webhookSecret?: string;
  readonly installationId?: string;
}

export interface LinearDriverConfig {
  readonly apiKey: string;
  readonly teamId: string;
  readonly appUserId: string;
  readonly agentHandle: string;
  readonly webhookSecret?: string;
}

export interface NotionAmbientConfig {
  readonly driverKey: string;
  readonly pageId: string;
  readonly botUserId: string;
  readonly workspaceId: string;
  readonly webhookSecret?: string;
  readonly anchorOnTopic?: string;
  readonly anchorOnTopic2?: string;
  readonly anchorOffTopic?: string;
  readonly anchorHuman?: string;
}

export interface SlackUnifiedConfig {
  readonly channelA: string;
  readonly channelB: string;
  readonly domain: string;
}

export interface PrConfig {
  readonly repo: string;
  readonly token: string;
}

export interface ConnectorWriteConfig {
  readonly channel: string;
}

export interface SoakSlackConfig {
  readonly channelDev: string;
  readonly channelOps: string;
}

export interface SoakNotionConfig {
  readonly page1: string;
  readonly page2: string;
}

export interface SoakLinearConfig {
  readonly labelId: string;
  readonly apiKey: string;
  readonly teamId: string;
}

export type Resolved<T> =
  | { readonly ok: true; readonly cfg: T }
  | { readonly ok: false; readonly missing: readonly string[] };

type Env = Record<string, string | undefined>;

function need(env: Env, names: readonly string[]): { values: string[]; missing: string[] } {
  const values: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const v = env[name]?.trim();
    if (v) values.push(v);
    else missing.push(name);
  }
  return { values, missing };
}

export function resolveSlack(env: Env = process.env): Resolved<SlackDriverConfig> {
  const { values, missing } = need(env, [ENV.slackUserToken, ENV.slackChannel, ENV.slackBotUserId]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { token: values[0], channel: values[1], botUserId: values[2] } };
}

export function resolveDiscord(env: Env = process.env): Resolved<DiscordDriverConfig> {
  const { values, missing } = need(env, [ENV.discordDriverToken, ENV.discordChannel, ENV.discordBotUserId]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { token: values[0], channel: values[1], botUserId: values[2] } };
}

export function resolveTeams(env: Env = process.env): Resolved<TeamsDriverConfig> {
  const { values, missing } = need(env, [
    ENV.teamsTenantId,
    ENV.teamsClientId,
    ENV.teamsRefreshToken,
    ENV.teamsTeamId,
    ENV.teamsChannelId,
    ENV.teamsBotAppId,
  ]);
  if (missing.length > 0) return { ok: false, missing };
  const refreshTokenFile = env[ENV.teamsRefreshTokenFile]?.trim() || DEFAULT_TEAMS_REFRESH_SINK;
  return {
    ok: true,
    cfg: {
      tenantId: values[0],
      clientId: values[1],
      refreshToken: values[2],
      teamId: values[3],
      channelId: values[4],
      refreshTokenFile,
      botAppId: values[5],
    },
  };
}

export const DEFAULT_TEAMS_REFRESH_SINK = ".env.e2e.teams-refresh";

export const PACING_CHANNEL_FLOOR_MS = 10_000;

export const PACING_MAX_CONCURRENT_PER_SURFACE = 2;

export function resolveSynthetic(env: Env = process.env): Resolved<SyntheticConfig> {
  const { values, missing } = need(env, [ENV.targetUrl, ENV.slackSigningSecret, ENV.slackAdminUserId, ENV.slackChannel]);
  if (missing.length > 0) return { ok: false, missing };
  const org = env[ENV.org]?.trim() || "default";
  return { ok: true, cfg: { targetUrl: values[0].replace(/\/+$/, ""), signingSecret: values[1], adminUserId: values[2], channel: values[3], org } };
}

export function slackAddOnRoomCollapsed(env: Env, channel: string): boolean {
  const base = env[ENV.slackChannel]?.trim();
  return base !== undefined && base.length > 0 && base === channel;
}

export function resolveSlackPrivate(env: Env = process.env): Resolved<SlackExtraChannelConfig> {
  const { values, missing } = need(env, [ENV.slackPrivateChannel]);
  if (missing.length > 0) return { ok: false, missing };
  if (slackAddOnRoomCollapsed(env, values[0]))
    return {
      ok: false,
      missing: [
        `${ENV.slackPrivateChannel} to a channel other than ${ENV.slackChannel}'s — S9/S11 need a room no explicit domain claims, so it resolves through the org criteria domain, which arms nameDropWake and runs no ambient supervisor (OPE-1905)`,
      ],
    };
  return { ok: true, cfg: { channel: values[0] } };
}

export function resolveSlackChannelB(env: Env = process.env): Resolved<SlackExtraChannelConfig> {
  const { values, missing } = need(env, [ENV.slackChannelB]);
  if (missing.length > 0) return { ok: false, missing };
  if (slackAddOnRoomCollapsed(env, values[0]))
    return {
      ok: false,
      missing: [`${ENV.slackChannelB} to a channel other than ${ENV.slackChannel}'s — S12 needs a SECOND silo to isolate from the first (OPE-1905)`],
    };
  return { ok: true, cfg: { channel: values[0] } };
}

export function resolveSlackMpim(
  env: Env = process.env,
  tracked: Readonly<Record<string, string>> = TRACKED_ROOM_IDS,
): Resolved<SlackExtraChannelConfig> {
  const channel = roomIdFor(ENV.slackMpimChannel, env, tracked);
  if (!channel) return { ok: false, missing: [ENV.slackMpimChannel] };
  return { ok: true, cfg: { channel } };
}

export function resolveSlackCapFixture(env: Env = process.env): Resolved<SlackExtraChannelConfig> {
  const { values, missing } = need(env, [ENV.slackCapChannel]);
  if (missing.length > 0) return { ok: false, missing };
  if (slackAddOnRoomCollapsed(env, values[0]))
    return {
      ok: false,
      missing: [`${ENV.slackCapChannel} to a channel other than ${ENV.slackChannel}'s — S10 needs a ledger the shared room cannot entangle (OPE-1905)`],
    };
  return { ok: true, cfg: { channel: values[0] } };
}

export function resolveSlackHalt(
  env: Env = process.env,
  tracked: Readonly<Record<string, string>> = TRACKED_ROOM_IDS,
): Resolved<SlackExtraChannelConfig> {
  const channel = roomIdFor(ENV.slackHaltChannel, env, tracked);
  if (!channel) return { ok: false, missing: [ENV.slackHaltChannel] };
  const collision = ROOM_VARS.find(
    (room) => room.surface === "slack" && room.envVar !== ENV.slackHaltChannel && roomIdFor(room.envVar, env, tracked) === channel,
  );
  if (collision) {
    return { ok: false, missing: [`${ENV.slackHaltChannel} to a room other than ${collision.envVar}'s — S-HALT needs an isolated cleanup scope`] };
  }
  return { ok: true, cfg: { channel } };
}

export function resolveControlWrite(env: Env = process.env): Resolved<ControlWriteConfig> {
  const resolved = resolveControlWriteConfig(env);
  return resolved.ok ? { ok: true, cfg: resolved.cfg } : { ok: false, missing: resolved.missing };
}

export function resolveSlackSupervisor(env: Env = process.env): Resolved<SlackExtraChannelConfig> {
  const { values, missing } = need(env, [ENV.slackSupervisorChannel]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { channel: values[0] } };
}

export function resolveSlackUser2(env: Env = process.env): Resolved<SlackUser2Config> {
  const { values, missing } = need(env, [ENV.slackUser2Id]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { userId: values[0] } };
}

export function resolveSlackSecondary(env: Env = process.env): Resolved<SlackSecondaryConfig> {
  const { values, missing } = need(env, [ENV.slackSecondaryToken, ENV.slackSecondaryUserId]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { token: values[0], userId: values[1] } };
}

export function resolveSyntheticDm(env: Env = process.env): Resolved<SyntheticDmConfig> {
  const { values, missing } = need(env, [ENV.slackDmChannel]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { dmChannel: values[0] } };
}

export function resolveWebhook(env: Env = process.env): Resolved<WebhookConfig> {
  const { values, missing } = need(env, [ENV.targetUrl, ENV.webhookSecret]);
  if (missing.length > 0) return { ok: false, missing };
  const hookId = env[ENV.webhookHookId]?.trim() || "e2e-smoke";
  return { ok: true, cfg: { targetUrl: values[0].replace(/\/+$/, ""), secret: values[1], hookId } };
}

export const S24_DEFAULT_QUERY = "team handbook";

export function resolveNotion(env: Env = process.env): Resolved<NotionConfig> {
  const { values, missing } = need(env, [ENV.notionChannel]);
  if (missing.length > 0) return { ok: false, missing };
  const query = env[ENV.notionQuery]?.trim() || S24_DEFAULT_QUERY;
  return { ok: true, cfg: { channel: values[0], query } };
}

export function resolveGithub(env: Env = process.env): Resolved<GithubDriverConfig> {
  const { values, missing } = need(env, [ENV.githubDriverToken, ENV.githubRepo, ENV.githubAppSlug, ENV.githubIssue]);
  if (missing.length > 0) return { ok: false, missing };
  const webhookSecret = env[ENV.githubWebhookSecret]?.trim();
  const installationId = env[ENV.githubInstallationId]?.trim();
  return {
    ok: true,
    cfg: { token: values[0], repo: values[1], appSlug: values[2], issue: values[3], ...(webhookSecret ? { webhookSecret } : {}), ...(installationId ? { installationId } : {}) },
  };
}

export function resolveLinear(env: Env = process.env): Resolved<LinearDriverConfig> {
  const { values, missing } = need(env, [ENV.linearApiKey, ENV.linearTeamId, ENV.linearAppUserId, ENV.linearAgentHandle]);
  if (missing.length > 0) return { ok: false, missing };
  const webhookSecret = env[ENV.linearWebhookSecret]?.trim();
  return { ok: true, cfg: { apiKey: values[0], teamId: values[1], appUserId: values[2], agentHandle: values[3], ...(webhookSecret ? { webhookSecret } : {}) } };
}

export function resolveNotionAmbient(env: Env = process.env): Resolved<NotionAmbientConfig> {
  const { missing } = need(env, [ENV.notionDriverKey, ENV.notionAmbientPageId, ENV.notionBotUserId, ENV.notionWorkspaceId]);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    cfg: {
      driverKey: env[ENV.notionDriverKey]!.trim(),
      pageId: env[ENV.notionAmbientPageId]!.trim(),
      botUserId: env[ENV.notionBotUserId]!.trim(),
      workspaceId: env[ENV.notionWorkspaceId]!.trim(),
      webhookSecret: env[ENV.notionAmbientWebhookSecret]?.trim() || undefined,
      anchorOnTopic: env[ENV.notionAnchorOnTopic]?.trim() || undefined,
      anchorOnTopic2: env[ENV.notionAnchorOnTopic2]?.trim() || undefined,
      anchorOffTopic: env[ENV.notionAnchorOffTopic]?.trim() || undefined,
      anchorHuman: env[ENV.notionAnchorHuman]?.trim() || undefined,
    },
  };
}

export function resolveSlackUnified(env: Env = process.env): Resolved<SlackUnifiedConfig> {
  const { values, missing } = need(env, [ENV.slackUnifiedChannelA, ENV.slackUnifiedChannelB]);
  if (missing.length > 0) return { ok: false, missing };
  const domain = env[ENV.unifiedDomain]?.trim() || "e2e-unified";
  return { ok: true, cfg: { channelA: values[0], channelB: values[1], domain } };
}

export function resolvePr(env: Env = process.env): Resolved<PrConfig> {
  const { values, missing } = need(env, [ENV.prRepo, ENV.githubDriverToken]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { repo: values[0], token: values[1] } };
}

export function resolveConnectorWrite(env: Env = process.env): Resolved<ConnectorWriteConfig> {
  const { values, missing } = need(env, [ENV.notionChannel]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { channel: values[0] } };
}

export function resolveSoakSlack(env: Env = process.env): Resolved<SoakSlackConfig> {
  const { values, missing } = need(env, [ENV.slackSoakChannelDev, ENV.slackSoakChannelOps]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { channelDev: values[0], channelOps: values[1] } };
}

export function resolveSoakNotion(env: Env = process.env): Resolved<SoakNotionConfig> {
  const { values, missing } = need(env, [ENV.notionSoakPage1, ENV.notionSoakPage2]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { page1: values[0], page2: values[1] } };
}

export function resolveSoakLinear(env: Env = process.env): Resolved<SoakLinearConfig> {
  const { values, missing } = need(env, [ENV.linearSoakLabelId, ENV.linearSoakDriverKey, ENV.linearSoakTeamId]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { labelId: values[0], apiKey: values[1], teamId: values[2] } };
}

export function resolveSoakLinearDriver(env: Env = process.env): Resolved<LinearDriverConfig> {
  const { values, missing } = need(env, [ENV.linearSoakDriverKey, ENV.linearSoakTeamId, ENV.linearSoakAppUserId, ENV.linearSoakAgentHandle]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { apiKey: values[0], teamId: values[1], appUserId: values[2], agentHandle: values[3] } };
}

export function resolveSoakGithub(env: Env = process.env): Resolved<GithubDriverConfig> {
  const base = resolveGithub(env);
  const { values, missing } = need(env, [ENV.githubSoakRepo]);
  if (!base.ok || missing.length > 0) return { ok: false, missing: [...(base.ok ? [] : base.missing), ...missing] };
  return { ok: true, cfg: { ...base.cfg, repo: values[0] } };
}

export interface EngagedRoomConfig {
  readonly id: string;
}

function engagedRoom(env: Env, name: string): Resolved<EngagedRoomConfig> {
  const { values, missing } = need(env, [name]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { id: values[0] } };
}

export type EngagedSurface = "slack" | "discord" | "teams" | "github" | "linear" | "notion";

export const ENGAGED_ROOM_VARS: Readonly<Record<EngagedSurface, string>> = {
  slack: ENV.slackPrivateChannel,
  discord: ENV.engagedDiscordChannel,
  teams: ENV.engagedTeamsSurface,
  github: ENV.engagedGithubRepo,
  linear: ENV.engagedLinearTeamId,
  notion: ENV.engagedNotionPageId,
};

export function resolveEngagedSlack(env: Env = process.env): Resolved<EngagedRoomConfig> {
  return engagedRoom(env, ENGAGED_ROOM_VARS.slack);
}

export function resolveEngagedDiscord(env: Env = process.env): Resolved<EngagedRoomConfig> {
  return engagedRoom(env, ENGAGED_ROOM_VARS.discord);
}

function teamsChannelOf(value: string): string {
  return value.startsWith("teams/") ? (value.split("/").pop() ?? "") : value;
}

function teamsCompareKey(value: string): string {
  return teamsSegment(teamsChannelOf(value));
}

export function resolveEngagedTeams(env: Env = process.env): Resolved<EngagedRoomConfig> {
  const room = engagedRoom(env, ENGAGED_ROOM_VARS.teams);
  if (!room.ok) return room;
  const id = teamsChannelOf(room.cfg.id);
  if (id.length === 0) return { ok: false, missing: [ENGAGED_ROOM_VARS.teams] };
  const shared = env[ENV.teamsChannelId]?.trim();
  if (shared && teamsCompareKey(shared) === teamsCompareKey(room.cfg.id)) {
    return {
      ok: false,
      missing: [
        `${ENGAGED_ROOM_VARS.teams} to a channel other than ${ENV.teamsChannelId}'s — J-ENGAGED-teams needs a room of its own (OPE-1531)`,
      ],
    };
  }
  return { ok: true, cfg: { id } };
}

export function resolveEngagedGithub(
  env: Env = process.env,
  tracked: Readonly<Record<string, string>> = TRACKED_ROOM_IDS,
): Resolved<EngagedRoomConfig> {
  const repo = roomIdFor(ENGAGED_ROOM_VARS.github, env, tracked);
  if (!repo) return { ok: false, missing: [ENGAGED_ROOM_VARS.github] };
  return { ok: true, cfg: { id: repo } };
}

export function resolveEngagedLinear(
  env: Env = process.env,
  tracked: Readonly<Record<string, string>> = TRACKED_ROOM_IDS,
): Resolved<EngagedRoomConfig> {
  const id = roomIdFor(ENGAGED_ROOM_VARS.linear, env, tracked);
  if (!id) return { ok: false, missing: [ENGAGED_ROOM_VARS.linear] };
  const room: Resolved<EngagedRoomConfig> = { ok: true, cfg: { id } };
  const keyVar = credentialVarFor(ENGAGED_ROOM_VARS.linear);
  if (keyVar !== undefined && !env[keyVar]?.trim()) {
    return {
      ok: false,
      missing: [`${keyVar} — this team is in its own Linear workspace, so ${ENV.linearApiKey} cannot see it (mint a personal API key in THAT workspace)`],
    };
  }
  const identity = identityVarsFor(ENGAGED_ROOM_VARS.linear);
  if (identity !== undefined) {
    const unset = [identity.appUserVar, identity.agentHandleVar].filter((v) => !env[v]?.trim());
    if (unset.length > 0) {
      return {
        ok: false,
        missing: [`${unset.join(" and ")} — OE runs a SEPARATE app per Linear workspace, so this team needs its workspace's own app-user id and mention handle (${ENV.linearAppUserId} names a user that workspace does not have)`],
      };
    }
  }
  return room;
}

export function engagedLinearIdentity(env: Env = process.env, fallback: { appUserId: string; agentHandle: string }): { appUserId: string; agentHandle: string } {
  const identity = identityVarsFor(ENGAGED_ROOM_VARS.linear);
  if (identity === undefined) return fallback;
  return {
    appUserId: env[identity.appUserVar]?.trim() || fallback.appUserId,
    agentHandle: env[identity.agentHandleVar]?.trim() || fallback.agentHandle,
  };
}

export function engagedLinearApiKey(env: Env = process.env, fallback: string): string {
  return env[ENV.addressedLinearApiKey]?.trim() || fallback;
}

export function resolveEngagedNotion(env: Env = process.env): Resolved<EngagedRoomConfig> {
  return engagedRoom(env, ENGAGED_ROOM_VARS.notion);
}

export function isLocalEvalTarget(targetUrl: string | undefined): boolean {
  if (!targetUrl) return false;
  try {
    const { hostname } = new URL(targetUrl);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export function auditSilencesExpected(env: Env = process.env, targetUrl?: string): boolean {
  return env[ENV.auditSilences]?.trim() === "1" && isLocalEvalTarget(targetUrl);
}

export interface CapabilityReport {
  readonly available: ReadonlySet<Capability>;
  readonly missing: Readonly<Record<Capability, readonly string[]>>;
}

export interface TrackedRoomResolver {
  readonly capability: Capability;
  readonly roomId: (env: Env, tracked: Readonly<Record<string, string>>) => string | undefined;
  readonly alsoNeeds: readonly string[];
}

function roomExtraVars(envVar: string): readonly string[] {
  const identity = identityVarsFor(envVar);
  const credential = credentialVarFor(envVar);
  return [...(credential ? [credential] : []), ...(identity ? [identity.appUserVar, identity.agentHandleVar] : [])];
}

export const TRACKED_ROOM_RESOLVERS: Readonly<Record<string, TrackedRoomResolver>> = {
  [ENV.slackMpimChannel]: {
    capability: "slackMpim",
    roomId: (env, tracked) => {
      const r = resolveSlackMpim(env, tracked);
      return r.ok ? r.cfg.channel : undefined;
    },
    alsoNeeds: roomExtraVars(ENV.slackMpimChannel),
  },
  [ENV.slackHaltChannel]: {
    capability: "slackHalt",
    roomId: (env, tracked) => {
      const r = resolveSlackHalt(env, tracked);
      return r.ok ? r.cfg.channel : undefined;
    },
    alsoNeeds: roomExtraVars(ENV.slackHaltChannel),
  },
  [ENGAGED_ROOM_VARS.github]: {
    capability: "engagedGithub",
    roomId: (env, tracked) => {
      const r = resolveEngagedGithub(env, tracked);
      return r.ok ? r.cfg.id : undefined;
    },
    alsoNeeds: roomExtraVars(ENGAGED_ROOM_VARS.github),
  },
  [ENGAGED_ROOM_VARS.linear]: {
    capability: "engagedLinear",
    roomId: (env, tracked) => {
      const r = resolveEngagedLinear(env, tracked);
      return r.ok ? r.cfg.id : undefined;
    },
    alsoNeeds: roomExtraVars(ENGAGED_ROOM_VARS.linear),
  },
};

export function resolveCapabilities(env: Env = process.env, tracked: Readonly<Record<string, string>> = TRACKED_ROOM_IDS): CapabilityReport {
  const slack = resolveSlack(env);
  const discord = resolveDiscord(env);
  const teams = resolveTeams(env);
  const synthetic = resolveSynthetic(env);
  const slackPrivate = resolveSlackPrivate(env);
  const slackChannelB = resolveSlackChannelB(env);
  const slackMpim = resolveSlackMpim(env, tracked);
  const slackCapFixture = resolveSlackCapFixture(env);
  const slackHalt = resolveSlackHalt(env, tracked);
  const controlWrite = resolveControlWrite(env);
  const slackSupervisor = resolveSlackSupervisor(env);
  const syntheticDm = resolveSyntheticDm(env);
  const slackUser2 = resolveSlackUser2(env);
  const slackSecondary = resolveSlackSecondary(env);
  const webhook = resolveWebhook(env);
  const notion = resolveNotion(env);
  const github = resolveGithub(env);
  const linear = resolveLinear(env);
  const notionAmbient = resolveNotionAmbient(env);
  const slackUnified = resolveSlackUnified(env);
  const pr = resolvePr(env);
  const connectorWrite = resolveConnectorWrite(env);
  const soakSlack = resolveSoakSlack(env);
  const soakNotion = resolveSoakNotion(env);
  const soakLinear = resolveSoakLinear(env);
  const engagedSlack = resolveEngagedSlack(env);
  const engagedDiscord = resolveEngagedDiscord(env);
  const engagedTeams = resolveEngagedTeams(env);
  const engagedGithub = resolveEngagedGithub(env, tracked);
  const engagedLinear = resolveEngagedLinear(env, tracked);
  const engagedNotion = resolveEngagedNotion(env);
  const available = new Set<Capability>();
  if (slack.ok) available.add("slack");
  if (discord.ok) available.add("discord");
  if (teams.ok) available.add("teams");
  if (synthetic.ok) available.add("synthetic");
  if (slackPrivate.ok) available.add("slackPrivate");
  if (slackChannelB.ok) available.add("slackChannelB");
  if (slack.ok && slackMpim.ok) available.add("slackMpim");
  if (slackCapFixture.ok) available.add("slackCapFixture");
  if (slack.ok && slackHalt.ok) available.add("slackHalt");
  if (controlWrite.ok) available.add("controlWrite");
  if (slackSupervisor.ok) available.add("slackSupervisor");
  if (syntheticDm.ok) available.add("syntheticDm");
  if (slackUser2.ok) available.add("slackUser2");
  if (slackSecondary.ok) available.add("slackSecondary");
  if (webhook.ok) available.add("webhook");
  if (notion.ok) available.add("notion");
  if (github.ok) available.add("github");
  if (linear.ok) available.add("linear");
  if (notionAmbient.ok) available.add("notionAmbient");
  if (slackUnified.ok) available.add("slackUnified");
  if (pr.ok) available.add("pr");
  if (connectorWrite.ok) available.add("connectorWrite");
  if (soakSlack.ok) available.add("soakSlack");
  if (soakNotion.ok) available.add("soakNotion");
  if (soakLinear.ok) available.add("soakLinear");
  if (engagedSlack.ok) available.add("engagedSlack");
  if (engagedDiscord.ok) available.add("engagedDiscord");
  if (engagedTeams.ok) available.add("engagedTeams");
  if (github.ok && engagedGithub.ok) available.add("engagedGithub");
  if (linear.ok && engagedLinear.ok) available.add("engagedLinear");
  if (engagedNotion.ok) available.add("engagedNotion");
  return {
    available,
    missing: {
      slack: slack.ok ? [] : slack.missing,
      discord: discord.ok ? [] : discord.missing,
      teams: teams.ok ? [] : teams.missing,
      synthetic: synthetic.ok ? [] : synthetic.missing,
      slackPrivate: slackPrivate.ok ? [] : slackPrivate.missing,
      slackChannelB: slackChannelB.ok ? [] : slackChannelB.missing,
      slackMpim: slackMpim.ok ? [] : slackMpim.missing,
      slackCapFixture: slackCapFixture.ok ? [] : slackCapFixture.missing,
      slackHalt: slackHalt.ok ? [] : slackHalt.missing,
      controlWrite: controlWrite.ok ? [] : controlWrite.missing,
      slackSupervisor: slackSupervisor.ok ? [] : slackSupervisor.missing,
      syntheticDm: syntheticDm.ok ? [] : syntheticDm.missing,
      slackUser2: slackUser2.ok ? [] : slackUser2.missing,
      slackSecondary: slackSecondary.ok ? [] : slackSecondary.missing,
      webhook: webhook.ok ? [] : webhook.missing,
      notion: notion.ok ? [] : notion.missing,
      github: github.ok ? [] : github.missing,
      linear: linear.ok ? [] : linear.missing,
      notionAmbient: notionAmbient.ok ? [] : notionAmbient.missing,
      slackUnified: slackUnified.ok ? [] : slackUnified.missing,
      pr: pr.ok ? [] : pr.missing,
      connectorWrite: connectorWrite.ok ? [] : connectorWrite.missing,
      soakSlack: soakSlack.ok ? [] : soakSlack.missing,
      soakNotion: soakNotion.ok ? [] : soakNotion.missing,
      soakLinear: soakLinear.ok ? [] : soakLinear.missing,
      engagedSlack: engagedSlack.ok ? [] : engagedSlack.missing,
      engagedDiscord: engagedDiscord.ok ? [] : engagedDiscord.missing,
      engagedTeams: engagedTeams.ok ? [] : engagedTeams.missing,
      engagedGithub: engagedGithub.ok ? [] : engagedGithub.missing,
      engagedLinear: engagedLinear.ok ? [] : engagedLinear.missing,
      engagedNotion: engagedNotion.ok ? [] : engagedNotion.missing,
    },
  };
}
