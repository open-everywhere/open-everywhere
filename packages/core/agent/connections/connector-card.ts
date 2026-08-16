import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { roleForBinding } from "../access/roles.js";
import { deploymentOrg, type SurfaceBinding } from "../identity/binding.js";
import { rawVaultSubject } from "../identity/oauth-vault-share.js";
import type { Domain } from "../memory/domain.js";
import type { ConnectorCredentials, ConnectorCredentialType } from "../access/connector-credentials.js";
import { vercelConnectorOf } from "../access/connector-credentials.js";
import {
  AUTH_URL_TTL_MS,
  defaultConnectorAuthStarter,
  type ConnectorAuthorizationStarter,
} from "./connector-auth.js";
import { requestCredentialIntake, type CredentialIntakeDeps } from "../credentials/intake.js";
import { deriveCredentialRef } from "../credentials/ref.js";
import { offerableCredential, optionLabel, type ConnectMode, type ConnectorOption } from "./connector-offer.js";

type PostFn = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

export const OE_CONNECT_ACTION_PREFIX = "oe_connect:";

function buttonText(o: ConnectorOption): string {
  if (o.credentialType === "user-oauth") return "Connect my account";
  if (o.credentialType === "service-oauth") return "Connect org account";
  return "Set API key";
}

export function buildConnectCard(
  connectorName: string,
  options: readonly ConnectorOption[],
  org: string,
): { blocks: unknown[]; text: string } {
  const header = {
    type: "section",
    text: { type: "mrkdwn", text: `🔌 Connect *${connectorName}* — choose how to authorize:` },
  };
  const buttons = options
    .filter((o) => o.route.kind === "modal" || o.route.kind === "url")
    .map((o) => ({
      type: "button",
      action_id: `${OE_CONNECT_ACTION_PREFIX}${connectorName}:${o.credentialType}`,
      value: org,
      ...(o.credentialType === "user-oauth" ? { style: "primary" } : {}),
      text: { type: "plain_text", text: buttonText(o) },
    }));
  const degraded = options.filter((o) => o.route.kind === "text-degrade");
  const blocks: unknown[] = [header];
  if (buttons.length > 0) blocks.push({ type: "actions", elements: buttons });
  for (const o of degraded) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `*${optionLabel(o)}*: ${o.route.reason ?? "not available on this surface."}` }],
    });
  }
  return { blocks, text: `Connect ${connectorName} — choose how to authorize.` };
}

async function mintOAuthUrl(
  startAuth: ConnectorAuthorizationStarter,
  vercelConnector: string,
  subject: { readonly type: "user"; readonly id: string } | { readonly type: "app" },
): Promise<string> {
  return (await startAuth(vercelConnector, { subject }, { expiresInMs: AUTH_URL_TTL_MS })).url;
}

export async function renderNonSlackConnect(
  connectorName: string,
  options: readonly ConnectorOption[],
  ctx: { readonly mode: ConnectMode; readonly principalId?: string; readonly org: string; readonly platform: string; readonly workspace?: string },
  startAuth: ConnectorAuthorizationStarter = defaultConnectorAuthStarter,
  issuePageLink?: (o: ConnectorOption) => Promise<string | undefined>,
): Promise<{ text: string; issued: ConnectorOption[] }> {
  const lines: string[] = [`Connect *${connectorName}*:`];
  const issued: ConnectorOption[] = [];
  for (const o of options) {
    if (o.credentialType === "service-oauth") {
      lines.push(
        o.dashboardUrl
          ? `• *${optionLabel(o)}* — a Vercel team member authorizes the org account on the dashboard: ${o.dashboardUrl}`
          : `• *${optionLabel(o)}* — an operator authorizes the org account on the vendor's admin dashboard.`,
      );
      continue;
    }
    if (o.route.kind === "page") {
      const url = issuePageLink ? await issuePageLink(o) : undefined;
      lines.push(
        url
          ? `• *${optionLabel(o)}* — open this one-time secure page to enter the key (expires soon; it works once): ${url}`
          : `• *${optionLabel(o)}* — secure key entry isn't available on this deployment right now; ask an operator to set it via the Vercel dashboard/CLI.`,
      );
      continue;
    }
    if (o.route.kind === "url" && o.vercelConnector && o.credentialType === "user-oauth") {
      if (!(ctx.mode === "dm" && ctx.principalId)) continue;
      try {
        const url = await mintOAuthUrl(startAuth, o.vercelConnector, {
          type: "user",
          id: rawVaultSubject(ctx.org, ctx.platform, ctx.workspace, ctx.principalId),
        });
        lines.push(`• *${optionLabel(o)}* — connect your personal account (expires soon): ${url}`);
        issued.push(o);
      } catch {
        lines.push(`• *${optionLabel(o)}* — couldn't start the connect flow (the connector isn't fully provisioned; ask an operator).`);
      }
    } else {
      lines.push(`• *${optionLabel(o)}* — ${o.route.reason ?? "not available on this surface."}`);
    }
  }
  return { text: lines.join("\n"), issued };
}

