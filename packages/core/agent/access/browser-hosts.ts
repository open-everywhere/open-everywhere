import { processRegistrySlot } from "../lib/process-registry.js";
import { getSettings } from "../settings/settings.js";
import type { HttpMethod } from "./bundle.js";

const HTTP_METHODS: ReadonlySet<string> = new Set<HttpMethod>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

export interface BrowserHostDeclaration {
  readonly host: string;
  readonly methods: readonly HttpMethod[];
  readonly credential?: string;
  readonly evaluate?: boolean;
  readonly why: string;
}

const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

export function isLoopbackBrowseHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && Number(m[1]) === 127;
}

export function browserHostProblems(rows: readonly BrowserHostDeclaration[]): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  if (rows.length === 0) {
    problems.push("the browser host declaration is empty — the capability requires at least one declared host (fail closed)");
  }
  for (const row of rows) {
    const host = row.host;
    const at = `"${host}"`;
    if (typeof host !== "string" || host.trim() !== host || host.toLowerCase() !== host || host.length === 0) {
      problems.push(`${at}: a host is a bare lowercase hostname with no surrounding whitespace`);
      continue;
    }
    if (isLoopbackBrowseHost(host)) {
    } else if (host.includes("*")) {
      problems.push(`${at}: wildcards are not supported — the egress firewall matches exact hosts, so a wildcard would open nothing on the outer wall; declare each hostname`);
    } else if (/[/:@\s]/.test(host)) {
      problems.push(`${at}: bare hostname only — no scheme, port, path, or credentials`);
    } else if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
      problems.push(`${at}: literal IPs are refused (metadata/private-range hazard) — declare a DNS name, or a loopback address for an in-sandbox server`);
    } else if (!DNS_NAME.test(host)) {
      problems.push(`${at}: not a valid hostname (lowercase DNS labels, alphabetic TLD)`);
    }
    if (seen.has(host)) {
      problems.push(`${at}: declared twice — one row per host, so the verbs and the credential a host is reached with are unambiguous`);
    }
    seen.add(host);

    if (!Array.isArray(row.methods)) {
      problems.push(`${at}: declare the HTTP verbs the firewall admits, as an array`);
      continue;
    }
    if (row.methods.length === 0) {
      problems.push(`${at}: declare the HTTP verbs the firewall admits — a browser host is a host+method row, and an empty list would admit nothing`);
    }
    for (const method of row.methods) {
      if (!HTTP_METHODS.has(method)) problems.push(`${at}: "${method}" is not an HTTP verb this plane admits`);
    }
    if (row.credential !== undefined) {
      if (row.credential.trim().length === 0) {
        problems.push(`${at}: "credential" names an egress connection id — an empty string names nothing`);
      }
      if (isLoopbackBrowseHost(host)) {
        problems.push(
          `${at}: a loopback host carries no credential — loopback traffic never crosses the egress firewall, so there is no boundary at which to inject one`,
        );
      }
    }
    if (typeof row.why !== "string" || row.why.trim().length === 0) {
      problems.push(`${at}: declare WHY this deployment reaches this host — the row is a reviewed security decision`);
    }
  }
  return problems;
}

const SLOT = processRegistrySlot<readonly BrowserHostDeclaration[]>("browser-hosts.v1");

export function defineBrowserHosts(rows: readonly BrowserHostDeclaration[]): readonly BrowserHostDeclaration[] {
  const problems = browserHostProblems(rows);
  if (problems.length > 0) {
    throw new Error(`browser host declaration is unusable — NOT arming (fail closed):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return Object.freeze(rows.map((r) => Object.freeze({ ...r })));
}

export function registerBrowserHosts(rows: readonly BrowserHostDeclaration[]): void {
  SLOT.set(defineBrowserHosts(rows));
}

export function browserHostDeclarations(): readonly BrowserHostDeclaration[] {
  return SLOT.get() ?? [];
}

export function browserEgressHosts(): readonly BrowserHostDeclaration[] {
  if (!getSettings().browser.enabled) return [];
  return browserHostDeclarations().filter((r) => !isLoopbackBrowseHost(r.host));
}

export function browserEvaluateHosts(): ReadonlySet<string> {
  if (!getSettings().browser.enabled) return new Set();
  return new Set(browserHostDeclarations().filter((r) => r.evaluate === true).map((r) => r.host));
}

export function _setBrowserHostsForTest(rows: readonly BrowserHostDeclaration[]): void {
  SLOT.set(Object.freeze(rows.map((r) => Object.freeze({ ...r }))));
}

export function resetBrowserHostsForTest(): void {
  SLOT.set(null);
}
