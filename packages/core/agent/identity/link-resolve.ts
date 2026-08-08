import type { Principal, PrincipalSurfaceIds } from "./principals.js";

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

function pairKey(platform: string, id: string): string {
  return `${platform}\u0000${id}`;
}

function accountKeys(ids: PrincipalSurfaceIds): string[] {
  return Object.entries(ids)
    .filter(([, v]) => typeof v === "string" && v.length > 0)
    .map(([platform, id]) => pairKey(platform, id));
}

export function unionPrincipals(config: readonly Principal[], linkSets: readonly LinkSetPrincipal[]): PrincipalUnion {
  const warnings: UnionWarning[] = [];

  const setByAccount = new Map<string, number>();
  const setDuplicates = new Set<string>();
  for (const [i, s] of linkSets.entries()) {
    for (const k of accountKeys(s.ids)) {
      if (setByAccount.has(k) && setByAccount.get(k) !== i) setDuplicates.add(k);
      else setByAccount.set(k, i);
    }
  }

  const configForSet = new Map<number, number>();
  const conflicted = new Set<string>();
  for (const [ci, p] of config.entries()) {
    const hits = new Set<number>();
    for (const k of accountKeys(p.ids ?? {})) {
      if (setDuplicates.has(k)) conflicted.add(k);
      const si = setByAccount.get(k);
      if (si !== undefined) hits.add(si);
    }
    if (hits.size === 0) continue;
    if (hits.size > 1) {
      for (const k of accountKeys(p.ids ?? {})) if (setByAccount.has(k)) conflicted.add(k);
      continue;
    }
    const si = [...hits][0]!;
    const already = configForSet.get(si);
    if (already !== undefined && already !== ci) {
      for (const k of accountKeys(config[already]!.ids ?? {})) if (setByAccount.get(k) === si) conflicted.add(k);
      for (const k of accountKeys(p.ids ?? {})) if (setByAccount.get(k) === si) conflicted.add(k);
      continue;
    }
    configForSet.set(si, ci);
  }

  for (const k of conflicted) warnings.push(conflictWarning(k));
  for (const k of setDuplicates) if (!conflicted.has(k)) warnings.push(conflictWarning(k));

  const drop = new Set<string>([...conflicted, ...setDuplicates]);
  const mergedSets = new Set<number>();
  const principals: Principal[] = [];

  for (const [ci, p] of config.entries()) {
    const si = [...configForSet.entries()].find(([, c]) => c === ci)?.[0];
    const ids: Record<string, string> = {};
    for (const [platform, id] of Object.entries(p.ids ?? {})) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (drop.has(pairKey(platform, id))) continue;
      ids[platform] = id;
    }
    if (si !== undefined) {
      mergedSets.add(si);
      for (const [platform, id] of Object.entries(linkSets[si]!.ids)) {
        if (typeof id !== "string" || id.length === 0) continue;
        if (drop.has(pairKey(platform, id))) continue;
        if (ids[platform] === undefined) ids[platform] = id;
      }
    }
    principals.push({ ...p, ids });
  }

  for (const [si, s] of linkSets.entries()) {
    if (mergedSets.has(si)) continue;
    const ids: Record<string, string> = {};
    for (const [platform, id] of Object.entries(s.ids)) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (drop.has(pairKey(platform, id))) continue;
      ids[platform] = id;
    }
    if (Object.keys(ids).length === 0) continue;
    principals.push({ name: s.handle, handle: s.handle, ids });
  }

  return { principals, warnings };
}

function conflictWarning(pair: string): UnionWarning {
  const [platform, id] = pair.split("\u0000") as [string, string];
  const key = `${platform} account "${id}"`;
  return {
    key,
    message:
      `identity conflict: ${key} is claimed by two different people across the config principals map and the DB link-sets. ` +
      `NO merge was applied for that account (fail-closed on merge) — it stays a distinct per-surface identity until the ` +
      `disagreement is resolved (edit agent/identity/principals.ts, or revoke the link-set).`,
  };
}