interface ConnectClickPayload {
  readonly actions?: readonly { readonly action_id?: unknown; readonly value?: unknown }[];
  readonly user?: { readonly id?: unknown };
  readonly team?: { readonly id?: unknown };
  readonly channel?: { readonly id?: unknown };
}

export interface ConnectorCardDeps {
  readonly post?: PostFn;
  readonly startAuth?: ConnectorAuthorizationStarter;
  readonly requestIntake?: (input: Parameters<typeof requestCredentialIntake>[0], deps?: CredentialIntakeDeps) => Promise<{ id: string }>;
  readonly loadConnectorCredentials?: () => readonly ConnectorCredentials[];
  readonly loadDomains?: () => readonly Domain[];
  readonly now?: () => Date;
}

async function ephemeral(post: PostFn, channelId: string, userId: string, text: string): Promise<void> {
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("user", userId);
  body.set("text", text);
  await post("chat.postEphemeral", body.toString());
}

function connectWhere(org: string, teamId: string | undefined, channelId: string): { org: string; platform: string; workspace: string; surface: string } {
  return { org, platform: "slack", workspace: teamId || "unknown", surface: channelId };
}

function slackIdPrefixMode(channelId: string | undefined): "dm" | "channel" {
  return channelId?.startsWith("D") ? "dm" : "channel";
}

function clickerRole(org: string, teamId: string | undefined, channelId: string, clickerId: string, domains: readonly Domain[]): { isAdmin: boolean; domain?: string } {
  const binding: SurfaceBinding = {
    org,
    platform: "slack",
    workspace: teamId ?? "unknown",
    surface: channelId,
    mode: slackIdPrefixMode(channelId),
    visibility: "private",
    trust: "internal",
    principalId: clickerId,
  };
  const role = roleForBinding(binding, domains);
  return { isAdmin: role.isDomainAdmin, ...(role.domain ? { domain: role.domain } : {}) };
}

