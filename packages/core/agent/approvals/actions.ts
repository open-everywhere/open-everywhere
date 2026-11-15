import { getOperationalStore } from "../operational/provider.js";
import { haltAddressFields, haltAddressFromParts } from "../access/halt.js";
import { appendAudit } from "../audit/audit.js";
import { parseScopeKey } from "../access/scope-key.js";
import { principalKey } from "../identity/principal-key.js";
import type { CapLevel } from "../operational/store.js";
import type { ActionKind, PendingActionRow } from "./types.js";
import { placeWords } from "../channels/friendly-ids.js";
import { plainValue } from "./plain-text.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

const REGISTRY = new Map<string, ActionKind<any>>();

export function registerActionKind(k: ActionKind<any>): void {
  REGISTRY.set(k.kind, k);
}

export function actionKind(kind: string): ActionKind<any> | undefined {
  return REGISTRY.get(kind);
}

export function registeredActionKinds(): string[] {
  return [...REGISTRY.keys()].sort();
}

export function summarizeFrozenRow(row: PendingActionRow): string[] {
  const kindDef = actionKind(row.kind);
  if (!kindDef) return [`(no registered ActionKind for "${row.kind}")`];
  try {
    const args = JSON.parse(row.argsJson);
    return kindDef.summarize(args);
  } catch {
    return ["(failed to render this pending's summary)"];
  }
}

export function whereFromScope(org: string, scopeKey: string): { org: string; platform: string; workspace: string; surface?: string } {
  const parsed = parseScopeKey(scopeKey);
  switch (parsed.kind) {
    case "domain":
      return { org, platform: "domain", workspace: parsed.name || "unknown" };
    case "principal":
      return { org, platform: "user", workspace: principalKey(parsed.platform, parsed.tenant, parsed.id) };
    case "tenant":
      return { org, platform: parsed.platform, workspace: parsed.workspace };
    case "surface":
      return { org, platform: parsed.platform, workspace: parsed.workspace, surface: parsed.surface };
    case "malformed": {
      const [platform, workspace, surface] = parsed.parts;
      return { org, platform: platform || "unknown", workspace: workspace || "unknown", ...(surface ? { surface } : {}) };
    }
  }
}

export function orgWideWhere(org: string): { org: string; platform: string; workspace: string } {
  return { org, platform: "org", workspace: org };
}

function fmtCap(tokens: number | null): string {
  return tokens === null ? "none (uncapped)" : `${tokens.toLocaleString()} tokens/mo`;
}

function fmtCapUsd(usd: number | null): string {
  return usd === null ? "none (uncapped)" : `$${usd.toFixed(2)}/mo`;
}

