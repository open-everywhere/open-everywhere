import { randomUUID } from "node:crypto";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { actingPrincipalId, bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { buildResolveRequest, resolveAccessFor, unattendedOf } from "../access/request.js";
import { resolveAccess, surfaceKeyOf } from "../access/resolver.js";
import { getConfig } from "../access/config.js";
import { planAccessDelta, grantSentence, HTTP_METHODS, type AccessDelta, type PlanContext, type RequestingScope } from "../access/delta.js";
import { roleForBinding } from "../access/roles.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { isLinkSetMember, type Group } from "../identity/groups.js";
import type { Binding, Bundle } from "../access/bundle.js";
import type { Domain } from "../memory/domain.js";
import { resolveSkillDomain } from "../skills/domain-skills.js";
import { resolveMessagePermalink } from "../channels/surface-message-ops.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, describeVenueRedirect } from "../approvals/card-venue.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

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
  readonly universe?: string;
}

export type RequestTarget = "channel" | "personal" | "group";

export interface RequestAccessInput {
  readonly kind: string;
  readonly target?: string;
  readonly group?: string;
  readonly connection?: string;
  readonly add_methods?: readonly string[];
  readonly add_path_prefixes?: readonly string[];
  readonly connector?: string;
  readonly reason?: string;
}

export function requestTargetOf(input: Pick<RequestAccessInput, "target">): RequestTarget {
  const raw = (input.target ?? "channel").trim();
  if (raw === "channel" || raw === "personal" || raw === "group") return raw;
  throw new Error(`unknown request target "${raw}" — the targets are channel (this room), personal (your own DM) and group (a declared person-group).`);
}

export function requestingScopeFor(
  target: RequestTarget,
  binding: SurfaceBinding,
  surfaceKey: string,
  input: Pick<RequestAccessInput, "group">,
): RequestingScope {
  switch (target) {
    case "channel":
      return { level: "surface", surface: surfaceKey };
    case "personal":
      return { level: "principal", principal: tryPrincipalKey(binding.platform, binding.workspace, actingPrincipalId(binding) ?? "") ?? "" };
    case "group":
      return { level: "group", group: (input.group ?? "").trim() };
  }
}

export function groupEffectiveAccess(
  group: string,
  platform: string,
  workspace: string,
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
): PlanContext["access"] {
  const groupBindings = bindings.filter((b) => b.scope.level === "group" && b.scope.group === group);
  return resolveAccess(
    { mode: "dm", platform, workspace, channel: "-", principalId: "-", groups: [group] },
    bundles,
    groupBindings,
    getConfig().pluginRegistry,
    getConfig().loadProviders?.() ?? [],
  );
}

function universeNote(scope: RequestingScope, groups: readonly Group[]): string | undefined {
  if (scope.level === "principal") return `Personal DM grant for \`${scope.principal}\` — resolves in that person's DM and nowhere else.`;
  if (scope.level !== "group") return undefined;
  const g = groups.find((x) => x.name === scope.group);
  const sets = g?.members.filter(isLinkSetMember).length ?? 0;
  return (
    `Group grant for "${scope.group}" — ${g?.members.length ?? 0} member(s), link-set members: ${sets > 0 ? `yes (${sets})` : "no"}. ` +
    `It resolves in each member's own DM, never in a channel` +
    (sets > 0
      ? `. NOTE: the ${sets} link-set member(s) resolve to each person's CONFIRMED accounts only — a directory suggestion or a suspended/revoked link-set grants nothing.`
      : ".")
  );
}

