import browserExtension from "@agent-browser/eve";
import * as vendorTools from "@agent-browser/eve/tools";
import { registerBrowserToolkit, openBrowserEgressHosts, isLoopbackBrowseHost, browserRunsInBox, resolveEgressRoute, type BrowserToolEntry } from "@open-everywhere/core/agent/adapter-api.js";
import { type AgentBrowserConfig } from "./config.js";
import { boxedBrowserExecute, createQaBoxDriver, type QaBoxDriver } from "./docker-box.js";

interface BoundBrowserConfig {
  readonly allowedDomains?: readonly string[];
  readonly autoInstall: boolean;
  readonly contentBoundaries: boolean;
  readonly inlineScreenshots: boolean;
  readonly session?: string;
  readonly proxy?: string;
}

export const BROWSER_SESSION_NAME = "oe-browser";

export function registerAgentBrowser(cfg: AgentBrowserConfig, driver: QaBoxDriver | undefined = browserRunsInBox() ? createQaBoxDriver() : undefined): boolean {
  let proxy: string | undefined;
  if (driver !== undefined) {
    const route = resolveEgressRoute(new URL("https://example.com/"), process.env, "agent-browser");
    if (route.via !== "proxy") {
      console.error("[open-everywhere:agent-browser] the browser runs in a container behind the egress proxy here, but the app has no HTTPS_PROXY — REFUSING to arm the browser toolkit.");
      return false;
    }
    proxy = route.proxyUrl;
  }
  browserExtension({
    allowedDomains: [...cfg.domains],
    autoInstall: false,
    contentBoundaries: true,
    inlineScreenshots: false,
    session: BROWSER_SESSION_NAME,
    ...(proxy !== undefined ? { proxy } : {}),
  });

  const bound = browserExtension.config as unknown as BoundBrowserConfig;
  const domainsBound =
    Array.isArray(bound.allowedDomains) &&
    bound.allowedDomains.length === cfg.domains.length &&
    cfg.domains.every((d, i) => bound.allowedDomains![i] === d);
  if (bound.autoInstall !== false || !domainsBound || bound.session !== BROWSER_SESSION_NAME || bound.proxy !== proxy) {
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
      const entry = t as BrowserToolEntry;
      entries[`browser_${name}`] =
        driver === undefined ? entry : { ...entry, execute: boxedBrowserExecute(`browser_${name}`, entry.execute.bind(entry), driver) };
    }
  }
  registerBrowserToolkit(entries);

  openBrowserEgressHosts(cfg.hosts.filter((h) => h.credential === undefined && !isLoopbackBrowseHost(h.host)).map((h) => h.host));

  const credentialed = cfg.hosts.filter((h) => h.credential !== undefined).length;
  console.log(
    `[open-everywhere:agent-browser] armed: ${Object.keys(entries).length} browser tools, ` +
      `hosts [${cfg.domains.join(", ")}] (${credentialed} credentialed at the firewall) ` +
      `(containment: agent-browser allowed-domains + ${driver === undefined ? "egress firewall" : "a per-session container behind the egress proxy"})`,
  );
  return true;
}
