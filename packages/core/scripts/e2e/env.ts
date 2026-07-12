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
  slackDmChannel: "E2E_SLACK_DM_CHANNEL",
  slackUser2Id: "E2E_SLACK_USER2_ID",
  org: "E2E_ORG",
  targetUrl: "E2E_TARGET_URL",
  slackSigningSecret: "SLACK_SIGNING_SECRET",
  includeOptional: "E2E_INCLUDE_OPTIONAL",
  webhookSecret: "E2E_WEBHOOK_SECRET",
  webhookHookId: "E2E_WEBHOOK_HOOK_ID",
  slackSupervisorChannel: "E2E_SLACK_SUPERVISOR_CHANNEL",
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

  linearApiKey: "E2E_LINEAR_API_KEY",
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

  slackUnifiedChannelA: "E2E_SLACK_UNIFIED_CHANNEL_A",
  slackUnifiedChannelB: "E2E_SLACK_UNIFIED_CHANNEL_B",
  unifiedDomain: "E2E_UNIFIED_DOMAIN",
} as const;

export type Capability =
  | "slack"
  | "discord"
  | "synthetic"
  | "slackPrivate"
  | "slackChannelB"
  | "syntheticDm"
  | "slackUser2"
  | "webhook"
  | "notion"
  | "slackSupervisor"
  | "teams"
  | "github"
  | "linear"
  | "notionAmbient"
  | "slackUnified";

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
  readonly targetUrl: string;
  readonly signingSecret: string;
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
}

export interface SlackUnifiedConfig {
  readonly channelA: string;
  readonly channelB: string;
  readonly domain: string;
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

export function resolveSynthetic(env: Env = process.env): Resolved<SyntheticConfig> {
  const { values, missing } = need(env, [ENV.targetUrl, ENV.slackSigningSecret, ENV.slackAdminUserId, ENV.slackChannel]);
  if (missing.length > 0) return { ok: false, missing };
  const org = env[ENV.org]?.trim() || "default";
  return { ok: true, cfg: { targetUrl: values[0].replace(/\/+$/, ""), signingSecret: values[1], adminUserId: values[2], channel: values[3], org } };
}

export function resolveSlackPrivate(env: Env = process.env): Resolved<SlackExtraChannelConfig> {
  const { values, missing } = need(env, [ENV.slackPrivateChannel]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { channel: values[0] } };
}

export function resolveSlackChannelB(env: Env = process.env): Resolved<SlackExtraChannelConfig> {
  const { values, missing } = need(env, [ENV.slackChannelB]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { channel: values[0] } };
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

export function resolveSyntheticDm(env: Env = process.env): Resolved<SyntheticDmConfig> {
  const { values, missing } = need(env, [ENV.targetUrl, ENV.slackSigningSecret, ENV.slackDmChannel]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { targetUrl: values[0].replace(/\/+$/, ""), signingSecret: values[1], dmChannel: values[2] } };
}

export function resolveWebhook(env: Env = process.env): Resolved<WebhookConfig> {
  const { values, missing } = need(env, [ENV.targetUrl, ENV.webhookSecret]);
  if (missing.length > 0) return { ok: false, missing };
  const hookId = env[ENV.webhookHookId]?.trim() || "e2e-smoke";
  return { ok: true, cfg: { targetUrl: values[0].replace(/\/+$/, ""), secret: values[1], hookId } };
}

export function resolveNotion(env: Env = process.env): Resolved<NotionConfig> {
  const { values, missing } = need(env, [ENV.notionChannel]);
  if (missing.length > 0) return { ok: false, missing };
  const query = env[ENV.notionQuery]?.trim() || "team handbook";
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
    },
  };
}

export function resolveSlackUnified(env: Env = process.env): Resolved<SlackUnifiedConfig> {
  const { values, missing } = need(env, [ENV.slackUnifiedChannelA, ENV.slackUnifiedChannelB]);
  if (missing.length > 0) return { ok: false, missing };
  const domain = env[ENV.unifiedDomain]?.trim() || "e2e-unified";
  return { ok: true, cfg: { channelA: values[0], channelB: values[1], domain } };
}

export interface CapabilityReport {
  readonly available: ReadonlySet<Capability>;
  readonly missing: Readonly<Record<Capability, readonly string[]>>;
  readonly includeOptional: boolean;
}

export function resolveCapabilities(env: Env = process.env): CapabilityReport {
  const slack = resolveSlack(env);
  const discord = resolveDiscord(env);
  const teams = resolveTeams(env);
  const synthetic = resolveSynthetic(env);
  const slackPrivate = resolveSlackPrivate(env);
  const slackChannelB = resolveSlackChannelB(env);
  const slackSupervisor = resolveSlackSupervisor(env);
  const syntheticDm = resolveSyntheticDm(env);
  const slackUser2 = resolveSlackUser2(env);
  const webhook = resolveWebhook(env);
  const notion = resolveNotion(env);
  const github = resolveGithub(env);
  const linear = resolveLinear(env);
  const notionAmbient = resolveNotionAmbient(env);
  const slackUnified = resolveSlackUnified(env);
  const available = new Set<Capability>();
  if (slack.ok) available.add("slack");
  if (discord.ok) available.add("discord");
  if (teams.ok) available.add("teams");
  if (synthetic.ok) available.add("synthetic");
  if (slackPrivate.ok) available.add("slackPrivate");
  if (slackChannelB.ok) available.add("slackChannelB");
  if (slackSupervisor.ok) available.add("slackSupervisor");
  if (syntheticDm.ok) available.add("syntheticDm");
  if (slackUser2.ok) available.add("slackUser2");
  if (webhook.ok) available.add("webhook");
  if (notion.ok) available.add("notion");
  if (github.ok) available.add("github");
  if (linear.ok) available.add("linear");
  if (notionAmbient.ok) available.add("notionAmbient");
  if (slackUnified.ok) available.add("slackUnified");
  return {
    available,
    missing: {
      slack: slack.ok ? [] : slack.missing,
      discord: discord.ok ? [] : discord.missing,
      teams: teams.ok ? [] : teams.missing,
      synthetic: synthetic.ok ? [] : synthetic.missing,
      slackPrivate: slackPrivate.ok ? [] : slackPrivate.missing,
      slackChannelB: slackChannelB.ok ? [] : slackChannelB.missing,
      slackSupervisor: slackSupervisor.ok ? [] : slackSupervisor.missing,
      syntheticDm: syntheticDm.ok ? [] : syntheticDm.missing,
      slackUser2: slackUser2.ok ? [] : slackUser2.missing,
      webhook: webhook.ok ? [] : webhook.missing,
      notion: notion.ok ? [] : notion.missing,
      github: github.ok ? [] : github.missing,
      linear: linear.ok ? [] : linear.missing,
      notionAmbient: notionAmbient.ok ? [] : notionAmbient.missing,
      slackUnified: slackUnified.ok ? [] : slackUnified.missing,
    },
    includeOptional: env[ENV.includeOptional] === "1",
  };
}
