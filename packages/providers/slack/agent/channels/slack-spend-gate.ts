import {
  resolvePartition,
  bindFrom,
  scopeOverBudget,
  capBypassFor,
  getOperationalStore,
  type BindableContext,
  type SessionMode,
} from "@open-everywhere/core/agent/adapter-api.js";

export type SpendGateDoor = "mention" | "engagement" | "join";

export type SpendGateDecision = "proceed" | "declined";

interface Verdict {
  readonly over: boolean;
  readonly reason?: string;
}

export interface SlackSpendGateInput {
  readonly bindable: BindableContext;
  readonly mode: SessionMode;
  readonly principalId?: string;
  readonly teamId?: string | null;
  readonly door: SpendGateDoor;
  readonly post: (text: string) => Promise<void>;
  readonly checkOverBudget?: (bindable: BindableContext, mode: SessionMode) => Promise<Verdict>;
  readonly bypassFor?: (input: {
    readonly org: string;
    readonly principalId: string | undefined;
    readonly surfaceKey: string;
    readonly reason?: string;
  }) => Promise<{ readonly warn: boolean } | null>;
  readonly appendGateAudit?: (row: SpendGateAuditRow) => Promise<void>;
}

export interface SpendGateAuditRow {
  readonly ts: string;
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly action: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export function spendRefusalCopy(reason: string | undefined, surfaceKey: string, workspaceKey: string): string {
  return `:no_entry: I'm holding off here — ${reason}. An admin can raise this permanently in the spend-budgets config, or DM me to propose a temporary override — an admin approves it on a card. Scope keys for the override: this channel = \`${surfaceKey}\`, whole workspace = \`${workspaceKey}\`.`;
}

export function spendBypassWarnCopy(reason: string | undefined): string {
  return `:warning: ${reason} — proceeding because you're an admin. Ask me here to raise or clear the cap (an approval card follows), or change it permanently in the spend-budgets config.`;
}

export async function slackSpendGate(input: SlackSpendGateInput): Promise<SpendGateDecision> {
  const check = input.checkOverBudget ?? liveCheckOverBudget;
  const bypass = input.bypassFor ?? capBypassFor;
  const audit = input.appendGateAudit ?? liveAppendGateAudit;
  try {
    const partition = resolvePartition(input.bindable);
    const binding = bindFrom(input.bindable);
    const verdict = await check(input.bindable, input.mode);
    try {
      await audit({
        ts: new Date().toISOString(),
        org: partition.org,
        platform: partition.platform,
        workspace: partition.workspace,
        surface: partition.surface,
        action: "spend.gate",
        detail: {
          key: partition.surfaceKey,
          mode: input.mode,
          door: input.door,
          team: input.teamId ?? null,
          over: verdict.over,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        },
      });
    } catch {
    }
    if (!verdict.over) return "proceed";
    const granted = await bypass({
      org: binding.org,
      principalId: input.principalId,
      surfaceKey: partition.surfaceKey,
      reason: verdict.reason,
    });
    if (granted) {
      if (granted.warn) {
        try {
          await input.post(spendBypassWarnCopy(verdict.reason));
        } catch {
        }
      }
      return "proceed";
    }
    try {
      await input.post(spendRefusalCopy(verdict.reason, partition.surfaceKey, `${binding.platform}/${binding.workspace}`));
    } catch {
    }
    return "declined";
  } catch (e) {
    console.warn(`[open-everywhere:spend-gate] check failed OPEN: ${e instanceof Error ? e.message : String(e)}`);
    return "proceed";
  }
}

function liveCheckOverBudget(bindable: BindableContext, mode: SessionMode): Promise<Verdict> {
  return scopeOverBudget(resolvePartition(bindable), mode, new Date().toISOString(), bindFrom(bindable).trust);
}

function liveAppendGateAudit(row: SpendGateAuditRow): Promise<void> {
  return getOperationalStore().appendAudit(row);
}
