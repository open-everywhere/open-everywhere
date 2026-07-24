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
import { executorHomeOf } from "../access/providers.js";
import { deriveCredentialRef } from "../credentials/ref.js";
import { intakePageAvailable, issueIntakePageLink } from "../credentials/intake-page.js";

function connectModeOf(mode: string): ConnectMode {
  return mode === "dm" ? "dm" : "channel";
}

const connectorEntry = defineTool({
  description:
    "Post connect options for a provider so a human can authorize it. Call with a provider name when " +
    "someone wants to connect/authorize an integration (e.g. \"connect Notion\", \"set the API key\"), or " +
    "with NO provider to list what can be connected here. This posts buttons/links — it does NOT store " +
    "any secret or grant anything itself; a human completes the connect, and personal OAuth only works " +
    "in a DM while org-level setup is admin-only (options a requester can't use are simply not shown). " +
    "NEVER invite anyone to paste a secret/API key into chat — secrets travel only through the posted " +
    "intake UI or an operator, and a pasted key is compromised. " +
    "If the person says they have ALREADY completed a sign-in/authorization, do NOT call this — retry " +
    "the actual operation instead (the provider's own tools / connection_search); grants land server-side, " +
    "so only a fresh attempt can see them, and re-posting connect options reads as a runaround. " +
    "The posted card/message IS the reply — do not add a URL, a summary, or confirmation text after this call.",
  inputSchema: z.object({
    provider: z
      .string()
      .min(1)
      .optional()
      .describe("The provider to connect (as listed by calling with no provider). Omit to list connectable providers here."),
  }),
  outputSchema: z.object({
    action: z.enum(["posted", "listed", "none"]),
    provider: z.string().optional(),
    options: z.array(z.string()),
    note: z.string(),
  }),
  async execute(input, ctx) {
    const binding = bindFrom(ctx as BindableContext);
    const platform = binding.platform;
    const mode = connectModeOf(binding.mode);
    const isAdmin = resolveRole(ctx as BindableContext).isDomainAdmin;
    const hostWriteBroker = hostWriteHomeAvailable(registeredCredentialHomes());
    const pageArmed = intakePageAvailable();
    const providers = getConfig().loadProviders?.() ?? [];

    if (!input.provider) {
      if (providers.length === 0) {
        return { action: "none" as const, options: [], note: "No providers are configured on this deployment." };
      }
      const lines = providers.map((p) => {
        const labels = resolveConnectorOptions({ provider: p, platform, mode, isAdmin, hostWriteBroker, intakePageAvailable: pageArmed })
          .filter((o) => o.route.kind !== "unavailable")
          .map(optionLabel);
        return `- ${p.name}: ${labels.length ? labels.join(", ") : "nothing offerable here"}`;
      });
      return {
        action: "listed" as const,
        options: providers.map((p) => p.name),
        note: `Connectable providers here:\n${lines.join("\n")}\nCall connector with a provider name to post its options.`,
      };
    }

    const provider = providers.find((p) => p.name === input.provider);
    if (!provider) {
      throw new Error(
        `no provider "${input.provider}" is configured — known providers: ${providers.map((p) => p.name).join(", ") || "none"}.`,
      );
    }

    const options = resolveConnectorOptions({ provider, platform, mode, isAdmin, hostWriteBroker, intakePageAvailable: pageArmed }).filter(
      (o) => o.route.kind !== "unavailable",
    );
    const labels = options.map(optionLabel);
    if (options.length === 0) {
      return {
        action: "none" as const,
        provider: provider.name,
        options: [],
        note: `No connect options are offerable for ${provider.name} here — personal OAuth is DM-only, and org-level setup (service OAuth / API key) is admin-only.`,
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
        detail: { provider: provider.name, options: labels },
      });

    if (platform === "slack") {
      const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
      if (!channelId) {
        throw new Error("connector couldn't resolve this Slack channel's id — try again from a real channel or DM.");
      }
      const { blocks, text } = buildConnectCard(provider.name, options, binding.org);
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
        provider: provider.name,
        options: labels,
        note: `posted connect options for ${provider.name}: ${labels.join(", ")}`,
      };
    }

    const target = resolveReplyTarget(ctx as BindableContext);
    if (!target) {
      throw new Error("connector couldn't resolve this conversation to post the connect links — ask me from a direct channel or DM.");
    }
    const issuePageLink = async (o: ConnectorOption): Promise<string | undefined> => {
      if (!binding.principalId) return undefined;
      const cred = offerableCredential(provider, o.credentialType);
      if (!cred) return undefined;
      const execHome = executorHomeOf(cred);
      const ref = deriveCredentialRef({ provider: provider.name, credentialId: cred.id, ...(execHome ? { executor: execHome } : {}) });
      if (!ref) return undefined;
      const link = await issueIntakePageLink({
        org: binding.org,
        provider: provider.name,
        ...(partition.workspace ? { teamId: partition.workspace } : {}),
        platform,
        ref,
        requestedBy: binding.principalId,
        channelId: partition.surface,
      });
      return link?.url;
    };
    const { text, issued } = await renderNonSlackConnect(provider.name, options, { mode, principalId: binding.principalId }, undefined, issuePageLink);
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
        detail: { provider: provider.name, subject: o.principal },
      });
    }
    return {
      action: "posted" as const,
      provider: provider.name,
      options: labels,
      note: `posted connect options for ${provider.name}: ${labels.join(", ")}`,
    };
  },
});
preRegisterDynamicEntry("connector", "_single", connectorEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, _ctx) => connectorEntry,
  },
});
