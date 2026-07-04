import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spendView, routinesView, auditView, accessView, overridesView, usageSummaryView, skillsListView, memoryListView, memoryReadView } from "./views.js";
import { registerControlWriteTools } from "./writes.js";
import { scopeDenial, siloScopeDenial } from "./auth.js";
import { getConfig } from "../access/config.js";

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
  "skills_list",
  "memory_list",
  "memory_read",
] as const;

export interface ControlServerOptions {
  readonly includeWrites?: boolean;
  readonly actor?: string;
  readonly roles?: readonly string[];
}

export function buildControlServer(opts: ControlServerOptions = {}): McpServer {
  const server = new McpServer({ name: "open-everywhere-control", version: "0.1.0" });
  const roles = opts.roles ?? ["admin"];

  server.registerTool(
    "spend_report",
    {
      title: "Spend report",
      description: "Per-surface and per-workspace token spend for a month against configured caps. Read-only. period defaults to the current month (YYYY-MM).",
      inputSchema: { period: z.string().regex(/^\d{4}-\d{2}$/).optional() },
    },
    (args) => jsonTool(() => spendView(args.period))(),
  );

  server.registerTool(
    "routines_list",
    {
      title: "List routines",
      description: "Every proactive routine across surfaces (config-as-code's routines console). onlyDue=true returns just those a tick would fire now. Read-only.",
      inputSchema: { onlyDue: z.boolean().optional() },
    },
    (args) => jsonTool(() => routinesView({ onlyDue: args.onlyDue }))(),
  );

  server.registerTool(
    "audit_query",
    {
      title: "Query audit log",
      description: "Read the append-only audit trail — who did what, when (memory writes, network grants, consequential tool actions). All filters optional. Read-only.",
      inputSchema: {
        org: z.string().optional(),
        workspace: z.string().optional(),
        surface: z.string().optional(),
        action: z.string().optional(),
        principalId: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    (args) => jsonTool(() => auditView(args))(),
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

  if (opts.includeWrites) registerControlWriteTools(server, opts.actor ?? "unknown", roles);

  return server;
}
