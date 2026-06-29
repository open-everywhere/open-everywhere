import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spendView, routinesView, auditView, accessView, overridesView } from "./views.js";
import { registerControlWriteTools } from "./writes.js";

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

export const CONTROL_TOOL_NAMES = ["spend_report", "routines_list", "audit_query", "access_preview", "overrides_list"] as const;

export interface ControlServerOptions {
  readonly includeWrites?: boolean;
  readonly actor?: string;
}

export function buildControlServer(opts: ControlServerOptions = {}): McpServer {
  const server = new McpServer({ name: "open-everywhere-control", version: "0.1.0" });

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
      description: "The reconcile worklist: every live override overlaying config-as-code for an org — spend caps (with configCap, divergesFromConfig, expired) and connector revokes (sticky) — each with reason/setBy. Overrides are temporary bridges; this shows which need PR'ing into config or clearing. Read-only.",
      inputSchema: { org: z.string().min(1) },
    },
    (args) => jsonTool(() => overridesView(args.org))(),
  );

  if (opts.includeWrites) registerControlWriteTools(server, opts.actor ?? "unknown");

  return server;
}
