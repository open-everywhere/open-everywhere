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
  const [platform, workspace, surface] = scopeKey.split("/");
  return { org, platform: platform || "unknown", workspace: workspace || "unknown", ...(surface ? { surface } : {}) };
}

function fmtCap(tokens: number | null): string {
  return tokens === null ? "none (uncapped)" : `${tokens.toLocaleString()} tokens/mo`;
}

export interface SpendSetArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly level: CapLevel;
  readonly monthlyTokens: number;
  readonly reason?: string;
  readonly currentCap: number | null;
}

const spendSet: ActionKind<SpendSetArgs> = {
  kind: "spend.set",
  policy: "admin",
  summarize(args) {
    return [
      `Set spend limit — scope \`${args.scopeKey}\` (${args.level})`,
      `${fmtCap(args.currentCap)} → ${fmtCap(args.monthlyTokens)}`,
      ...(args.reason ? [`Reason: ${args.reason}`] : []),
    ];
  },
  async execute(args, decidedBy) {
    const store = getOperationalStore();
    await store.setSpendLimit(args.org, args.scopeKey, args.level, args.monthlyTokens, { reason: args.reason, setBy: decidedBy });
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "admin.spend.set_limit",
      detail: { scopeKey: args.scopeKey, level: args.level, monthlyTokens: args.monthlyTokens, ...(args.reason ? { reason: args.reason } : {}) },
    });
    return `spend limit set to ${fmtCap(args.monthlyTokens)} for \`${args.scopeKey}\` (${args.level})`;
  },
};

export interface SpendClearArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly level: CapLevel;
  readonly currentCap: number | null;
}

const spendClear: ActionKind<SpendClearArgs> = {
  kind: "spend.clear",
  policy: "admin",
  summarize(args) {
    return [`Clear spend limit override — scope \`${args.scopeKey}\` (${args.level})`, `${fmtCap(args.currentCap)} → reverts to the config-as-code cap`];
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
    return cleared
      ? `spend limit override cleared for \`${args.scopeKey}\` (${args.level}) — reverted to config`
      : `no spend limit override was set for \`${args.scopeKey}\` (${args.level}) — nothing to clear`;
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