function plainUsd(usd: number): string {
  const whole = Number.isInteger(usd);
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function plainCapUsd(usd: number | null): string {
  return usd === null ? "no limit" : `${plainUsd(usd)}/mo`;
}
function plainCapTokens(tokens: number | null): string {
  return tokens === null ? "no limit" : `${tokens.toLocaleString("en-US")} tokens/mo`;
}

export function spendConsequenceLine(args: Pick<SpendSetArgs, "monthlyTokens" | "monthlyUsd" | "currentCap" | "currentUsd">): string | undefined {
  const clauses: string[] = [];
  if (args.monthlyUsd != null) clauses.push(`from ${plainCapUsd(args.currentUsd ?? null)} to ${plainCapUsd(args.monthlyUsd)}`);
  if (args.monthlyTokens != null) clauses.push(`from ${plainCapTokens(args.currentCap)} to ${plainCapTokens(args.monthlyTokens)}`);
  if (clauses.length === 0) return undefined;
  const line = clauses.join(", and ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function scopeLine(label: string | undefined, scopeKey: string, level: string): string {
  return `${scopeWords(label, scopeKey)} (${level})`;
}

function scopeWords(label: string | undefined, scopeKey: string): string {
  return label !== undefined && label.trim().length > 0 ? plainValue(label) : placeWords({ key: scopeKey });
}

function plainScope(label: string | undefined, scopeKey: string): string {
  return scopeWords(label, scopeKey);
}

export interface SpendSetArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly level: CapLevel;
  readonly monthlyTokens?: number;
  readonly monthlyUsd?: number;
  readonly reason?: string;
  readonly scopeLabel?: string;
  readonly tainted?: boolean;
  readonly currentCap: number | null;
  readonly currentUsd?: number | null;
  readonly coverage?: SpendCoverage;
}

export type SpendCoverage =
  | { readonly measured: "full"; readonly windowDays: number }
  | { readonly measured: "no-traffic"; readonly windowDays: number }
  | { readonly measured: "gap"; readonly windowDays: number; readonly unratedModels: readonly string[]; readonly unobservedModels: readonly string[] }
  | { readonly measured: "none"; readonly why: string };

const COVERAGE_MODELS_SHOWN = 8;

function namedModels(models: readonly string[]): string {
  if (models.length <= COVERAGE_MODELS_SHOWN) return models.join(", ");
  return `${models.slice(0, COVERAGE_MODELS_SHOWN).join(", ")} and ${models.length - COVERAGE_MODELS_SHOWN} more`;
}

function spendCoverageLines(coverage: SpendCoverage | undefined): string[] {
  if (coverage === undefined) return [];
  switch (coverage.measured) {
    case "none":
      return [`⚠ pricing coverage NOT MEASURED when this card was posted — ${coverage.why} This $ figure may not meter all of this scope's traffic.`];
    case "no-traffic":
      return [`ℹ pricing coverage: this scope ran no traffic in the ${coverage.windowDays} days before this card was posted, so nothing here shows whether this $ cap would meter it`];
    case "full":
      return [`✅ pricing coverage: every model this scope ran on in the ${coverage.windowDays} days before this card was posted carried a committed price`];
    case "gap": {
      const lines: string[] = [];
      if (coverage.unratedModels.length > 0) {
        lines.push(
          `⚠ pricing coverage: this $ cap does NOT count calls on ${namedModels(coverage.unratedModels)} — they carry no committed price and add $0 to the spend ledger` +
            ` (measured over the ${coverage.windowDays} days before this card was posted). The cap still sums every other priced row, and a token cap is unaffected.`,
        );
      }
      if (coverage.unobservedModels.length > 0) {
        lines.push(
          `⚠ pricing coverage: some of this scope's rows record no model at all (${namedModels(coverage.unobservedModels)}), so the cap does not count them either` +
            ` (measured over the ${coverage.windowDays} days before this card was posted).` +
            ` That is an instrumentation gap, not a pricing one — no rate can be committed for them, because nothing observed which model ran.`,
        );
      }
      return lines;
    }
    default:
      return ["⚠ pricing coverage: this card carries a coverage state this deploy cannot read — treat the $ figure's coverage as unknown"];
  }
}

function spendCoverageDetail(coverage: SpendCoverage | undefined): AuditDetail {
  if (coverage === undefined) return {};
  switch (coverage.measured) {
    case "gap":
      return {
        pricingCoverage: "gap",
        ...(coverage.unratedModels.length > 0 ? { unratedModels: [...coverage.unratedModels] } : {}),
        ...(coverage.unobservedModels.length > 0 ? { unobservedModels: [...coverage.unobservedModels] } : {}),
      };
    case "none":
      return { pricingCoverage: "not-measured" };
    case "no-traffic":
      return { pricingCoverage: "no-traffic" };
    case "full":
      return { pricingCoverage: "full" };
    default:
      return { pricingCoverage: "unknown" };
  }
}

function spendChangeLines(args: SpendSetArgs): string[] {
  const lines: string[] = [];
  if (args.monthlyTokens != null) lines.push(`tokens: ${fmtCap(args.currentCap)} → ${fmtCap(args.monthlyTokens)}`);
  if (args.monthlyUsd != null) lines.push(`$: ${fmtCapUsd(args.currentUsd ?? null)} → ${fmtCapUsd(args.monthlyUsd)}`);
  return lines;
}

const spendSet: ActionKind<SpendSetArgs> = {
  kind: "spend.set",
  policy: "admin",
  volatileArgs: ["coverage"],
  proseArgs: ["reason"],
  plainSummary(args) {
    const figures = [
      ...(args.monthlyTokens != null ? [plainCapTokens(args.monthlyTokens)] : []),
      ...(args.monthlyUsd != null ? [plainCapUsd(args.monthlyUsd)] : []),
    ].join(" and ");
    return `Set the monthly spend limit for ${plainScope(args.scopeLabel, args.scopeKey)} to ${figures || "a new figure"}`;
  },
  consequence(args) {
    return spendConsequenceLine(args);
  },
  summarize(args) {
    return [
      `Set spend limit — ${scopeLine(args.scopeLabel, args.scopeKey, args.level)}`,
      ...spendChangeLines(args),
      ...spendCoverageLines(args.coverage),
      ...(args.reason ? [`Reason: ${args.reason}`] : []),
    ];
  },
  async execute(args, decidedBy) {
    const store = getOperationalStore();
    await store.setSpendLimit(
      args.org,
      args.scopeKey,
      args.level,
      { monthlyTokens: args.monthlyTokens, monthlyUsd: args.monthlyUsd },
      { reason: args.reason, setBy: decidedBy },
    );
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "admin.spend.set_limit",
      detail: {
        scopeKey: args.scopeKey,
        level: args.level,
        ...(args.monthlyTokens != null ? { monthlyTokens: args.monthlyTokens } : {}),
        ...(args.monthlyUsd != null ? { monthlyUsd: args.monthlyUsd } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
        ...spendCoverageDetail(args.coverage),
      },
    });
    const set = [
      ...(args.monthlyTokens != null ? [plainCapTokens(args.monthlyTokens)] : []),
      ...(args.monthlyUsd != null ? [plainCapUsd(args.monthlyUsd)] : []),
    ].join(" and ");
    return `spend limit set to ${set} for ${scopeWords(args.scopeLabel, args.scopeKey)}`;
  },
};

