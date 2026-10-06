import { unattendedFrom, type SurfaceBinding } from "../identity/binding.js";
import { cancelAnchoredTurn, type AttachSessionForCancel } from "../channels/turn-cancel.js";
import { turnChannelKey } from "../channels/turn-registry.js";
import { type Caps } from "../spend/spend.js";
import { periodOf } from "../spend/spend.js";
import { effectiveCaps, domainNameForScope } from "../spend/caps.js";
import { surfaceTokens, workspaceTokens } from "../spend/store.js";
import { scopeUsdSpend } from "../spend/check.js";
import { getProvider } from "../memory/provider.js";
import { getConfig } from "../access/config.js";
import { telemetryStatusLine } from "../observability/telemetry.js";
import { domainForChannel, type Domain } from "../memory/domain.js";
import { requestApproval } from "../approvals/flow.js";
import { friendlyScopeLabel } from "../approvals/scope-label.js";
import {
  defaultScopeKey,
  approvalPostDeps,
  planSetSpendLimit,
  requireCardPathHere,
  readSpendCoverage,
  frozenCoverage,
  type SetSpendLimitInput,
  type CurrentCaps,
} from "../tools/set_spend_limit.js";
import { planClearSpendLimit, type ClearSpendLimitInput } from "../tools/clear_spend_limit.js";
import { domainSpendWindow, reportDomainForBinding } from "../spend/reporting.js";
import type { SkillDomainRefusal } from "../skills/domain-skills.js";
import { parseRateTokens, runRate, rateHelpLine, type RateCommand } from "./rate.js";
import { agentCommandName, agentDisplayName } from "../identity/bot-name.js";
import { getAppInfo, hasRealAppVersion, registerAppInfo as storeAppInfo, type AppInfo } from "./app-info.js";
import { assertPostgresWiredAtBoot } from "../operational/postgres-wiring.js";

export function oeCommandName(): string {
  return agentCommandName();
}

export function oeSlash(sub?: string): string {
  return sub === undefined ? `/${oeCommandName()}` : `/${oeCommandName()} ${sub}`;
}

export { type AppInfo, APP_VERSION_UNVERSIONED, normalizeAppVersion, hasRealAppVersion, getAppInfo, resetAppInfo } from "./app-info.js";

export function registerAppInfo(info: AppInfo): void {
  assertPostgresWiredAtBoot();
  storeAppInfo(info);
}

export type OeCommand =
  | { readonly kind: "help" }
  | { readonly kind: "status" }
  | { readonly kind: "budget-status" }
  | { readonly kind: "budget-raise"; readonly usd: number }
  | { readonly kind: "budget-clear" }
  | { readonly kind: "stop" }
  | RateCommand
  | { readonly kind: "error"; readonly message: string };

function parseBudgetTokens(rest: readonly string[]): OeCommand {
  const [action, amountRaw] = rest;
  if (!action || action === "status") return { kind: "budget-status" };
  if (action === "clear") return { kind: "budget-clear" };
  if (action === "raise") {
    const usd = Number(amountRaw);
    if (!amountRaw || !Number.isFinite(usd) || usd <= 0) {
      return {
        kind: "error",
        message: `"${oeSlash("budget raise")}" needs a positive USD amount, e.g. "${oeSlash("budget raise 25")}" (got ${JSON.stringify(amountRaw ?? "")}).`,
      };
    }
    return { kind: "budget-raise", usd };
  }
  return { kind: "error", message: `Unknown "budget" action "${action}" — try "budget", "budget raise <usd>", or "budget clear".` };
}

export function parseOeCommandTokens(tokens: readonly string[]): OeCommand {
  const [sub, ...rest] = tokens;
  if (!sub || sub === "help") return { kind: "help" };
  if (sub === "status") return { kind: "status" };
  if (sub === "stop") return { kind: "stop" };
  if (sub === "rate") return parseRateTokens(rest);
  if (sub === "budget") return parseBudgetTokens(rest);
  return { kind: "error", message: `Unknown command "${sub}" — try "${oeSlash("help")}" to see what's available.` };
}

