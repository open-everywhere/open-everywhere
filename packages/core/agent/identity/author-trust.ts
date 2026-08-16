import { parseSurfaceKeyEntry, surfaceKeyEntryMatches, type SurfaceKeyEntry } from "./surface-key-grammar.js";
import { isQualifiedPrincipalKey, parsePrincipalKey, tryPrincipalKey } from "./principal-key.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistrySlot } from "../lib/process-registry.js";
import type { Group } from "./groups.js";

export interface AuthorGroupMember {
  readonly group: string;
}

export interface AuthorMembershipMember {
  readonly membership: string;
}

export type AuthorMember = string | AuthorGroupMember | AuthorMembershipMember;

export interface AuthorTrustEntry {
  readonly tenant: string;
  readonly internal: readonly AuthorMember[];
}

export type AuthorTrust = "internal" | "external";

export function defineAuthorTrust(entry: AuthorTrustEntry): AuthorTrustEntry {
  return entry;
}

interface RegisteredTenant {
  readonly tenantKey: string;
  readonly platform: string;
  readonly tenant: string;
  readonly principals: ReadonlySet<string>;
  readonly memberships: readonly SurfaceKeyEntry[];
}

const tenantsSlot = processRegistrySlot<ReadonlyMap<string, RegisteredTenant>>("author-trust.tenants.v1");
function tenants(): ReadonlyMap<string, RegisteredTenant> {
  return tenantsSlot.get() ?? new Map();
}