export interface SpendClearArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly level: CapLevel;
  readonly currentCap: number | null;
  readonly currentUsd?: number | null;
  readonly afterCap?: number | null;
  readonly afterUsd?: number | null;
  readonly scopeLabel?: string;
  readonly tainted?: boolean;
}

export function spendClearConsequenceLine(args: Pick<SpendClearArgs, "currentCap" | "currentUsd" | "afterCap" | "afterUsd">): string | undefined {
  if (args.afterCap === undefined && args.afterUsd === undefined) return undefined;
  const clauses: string[] = [];
  const nowUsd = args.currentUsd ?? null;
  const afterUsd = args.afterUsd ?? null;
  const afterCap = args.afterCap ?? null;
  if (nowUsd !== null || afterUsd !== null) clauses.push(`from ${plainCapUsd(nowUsd)} to ${plainCapUsd(afterUsd)}`);
  if (args.currentCap !== null || afterCap !== null) clauses.push(`from ${plainCapTokens(args.currentCap)} to ${plainCapTokens(afterCap)}`);
  if (clauses.length === 0) return undefined;
  const line = `${clauses.join(", and ")} (the default)`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function spendClearAfterWords(args: Pick<SpendClearArgs, "afterCap" | "afterUsd">): string | undefined {
  if (args.afterCap === undefined && args.afterUsd === undefined) return undefined;
  const parts = [...(args.afterUsd != null ? [plainCapUsd(args.afterUsd)] : []), ...(args.afterCap != null ? [plainCapTokens(args.afterCap)] : [])];
  return parts.length > 0 ? parts.join(" and ") : "no limit";
}

const spendClear: ActionKind<SpendClearArgs> = {
  kind: "spend.clear",
  policy: "admin",
  volatileArgs: ["afterCap", "afterUsd"],
  plainSummary(args) {
    return `Reset the spend limit for ${plainScope(args.scopeLabel, args.scopeKey)} to the default`;
  },
  consequence(args) {
    return spendClearConsequenceLine(args);
  },
  doneSummary(args) {
    const after = spendClearAfterWords(args);
    return `reset the spend limit for ${scopeWords(args.scopeLabel, args.scopeKey)} to ${after ?? "the default"}`;
  },
  summarize(args) {
    const current = [
      ...(args.currentCap !== null ? [fmtCap(args.currentCap)] : []),
      ...(args.currentUsd != null ? [fmtCapUsd(args.currentUsd)] : []),
    ];
    const after = spendClearAfterWords(args);
    return [
      `Clear spend limit override — ${scopeLine(args.scopeLabel, args.scopeKey, args.level)}`,
      `${current.length ? current.join(" + ") : "none (uncapped)"} → ${after === undefined ? "the configured limit" : `${after} (the configured limit)`}`,
    ];
  },
  async execute(args, decidedBy) {
    const store = getOperationalStore();
    const cleared = await store.clearSpendLimit(args.org, args.scopeKey, args.level);
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "admin.spend.clear_limit",
      detail: { scopeKey: args.scopeKey, level: args.level, cleared },
    });
    const scope = scopeWords(args.scopeLabel, args.scopeKey);
    return cleared
      ? `the spend limit for ${scope} is back to the default`
      : `${scope} had no spend limit override, so nothing changed`;
  },
};

