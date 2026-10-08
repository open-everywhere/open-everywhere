import { resolvePartition, domainKeyOf } from "../memory/partition.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { scopeOverBudget } from "./check.js";
import { capBypassFor } from "./bypass.js";
import { getOperationalStore } from "../operational/provider.js";
import type { SessionMode } from "../access/resolver.js";
import type { CapLayer } from "./spend.js";

export type SpendGateDoor = "mention" | "engagement" | "join" | "window" | "answer";

export type SpendGateDecision = "proceed" | "declined";

interface Verdict {
  readonly over: boolean;
  readonly reason?: string;
  readonly layer?: CapLayer;
  readonly scopeKey?: string;
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

export interface SpendGateBadges {
  readonly refusal: string;
  readonly warning: string;
}

export const UNICODE_SPEND_BADGES: SpendGateBadges = { refusal: "⛔", warning: "⚠️" };

export const SLACK_SPEND_BADGES: SpendGateBadges = { refusal: ":no_entry:", warning: ":warning:" };

export interface IngressSpendGateInput {
  readonly bindable: BindableContext;
  readonly mode?: SessionMode;
  readonly principalId?: string;
  readonly workspaceRef?: string | null;
  readonly door: SpendGateDoor;
  readonly post: (text: string) => Promise<void>;
  readonly badges?: SpendGateBadges;
  readonly checkOverBudget?: (bindable: BindableContext, mode: SessionMode) => Promise<Verdict>;
  readonly bypassFor?: (input: {
    readonly org: string;
    readonly principalId: string | undefined;
    readonly surfaceKey: string;
    readonly reason?: string;
    readonly enterprise?: string;
  }) => Promise<{ readonly warn: boolean } | null>;
  readonly appendGateAudit?: (row: SpendGateAuditRow) => Promise<void>;
}

export interface SpendRefusalCopyInput {
  readonly reason?: string;
  readonly surfaceKey: string;
  readonly workspaceKey: string;
  readonly mode: SessionMode;
  readonly layer?: CapLayer;
  readonly layerKey?: string;
  readonly badge?: string;
}

const PLACE_WORD: Record<SessionMode, string> = { dm: "this DM", mpim: "this group DM", channel: "this channel" };

const CAP_LAYER_COPY: Record<CapLayer, { readonly keyLabel: (mode: SessionMode) => string }> = {
  user: { keyLabel: () => "your own allowance" },
  surface: { keyLabel: (mode) => PLACE_WORD[mode] },
  workspace: { keyLabel: () => "whole workspace" },
};

export function spendRefusalCopy(input: SpendRefusalCopyInput): string {
  const { reason, surfaceKey, workspaceKey, mode, layer, layerKey } = input;
  const badge = input.badge ?? UNICODE_SPEND_BADGES.refusal;
  const inDm = mode === "dm" || mode === "mpim";

  const remedy = inDm
    ? "I can't raise it from in here. Ask an org admin to raise it: permanently in the spend-budgets config, or temporarily by asking me from a channel to propose an override — an admin approves that on a card."
    : "An admin can raise this permanently in the spend-budgets config, or DM me to propose a temporary override — an admin approves it on a card.";

  const breached = layer && layerKey ? `${CAP_LAYER_COPY[layer].keyLabel(mode)} = \`${layerKey}\`` : undefined;
  const here = `${PLACE_WORD[mode]} = \`${surfaceKey}\``;
  const keys = breached
    ? breached === here
      ? breached
      : `${breached}, ${here}`
    : `${here}, whole workspace = \`${workspaceKey}\``;

  return `${badge} I'm holding off${inDm ? "" : " here"} — ${reason}. ${remedy} Scope keys for the override: ${keys}.`;
}

export function spendBypassWarnCopy(reason: string | undefined, badge: string = UNICODE_SPEND_BADGES.warning): string {
  return `${badge} ${reason} — proceeding because you're an admin. Ask me here to raise or clear the cap (an approval card follows), or change it permanently in the spend-budgets config.`;
}

export async function ingressSpendGate(input: IngressSpendGateInput): Promise<SpendGateDecision> {
  const check = input.checkOverBudget ?? liveCheckOverBudget;
  const bypass = input.bypassFor ?? capBypassFor;
  const audit = input.appendGateAudit ?? liveAppendGateAudit;
  const badges = input.badges ?? UNICODE_SPEND_BADGES;
  try {
    const partition = resolvePartition(input.bindable);
    const binding = bindFrom(input.bindable);
    const mode = input.mode ?? binding.mode;
    const verdict = await check(input.bindable, mode);
    try {
      if (verdict.over)
        await audit({
          ts: new Date().toISOString(),
          org: partition.org,
          platform: partition.platform,
          workspace: partition.workspace,
          surface: partition.surface,
          action: "spend.gate",
          detail: {
            key: domainKeyOf(partition),
            mode,
            door: input.door,
            ...(input.workspaceRef !== undefined ? { team: input.workspaceRef } : {}),
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
      surfaceKey: domainKeyOf(partition),
      reason: verdict.reason,
      ...(binding.enterprise === undefined ? {} : { enterprise: binding.enterprise }),
    });
    if (granted) {
      if (granted.warn) {
        try {
          await input.post(spendBypassWarnCopy(verdict.reason, badges.warning));
        } catch {
        }
      }
      return "proceed";
    }
    try {
      await input.post(
        spendRefusalCopy({
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
          surfaceKey: domainKeyOf(partition),
          workspaceKey: `${binding.platform}/${binding.workspace}`,
          mode,
          ...(verdict.layer !== undefined ? { layer: verdict.layer } : {}),
          ...(verdict.scopeKey !== undefined ? { layerKey: verdict.scopeKey } : {}),
          badge: badges.refusal,
        }),
      );
    } catch {
    }
    return "declined";
  } catch (e) {
    console.warn(`[open-everywhere:spend-gate] check failed OPEN (door=${input.door}): ${e instanceof Error ? e.message : String(e)}`);
    return "proceed";
  }
}

function liveCheckOverBudget(bindable: BindableContext, mode: SessionMode): Promise<Verdict> {
  const binding = bindFrom(bindable);
  return scopeOverBudget(resolvePartition(bindable), mode, new Date().toISOString(), binding.trust, binding.principalId);
}

function liveAppendGateAudit(row: SpendGateAuditRow): Promise<void> {
  return getOperationalStore().appendAudit(row);
}
