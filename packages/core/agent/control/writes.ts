import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";

export const CONTROL_WRITE_TOOL_NAMES = [
  "set_spend_limit",
  "clear_spend_limit",
  "revoke_connector",
  "clear_connector_override",
  "cancel_routine",
] as const;

function whereFromScope(org: string, scopeKey: string): { org: string; platform: string; workspace: string; surface?: string } {
  const [platform, workspace, surface] = scopeKey.split("/");
  return { org, platform: platform || "unknown", workspace: workspace || "unknown", ...(surface ? { surface } : {}) };
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function registerControlWriteTools(server: McpServer, actor: string): void {
  const store = () => getOperationalStore();

  server.registerTool(
    "set_spend_limit",
    {
      title: "Set spend limit",
      description: "Set a monthly token budget override for a scope (overlays the config caps). level=surface uses a surfaceKey 'platform/workspace/surface'; level=workspace uses 'platform/workspace'. Takes effect immediately, no redeploy. An override is a TEMPORARY BRIDGE: pass ttlSeconds so it auto-reverts to the config cap (recommended — a raised cap should land in caps.ts via PR; an un-reconciled override drifts from git). reason is surfaced in the drift view (list_overrides).",
      inputSchema: {
        org: z.string().min(1),
        scopeKey: z.string().min(1),
        level: z.enum(["surface", "workspace"]),
        monthlyTokens: z.number().int().positive(),
        ttlSeconds: z.number().int().positive().optional(),
        reason: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const expiresAt = a.ttlSeconds != null ? Date.now() + a.ttlSeconds * 1000 : undefined;
        await store().setSpendLimit(a.org, a.scopeKey, a.level, a.monthlyTokens, { expiresAt, reason: a.reason, setBy: actor });
        await appendAudit({ ...whereFromScope(a.org, a.scopeKey), principalId: actor, action: "admin.spend.set_limit", detail: { scopeKey: a.scopeKey, level: a.level, monthlyTokens: a.monthlyTokens, ...(expiresAt != null ? { expiresAt } : {}), ...(a.reason ? { reason: a.reason } : {}) } });
        return jsonResult({ ok: true, org: a.org, scopeKey: a.scopeKey, level: a.level, monthlyTokens: a.monthlyTokens, ...(expiresAt != null ? { expiresAt } : {}) });
      } catch (e) {
        return errorResult(`set_spend_limit failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "clear_spend_limit",
    {
      title: "Clear spend limit",
      description: "Remove a spend-limit override (reverts the scope to the config-as-code caps).",
      inputSchema: { org: z.string().min(1), scopeKey: z.string().min(1), level: z.enum(["surface", "workspace"]) },
    },
    async (a) => {
      try {
        const cleared = await store().clearSpendLimit(a.org, a.scopeKey, a.level);
        await appendAudit({ ...whereFromScope(a.org, a.scopeKey), principalId: actor, action: "admin.spend.clear_limit", detail: { scopeKey: a.scopeKey, level: a.level, cleared } });
        return jsonResult({ ok: true, cleared, org: a.org, scopeKey: a.scopeKey, level: a.level });
      } catch (e) {
        return errorResult(`clear_spend_limit failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "revoke_connector",
    {
      title: "Revoke connector from a surface (break-glass)",
      description: "Break-glass: revoke an Eve connector (by name, e.g. 'notion') from a surface at runtime — the hard gate blocks it immediately, no redeploy. Use for incidents (leaked token, abuse). A revoke is STICKY (no auto-expiry — auto-clearing would re-open access); revert deliberately with clear_connector_override (or a PR removing the grant from bundles.ts). reason is surfaced in the drift view. surfaceKey is 'platform/workspace/surface'. (There is no runtime *grant* — access widens only through a reviewed PR.)",
      inputSchema: { org: z.string().min(1), surfaceKey: z.string().min(1), connector: z.string().min(1), reason: z.string().optional() },
    },
    async (a) => {
      try {
        await store().setConnectorOverride(a.org, a.surfaceKey, a.connector, false, { reason: a.reason, setBy: actor });
        await appendAudit({ ...whereFromScope(a.org, a.surfaceKey), principalId: actor, action: "admin.connector.revoke", detail: { connector: a.connector, ...(a.reason ? { reason: a.reason } : {}) } });
        return jsonResult({ ok: true, revoked: a.connector, org: a.org, surfaceKey: a.surfaceKey });
      } catch (e) {
        return errorResult(`revoke_connector failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "clear_connector_override",
    {
      title: "Clear a connector override",
      description: "Remove a connector override for a surface, reverting it to the config-as-code bundle grants — i.e. undo a break-glass revoke_connector. Returns cleared=false if there was no override. surfaceKey is 'platform/workspace/surface'.",
      inputSchema: { org: z.string().min(1), surfaceKey: z.string().min(1), connector: z.string().min(1) },
    },
    async (a) => {
      try {
        const cleared = await store().clearConnectorOverride(a.org, a.surfaceKey, a.connector);
        await appendAudit({ ...whereFromScope(a.org, a.surfaceKey), principalId: actor, action: "admin.connector.clear_override", detail: { connector: a.connector, cleared } });
        return jsonResult({ ok: true, cleared, org: a.org, surfaceKey: a.surfaceKey, connector: a.connector });
      } catch (e) {
        return errorResult(`clear_connector_override failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "cancel_routine",
    {
      title: "Cancel a routine",
      description: "Cancel (delete) a routine by id on a given surface. Get org/surfaceKey/id from routines_list. Returns cancelled=false if no such routine.",
      inputSchema: { org: z.string().min(1), surfaceKey: z.string().min(1), id: z.string().min(1) },
    },
    async (a) => {
      try {
        const cancelled = await store().removeRoutine(a.org, a.surfaceKey, a.id);
        await appendAudit({ ...whereFromScope(a.org, a.surfaceKey), principalId: actor, action: "admin.routine.cancel", detail: { id: a.id, cancelled } });
        return jsonResult({ ok: true, cancelled, org: a.org, surfaceKey: a.surfaceKey, id: a.id });
      } catch (e) {
        return errorResult(`cancel_routine failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