export function parseSlackCommandText(text: string | undefined): OeCommand {
  const tokens = (text ?? "")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return parseOeCommandTokens(tokens);
}

export function renderHelp(): string {
  return [
    `*${oeSlash()}* — zero-inference control-plane commands (pure logic, code-rendered, no model turn — ` +
      "these work even during a spend-cap decline or a model/gateway outage):",
    `• \`${oeSlash("status")}\` — deploy sanity: deployment sha, eve pin, model config, memory provider, telemetry — plus the app version and the context window with its compaction threshold, each where this deployment carries one.`,
    `• \`${oeSlash("stop")}\` — stand down the turn running in this channel (free, instant, works over a spend cap).`,
    `• \`${oeSlash("budget")}\` — this channel's and workspace's effective spend caps + current-month spend.`,
    `• \`${oeSlash("budget raise <usd>")}\` — propose a new monthly USD cap for this channel (posts an approval card; an admin decides).`,
    `• \`${oeSlash("budget clear")}\` — propose clearing this channel's spend-limit override back to config (posts an approval card).`,
    rateHelpLine(),
    `• \`${oeSlash("help")}\` — this message.`,
  ].join("\n");
}

function fmtTokenCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function renderStatus(info: AppInfo, memoryProviderId: string, telemetryStatus = "unknown"): string {
  const { contextWindowTokens: windowTokens, compactionThresholdTokens: thresholdTokens } = info;
  return [
    hasRealAppVersion(info) ? `*${agentDisplayName()}* v${info.version}` : `*${agentDisplayName()}*`,
    `• deployment sha: \`${info.deploymentSha}\``,
    `• eve: \`${info.evePin}\``,
    `• primary model: \`${info.primaryModel}\``,
    `• utility model: \`${info.utilityModel}\``,
    ...(windowTokens !== undefined && thresholdTokens !== undefined && windowTokens > 0
      ? [
          `• context window: \`${fmtTokenCount(windowTokens)}\` tokens — compaction fires at ` +
            `\`${fmtTokenCount(thresholdTokens)}\` (${Math.round((thresholdTokens / windowTokens) * 100)}%)`,
        ]
      : []),
    `• memory provider: \`${memoryProviderId}\``,
    `• telemetry: \`${telemetryStatus}\``,
  ].join("\n");
}

function fmtCap(n: number | null | undefined, unit: "tokens" | "usd"): string {
  if (n == null) return "uncapped";
  return unit === "usd" ? `$${n.toFixed(2)}` : fmtTokenCount(n);
}

export interface BudgetStatusFacts {
  readonly surfaceKey: string;
  readonly workspaceKey: string;
  readonly surfaceTokens: number;
  readonly workspaceTokens: number;
  readonly surfaceUsd: number;
  readonly workspaceUsd: number;
  readonly caps: Caps;
}

export function renderBudgetStatus(f: BudgetStatusFacts): string {
  return [
    "*Spend status* (current calendar month)",
    `• this channel (\`${f.surfaceKey}\`): ${fmtTokenCount(f.surfaceTokens)} / ${fmtCap(f.caps.surfaceMonthlyTokens, "tokens")} tokens · ` +
      `~$${f.surfaceUsd.toFixed(2)} / ${fmtCap(f.caps.surfaceMonthlyUsd, "usd")}`,
    `• whole workspace (\`${f.workspaceKey}\`): ${fmtTokenCount(f.workspaceTokens)} / ${fmtCap(f.caps.workspaceMonthlyTokens, "tokens")} tokens · ` +
      `~$${f.workspaceUsd.toFixed(2)} / ${fmtCap(f.caps.workspaceMonthlyUsd, "usd")}`,
    `_propose a change with \`${oeSlash("budget raise <usd>")}\` or \`${oeSlash("budget clear")}\`._`,
  ].join("\n");
}

