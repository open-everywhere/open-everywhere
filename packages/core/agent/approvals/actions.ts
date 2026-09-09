import { getOperationalStore } from "../operational/provider.js";
import { haltAddressFields, haltAddressFromParts } from "../access/halt.js";
import { appendAudit } from "../audit/audit.js";
import { parseScopeKey } from "../access/scope-key.js";
import { principalKey } from "../identity/principal-key.js";
import type { CapLevel } from "../operational/store.js";
import type { ActionKind, PendingActionRow } from "./types.js";
import { withTaintDisclosure } from "./taint-disclosure.js";

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
    return withTaintDisclosure(kindDef.summarize(args), args, { live: false });
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

function scopeLine(label: string | undefined, scopeKey: string, level: string): string {
  return label ? `${label} (${level})` : `scope \`${scopeKey}\` (${level})`;
}

function spendTaintLines(tainted: boolean | undefined): string[] {
  return tainted ? ["⚠ proposed in a turn that read external content — confirm a person actually asked for this budget change before approving"] : [];
}

export interface SpendSetArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly level: CapLevel;
  readonly monthlyTokens?: number;
  readonly monthlyUsd?: number;
  readonly reason?: string;
  readonly scopeLabel?: string;
  readonly currentCap: number | null;
  readonly currentUsd?: number | null;
  readonly tainted?: boolean;
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

function spendCoverageDetail(coverage: SpendCoverage | undefined): Record<string, unknown> {
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
  summarize(args) {
    return [
      `Set spend limit — ${scopeLine(args.scopeLabel, args.scopeKey, args.level)}`,
      ...spendChangeLines(args),
      ...spendCoverageLines(args.coverage),
      ...(args.reason ? [`Reason: ${args.reason}`] : []),
      ...spendTaintLines(args.tainted),
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
        ...(args.tainted ? { tainted: true } : {}),
        ...spendCoverageDetail(args.coverage),
      },
    });
    const set = [
      ...(args.monthlyTokens != null ? [fmtCap(args.monthlyTokens)] : []),
      ...(args.monthlyUsd != null ? [fmtCapUsd(args.monthlyUsd)] : []),
    ].join(" + ");
    return `spend limit set to ${set} for ${args.scopeLabel ?? `\`${args.scopeKey}\``} (${args.level})`;
  },
};

export interface SpendClearArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly level: CapLevel;
  readonly currentCap: number | null;
  readonly currentUsd?: number | null;
  readonly scopeLabel?: string;
  readonly tainted?: boolean;
}

const spendClear: ActionKind<SpendClearArgs> = {
  kind: "spend.clear",
  policy: "admin",
  summarize(args) {
    const current = [
      ...(args.currentCap !== null ? [fmtCap(args.currentCap)] : []),
      ...(args.currentUsd != null ? [fmtCapUsd(args.currentUsd)] : []),
    ];
    return [
      `Clear spend limit override — ${scopeLine(args.scopeLabel, args.scopeKey, args.level)}`,
      `${current.length ? current.join(" + ") : "none (uncapped)"} → reverts to the config-as-code cap`,
      ...spendTaintLines(args.tainted),
    ];
  },
  async execute(args, decidedBy) {
    const store = getOperationalStore();
    const cleared = await store.clearSpendLimit(args.org, args.scopeKey, args.level);
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "admin.spend.clear_limit",
      detail: { scopeKey: args.scopeKey, level: args.level, cleared, ...(args.tainted ? { tainted: true } : {}) },
    });
    const scope = args.scopeLabel ?? `\`${args.scopeKey}\``;
    return cleared
      ? `spend limit override cleared for ${scope} (${args.level}) — reverted to config`
      : `no spend limit override was set for ${scope} (${args.level}) — nothing to clear`;
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
  summarize(args) {
    return [`Revoke connector \`${args.connector}\` — scope \`${args.scopeKey}\``, ...(args.reason ? [`Reason: ${args.reason}`] : [])];
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
    return `connector \`${args.connector}\` revoked for \`${args.scopeKey}\``;
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
  summarize(args) {
    return [`Clear connector override \`${args.connector}\` — scope \`${args.scopeKey}\``, `Reverts to the config-as-code bundle grant`];
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
      ? `connector override cleared for \`${args.connector}\` on \`${args.scopeKey}\` — reverted to config`
      : `no connector override was set for \`${args.connector}\` on \`${args.scopeKey}\` — nothing to clear`;
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
  summarize(args) {
    const where = args.orgWide === true ? "everywhere in this org" : `\`${args.scopeKey}\` (${args.level})`;
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
      ? `halt cleared${args.orgWide === true ? " org-wide" : ` for \`${args.scopeKey}\``} — consequential acts work again`
      : `no halt was in force${args.orgWide === true ? " org-wide" : ` for \`${args.scopeKey}\``} — nothing to clear`;
  },
};

registerActionKind(spendSet);
registerActionKind(spendClear);
registerActionKind(connectorRevoke);
registerActionKind(connectorClear);
registerActionKind(haltResume);