export function planRequestAccess(
  binding: SurfaceBinding,
  planCtx: PlanContext,
  input: RequestAccessInput,
  extras: { scopeKey: string; channelId: string; configRepo: string; permalink?: string; domains?: readonly Domain[] },
): RequestAccessArgs {
  const target = requestTargetOf(input);
  if (target === "channel" && binding.mode !== "channel") {
    throw new Error(
      "access requests come from the channel that needs the access (grants bind to a channel scope) — ask again from that channel, not a DM. " +
        "To widen your OWN personal (DM) access instead, ask me here with target=personal.",
    );
  }
  if (target === "personal" && binding.mode !== "dm") {
    throw new Error("a personal (DM) access request has to come from our DM — that's the universe it would land in. Send me a direct message and ask there.");
  }
  if (target === "group" && binding.mode !== "channel" && binding.mode !== "dm") {
    throw new Error(`group access requests come from a channel or a DM (this surface is "${binding.mode}").`);
  }
  if (binding.trust === "external") {
    throw new Error("this channel is externally shared — access can't be widened from an external surface; an internal admin can PR a grant by hand.");
  }
  const requestedBy = actingPrincipalId(binding);
  if (!requestedBy) {
    throw new Error("request_access needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not ask for its own channel to be widened in that person's name. Ask someone in this channel to request it.");
  }

  const expectedLevel = target === "channel" ? "surface" : target === "personal" ? "principal" : "group";
  if (planCtx.scope.level !== expectedLevel) {
    throw new Error(`request_access wiring bug: target "${target}" addresses a ${expectedLevel}-level scope but was handed a ${planCtx.scope.level}-level one.`);
  }

  if (planCtx.scope.level === "principal") {
    const self = tryPrincipalKey(binding.platform, binding.workspace, requestedBy) ?? "";
    if (planCtx.scope.principal !== self) {
      throw new Error(
        `personal access requests are self-service only: I can only ask for YOUR own DM access (\`${self}\`), never anyone else's (\`${planCtx.scope.principal}\`). ` +
          `A grant for another person is theirs to request, or an admin PRs it by hand.`,
      );
    }
  }

  if (planCtx.scope.level === "group" && planCtx.scope.group !== (input.group ?? "").trim()) {
    throw new Error(`request_access wiring bug: the ask names group "${(input.group ?? "").trim()}" but the scope addresses "${planCtx.scope.group}".`);
  }

  if (planCtx.scope.level === "group") {
    const role = roleForBinding(binding, extras.domains ?? []);
    if (!role.isOrgAdmin) {
      throw new Error(
        `granting a person-group is an org-admin action — a group grant lands in EVERY member's DM, so it isn't scoped to any channel you administer.${
          role.principalId ? ` Your id ("${role.principalId}") isn't on the "org" pseudo-domain's admins list.` : ""
        } Ask an org admin to request it, or have them PR the binding by hand.`,
      );
    }
  }

  const delta = planAccessDelta(
    {
      kind: input.kind,
      connection: input.connection,
      addMethods: input.add_methods,
      addPathPrefixes: input.add_path_prefixes,
      connector: input.connector,
      reason: input.reason,
    },
    planCtx,
  );

  const universe = universeNote(delta.scope, planCtx.groups ?? []);
  return {
    org: binding.org,
    scopeKey: extras.scopeKey,
    requestId: randomUUID(),
    delta,
    requestedBy,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    channelId: extras.channelId,
    threadTs: binding.threadTs ?? null,
    ...(extras.permalink ? { permalink: extras.permalink } : {}),
    configRepo: extras.configRepo,
    ...(universe ? { universe } : {}),
  };
}

