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
  org: "E2E_ORG",
  targetUrl: "E2E_TARGET_URL",
  slackSigningSecret: "SLACK_SIGNING_SECRET",
  includeOptional: "E2E_INCLUDE_OPTIONAL",
} as const;

export type Capability = "slack" | "discord" | "synthetic" | "slackPrivate" | "slackChannelB" | "syntheticDm";

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

export interface SyntheticDmConfig {
  readonly targetUrl: string;
  readonly signingSecret: string;
  readonly dmChannel: string;
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

export function resolveSyntheticDm(env: Env = process.env): Resolved<SyntheticDmConfig> {
  const { values, missing } = need(env, [ENV.targetUrl, ENV.slackSigningSecret, ENV.slackDmChannel]);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cfg: { targetUrl: values[0].replace(/\/+$/, ""), signingSecret: values[1], dmChannel: values[2] } };
}

export interface CapabilityReport {
  readonly available: ReadonlySet<Capability>;
  readonly missing: Readonly<Record<Capability, readonly string[]>>;
  readonly includeOptional: boolean;
}

export function resolveCapabilities(env: Env = process.env): CapabilityReport {
  const slack = resolveSlack(env);
  const discord = resolveDiscord(env);
  const synthetic = resolveSynthetic(env);
  const slackPrivate = resolveSlackPrivate(env);
  const slackChannelB = resolveSlackChannelB(env);
  const syntheticDm = resolveSyntheticDm(env);
  const available = new Set<Capability>();
  if (slack.ok) available.add("slack");
  if (discord.ok) available.add("discord");
  if (synthetic.ok) available.add("synthetic");
  if (slackPrivate.ok) available.add("slackPrivate");
  if (slackChannelB.ok) available.add("slackChannelB");
  if (syntheticDm.ok) available.add("syntheticDm");
  return {
    available,
    missing: {
      slack: slack.ok ? [] : slack.missing,
      discord: discord.ok ? [] : discord.missing,
      synthetic: synthetic.ok ? [] : synthetic.missing,
      slackPrivate: slackPrivate.ok ? [] : slackPrivate.missing,
      slackChannelB: slackChannelB.ok ? [] : slackChannelB.missing,
      syntheticDm: syntheticDm.ok ? [] : syntheticDm.missing,
    },
    includeOptional: env[ENV.includeOptional] === "1",
  };
}
