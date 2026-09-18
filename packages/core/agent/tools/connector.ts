import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { resolveRole } from "../access/roles.js";
import { resolvePartition } from "../memory/partition.js";
import { getConfig } from "../access/config.js";
import { appendAudit } from "../audit/audit.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { resolveReplyTarget, postReply, type ReplyAudit } from "../channels/reply-post.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { resolveConnectorOptions, optionLabel, hostWriteHomeAvailable, offerableCredential, type ConnectMode, type ConnectorOption } from "../connections/connector-offer.js";
import { registeredCredentialHomes } from "../credentials/home.js";
import { buildConnectCard, renderNonSlackConnect } from "../connections/connector-card.js";
import { deriveCredentialRef } from "../credentials/ref.js";
import { intakePageAvailable, issueIntakePageLink } from "../credentials/intake-page.js";

function connectModeOf(mode: string): ConnectMode {
  return mode === "dm" ? "dm" : "channel";
}

const connectorEntry = defineTool({
  description:
    "Post connect options for a connector so a human can authorize it. Call with a connector name when " +
    "someone wants to connect/authorize an integration (e.g. \"connect Notion\", \"set the API key\"), or " +
    "with NO connector to list what can be connected here. This posts buttons/links — it does NOT store " +
    "any secret or grant anything itself; a human completes the connect, and personal OAuth only works " +
    "in a DM while org-level setup is admin-only (options a requester can't use are simply not shown). " +
    "NEVER invite anyone to paste a secret/API key into chat — secrets travel only through the posted " +
    "intake UI or an operator, and a pasted key is compromised. " +
    "If the person says they have ALREADY completed a sign-in/authorization, do NOT call this — retry " +
    "the actual operation instead (the connector's own tools / connection_search); grants land server-side, " +
    "so only a fresh attempt can see them, and re-posting connect options reads as a runaround. " +
    "The posted card/message IS the reply — do not add a URL, a summary, or confirmation text after this call.",
  inputSchema: z.object({
    connector: z
      .string()
      .min(1)
      .optional()
      .describe("The connector to connect (as listed by calling with no connector). Omit to list connectable connectors here."),
  }),
  outputSchema: z.object({
    action: z.enum(["posted", "listed", "none"]),
    connector: z.string().optional(),
    options: z.array(z.string()),
    note: z.string(),
  }),
  async execute(input, ctx) {
    const binding = bindFrom(ctx as BindableContext);
    const platform = binding.platform;
    const mode = connectModeOf(binding.mode);
    const role = resolveRole(ctx as BindableContext);
    const isAdmin = role.unverified === undefined && role.isDomainAdmin;
    const isOrgAdmin = role.unverified === undefined && role.isOrgAdmin;
    const unverifiedNote =
      role.unverified === undefined
        ? ""
        : " (Org-level options are withheld on this turn because the caller could not be verified, not because you lack standing —" +
          " ask again on its own and they are offered normally.)";
    const hostWriteBroker = hostWriteHomeAvailable(registeredCredentialHomes());
    const pageArmed = intakePageAvailable();
    const catalogues = getConfig().loadConnectorCredentials?.() ?? [];

    if (!input.connector) {
      if (catalogues.length === 0) {
        return { action: "none" as const, options: [], note: "No connectors are configured on this deployment." };
      }
      const lines = catalogues.map((p) => {
        const labels = resolveConnectorOptions({ catalogue: p, platform, mode, isAdmin, isOrgAdmin, hostWriteBroker, intakePageAvailable: pageArmed })
          .filter((o) => o.route.kind !== "unavailable")
          .map(optionLabel);
        return `- ${p.connector}: ${labels.length ? labels.join(", ") : "nothing offerable here"}`;
      });
      return {
        action: "listed" as const,
        options: catalogues.map((p) => p.connector),
        note: `Connectable connectors here:\n${lines.join("\n")}\nCall connector with a connector name to post its options.${unverifiedNote}`,
      };
    }

    const catalogue = catalogues.find((p) => p.connector === input.connector);
    if (!catalogue) {
      throw new Error(
        `no connector "${input.connector}" is configured — known connectors: ${catalogues.map((p) => p.connector).join(", ") || "none"}.`,
      );
    }

    const options = resolveConnectorOptions({ catalogue, platform, mode, isAdmin, isOrgAdmin, hostWriteBroker, intakePageAvailable: pageArmed }).filter(
      (o) => o.route.kind !== "unavailable",
    );
    const labels = options.map(optionLabel);
    if (options.length === 0) {
      return {
        action: "none" as const,
        connector: catalogue.connector,
        options: [],
        note: `No connect options are offerable for ${catalogue.connector} here — personal OAuth is DM-only, and org-level setup (service OAuth / API key) is admin-only.${unverifiedNote}`,
      };
    }

    const partition = resolvePartition(ctx as BindableContext);
    const cardAudit = () =>
      appendAudit({
        org: partition.org,
        platform: partition.platform,
        workspace: partition.workspace,
        surface: partition.surface,
        ...(binding.principalId ? { principalId: binding.principalId } : {}),
        action: "connector.card_posted",
        detail: { connector: catalogue.connector, options: labels },
      });

    if (platform === "slack") {
      const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
      if (!channelId) {
        throw new Error("connector couldn't resolve this Slack channel's id — try again from a real channel or DM.");
      }
      const { blocks, text } = buildConnectCard(catalogue.connector, options, binding.org);
      const body = new URLSearchParams();
      body.set("channel", channelId);
      if (binding.threadTs) body.set("thread_ts", binding.threadTs);
      body.set("text", text);
      body.set("blocks", JSON.stringify(blocks));
      const res = await bridgeSlackForm("chat.postMessage", body.toString());
      if (res?.ok !== true) {
        throw new Error("connector couldn't post the connect card to Slack (check the bot token / scopes).");
      }
      await cardAudit();
      return {
        action: "posted" as const,
        connector: catalogue.connector,
        options: labels,
        note: `posted connect options for ${catalogue.connector}: ${labels.join(", ")}`,
      };
    }

    const target = resolveReplyTarget(ctx as BindableContext);
    if (!target) {
      throw new Error("connector couldn't resolve this conversation to post the connect links — ask me from a direct channel or DM.");
    }
    const issuePageLink = async (o: ConnectorOption): Promise<string | undefined> => {
      if (!binding.principalId) return undefined;
      const cred = offerableCredential(catalogue, o.credentialType);
      if (!cred) return undefined;
      const ref = deriveCredentialRef({ connector: catalogue.connector, credentialId: cred.id });
      if (!ref) return undefined;
      const link = await issueIntakePageLink({
        org: binding.org,
        connector: catalogue.connector,
        ...(partition.workspace ? { teamId: partition.workspace } : {}),
        platform,
        ref,
        requestedBy: binding.principalId,
        channelId: partition.surface,
      });
      return link?.url;
    };
    const { text, issued } = await renderNonSlackConnect(
      catalogue.connector,
      options,
      { mode, principalId: binding.principalId, org: binding.org, platform: binding.platform },
      undefined,
      issuePageLink,
    );
    const audit: ReplyAudit = {
      org: partition.org,
      platform: partition.platform,
      workspace: partition.workspace,
      surface: partition.surface,
      ...(binding.principalId ? { principalId: binding.principalId } : {}),
      route: "tool",
    };
    await postReply(target, text, audit);
    await cardAudit();
    for (const o of issued) {
      await appendAudit({
        org: partition.org,
        platform: partition.platform,
        workspace: partition.workspace,
        surface: partition.surface,
        ...(binding.principalId ? { principalId: binding.principalId } : {}),
        action: "connector.oauth_url_issued",
        detail: { connector: catalogue.connector, subject: o.principal },
      });
    }
    return {
      action: "posted" as const,
      connector: catalogue.connector,
      options: labels,
      note: `posted connect options for ${catalogue.connector}: ${labels.join(", ")}`,
    };
  },
});
preRegisterDynamicEntry("connector", "_single", connectorEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, _ctx) => connectorEntry,
  },
});
