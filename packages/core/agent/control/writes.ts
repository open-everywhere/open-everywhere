import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { scopeDenial } from "./auth.js";
import { assertSafeRelPath } from "./views.js";
import { getConfig } from "../access/config.js";
import { providerById } from "../memory/provider.js";
import { siloTier } from "../memory/store.js";
import { controlPartition } from "../memory/partition.js";
import { deleteDomainSkill } from "../skills/domain-skills.js";
import { isModelUsable, reasoningRank } from "../model/policy.js";
import { reasoningCeilingForDomain } from "../memory/domain.js";
import { stampHumanEdit } from "../memory/provenance.js";
import { resolveApprovalClick, isDomainLevelSpendCap } from "../approvals/flow.js";
import { whereFromScope as approvalWhereFromScope } from "../approvals/actions.js";

export const CONTROL_WRITE_TOOL_NAMES = [
  "set_spend_limit",
  "clear_spend_limit",
  "revoke_connector",
  "clear_connector_override",
  "cancel_routine",
  "delete_skill",
  "memory_write_file",
  "memory_delete_file",
  "set_domain_model",
  "clear_domain_model",
  "decide_pending_action",
] as const;

const REASONING_LEVELS: ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"] = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const MEMORY_WRITE_MAX_BYTES = 64 * 1024;

export function assertMemoryFileWritable(relPath: string, content?: string): void {
  const base = relPath.split("/").pop() ?? relPath;
  if (base.startsWith("_")) {
    throw new Error(`"${relPath}" looks like a host-internal operational marker (a "_"-prefixed name, e.g. "_onboarded") — refusing to touch it from the control plane.`);
  }
  if (!/\.(md|txt)$/i.test(relPath)) {
    throw new Error(`"${relPath}" must be a ".md" or ".txt" file (memory content only).`);
  }
  if (content !== undefined && Buffer.byteLength(content, "utf-8") > MEMORY_WRITE_MAX_BYTES) {
    throw new Error(`"${relPath}" is ${Buffer.byteLength(content, "utf-8")} bytes, over the ${MEMORY_WRITE_MAX_BYTES / 1024}KB control-plane write cap.`);
  }
}

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