function mentionFor(binding: SurfaceBinding): string {
  return binding.principalId ? `<@${binding.principalId}>` : "an unidentified user";
}

export interface BudgetStatusDeps {
  readonly effectiveCaps?: typeof effectiveCaps;
  readonly surfaceTokens?: typeof surfaceTokens;
  readonly workspaceTokens?: typeof workspaceTokens;
  readonly scopeUsdSpend?: typeof scopeUsdSpend;
  readonly nowISO?: () => string;
}

export async function computeBudgetStatusFacts(binding: SurfaceBinding, deps: BudgetStatusDeps = {}): Promise<BudgetStatusFacts> {
  const effectiveCapsFn = deps.effectiveCaps ?? effectiveCaps;
  const surfaceTokensFn = deps.surfaceTokens ?? surfaceTokens;
  const workspaceTokensFn = deps.workspaceTokens ?? workspaceTokens;
  const scopeUsdSpendFn = deps.scopeUsdSpend ?? scopeUsdSpend;
  const nowISO = deps.nowISO ? deps.nowISO() : new Date().toISOString();

  const surfaceKey = defaultScopeKey(binding, "surface");
  const workspaceKey = defaultScopeKey(binding, "workspace");
  const period = periodOf(nowISO);
  const domainName = domainNameForScope(surfaceKey, binding.mode, binding.trust);

  const [caps, st, wt, usd] = await Promise.all([
    effectiveCapsFn(binding.org, workspaceKey, surfaceKey, domainName),
    surfaceTokensFn(binding.org, surfaceKey, period),
    workspaceTokensFn(binding.org, workspaceKey, period),
    scopeUsdSpendFn(binding.org, workspaceKey, surfaceKey, nowISO),
  ]);

  return {
    surfaceKey,
    workspaceKey,
    surfaceTokens: st,
    workspaceTokens: wt,
    surfaceUsd: usd.surfaceUsd,
    workspaceUsd: usd.workspaceUsd,
    caps,
  };
}

export interface OeApprovalDeps {
  readonly effectiveCaps?: typeof effectiveCaps;
  readonly requestApproval?: typeof requestApproval;
  readonly friendlyScopeLabel?: typeof friendlyScopeLabel;
  readonly readSpendCoverage?: typeof readSpendCoverage;
  readonly domainSpendWindow?: typeof domainSpendWindow;
  readonly domains?: readonly Domain[];
  readonly nowISO?: () => string;
}

function noDomainSpendReason(reason: SkillDomainRefusal): string {
  switch (reason) {
    case "dm":
      return "a DM belongs to no memory domain";
    case "mpim":
      return "a group chat belongs to no memory domain";
    case "external":
      return "an externally-shared or unconfirmed channel reports no domain spend";
    case "unassigned":
      return "this channel is in no memory domain, and no org-wide default domain is configured";
  }
}

export const BUDGET_RAISE_SCAN_DAYS = 30;

async function budgetRaiseSpendSentence(binding: SurfaceBinding, deps: OeApprovalDeps): Promise<string> {
  const domains = deps.domains ?? getConfig().loadDomains();
  const resolved = reportDomainForBinding(binding, domains);
  if (resolved.domain === null) return `\n_No domain spend to show — ${noDomainSpendReason(resolved.reason)}._`;
  try {
    const scan = await (deps.domainSpendWindow ?? domainSpendWindow)(
      binding.org,
      resolved.domain,
      deps.nowISO ? deps.nowISO() : new Date().toISOString(),
      BUDGET_RAISE_SCAN_DAYS,
      { domains },
    );
    return (
      `\n_Domain \`${scan.domain}\` spent ~$${scan.usd.toFixed(2)} on ${fmtTokenCount(scan.tokens)} tokens over ${fmtTokenCount(scan.calls)} calls ` +
      `in ${scan.periods.join(", ")} — the whole calendar months holding the last ${BUDGET_RAISE_SCAN_DAYS} days, which is the finest window the spend ledger keeps._`
    );
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`[open-everywhere:spend] "${oeSlash("budget raise")}" could not scan domain "${resolved.domain}" spend: ${why}`);
    return `\n_Domain spend NOT shown — the spend ledger could not be read on this turn._`;
  }
}

