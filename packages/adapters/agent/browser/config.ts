import { getSettings } from "@open-everywhere/core/agent/adapter-api.js";

export const AGENT_BROWSER_FLAG = "OE_AGENT_BROWSER";
export const AGENT_BROWSER_DOMAINS_ENV = "OE_AGENT_BROWSER_DOMAINS";

export interface AgentBrowserConfig {
  readonly domains: readonly string[];
}

export function agentBrowserEnabled(): boolean {
  return getSettings().browser.enabled;
}

export function isLoopbackBrowseHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && Number(m[1]) === 127;
}

const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

export interface ParsedDomains {
  readonly domains: readonly string[];
  readonly problems: readonly string[];
}

export function parseAgentBrowserDomains(raw: string | undefined): ParsedDomains {
  const problems: string[] = [];
  const domains: string[] = [];
  const seen = new Set<string>();
  const entries = (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  for (const entry of entries) {
    if (/[*]/.test(entry)) {
      problems.push(`"${entry}": wildcards are not supported — the egress firewall matches exact hosts, so a wildcard would silently break the outer wall; list each hostname`);
    } else if (/[/:@\s]/.test(entry)) {
      problems.push(`"${entry}": bare hostname only — no scheme, port, path, or credentials`);
    } else if (isLoopbackBrowseHost(entry)) {
      if (!seen.has(entry)) { seen.add(entry); domains.push(entry); }
    } else if (/^(\d{1,3}\.){3}\d{1,3}$/.test(entry)) {
      problems.push(`"${entry}": literal IPs are refused (metadata/private-range hazard) — use a DNS name, or a loopback address for an in-sandbox server`);
    } else if (!DNS_NAME.test(entry)) {
      problems.push(`"${entry}": not a valid hostname (lowercase DNS labels, alphabetic TLD)`);
    } else if (!seen.has(entry)) {
      seen.add(entry);
      domains.push(entry);
    }
  }
  if (entries.length === 0) problems.push(`${AGENT_BROWSER_DOMAINS_ENV} is empty — the capability requires an explicit operator allowlist (fail closed)`);
  return { domains, problems };
}

let cached: AgentBrowserConfig | undefined;
let cachedResolved = false;

export function loadAgentBrowserConfig(): AgentBrowserConfig | undefined {
  if (cachedResolved) return cached;
  cachedResolved = true;
  cached = undefined;
  if (!agentBrowserEnabled()) return undefined;
  const { domains, problems } = parseAgentBrowserDomains(getSettings().browser.domains);
  if (problems.length > 0) {
    console.error(
      `[open-everywhere:agent-browser] ${AGENT_BROWSER_FLAG}=1 but the domain allowlist is unusable — NOT arming (fail closed):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    return undefined;
  }
  cached = { domains };
  return cached;
}

export function resetAgentBrowserConfigForTest(): void {
  cached = undefined;
  cachedResolved = false;
}
