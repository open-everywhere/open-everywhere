import { getSettings, browserHostDeclarations, browserPlaneRefusal, type BrowserHostDeclaration } from "@open-everywhere/core/agent/adapter-api.js";

const AGENT_BROWSER_FLAG = "browser.enabled";

export interface AgentBrowserConfig {
  readonly hosts: readonly BrowserHostDeclaration[];
  readonly domains: readonly string[];
}

export function agentBrowserEnabled(): boolean {
  return getSettings().browser.enabled;
}

let cached: AgentBrowserConfig | undefined;
let cachedResolved = false;

export function loadAgentBrowserConfig(): AgentBrowserConfig | undefined {
  if (cachedResolved) return cached;
  cachedResolved = true;
  cached = undefined;
  if (!agentBrowserEnabled()) return undefined;
  const refusal = browserPlaneRefusal();
  if (refusal !== undefined) {
    console.error(`[open-everywhere:agent-browser] ${AGENT_BROWSER_FLAG}: true but ${refusal} NOT arming (fail closed): no tools mount, no egress host opens, no browser bakes.`);
    return undefined;
  }
  const hosts = browserHostDeclarations();
  if (hosts.length === 0) {
    console.error(
      `[open-everywhere:agent-browser] ${AGENT_BROWSER_FLAG}: true but no browser host is declared — NOT arming (fail closed). ` +
        "Declare the browse targets in agent/access/browser-hosts.ts.",
    );
    return undefined;
  }
  cached = { hosts, domains: hosts.map((h) => h.host) };
  return cached;
}

export function resetAgentBrowserConfigForTest(): void {
  cached = undefined;
  cachedResolved = false;
}
