import { appendAudit } from "../audit/audit.js";
import type { AuditInput } from "../operational/store.js";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { parseWindowToken } from "./window-key.js";
import { unifiedDomainSessionKey } from "./unified-supervisor.js";

export const RUN_KEY_FETCH_MARKER = "Failed to fetch run key";

export const DEPLOYMENT_GONE_MARKER = "Deployment not found";

export const HTTP_404_MARKER = "HTTP 404";

export const PRUNED_DEPLOYMENT_AUDIT_ACTION = "session.pruned_deployment_strand";

function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return parts.join(" | ");
}

export function isPrunedDeploymentWakeError(err: unknown): boolean {
  const text = errorText(err);
  if (!text.includes(RUN_KEY_FETCH_MARKER)) return false;
  return text.includes(DEPLOYMENT_GONE_MARKER) || text.includes(HTTP_404_MARKER);
}

export function prunedDeploymentIds(err: unknown): { runId?: string; deploymentId?: string } {
  const m = /Failed to fetch run key for (\S+) \(deployment ([^)]+)\)/u.exec(errorText(err));
  return m ? { runId: m[1], deploymentId: m[2] } : {};
}

export type StrandHealOutcome =
  | "not-classified"
  | "marked"
  | "no-row"
  | "not-a-window"
  | "failed";

export interface StrandHealInput {
  readonly token: string;
  readonly surfaceKey: string;
  readonly platform: string;
  readonly atIso: string;
  readonly err: unknown;
  readonly org?: string;
  readonly store?: Pick<OperationalStore, "markChannelSessionRotation">;
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly registryKey?: string;
  readonly workspace?: string;
}

export async function healPrunedDeploymentStrand(input: StrandHealInput): Promise<StrandHealOutcome> {
  if (!isPrunedDeploymentWakeError(input.err)) return "not-classified";
  try {
    const org = input.org ?? deploymentOrg();
    const key = parseWindowToken(input.token);
    const ids = prunedDeploymentIds(input.err);
    const registryKey = input.registryKey ?? (key ? unifiedDomainSessionKey(key.windowId) : undefined);
    const marked = registryKey
      ? await (input.store ?? getOperationalStore()).markChannelSessionRotation(org, registryKey, input.atIso)
      : false;
    const outcome: StrandHealOutcome = registryKey ? (marked ? "marked" : "no-row") : "not-a-window";
    await (input.audit ?? appendAudit)({
      ts: input.atIso,
      org,
      platform: input.platform,
      workspace: input.workspace ?? key?.domain ?? "unknown",
      surface: input.surfaceKey,
      action: PRUNED_DEPLOYMENT_AUDIT_ACTION,
      detail: {
        token: input.token,
        ...(registryKey ? { registryKey } : {}),
        ...ids,
        outcome,
        remedy: outcome === "marked" ? "rotate-at-next-wake" : "none",
      },
    }).catch(() => undefined);
    return outcome;
  } catch {
    return "failed";
  }
}

const UNDELIVERED_AFTER_HEAL = Symbol("oeUndeliveredAfterHeal");

export function markUndeliveredAfterHeal(err: unknown): void {
  if (err && typeof err === "object") {
    (err as Record<PropertyKey, unknown>)[UNDELIVERED_AFTER_HEAL] = true;
  }
}

export function isUndeliveredAfterHeal(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as Record<PropertyKey, unknown>)[UNDELIVERED_AFTER_HEAL] === true);
}