export function registerAuthorTrust(entries: Iterable<AuthorTrustEntry>, groups: readonly Group[] = []): void {
  const bad: string[] = [];
  const next = new Map<string, RegisteredTenant>();
  const byName = new Map(groups.map((g) => [g.name, g] as const));

  for (const [index, entry] of [...entries].entries()) {
    const tenantKey = typeof entry?.tenant === "string" ? entry.tenant : "";
    const where = tenantKey.length > 0 ? `author-trust entry "${tenantKey}"` : `author-trust entry #${index}`;
    const parsed = tenantKey.length > 0 ? parseSurfaceKeyEntry(tenantKey) : undefined;
    if (!parsed || parsed.kind !== "tenant") {
      bad.push(
        `  ${where}: \`tenant\` must be exactly "<platform>/<tenant-id>" (e.g. "discord/1300000000000000100", "notion/<workspaceId>") — not a surface key, not a glob, not a bare platform. The register arms ONE tenant at a time on purpose (identity/author-trust.ts).`,
      );
      continue;
    }
    if (!admitProviderRegistration(parsed.platform, "author-trust")) continue;
    if (next.has(tenantKey)) {
      bad.push(`  ${where} is declared more than once — merge the two \`internal\` lists into one entry so a reader sees the whole declaration in one place`);
      continue;
    }
    const members = entry.internal ?? [];
    if (members.length === 0) {
      bad.push(`  ${where} has an empty \`internal\` list — that would ARM the tenant and then refute everybody. List its people, or drop the entry to leave the tenant undeclared.`);
      continue;
    }

    const principals = new Set<string>();
    const memberships: SurfaceKeyEntry[] = [];
    const seen = new Set<string>();
    for (const m of members) {
      if (typeof m === "string") {
        if (seen.has(`key\u0000${m}`)) bad.push(`  ${where} lists member "${m}" more than once — remove the duplicate`);
        seen.add(`key\u0000${m}`);
        if (!isQualifiedPrincipalKey(m)) {
          bad.push(
            `  ${where} member "${m}" is not a qualified principal key ("<platform>/<id>", or "<platform>/<tenant>/<id>" on a tenant-scoped platform such as Slack) — identity/principal-key.ts. An unqualified id has no platform namespace and can NEVER match.`,
          );
          continue;
        }
        if (parsePrincipalKey(m)?.platform !== parsed.platform) {
          bad.push(
            `  ${where} member "${m}" is on a DIFFERENT platform from the tenant it is declared under ("${parsed.platform}") — it can never match here, so it is dead config. Move it to that platform's own entry.`,
          );
          continue;
        }
        principals.add(m);
        continue;
      }
      if (typeof m === "object" && m !== null && "group" in m) {
        const name = (m as AuthorGroupMember).group;
        if (seen.has(`group\u0000${name}`)) bad.push(`  ${where} lists group "${name}" more than once — remove the duplicate`);
        seen.add(`group\u0000${name}`);
        const group = byName.get(name);
        if (!group) {
          bad.push(`  ${where} names person-group "${name}", which is not defined (agent/identity/groups.ts) — a group reference that resolves to nothing grants nothing`);
          continue;
        }
        const keys = (group.members ?? []).filter((k): k is string => typeof k === "string").filter((k) => parsePrincipalKey(k)?.platform === parsed.platform);
        if (keys.length === 0) {
          bad.push(
            `  ${where} names person-group "${name}", which has NO ${parsed.platform} principal-key member. Link-set members do NOT count on this plane — expanding one is an async database read and this resolver runs on the synchronous wake path (see the module header). Add a "${parsed.platform}/…" key to the group, or drop the reference.`,
          );
          continue;
        }
        for (const k of keys) principals.add(k);
        continue;
      }
      if (typeof m === "object" && m !== null && "membership" in m) {
        const key = (m as AuthorMembershipMember).membership;
        if (seen.has(`membership\u0000${key}`)) bad.push(`  ${where} lists membership "${key}" more than once — remove the duplicate`);
        seen.add(`membership\u0000${key}`);
        const p = typeof key === "string" ? parseSurfaceKeyEntry(key) : undefined;
        if (!p || p.kind !== "group") {
          bad.push(
            `  ${where} membership "${key}" is not a group-rung key — the shape is "<platform>/<tenant>/<marker>:<id>", e.g. "${parsed.platform}/${parsed.tenant}/role:0123456789" (a single trailing "*" is allowed: "role:*" admits every author holding any role). See identity/surface-key-grammar.ts.`,
          );
          continue;
        }
        if (p.platform !== parsed.platform || p.tenant !== parsed.tenant) {
          bad.push(
            `  ${where} membership "${key}" names tenant "${p.platform}/${p.tenant}", not the "${tenantKey}" it is declared under — it can never match here. A membership pattern only ever narrows WITHIN its own tenant.`,
          );
          continue;
        }
        memberships.push(p);
        continue;
      }
      bad.push(`  ${where} has a member that is neither a principal key (a string), a { group: "…" } reference, nor a { membership: "…" } pattern`);
    }

    if (principals.size === 0 && memberships.length === 0) continue;
    next.set(tenantKey, { tenantKey, platform: parsed.platform, tenant: parsed.tenant, principals, memberships });
  }

  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid author-trust declaration(s):\n" +
        bad.join("\n") +
        "\n(identity/author-trust.ts registerAuthorTrust / docs/how-it-works/identity.md#author-trust).",
    );
  }
  tenantsSlot.set(next);
}

export function _resetAuthorTrustForTest(): void {
  tenantsSlot.set(new Map());
}

export function armedAuthorTrustTenants(): readonly string[] {
  return [...tenants().keys()].sort();
}

export interface AuthorTrustQuery {
  readonly tenantKey: string;
  readonly authorId?: string;
  readonly memberships?: readonly string[];
}

export function declaredAuthorTrust(q: AuthorTrustQuery): AuthorTrust | undefined {
  const t = tenants().get(q.tenantKey);
  if (!t) return undefined;
  if (q.authorId) {
    const key = tryPrincipalKey(t.platform, t.tenant, q.authorId);
    if (key !== undefined && t.principals.has(key)) return "internal";
  }
  for (const held of q.memberships ?? []) {
    if (t.memberships.some((e) => surfaceKeyEntryMatches(e, held))) return "internal";
  }
  return "external";
}

export function authorRefutedByRegister(q: AuthorTrustQuery): boolean {
  return declaredAuthorTrust(q) === "external";
}
