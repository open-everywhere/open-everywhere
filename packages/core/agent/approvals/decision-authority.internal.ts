import { addressedWakeThisTurn, exactDispatchWakeThisTurn } from "../access/dispatch-origin-signal.js";
import { isRequesterVerdict, type RequesterVerdict } from "../access/requester-identity.js";
import {
  isUnifiedWakeOrigin,
  resolveUnifiedWakeAuthority,
  wakeBindingMatchesOrigin,
  type UnifiedWakeOrigin,
} from "../channels/unified-window.js";
import { resolveDelegatedTaskAuthority } from "../channels/task-wake.js";
import { currentTurnId, currentWindowToken, deploymentOrg, isSubagentChildContext, isUnifiedWindowContext, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { isFrozenSurfaceBinding } from "../identity/frozen-surface-binding.internal.js";
import { getOperationalStore } from "../operational/provider.js";

const KEY_PREFIX = "approval-decision-authority:";
const RETENTION_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1_000;

export interface ApprovalDecisionAuthority {
  readonly binding: SurfaceBinding;
  readonly origin: UnifiedWakeOrigin;
  readonly surfaceKey: string;
  readonly requester: RequesterVerdict;
  readonly nonMemberWake: boolean;
}

function key(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

export async function captureApprovalDecisionAuthority(ctx: BindableContext): Promise<ApprovalDecisionAuthority | undefined> {
  if (isSubagentChildContext(ctx)) {
    const child = await resolveDelegatedTaskAuthority(ctx);
    if (child === undefined) {
      if (currentWindowToken(ctx) === undefined) return undefined;
      throw new Error("approval decision authority: the delegated child has no exact wake-backed dispatch authority");
    }
    return {
      binding: child.binding,
      origin: child.origin,
      surfaceKey: child.surfaceKey,
      requester: child.requester,
      nonMemberWake: child.nonMemberWake,
    };
  }
  if (!isUnifiedWindowContext(ctx) && currentWindowToken(ctx) === undefined) return undefined;
  const turnId = currentTurnId(ctx);
  const wakeId = addressedWakeThisTurn(turnId) ?? exactDispatchWakeThisTurn(turnId);
  if (wakeId === undefined) throw new Error("approval decision authority: the proposing window turn has no exact delivered or addressed wake");
  const store = getOperationalStore();
  const authority = await resolveUnifiedWakeAuthority(store, deploymentOrg(), wakeId);
  if (authority === undefined) {
    throw new Error("approval decision authority: the proposing wake has no complete frozen binding");
  }
  const { binding, origin, surfaceKey, requester, nonMemberWake } = authority;
  const bindingKey = `${binding.platform}/${binding.workspace}/${binding.surface}`;
  if (bindingKey !== surfaceKey || !wakeBindingMatchesOrigin(binding, origin)) {
    throw new Error("approval decision authority: the proposing wake binding does not match its durable origin");
  }
  return {
    binding,
    origin,
    surfaceKey,
    requester,
    nonMemberWake,
  };
}

function isAuthority(value: unknown): value is ApprovalDecisionAuthority {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!Object.keys(row).every((k) => ["binding", "origin", "surfaceKey", "requester", "nonMemberWake"].includes(k))) return false;
  if (!isFrozenSurfaceBinding(row.binding) || !isUnifiedWakeOrigin(row.origin) || !isRequesterVerdict(row.requester)) return false;
  if (typeof row.surfaceKey !== "string" || row.surfaceKey.length === 0 || typeof row.nonMemberWake !== "boolean") return false;
  const binding = row.binding;
  return row.surfaceKey === `${binding.platform}/${binding.workspace}/${binding.surface}` && wakeBindingMatchesOrigin(binding, row.origin);
}

export async function rememberApprovalDecisionAuthority(org: string, id: string, expiresAt: string, authority: ApprovalDecisionAuthority): Promise<void> {
  if (authority.binding.org !== org) throw new Error("approval decision authority: proposal org does not match the frozen binding");
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) throw new Error("approval decision authority: pending expiry is invalid");
  const ttlMs = Math.max(1, expiryMs - Date.now() + RETENTION_AFTER_EXPIRY_MS);
  await getOperationalStore().putTaskResult(org, key(id), JSON.stringify(authority), new Date().toISOString(), ttlMs);
}

export async function readApprovalDecisionAuthority(org: string, id: string): Promise<ApprovalDecisionAuthority | undefined> {
  try {
    const raw = await getOperationalStore().getTaskResult(org, key(id));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isAuthority(parsed)) return undefined;
    if (parsed.binding.org !== org) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
