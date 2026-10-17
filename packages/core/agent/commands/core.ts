import { placeWords } from "../channels/friendly-ids.js";
import { friendlyMonth, PersonFacingError } from "../channels/person-text.js";
import { unattendedFrom, type SurfaceBinding } from "../identity/binding.js";
import { cancelAnchoredTurn, type AttachSessionForCancel } from "../channels/turn-cancel.js";
import { turnAnchorAddress, turnChannelKey } from "../channels/turn-registry.js";
import { ownCardRoom } from "../approvals/card-venue.js";
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
  capsAfterClearFor,
  type SetSpendLimitInput,
  type CurrentCaps,
} from "../tools/set_spend_limit.js";
import { planClearSpendLimit, type ClearSpendLimitInput } from "../tools/clear_spend_limit.js";
import { domainSpendWindow, reportDomainForBinding } from "../spend/reporting.js";
import type { SkillDomainRefusal } from "../skills/domain-skills.js";
import { parseRateTokens, runRate, rateHelpLine, type RateCommand } from "./rate.js";
import { optOutHelpLine, parseOptOutTokens, runOptOut, type OptOutCommand } from "./optout.js";
import { parseWatchTokens, runWatch, watchHelpLine, type WatchCommand } from "./watch.js";
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
  | Extract<OptOutCommand, { kind: "optout" }>
  | Extract<WatchCommand, { kind: "watch" }>
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
        message: `Add an amount in dollars, for example \`${oeSlash("budget raise 25")}\`.`,
      };
    }
    return { kind: "budget-raise", usd };
  }
  return {
    kind: "error",
    message: `I don't know "${action}". Try \`${oeSlash("budget")}\`, \`${oeSlash("budget raise 25")}\` or \`${oeSlash("budget clear")}\`.`,
  };
}

export function parseOeCommandTokens(tokens: readonly string[]): OeCommand {
  const [sub, ...rest] = tokens;
  if (!sub || sub === "help") return { kind: "help" };
  if (sub === "status") return { kind: "status" };
  if (sub === "stop") return { kind: "stop" };
  if (sub === "rate") return parseRateTokens(rest);
  if (sub === "budget") return parseBudgetTokens(rest);
  if (sub === "optout") return parseOptOutTokens(rest);
  if (sub === "watch") return parseWatchTokens(rest);
  return { kind: "error", message: `I don't know "${sub}". Try \`${oeSlash("help")}\` to see what I can do.` };
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
    `*${oeSlash()}* — quick commands. They answer at once, even when I'm over budget:`,
    `• \`${oeSlash("status")}\` — check that I'm running, with version details for your admin.`,
    `• \`${oeSlash("stop")}\` — stop what I'm doing in this channel.`,
    `• \`${oeSlash("budget")}\` — see this month's spending and limits.`,
    `• \`${oeSlash("budget raise <usd>")}\` — ask an admin for a new monthly limit for this channel.`,
    `• \`${oeSlash("budget clear")}\` — ask an admin to put this channel back on the usual limit.`,
    rateHelpLine(),
    optOutHelpLine(),
    watchHelpLine(),
    `• \`${oeSlash("help")}\` — show this list.`,
  ].join("\n");
}

function fmtTokenCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function renderStatus(info: AppInfo, memoryProviderId: string, telemetryStatus = "unknown"): string {
  const { contextWindowTokens: windowTokens, compactionThresholdTokens: thresholdTokens } = info;
  return [
    hasRealAppVersion(info) ? `*${agentDisplayName()}* v${info.version} is running.` : `*${agentDisplayName()}* is running.`,
    "_Details for your admin:_",
    `• build: \`${info.deploymentSha}\``,
    `• eve: \`${info.evePin}\``,
    `• main model: \`${info.primaryModel}\``,
    `• helper model: \`${info.utilityModel}\``,
    ...(windowTokens !== undefined && thresholdTokens !== undefined && windowTokens > 0
      ? [
          `• context window: \`${fmtTokenCount(windowTokens)}\` tokens — summarised at ` +
            `\`${fmtTokenCount(thresholdTokens)}\` (${Math.round((thresholdTokens / windowTokens) * 100)}%)`,
        ]
      : []),
    `• memory: \`${memoryProviderId}\``,
    `• telemetry: \`${telemetryStatus}\``,
  ].join("\n");
}

function fmtCap(n: number | null | undefined, unit: "tokens" | "usd"): string {
  if (n == null) return "no limit";
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
    "*Spending this month*",
    `• this channel: about $${f.surfaceUsd.toFixed(2)} of ${fmtCap(f.caps.surfaceMonthlyUsd, "usd")} · ` +
      `${fmtTokenCount(f.surfaceTokens)} of ${fmtCap(f.caps.surfaceMonthlyTokens, "tokens")} tokens`,
    `• whole workspace: about $${f.workspaceUsd.toFixed(2)} of ${fmtCap(f.caps.workspaceMonthlyUsd, "usd")} · ` +
      `${fmtTokenCount(f.workspaceTokens)} of ${fmtCap(f.caps.workspaceMonthlyTokens, "tokens")} tokens`,
    `_To change this channel's limit, use \`${oeSlash("budget raise <usd>")}\` or \`${oeSlash("budget clear")}\`._`,
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
  readonly capsAfterClear?: typeof capsAfterClearFor;
}

