import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spendView, routinesView, auditView, accessView, overridesView, usageSummaryView, usageWindowView, skillsListView, skillRevisionsView, DEFAULT_SKILL_REVISIONS_LIMIT, MAX_SKILL_REVISIONS_LIMIT, memoryListView, memoryReadView, pendingActionsView, unifiedDomainAudit } from "./views.js";
import { registerControlWriteTools } from "./writes.js";
import { scopeDenial, siloScopeDenial } from "./auth.js";
import { getConfig } from "../access/config.js";
import { deploymentOrg } from "../identity/binding.js";

const SESSION_MODE = z.enum(["channel", "dm", "mpim"]);

function jsonTool<T>(run: () => Promise<T>) {
  return async () => {
    try {
      const data = await run();
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `control view failed: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  };
}

export const CONTROL_TOOL_NAMES = [
  "spend_report",
  "routines_list",
  "audit_query",
  "access_preview",
  "overrides_list",
  "usage_summary",
  "usage_window",
  "skills_list",
  "skill_revisions",
  "memory_list",
  "memory_read",
  "pending_actions_list",
  "unified_domain_audit",
] as const;

export interface ControlServerOptions {
  readonly includeWrites?: boolean;
  readonly actor?: string;
  readonly roles?: readonly string[];
  readonly readOnly?: boolean;
}

export function buildControlServer(opts: ControlServerOptions = {}): McpServer {
  const server = new McpServer({ name: "open-everywhere-control", version: "0.1.0" });
  const roles = opts.roles ?? ["admin"];

  server.registerTool(
    "spend_report",
    {
      title: "Spend report",
      description:
        "Per-surface and per-workspace token + estimated USD spend for a month against EFFECTIVE caps (config-as-code overlaid with any active admin override — the same caps the spend gate enforces). Read-only. period defaults to the current month (YYYY-MM).",
      inputSchema: { period: z.string().regex(/^\d{4}-\d{2}$/).optional() },
    },
    (args) => jsonTool(() => spendView(args.period))(),
  );

  server.registerTool(
    "routines_list",
    {
      title: "List routines",
      description:
        'Every proactive routine across one org\'s surfaces (config-as-code\'s routines console) — id, trigger, next run, status, failure count, the routine\'s full PROMPT, and for an event subscription when its filter first/last matched a delivery. onlyDue=true returns just those a tick would fire now. org defaults to the deployment\'s (OE_ORG / "default"); an org-wide listing requires the org-wide "admin" role, or pass surfaceKey to scope it to one channel (a covering "domain:<name>" role is enough for that). Read-only.',
      inputSchema: { onlyDue: z.boolean().optional(), org: z.string().min(1).optional(), surfaceKey: z.string().min(1).optional() },
    },
    (args) =>
      jsonTool(async () => {
        const org = args.org ?? deploymentOrg();
        const denial = scopeDenial(roles, { org, ...(args.surfaceKey ? { surfaceKey: args.surfaceKey } : {}) });
        if (denial) throw new Error(denial);
        return routinesView({ onlyDue: args.onlyDue, org, ...(args.surfaceKey ? { surfaceKey: args.surfaceKey } : {}) });
      })(),
  );

  server.registerTool(
    "audit_query",
    {
      title: "Query audit log",
      description:
        "Read the append-only audit trail — who did what, when (memory writes, network grants, consequential tool actions). Always this deployment's own org; every other filter is optional. Read-only.",
      inputSchema: {
        workspace: z.string().optional(),
        surface: z.string().optional(),
        action: z.string().optional(),
        principalId: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    (args) => jsonTool(() => auditView({ ...args, org: deploymentOrg() }))(),
  );

  server.registerTool(
    "access_preview",
    {
      title: "Preview effective access",
      description: "Resolve what a given scope can reach — reachable hosts, connections (secret NAMES only), repos, plugins, host-side connectors, and the instruction precedence stack. The same resolution the running agent uses. No secret values. Read-only.",
      inputSchema: {
        platform: z.string().optional(),
        workspace: z.string().optional(),
        channel: z.string().optional(),
        mode: SESSION_MODE.optional(),
        principalId: z.string().optional(),
      },
    },
    (args) => jsonTool(() => accessView(args))(),
  );

  server.registerTool(
    "unified_domain_audit",
    {
      title: "Unified cross-surface domain audit",
      description:
        "For a unified cross-surface supervisor domain (research preview): which surfaces are in this one mind, what the agent itself can reach ACROSS all of them (unioned, flagging any container that widens the set), which mapped humans can read across which surfaces (the read-across exposure map), the domain admins, and the audited reply/silence record. Pure-read (restricts nothing) — the domain-grain answer no per-container access_preview can give. Scope-gated to org or domain:<name> role. sinceDays defaults to 30.",
      inputSchema: {
        domain: z.string().min(1),
        org: z.string().optional(),
        sinceDays: z.number().int().positive().max(365).optional(),
      },
    },
    (args) =>
      jsonTool(async () => {
        const org = args.org ?? deploymentOrg();
        const denial = scopeDenial(roles, { org, domain: args.domain });
        if (denial) throw new Error(denial);
        return unifiedDomainAudit({ domain: args.domain, org, ...(args.sinceDays ? { sinceDays: args.sinceDays } : {}) });
      })(),
  );

  server.registerTool(
    "overrides_list",
    {
      title: "List runtime overrides (drift view)",
      description: "The reconcile worklist: every live override overlaying config-as-code for an org — spend caps (with configCap, divergesFromConfig, expired) and connector revokes (sticky) — each with reason/setBy. Overrides are temporary bridges; this shows which need PR'ing into config or clearing. Read-only. Org-wide (every scopeKey in the org) — requires org-admin; a domain-scoped role can't cover an unscoped org-wide listing.",
      inputSchema: { org: z.string().min(1) },
    },
    (args) =>
      jsonTool(async () => {
        const denial = scopeDenial(roles, { org: args.org });
        if (denial) throw new Error(denial);
        return overridesView(args.org);
      })(),
  );

  server.registerTool(
    "usage_summary",
    {
      title: "Usage summary (tokens + $ estimate)",
      description:
        "Grouped usage_events rollup (surface/user/kind/model) with an estimated $ figure where a model can be assumed — the control-plane view behind the session_cost/spend_report/usage_report agent tools, plus a routine-fired cost PROJECTION (7d/30d) per surface where there's enough history (routinePredictions — always an estimate, never a bill). Pass domain OR surfaceKey to scope it (a domain:<name> role covers its own domain/surfaceKey); an unscoped, org-wide call needs the org-wide \"admin\" role. sinceDays defaults to 30. Read-only.",
      inputSchema: {
        org: z.string().min(1),
        domain: z.string().optional(),
        surfaceKey: z.string().optional(),
        sinceDays: z.number().int().positive().max(365).optional(),
        assumedModelId: z.string().optional(),
      },
    },
    (args) =>
      jsonTool(async () => {
        const denial = scopeDenial(roles, { org: args.org, domain: args.domain, surfaceKey: args.surfaceKey });
        if (denial) throw new Error(denial);
        return usageSummaryView(args);
      })(),
  );

  server.registerTool(
    "usage_window",
    {
      title: "Usage window (priced, per surface × model)",
      description:
        'Everything the deployment spent since a timestamp across a set of workspaces, grouped by (surfaceKey, model): call count, token sums, an EXACT per-row $ estimate at each row\'s own stamped model rate (spend/pricing.ts), and a total. An unpriced or unstamped row shows tokens with estimatedUsd omitted and its model under unpricedModels — never a guessed figure (deliberately NO assumed-model fallback, unlike usage_summary). Built for the e2e/CI harness pricing a live run via a read-only service token. workspaceKeys entries are exactly "platform/workspace"; sinceIso is any parseable ISO-8601 timestamp; org defaults to the deployment\'s (OE_ORG / "default"). Org-wide — requires the org-wide "admin" role (service tokens carry it). Read-only.',
      inputSchema: {
        sinceIso: z.string().min(1),
        workspaceKeys: z.array(z.string().min(1)).min(1),
        org: z.string().min(1).optional(),
      },
    },
    (args) =>
      jsonTool(async () => {
        const org = args.org ?? deploymentOrg();
        const denial = scopeDenial(roles, { org });
        if (denial) throw new Error(denial);
        return usageWindowView({ sinceIso: args.sinceIso, workspaceKeys: args.workspaceKeys, org });
      })(),
  );

  server.registerTool(
    "skills_list",
    {
      title: "List a domain's runtime-authored skills",
      description:
        "Every runtime DOMAIN skill (agent/skills/domain-skills.ts) authored for one memory domain — the control-plane mirror of the list_skills agent tool's \"domain\" tier. Requires a domain:<name> role covering it (or org-wide \"admin\"). Read-only.",
      inputSchema: { org: z.string().min(1), domain: z.string().min(1) },
    },
    (args) =>
      jsonTool(async () => {
        const denial = scopeDenial(roles, { org: args.org, domain: args.domain });
        if (denial) throw new Error(denial);
        return skillsListView(args);
      })(),
  );

  server.registerTool(
    "skill_revisions",
    {
      title: "One domain skill's approved-body history",
      description:
        `Every recorded body of ONE runtime domain skill (skills_list for the current names), newest first — the append-only log OPE-237 writes on every ` +
        `putDomainSkill (agent/operational/store.ts's domain_skill_revisions): the exact content, who authored it, who ARMED it by approving the card ` +
        `(armedBy), and that card's id (approvalId — join it to pending_actions for the frozen args, or to the audit trail for the "approval.approved" ` +
        `row) so this answers "what did the approver actually agree to", not just "who last touched it". Survives delete_skill: a removed skill's history ` +
        `still reads here. name is required (this reads one skill's history, never a whole domain's — skills_list is the domain sweep). limit caps the ` +
        `rows returned (default ${DEFAULT_SKILL_REVISIONS_LIMIT}, max ${MAX_SKILL_REVISIONS_LIMIT}); capped:true in ` +
        `the result means there are older revisions this call didn't return. SAME gate as skills_list — a domain:<name> role covering it, or org-wide ` +
        `"admin" — because a skill body is already fully readable at that tier via skills_list; this is that same content, historically. Read-only.`,
      inputSchema: {
        org: z.string().min(1),
        domain: z.string().min(1),
        name: z.string().min(1),
        limit: z.number().int().positive().max(MAX_SKILL_REVISIONS_LIMIT).optional(),
      },
    },
    (args) =>
      jsonTool(async () => {
        const denial = scopeDenial(roles, { org: args.org, domain: args.domain });
        if (denial) throw new Error(denial);
        return skillRevisionsView(args);
      })(),
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memory silos (the org brain, without SQL)",
      description:
        "Every memory silo (memory/silo.ts) the caller's roles cover, enumerated from CONFIG (the domains registry, incl. the conventional \"org-brain\" silo) — not by scanning the store. Each row: silo name, the explicit domain(s) referencing it, provider/backing, read-only flag, and its files with sizes. Row-filtered by role, never an all-or-nothing denial: a domain:<name> role sees only silos an explicit domain of that name references; \"admin\" sees every silo. The org-brain (or any silo referenced only by the org/public/dm pseudo-domains, or by no domain at all) is admin-only. DM/personal and workspace-tier memory are never listed here (excluded entirely — fail-closed privacy). Read-only.",
      inputSchema: { org: z.string().min(1) },
    },
    (args) => jsonTool(() => memoryListView(args.org, roles))(),
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read one memory file",
      description:
        "Read one file (relPath, e.g. \"MEMORY.md\" or \"people.md\") out of one memory silo (memory_list for the silo names + file lists). Requires a role covering that silo (\"admin\", or a \"domain:<name>\" role for an explicit domain referencing it) — same admin-only carve-out as memory_list for the org-brain / an unreferenced silo. Read-only.",
      inputSchema: { org: z.string().min(1), silo: z.string().min(1), relPath: z.string().min(1) },
    },
    (args) =>
      jsonTool(async () => {
        const denial = siloScopeDenial(roles, args.org, args.silo, getConfig().loadDomains());
        if (denial) throw new Error(denial);
        return memoryReadView(args);
      })(),
  );

  server.registerTool(
    "pending_actions_list",
    {
      title: "List pending approvals awaiting a decision",
      description:
        "The approvals decide-queue: every action still awaiting an admin decision for an org — the id (feed it to decide_pending_action), the proposed action kind + who may decide it (policy), a code-rendered human summary of the FROZEN args (never the raw arg blob), the target scope/domain, who requested it, and its age + expiry. Row-filtered by role like memory_list — a domain:<name> role sees only pendings in its own domain; \"admin\" sees all. Read-only (a row past its TTL shows expired:true, it isn't decided here).",
      inputSchema: { org: z.string().min(1) },
    },
    (args) => jsonTool(() => pendingActionsView(args.org, roles))(),
  );

  if (opts.includeWrites && opts.readOnly !== true) registerControlWriteTools(server, opts.actor ?? "unknown", roles);

  return server;
}
