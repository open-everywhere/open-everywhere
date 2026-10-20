import { auditErrorDetail, scrubAuditText } from "../audit/tool-action.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOperationalStore } from "../operational/provider.js";
import { CAP_LEVELS } from "../operational/store.js";
import { appendAudit } from "../audit/audit.js";
import { foreignOrgDenial, scopeDenial } from "./auth.js";
import { deploymentOrg } from "../identity/binding.js";
import { assertSafeRelPath } from "./views.js";
import { getConfig } from "../access/config.js";
import { providerById } from "../memory/provider.js";
import { siloAccess } from "../memory/resolve.js";
import { siloTier } from "../memory/store.js";
import { controlPartition } from "../memory/partition.js";
import { deleteDomainSkill } from "../skills/domain-skills.js";
import { isModelUsable, reasoningRank } from "../model/policy.js";
import { modelPricing } from "../spend/pricing.js";
import { reasoningCeilingForDomain } from "../memory/domain.js";
import { stampHumanEdit } from "../memory/provenance.js";
import { writeMemoryTier } from "../memory/write-road.js";
import { resolveApprovalClick, isOrgAdminOnlySpendCap } from "../approvals/flow.js";
import { disarmApprovalJudge, rearmApprovalJudge } from "../approvals/judge-contradiction.js";
import { orgWideWhere, whereFromScope } from "../approvals/actions.js";
import { haltAddressFields, haltAddressFromParts } from "../access/halt.js";
import { conversationGrantRoomPrefix, grantReach } from "../approvals/session-grant.js";
import { routinePermissionKeyParts } from "../routines/permission-key.js";
import { reopenSlackSetupPage } from "../channels/slack-bridge.js";
import { listLinkSetsWithIds, purgeLinkSetCredentials, revokeLinkSet, setLinkSetHold } from "../identity/link-store.js";
import { directoryProvider } from "../identity/directory.js";
import { directoryMode, directoryObserveRefusal, lastDirectorySync, syncDirectoryOrg } from "../identity/directory-sync.js";
import { DIRECTORY_PREVIEW_DEFAULT_PEOPLE, DIRECTORY_PREVIEW_MAX_PEOPLE, previewDirectoryOrg } from "../identity/directory-preview.js";
import { directoryGroupAllowlist, groupPlanIsNoop, planDirectoryGroups, planOverlayContent, renderGroupPlan } from "../identity/group-sync.js";
import { directoryGroupsOf } from "../identity/groups-codemod.js";
import { deliverGroupsOverlay } from "../identity/groups-delivery.js";
import { ENV_ADOPT_MAX_NAMES, runEnvAdoptDoor } from "../credentials/env-adopt.js";

export const CONTROL_WRITE_TOOL_NAMES = [
  "set_spend_limit",
  "clear_spend_limit",
  "revoke_connector",
  "clear_connector_override",
  "revoke_session_grants",
  "cancel_routine",
  "delete_skill",
  "memory_write_file",
  "memory_delete_file",
  "set_domain_model",
  "clear_domain_model",
  "decide_pending_action",
  "disarm_approval_judge",
  "rearm_approval_judge",
  "halt",
  "resume",
  "link_sets_list",
  "suspend_link_set",
  "reactivate_link_set",
  "revoke_link_set",
  "purge_link_set_credentials",
  "directory_sync_now",
  "directory_sync_status",
  "directory_sync_preview",
  "directory_groups_plan",
  "reopen_slack_setup",
  "adopt_env_secrets",
] as const;

const judgeOperatorScopeSchema = z
  .object({
    org: z.string().min(1),
    domain: z.string().min(1).optional(),
    orgWide: z.literal(true).optional(),
  })
  .refine((a) => (a.domain === undefined) !== (a.orgWide === undefined), {
    message:
      'name exactly one address: "domain" for one domain, or "orgWide": true for the domain-less consults — never both, never neither.',
  });

type JudgeOperatorScopeArgs = z.infer<typeof judgeOperatorScopeSchema>;

function judgeOperatorScopeRequest(a: JudgeOperatorScopeArgs): { org: string; domain?: string } {
  return a.domain === undefined ? { org: a.org } : { org: a.org, domain: a.domain };
}

function judgeOperatorOrgDenial(a: JudgeOperatorScopeArgs): string | undefined {
  const mine = deploymentOrg();
  if (a.org === mine) return undefined;
  return `org "${a.org}" is not this deployment's org ("${mine}"). The approval judge's disarm state is read per org, so a row written under another org would be found by no consult — the call is refused rather than silently doing nothing.`;
}

function judgeOperatorAddress(a: JudgeOperatorScopeArgs): { domain: string } | { orgWide: true } {
  return a.domain === undefined ? { orgWide: true } : { domain: a.domain };
}

const haltOperatorScopeFields = {
  org: z.string().min(1),
  level: z.enum(CAP_LEVELS).optional(),
  scopeKey: z.string().min(1).optional(),
  orgWide: z.literal(true).optional(),
} as const;

function refineHaltOperatorScope<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema
  .refine((raw) => {
    const a = raw as { level?: unknown; scopeKey?: unknown };
    return (a.level === undefined) === (a.scopeKey === undefined);
  }, {
    message: 'an addressed halt needs BOTH "level" and "scopeKey" — a level with no key addresses nothing.',
  })
  .refine((raw) => {
    const a = raw as { level?: unknown; orgWide?: unknown };
    return (a.level === undefined) !== (a.orgWide === undefined);
  }, {
    message: 'name exactly one address: a ("level", "scopeKey") pair, or "orgWide": true for the whole org — never both, never neither.',
  });
}

const haltOwnershipSchema = z.object({ setAt: z.string().datetime(), setBy: z.string().min(1).optional(), setRef: z.string().min(1).optional() });
const haltOperatorScopeSchema = refineHaltOperatorScope(z.object(haltOperatorScopeFields));
const resumeOperatorScopeSchema = refineHaltOperatorScope(z.object({ ...haltOperatorScopeFields, expected: haltOwnershipSchema.optional() }));