function requireChannelId(binding: SurfaceBinding): string {
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) {
    throw new Error("couldn't resolve this channel's id — try this from a real channel or DM, not a synthetic context.");
  }
  return channelId;
}

export async function runBudgetRaise(binding: SurfaceBinding, usd: number, deps: OeApprovalDeps = {}): Promise<string> {
  requireCardPathHere(`"${oeSlash("budget raise")}"`, binding.platform);
  const effectiveCapsFn = deps.effectiveCaps ?? effectiveCaps;
  const requestApprovalFn = deps.requestApproval ?? requestApproval;
  const friendlyScopeLabelFn = deps.friendlyScopeLabel ?? friendlyScopeLabel;

  const level = "surface" as const;
  const scopeKey = defaultScopeKey(binding, level);
  const workspaceKey = defaultScopeKey(binding, "workspace");
  const domain = domainForChannel(scopeKey, getConfig().loadDomains())?.name ?? null;
  const caps = await effectiveCapsFn(binding.org, workspaceKey, scopeKey, domainNameForScope(scopeKey, binding.mode, binding.trust));
  const current: CurrentCaps = { tokens: caps.surfaceMonthlyTokens ?? null, usd: caps.surfaceMonthlyUsd ?? null };

  const input: SetSpendLimitInput = {
    monthlyUsd: usd,
    reason: `requested via "${oeSlash("budget raise")}" by ${mentionFor(binding)}`,
  };
  const plan = planSetSpendLimit(binding, input, current, domain);

  const channelId = requireChannelId(binding);
  const scopeLabel = await friendlyScopeLabelFn(plan.scopeKey);
  const coverageReport = await (deps.readSpendCoverage ?? readSpendCoverage)(plan.args.org, plan.args.level, plan.args.scopeKey, plan.args.monthlyUsd);
  const coverage = coverageReport === undefined ? undefined : frozenCoverage(coverageReport);
  const posted = await requestApprovalFn(
    {
      org: plan.args.org,
      kind: plan.kind,
      args: { ...plan.args, ...(scopeLabel ? { scopeLabel } : {}), ...(coverage ? { coverage } : {}) },
      scopeKey: plan.scopeKey,
      domain: plan.domain,
      requestedBy: binding.principalId!,
      channelId,
      threadTs: binding.threadTs ?? null,
      chain: { unattended: unattendedFrom(binding) },
    },
    approvalPostDeps(binding.platform),
  );
  const spendSentence = await budgetRaiseSpendSentence(binding, deps);
  if (posted.autoApproved) {
    return (
      `Done — $${usd.toFixed(2)}/month on \`${plan.scopeKey}\` is already in force: the approver chain auto-approved it ` +
      `(${posted.autoApproved.resolvedBy}), so no card was posted — ${posted.autoApproved.outcome}` +
      spendSentence
    );
  }
  return (
    `Card posted in this channel — proposing $${usd.toFixed(2)}/month on \`${plan.scopeKey}\` ` +
    `(pending \`${posted.id}\`, expires ${posted.expiresAt}). An admin needs to Approve it.` +
    spendSentence
  );
}

