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
import { domainForChannel } from "../memory/domain.js";
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

export const OE_COMMAND_NAME = "oe";

export interface AppInfo {
  readonly version: string;
  readonly primaryModel: string;
  readonly utilityModel: string;
  readonly contextWindowTokens?: number;
  readonly compactionThresholdTokens?: number;
  readonly deploymentSha: string;
  readonly evePin: string;
}

export const APP_VERSION_UNVERSIONED = "unversioned";

const UNVERSIONED_PLACEHOLDER = "0.0.0";

export function normalizeAppVersion(raw: string): string {
  const v = raw.trim();
  if (v === "" || v === UNVERSIONED_PLACEHOLDER) return APP_VERSION_UNVERSIONED;
  return v;
}

export function hasRealAppVersion(info: AppInfo): boolean {
  return info.version !== APP_VERSION_UNVERSIONED && info.version !== "unknown";
}

const UNKNOWN_APP_INFO: AppInfo = {
  version: "unknown",
  primaryModel: "unknown",
  utilityModel: "unknown",
  deploymentSha: "unknown",
  evePin: "unknown",
};
let registeredAppInfo: AppInfo = UNKNOWN_APP_INFO;

export function registerAppInfo(info: AppInfo): void {
  registeredAppInfo = { ...info, version: normalizeAppVersion(info.version) };
}

export function getAppInfo(): AppInfo {
  return registeredAppInfo;
}

export function resetAppInfo(): void {
  registeredAppInfo = UNKNOWN_APP_INFO;
}

export type OeCommand =
  | { readonly kind: "help" }
  | { readonly kind: "status" }
  | { readonly kind: "budget-status" }
  | { readonly kind: "budget-raise"; readonly usd: number }
  | { readonly kind: "budget-clear" }
  | { readonly kind: "stop" }
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
        message: `"/oe budget raise" needs a positive USD amount, e.g. "/oe budget raise 25" (got ${JSON.stringify(amountRaw ?? "")}).`,
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
  if (sub === "budget") return parseBudgetTokens(rest);
  return { kind: "error", message: `Unknown command "${sub}" — try "/oe help" to see what's available.` };
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
    "*/oe* — zero-inference control-plane commands (pure logic, code-rendered, no model turn — " +
      "these work even during a spend-cap decline or a model/gateway outage):",
    "• `/oe status` — deploy sanity: app version, deployment sha, eve pin, model config, memory provider.",
    "• `/oe stop` — stand down the turn running in this channel (free, instant, works over a spend cap).",
    "• `/oe budget` — this channel's and workspace's effective spend caps + current-month spend.",
    "• `/oe budget raise <usd>` — propose a new monthly USD cap for this channel (posts an approval card; an admin decides).",
    "• `/oe budget clear` — propose clearing this channel's spend-limit override back to config (posts an approval card).",
    "• `/oe help` — this message.",
  ].join("\n");
}

function fmtTokenCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function renderStatus(info: AppInfo, memoryProviderId: string, telemetryStatus = "unknown"): string {
  const { contextWindowTokens: windowTokens, compactionThresholdTokens: thresholdTokens } = info;
  return [
    hasRealAppVersion(info) ? `*Open Everywhere* v${info.version}` : "*Open Everywhere*",
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
    `• this channel (\`${f.surfaceKey}\`): ${f.surfaceTokens.toLocaleString()} / ${fmtCap(f.caps.surfaceMonthlyTokens, "tokens")} tokens · ` +
      `~$${f.surfaceUsd.toFixed(2)} / ${fmtCap(f.caps.surfaceMonthlyUsd, "usd")}`,
    `• whole workspace (\`${f.workspaceKey}\`): ${f.workspaceTokens.toLocaleString()} / ${fmtCap(f.caps.workspaceMonthlyTokens, "tokens")} tokens · ` +
      `~$${f.workspaceUsd.toFixed(2)} / ${fmtCap(f.caps.workspaceMonthlyUsd, "usd")}`,
    "_propose a change with `/oe budget raise <usd>` or `/oe budget clear`._",
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
}

function requireChannelId(binding: SurfaceBinding): string {
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) {
    throw new Error("couldn't resolve this channel's id — try this from a real channel or DM, not a synthetic context.");
  }
  return channelId;
}

export async function runBudgetRaise(binding: SurfaceBinding, usd: number, deps: OeApprovalDeps = {}): Promise<string> {
  requireCardPathHere('"/oe budget raise"', binding.platform);
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
    reason: `requested via "/oe budget raise" by ${mentionFor(binding)}`,
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
  if (posted.autoApproved) {
    return (
      `Done — $${usd.toFixed(2)}/month on \`${plan.scopeKey}\` is already in force: the approver chain auto-approved it ` +
      `(${posted.autoApproved.resolvedBy}), so no card was posted — ${posted.autoApproved.outcome}`
    );
  }
  return (
    `Card posted in this channel — proposing $${usd.toFixed(2)}/month on \`${plan.scopeKey}\` ` +
    `(pending \`${posted.id}\`, expires ${posted.expiresAt}). An admin needs to Approve it.`
  );
}

export async function runBudgetClear(binding: SurfaceBinding, deps: OeApprovalDeps = {}): Promise<string> {
  requireCardPathHere('"/oe budget clear"', binding.platform);
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
    return "Couldn't resolve this channel — try `/oe stop` from a real channel or DM, not a synthetic context.";
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
  }
}
