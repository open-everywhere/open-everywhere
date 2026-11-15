import type { PendingActionRow } from "./types.js";
import { getSettings } from "../settings/settings.js";
import { getConfig } from "../access/config.js";
import { parseScopeKey } from "../access/scope-key.js";
import { judgedConnectorOpTool, judgeHumanOnlyReason, toolForActionKind } from "../access/approver-chain.js";
import { CONNECTOR_DESTRUCTIVE_VERBS, CONNECTOR_WRITE_VERBS, classifyConnectorOpTier, judgeDeferredTool, parseQualifiedToolName } from "../access/consequence.js";
import { isValidPreApprovalRuleId, ruleInstanceProblems } from "../access/pre-approval-rules.js";
import { isDmAnchorDomain } from "../channels/window-key.js";

export const ALLOW_RULE_VERB = "approve_rule";

export const ALLOW_RULE_LABEL = "Approve, and allow things like this";

export type AllowRuleVenue = "dm" | "domain";

export interface AllowRuleSubject {
  readonly tool: string;
  readonly action: string;
  readonly objects: readonly string[];
  readonly ops?: readonly string[];
}

export interface AllowRuleProposal {
  readonly venue: AllowRuleVenue;
  readonly domain?: string;
  readonly id: string;
  readonly subject: AllowRuleSubject;
  readonly rule: string;
}

export const ALLOW_RULE_CONFIRM_TEXT_MAX = 300;

function cleanWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function plural(noun: string): string {
  if (noun.length === 0) return "items";
  if (noun.endsWith("s")) return noun;
  if (/[^aeiou]y$/u.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

function toolSubject(kind: string, tool: string): AllowRuleSubject | undefined {
  switch (kind) {
    case "pr.open":
      return { tool, action: "open", objects: ["pull requests"] };
    case "access.request":
      return { tool, action: "send", objects: ["access requests"] };
    case "routine.create":
      return { tool, action: "create", objects: ["routines"] };
    default:
      return undefined;
  }
}

function connectorSubject(qualifiedTool: string): AllowRuleSubject | undefined {
  const parsed = parseQualifiedToolName(qualifiedTool);
  if (parsed === undefined || !("connection" in parsed) || parsed.connection === undefined) return undefined;
  const connection = cleanWords(parsed.connection);
  const op = parsed.verb;
  if (connection === "" || op === "") return undefined;
  const destructive = classifyConnectorOpTier(qualifiedTool) === "destructive";
  const tokens = cleanWords(op).split(" ").filter((t) => t.length > 0);
  const vendor = connection.split(" ").pop();
  const rest = tokens[0] === vendor ? tokens.slice(1) : tokens;
  const verbs = destructive ? CONNECTOR_DESTRUCTIVE_VERBS : CONNECTOR_WRITE_VERBS;
  const verbAt = rest.findIndex((t) => verbs.includes(t));
  if (verbAt === -1) return undefined;
  const object = rest.filter((_, i) => i !== verbAt).join(" ");
  return { tool: connection, action: rest[verbAt]!, objects: [plural(object)], ops: [op] };
}

export function allowRuleText(venue: AllowRuleVenue, subject: AllowRuleSubject): string {
  const where = venue === "dm" ? "In this DM" : "In this domain";
  const asker = venue === "dm" ? "the person asked for it in this turn" : "a person asked for it in this turn";
  const objects = subject.objects.join(" and ");
  let act: string;
  if (subject.ops !== undefined) {
    const ops = subject.ops.join(", ");
    act = CONNECTOR_DESTRUCTIVE_VERBS.includes(subject.action)
      ? `${subject.action} ${objects}, one named item per call and never in bulk, with the ${subject.tool} connector's ${ops}`
      : `${subject.action} ${objects} with the ${subject.tool} connector's ${ops}`;
  } else if (subject.tool === "create_routine") {
    act = "create routines with create_routine that report here and declare no standing write";
  } else {
    act = `${subject.action} ${objects} with ${subject.tool}`;
  }
  return `${where}, ${act} when ${asker}, with matching arguments. Never in an unattended run.`;
}

function allowRuleId(venue: AllowRuleVenue, subject: AllowRuleSubject, domain?: string): string {
  const parts = venue === "dm" ? ["dm", slug(subject.tool), slug(subject.action)] : [slug(domain ?? ""), slug(subject.tool), slug(subject.action)];
  return parts.filter((p) => p.length > 0).join(".").slice(0, 64);
}

export function widenAllowRuleSubject(existing: AllowRuleSubject, incoming: AllowRuleSubject): AllowRuleSubject {
  const objects = [...new Set([...existing.objects, ...incoming.objects])].sort();
  const ops = existing.ops !== undefined || incoming.ops !== undefined ? [...new Set([...(existing.ops ?? []), ...(incoming.ops ?? [])])].sort() : undefined;
  return { tool: existing.tool, action: existing.action, objects, ...(ops !== undefined ? { ops } : {}) };
}

export function parseAllowRuleSubject(json: string): AllowRuleSubject | undefined {
  try {
    const v = JSON.parse(json) as Partial<AllowRuleSubject>;
    if (typeof v.tool !== "string" || typeof v.action !== "string" || !Array.isArray(v.objects)) return undefined;
    if (!v.objects.every((o) => typeof o === "string")) return undefined;
    if (v.ops !== undefined && (!Array.isArray(v.ops) || !v.ops.every((o) => typeof o === "string"))) return undefined;
    return { tool: v.tool, action: v.action, objects: v.objects, ...(v.ops !== undefined ? { ops: v.ops } : {}) };
  } catch {
    return undefined;
  }
}

export function isDmRuleRoom(scopeKey: string): boolean {
  const parsed = parseScopeKey(scopeKey);
  return parsed.kind === "surface" && parsed.platform === "slack" && parsed.surface.startsWith("D");
}

function allowRuleVenueOf(row: Pick<PendingActionRow, "scopeKey" | "domain">): { readonly venue: AllowRuleVenue; readonly domain?: string } | undefined {
  if (isDmRuleRoom(row.scopeKey)) return { venue: "dm" };
  const parsed = parseScopeKey(row.scopeKey);
  if (parsed.kind !== "surface" || parsed.platform !== "slack") return undefined;
  if (typeof row.domain !== "string" || row.domain.length === 0 || isDmAnchorDomain(row.domain)) return undefined;
  return { venue: "domain", domain: row.domain };
}

function domainRulePrEnabled(): boolean {
  try {
    const cfg = getConfig().loadAccessRequests?.();
    return typeof cfg?.configRepo === "string" && cfg.configRepo.length > 0 && typeof cfg.adminChannel === "string" && cfg.adminChannel.length > 0;
  } catch {
    return false;
  }
}

const ALLOW_RULE_TOOL_KINDS: ReadonlySet<string> = new Set(["pr.open", "routine.create"]);

function subjectForRow(row: PendingActionRow, args: Record<string, unknown>): AllowRuleSubject | undefined {
  if (row.kind === "op.connector") {
    const { tainted: _legacyTaint, ...opArgs } = args;
    const tool = judgedConnectorOpTool(row.kind, opArgs, { unattended: false, ...(row.domain ? { domain: row.domain } : {}) });
    return tool === undefined ? undefined : connectorSubject(tool);
  }
  const tool = toolForActionKind(row.kind);
  if (tool === undefined || !judgeDeferredTool(tool)) return undefined;
  if (judgeHumanOnlyReason({ tool, action: row.kind, args }) !== undefined) return undefined;
  return toolSubject(row.kind, tool);
}

export function allowRuleProposalForRow(row: PendingActionRow): AllowRuleProposal | undefined {
  if (row.status !== "pending") return undefined;
  if (getSettings().approvals.judgeMode !== "enforce") return undefined;
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.argsJson) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    args = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (row.kind !== "op.connector" && !ALLOW_RULE_TOOL_KINDS.has(row.kind)) return undefined;
  const where = allowRuleVenueOf(row);
  if (where === undefined) return undefined;
  if (where.venue === "domain" && !domainRulePrEnabled()) return undefined;
  const subject = subjectForRow(row, args);
  if (subject === undefined) return undefined;
  const id = allowRuleId(where.venue, subject, where.domain);
  if (!isValidPreApprovalRuleId(id)) return undefined;
  const rule = allowRuleText(where.venue, subject);
  if (ruleInstanceProblems(rule).length > 0) return undefined;
  const proposal: AllowRuleProposal = { venue: where.venue, ...(where.domain ? { domain: where.domain } : {}), id, subject, rule };
  if (allowRuleConfirmText(proposal).length > ALLOW_RULE_CONFIRM_TEXT_MAX) return undefined;
  return proposal;
}

export function allowRuleConfirmText(proposal: AllowRuleProposal): string {
  const lead =
    proposal.venue === "dm"
      ? "Approve this, and keep this rule in your DM. It applies at once. Remove it in my Home tab."
      : `Approve this, and propose this rule for the ${proposal.domain ?? ""} domain in a pull request.`;
  return `${lead}\n\n"${proposal.rule}"`;
}
