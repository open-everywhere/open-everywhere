import type { ProviderGrant } from "./providers.js";

export type ScopeLevel = "org" | "tenant" | "domain" | "surface" | "principal";

export interface Scope {
  readonly level: ScopeLevel;
  readonly tenant?: string;
  readonly domain?: string;
  readonly surface?: string;
  readonly principal?: string;
}

export type CredentialType = "bearer" | "basic" | "github-app";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CustomHeader {
  readonly name: string;
  readonly prefix?: string;
  readonly secretRef: string;
}

export interface CredentialAuthorizationDetail {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface Connection {
  readonly id: string;
  readonly credentialType: CredentialType;
  readonly secretRef: string;
  readonly broker?: string;
  readonly allowedWebsites: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly customHeaders?: readonly CustomHeader[];
  readonly methods?: readonly HttpMethod[];
  readonly authorizationDetails?: readonly CredentialAuthorizationDetail[];
}

export interface Bundle {
  readonly name: string;
  readonly title?: string;
  readonly connections?: readonly Connection[];
  readonly connectors?: readonly string[];
  readonly providers?: readonly ProviderGrant[];
  readonly repos?: readonly string[];
  readonly domains?: readonly string[];
  readonly plugins?: readonly string[];
  readonly instructions?: string;
}

export interface Binding {
  readonly bundle: string;
  readonly scope: Scope;
  readonly allowBroad?: string;
}

export function defineBundle(bundle: Bundle): Bundle {
  return bundle;
}

export function defineBinding(binding: Binding): Binding {
  return binding;
}

const REPO_FORM = /^[\w.-]+\/[\w.-]+$/u;

function isOverlyBroadHost(pattern: string): boolean {
  return pattern === "*" || /^\*\.[^.]+$/u.test(pattern);
}

function broadHostProblems(bundleName: string, field: string, hosts: readonly string[]): string[] {
  return hosts
    .filter(isOverlyBroadHost)
    .map(
      (h) =>
        `  bundle "${bundleName}" ${field} pattern "${h}" is overly broad (matches ${h === "*" ? "every host" : "an entire TLD"}) — name real hosts, wildcard only one org's subdomains (e.g. "*.googleapis.com")`,
    );
}

export function assertBundlesValid(bundles: readonly Bundle[]): void {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const b of bundles) {
    if (seen.has(b.name)) bad.push(`  bundle name "${b.name}" is defined more than once (bindings reference bundles by name — names must be unique)`);
    seen.add(b.name);
    for (const c of b.connections ?? []) {
      if (c.allowedWebsites.length === 0) {
        bad.push(`  bundle "${b.name}" connection "${c.id}" has an empty allowedWebsites — the credential can be sent nowhere; name the host(s) it may reach`);
      }
      bad.push(...broadHostProblems(b.name, `connection "${c.id}" allowedWebsites`, c.allowedWebsites));
    }
    bad.push(...broadHostProblems(b.name, "domains", b.domains ?? []));
    const connectors = new Set<string>();
    for (const name of b.connectors ?? []) {
      if (connectors.has(name)) bad.push(`  bundle "${b.name}" grants connector "${name}" more than once — remove the duplicate`);
      connectors.add(name);
    }
    for (const repo of b.repos ?? []) {
      if (!REPO_FORM.test(repo)) {
        bad.push(`  bundle "${b.name}" repo "${repo}" must be bare owner/name form (e.g. "acme/web") — not a URL, a bare owner, or an owner/name/extra path`);
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid access bundle(s):\n" + bad.join("\n") + "\n(access/bundle.ts / docs/how-it-works/access-and-scoping.md)",
    );
  }
}

type ScopeAddressField = "tenant" | "domain" | "surface" | "principal";
const LEVEL_FIELD: Record<string, ScopeAddressField | null | undefined> = {
  org: null,
  tenant: "tenant",
  domain: "domain",
  surface: "surface",
  principal: "principal",
};

export const TENANT_KEY = /^[^/\s]+\/[^/\s]+$/u;
export const SURFACE_KEY = /^[^/\s]+\/[^/\s]+\/\S+$/u;

export function assertBindingsValid(bindings: readonly Binding[], bundles: readonly Bundle[]): void {
  const known = new Set(bundles.map((b) => b.name));
  const bad: string[] = [];
  for (const b of bindings) {
    const where = `binding "${b.bundle}" (${b.scope.level} scope)`;
    if (!known.has(b.bundle)) bad.push(`  ${where} references unknown bundle "${b.bundle}" — define it in the bundles list or fix the name`);
    const { level, tenant, domain, surface, principal } = b.scope;
    const required = LEVEL_FIELD[level];
    if (required === undefined) {
      bad.push(`  ${where} has an unknown scope.level "${level}" — the levels are org | tenant | domain | surface | principal`);
      continue;
    }
    for (const [field, value] of [["tenant", tenant], ["domain", domain], ["surface", surface], ["principal", principal]] as const) {
      if (field === required) {
        if (!value) bad.push(`  ${where} needs scope.${field} — a ${level}-level binding can never match without one`);
      } else if (value !== undefined) {
        bad.push(
          `  ${where} also sets scope.${field} — a ${level}-level scope carries ${required ? `only scope.${required}` : "no address field"}; drop it or change the level`,
        );
      }
    }
    if (tenant && !TENANT_KEY.test(tenant)) {
      bad.push(
        `  ${where} scope.tenant "${tenant}" must be the PLATFORM-QUALIFIED tenant key "platform/<tenant-id>" (e.g. "slack/T0123ABC", "discord/1300000000000000100", "github/acme") — a bare vendor id has no platform and will NEVER match`,
      );
    }
    if (surface && !SURFACE_KEY.test(surface)) {
      bad.push(
        `  ${where} scope.surface "${surface}" must be the fully-qualified surface key "platform/<tenant-id>/<container-id>" (e.g. "slack/T0123ABC/C0123ABC") — the SAME form memory domains' \`channels\` use; a bare channel id will NEVER match`,
      );
    }
    if (domain?.includes("/")) {
      bad.push(
        `  ${where} scope.domain "${domain}" contains "/" — a domain scope takes the BARE domain name from memory/domains.ts ("payments"), deliberately NOT tenant-qualified: domains are cross-platform, so one grant is one binding`,
      );
    }
    if (principal?.includes("/") || principal?.startsWith("dm:")) {
      bad.push(
        `  ${where} scope.principal "${principal}" must be the BARE platform principal id (e.g. a Slack member id "U0123ABC") — the old \`workspace: "dm:<id>"\` sentinel is now the first-class \`principal\` level, so drop the "dm:" prefix`,
      );
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid access binding(s):\n" + bad.join("\n") + "\n(access/bundle.ts / docs/how-it-works/access-and-scoping.md)",
    );
  }
}
