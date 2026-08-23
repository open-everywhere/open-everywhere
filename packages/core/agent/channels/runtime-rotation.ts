import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";

export const EVE_RUNTIME_VERSION = "0.44.3";

const RUNTIME_ROTATION_CLAIM_PREFIX = "oe-runtime-rotation";

export function runtimeRotationClaimKey(registryKey: string): string {
  return `${RUNTIME_ROTATION_CLAIM_PREFIX}:${EVE_RUNTIME_VERSION}:${registryKey}`;
}

export const RUNTIME_ROTATION_AUDIT_ACTION = "session.runtime_rotation";

export const RUNTIME_ROTATION_PRINCIPAL = "oe:deploy";

export interface RuntimeRotationDeps {
  readonly store?: Pick<OperationalStore, "claimNotice">;
}

export interface RuntimeRotationScope {
  readonly org: string;
  readonly registryKey: string;
  readonly surfaceKey: string;
  readonly atIso: string;
}

export async function claimRuntimeRotation(scope: RuntimeRotationScope, deps: RuntimeRotationDeps = {}): Promise<boolean> {
  const store = deps.store ?? getOperationalStore();
  const key = runtimeRotationClaimKey(scope.registryKey);
  let won: boolean;
  try {
    won = await store.claimNotice(scope.org, key, scope.atIso);
  } catch (err) {
    console.warn(`[open-everywhere:runtime-rotation] claim failed for ${scope.registryKey}: ${String(err)} — resuming the current generation`);
    return false;
  }
  if (!won) return false;

  const [platform = "", workspace = "", ...rest] = scope.surfaceKey.split("/");
  await appendAudit({
    org: scope.org,
    platform,
    workspace,
    surface: rest.join("/"),
    principalId: RUNTIME_ROTATION_PRINCIPAL,
    action: RUNTIME_ROTATION_AUDIT_ACTION,
    detail: {
      registryKey: scope.registryKey,
      eveVersion: EVE_RUNTIME_VERSION,
      note:
        "the eve build changed since this seat's session was minted, so OE cannot prove the session is resumable — " +
        "the generation was retired and this wake goes to a fresh one. The retired generation's in-context state " +
        "(working memory) is gone; the recorded conversation tail and durable memory are not.",
    },
  }).catch(() => undefined);

  return true;
}
