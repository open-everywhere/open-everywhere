import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { bindFrom } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalIdOf, buildResolveRequest, resolveAccessFor } from "../access/request.js";
import { surfaceKeyOf } from "../access/resolver.js";
import { getConfig } from "../access/config.js";
import { definedConnectors } from "../access/delta.js";
import {
  agentSiloName,
  assertExposedAgentSpec,
  type AgentMemory,
  type AgentSpec,
} from "../memory/agents-codemod.js";
import type { MemorySilo } from "../memory/silo.js";
import type { AgentCreateArgs } from "../approvals/agent-create.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, describeVenueRedirect } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const selectionSchema = z.object({
  default: z.enum(["recurse", "include"]).describe('What UNLISTED nodes get: "recurse" = take all (prune with excludes); "include" = take only the root + ticked nodes.'),
  rules: z
    .array(
      z.object({
        path: z.string().min(1).describe('Node path relative to the silo root ("Handbook/Deep Dive") or a raw node id.'),
        mode: z.enum(["recurse", "include", "exclude"]),
      }),
    )
    .optional(),
});

export default defineTool({
  description:
    "PROPOSE a new AGENT for THIS channel — a self-contained teammate with its OWN memory brain and its own capabilities. This grants nothing itself: it opens a pull request adding the agent to this deployment's config, for a human to review and merge; nothing is provisioned until an admin merges it. An agent is three things derived from what you pass: a memory DOMAIN whose roster is this channel, a memory SILO (where its brain lives — either reuse an existing silo by name, or materialise a NEW read-only silo over notion/github/postgres), and a capability BUNDLE (its standing instructions + any connectors) bound to that channel. Use it when someone wants to stand up a dedicated assistant in a channel (\"make this channel a support agent backed by our Notion handbook\"). Refused from a DM, a group chat, an externally-shared channel, or a channel that ALREADY belongs to a domain. Set `exposed: true` ONLY for an agent a wider, less-trusted audience will reach — it is then forced curated READ-ONLY. The posted card IS the reply — do not add narration after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `note` field names it, and you MUST relay that.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(64)
      .describe('The agent\'s bare name — also its memory domain + bundle name. Letters, digits, "_" or "-", e.g. "support-desk". No "/".'),
    title: z.string().optional().describe("A human-friendly display title, e.g. \"Support Desk Assistant\". Optional."),
    memory: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("existing-silo"),
          silo: z.string().min(1).describe("The name of an already-defined memory silo to reuse as this agent's brain."),
        }),
        z.object({
          kind: z.literal("new-readonly"),
          provider: z.enum(["notion", "github", "postgres"]).describe("The backing for a NEW read-only silo materialised for this agent."),
          container: z.string().optional().describe('Provider container: a repo ("github"), a root page/teamspace id ("notion").'),
          path: z.string().optional().describe("Subtree within the container this silo's memory lives under."),
          select: selectionSchema.optional().describe("Curated subset of a tree backing (notion/github) — take only part of the source."),
          skill: z.string().optional().describe("The skill that teaches how to USE/UPDATE this source (e.g. the Notion-update skill)."),
        }),
      ])
      .describe('WHERE the agent\'s brain lives: reuse an existing silo ({ kind: "existing-silo", silo }) or materialise a new READ-ONLY one ({ kind: "new-readonly", provider, ... }).'),
    connectors: z.array(z.string().min(1)).optional().describe("Connector slug(s) this agent may use — each must already be defined in this deployment's config."),
    instructions: z.string().optional().describe("Standing instructions the agent follows on every turn — its persona / job. Kept as narrow as the job allows."),
    exposed: z.boolean().optional().default(false).describe("True ONLY if a wider, less-trusted audience reaches this agent. It is then forced curated read-only (read-only silo, no org-brain inheritance)."),
    reason: z.string().optional().describe("Why this agent is wanted — shown on the card and in the PR."),
  }),
  outputSchema: z.object({
    requested: z.boolean(),
    pendingId: z.string(),
    expiresAt: z.string().optional().describe("Absent when the chain auto-approved: the row is already decided, so nothing expires."),
    note: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "create_agent");

    const binding = bindFrom(ctx);
    const p = resolvePartition(ctx);
    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "propose that agent"));
    }
    const venue = venueResult.venue;
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error(
        "create_agent needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and a routine fire may not author standing behaviour (a new channel-resident agent) in that person's name. Ask a person in this conversation to propose it.",
      );
    }
    if (binding.mode !== "channel") {
      throw new Error("create_agent binds an agent to the channel it's proposed from — ask again from that channel, not a DM or group chat.");
    }
    if (binding.trust === "external") {
      throw new Error("this channel is externally shared — an agent can't be provisioned onto an external surface; an internal admin can add one by hand.");
    }

    const cfg = getConfig();
    const ar = cfg.loadAccessRequests?.();
    if (!ar?.adminChannel || !ar?.configRepo) {
      throw new Error(
        "creating agents from chat isn't enabled on this deployment (no admin channel / config repo configured — " +
          "OE_ACCESS_ADMIN_CHANNEL + OE_ACCESS_CONFIG_REPO). An admin can add an agent by hand instead.",
      );
    }

    const name = input.name.trim();
    if (!NAME_RE.test(name)) {
      throw new Error(`"${input.name}" isn't a valid agent name — use letters, digits, "_" or "-" (1–64 chars, no "/").`);
    }

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("create_agent couldn't resolve this channel's id — try again from a real channel, not a synthetic context.");
    }

    const req = buildResolveRequest(ctx);
    const surfaceKey = surfaceKeyOf(req);

    if (cfg.loadDomains().some((d) => d.name === name)) {
      throw new Error(`"${name}" is already a memory domain in this deployment — an agent's name is its domain name, so pick a different name (or an admin renames the existing domain by hand).`);
    }
    const existingDomains = req.domains ?? [];
    if (existingDomains.length > 0) {
      throw new Error(
        `this channel already belongs to the "${existingDomains.join(", ")}" domain — a channel can be in at most one domain, so it can't also become agent "${name}". Propose the agent from a channel that isn't in a domain yet, or an admin moves this one by hand.`,
      );
    }

    const connectors = [...new Set((input.connectors ?? []).map((c) => c.trim()).filter((c) => c.length > 0))];
    if (connectors.length > 0) {
      const defined = definedConnectors(cfg.loadBundles());
      const unknown = connectors.filter((c) => !defined.includes(c));
      if (unknown.length > 0) {
        throw new Error(
          `connector(s) ${unknown.map((c) => `"${c}"`).join(", ")} aren't defined in this deployment's config (defined: ${defined.length ? defined.join(", ") : "none"}) — an agent can only be granted connectors this deployment already provides.`,
        );
      }
    }

    const memory: AgentMemory =
      input.memory.kind === "existing-silo"
        ? { kind: "existing-silo", silo: input.memory.silo.trim() }
        : {
            kind: "new-readonly",
            provider: input.memory.provider,
            ...(input.memory.container?.trim() ? { container: input.memory.container.trim() } : {}),
            ...(input.memory.path?.trim() ? { path: input.memory.path.trim() } : {}),
            ...(input.memory.select ? { select: input.memory.select } : {}),
            ...(input.memory.skill?.trim() ? { skill: input.memory.skill.trim() } : {}),
          };

    const spec: AgentSpec = {
      name,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      channels: [surfaceKey],
      memory,
      ...(connectors.length > 0 ? { connectors } : {}),
      ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
      ...(input.exposed ? { exposed: true } : {}),
    };

    const silos = cfg.loadSilos();
    const resolveSilo = (n: string): MemorySilo | undefined => silos.find((s) => s.name === n);
    assertExposedAgentSpec(spec, resolveSilo);

    const args: AgentCreateArgs = {
      org: p.org,
      scopeKey: p.surfaceKey,
      requestId: randomUUID(),
      spec,
      requestedBy,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      channelId,
      threadTs: binding.threadTs ?? null,
      configRepo: ar.configRepo,
      agentsPath: ar.agentsPath ?? "agent/memory/agents.generated.ts",
    };

    const posted = await requestApproval(
      {
        org: args.org,
        kind: "agent.create",
        args,
        scopeKey: args.scopeKey,
        domain: null,
        requestedBy,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
      },
      approvalPostDeps(venue.platform),
    );

    const memoryClause = spec.memory.kind === "new-readonly" ? `a new read-only ${spec.memory.provider} silo` : `existing silo "${spec.memory.silo}"`;
    const subject = `PR against ${ar.configRepo} provisioning agent "${name}" (reading ${memoryClause}) for this channel`;
    if (posted.autoApproved) {
      return {
        requested: false,
        autoApproved: true,
        pendingId: posted.id,
        note: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      requested: true,
      pendingId: posted.id,
      expiresAt: posted.expiresAt,
      note: `${cardPostedPrefix(venue)} — ${subject} (pending ${posted.id}). Nothing is provisioned until an admin merges the PR.${describeVenueRedirect(venue, "approve it")}`,
    };
  },
});
