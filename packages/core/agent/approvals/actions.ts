import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import type { CapLevel } from "../operational/store.js";
import type { ActionKind } from "./types.js";

const REGISTRY = new Map<string, ActionKind<any>>();

export function registerActionKind(k: ActionKind<any>): void {
  REGISTRY.set(k.kind, k);
}

export function actionKind(kind: string): ActionKind<any> | undefined {
  return REGISTRY.get(kind);
}

export function whereFromScope(org: string, scopeKey: string): { org: string; platform: string; workspace: string; surface?: string } {
  const parts = scopeKey.split("/");
  if (parts.length === 1) {
    return { org, platform: "domain", workspace: parts[0] || "unknown" };
  }
  const [platform, workspace, surface] = parts;
  return { org, platform: platform || "unknown", workspace: workspace || "unknown", ...(surface ? { surface } : {}) };
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
    const scope = args.scopeLabel ?? `\`${args.scopeKey}\``;
    return cleared
      ? `spend limit override cleared for ${scope} (${args.level}) — reverted to config`
      : `no spend limit override was set for ${scope} (${args.level}) — nothing to clear`;
  },
};

export interface ConnectorRevokeArgs {
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

export interface ConnectorClearArgs {
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

registerActionKind(spendSet);
registerActionKind(spendClear);
registerActionKind(connectorRevoke);
registerActionKind(connectorClear);
