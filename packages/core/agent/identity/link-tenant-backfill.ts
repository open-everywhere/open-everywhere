import { getOperationalStore } from "../operational/provider.js";
import { isTenantScopedPlatform } from "./principal-key.js";
import { tryLinkTenantOf } from "./link-tenant.js";
import type { OperationalStore } from "../operational/store.js";

export interface LinkTenantBackfillOutcome {
  readonly filled: readonly { readonly platform: string; readonly tenant: string; readonly rows: number }[];
  readonly unresolved: readonly string[];
}

export async function backfillLinkTenants(opts?: { readonly store?: OperationalStore; readonly now?: Date }): Promise<LinkTenantBackfillOutcome> {
  const store = opts?.store ?? getOperationalStore();
  const at = (opts?.now ?? new Date()).toISOString();
  const filled: { platform: string; tenant: string; rows: number }[] = [];
  const unresolved: string[] = [];
  for (const platform of await store.unbackfilledLinkedIdPlatforms()) {
    if (!isTenantScopedPlatform(platform)) continue;
    const tenant = tryLinkTenantOf(platform, undefined);
    if (tenant === undefined || tenant.length === 0) {
      unresolved.push(platform);
      continue;
    }
    filled.push({ platform, tenant, rows: await store.backfillLinkedIdTenant(platform, tenant, at) });
  }
  return { filled, unresolved };
}

export function linkTenantBackfillWarning(platform: string): string {
  return (
    `[open-everywhere:identity] ⚠ identity links on "${platform}" carry no workspace and this deployment cannot name one. ` +
    `On ${platform} a person id is issued PER WORKSPACE, so those rows cannot be matched safely and their links are ` +
    "DORMANT — the people on them fall back to per-surface identity (nothing is mis-attributed; standing is lost, never " +
    `gained). Fix: declare that workspace's ${platform} channel in agent/memory/domains.ts and reboot — this sweep runs ` +
    "on every boot and stamps the rows as soon as the workspace is nameable. If more than one workspace is declared " +
    "(OE_ALLOW_MULTI_TENANT_PRINCIPALS=1), only the original delivery knew which one these rows belong to; they have to " +
    "be re-linked. (OPE-309 phase 2, identity/link-tenant-backfill.ts)"
  );
}

export async function bootBackfillLinkTenants(opts?: { readonly store?: OperationalStore; readonly log?: (line: string) => void }): Promise<void> {
  const log = opts?.log ?? ((line: string) => console.log(line));
  try {
    const outcome = await backfillLinkTenants(opts?.store ? { store: opts.store } : undefined);
    for (const f of outcome.filled) {
      if (f.rows > 0) log(`[open-everywhere:identity] backfilled ${f.rows} "${f.platform}" identity link row(s) with tenant "${f.tenant}" (OPE-309 phase 2).`);
    }
    for (const platform of outcome.unresolved) log(linkTenantBackfillWarning(platform));
  } catch (err) {
    log(`[open-everywhere:identity] identity link tenant backfill could not run: ${err instanceof Error ? err.message : String(err)} — links written before the tenant column stay dormant until it does.`);
  }
}