interface ConnectorRevokeArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly connector: string;
  readonly reason?: string;
}

const connectorRevoke: ActionKind<ConnectorRevokeArgs> = {
  kind: "connector.revoke",
  policy: "admin",
  plainSummary(args) {
    return `Turn off the ${plainValue(args.connector)} connector for ${placeWords({ key: args.scopeKey })}`;
  },
  summarize(args) {
    return [`Revoke connector \`${args.connector}\` — for ${placeWords({ key: args.scopeKey })}`, ...(args.reason ? [`Reason: ${args.reason}`] : [])];
  },
  async execute(args, decidedBy) {
    const store = getOperationalStore();
    await store.setConnectorOverride(args.org, args.scopeKey, args.connector, false, { reason: args.reason, setBy: decidedBy });
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "admin.connector.revoke",
      detail: { connector: args.connector, ...(args.reason ? { reason: args.reason } : {}) },
    });
    return `${args.connector} turned off for ${placeWords({ key: args.scopeKey })}`;
  },
};

interface ConnectorClearArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly connector: string;
}

const connectorClear: ActionKind<ConnectorClearArgs> = {
  kind: "connector.clear",
  policy: "admin",
  plainSummary(args) {
    return `Put the ${plainValue(args.connector)} connector back on its configured access for ${placeWords({ key: args.scopeKey })}`;
  },
  summarize(args) {
    return [`Clear connector override \`${args.connector}\` — for ${placeWords({ key: args.scopeKey })}`, `Reverts to the config-as-code bundle grant`];
  },
  async execute(args, decidedBy) {
    const store = getOperationalStore();
    const cleared = await store.clearConnectorOverride(args.org, args.scopeKey, args.connector);
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "admin.connector.clear_override",
      detail: { connector: args.connector, cleared },
    });
    return cleared
      ? `${args.connector} is back on its configured access in ${placeWords({ key: args.scopeKey })}`
      : `${args.connector} had no override in ${placeWords({ key: args.scopeKey })}, so nothing changed`;
  },
};

export interface HaltResumeArgs {
  readonly org: string;
  readonly orgWide?: true;
  readonly level?: CapLevel;
  readonly scopeKey?: string;
  readonly scopeLabel?: string;
}

const haltResume: ActionKind<HaltResumeArgs> = {
  kind: "halt.resume",
  policy: "admin",
  plainSummary(args) {
    const where = args.orgWide === true ? "everywhere in this org" : `for ${plainScope(args.scopeLabel, args.scopeKey ?? "")}`;
    return `Lift the emergency halt ${where}, so the agent can act again`;
  },
  summarize(args) {
    const where = args.orgWide === true ? "everywhere in this org" : `${scopeWords(args.scopeLabel, args.scopeKey ?? "")} (${args.level})`;
    return [
      `Resume — lift the break-glass halt ${where}`,
      "Consequential acts start working again: approvals, routine fires, connector calls, credential grants and outbound network access.",
      ...(args.scopeLabel ? [`Scope: ${args.scopeLabel}`] : []),
    ];
  },
  async execute(args, decidedBy) {
    const address = haltAddressFromParts(args);
    const cleared = await getOperationalStore().clearHalt(args.org, address, { clearedBy: decidedBy });
    await appendAudit({
      ...(address.orgWide ? orgWideWhere(args.org) : whereFromScope(args.org, address.scopeKey)),
      principalId: decidedBy,
      action: "admin.halt.cleared",
      detail: { ...haltAddressFields(address), cleared },
    });
    return cleared
      ? `halt lifted${args.orgWide === true ? " everywhere" : ` for ${scopeWords(args.scopeLabel, args.scopeKey ?? "")}`}, so the agent can act again`
      : `no halt was in force${args.orgWide === true ? " anywhere" : ` for ${scopeWords(args.scopeLabel, args.scopeKey ?? "")}`}, so nothing changed`;
  },
};

registerActionKind(spendSet);
registerActionKind(spendClear);
registerActionKind(connectorRevoke);
registerActionKind(connectorClear);
registerActionKind(haltResume);
