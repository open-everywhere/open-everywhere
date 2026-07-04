import type { ProviderGrant } from "./providers.js";

export type ScopeLevel = "org" | "workspace" | "domain" | "channel";

export interface Scope {
  readonly level: ScopeLevel;
  readonly workspace?: string;
  readonly domain?: string;
  readonly channel?: string;
}

export type CredentialType = "bearer" | "basic" | "github-app";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CustomHeader {
  readonly name: string;
  readonly prefix?: string;
  readonly secretRef: string;
}

export interface Connection {
  readonly id: string;
  readonly credentialType: CredentialType;
  readonly secretRef: string;
  readonly allowedWebsites: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly customHeaders?: readonly CustomHeader[];
  readonly methods?: readonly HttpMethod[];
}

export interface Bundle {
  readonly name: string;
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

export function assertBindingsValid(bindings: readonly Binding[], bundles: readonly Bundle[]): void {
  const known = new Set(bundles.map((b) => b.name));
  const bad: string[] = [];
  for (const b of bindings) {
    const where = `binding "${b.bundle}" (${b.scope.level} scope)`;
    if (!known.has(b.bundle)) bad.push(`  ${where} references unknown bundle "${b.bundle}" — define it in the bundles list or fix the name`);
    const { level, workspace, domain, channel } = b.scope;
    if ((level === "workspace" || level === "domain" || level === "channel") && !workspace) {
      bad.push(`  ${where} needs scope.workspace — a ${level}-level binding can never match without one`);
    }
    if (level === "domain" && !domain) bad.push(`  ${where} needs scope.domain (a memory/domains.ts name)`);
    if (level === "channel" && !channel) bad.push(`  ${where} needs scope.channel`);
    for (const [field, value] of [["workspace", workspace], ["channel", channel]] as const) {
      if (value?.includes("/")) {
        bad.push(
          `  ${where} scope.${field} "${value}" contains "/" — bindings take the BARE platform id (Slack: team_id like "T0123ABC" / channel_id like "C0123ABC"), not the "platform/…" surface key memory domains use; a "/" value will NEVER match`,
        );
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid access binding(s):\n" + bad.join("\n") + "\n(access/bundle.ts / docs/how-it-works/access-and-scoping.md)",
    );
  }
}
