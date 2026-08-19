import { fetchAudit, type AuditWireEntry } from "./e2e/audit-read.js";
import type { OperationalStore } from "../agent/operational/store.js";

export const STORE_IDENTITY_MAX_DRIFT_MS = 5 * 60 * 1000;

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

export interface StoreIdentitySample {
  readonly localNewestTs: string | null;
  readonly remoteNewestTs: string | null;
}

export type StoreIdentityVerdict = { readonly ok: true; readonly diffMs: number } | { readonly ok: false; readonly reason: string };

export function evaluateStoreIdentity(sample: StoreIdentitySample, maxDriftMs: number = STORE_IDENTITY_MAX_DRIFT_MS): StoreIdentityVerdict {
  const { localNewestTs, remoteNewestTs } = sample;
  if (localNewestTs === null || remoteNewestTs === null) {
    return {
      ok: false,
      reason:
        `cannot establish store identity — this process's store's newest audit row is ${localNewestTs ?? "ABSENT"}, ` +
        `the deployment's newest reported row is ${remoteNewestTs ?? "ABSENT"}. An empty side proves nothing.`,
    };
  }
  const localMs = Date.parse(localNewestTs);
  const remoteMs = Date.parse(remoteNewestTs);
  if (Number.isNaN(localMs) || Number.isNaN(remoteMs)) {
    return { ok: false, reason: `unparseable audit timestamp — local="${localNewestTs}" remote="${remoteNewestTs}"` };
  }
  const diffMs = Math.abs(localMs - remoteMs);
  if (diffMs > maxDriftMs) {
    return {
      ok: false,
      reason:
        `this process's store's newest audit row (${localNewestTs}) diverges from the deployment's newest reported ` +
        `row (${remoteNewestTs}) by ${Math.round(diffMs / 1000)}s — more than the ${Math.round(maxDriftMs / 1000)}s window. ` +
        "This DATABASE_URL is very likely NOT the deployment's own store.",
    };
  }
  return { ok: true, diffMs };
}

export interface StoreIdentityGuardConfig {
  readonly targetUrl: string;
  readonly readToken: string;
  readonly org: string;
  readonly maxDriftMs?: number;
}

export type FetchAuditFn = (targetUrl: string, readToken: string, opts: { readonly sinceIso: string; readonly limit?: number }) => Promise<readonly AuditWireEntry[]>;

export async function assertStoreIdentity(
  store: OperationalStore,
  config: StoreIdentityGuardConfig,
  fetchAuditFn: FetchAuditFn = fetchAudit,
): Promise<StoreIdentityVerdict & { readonly ok: true }> {
  let remoteRows: readonly AuditWireEntry[];
  try {
    remoteRows = await fetchAuditFn(config.targetUrl, config.readToken, { sinceIso: EPOCH_ISO, limit: 1 });
  } catch (err) {
    throw new Error(
      `STORE-IDENTITY GUARD: could not reach the deployment's control plane at ${config.targetUrl} to verify this store's ` +
        `identity — refusing to write blind. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const remoteNewestTs = remoteRows[0]?.ts ?? null;

  const localRows = await store.readAudit({ org: config.org, limit: 1 });
  const localNewestTs = localRows[0]?.ts ?? null;

  const verdict = evaluateStoreIdentity({ localNewestTs, remoteNewestTs }, config.maxDriftMs ?? STORE_IDENTITY_MAX_DRIFT_MS);
  if (!verdict.ok) {
    throw new Error(
      `STORE-IDENTITY GUARD: refusing to write — ${verdict.reason}\n` +
        `  This process's DATABASE_URL does not appear to be the store behind ${config.targetUrl} (org "${config.org}").\n` +
        "  See OPE-835: a healthy-but-wrong Postgres database reports green here with no credential error — only this identity check catches it.",
    );
  }
  return verdict;
}

export interface StoreIdentityGuardEnv {
  readonly E2E_TARGET_URL?: string;
  readonly OE_DEPLOY_ALIAS?: string;
  readonly E2E_CONTROL_READ_TOKEN?: string;
}

export function resolveStoreIdentityGuardConfig(org: string, env: StoreIdentityGuardEnv, maxDriftMs?: number): StoreIdentityGuardConfig {
  const alias = env.OE_DEPLOY_ALIAS?.trim();
  const targetUrl = env.E2E_TARGET_URL?.trim() || (alias ? `https://${alias}` : "");
  if (!targetUrl) {
    throw new Error(
      "STORE-IDENTITY GUARD: no deployment to verify this store against — set E2E_TARGET_URL (or OE_DEPLOY_ALIAS) so " +
        "this rung can compare the store it opened to the deployment's own audit trail BEFORE writing. " +
        "Refusing to proceed blind (see OPE-835) rather than skip the check.",
    );
  }
  const readToken = env.E2E_CONTROL_READ_TOKEN?.trim();
  if (!readToken) {
    throw new Error(
      "STORE-IDENTITY GUARD: E2E_CONTROL_READ_TOKEN is not set — this rung cannot verify the store it opened is the " +
        "deployment's own before writing. Refusing to proceed blind (see OPE-835) rather than skip the check.",
    );
  }
  return { targetUrl, readToken, org, ...(maxDriftMs !== undefined ? { maxDriftMs } : {}) };
}

export async function guardStoreIdentityBeforeWrite(
  store: OperationalStore,
  org: string,
  env: StoreIdentityGuardEnv = process.env,
): Promise<void> {
  const config = resolveStoreIdentityGuardConfig(org, env);
  await assertStoreIdentity(store, config);
}
