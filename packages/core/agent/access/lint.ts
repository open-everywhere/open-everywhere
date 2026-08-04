import type { Binding, Bundle } from "./bundle.js";
import type { Domain } from "../memory/domain.js";

function credentialedFields(bundle: Bundle): string[] {
  const fields: string[] = [];
  if (bundle.connections?.length) fields.push(`${bundle.connections.length} connection(s)`);
  if (bundle.providers?.length) fields.push(`${bundle.providers.length} provider credential(s)`);
  if (bundle.repos?.length) fields.push(`${bundle.repos.length} repo(s)`);
  if (bundle.connectors?.length) fields.push(`${bundle.connectors.length} connector(s)`);
  if (bundle.awsRoles?.length) fields.push(`${bundle.awsRoles.length} AWS role(s)`);
  return fields;
}

function tenantClaims(domains: readonly Domain[]): Map<string, readonly string[]> {
  const claims = new Map<string, readonly string[]>();
  for (const d of domains) {
    if (d.containers && d.containers.length > 0) claims.set(d.name, d.containers);
  }
  return claims;
}

export function lintBroadGrants(
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
  domains: readonly Domain[] = [],
): string[] {
  const byName = new Map(bundles.map((b) => [b.name, b]));
  const claims = tenantClaims(domains);
  const problems: string[] = [];
  for (const binding of bindings) {
    const claimed =
      binding.scope.level === "domain" && binding.scope.domain !== undefined
        ? claims.get(binding.scope.domain)
        : undefined;
    const broad = binding.scope.level === "org" || binding.scope.level === "tenant" || claimed !== undefined;
    if (binding.allowBroad !== undefined && !broad) {
      const why =
        binding.scope.level === "domain"
          ? ` — a domain binding is only broad while its domain claims a tenant via \`containers\` (agent/memory/domains.ts), and "${binding.scope.domain}" claims none`
          : "";
      problems.push(
        `binding "${binding.bundle}" (${binding.scope.level} scope) sets allowBroad but isn't a broad scope${why} — remove the escape (it suggests the binding means something it doesn't)`,
      );
      continue;
    }
    if (!broad) continue;
    const bundle = byName.get(binding.bundle);
    if (!bundle) continue;
    const fields = credentialedFields(bundle);
    if (fields.length === 0) continue;
    if (binding.allowBroad !== undefined && binding.allowBroad.trim() === "") {
      problems.push(`binding "${binding.bundle}" (${binding.scope.level} scope) has an EMPTY allowBroad — the escape must name the reason this broad grant is deliberate`);
      continue;
    }
    if (binding.allowBroad === undefined) {
      if (claimed) {
        problems.push(
          `broad credentialed grant (via domain claim): bundle "${binding.bundle}" carries ${fields.join(" + ")} bound at domain scope — but domain "${binding.scope.domain}" claims the whole tenant(s) ${claimed.join(", ")} via \`containers\` (agent/memory/domains.ts), so this reaches EVERY surface under them, including ones created later that nobody will ever list. ` +
            `The binding reads as narrow; the width comes from the domain. Either enumerate the domain's surfaces in \`channels\` instead of claiming the tenant, or accept it deliberately with allowBroad: "<reason>" on the binding (access/bundle.ts).`,
        );
      } else {
        problems.push(
          `broad credentialed grant: bundle "${binding.bundle}" carries ${fields.join(" + ")} bound at ${binding.scope.level} scope — every surface beneath it (incl. future/public ones) inherits that capability. ` +
            `Bind it to a domain or specific surface instead, or accept it deliberately with allowBroad: "<reason>" on the binding (access/bundle.ts).`,
        );
      }
    }
  }
  return problems;
}

export function lintMethodNarrowing(bundles: readonly Bundle[]): string[] {
  const problems: string[] = [];
  for (const bundle of bundles) {
    for (const c of bundle.connections ?? []) {
      if (!c.methods || c.methods.length === 0) {
        problems.push(
          `bundle "${bundle.name}" connection "${c.id}" declares no \`methods\` — an un-narrowed credentialed connection admits GET and DELETE alike on its granted hosts. ` +
            `Declare the methods it needs: ["GET", "HEAD"] is the read-only standard shape; name mutating methods explicitly so they're a reviewed declaration.`,
        );
      }
    }
  }
  return problems;
}

export function lintAccessConfig(
  bundles: readonly Bundle[],
  bindings: readonly Binding[],
  domains: readonly Domain[] = [],
): string[] {
  return [...lintBroadGrants(bundles, bindings, domains), ...lintMethodNarrowing(bundles)];
}
