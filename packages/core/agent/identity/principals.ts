import { UNNAMED_TENANT, isTenantScopedPlatform, tryPrincipalKey } from "./principal-key.js";

export interface PrincipalAccount {
  readonly tenant?: string;
  readonly id: string;
}

export type PrincipalSurfaceEntry = string | PrincipalAccount | readonly (string | PrincipalAccount)[];

export type PrincipalSurfaceIds = Readonly<Record<string, PrincipalSurfaceEntry>>;

export interface PrincipalAccountRef {
  readonly platform: string;
  readonly tenant?: string;
  readonly id: string;
}

export interface Principal {
  readonly name: string;
  readonly handle?: string;
  readonly ids: PrincipalSurfaceIds;
  readonly email?: string;
}

export function definePrincipal(p: Principal): Principal {
  return p;
}

function entryAccounts(platform: string, entry: PrincipalSurfaceEntry | undefined): PrincipalAccountRef[] {
  const one = (v: string | PrincipalAccount): PrincipalAccountRef | undefined => {
    if (typeof v === "string") return v.length > 0 ? { platform, id: v } : undefined;
    if (!v || typeof v !== "object" || typeof v.id !== "string" || v.id.length === 0) return undefined;
    const tenant = typeof v.tenant === "string" ? v.tenant.trim() : "";
    return tenant.length > 0 ? { platform, tenant, id: v.id } : { platform, id: v.id };
  };
  const list = Array.isArray(entry) ? (entry as readonly (string | PrincipalAccount)[]) : entry === undefined ? [] : [entry as string | PrincipalAccount];
  const out: PrincipalAccountRef[] = [];
  for (const v of list) {
    const a = one(v);
    if (a) out.push(a);
  }
  return out;
}

