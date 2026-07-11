import type { Binding, Bundle } from "./bundle.js";

function credentialedFields(bundle: Bundle): string[] {
  const fields: string[] = [];
  if (bundle.connections?.length) fields.push(`${bundle.connections.length} connection(s)`);
  if (bundle.providers?.length) fields.push(`${bundle.providers.length} provider credential(s)`);
  if (bundle.repos?.length) fields.push(`${bundle.repos.length} repo(s)`);
  if (bundle.connectors?.length) fields.push(`${bundle.connectors.length} connector(s)`);
  return fields;
}

export function lintBroadGrants(bundles: readonly Bundle[], bindings: readonly Binding[]): string[] {
  const byName = new Map(bundles.map((b) => [b.name, b]));
  const problems: string[] = [];
  for (const binding of bindings) {
    const broad = (binding.scope.level === "org" || binding.scope.level === "workspace") && !binding.scope.workspace?.startsWith("dm:");
    if (binding.allowBroad !== undefined && !broad) {
      problems.push(
        `binding "${binding.bundle}" (${binding.scope.level} scope) sets allowBroad but isn't a broad scope — remove the escape (it suggests the binding means something it doesn't)`,
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
      problems.push(
        `broad credentialed grant: bundle "${binding.bundle}" carries ${fields.join(" + ")} bound at ${binding.scope.level} scope — every channel beneath it (incl. future/public ones) inherits that capability. ` +
          `Bind it to a domain or specific channel instead, or accept it deliberately with allowBroad: "<reason>" on the binding (access/bundle.ts).`,
      );
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

export function lintAccessConfig(bundles: readonly Bundle[], bindings: readonly Binding[]): string[] {
  return [...lintBroadGrants(bundles, bindings), ...lintMethodNarrowing(bundles)];
}