const spendOwnershipSchema = z
  .object({
    monthlyTokens: z.number().int().positive().optional(),
    monthlyUsd: z.number().positive().optional(),
    expiresAt: z.number().int(),
    reason: z.string().min(1),
    setBy: z.string().min(1),
  })
  .refine((a) => a.monthlyTokens != null || a.monthlyUsd != null, {
    message: "an owned spend row needs monthlyTokens and/or monthlyUsd",
  });

type HaltOperatorScopeArgs = z.infer<typeof haltOperatorScopeSchema>;

function haltOperatorScopeRequest(a: HaltOperatorScopeArgs): { org: string; domain?: string } {
  return a.level === "domain" && a.scopeKey !== undefined ? { org: a.org, domain: a.scopeKey } : { org: a.org };
}

function haltOperatorOrgDenial(a: HaltOperatorScopeArgs): string | undefined {
  const mine = deploymentOrg();
  if (a.org === mine) return undefined;
  return `org "${a.org}" is not this deployment's org ("${mine}"). Every halt arrow reads the halt rows for its own org, so a row written under another org would stop nothing — the call is refused rather than silently doing nothing.`;
}

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

function assertMemoryFileWritable(relPath: string, content?: string): void {
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
        ifAbsent: z.literal(true).optional(),
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
        const created = await store().setSpendLimit(
          a.org,
          a.scopeKey,
          a.level,
          { monthlyTokens: a.monthlyTokens, monthlyUsd: a.monthlyUsd },
          { expiresAt, reason: a.reason, setBy: actor },
          ...(a.ifAbsent ? [{ ifAbsent: true } as const] : []),
        );
        const amounts = { ...(a.monthlyTokens != null ? { monthlyTokens: a.monthlyTokens } : {}), ...(a.monthlyUsd != null ? { monthlyUsd: a.monthlyUsd } : {}) };
        if (!created) return jsonResult({ ok: true, created: false, org: a.org, scopeKey: a.scopeKey, level: a.level });
        await appendAudit({ ...whereFromScope(a.org, a.scopeKey), principalId: actor, action: "admin.spend.set_limit", detail: { scopeKey: a.scopeKey, level: a.level, ...amounts, ...(expiresAt != null ? { expiresAt } : {}), ...(a.reason ? { reason: a.reason } : {}) } });
        return jsonResult({ ok: true, created: true, org: a.org, scopeKey: a.scopeKey, level: a.level, ...amounts, ...(expiresAt != null ? { expiresAt } : {}), ...(a.reason ? { reason: a.reason } : {}), setBy: actor });
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
      inputSchema: { org: z.string().min(1), scopeKey: z.string().min(1), level: z.enum(["surface", "workspace"]), expected: spendOwnershipSchema.optional() },
    },
    async (a) => {
      const denial = scopeDenial(roles, { org: a.org, surfaceKey: a.scopeKey });
      if (denial) return errorResult(denial);
      try {
        const cleared = await store().clearSpendLimit(a.org, a.scopeKey, a.level, a.expected);
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
    "revoke_session_grants",
    {
      title: "Revoke a routine's standing grants or a room's unspent approvals (break-glass)",
      description:
        "Break-glass. A click in a conversation approves one act and keeps no grant, so a conversation never holds a standing grant. Pass sessionId = the grant key of a routine of this room (surfaceKey is the routine's own room) to withdraw that routine's standing grants: its \"Approve for this routine (up to N h)\" grant and its DECLARED permissions (the `connector.tool:` rows), so the routine's next PR-open or unattended connector write gets a card or is refused and asks again. Without sessionId it withdraws every connector-op approval a click gave in the room that the agent has not spent yet (one call each). surfaceKey is 'platform/workspace/surface' of the ROOM: a Discord thread or a Teams reply chain is reached through its parent channel. Narrowing only — it can never grant. Note what it does NOT do: a grant only skips the human card, so this does not remove any capability; to cut ACCESS use revoke_connector. revoked counts the memos deleted; 0 means there were none. reason is recorded in the audit row.",
      inputSchema: {
        org: z.string().min(1),
        surfaceKey: z.string().min(1),
        sessionId: z.string().min(1).optional(),
        reason: z.string().optional(),
      },
    },
    async (a) => {
      const denial = scopeDenial(roles, { org: a.org, surfaceKey: a.surfaceKey });
      if (denial) return errorResult(denial);
      try {
        let revoked: number;
        let target: string;
        if (a.sessionId) {
          const reach = grantReach(a.sessionId);
          if (reach === "routine") {
            const parts = routinePermissionKeyParts(a.sessionId);
            const routine = parts === undefined ? null : await store().getRoutine(a.org, a.surfaceKey, parts.routineId);
            if (routine === null || routine.surfaceKey !== a.surfaceKey) {
              return errorResult(
                `revoke_session_grants: sessionId "${a.sessionId}" is not the grant key of a routine of "${a.surfaceKey}". ` +
                  `Pass the surfaceKey of the room that owns the routine (routines_list shows it).`,
              );
            }
          } else if (!a.sessionId.startsWith(conversationGrantRoomPrefix(a.surfaceKey))) {
            return errorResult(
              `revoke_session_grants: sessionId "${a.sessionId}" is not a grant key of "${a.surfaceKey}". ` +
                `Pass a routine grant key of this room, a key that starts with "${conversationGrantRoomPrefix(a.surfaceKey)}", or omit sessionId to revoke every unspent approval in the room.`,
            );
          }
          target = a.sessionId;
          revoked = await store().revokeSessionApprovals(a.org, a.sessionId);
        } else {
          target = conversationGrantRoomPrefix(a.surfaceKey);
          revoked = await store().revokeSessionApprovalsByPrefix(a.org, target);
        }
        await appendAudit({
          ...whereFromScope(a.org, a.surfaceKey),
          principalId: actor,
          action: "admin.session_grants.revoke",
          detail: { surfaceKey: a.surfaceKey, ...(a.sessionId ? { sessionId: a.sessionId } : { prefix: target }), revoked, ...(a.reason ? { reason: a.reason } : {}) },
        });
        return jsonResult({ ok: true, org: a.org, surfaceKey: a.surfaceKey, ...(a.sessionId ? { sessionId: a.sessionId } : { prefix: target }), revoked });
      } catch (e) {
        return errorResult(`revoke_session_grants failed: ${e instanceof Error ? e.message : String(e)}`);
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
        "Out-of-band twin of the Slack/Discord approval-card click: approve or deny a pending action by id (pending_actions_list for the ids + summaries) without a chat button — for a headless consumer or an admin driving the MCP. Approve EXECUTES the frozen args; deny rejects them. Reuses the ONE cross-surface decide core (approvals/flow.ts) — same CAS-decide, so a double-decide is safe (returns outcome:\"already-decided\", not an error) and approve semantics can never drift from the click path. RBAC: a control role must cover the pending's frozen scope (org \"admin\", or a covering \"domain:<name>\"); a DOMAIN-LEVEL or PER-USER spend cap is org-admin-only (a domain admin must never raise their own budget, nor one named person's allowance). The control identity is recorded as the decider.",
      inputSchema: { org: z.string().min(1), id: z.string().min(1), decision: z.enum(["approve", "deny"]) },
    },
    async (a) => {
      try {
        const foreign = foreignOrgDenial(a.org);
        if (foreign) return errorResult(foreign);
        const row = await store().getPendingAction(a.org, a.id);
        if (!row) {
          return errorResult(`decide_pending_action: no pending action "${a.id}" in org "${a.org}" (already decided and aged out, or never existed).`);
        }
        const denial = isOrgAdminOnlySpendCap(row)
          ? roles.includes("admin")
            ? null
            : `forbidden: a domain-level or per-user spend cap is org-admin-only (have: ${roles.length ? roles.join(", ") : "none"}; need "admin").`
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
          case "clicker-denied":
            return errorResult(`decide_pending_action: the click for "${a.id}" was refused (${res.reason}).`);
          case "halted":
            return errorResult(`decide_pending_action: ${res.notice}`);
          case "contradicted":
            return errorResult(`decide_pending_action: "${a.id}" resolved as a judge contradiction, which this tool never requests.`);
          case "not-pending":
          case "lost-race":
            return jsonResult({ ok: true, outcome: "already-decided", org: a.org, id: a.id });
          case "expired":
          case "expired-race":
            return jsonResult({ ok: true, outcome: "expired", org: a.org, id: a.id });
          case "decided": {
            await appendAudit({
              ...whereFromScope(a.org, row.scopeKey),
              principalId: actor,
              action: "admin.approval.decide",
              detail: { id: a.id, kind: row.kind, decision: res.row.status, outcome: scrubAuditText(res.outcomeLine) },
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
    "disarm_approval_judge",
    {
      title: "Disarm the approval judge for a domain or org-wide (break-glass)",
      description:
        "Turn the LLM approval judge OFF for one address, now. The judge lifts explicitly defer-flipped gated verbs without a card (agent/access/approval-judge.ts), and an operator is the only thing that disarms it — no volume of human overrules does. Name EXACTLY ONE address: `domain` for one domain, or `orgWide: true` for the DOMAIN-LESS consults. 🔴 KNOW THE BLAST RADIUS OF `orgWide`: it covers every defer-flipped propose that carries no domain, which today means `pr.open` and `routine.create` always, `spend.set` on every user-level cap and on any scope no domain claims, and `memory.purge` / `access.request` from any surface with no domain (a DM, for one). It is NOT a wildcard: it reaches no domained consult, and there is deliberately no \"disarm everywhere at once\" switch. Effect: every defer-flipped verb at that address falls back to its last-resort approval card, which is the pre-judge behaviour — the degrade never widens access. Recorded as one `approval.judge.contradicted` audit row (humanAction \"admin-disarm\"). It LASTS UNTIL AN OPERATOR RE-ARMS with `rearm_approval_judge`; no clock lifts it. `domain` requires a role covering the domain (a domain:<name> role, or org-wide \"admin\"); `orgWide` is an unscoped ask and requires \"admin\". \ud83d\udd34 `org` MUST be this deployment's own org: the judge's disarm state is read per org (OPE-1368), so a row written under any other string would be found by no consult \u2014 the call is refused by name rather than reporting success for a no-op.",
      inputSchema: judgeOperatorScopeSchema,
    },
    async (a) => {
      const denial = judgeOperatorOrgDenial(a) ?? scopeDenial(roles, judgeOperatorScopeRequest(a));
      if (denial) return errorResult(denial);
      const address = judgeOperatorAddress(a);
      try {
        await disarmApprovalJudge({ org: a.org, principalId: actor, ...address });
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "admin.approval.judge_disarm", detail: { ...address } });
        return jsonResult({ ok: true, org: a.org, ...address, disarmed: true });
      } catch (e) {
        return errorResult(`disarm_approval_judge failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "rearm_approval_judge",
    {
      title: "Re-arm the approval judge for a domain or org-wide",
      description:
        "Turn the LLM approval judge back ON for one address, now — the symmetric partner of `disarm_approval_judge` and the only thing that cancels a disarm. Name EXACTLY ONE address, the same two the disarm takes: `domain`, or `orgWide: true` for the DOMAIN-LESS consults. Effect: defer-flipped verbs at that address are judged again, exactly as before the disarm; an address that was never disarmed is already armed and this call changes nothing. 🔴 THIS DIRECTION IS PERMISSIVE, so know the blast radius of `orgWide` before using it: it restores card-free auto-approval on every defer-flipped propose that carries no domain — `pr.open` and `routine.create` always, `spend.set` on every user-level cap and on any scope no domain claims, and `memory.purge` / `access.request` from any surface with no domain. 🔴 The two addresses are a strict partition: an org-wide re-arm restores the domain-less consults ONLY, and never a domain another operator disarmed. Recorded as one `approval.judge.contradicted` audit row (humanAction \"admin-rearm\"). The ledger is APPEND-ONLY: this cancels the operator's disarm and erases nothing — every human overrule stays in the trail, and overrules drive no automatic behaviour to suppress. `domain` requires a role covering the domain (a domain:<name> role, or org-wide \"admin\"); `orgWide` is an unscoped ask and requires \"admin\". \ud83d\udd34 `org` MUST be this deployment's own org: the judge's disarm state is read per org (OPE-1368), so a row written under any other string would be found by no consult \u2014 the call is refused by name rather than reporting success for a no-op.",
      inputSchema: judgeOperatorScopeSchema,
    },
    async (a) => {
      const denial = judgeOperatorOrgDenial(a) ?? scopeDenial(roles, judgeOperatorScopeRequest(a));
      if (denial) return errorResult(denial);
      const address = judgeOperatorAddress(a);
      try {
        await rearmApprovalJudge({ org: a.org, principalId: actor, ...address });
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "admin.approval.judge_rearm", detail: { ...address } });
        return jsonResult({ ok: true, org: a.org, ...address, rearmed: true });
      } catch (e) {
        return errorResult(`rearm_approval_judge failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "halt",
    {
      title: "Halt everything consequential at one address (break-glass)",
      description:
        "Stop every consequential act at one address, now. While halted: no gated verb passes the approver chain, no routine fires on either leg, no connector op through a connected integration and no borrowed credential grant is spendable, the sandbox firewall is deny-all, and `web_fetch`, `web_search` and every `assertEgressReach` fetch are refused. 🔴 A HALT PAUSES ACTS, NOT READING. A consequential act is one whose effect leaves the conversation, so the agent still reads, still replies, still delegates a read to a worker, still posts a file into the asking room and still keeps that room in memory — and it says that it is halted. Do not read this verb as an information blackout: it is not one, and telling a seat otherwise stops work nobody stopped (OPE-1758). Name EXACTLY ONE address: a (`level`, `scopeKey`) pair — level is one of surface/workspace/domain/user, scopeKey the matching scope key — or `orgWide: true` for the whole org. Halted if ANY covering row is active, so an org-wide halt covers everything regardless of the addressed rows. It LASTS UNTIL SOMEBODY RESUMES; no clock lifts it. 🔴 `org` MUST be this deployment's own org, or the call is refused by name rather than writing a row no arrow would read.",
      inputSchema: haltOperatorScopeSchema,
    },
    async (a) => {
      const denial = haltOperatorOrgDenial(a) ?? scopeDenial(roles, haltOperatorScopeRequest(a));
      if (denial) return errorResult(denial);
      try {
        const address = haltAddressFromParts(a);
        await getOperationalStore().setHalt(a.org, address, { setBy: actor });
        await appendAudit({
          ...(address.orgWide ? orgWideWhere(a.org) : whereFromScope(a.org, address.scopeKey)),
          principalId: actor,
          action: "admin.halt.set",
          detail: { ...haltAddressFields(address), door: "control-mcp" },
        });
        return jsonResult({ ok: true, org: a.org, ...haltAddressFields(address), halted: true });
      } catch (e) {
        return errorResult(`halt failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "resume",
    {
      title: "Lift the break-glass halt at one address",
      description:
        "Lift a halt at one address, now — the symmetric partner of `halt` and the door that works when the in-chat one does not (that one is carded and needs an admin present). It restores the consequential acts `halt` paused; reading and replying never stopped, so nothing about them changes here. Name EXACTLY ONE address, the same two `halt` takes: a (`level`, `scopeKey`) pair, or `orgWide: true`. 🔴 The addresses are a strict partition: lifting the org-wide halt does not lift an addressed one, and vice versa — if both cover a call, both must be resumed. `cleared: false` means nothing was halted there; that is not an error. 🔴 `org` MUST be this deployment's own org.",
      inputSchema: resumeOperatorScopeSchema,
    },
    async (a) => {
      const denial = haltOperatorOrgDenial(a) ?? scopeDenial(roles, haltOperatorScopeRequest(a));
      if (denial) return errorResult(denial);
      try {
        const address = haltAddressFromParts(a);
        const cleared = await getOperationalStore().clearHalt(a.org, address, { clearedBy: actor }, a.expected);
        await appendAudit({
          ...(address.orgWide ? orgWideWhere(a.org) : whereFromScope(a.org, address.scopeKey)),
          principalId: actor,
          action: "admin.halt.cleared",
          detail: { ...haltAddressFields(address), door: "control-mcp", cleared },
        });
        return jsonResult({ ok: true, org: a.org, ...haltAddressFields(address), cleared });
      } catch (e) {
        return errorResult(`resume failed: ${e instanceof Error ? e.message : String(e)}`);
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
        "Runtime SELF-SERVE of a domain's model id and/or reasoning effort — the free CHOICE within the org's model-policy envelope (agent/model/policy.ts is the git-config allow-list/ceiling; this is the per-domain runtime pick layered under it, see docs/deploy/configuration-reference.md \"Model policy\"). Requires a DOMAIN ADMIN of `domain` (or org-wide admin) — the one control-plane write a domain admin, not just an org admin, may make on their own domain. modelId must be usable under the org's model policy (allow-listed and not provider-denied — any id if no policy is configured); reasoning must be at/under the domain's effective reasoning ceiling. At least one of modelId/reasoning is required. Takes effect immediately (no redeploy, no session restart needed); replaces any previous pick for the domain wholesale. clear_domain_model reverts to the git-config route. 🔴 AN UNPRICED PICK STILL LANDS, AND REPORTS ITSELF (OPE-1157): when `modelId` carries no committed price in this deployment (agent/spend/model-pricing.ts, or core's built-in table), the result adds `unpriced: true` and a warning, and the audit row carries the same flag. Calls on that model add $0 to the spend ledger, so this domain's turn spend stops counting against any USD cap over it until the rate is committed. The cap is not dead: it still sums every other priced row in its scope, and a TOKEN cap is unaffected, because tokens are counted for every call. Measure the rate with `npm run probe:models` and commit it.",
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
        const unpriced = a.modelId !== undefined && modelPricing(a.modelId) === undefined;
        await store().setDomainModel(a.org, a.domain, { modelId: a.modelId, reasoning: a.reasoning }, actor);
        const picked = { ...(a.modelId ? { modelId: a.modelId } : {}), ...(a.reasoning ? { reasoning: a.reasoning } : {}) };
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "admin.model.set_domain", detail: { domain: a.domain, ...picked, ...(unpriced ? { unpriced: true } : {}) } });
        return jsonResult({
          ok: true,
          org: a.org,
          domain: a.domain,
          ...picked,
          ...(unpriced
            ? {
                unpriced: true,
                warning:
                  `The pick is set, but model "${a.modelId}" has no committed price in this deployment ` +
                  `(agent/spend/model-pricing.ts, or core's built-in table). Calls on that model add $0 to the ` +
                  `spend ledger, so domain "${a.domain}"'s turn spend stops counting against any USD cap over it ` +
                  `until the rate is committed. The cap still sums every other priced row in the scope. Token ` +
                  `caps are unaffected. Measure the rate (\`npm run probe:models\`) and commit it.`,
              }
            : {}),
        });
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

  const requireOrgAdminForLinks = (verb: string, org: string): string | null =>
    foreignOrgDenial(org) ??
    (roles.includes("admin") ? null : `forbidden: ${verb} requires the org-wide "admin" role — a link-set spans every surface, so no domain role covers it (have: ${roles.length ? roles.join(", ") : "none"}).`);

  server.registerTool(
    "link_sets_list",
    {
      title: "List identity link-sets",
      description:
        "Every cross-surface identity link-set in an org: the person's display handle, the set's status (active | suspended | revoked), and each linked account with its own status (suggested | confirmed | revoked) and the evidence that established it (`challenge:<id>`, `config-import`, `directory-sync:<provider>`). Org-admin only — a link-set enumerates one human's accounts across every surface. This is the offboarding worklist: find the person's set here, then revoke_link_set.",
      inputSchema: { org: z.string().min(1) },
    },
    async (a) => {
      const denial = requireOrgAdminForLinks("link_sets_list", a.org);
      if (denial) return errorResult(denial);
      try {
        const rows = await listLinkSetsWithIds(a.org);
        return jsonResult({
          ok: true,
          org: a.org,
          linkSets: rows.map(({ set, ids }) => ({
            id: set.id,
            handle: set.handle,
            status: set.status,
            createdAt: set.createdAt,
            updatedAt: set.updatedAt,
            ids: ids.map((r) => ({ platform: r.platform, nativeId: r.nativeId, status: r.status, establishedBy: r.establishedBy, updatedAt: r.updatedAt })),
          })),
        });
      } catch (e) {
        return errorResult(`link_sets_list failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "suspend_link_set",
    {
      title: "Suspend an identity link-set",
      description:
        "Put a person's identity link-set on HOLD: it stops resolving, so cross-surface attribution for those accounts degrades to per-surface identity until it is reactivated. Reversible (reactivate_link_set) — use this for a suspected compromise or an observed directory deprovision; use revoke_link_set for a real offboarding. Org-admin only. Get the id from link_sets_list.",
      inputSchema: { org: z.string().min(1), linkSetId: z.string().min(1) },
    },
    async (a) => {
      const denial = requireOrgAdminForLinks("suspend_link_set", a.org);
      if (denial) return errorResult(denial);
      try {
        const res = await setLinkSetHold({ org: a.org, linkSetId: a.linkSetId, hold: "suspended", actor });
        if (!res.ok) return errorResult(`suspend_link_set failed: ${res.reason}`);
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "admin.identity.suspend_link_set", detail: { linkSetId: a.linkSetId } });
        return jsonResult({ ok: true, org: a.org, linkSetId: a.linkSetId, status: "suspended" });
      } catch (e) {
        return errorResult(`suspend_link_set failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "reactivate_link_set",
    {
      title: "Reactivate a suspended identity link-set",
      description:
        "Lift a suspend_link_set hold — the set resolves again and cross-surface attribution resumes. Only a SUSPENDED set can be reactivated: a revoked one is terminal, and a person who needs standing back builds a fresh set through the ordinary link_identity challenge. Org-admin only.",
      inputSchema: { org: z.string().min(1), linkSetId: z.string().min(1) },
    },
    async (a) => {
      const denial = requireOrgAdminForLinks("reactivate_link_set", a.org);
      if (denial) return errorResult(denial);
      try {
        const res = await setLinkSetHold({ org: a.org, linkSetId: a.linkSetId, hold: "active", actor });
        if (!res.ok) return errorResult(`reactivate_link_set failed: ${res.reason}`);
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "admin.identity.reactivate_link_set", detail: { linkSetId: a.linkSetId } });
        return jsonResult({ ok: true, org: a.org, linkSetId: a.linkSetId, status: "active" });
      } catch (e) {
        return errorResult(`reactivate_link_set failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "revoke_link_set",
    {
      title: "Revoke an identity link-set (offboarding, TERMINAL)",
      description:
        "THE OFFBOARDING LEVER, and it does not come back: closes a person's link-set and tombstones every account on it, so none of those accounts can be re-linked to anyone by a later challenge. Cross-surface attribution for them stops immediately. There is deliberately no un-revoke — a mistake is repaired by running link_identity again with the accounts that should be linked, because \"this person no longer has standing\" must not be quietly reversible. Prefer suspend_link_set if you might want it back. Org-admin only.",
      inputSchema: { org: z.string().min(1), linkSetId: z.string().min(1) },
    },
    async (a) => {
      const denial = requireOrgAdminForLinks("revoke_link_set", a.org);
      if (denial) return errorResult(denial);
      try {
        const res = await revokeLinkSet({ org: a.org, linkSetId: a.linkSetId, actor });
        if (!res.ok) return errorResult(`revoke_link_set failed: ${res.reason}`);
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "admin.identity.revoke_link_set", detail: { linkSetId: a.linkSetId, note: res.note } });
        return jsonResult({ ok: true, org: a.org, linkSetId: a.linkSetId, status: "revoked", note: res.note });
      } catch (e) {
        return errorResult(`revoke_link_set failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "purge_link_set_credentials",
    {
      title: "Purge a link-set's stored credentials",
      description:
        "DESTROY the OAuth credentials stored against a person's link-set: revoked at the provider (RFC 7009) where the provider supports it, then deleted from the encrypted vault. revoke_link_set already does this as part of offboarding — reach for this verb for the two cases it does not cover: a set REVOKED BEFORE this existed (its tokens are unreachable but still stored), and a suspected token compromise where you want the credential dead without spending the terminal revoke. Works on a set in any status; purging only ever removes authority, never grants it. Not reversible — the person re-authorizes through the ordinary consent flow. Org-admin only. Get the id from link_sets_list.",
      inputSchema: { org: z.string().min(1), linkSetId: z.string().min(1) },
    },
    async (a) => {
      const denial = requireOrgAdminForLinks("purge_link_set_credentials", a.org);
      if (denial) return errorResult(denial);
      try {
        const res = await purgeLinkSetCredentials({ org: a.org, linkSetId: a.linkSetId, actor });
        if (!res.ok) return errorResult(`purge_link_set_credentials failed: ${res.reason}`);
        await appendAudit({ org: a.org, platform: "control", workspace: "control", principalId: actor, action: "admin.identity.purge_link_set_credentials", detail: { linkSetId: a.linkSetId, credentialsPurged: res.purged ?? 0 } });
        return jsonResult({ ok: true, org: a.org, linkSetId: a.linkSetId, purged: res.purged ?? 0, note: res.note });
      } catch (e) {
        return errorResult(`purge_link_set_credentials failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "directory_sync_now",
    {
      title: "Sync identity links from the directory (Okta) now",
      description:
        "Run the identity-directory sync for an org immediately instead of waiting for the daily schedule, and return the plan it applied. New IdP→platform mappings land as `suggested` links — INERT until the person confirms them in their own DM (`confirm_link`) — unless the deployment declares the `directory.autoConfirm: \"attested\"` setting, which auto-confirms only mappings the IdP itself provisions. A person the directory reports as deprovisioned has their link-set SUSPENDED eagerly. Refused when the `directory.mode` setting is `observe` — use directory_sync_preview to read the plan instead. It never unlinks or revokes anything: absence from the directory is not evidence, and revocation stays a human act (revoke_link_set). Safe to run repeatedly and concurrently — a second run over an unchanged directory is all no-ops. Returns `{ provider: null }` when no directory adapter is wired. Org-admin only.",
      inputSchema: { org: z.string().min(1) },
    },
    async (a) => {
      const denial = requireOrgAdminForLinks("directory_sync_now", a.org);
      if (denial) return errorResult(denial);
      if (directoryProvider() && directoryMode() === "observe") return errorResult(directoryObserveRefusal("directory_sync_now"));
      try {
        const res = await syncDirectoryOrg({ org: a.org });
        if (!res) {
          return jsonResult({
            ok: true,
            org: a.org,
            provider: null,
            note: "no directory provider is registered — set directory.provider and directory.oktaOrgUrl in agent/settings/settings.ts and store the OKTA_API_TOKEN operator secret (the local `npm run control` entry reads the checkout's settings), to arm directory sync.",
          });
        }
        await appendAudit({
          org: a.org,
          platform: "control",
          workspace: "control",
          principalId: actor,
          action: "admin.identity.directory_sync_now",
          detail: { provider: res.provider, policy: res.policy, planned: res.plan.counts, applied: res.applied, warnings: res.plan.warnings.length },
        });
        return jsonResult({
          ok: true,
          org: a.org,
          provider: res.provider,
          policy: res.policy,
          people: res.plan.people,
          planned: res.plan.counts,
          applied: res.applied,
          warnings: res.plan.warnings,
          refusals: res.refusals,
          startedAt: res.startedAt,
          finishedAt: res.finishedAt,
        });
      } catch (e) {
        return errorResult(`directory_sync_now failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "directory_sync_status",
    {
      title: "Last identity-directory sync result",
      description:
        "What the last identity-directory sync did for an org: when it ran, which provider, the auto-confirm policy in force, how many suggestions/confirmations/suspensions it planned and applied, and any warnings it refused to act on (an account two directory records claim, a person whose accounts already span two link-sets). Read straight off the audit trail, so it reflects scheduled runs and manual ones alike. Org-admin only.",
      inputSchema: { org: z.string().min(1) },
    },
    async (a) => {
      const denial = requireOrgAdminForLinks("directory_sync_status", a.org);
      if (denial) return errorResult(denial);
      try {
        const provider = directoryProvider();
        const last = await lastDirectorySync(a.org);
        return jsonResult({
          ok: true,
          org: a.org,
          provider: provider ? { id: provider.id, name: provider.name } : null,
          lastRun: last ? { ts: last.ts, ...last.detail } : null,
          note: provider
            ? last
              ? undefined
              : "a directory provider is wired but this org has never synced — run directory_sync_now, or wait for the daily schedule."
            : "no directory provider is registered (directory.provider is \"none\" or its adapter is not wired) — directory sync is off.",
        });
      } catch (e) {
        return errorResult(`directory_sync_status failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "directory_sync_preview",
    {
      title: "Preview what the identity-directory (Okta) sync sees and would do — writes nothing",
      description:
        "Read the directory once and report what it sees and what a real sync WOULD do, without doing any of it: people listed (active, deprovisioned, with and without accounts), accounts per platform, each configured source's field and evidence grade, assignments the adapter dropped and why, account ids whose shape cannot match how this deployment keys that platform, accounts the planner would place nowhere (an unadmitted workspace, two directory records claiming one account), the groups seen and read under `directory.groupAllowlist`, the person-group overlay `directory_groups_plan` would propose, and the planned suggestions, confirmations and SUSPENSIONS. Writes nothing, appends no audit row, opens no PR and messages nobody, in either `directory.mode`. Pair it with `directory.mode: \"observe\"` to arm the adapter with nothing applied. `report` is the same facts as readable lines. `limit` caps the per-person rows (default 50, max 500); the counts always cover everyone. Every email address in the answer is masked to its domain (`…@acme.example`), whether it came as an account id, a display name or warning text, and no group member list is returned. Returns `{ provider: null }` when no directory adapter is wired. Org-admin only.",
      inputSchema: { org: z.string().min(1), limit: z.number().int().min(0).max(DIRECTORY_PREVIEW_MAX_PEOPLE).optional() },
    },
    async (a) => {
      const denial = requireOrgAdminForLinks("directory_sync_preview", a.org);
      if (denial) return errorResult(denial);
      try {
        const preview = await previewDirectoryOrg({ org: a.org, limit: a.limit ?? DIRECTORY_PREVIEW_DEFAULT_PEOPLE });
        if (!preview) {
          return jsonResult({
            ok: true,
            org: a.org,
            provider: null,
            note: "no directory provider is registered — set directory.provider and directory.oktaOrgUrl in agent/settings/settings.ts and store the OKTA_API_TOKEN operator secret (the local `npm run control` entry reads the checkout's settings; declare directory.mode: \"observe\" first), to preview a directory.",
          });
        }
        return jsonResult({ ok: true, ...preview });
      } catch (e) {
        return errorResult(`directory_sync_preview failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "directory_groups_plan",
    {
      title: "Plan (or bot-PR-deliver) the IdP person-group overlay — review mode either way",
      description:
        "Diff the directory's (Okta's) GROUP memberships against this deployment's machine-owned person-group overlay. DEFAULT (deliver unset/false): returns the next overlay file plus a readable list of the additions and removals it would make, and APPLIES NOTHING — commit the returned `overlayContent` to `agent/identity/groups.generated.ts` (or open a PR with it) and the memberships take effect on the next deploy. With `deliver: true`: opens (or updates) a BOT-PR that writes that overlay to the config repo — the GitHub merge is the approval, so nothing takes effect until an admin merges and the config redeploys (still review mode, just automated; there is no silent auto-apply). Person-groups grant capability in each member's DM, so they are config-as-code and change only through a merged diff. Groups are named `directory:<idp-group>` so they can never collide with hand-written ones, and members are link-set references, so a person only ever contributes the accounts they have CONFIRMED. A person the directory reports as deprovisioned is dropped from every group — and their link-set is separately suspended by directory_sync_now, which stops their access immediately without waiting for this diff. If the `directory.groupAllowlist` setting is non-empty, only the listed IdP groups sync. `deliver:true` needs the config repo configured (the accessRequests.configRepo setting) and refuses politely otherwise. Returns `{ provider: null }` when no directory adapter is wired. Org-admin only.",
      inputSchema: { org: z.string().min(1), deliver: z.boolean().optional() },
    },
    async (a) => {
      const denial = requireOrgAdminForLinks("directory_groups_plan", a.org);
      if (denial) return errorResult(denial);
      try {
        const provider = directoryProvider();
        if (!provider) {
          return jsonResult({
            ok: true,
            org: a.org,
            provider: null,
            note: "no directory provider is registered — set directory.provider and directory.oktaOrgUrl in agent/settings/settings.ts and store the OKTA_API_TOKEN operator secret (the local `npm run control` entry reads the checkout's settings), to arm directory group sync. Person-groups declared by hand in agent/identity/groups.ts work regardless.",
          });
        }
        if (a.deliver && directoryMode() === "observe") return errorResult(directoryObserveRefusal("directory_groups_plan with deliver: true"));
        const current = directoryGroupsOf(getConfig().loadGroups?.() ?? []);
        const people = await provider.listPeople();
        const allowGroups = directoryGroupAllowlist();
        const plan = planDirectoryGroups({ provider: provider.id, people, current, allowGroups });
        const noop = groupPlanIsNoop(plan);

        if (a.deliver) {
          const delivery = await deliverGroupsOverlay(plan);
          await appendAudit({
            org: a.org,
            platform: "control",
            workspace: "control",
            principalId: actor,
            action: "admin.identity.directory_groups_pr",
            detail: {
              provider: provider.id,
              people: plan.people,
              planned: plan.counts,
              warnings: plan.warnings.length,
              outcome: delivery.outcome,
              ...(delivery.pr ? { pr: delivery.pr.number, url: delivery.pr.url, branch: delivery.branch } : {}),
              ...(allowGroups ? { allowlisted: allowGroups.length } : {}),
            },
          });
          return jsonResult({
            ok: true,
            org: a.org,
            provider: provider.id,
            people: plan.people,
            planned: plan.counts,
            changed: !noop,
            diff: renderGroupPlan(plan),
            warnings: plan.warnings,
            delivered: delivery.outcome,
            ...(delivery.pr ? { pr: delivery.pr } : {}),
            note: delivery.note,
          });
        }

        await appendAudit({
          org: a.org,
          platform: "control",
          workspace: "control",
          principalId: actor,
          action: "admin.identity.directory_groups_plan",
          detail: { provider: provider.id, people: plan.people, planned: plan.counts, warnings: plan.warnings.length, ...(allowGroups ? { allowlisted: allowGroups.length } : {}) },
        });
        return jsonResult({
          ok: true,
          org: a.org,
          provider: provider.id,
          people: plan.people,
          planned: plan.counts,
          changed: !noop,
          diff: renderGroupPlan(plan),
          warnings: plan.warnings,
          overlayPath: "agent/identity/groups.generated.ts",
          overlayContent: planOverlayContent(plan),
          note: noop
            ? "the overlay already matches the directory — nothing to commit."
            : "REVIEW MODE: nothing was applied. Commit `overlayContent` to `overlayPath` (a PR is the reviewed diff), or re-run with deliver:true to open a bot-PR — the memberships take effect on the next deploy of the merged config.",
        });
      } catch (e) {
        return errorResult(`directory_groups_plan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const requireAdmin = (org: string): string | null =>
    foreignOrgDenial(org) ??
    (roles.includes("admin")
      ? null
      : `forbidden: memory writes require the org-wide "admin" role (v1 — domain roles get memory_list/memory_read only; have: ${roles.length ? roles.join(", ") : "none"}).`);

  server.registerTool(
    "memory_write_file",
    {
      title: "Write a memory file (full-file replace)",
      description:
        "Full-file replace of one file inside one memory silo (creates it if absent). ADMIN ONLY (v1) — an org admin IS the approver here, unlike the dream cycle's propose-only gate for the untrusted-autonomous agent. `.md`/`.txt` only, 64KB cap, refuses a `_`-prefixed operational marker (e.g. `_onboarded`). Stamps an in-file human-edit marker (edited_by/edited_at) so the dream cycle never treats this write as agent drift. Audited (`memory.write`) and committed with a `control-plane edit by <subject>` message.",
      inputSchema: { org: z.string().min(1), silo: z.string().min(1), relPath: z.string().min(1), content: z.string() },
    },
    async (a) => {
      const denial = requireAdmin(a.org);
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
        const access = siloAccess(silo.name, getConfig().loadDomains());
        const files = await provider.readTier(p, tier, silo, access);
        files[a.relPath] = stampHumanEdit(a.content);
        const { version: commit } = await writeMemoryTier({
          provider,
          partition: p,
          tier,
          files,
          message: `control-plane edit by ${actor}`,
          silo,
          access,
          road: "control-edit",
          principalId: actor,
          platform: "control",
          workspace: "control",
          extra: { relPath: a.relPath, bytes: Buffer.byteLength(a.content, "utf-8") },
        });
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
      const denial = requireAdmin(a.org);
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
          commit = await provider.deleteFile(controlPartition(a.org), siloTier(silo.name), a.relPath, silo, siloAccess(silo.name, getConfig().loadDomains()));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await appendAudit({
            org: a.org,
            platform: "control",
            workspace: "control",
            principalId: actor,
            action: "memory.delete",
            detail: { silo: a.silo, relPath: a.relPath, deleted: false, ...auditErrorDetail(e) },
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
  server.registerTool(
    "reopen_slack_setup",
    {
      title: "Reopen Slack setup",
      description:
        "Reopen this deployment's /setup page after a Slack install has locked it, so setup can be run again (for example to install into a different workspace). Destroys only the install RECORD — every stored Slack credential stays, so the agent keeps working on Slack until a new run replaces them. The reopened page still requires the one-time setup code, which the deployment logs again on its next start. Returns reopened=false if setup was already open. Org-admin only.",
      inputSchema: { org: z.string().min(1) },
    },
    async (a) => {
      const denial =
        foreignOrgDenial(a.org) ??
        (roles.includes("admin")
          ? null
          : `forbidden: reopen_slack_setup requires the org-wide "admin" role — setup is a deployment-wide door, so no domain role covers it (have: ${roles.length ? roles.join(", ") : "none"}).`);
      if (denial) return errorResult(denial);
      try {
        const reopened = await reopenSlackSetupPage();
        if (reopened === undefined) {
          return errorResult(
            "reopen_slack_setup failed: no Slack provider is wired on this deployment, so there is no Slack setup page to reopen.",
          );
        }
        await appendAudit({
          ...orgWideWhere(a.org),
          principalId: actor,
          action: "slack.setup_reopened",
          detail: { reopened },
        });
        return jsonResult({ ok: true, reopened, org: a.org });
      } catch (e) {
        return errorResult(`reopen_slack_setup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "adopt_env_secrets",
    {
      title: "Adopt operator secrets from the deployment's environment",
      description:
        "Copy the value of each named OPERATOR SECRET from this running deployment's own environment into its db credential store, under the same name. This is the path for a value the operator has no local copy of (a Vercel SENSITIVE env var reads back empty). The value never leaves the deployment: the reply says, per name, `stored`, `already-stored` or `no-env-value`, and nothing else about the value. Only a name on the operator-secret roster is accepted (the surface credentials, the control-token lists, the model gateway key and the other operator secrets the loaded bundles declare); the roots of trust (DATABASE_URL, OE_CREDENTIAL_ENCRYPTION_KEY) are refused. A name that is already stored is kept and reported `already-stored` unless `overwrite: true`. After a name reports `stored`, delete its env var on the host. Org-admin only, and audited by name.",
      inputSchema: {
        org: z.string().min(1),
        names: z.array(z.string()).min(1).max(ENV_ADOPT_MAX_NAMES),
        overwrite: z.boolean().optional(),
      },
    },
    async (a) => {
      const denial =
        foreignOrgDenial(a.org) ??
        (roles.includes("admin")
          ? null
          : `forbidden: adopt_env_secrets requires the org-wide "admin" role — an operator secret serves the whole deployment, so no domain role covers it (have: ${roles.length ? roles.join(", ") : "none"}).`);
      if (denial) return errorResult(denial);
      const overwrite = a.overwrite === true;
      const outcome = await runEnvAdoptDoor({ names: a.names, overwrite, actor, org: a.org });
      if (!outcome.ok) return errorResult(`adopt_env_secrets failed: ${outcome.message}`);
      return jsonResult({ ok: true, org: a.org, overwrite, results: outcome.results });
    },
  );
}