export async function runBudgetClear(binding: SurfaceBinding, deps: OeApprovalDeps = {}): Promise<string> {
  requireCardPathHere(`"${oeSlash("budget clear")}"`, binding.platform);
  const effectiveCapsFn = deps.effectiveCaps ?? effectiveCaps;
  const requestApprovalFn = deps.requestApproval ?? requestApproval;
  const friendlyScopeLabelFn = deps.friendlyScopeLabel ?? friendlyScopeLabel;

  const level = "surface" as const;
  const scopeKey = defaultScopeKey(binding, level);
  const workspaceKey = defaultScopeKey(binding, "workspace");
  const domain = domainForChannel(scopeKey, getConfig().loadDomains())?.name ?? null;
  const caps = await effectiveCapsFn(binding.org, workspaceKey, scopeKey, domainNameForScope(scopeKey, binding.mode, binding.trust));
  const current: CurrentCaps = { tokens: caps.surfaceMonthlyTokens ?? null, usd: caps.surfaceMonthlyUsd ?? null };

  const input: ClearSpendLimitInput = {};
  const plan = planClearSpendLimit(binding, input, current, domain);

  const channelId = requireChannelId(binding);
  const scopeLabel = await friendlyScopeLabelFn(plan.scopeKey);
  const posted = await requestApprovalFn(
    {
      org: plan.args.org,
      kind: plan.kind,
      args: { ...plan.args, ...(scopeLabel ? { scopeLabel } : {}) },
      scopeKey: plan.scopeKey,
      domain: plan.domain,
      requestedBy: binding.principalId!,
      channelId,
      threadTs: binding.threadTs ?? null,
      chain: { unattended: unattendedFrom(binding) },
    },
    approvalPostDeps(binding.platform),
  );
  if (posted.autoApproved) {
    return (
      `Done — the override on \`${plan.scopeKey}\` is already back to the config-as-code cap: the approver chain auto-approved it ` +
      `(${posted.autoApproved.resolvedBy}), so no card was posted — ${posted.autoApproved.outcome}`
    );
  }
  return (
    `Card posted in this channel — proposing to clear the override on \`${plan.scopeKey}\` back to the config-as-code cap ` +
    `(pending \`${posted.id}\`, expires ${posted.expiresAt}). An admin needs to Approve it.`
  );
}

export interface OeCommandDeps {
  readonly attachSession?: AttachSessionForCancel;
}

export async function runStop(binding: SurfaceBinding, attachSession: AttachSessionForCancel | undefined): Promise<string> {
  if (!attachSession) {
    return "Stop isn't wired on this surface yet — react with the raised-hand emoji on the thread instead.";
  }
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  const channelKey = turnChannelKey(binding.platform, channelId);
  if (!channelKey) {
    return `Couldn't resolve this channel — try \`${oeSlash("stop")}\` from a real channel or DM, not a synthetic context.`;
  }
  const result = await cancelAnchoredTurn({
    org: binding.org,
    platform: binding.platform,
    workspace: binding.workspace,
    ...(binding.principalId ? { requestedBy: binding.principalId } : {}),
    via: "command",
    query: { channelKey },
    attachSession,
  });
  return result.message;
}

export async function runOeCommand(cmd: OeCommand, binding: SurfaceBinding, deps: OeCommandDeps = {}): Promise<string> {
  switch (cmd.kind) {
    case "error":
      return cmd.message;
    case "help":
      return renderHelp();
    case "status": {
      let memoryProviderId = "unknown";
      try {
        memoryProviderId = getProvider().id;
      } catch {
      }
      let telemetryStatus = "unknown";
      try {
        telemetryStatus = telemetryStatusLine();
      } catch {
      }
      return renderStatus(getAppInfo(), memoryProviderId, telemetryStatus);
    }
    case "budget-status": {
      const facts = await computeBudgetStatusFacts(binding);
      return renderBudgetStatus(facts);
    }
    case "budget-raise":
      return runBudgetRaise(binding, cmd.usd);
    case "budget-clear":
      return runBudgetClear(binding);
    case "stop":
      return runStop(binding, deps.attachSession);
    case "rate":
      return runRate(binding, cmd.score);
  }
}