export const CARD_IS_THE_ANSWER = "";

const ALREADY_WAITING = "That request is already waiting for an admin.";

function noDomainSpendReason(reason: SkillDomainRefusal): string {
  switch (reason) {
    case "dm":
      return "a direct message is not part of a domain";
    case "mpim":
      return "a group chat is not part of a domain";
    case "external":
      return "I can't confirm this channel is only your organisation's";
    case "unassigned":
      return "this channel is not part of a domain yet";
  }
}

export const BUDGET_RAISE_SCAN_DAYS = 30;

async function budgetRaiseSpendSentence(binding: SurfaceBinding, deps: OeApprovalDeps): Promise<string> {
  const domains = deps.domains ?? getConfig().loadDomains();
  const resolved = reportDomainForBinding(binding, domains);
  if (resolved.domain === null) {
    console.log(`[open-everywhere:spend] "${oeSlash("budget raise")}" shows no domain spend: ${noDomainSpendReason(resolved.reason)}`);
    return "";
  }
  try {
    const scan = await (deps.domainSpendWindow ?? domainSpendWindow)(
      binding.org,
      resolved.domain,
      deps.nowISO ? deps.nowISO() : new Date().toISOString(),
      BUDGET_RAISE_SCAN_DAYS,
      { domains },
    );
    return `For comparison, ${scan.domain} spent about $${scan.usd.toFixed(2)} in ${monthList(scan.periods)}.`;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`[open-everywhere:spend] "${oeSlash("budget raise")}" could not scan domain "${resolved.domain}" spend: ${why}`);
    return `I couldn't load ${resolved.domain}'s spending just now.`;
  }
}

function requireChannelId(binding: SurfaceBinding): string {
  const channelId = ownCardRoom(binding)?.channelId;
  if (!channelId) {
    throw new PersonFacingError("I can't do that here. Try it in a channel or a direct message.");
  }
  return channelId;
}

async function askAdmin<T>(post: () => Promise<T>): Promise<T> {
  try {
    return await post();
  } catch (err) {
    if (err instanceof PersonFacingError) throw err;
    console.warn(`[open-everywhere:commands] the budget request could not be sent: ${err instanceof Error ? err.message : String(err)}`);
    throw new PersonFacingError("I couldn't send that request. Try again in a moment, and if it still fails, ask your admin.");
  }
}

function monthList(periods: readonly string[]): string {
  const words = periods.map(friendlyMonth);
  return words.length <= 1 ? (words[0] ?? "recent months") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  const place = placeWords({ key: plan.scopeKey, ...(scopeLabel ? { label: scopeLabel } : {}) });
  const coverageReport = await (deps.readSpendCoverage ?? readSpendCoverage)(plan.args.org, plan.args.level, plan.args.scopeKey, plan.args.monthlyUsd);
  const coverage = coverageReport === undefined ? undefined : frozenCoverage(coverageReport);
  const posted = await askAdmin(() =>
    requestApprovalFn(
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
    ),
  );
  const spendSentence = await budgetRaiseSpendSentence(binding, deps);
  if (posted.autoApproved) {
    return [`Done. The limit for ${place} is now ${plainUsd(usd)} a month.`, spendSentence].filter(Boolean).join("\n");
  }
  if (posted.deduped) return [ALREADY_WAITING, spendSentence].filter(Boolean).join("\n");
  return spendSentence || CARD_IS_THE_ANSWER;
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
  const after = await (deps.capsAfterClear ?? capsAfterClearFor)(binding.org, workspaceKey, level, scopeKey, binding.mode, binding.trust);
  const plan = planClearSpendLimit(binding, input, current, domain, after);

  const channelId = requireChannelId(binding);
  const scopeLabel = await friendlyScopeLabelFn(plan.scopeKey);
  const place = placeWords({ key: plan.scopeKey, ...(scopeLabel ? { label: scopeLabel } : {}) });
  const posted = await askAdmin(() =>
    requestApprovalFn(
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
    ),
  );
  if (posted.autoApproved) {
    return `Done. ${capitalise(place)} is back on the default limit.`;
  }
  if (posted.deduped) return ALREADY_WAITING;
  return CARD_IS_THE_ANSWER;
}

function plainUsd(usd: number): string {
  const whole = Number.isInteger(usd);
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export interface OeCommandDeps {
  readonly attachSession?: AttachSessionForCancel;
}

export async function runStop(binding: SurfaceBinding, attachSession: AttachSessionForCancel | undefined): Promise<string> {
  if (!attachSession) {
    return "I can't stop from a command here. React to my message with the raised-hand emoji ✋ instead.";
  }
  const channelId = turnAnchorAddress(binding).channelId;
  const channelKey = turnChannelKey(binding.platform, channelId);
  if (!channelKey) {
    return `I can't do that here. Try \`${oeSlash("stop")}\` in a channel or a direct message.`;
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
    case "optout":
      return runOptOut(binding, cmd.action);
    case "watch":
      return runWatch(binding, cmd.action);
  }
}