function compareAccounts(a: PrincipalAccountRef, b: PrincipalAccountRef): number {
  if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
  const at = a.tenant ?? "";
  const bt = b.tenant ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

export function accountRefKey(a: PrincipalAccountRef): string {
  return JSON.stringify([a.platform, a.tenant ?? "", a.id]);
}

export function surfaceAccounts(ids: PrincipalSurfaceIds | undefined): readonly PrincipalAccountRef[] {
  const seen = new Set<string>();
  const out: PrincipalAccountRef[] = [];
  for (const [platform, entry] of Object.entries(ids ?? {})) {
    if (!platform) continue;
    for (const a of entryAccounts(platform, entry)) {
      const k = accountRefKey(a);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
  }
  return out.sort(compareAccounts);
}

export function principalAccounts(p: Principal): readonly PrincipalAccountRef[] {
  return surfaceAccounts(p.ids);
}

export function surfaceIdsFromAccounts(accounts: Iterable<PrincipalAccountRef>): PrincipalSurfaceIds {
  const byPlatform = new Map<string, PrincipalAccountRef[]>();
  const seen = new Set<string>();
  for (const a of accounts) {
    if (!a.platform || !a.id) continue;
    const k = accountRefKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    const list = byPlatform.get(a.platform) ?? [];
    list.push(a);
    byPlatform.set(a.platform, list);
  }
  const out: Record<string, PrincipalSurfaceEntry> = {};
  for (const platform of [...byPlatform.keys()].sort()) {
    const list = byPlatform.get(platform)!.sort(compareAccounts);
    if (list.length === 1 && list[0]!.tenant === undefined) {
      out[platform] = list[0]!.id;
      continue;
    }
    out[platform] = list.map((a) => (a.tenant === undefined ? { id: a.id } : { tenant: a.tenant, id: a.id }));
  }
  return out;
}

export function resolvePrincipal(platform: string, tenant: string | undefined | null, id: string, principals: readonly Principal[]): Principal | undefined {
  if (!platform || !id) return undefined;
  const scoped = isTenantScopedPlatform(platform);
  const want = typeof tenant === "string" ? tenant.trim() : "";
  let loose: Principal | undefined;
  for (const p of principals) {
    for (const a of principalAccounts(p)) {
      if (a.platform !== platform || a.id !== id) continue;
      if (!scoped) return p;
      if (a.tenant === undefined) {
        loose ??= p;
        continue;
      }
      if (want.length > 0 && a.tenant === want) return p;
    }
  }
  return loose;
}

export function principalLabel(p: Principal): string {
  return p.handle ? `${p.name} (@${p.handle})` : p.name;
}

export function principalSurfaces(p: Principal): string[] {
  return [...new Set(principalAccounts(p).map((a) => a.platform))].sort();
}

export function principalKeys(p: Principal): string[] {
  const keys = new Set<string>();
  for (const a of principalAccounts(p)) {
    const key = tryPrincipalKey(a.platform, a.tenant, a.id);
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

export function assertPrincipalsValid(principals: readonly Principal[]): void {
  const bad: string[] = [];
  const claimed = new Map<string, number>();
  const emails = new Map<string, number>();
  const qualified = new Map<string, number>();
  const unqualified = new Map<string, number>();
  const at = (i: number): string => `"${principals[i]!.name}" (entry #${i})`;
  const named = (a: PrincipalAccountRef): string => tryPrincipalKey(a.platform, a.tenant, a.id) ?? `(${a.platform}, ${a.id})`;
  for (const [index, p] of principals.entries()) {
    if (!p.name || p.name.trim().length === 0) {
      bad.push(`  a principal has an empty name (ids: ${JSON.stringify(p.ids)})`);
    }
    const entries = Object.entries(p.ids ?? {});
    if (entries.length === 0) {
      bad.push(`  "${p.name}" has no surface ids — an unjoinable principal (add at least one platform id)`);
    }
    for (const [platform, entry] of entries) {
      const written = Array.isArray(entry) ? (entry as readonly unknown[]) : entry === undefined ? [] : [entry as unknown];
      if (written.length === 0) {
        bad.push(`  "${p.name}" has an empty entry for platform "${platform}" — write an id, or drop the platform`);
        continue;
      }
      const scoped = isTenantScopedPlatform(platform);
      for (const v of written) {
        const isObj = typeof v === "object" && v !== null;
        const rawId = typeof v === "string" ? v : isObj ? (v as PrincipalAccount).id : undefined;
        if (typeof rawId !== "string" || rawId.length === 0) {
          bad.push(`  "${p.name}" has an empty id for platform "${platform}"`);
          continue;
        }
        const rawTenant = isObj && typeof (v as PrincipalAccount).tenant === "string" ? (v as PrincipalAccount).tenant!.trim() : undefined;
        if (rawTenant !== undefined && !scoped) {
          bad.push(
            `  "${p.name}" names a tenant ("${rawTenant}") for "${platform}", whose person ids are addressed vendor-globally — ` +
              "the principal-key grammar has no workspace rung there, so the tenant would be silently discarded and two entries " +
              "differing only by it would collide on one key. Remove it, or write the platform as a bare id.",
          );
          continue;
        }
        if (rawTenant !== undefined && (rawTenant.length === 0 || /[\s/]/u.test(rawTenant) || rawTenant === UNNAMED_TENANT)) {
          bad.push(
            `  "${p.name}" names an unusable ${platform} tenant ("${rawTenant}") — a tenant rung carries no slash and no whitespace, ` +
              `and "${UNNAMED_TENANT}" is the literal for "nobody said", not a workspace id. Omit the tenant to mean "this ` +
              'deployment\'s only workspace", or write the real workspace id.',
          );
          continue;
        }
        const account: PrincipalAccountRef = rawTenant !== undefined && scoped ? { platform, tenant: rawTenant, id: rawId } : { platform, id: rawId };
        if (scoped) {
          const ledger = account.tenant === undefined ? unqualified : qualified;
          if (!ledger.has(platform)) ledger.set(platform, index);
        }
        const key = accountRefKey(account);
        const prev = claimed.get(key);
        if (prev !== undefined) {
          bad.push(`  ${named(account)} is claimed by BOTH ${at(prev)} and ${at(index)} — an account is exactly one person (fail-closed on merge)`);
        } else {
          claimed.set(key, index);
        }
      }
    }
    if (p.email && p.email.trim().length > 0) {
      const key = p.email.trim().toLowerCase();
      const prev = emails.get(key);
      if (prev !== undefined) {
        bad.push(`  email "${p.email}" is claimed by BOTH ${at(prev)} and ${at(index)} — would propose a bad auto-join merge`);
      } else {
        emails.set(key, index);
      }
    }
  }
  for (const [platform, qi] of qualified) {
    const ui = unqualified.get(platform);
    if (ui === undefined) continue;
    bad.push(
      `  "${platform}" is written BOTH with a workspace (${at(qi)}) and without one (${at(ui)}) — the half-migrated state. ` +
        `On ${platform} a person id is issued PER WORKSPACE, so a bare id means "whichever workspace this deployment serves"; ` +
        "alongside a workspace-qualified entry it would wildcard across the very workspaces those entries exist to tell apart. " +
        `Qualify EVERY ${platform} entry ({ tenant: "<workspace-id>", id: "<user-id>" }), or none of them.`,
    );
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid principals map (cross-surface identity):\n" +
        bad.join("\n") +
        "\n(identity/principals.ts assertPrincipalsValid).",
    );
  }
}
