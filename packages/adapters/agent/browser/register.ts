import browserExtension from "@agent-browser/eve";
import * as vendorTools from "@agent-browser/eve/tools";
import { registerBrowserToolkit, openBrowserEgressHosts, isLoopbackBrowseHost, type BrowserToolEntry } from "@open-everywhere/core/agent/adapter-api.js";
import { type AgentBrowserConfig } from "./config.js";

interface BoundBrowserConfig {
  readonly allowedDomains?: readonly string[];
  readonly autoInstall: boolean;
  readonly contentBoundaries: boolean;
  readonly inlineScreenshots: boolean;
}

export function registerAgentBrowser(cfg: AgentBrowserConfig): boolean {
  browserExtension({
    allowedDomains: [...cfg.domains],
    autoInstall: false,
    contentBoundaries: true,
    inlineScreenshots: false,
  });

  const bound = browserExtension.config as unknown as BoundBrowserConfig;
  const domainsBound =
    Array.isArray(bound.allowedDomains) &&
    bound.allowedDomains.length === cfg.domains.length &&
    cfg.domains.every((d, i) => bound.allowedDomains![i] === d);
  if (bound.autoInstall !== false || !domainsBound) {
    console.error(
      "[open-everywhere:agent-browser] extension config binding FAILED (namespace patch missing? see patches/@agent-browser+eve+*.patch) — " +
        "REFUSING to arm the browser toolkit: unbound tools would run with vendor defaults (auto-install on, no domain containment).",
    );
    return false;
  }

  const entries: Record<string, BrowserToolEntry> = {};
  for (const [name, tool] of Object.entries(vendorTools)) {
    const t = tool as Partial<BrowserToolEntry> | undefined;
    if (t && typeof t.execute === "function" && typeof t.description === "string") {
      entries[`browser_${name}`] = t as BrowserToolEntry;
    }
  }
  registerBrowserToolkit(entries);

  openBrowserEgressHosts(cfg.hosts.filter((h) => h.credential === undefined && !isLoopbackBrowseHost(h.host)).map((h) => h.host));

  const credentialed = cfg.hosts.filter((h) => h.credential !== undefined).length;
  console.log(
    `[open-everywhere:agent-browser] armed: ${Object.keys(entries).length} browser tools, ` +
      `hosts [${cfg.domains.join(", ")}] (${credentialed} credentialed at the firewall) ` +
      `(containment: agent-browser allowed-domains + egress firewall)`,
  );
  return true;
}
