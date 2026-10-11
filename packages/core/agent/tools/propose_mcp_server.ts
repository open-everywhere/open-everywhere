import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { actingPrincipalIdOf, resolveMode, unattendedOf } from "../access/request.js";
import { bindFrom, currentTurnId, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { delegatedNonMemberWakeThisTurn } from "../identity/delegated-binding.js";
import { parseDbCredentialRef } from "../credentials/ref.js";
import { getConfig } from "../access/config.js";
import { OE_CHAT_NONMEMBER_ATTR } from "../access/taint-signal.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { mcpServerReachLine, requireMcpServerProposeConfig, validateMcpServerProposal } from "../approvals/mcp-server-propose.js";
import type { McpServerDeclaration } from "../connections/mcp-servers.js";

export function nonMemberWake(ctx: BindableContext, delegated: boolean | undefined = delegatedNonMemberWakeThisTurn(currentTurnId(ctx))): boolean {
  if (delegated !== undefined) return delegated;
  const attrs = ctx.session?.auth?.current?.attributes as Readonly<Record<string, unknown>> | undefined;
  return attrs?.[OE_CHAT_NONMEMBER_ATTR] === "true";
}

export function isSecretRef(ref: string): boolean {
  return parseDbCredentialRef(ref) !== null && /^db:[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9-]{0,63}$/u.test(ref);
}

export function mcpServerProposeAudienceRefusal(binding: Pick<SurfaceBinding, "trust">, opts: { readonly nonMember: boolean; readonly actingPrincipal: string | undefined }): string | undefined {
  if (binding.trust === "external") {
    return "this conversation is external (a shared channel, a guest or an outside account), and a declared MCP server reaches every person who can DM the agent — so it can't be proposed from here. Ask an internal person to propose it, or an admin to add it to agent/access/mcp-servers.ts by hand.";
  }
  if (opts.nonMember) {
    return "a message from someone outside the workspace woke this turn, so I can't propose a new MCP server from it. Ask again in a conversation with members only.";
  }
  if (opts.actingPrincipal === undefined) {
    return "propose_mcp_server needs a person in the conversation — a triggered routine fire has no acting sender, so it may not open a config PR in anyone's name. Ask a person here to request it.";
  }
  return undefined;
}

const HTTPS_URL = z.string().url().refine((u) => u.startsWith("https://"), "must be an https URL");

export default defineTool({
  description:
    "Propose setting up a vendor's hosted MCP server for this deployment — the answer to \"set up FullStory\" or \"connect <vendor>\". Research it FIRST with web_search and web_fetch: find the vendor's OWN MCP endpoint in its docs, then read its OAuth metadata (/.well-known/oauth-protected-resource on the MCP URL, then /.well-known/oauth-authorization-server on the server it names). A `registration_endpoint` there means dynamic client registration: omit `signIn` (or pass only `scopes`). No registration endpoint means the vendor issues a static client: pass `signIn.mode: \"static-confidential\"` with its endpoints, the public client id and a secret REF like \"db:<vendor>:oauth-client-secret\" — never a secret value. " +
    "This does NOT set anything up. It posts a card; approving it opens a pull request on the deployment's config repo that adds ONE entry to agent/access/mcp-servers.ts, for an admin to merge. The PR names the doc URLs you pass, so pass the pages you actually read, and every vendor-side step a person must do by hand. A merged entry reaches EVERY person who can DM the agent unless `people.groups` narrows it — say so to the person. Refused in an external or guest conversation. The posted card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    name: z.string().min(1).describe('The connection slug: lowercase, a letter first, e.g. "fullstory".'),
    url: HTTPS_URL.describe("The vendor's hosted MCP endpoint, from the vendor's own docs. No query string."),
    description: z.string().min(1).describe("One line on what the server is for — the model reads it to decide when to call the server."),
    signIn: z
      .union([
        z.object({ mode: z.literal("discovery-dcr-pkce").optional(), scopes: z.array(z.string().min(1)).optional() }),
        z.object({
          mode: z.literal("static-confidential"),
          authorizationEndpoint: HTTPS_URL,
          tokenEndpoint: HTTPS_URL,
          revocationEndpoint: HTTPS_URL.optional(),
          clientId: z.string().min(1).describe("The PUBLIC client id the vendor issued."),
          clientSecretRef: z
            .string()
            .refine(isSecretRef, 'must be a credential-store REF like "db:fullstory:oauth-client-secret" — never the secret value')
            .describe('The credential-store REF the secret will live under, e.g. "db:fullstory:oauth-client-secret". Never the value.'),
          bodyEncoding: z.enum(["form", "json"]),
          scopes: z.array(z.string().min(1)).optional(),
        }),
      ])
      .optional()
      .describe("Omit for dynamic client registration with no scopes."),
    peopleGroups: z.array(z.string().min(1)).optional().describe("Person-groups to narrow the server to. Omit to give it to every person who can DM the agent."),
    docUrls: z.array(HTTPS_URL).min(1).max(8).describe("The vendor documentation pages you read to get the URL and the sign-in. The reviewer checks the entry against them."),
    vendorSteps: z.array(z.string().min(1)).max(8).optional().describe("Steps a person must do in the vendor's console, e.g. \"Create an OAuth app in Settings → Integrations\"."),
    reason: z.string().optional().describe("Why this is wanted, for the PR body."),
  }),
  outputSchema: z.object({
    proposed: z.boolean(),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    name: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "propose_mcp_server");
    if (resolveMode(ctx) === "mpim") throw new Error("Group DMs are execution-only — propose an MCP server from a channel or a DM instead.");

    const binding = bindFrom(ctx);
    const requestedBy = actingPrincipalIdOf(ctx);
    const refusal = mcpServerProposeAudienceRefusal(binding, { nonMember: nonMemberWake(ctx), actingPrincipal: requestedBy });
    if (refusal !== undefined) throw new Error(refusal);

    const p = resolvePartition(ctx);
    const proposeScopeKey = await proposalScopeKey(ctx, p);
    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "propose that MCP server"));
    const venue = venueResult.venue;

    const cfg = requireMcpServerProposeConfig();

    const signIn = input.signIn;
    const declaration: McpServerDeclaration = {
      name: input.name.trim(),
      url: input.url.trim(),
      description: input.description.trim(),
      ...(signIn === undefined
        ? {}
        : signIn.mode === "static-confidential"
          ? { signIn }
          : signIn.scopes !== undefined && signIn.scopes.length > 0
            ? { signIn: { scopes: signIn.scopes } }
            : {}),
      ...(input.peopleGroups !== undefined && input.peopleGroups.length > 0 ? { people: { groups: input.peopleGroups } } : {}),
    };
    validateMcpServerProposal(declaration, cfg.baseMcpServers!());

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("propose_mcp_server couldn't resolve this conversation's id — try again from a real channel or DM.");

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "mcp-server.propose",
        args: {
          org: p.org,
          scopeKey: proposeScopeKey,
          requestId: randomUUID(),
          declaration,
          docUrls: input.docUrls,
          vendorSteps: input.vendorSteps ?? [],
          requestedBy: requestedBy!,
          ...(input.reason ? { reason: input.reason } : {}),
          channelId,
          threadTs: binding.threadTs ?? null,
          configRepo: cfg.configRepo,
        },
        scopeKey: proposeScopeKey,
        domain: null,
        requestedBy: requestedBy!,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const tail = `${mcpServerReachLine(declaration)} Nothing is set up until an admin merges the PR.`;
    if (posted.autoApproved) {
      return { proposed: true, pending: false, autoApproved: true, pendingId: posted.id, name: declaration.name, message: `${autoApprovedNote(`PR against ${cfg.configRepo} adding MCP server "${declaration.name}"`, posted.autoApproved)} ${tail}` };
    }
    return {
      proposed: true,
      pending: true,
      pendingId: posted.id,
      name: declaration.name,
      message: `${cardPostedPrefix(venue)} — approving it opens a PR against ${cfg.configRepo} adding MCP server "${declaration.name}" to agent/access/mcp-servers.ts (pending ${posted.id}). ${tail}${cardPostedTail(venue, "approve it", posted)}`,
    };
  },
});