export function registerControlWriteTools(server: McpServer, actor: string, roles: readonly string[] = ["admin"]): void {
  const store = () => getOperationalStore();

  server.registerTool(
    "set_spend_limit",
    {
      title: "Set spend limit",
      description: "Set a monthly budget override for a scope (overlays the config caps) — a token count (monthlyTokens) and/or a USD amount (monthlyUsd); at least one is required. level=surface uses a surfaceKey 'platform/workspace/surface'; level=workspace uses 'platform/workspace'. Takes effect immediately, no redeploy; replaces any previous override at the same scope+level. An override is a TEMPORARY BRIDGE: pass ttlSeconds so it auto-reverts to the config cap (recommended — a raised cap should land in the spend-budgets registry via PR; an un-reconciled override drifts from git). reason is surfaced in the drift view (list_overrides).",
      inputSchema: {
        org: z.string().min(1),
        scopeKey: z.string().min(1),
        level: z.enum(["surface", "workspace"]),
        monthlyTokens: z.number().int().positive().optional(),
        monthlyUsd: z.number().positive().optional(),
        ttlSeconds: z.number().int().positive().optional(),
        reason: z.string().optional(),
      },
    },
    async (a) => {
      const denial = scopeDenial(roles, { org: a.org, surfaceKey: a.scopeKey });
      if (denial) return errorResult(denial);
      if (a.monthlyTokens == null && a.monthlyUsd == null) {
        return errorResult("set_spend_limit needs monthlyTokens and/or monthlyUsd — an override must set at least one cap component.");
      }
      try {
        const expiresAt = a.ttlSeconds != null ? Date.now() + a.ttlSeconds * 1000 : undefined;
        await store().setSpendLimit(a.org, a.scopeKey, a.level, { monthlyTokens: a.monthlyTokens, monthlyUsd: a.monthlyUsd }, { expiresAt, reason: a.reason, setBy: actor });
        const amounts = { ...(a.monthlyTokens != null ? { monthlyTokens: a.monthlyTokens } : {}), ...(a.monthlyUsd != null ? { monthlyUsd: a.monthlyUsd } : {}) };
        await appendAudit({ ...whereFromScope(a.org, a.scopeKey), principalId: actor, action: "admin.spend.set_limit", detail: { scopeKey: a.scopeKey, level: a.level, ...amounts, ...(expiresAt != null ? { expiresAt } : {}), ...(a.reason ? { reason: a.reason } : {}) } });
        return jsonResult({ ok: true, org: a.org, scopeKey: a.scopeKey, level: a.level, ...amounts, ...(expiresAt != null ? { expiresAt } : {}) });
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
      const denial = scopeDenial(roles, { org: a.org, surfaceKey: a.scopeKey });
      if (denial) return errorResult(denial);
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
      const denial = scopeDenial(roles, { org: a.org, surfaceKey: a.surfaceKey });
      if (denial) return errorResult(denial);
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
      const denial = scopeDenial(roles, { org: a.org, surfaceKey: a.surfaceKey });
      if (denial) return errorResult(denial);
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
      const denial = scopeDenial(roles, { org: a.org, surfaceKey: a.surfaceKey });
      if (denial) return errorResult(denial);
      try {
        const cancelled = await store().removeRoutine(a.org, a.surfaceKey, a.id);
        await appendAudit({ ...whereFromScope(a.org, a.surfaceKey), principalId: actor, action: "admin.routine.cancel", detail: { id: a.id, cancelled } });
        return jsonResult({ ok: true, cancelled, org: a.org, surfaceKey: a.surfaceKey, id: a.id });
      } catch (e) {
        return errorResult(`cancel_routine failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "decide_pending_action",
    {
      title: "Decide a pending approval (approve / deny)",
      description:
        "Out-of-band twin of the Slack/Discord approval-card click: approve or deny a pending action by id (pending_actions_list for the ids + summaries) without a chat button — for a headless consumer or an admin driving the MCP. Approve EXECUTES the frozen args; deny rejects them. Reuses the ONE cross-surface decide core (approvals/flow.ts) — same CAS-decide, so a double-decide is safe (returns outcome:\"already-decided\", not an error) and approve semantics can never drift from the click path. RBAC: a control role must cover the pending's frozen scope (org \"admin\", or a covering \"domain:<name>\"); a DOMAIN-LEVEL spend cap is org-admin-only (a domain admin must never raise their own budget). The control identity is recorded as the decider.",
      inputSchema: { org: z.string().min(1), id: z.string().min(1), decision: z.enum(["approve", "deny"]) },
    },
    async (a) => {
      try {
        const row = await store().getPendingAction(a.org, a.id);
        if (!row) {
          return errorResult(`decide_pending_action: no pending action "${a.id}" in org "${a.org}" (already decided and aged out, wrong org, or never existed).`);
        }
        const denial = isDomainLevelSpendCap(row)
          ? roles.includes("admin")
            ? null
            : `forbidden: a domain-level spend cap is org-admin-only (have: ${roles.length ? roles.join(", ") : "none"}; need "admin").`
          : scopeDenial(roles, { org: a.org, surfaceKey: row.scopeKey, domain: row.domain ?? undefined });
        if (denial) return errorResult(denial);

        const res = await resolveApprovalClick({
          org: a.org,
          id: a.id,
          decision: a.decision === "approve" ? "approve" : "reject",
          clickerId: actor,
          platformAdmin: () => true,
        });

        switch (res.outcome) {
          case "unknown":
            return errorResult(`decide_pending_action: pending action "${a.id}" is no longer known (decided and aged out between read and decide).`);
          case "unregistered-kind":
            return errorResult(`decide_pending_action: pending action "${a.id}" has no registered ActionKind ("${row.kind}") — cannot decide.`);
          case "denied":
            return errorResult(`decide_pending_action: not authorized to decide "${a.id}".`);
          case "not-pending":
          case "lost-race":
            return jsonResult({ ok: true, outcome: "already-decided", org: a.org, id: a.id });
          case "expired":
          case "expired-race":
            return jsonResult({ ok: true, outcome: "expired", org: a.org, id: a.id });
          case "decided": {
            await appendAudit({
              ...approvalWhereFromScope(a.org, row.scopeKey),
              principalId: actor,
              action: "admin.approval.decide",
              detail: { id: a.id, kind: row.kind, decision: res.row.status, outcome: res.outcomeLine },
            });
            return jsonResult({ ok: true, outcome: "decided", org: a.org, id: a.id, kind: row.kind, decision: res.row.status, decidedBy: res.row.decidedBy, result: res.outcomeLine });
          }
        }
        return errorResult(`decide_pending_action: unexpected resolution for "${a.id}".`);
      } catch (e) {
        return errorResult(`decide_pending_action failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "delete_skill",
    {
      title: "Delete a domain skill (break-glass)",
      description:
        "Break-glass removal of a runtime domain skill (agent/skills/domain-skills.ts) without needing Slack channel membership — the out-of-band twin of the in-channel delete_skill agent tool. Requires a domain:<name> role covering the domain (or org-wide \"admin\"). Returns deleted=false if no such skill existed.",
      inputSchema: { org: z.string().min(1), domain: z.string().min(1), name: z.string().min(1) },
    },
    async (a) => {
      const denial = scopeDenial(roles, { org: a.org, domain: a.domain });
      if (denial) return errorResult(denial);
      try {
        const deleted = await deleteDomainSkill(a.org, a.domain, a.name);
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "skill.delete", detail: { domain: a.domain, name: a.name, deleted } });
        return jsonResult({ ok: true, deleted, org: a.org, domain: a.domain, name: a.name });
      } catch (e) {
        return errorResult(`delete_skill failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "set_domain_model",
    {
      title: "Set a domain's model / reasoning pick",
      description:
        "Runtime SELF-SERVE of a domain's model id and/or reasoning effort — the free CHOICE within the org's model-policy envelope (agent/model/policy.ts is the git-config allow-list/ceiling; this is the per-domain runtime pick layered under it, see docs/deploy/configuration-reference.md \"Model policy\"). Requires a DOMAIN ADMIN of `domain` (or org-wide admin) — the one control-plane write a domain admin, not just an org admin, may make on their own domain. modelId must be usable under the org's model policy (allow-listed and not provider-denied — any id if no policy is configured); reasoning must be at/under the domain's effective reasoning ceiling. At least one of modelId/reasoning is required. Takes effect immediately (no redeploy, no session restart needed); replaces any previous pick for the domain wholesale. clear_domain_model reverts to the git-config route.",
      inputSchema: {
        org: z.string().min(1),
        domain: z.string().min(1),
        modelId: z.string().min(1).optional(),
        reasoning: z.enum(REASONING_LEVELS).optional(),
      },
    },
    async (a) => {
      const denial = scopeDenial(roles, { org: a.org, domain: a.domain });
      if (denial) return errorResult(denial);
      if (a.modelId == null && a.reasoning == null) {
        return errorResult("set_domain_model needs modelId and/or reasoning — a pick must set at least one.");
      }
      try {
        const domains = getConfig().loadDomains();
        const target = domains.find((d) => d.name === a.domain);
        if (!target) return errorResult(`set_domain_model failed: no domain named "${a.domain}" is configured.`);
        const policy = getConfig().loadModelPolicy?.();
        if (a.modelId !== undefined && !isModelUsable(a.modelId, policy)) {
          return errorResult(`set_domain_model failed: model "${a.modelId}" is not usable under the org model policy (not allow-listed, or its vendor is provider-denied).`);
        }
        if (a.reasoning !== undefined && policy) {
          const rolesCfg = getConfig().loadRoles?.() ?? [];
          const ceiling = reasoningCeilingForDomain(a.domain, domains, rolesCfg, policy.reasoningCeiling ?? "medium");
          if (reasoningRank(a.reasoning) > reasoningRank(ceiling)) {
            return errorResult(`set_domain_model failed: reasoning "${a.reasoning}" exceeds domain "${a.domain}"'s effective reasoning ceiling "${ceiling}".`);
          }
        }
        await store().setDomainModel(a.org, a.domain, { modelId: a.modelId, reasoning: a.reasoning }, actor);
        const picked = { ...(a.modelId ? { modelId: a.modelId } : {}), ...(a.reasoning ? { reasoning: a.reasoning } : {}) };
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "admin.model.set_domain", detail: { domain: a.domain, ...picked } });
        return jsonResult({ ok: true, org: a.org, domain: a.domain, ...picked });
      } catch (e) {
        return errorResult(`set_domain_model failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "clear_domain_model",
    {
      title: "Clear a domain's model pick",
      description: "Remove a domain's runtime model/reasoning pick (reverts to the git-config route). Requires a domain admin of `domain` (or org-wide admin). Returns cleared=false if no pick was set.",
      inputSchema: { org: z.string().min(1), domain: z.string().min(1) },
    },
    async (a) => {
      const denial = scopeDenial(roles, { org: a.org, domain: a.domain });
      if (denial) return errorResult(denial);
      try {
        const cleared = await store().clearDomainModel(a.org, a.domain);
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "admin.model.clear_domain", detail: { domain: a.domain, cleared } });
        return jsonResult({ ok: true, cleared, org: a.org, domain: a.domain });
      } catch (e) {
        return errorResult(`clear_domain_model failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const requireAdmin = (): string | null =>
    roles.includes("admin")
      ? null
      : `forbidden: memory writes require the org-wide "admin" role (v1 — domain roles get memory_list/memory_read only; have: ${roles.length ? roles.join(", ") : "none"}).`;

  server.registerTool(
    "memory_write_file",
    {
      title: "Write a memory file (full-file replace)",
      description:
        "Full-file replace of one file inside one memory silo (creates it if absent). ADMIN ONLY (v1) — an org admin IS the approver here, unlike the dream cycle's propose-only gate for the untrusted-autonomous agent. `.md`/`.txt` only, 64KB cap, refuses a `_`-prefixed operational marker (e.g. `_onboarded`). Stamps an in-file human-edit marker (edited_by/edited_at) so the dream cycle never treats this write as agent drift. Audited (`memory.write`) and committed with a `control-plane edit by <subject>` message.",
      inputSchema: { org: z.string().min(1), silo: z.string().min(1), relPath: z.string().min(1), content: z.string() },
    },
    async (a) => {
      const denial = requireAdmin();
      if (denial) return errorResult(denial);
      try {
        assertSafeRelPath(a.relPath);
        assertMemoryFileWritable(a.relPath, a.content);
        const silo = getConfig()
          .loadSilos()
          .find((s) => s.name === a.silo);
        if (!silo) return errorResult(`memory_write_file failed: no memory silo named "${a.silo}".`);
        const provider = providerById(silo.provider);
        const p = controlPartition(a.org);
        const tier = siloTier(silo.name);
        const files = await provider.readTier(p, tier, silo);
        files[a.relPath] = stampHumanEdit(a.content);
        const commit = await provider.writeTier(p, tier, files, `control-plane edit by ${actor}`, silo);
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "memory.write", detail: { silo: a.silo, relPath: a.relPath, bytes: Buffer.byteLength(a.content, "utf-8"), commit } });
        return jsonResult({ ok: true, org: a.org, silo: a.silo, relPath: a.relPath, commit });
      } catch (e) {
        return errorResult(`memory_write_file failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "memory_delete_file",
    {
      title: "Delete a memory file",
      description:
        "Delete one file from one memory silo. ADMIN ONLY (v1), same posture as memory_write_file. Refuses a `_`-prefixed operational marker. Returns deleted=false if the file wasn't there. Audited (`memory.delete`) and committed with a `control-plane edit by <subject>` message.",
      inputSchema: { org: z.string().min(1), silo: z.string().min(1), relPath: z.string().min(1) },
    },
    async (a) => {
      const denial = requireAdmin();
      if (denial) return errorResult(denial);
      try {
        assertSafeRelPath(a.relPath);
        assertMemoryFileWritable(a.relPath);
        const silo = getConfig()
          .loadSilos()
          .find((s) => s.name === a.silo);
        if (!silo) return errorResult(`memory_delete_file failed: no memory silo named "${a.silo}".`);
        const provider = providerById(silo.provider);
        if (!provider.deleteFile) {
          return errorResult(`memory_delete_file failed: the "${provider.id}" memory backend doesn't support single-file deletion yet (silo "${a.silo}").`);
        }
        let commit: string | null;
        try {
          commit = await provider.deleteFile(controlPartition(a.org), siloTier(silo.name), a.relPath, silo);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await appendAudit({
            org: a.org,
            platform: "control",
            workspace: "control",
            principalId: actor,
            action: "memory.delete",
            detail: { silo: a.silo, relPath: a.relPath, deleted: false, error: message },
          });
          return errorResult(`memory_delete_file failed: ${message}`);
        }
        const deleted = commit !== null;
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "memory.delete", detail: { silo: a.silo, relPath: a.relPath, deleted, ...(commit ? { commit } : {}) } });
        return jsonResult({ ok: true, deleted, org: a.org, silo: a.silo, relPath: a.relPath, commit });
      } catch (e) {
        return errorResult(`memory_delete_file failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
