import { appendAudit } from "../audit/audit.js";
import { domainFingerprintForSeat } from "./domain-fingerprint.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { RUNTIME_CODE_FINGERPRINT_SOURCE } from "./runtime-code-fingerprint.generated.js";

export const EVE_RUNTIME_VERSION = "0.71.0";

export const RUNTIME_DEPLOYMENT_ID: string = (process.env.VERCEL_DEPLOYMENT_ID ?? "").trim() || "local";

if (RUNTIME_DEPLOYMENT_ID === "local" && (process.env.VERCEL ?? "").trim().length > 0) {
  console.warn(
    "[open-everywhere:runtime-rotation] VERCEL is set but VERCEL_DEPLOYMENT_ID is empty — every rotation audit row will name the deployment `local`",
  );
}

export const RUNTIME_CODE_FINGERPRINT = `${EVE_RUNTIME_VERSION}:${RUNTIME_CODE_FINGERPRINT_SOURCE}`;

export const RUNTIME_ROTATION_AUDIT_ACTION = "session.runtime_rotation";

export const RUNTIME_ROTATION_PRINCIPAL = "oe:deploy";

export interface RuntimeRotationDeps {
  readonly store?: Pick<OperationalStore, "stampChannelSessionRuntime">;
  readonly codeFingerprint?: string;
  readonly domainFingerprint?: string;
}

export interface RuntimeRotationScope {
  readonly org: string;
  readonly registryKey: string;
  readonly surfaceKey: string;
  readonly domainName?: string;
  readonly atIso: string;
}

export async function claimRuntimeRotation(scope: RuntimeRotationScope, deps: RuntimeRotationDeps = {}): Promise<boolean> {
  const codeFingerprint = deps.codeFingerprint ?? RUNTIME_CODE_FINGERPRINT;
  const domainFingerprint = deps.domainFingerprint ?? domainFingerprintForSeat(scope.domainName, scope.surfaceKey);
  if (domainFingerprint === undefined) return false;

  const store = deps.store ?? getOperationalStore();
  let stamp;
  try {
    stamp = await store.stampChannelSessionRuntime(scope.org, scope.registryKey, codeFingerprint, domainFingerprint);
  } catch (err) {
    console.warn(`[open-everywhere:runtime-rotation] comparison failed for ${scope.registryKey}: ${String(err)} — resuming the current generation`);
    return false;
  }
  if (stamp.outcome !== "rotate") return false;

  const codeChanged = stamp.previousCodeFingerprint !== codeFingerprint;
  const domainChanged = stamp.previousDomainFingerprint !== domainFingerprint;
  const changed = codeChanged && domainChanged ? "both" : codeChanged ? "code" : "domain";

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
      changed,
      codeFingerprint,
      domainFingerprint,
      previousCodeFingerprint: stamp.previousCodeFingerprint,
      previousDomainFingerprint: stamp.previousDomainFingerprint,
      eveVersion: EVE_RUNTIME_VERSION,
      deploymentId: RUNTIME_DEPLOYMENT_ID,
      note:
        "the code under this seat, or its domain's declaration, differs from what the seat was last served with, so the seat was still running the code it was minted under (and OE cannot prove the session is resumable across an eve bump) — " +
        "the generation was retired and this wake goes to a fresh one. The retired generation's in-context state " +
        "(working memory) is gone; the recorded conversation tail and durable memory are not.",
    },
  }).catch(() => undefined);

  return true;
}

export async function stampMintedRuntime(scope: RuntimeRotationScope, deps: RuntimeRotationDeps = {}): Promise<void> {
  const codeFingerprint = deps.codeFingerprint ?? RUNTIME_CODE_FINGERPRINT;
  const domainFingerprint = deps.domainFingerprint ?? domainFingerprintForSeat(scope.domainName, scope.surfaceKey);
  if (domainFingerprint === undefined) return;
  const store = deps.store ?? getOperationalStore();
  try {
    await store.stampChannelSessionRuntime(scope.org, scope.registryKey, codeFingerprint, domainFingerprint);
  } catch (err) {
    console.warn(`[open-everywhere:runtime-rotation] mint stamp failed for ${scope.registryKey}: ${String(err)} — the seat adopts on its next wake`);
  }
}