export async function handleConnectClick(payload: unknown, deps: ConnectorCardDeps = {}): Promise<boolean> {
  const p = payload as ConnectClickPayload | null | undefined;
  const action = p?.actions?.[0];
  const actionId = typeof action?.action_id === "string" ? action.action_id : undefined;
  if (actionId === undefined || !actionId.startsWith(OE_CONNECT_ACTION_PREFIX)) return false;

  const post = deps.post ?? bridgeSlackForm;
  try {
    const rest = actionId.slice(OE_CONNECT_ACTION_PREFIX.length);
    const sep = rest.lastIndexOf(":");
    const connectorName = sep > 0 ? rest.slice(0, sep) : undefined;
    const type = (sep > 0 ? rest.slice(sep + 1) : undefined) as ConnectorCredentialType | undefined;
    const org = typeof action?.value === "string" ? action.value : undefined;
    const clickerId = typeof p?.user?.id === "string" ? p.user.id : undefined;
    const channelId = typeof p?.channel?.id === "string" ? p.channel.id : undefined;
    const teamId = typeof p?.team?.id === "string" ? p.team.id : undefined;

    if (!connectorName || !type || !org || !clickerId || !channelId) {
      console.error(`[open-everywhere:connector] malformed oe_connect click "${actionId}" — missing connector/type/org/user/channel; ignoring`);
      return true;
    }

    const catalogues = deps.loadConnectorCredentials ? deps.loadConnectorCredentials() : (getConfig().loadConnectorCredentials?.() ?? []);
    const catalogue = catalogues.find((c) => c.connector === connectorName);
    const cred = catalogue ? offerableCredential(catalogue, type) : undefined;
    if (!catalogue || !cred) {
      await ephemeral(post, channelId, clickerId, "This connect option is no longer available.");
      return true;
    }

    const domains = deps.loadDomains ? deps.loadDomains() : getConfig().loadDomains();
    const startAuth = deps.startAuth ?? defaultConnectorAuthStarter;

    if (type === "user-oauth") {
      if (slackIdPrefixMode(channelId) !== "dm") {
        await ephemeral(post, channelId, clickerId, "Connecting your *personal* account only works in a DM with me — message me directly and try again.");
        return true;
      }
      const userConnector = vercelConnectorOf(cred);
      if (!userConnector) {
        await ephemeral(post, channelId, clickerId, "This connector isn't configured for personal OAuth (no OAuth connector id). Ask an operator.");
        return true;
      }
      return await mintAndDeliverOAuth(post, startAuth, {
        org, teamId, channelId, clickerId, connectorName, vercelConnector: userConnector,
        subject: { type: "user", id: rawVaultSubject(deploymentOrg(), "slack", teamId, clickerId) }, subjectLabel: "user",
      });
    }

    if (type === "service-oauth") {
      if (!clickerRole(org, teamId, channelId, clickerId, domains).isAdmin) {
        await ephemeral(post, channelId, clickerId, "Connecting the *org* account is admin-only — your id isn't listed as an admin for this workspace/domain.");
        return true;
      }
      const dash = cred.dashboardUrl;
      await ephemeral(
        post,
        channelId,
        clickerId,
        dash
          ? `Connecting the *org* ${connectorName} account is completed on the Vercel dashboard (needs a Vercel team member): ${dash} — authorize there, then ask me again.`
          : `Connecting the *org* ${connectorName} account is done by an operator on the vendor's admin dashboard — no self-serve link is configured for it here.`,
      );
      await appendAudit({
        ...connectWhere(org, teamId, channelId),
        principalId: clickerId,
        action: "connector.dashboard_link_issued",
        detail: { connector: connectorName, configured: Boolean(dash) },
      });
      return true;
    }

    if (type === "api-key") {
      const role = clickerRole(org, teamId, channelId, clickerId, domains);
      if (!role.isAdmin) {
        await ephemeral(post, channelId, clickerId, "Setting an *org* API key is admin-only — your id isn't listed as an admin for this workspace/domain.");
        return true;
      }
      if (!cred.secretRef) {
        await ephemeral(post, channelId, clickerId, "This connector's API-key credential has no configured storage ref. Ask an operator.");
        return true;
      }
      const requestIntake = deps.requestIntake ?? requestCredentialIntake;
      const ref = deriveCredentialRef({
        connector: connectorName,
        credentialId: cred.id,
      });
      if (!ref) {
        await ephemeral(post, channelId, clickerId, "This connector's API-key credential has no resolvable storage home. Ask an operator.");
        return true;
      }
      await requestIntake({
        org,
        connector: connectorName,
        ...(role.domain ? { domain: role.domain } : {}),
        ref,
        requestedBy: clickerId,
        channelId,
        ...(teamId ? { teamId } : {}),
      });
      return true;
    }

    console.error(`[open-everywhere:connector] oe_connect click with unrecognised type "${String(type)}" — ignoring`);
    return true;
  } catch (err) {
    console.error(`[open-everywhere:connector] handleConnectClick failed softly for "${actionId}": ${String(err)}`);
    return true;
  }
}

async function mintAndDeliverOAuth(
  post: PostFn,
  startAuth: ConnectorAuthorizationStarter,
  ctx: {
    readonly org: string;
    readonly teamId?: string;
    readonly channelId: string;
    readonly clickerId: string;
    readonly connectorName: string;
    readonly vercelConnector: string;
    readonly subject: { readonly type: "user"; readonly id: string } | { readonly type: "app" };
    readonly subjectLabel: "user" | "app";
  },
): Promise<boolean> {
  let url: string | undefined;
  try {
    url = (await startAuth(ctx.vercelConnector, { subject: ctx.subject }, { expiresInMs: AUTH_URL_TTL_MS })).url;
  } catch (err) {
    console.error(`[open-everywhere:connector] oauth mint failed for ${ctx.connectorName} (${ctx.subjectLabel}): ${String(err)}`);
    await ephemeral(post, ctx.channelId, ctx.clickerId, "Couldn't start the connect flow just now — the connector isn't fully provisioned on this deployment. Ask an operator.");
    return true;
  }
  const who = ctx.subjectLabel === "user" ? "your personal" : "the org service";
  await ephemeral(
    post,
    ctx.channelId,
    ctx.clickerId,
    `Open this link to connect ${who} *${ctx.connectorName}* account (expires soon): ${url}`,
  );
  await appendAudit({
    ...connectWhere(ctx.org, ctx.teamId, ctx.channelId),
    principalId: ctx.clickerId,
    action: "connector.oauth_url_issued",
    detail: { connector: ctx.connectorName, subject: ctx.subjectLabel },
  });
  return true;
}
