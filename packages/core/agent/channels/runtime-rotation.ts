import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";

export const EVE_RUNTIME_VERSION = "0.52.2";

export const RUNTIME_DEPLOYMENT_ID: string = (process.env.VERCEL_DEPLOYMENT_ID ?? "").trim() || "local";

if (RUNTIME_DEPLOYMENT_ID === "local" && (process.env.VERCEL ?? "").trim().length > 0) {
  console.warn(
    "[open-everywhere:runtime-rotation] VERCEL is set but VERCEL_DEPLOYMENT_ID is empty — every standing seat's rotation claim keys on `local`, so no seat will rotate on a deploy",
  );
}

const RUNTIME_ROTATION_CLAIM_PREFIX = "oe-runtime-rotation";

export const RUNTIME_ROTATION_GENERATION_PREFIX = `${RUNTIME_ROTATION_CLAIM_PREFIX}:${EVE_RUNTIME_VERSION}:${RUNTIME_DEPLOYMENT_ID}:`;

export const RUNTIME_ROTATION_CLAIM_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function runtimeRotationClaimKey(registryKey: string): string {
  return `${RUNTIME_ROTATION_GENERATION_PREFIX}${registryKey}`;
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
    won = await store.claimNotice(scope.org, key, scope.atIso, {
      sweepPrefix: `${RUNTIME_ROTATION_CLAIM_PREFIX}:`,
      keepPrefix: RUNTIME_ROTATION_GENERATION_PREFIX,
      olderThanMs: RUNTIME_ROTATION_CLAIM_RETENTION_MS,
    });
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
      deploymentId: RUNTIME_DEPLOYMENT_ID,
      note:
        "the eve build or the deployment changed since this seat's session was minted, so the seat was still running the minting deployment's code (and OE cannot prove the session is resumable across an eve bump) — " +
        "the generation was retired and this wake goes to a fresh one. The retired generation's in-context state " +
        "(working memory) is gone; the recorded conversation tail and durable memory are not.",
    },
  }).catch(() => undefined);

  return true;
}
