export type PrincipalSurfaceIds = Readonly<Record<string, string>>;

export interface Principal {
  readonly name: string;
  readonly handle?: string;
  readonly ids: PrincipalSurfaceIds;
  readonly email?: string;
}

export function definePrincipal(p: Principal): Principal {
  return p;
}

export function resolvePrincipal(platform: string, id: string, principals: readonly Principal[]): Principal | undefined {
  if (!platform || !id) return undefined;
  return principals.find((p) => p.ids[platform] === id);
}

export function principalLabel(p: Principal): string {
  return p.handle ? `${p.name} (@${p.handle})` : p.name;
}

export function principalSurfaces(p: Principal): string[] {
  return Object.entries(p.ids)
    .filter(([, v]) => typeof v === "string" && v.length > 0)
    .map(([k]) => k)
    .sort();
}

export function assertPrincipalsValid(principals: readonly Principal[]): void {
  const bad: string[] = [];
  const claimed = new Map<string, number>();
  const emails = new Map<string, number>();
  const at = (i: number): string => `"${principals[i]!.name}" (entry #${i})`;
  for (const [index, p] of principals.entries()) {
    if (!p.name || p.name.trim().length === 0) {
      bad.push(`  a principal has an empty name (ids: ${JSON.stringify(p.ids)})`);
    }
    const entries = Object.entries(p.ids ?? {});
    if (entries.length === 0) {
      bad.push(`  "${p.name}" has no surface ids — an unjoinable principal (add at least one platform id)`);
    }
    for (const [platform, id] of entries) {
      if (typeof id !== "string" || id.length === 0) {
        bad.push(`  "${p.name}" has an empty id for platform "${platform}"`);
        continue;
      }
      const key = `${platform}\u0000${id}`;
      const prev = claimed.get(key);
      if (prev !== undefined) {
        bad.push(`  (${platform}, ${id}) is claimed by BOTH ${at(prev)} and ${at(index)} — an account is exactly one person (fail-closed on merge)`);
      } else {
        claimed.set(key, index);
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
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid principals map (cross-surface identity):\n" +
        bad.join("\n") +
        "\n(identity/principals.ts assertPrincipalsValid).",
    );
  }
}
