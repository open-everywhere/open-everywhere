import { getOperationalStore } from "../operational/provider.js";
import { DM_RULES_MAX_PER_ROOM, type DmRuleRow } from "../operational/store.js";
import { appendAudit } from "../audit/audit.js";
import { resolveAudienceFloor } from "../access/audience-floor.js";
import type { ResolvedPreApprovalRule } from "../access/pre-approval-rules.js";
import { ruleInstanceProblems } from "../access/pre-approval-rules.js";
import { whereFromScope } from "./actions.js";
import { allowRuleProposalForRow, allowRuleText, isDmRuleRoom, parseAllowRuleSubject, widenAllowRuleSubject, type AllowRuleProposal } from "./allow-rule.js";
import { executeDomainRulePr, type DomainRulePrDeps } from "./allow-rule-pr.js";
import type { PendingActionRow } from "./types.js";

export type AllowRulePlan = { readonly ok: true; readonly proposal: AllowRuleProposal } | { readonly ok: false; readonly why: string; readonly reason: string };

export interface AllowRuleClick {
  readonly clickerId: string;
  readonly clickSurfaceKey?: string;
  readonly clickerIsGuest?: boolean;
}

export interface AllowRulePlanDeps {
  readonly floor?: typeof resolveAudienceFloor;
}

const NO_ADMINS: ReadonlySet<string> = new Set<string>();

export async function planAllowRuleClick(row: PendingActionRow, click: AllowRuleClick, deps: AllowRulePlanDeps = {}): Promise<AllowRulePlan> {
  const proposal = allowRuleProposalForRow(row);
  if (proposal === undefined) return { ok: false, reason: "no-rule-offered", why: "this card offers no rule, so I approved this one act only" };
  if (click.clickSurfaceKey === undefined) return { ok: false, reason: "no-room", why: "I could not tell which room the click came from, so I added no rule" };
  if (click.clickerIsGuest !== false) {
    return { ok: false, reason: "guest-clicker", why: "I could not confirm you as a full member of this workspace, so I added no rule. Guests and external accounts cannot add rules" };
  }
  if (proposal.venue === "dm") {
    if (click.clickerId !== row.requestedBy || !isDmRuleRoom(click.clickSurfaceKey)) {
      return { ok: false, reason: "not-owner", why: "only the person this DM belongs to can add a rule here, so I added no rule" };
    }
    return { ok: true, proposal };
  }
  try {
    const { floor, roster } = await (deps.floor ?? resolveAudienceFloor)(click.clickSurfaceKey, NO_ADMINS);
    if (!roster.resolved || floor === "guest") {
      return { ok: false, reason: "audience-floor", why: "this channel is shared outside the organisation, has a guest in it, or I could not read who is in it, so I added no rule" };
    }
  } catch {
    return { ok: false, reason: "audience-floor", why: "I could not read who is in this channel, so I added no rule" };
  }
  return { ok: true, proposal };
}

export interface ApplyAllowRuleDeps {
  readonly pr?: DomainRulePrDeps;
  readonly now?: () => Date;
}

export async function auditAllowRuleRefused(row: PendingActionRow, clickerId: string, reason: string, venue: object): Promise<void> {
  await appendAudit({
    ...whereFromScope(row.org, row.scopeKey),
    principalId: clickerId,
    action: "approval.rule.refused",
    detail: { id: row.id, kind: row.kind, reason, ...venue },
  }).catch(() => undefined);
}

export async function applyAllowRule(
  plan: Extract<AllowRulePlan, { ok: true }>,
  row: PendingActionRow,
  clickerId: string,
  venue: object,
  deps: ApplyAllowRuleDeps = {},
): Promise<string> {
  try {
    if (plan.proposal.venue === "dm") return await addDmRule(plan.proposal, row, clickerId, venue, deps);
    return await executeDomainRulePr({ proposal: plan.proposal, row, clickerId, venue }, deps.pr);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await auditAllowRuleRefused(row, clickerId, "write-failed", { ...venue, error: message });
    return `no rule was written: ${message}`;
  }
}

async function addDmRule(proposal: AllowRuleProposal, row: PendingActionRow, clickerId: string, venue: object, deps: ApplyAllowRuleDeps): Promise<string> {
  const store = getOperationalStore();
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const existing = await store.listDmRules(row.org, row.scopeKey);
  const same = existing.find((r) => r.ruleId === proposal.id);
  if (same === undefined && existing.length >= DM_RULES_MAX_PER_ROOM) {
    await auditAllowRuleRefused(row, clickerId, "cap", venue);
    return `no rule was added: you keep ${existing.length} rules, the most I keep for one person. Remove one in my Home tab first`;
  }
  const previous = same ? parseAllowRuleSubject(same.subjectJson) : undefined;
  const subject = previous ? widenAllowRuleSubject(previous, proposal.subject) : proposal.subject;
  const rule = allowRuleText("dm", subject);
  if (ruleInstanceProblems(rule).length > 0) throw new Error("the widened rule would name one object");
  if (same !== undefined && same.rule === rule) {
    await auditAllowRuleRefused(row, clickerId, "already-covered", venue);
    return `you already have this rule in your DM, so nothing changed: "${rule}"`;
  }
  const write: DmRuleRow = {
    org: row.org,
    surfaceKey: row.scopeKey,
    ruleId: proposal.id,
    ownerId: row.requestedBy,
    rule,
    subjectJson: JSON.stringify(subject),
    sourceActionId: row.id,
    createdAt: same?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  await store.upsertDmRule(write);
  const change = same === undefined ? "added" : "widened";
  await appendAudit({
    ...whereFromScope(row.org, row.scopeKey),
    principalId: clickerId,
    action: "approval.rule.added",
    detail: { id: row.id, kind: row.kind, ruleId: proposal.id, change, ...venue },
  }).catch(() => undefined);
  return change === "added" ? `rule added to your DM — it applies at once: "${rule}"` : `your DM rule now covers this too — it applies at once: "${rule}"`;
}

const DM_RULE_SCOPE = "dm (the person's own rule)";

export async function dmRulesForProposal(
  org: string,
  scopeKey: string,
  requestedBy: string | undefined,
  isOwnSourceAct?: (sourceActionId: string) => Promise<boolean>,
): Promise<readonly ResolvedPreApprovalRule[]> {
  if (requestedBy === undefined || !isDmRuleRoom(scopeKey)) return [];
  try {
    const rows = (await getOperationalStore().listDmRules(org, scopeKey)).filter((r) => r.ownerId === requestedBy);
    const kept: DmRuleRow[] = [];
    for (const r of rows) {
      const own = isOwnSourceAct ? await isOwnSourceAct(r.sourceActionId).catch(() => true) : false;
      if (!own) kept.push(r);
    }
    return kept.map((r) => ({ id: r.ruleId, rule: r.rule, scope: DM_RULE_SCOPE }));
  } catch (err) {
    console.warn(`[open-everywhere:approvals] DM rules unreadable for ${scopeKey} (${err instanceof Error ? err.message : String(err)}) — the judge reads none`);
    return [];
  }
}
