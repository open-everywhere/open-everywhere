import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { platformName } from "../channels/friendly-ids.js";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { roleForBinding } from "../access/roles.js";
import { deploymentOrg, type SurfaceBinding } from "../identity/binding.js";
import { rawVaultSubject } from "../identity/oauth-vault-share.js";
import type { Domain } from "../memory/domain.js";
import type { ConnectorCredentials, ConnectorCredentialType } from "../access/connector-credentials.js";
import { oauthConnectorOf } from "../access/connector-credentials.js";
import {
  AUTH_URL_TTL_MS,
  defaultConnectorAuthStarter,
  type ConnectorAuthorizationStarter,
} from "./connector-auth.js";
import { requestCredentialIntake, type CredentialIntakeDeps } from "../credentials/intake.js";
import { deriveCredentialRef } from "../credentials/ref.js";
import { offerableCredential, optionLabel, unqualifiedAppRowMintHome, type ConnectMode, type ConnectorOption } from "./connector-offer.js";

type PostFn = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

export const OE_CONNECT_ACTION_PREFIX = "oe_connect:";

export function connectorWords(connectorName: string): string {
  const known = platformName(connectorName);
  return known !== connectorName ? known : connectorName.charAt(0).toUpperCase() + connectorName.slice(1);
}

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
    text: { type: "mrkdwn", text: `🔌 Connect *${connectorWords(connectorName)}*. Pick one:` },
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
      elements: [{ type: "mrkdwn", text: `*${optionLabel(o)}*: ${o.route.reason ?? "not available here."}` }],
    });
  }
  return { blocks, text: `Connect ${connectorWords(connectorName)}.` };
}

async function mintOAuthUrl(
  startAuth: ConnectorAuthorizationStarter,
  oauthConnector: string,
  subject: { readonly type: "user"; readonly id: string } | { readonly type: "app" },
): Promise<string> {
  return (await startAuth(oauthConnector, { subject }, { expiresInMs: AUTH_URL_TTL_MS })).url;
}