const requestAccessEntry = defineTool({
        description:
          "PROPOSE widening access — this grants nothing itself. Use when someone asks for access they don't have. Exactly two request shapes exist: kind=widen-connection (add HTTP methods and/or path prefixes to a connection ALREADY available in the target) and kind=grant-connector (enable a connector this deployment already defines but the target doesn't have). Anything else — a new website/host, a new credential or API key, a new repo, a brand-new integration — is NOT requestable this way: refuse and say an admin needs to PR it by hand. `target` picks the universe: \"channel\" (default, THIS room — must be asked from that channel), \"personal\" (the ASKER's own DM access — only from their DM, and only ever for themselves: never use it to ask on someone else's behalf), or \"group\" (a declared person-group, landing in every member's DM — org admins only, and name the group in `group`). On success a \"Request access\" card is posted in this thread; any member's tap sends the request as a bot-PR that an admin merges in GitHub — nothing changes until that merge. The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `note` field names it, and you MUST relay that.",
        inputSchema: z.object({
          kind: z.enum(["widen-connection", "grant-connector"]).describe("Which of the two request shapes this ask maps to."),
          target: z
            .enum(["channel", "personal", "group"])
            .optional()
            .describe(
              'Which universe to widen: "channel" (default — this room), "personal" (the asker\'s own DM access; DM-only and self-only), "group" (a declared person-group, every member\'s DM; org admins only).',
            ),
          group: z.string().optional().describe("target=group: the declared person-group name to grant (as listed in this deployment's groups)."),
          connection: z.string().optional().describe("widen-connection: the id of the existing connection to widen (as listed in the target's access)."),
          add_methods: z.array(z.enum(HTTP_METHODS as [string, ...string[]])).optional().describe("widen-connection: HTTP methods to add."),
          add_path_prefixes: z.array(z.string()).optional().describe('widen-connection: path prefixes to add (each starts with "/").'),
          connector: z.string().optional().describe("grant-connector: the connector name to enable for the target."),
          reason: z
            .string()
            .optional()
            .describe("Why this access is needed — shown on the card and in the PR. REQUIRED for a broad person-group (many members, or link-set members): it is recorded on the binding as the reviewed `allowBroad` acknowledgement."),
        }),
        outputSchema: z.object({
          requested: z.boolean(),
          pendingId: z.string(),
          expiresAt: z.string().optional().describe("Absent when the chain auto-approved: the row is already decided, so nothing expires."),
          note: z.string(),
          autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
        }),
        async execute(input, ctx) {
          await requireSessionContinuation(ctx, "request_access");
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
            throw new Error("request_access couldn't resolve this channel's id — try again from a real channel, not a synthetic context.");
          }

          const req = buildResolveRequest(ctx);
          const target = requestTargetOf(input);
          const groups = cfg.loadGroups?.() ?? [];
          const scope = requestingScopeFor(target, binding, surfaceKeyOf(req), input);
          const planCtx: PlanContext = {
            scope,
            access:
              scope.level === "group"
                ? groupEffectiveAccess(scope.group, req.platform, req.workspace, cfg.loadBundles(), cfg.loadBindings())
                : resolveAccessFor(ctx),
            bundles: cfg.loadBundles(),
            groups,
          };

          const permalink = binding.threadTs
            ? await resolveMessagePermalink(binding.platform, {
                channelId,
                messageId: binding.threadTs,
                workspace: binding.workspace,
                dm: binding.mode === "dm",
              })
            : undefined;

          const args = planRequestAccess(binding, planCtx, input, {
            scopeKey: partition.surfaceKey,
            channelId,
            configRepo: ar.configRepo,
            permalink,
            domains: cfg.loadDomains(),
          });

          const venueResult = await checkApprovalVenue(binding, partition, () => cfg.loadDomains());
          if ("refusal" in venueResult) {
            throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "request that access"));
          }
          const venue = venueResult.venue;

          const posted = await requestApproval(
            {
              org: args.org,
              kind: "access.request",
              args,
              scopeKey: args.scopeKey,
              domain,
              requestedBy: args.requestedBy,
              channelId: venue.channelId,
              threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
              postedTo: venue.surfaceKey,
              chain: { unattended: unattendedOf(ctx) },
            },
            approvalPostDeps(venue.platform),
          );

          if (posted.autoApproved) {
            return {
              requested: false,
              autoApproved: true,
              pendingId: posted.id,
              note: autoApprovedNote(grantSentence(args.delta), posted.autoApproved),
            };
          }
          return {
            requested: true,
            pendingId: posted.id,
            expiresAt: posted.expiresAt,
            note: `${cardPostedPrefix(venue)} — ${grantSentence(args.delta)} (pending ${posted.id}).` + describeVenueRedirect(venue, "tap it to send the request"),
          };
        },
});
preRegisterDynamicEntry("request_access", "_single", requestAccessEntry);

export default defineDynamic({
  events: {
    "session.started": () => requestAccessEntry,
  },
});
