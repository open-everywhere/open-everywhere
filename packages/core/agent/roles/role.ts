import {
  criteriaDomain,
  domainForChannel,
  type Domain,
  type ModelRoutes,
  type SandboxPreset,
} from "../memory/domain.js";
import { domainKeyOf, type Partition } from "../memory/partition.js";
import type { SurfaceBinding } from "../identity/binding.js";

export interface Role {
  readonly name: string;
  readonly instructions?: string;
  readonly persona?: string;
  readonly statusVerbs?: readonly string[];
  readonly statusVerbsMode?: "extend" | "replace";
  readonly bundle?: string;
  readonly models?: ModelRoutes;
  readonly memory?: string | readonly string[];
  readonly sandbox?: SandboxPreset;
}

export function defineRole(role: Role): Role {
  return role;
}

export function roleByName(name: string | undefined, roles: readonly Role[]): Role | undefined {
  if (!name) return undefined;
  return roles.find((r) => r.name === name);
}

export function assertRolesValid(roles: readonly Role[]): void {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const r of roles) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (name.length === 0) bad.push(`  a role has no name — every role needs a stable name`);
    else if (seen.has(name)) bad.push(`  role "${name}" is defined twice — names must be unique`);
    else seen.add(name);
    const hasFacet =
      r.instructions !== undefined ||
      r.persona !== undefined ||
      r.statusVerbs !== undefined ||
      r.bundle !== undefined ||
      r.models !== undefined ||
      r.memory !== undefined ||
      r.sandbox !== undefined;
    if (!hasFacet) bad.push(`  role "${name || "(unnamed)"}" presets nothing — give it instructions/persona or at least one knob`);
  }
  if (bad.length > 0) {
    throw new Error("open-everywhere: invalid role(s):\n" + bad.join("\n") + "\n(roles/role.ts / docs/capabilities/roles.md)");
  }
}

export function applyRoleDefaults(domains: readonly Domain[], roles: readonly Role[]): Domain[] {
  const bad: string[] = [];
  const out = domains.map((d) => {
    if (!d.role) return d;
    const role = roleByName(d.role, roles);
    if (!role) {
      bad.push(`  domain "${d.name}" references unknown role "${d.role}" — define it with defineRole({ name: "${d.role}", … }) or fix the name`);
      return d;
    }
    return {
      ...d,
      bundle: d.bundle ?? role.bundle,
      memory: d.memory ?? role.memory,
      sandbox: d.sandbox ?? role.sandbox,
    };
  });
  if (bad.length > 0) {
    throw new Error("open-everywhere: invalid role reference(s):\n" + bad.join("\n") + "\n(roles/role.ts / docs/capabilities/roles.md)");
  }
  return out;
}

export function roleScopeDomain(binding: SurfaceBinding, partition: Partition, domains: readonly Domain[]): Domain | undefined {
  if (binding.mode === "mpim") return undefined;
  if (binding.mode === "dm") return criteriaDomain(binding.trust === "internal" ? "dm" : "public", domains);
  if (binding.trust === "external") return criteriaDomain("public", domains);
  return domainForChannel(domainKeyOf(partition), domains) ?? criteriaDomain("org", domains);
}

export function effectiveRoleFor(
  binding: SurfaceBinding,
  partition: Partition,
  domains: readonly Domain[],
  roles: readonly Role[],
): Role | undefined {
  const scope = roleScopeDomain(binding, partition, domains);
  if (!scope) return undefined;
  const own = roleByName(scope.role, roles);
  if (own) return own;
  if (scope.match !== undefined) return undefined;
  return roleByName(criteriaDomain("org", domains)?.role, roles);
}

export function renderRoleInstructions(role: Role): string {
  const parts: string[] = [];
  if (role.instructions && role.instructions.trim().length > 0) parts.push(role.instructions.trim());
  if (role.persona && role.persona.trim().length > 0) parts.push(`Voice: ${role.persona.trim()}`);
  if (parts.length === 0) return "";
  return `## Your role: ${role.name}\n` + parts.join("\n\n");
}

