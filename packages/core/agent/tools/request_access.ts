import { randomUUID } from "node:crypto";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, channelPlatform, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { buildResolveRequest, principalIdOf, resolveAccessFor } from "../access/request.js";
import { getConfig } from "../access/config.js";
import { planAccessDelta, grantSentence, HTTP_METHODS, type AccessDelta, type PlanContext } from "../access/delta.js";
import { resolveSkillDomain } from "../skills/domain-skills.js";
import { slackForm } from "../channels/slack-events.js";
import { requestApproval } from "../approvals/flow.js";

export interface RequestAccessArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly requestId: string;
  readonly delta: AccessDelta;
  readonly requestedBy: string;
  readonly reason?: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly permalink?: string;
  readonly configRepo: string;
}

export interface RequestAccessInput {
  readonly kind: string;
  readonly connection?: string;
  readonly add_methods?: readonly string[];
  readonly add_path_prefixes?: readonly string[];
  readonly connector?: string;
  readonly reason?: string;
}

export function planRequestAccess(
  binding: SurfaceBinding,
  planCtx: PlanContext,
  input: RequestAccessInput,
  extras: { scopeKey: string; channelId: string; configRepo: string; permalink?: string },
): RequestAccessArgs {
  if (binding.platform !== "slack") {
    throw new Error(`request_access is Slack-only for now (this surface is "${binding.platform}") — the request card renders as a Slack message.`);
  }
  if (binding.mode !== "channel") {
    throw new Error(
      "access requests come from the channel that needs the access (grants bind to a channel scope) — ask again from that channel, not a DM.",
    );
  }
  if (binding.trust === "external") {
    throw new Error("this channel is externally shared — access can't be widened from an external surface; an internal admin can PR a grant by hand.");
  }
  if (!binding.principalId) {
    throw new Error("request_access needs a verified sender on this turn — no principal id resolved, so there's no requester to show on the card.");
  }

  const delta = planAccessDelta(
    {
      kind: input.kind,
      connection: input.connection,
      addMethods: input.add_methods,
      addPathPrefixes: input.add_path_prefixes,
      connector: input.connector,
    },
    planCtx,
  );

  return {
    org: binding.org,
    scopeKey: extras.scopeKey,
    requestId: randomUUID(),
    delta,
    requestedBy: binding.principalId,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    channelId: extras.channelId,
    threadTs: binding.threadTs ?? null,
    ...(extras.permalink ? { permalink: extras.permalink } : {}),
    configRepo: extras.configRepo,
  };
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (channelPlatform(ctx as BindableContext) !== "slack") return null;
      return defineTool({
        description:
          "PROPOSE widening THIS channel's access — this grants nothing itself. Use when someone asks for access the channel doesn't have. Exactly two request shapes exist: kind=widen-connection (add HTTP methods and/or path prefixes to a connection ALREADY available in this channel) and kind=grant-connector (enable a connector this deployment already defines but this channel doesn't have). Anything else — a new website/host, a new credential or API key, a new repo, a brand-new integration — is NOT requestable this way: refuse and say an admin needs to PR it by hand. On success a \"Request access\" card is posted in this thread; any member's tap sends the request as a bot-PR that an admin merges in GitHub — nothing changes until that merge. The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call.",
        inputSchema: z.object({
          kind: z.enum(["widen-connection", "grant-connector"]).describe("Which of the two request shapes this ask maps to."),
          connection: z.string().optional().describe("widen-connection: the id of the existing connection to widen (as listed in this channel's access)."),
          add_methods: z.array(z.enum(HTTP_METHODS as [string, ...string[]])).optional().describe("widen-connection: HTTP methods to add."),
          add_path_prefixes: z.array(z.string()).optional().describe('widen-connection: path prefixes to add (each starts with "/").'),
          connector: z.string().optional().describe("grant-connector: the connector name to enable for this channel."),
          reason: z.string().optional().describe("Why the channel needs this — shown on the card and in the PR."),
        }),
        outputSchema: z.object({
          requested: z.boolean(),
          pendingId: z.string(),
          expiresAt: z.string(),
          note: z.string(),
        }),
        async execute(input, ctx) {
          const binding = bindFrom(ctx);
          const partition = resolvePartition(ctx);
          const domain = resolveSkillDomain(ctx) ?? null;

          const cfg = getConfig();
          const ar = cfg.loadAccessRequests?.();
          if (!ar?.adminChannel || !ar?.configRepo) {
            throw new Error(
              "access requests aren't enabled on this deployment (no admin channel / config repo configured — " +
                "OE_ACCESS_ADMIN_CHANNEL + OE_ACCESS_CONFIG_REPO). An admin can PR the grant by hand instead.",
            );
          }

          const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
          if (!channelId) {
            throw new Error("request_access couldn't resolve this Slack channel's id — try again from a real channel, not a synthetic context.");
          }

          const req = buildResolveRequest(ctx);
          const planCtx: PlanContext = {
            scope: { workspace: req.workspace, channel: req.channel },
            access: resolveAccessFor(ctx),
            bundles: cfg.loadBundles(),
          };

          let permalink: string | undefined;
          if (binding.threadTs) {
            const q = new URLSearchParams();
            q.set("channel", channelId);
            q.set("message_ts", binding.threadTs);
            const res = await slackForm("chat.getPermalink", q.toString());
            permalink = res?.ok === true && typeof res.permalink === "string" ? res.permalink : undefined;
          }

          const args = planRequestAccess(binding, planCtx, input, {
            scopeKey: partition.surfaceKey,
            channelId,
            configRepo: ar.configRepo,
            permalink,
          });

          const posted = await requestApproval({
            org: args.org,
            kind: "access.request",
            args,
            scopeKey: args.scopeKey,
            domain,
            requestedBy: args.requestedBy,
            channelId,
            threadTs: binding.threadTs ?? null,
          });

          return {
            requested: true,
            pendingId: posted.id,
            expiresAt: posted.expiresAt,
            note: `card posted — ${grantSentence(args.delta)} (pending ${posted.id}).`,
          };
        },
      });
    },
  },
});
