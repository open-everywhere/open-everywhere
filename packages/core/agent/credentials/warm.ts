import { auditErrorDetail } from "../audit/tool-action.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import type { BrokeredSecret } from "../access/credentials.js";
import type { CredentialRefreshPosture } from "../access/connector-credentials.js";

export const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface WarmCredentialSpec<Ctx> {
  readonly name: string;
  readonly platform: string;
  readonly auditAction: string;
  readonly refresh: CredentialRefreshPosture;
  readonly refreshMarginMs?: number;
  readonly fallbackTtlSeconds?: number;
  readonly key?: (ctx: Ctx) => string;
  readonly mint: (ctx: Ctx) => Promise<BrokeredSecret>;
}

export interface WarmCredential<Ctx> {
  get(ctx: Ctx): Promise<string>;
  peek(ctx: Ctx): BrokeredSecret | undefined;
  reset(): void;
}

function stamp(spec: WarmCredentialSpec<unknown>, minted: BrokeredSecret, nowMs: number): BrokeredSecret {
  if (minted.expiresAtMs !== undefined && Number.isFinite(minted.expiresAtMs)) return minted;
  if (spec.refresh === "re-mint") return { value: minted.value, expiresAtMs: nowMs + spec.fallbackTtlSeconds! * 1000 };
  return { value: minted.value };
}

export function warmCredential<Ctx = void>(spec: WarmCredentialSpec<Ctx>): WarmCredential<Ctx> {
  if (spec.refresh === "refresh-token") {
    throw new Error(
      `warmCredential("${spec.name}"): the "refresh-token" posture is not served by this seam — an OAuth refresh ` +
        `against a stored refresh token needs durable, cross-process rotation safety (credentials/kv-vault.ts), ` +
        `not a process-local memo. Refusing to apply a re-mint rhythm to a credential that needs a different one.`,
    );
  }
  if (spec.refresh === "re-mint" && !(typeof spec.fallbackTtlSeconds === "number" && spec.fallbackTtlSeconds > 0)) {
    throw new Error(
      `warmCredential("${spec.name}"): a "re-mint" credential must declare fallbackTtlSeconds (the vendor's ` +
        `documented lifetime) — without it, a mint response that omits its expiry would be held forever, which is ` +
        `the silent-staleness failure this seam exists to prevent.`,
    );
  }
  const margin = spec.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  if (!(Number.isFinite(margin) && margin >= 0)) {
    throw new Error(`warmCredential("${spec.name}"): refreshMarginMs must be a non-negative number of milliseconds.`);
  }

  const held = new Map<string, BrokeredSecret>();
  const inflight = new Map<string, Promise<string>>();
  const keyOf = (ctx: Ctx): string => (spec.key ? spec.key(ctx) : "");

  async function auditMintFailure(key: string, message: string): Promise<void> {
    console.error(`[open-everywhere:credentials] ${spec.name} mint failed${key ? ` (${key})` : ""}: ${message}`);
    await appendAudit({
      org: deploymentOrg(),
      platform: spec.platform,
      workspace: "unknown",
      action: spec.auditAction,
      detail: { credential: spec.name, ...(key ? { key } : {}), error: auditErrorDetail(message).error },
    }).catch(() => undefined);
  }

  return {
    async get(ctx: Ctx): Promise<string> {
      const key = keyOf(ctx);
      const now = Date.now();
      const cached = held.get(key);
      if (cached && (cached.expiresAtMs === undefined || cached.expiresAtMs - margin > now)) return cached.value;
      const flying = inflight.get(key);
      if (flying) return flying;
      const mint = (async (): Promise<string> => {
        try {
          const minted = await spec.mint(ctx);
          if (!minted || typeof minted.value !== "string" || minted.value.length === 0) {
            throw new Error(`${spec.name} mint returned no credential value.`);
          }
          const stamped = stamp(spec as WarmCredentialSpec<unknown>, minted, Date.now());
          held.set(key, stamped);
          return stamped.value;
        } catch (err) {
          await auditMintFailure(key, err instanceof Error ? err.message : String(err));
          throw err;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, mint);
      return mint;
    },
    peek(ctx: Ctx): BrokeredSecret | undefined {
      return held.get(keyOf(ctx));
    },
    reset(): void {
      held.clear();
      inflight.clear();
    },
  };
}