export async function renderNonSlackConnect(
  connectorName: string,
  options: readonly ConnectorOption[],
  ctx: { readonly mode: ConnectMode; readonly principalId?: string; readonly org: string; readonly platform: string; readonly workspace?: string },
  startAuth: ConnectorAuthorizationStarter = defaultConnectorAuthStarter,
  issuePageLink?: (o: ConnectorOption) => Promise<string | undefined>,
): Promise<{ text: string; issued: ConnectorOption[] }> {
  const lines: string[] = [`Connect *${connectorWords(connectorName)}*:`];
  const issued: ConnectorOption[] = [];
  for (const o of options) {
    if (o.credentialType === "service-oauth") {
      if (o.dashboardUrl) {
        lines.push(`• *${optionLabel(o)}* — an admin connects your organisation's account here: ${o.dashboardUrl}`);
        continue;
      }
      if (o.route.kind === "url" && o.oauthConnector && ctx.mode === "dm") {
        try {
          const url = await mintOAuthUrl(startAuth, o.oauthConnector, { type: "app" });
          lines.push(`• *${optionLabel(o)}* — connect your organisation's account (this link expires soon): ${url}`);
          issued.push(o);
        } catch {
          lines.push(`• *${optionLabel(o)}* — this isn't set up yet. Ask your admin.`);
        }
        continue;
      }
      if (o.route.kind === "url" && o.oauthConnector) {
        lines.push(`• *${optionLabel(o)}* — send me a direct message and ask again, so the link stays private.`);
        continue;
      }
      lines.push(`• *${optionLabel(o)}* — your admin connects this in ${connectorWords(connectorName)}'s own admin settings.`);
      continue;
    }
    if (o.route.kind === "page") {
      const url = issuePageLink ? await issuePageLink(o) : undefined;
      lines.push(
        url
          ? `• *${optionLabel(o)}* — enter the key on this private page (it works once and expires soon): ${url}`
          : `• *${optionLabel(o)}* — I can't take a key here right now. Ask your admin to add it.`,
      );
      continue;
    }
    if (o.route.kind === "url" && o.oauthConnector && o.credentialType === "user-oauth") {
      if (!(ctx.mode === "dm" && ctx.principalId)) continue;
      try {
        const url = await mintOAuthUrl(startAuth, o.oauthConnector, {
          type: "user",
          id: rawVaultSubject(ctx.org, ctx.platform, ctx.workspace, ctx.principalId),
        });
        lines.push(`• *${optionLabel(o)}* — connect your own account (this link expires soon): ${url}`);
        issued.push(o);
      } catch {
        lines.push(`• *${optionLabel(o)}* — this isn't set up yet. Ask your admin.`);
      }
    } else {
      lines.push(`• *${optionLabel(o)}* — ${o.route.reason ?? "not available here."}`);
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

function clickerRole(
  org: string,
  teamId: string | undefined,
  channelId: string,
  clickerId: string,
  domains: readonly Domain[],
): { isAdmin: boolean; isOrgAdmin: boolean; domain?: string } {
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
  return { isAdmin: role.isDomainAdmin, isOrgAdmin: role.isOrgAdmin, ...(role.domain ? { domain: role.domain } : {}) };
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
      await ephemeral(post, channelId, clickerId, "This option isn't available any more. Ask me again for a fresh one.");
      return true;
    }

    const domains = deps.loadDomains ? deps.loadDomains() : getConfig().loadDomains();
    const startAuth = deps.startAuth ?? defaultConnectorAuthStarter;

    if (type === "user-oauth") {
      if (slackIdPrefixMode(channelId) !== "dm") {
        await ephemeral(post, channelId, clickerId, "To connect your own account, send me a direct message and ask again.");
        return true;
      }
      const userConnector = oauthConnectorOf(cred);
      if (!userConnector) {
        await ephemeral(post, channelId, clickerId, "Connecting your own account isn't set up yet. Ask your admin.");
        return true;
      }
      return await mintAndDeliverOAuth(post, startAuth, {
        org, teamId, channelId, clickerId, connectorName, oauthConnector: userConnector,
        subject: { type: "user", id: rawVaultSubject(deploymentOrg(), "slack", teamId, clickerId) }, subjectLabel: "user",
      });
    }

    if (type === "service-oauth") {
      const orgRole = clickerRole(org, teamId, channelId, clickerId, domains);
      if (!orgRole.isAdmin) {
        await ephemeral(post, channelId, clickerId, "Only an admin can connect your organisation's account. Ask your admin.");
        return true;
      }
      const dash = cred.dashboardUrl;
      const mintHome = unqualifiedAppRowMintHome(type, cred);
      if (mintHome) {
        if (!orgRole.isOrgAdmin) {
          await ephemeral(
            post,
            channelId,
            clickerId,
            "Your organisation's account is shared by every domain, so only an organisation-wide admin can connect it. Ask one of them to click this.",
          );
          return true;
        }
        return await mintAndDeliverOAuth(post, startAuth, {
          org, teamId, channelId, clickerId, connectorName, oauthConnector: mintHome,
          subject: { type: "app" }, subjectLabel: "app",
        });
      }
      await ephemeral(
        post,
        channelId,
        clickerId,
        dash
          ? `An admin connects your organisation's ${connectorWords(connectorName)} account here: ${dash}. Then ask me again.`
          : `Your admin connects your organisation's ${connectorWords(connectorName)} account in ${connectorWords(connectorName)}'s own admin settings.`,
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
        await ephemeral(post, channelId, clickerId, "Only an admin can add a key for your organisation. Ask your admin.");
        return true;
      }
      if (!cred.secretRef) {
        await ephemeral(post, channelId, clickerId, "Adding a key isn't set up yet. Ask your admin.");
        return true;
      }
      const requestIntake = deps.requestIntake ?? requestCredentialIntake;
      const ref = deriveCredentialRef({
        connector: connectorName,
        credentialId: cred.id,
      });
      if (!ref) {
        await ephemeral(post, channelId, clickerId, "Adding a key isn't set up yet. Ask your admin.");
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
    readonly oauthConnector: string;
    readonly subject: { readonly type: "user"; readonly id: string } | { readonly type: "app" };
    readonly subjectLabel: "user" | "app";
  },
): Promise<boolean> {
  let url: string | undefined;
  try {
    url = (await startAuth(ctx.oauthConnector, { subject: ctx.subject }, { expiresInMs: AUTH_URL_TTL_MS })).url;
  } catch (err) {
    console.error(`[open-everywhere:connector] oauth mint failed for ${ctx.connectorName} (${ctx.subjectLabel}): ${String(err)}`);
    await ephemeral(post, ctx.channelId, ctx.clickerId, "I couldn't start connecting just now. This isn't fully set up yet, so ask your admin.");
    return true;
  }
  const who = ctx.subjectLabel === "user" ? "your own" : "your organisation's";
  await ephemeral(
    post,
    ctx.channelId,
    ctx.clickerId,
    `Open this link to connect ${who} *${connectorWords(ctx.connectorName)}* account (it expires soon): ${url}`,
  );
  await appendAudit({
    ...connectWhere(ctx.org, ctx.teamId, ctx.channelId),
    principalId: ctx.clickerId,
    action: "connector.oauth_url_issued",
    detail: { connector: ctx.connectorName, subject: ctx.subjectLabel },
  });
  return true;
}
