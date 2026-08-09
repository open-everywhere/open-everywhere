import { surfaceAccounts, surfaceIdsFromAccounts, type Principal, type PrincipalAccountRef, type PrincipalSurfaceIds } from "./principals.js";
import { isTenantScopedPlatform, tryPrincipalKey } from "./principal-key.js";

export interface LinkSetPrincipal {
  readonly linkSetId: string;
  readonly handle: string;
  readonly ids: PrincipalSurfaceIds;
}

export interface UnionWarning {
  readonly key: string;
  readonly message: string;
}

export interface PrincipalUnion {
  readonly principals: readonly Principal[];
  readonly warnings: readonly UnionWarning[];
}

function strictKey(a: PrincipalAccountRef): string {
  return JSON.stringify([a.platform, a.tenant ?? "", a.id]);
}

function looseKey(a: PrincipalAccountRef): string {
  return JSON.stringify([a.platform, a.id]);
}

function sameAccount(a: PrincipalAccountRef, b: PrincipalAccountRef): boolean {
  if (a.platform !== b.platform || a.id !== b.id) return false;
  if (!isTenantScopedPlatform(a.platform)) return true;
  if (a.tenant === undefined || b.tenant === undefined) return true;
  return a.tenant === b.tenant;
}

interface AccountIndex {
  readonly byStrict: Map<string, number>;
  readonly byLoose: Map<string, { readonly account: PrincipalAccountRef; readonly owner: number }[]>;
}

function indexAccounts(sides: readonly { readonly ids: PrincipalSurfaceIds }[]): AccountIndex {
  const byStrict = new Map<string, number>();
  const byLoose = new Map<string, { account: PrincipalAccountRef; owner: number }[]>();
  for (const [i, s] of sides.entries()) {
    for (const a of surfaceAccounts(s.ids)) {
      if (!byStrict.has(strictKey(a))) byStrict.set(strictKey(a), i);
      const list = byLoose.get(looseKey(a)) ?? [];
      list.push({ account: a, owner: i });
      byLoose.set(looseKey(a), list);
    }
  }
  return { byStrict, byLoose };
}

export function unionPrincipals(config: readonly Principal[], linkSets: readonly LinkSetPrincipal[]): PrincipalUnion {
  const warnings: UnionWarning[] = [];
  const conflicted = new Map<string, PrincipalAccountRef>();

  const flag = (a: PrincipalAccountRef): void => {
    if (!conflicted.has(strictKey(a))) conflicted.set(strictKey(a), a);
  };

  const setIndex = indexAccounts(linkSets);
  for (const [k, holders] of setIndex.byLoose) {
    void k;
    for (const x of holders) {
      for (const y of holders) {
        if (x.owner === y.owner || !sameAccount(x.account, y.account)) continue;
        flag(x.account);
        flag(y.account);
      }
    }
  }

  const setsMatching = (a: PrincipalAccountRef): { readonly account: PrincipalAccountRef; readonly owner: number }[] =>
    (setIndex.byLoose.get(looseKey(a)) ?? []).filter((h) => sameAccount(a, h.account));

  const configForSet = new Map<number, number>();
  for (const [ci, p] of config.entries()) {
    const hits = new Set<number>();
    for (const a of surfaceAccounts(p.ids)) {
      const matches = setsMatching(a);
      if (matches.length > 1 && new Set(matches.map((m) => m.account.tenant ?? "")).size > 1) {
        flag(a);
        for (const m of matches) flag(m.account);
        continue;
      }
      for (const m of matches) hits.add(m.owner);
    }
    if (hits.size === 0) continue;
    if (hits.size > 1) {
      for (const a of surfaceAccounts(p.ids)) {
        const matches = setsMatching(a);
        if (matches.length === 0) continue;
        flag(a);
        for (const m of matches) flag(m.account);
      }
      continue;
    }
    const si = [...hits][0]!;
    const already = configForSet.get(si);
    if (already !== undefined && already !== ci) {
      for (const entry of [config[already]!, p]) {
        for (const a of surfaceAccounts(entry.ids)) {
          const matches = setsMatching(a).filter((m) => m.owner === si);
          if (matches.length === 0) continue;
          flag(a);
          for (const m of matches) flag(m.account);
        }
      }
      continue;
    }
    configForSet.set(si, ci);
  }

  for (const a of conflicted.values()) warnings.push(conflictWarning(a));

  const dropped = (a: PrincipalAccountRef): boolean => conflicted.has(strictKey(a));
  const mergedSets = new Set<number>();
  const principals: Principal[] = [];

  for (const [ci, p] of config.entries()) {
    const si = [...configForSet.entries()].find(([, c]) => c === ci)?.[0];
    const accounts: PrincipalAccountRef[] = surfaceAccounts(p.ids).filter((a) => !dropped(a));
    if (si !== undefined) {
      mergedSets.add(si);
      for (const b of surfaceAccounts(linkSets[si]!.ids)) {
        if (dropped(b)) continue;
        const same = accounts.find((a) => sameAccount(a, b));
        if (same === undefined) {
          accounts.push(b);
          continue;
        }
        if (same.tenant === undefined && b.tenant !== undefined) accounts[accounts.indexOf(same)] = b;
      }
    }
    principals.push({ ...p, ids: surfaceIdsFromAccounts(accounts) });
  }

  for (const [si, s] of linkSets.entries()) {
    if (mergedSets.has(si)) continue;
    const accounts = surfaceAccounts(s.ids).filter((a) => !dropped(a));
    if (accounts.length === 0) continue;
    principals.push({ name: s.handle, handle: s.handle, ids: surfaceIdsFromAccounts(accounts) });
  }

  return { principals, warnings };
}

function conflictWarning(a: PrincipalAccountRef): UnionWarning {
  const key = tryPrincipalKey(a.platform, a.tenant, a.id) ?? `the ${a.platform} account "${a.id}" (workspace unnamed)`;
  return {
    key,
    message:
      `identity conflict: ${key} is claimed by two different people across the config principals map and the DB link-sets. ` +
      `NO merge was applied for that account (fail-closed on merge) — it stays a distinct per-surface identity until the ` +
      `disagreement is resolved (edit agent/identity/principals.ts, or revoke the link-set).`,
  };
}
