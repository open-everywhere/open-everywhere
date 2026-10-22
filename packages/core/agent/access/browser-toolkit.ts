import { defineTool, type ToolDefinition } from "eve/tools";
import type { WindowGrain } from "../identity/binding.js";
import { preRegisterDynamicEntry, grainBackstopAtExecute, fullKit } from "./window-gated.js";
import { currentSessionId, type BindableContext } from "../identity/binding.js";
import { auditToolAction } from "../audit/tool-action.js";
import { ingestUntrustedModelOutput } from "./untrusted.js";
import { browserEvaluateHosts } from "./browser-hosts.js";
import { resolveSandboxBackend } from "../sandbox/backend-select.js";
import { registerExtraEgressHosts } from "./extra-hosts.js";

export interface BrowserToolEntry {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  execute(input: any, ctx: any): any;
  toModelOutput?(output: any): any;
}

const BROWSER_TOOLS_SLUG = "browser_tools";

export function browserPlaneRefusal(): string | undefined {
  const backend = resolveSandboxBackend();
  if (backend === "vercel") return undefined;
  const why =
    backend === "justbash"
      ? "the justbash backend runs no native binary, so it cannot run the agent-browser CLI or Chromium"
      : "the docker backend's session containers sit outside the egress proxy and take no host allow-list (OPE-2407), so the declared hosts and the credential stamp cannot hold";
  return `the browser plane needs the Vercel Sandbox backend: ${why}. Nothing arms here (agent/access/browser-toolkit.ts).`;
}

const BROWSER_EGRESS_SOURCE = "agent-browser";

export function openBrowserEgressHosts(hosts: readonly string[]): boolean {
  const refusal = browserPlaneRefusal();
  if (refusal !== undefined) {
    console.error(`[open-everywhere:agent-browser] NOT opening ${hosts.length} declared egress host(s): ${refusal}`);
    return false;
  }
  registerExtraEgressHosts(BROWSER_EGRESS_SOURCE, hosts);
  return true;
}

export const BROWSER_TOOL_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_read",
  "browser_click",
  "browser_fill",
  "browser_press_key",
  "browser_hover",
  "browser_select_option",
  "browser_set_checked",
  "browser_scroll",
  "browser_drag",
  "browser_upload",
  "browser_wait_for",
  "browser_get",
  "browser_find",
  "browser_screenshot",
  "browser_evaluate",
  "browser_tabs",
  "browser_console",
  "browser_network_requests",
  "browser_close",
] as const;

export const BROWSER_UNFENCED_OPS: ReadonlySet<string> = new Set(["browser_screenshot", "browser_close"]);

function browserDomainOf(output: unknown): string | undefined {
  const host = (u: unknown): string | undefined => {
    if (typeof u !== "string") return undefined;
    try {
      return new URL(u).host || undefined;
    } catch {
      return undefined;
    }
  };
  if (output !== null && typeof output === "object") {
    const o = output as Record<string, unknown>;
    const direct = host(o.url) ?? host(o.href);
    if (direct !== undefined) return direct;
  }
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  const m = text.match(/https?:\/\/[^\s"'<>)]+/);
  return m ? host(m[0]) : undefined;
}

export function browserContentModelOutput(name: string, output: unknown): Promise<{ type: "text"; value: string }> {
  const op = name.startsWith("browser_") ? name.slice("browser_".length) : name;
  const domain = browserDomainOf(output);
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return ingestUntrustedModelOutput(text, {
    source: domain ? `browser ${op} ${domain}` : `browser ${op}`,
    ingestion: { kind: "web", label: `browser_${op}` },
  });
}

const lastBrowseHost = new Map<string, string>();

const HOST_TRACK_CAP = 256;

const URL_TAKING_OPS: ReadonlySet<string> = new Set(["browser_navigate", "browser_tabs"]);

function navigationTargetHost(name: string, input: unknown): string | undefined {
  if (!URL_TAKING_OPS.has(name) || input === null || typeof input !== "object") return undefined;
  const url = (input as { url?: unknown }).url;
  return typeof url === "string" ? hostOf(url) : undefined;
}

function hostOf(u: string): string | undefined {
  try {
    return new URL(u).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function resultReportedHost(output: unknown): string | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const o = output as { url?: unknown; href?: unknown };
  const url = typeof o.url === "string" ? o.url : typeof o.href === "string" ? o.href : undefined;
  return url === undefined ? undefined : hostOf(url);
}

function noteBrowseHost(ctx: unknown, host: string | undefined): void {
  if (host === undefined) return;
  const bare = host.startsWith("[") ? (host.match(/^\[[^\]]*\]/)?.[0] ?? host) : host.replace(/:\d+$/, "");
  if (bare.length === 0) return;
  const session = currentSessionId(ctx as BindableContext);
  if (session === undefined) return;
  if (!lastBrowseHost.has(session) && lastBrowseHost.size >= HOST_TRACK_CAP) {
    const oldest = lastBrowseHost.keys().next();
    if (!oldest.done) lastBrowseHost.delete(oldest.value);
  }
  lastBrowseHost.set(session, bare.toLowerCase());
}

export function currentBrowseHost(ctx: unknown): string | undefined {
  const session = currentSessionId(ctx as BindableContext);
  return session === undefined ? undefined : lastBrowseHost.get(session);
}

export function assertEvaluateArmedFor(ctx: unknown): void {
  const armed = browserEvaluateHosts();
  const host = currentBrowseHost(ctx);
  if (host === undefined) {
    throw new Error(
      "browser_evaluate: no page host is known for this session — navigate to a declared host first. " +
        "Page scripting is armed per host in the operator's browser host declaration (agent/access/browser-hosts.ts).",
    );
  }
  if (!armed.has(host)) {
    throw new Error(
      `browser_evaluate: "${host}" does not declare \`evaluate: true\` — page scripting is off for it. ` +
        "Drive the page from browser_snapshot plus browser_find/click/fill, or ask the operator to arm this host.",
    );
  }
}

export function resetBrowseHostsForTest(): void {
  lastBrowseHost.clear();
}

let registered: Readonly<Record<string, BrowserToolEntry>> | undefined;

function browserBackstoppedExecute(name: string, entry: BrowserToolEntry, auditAction: string): (input: unknown, ctx: unknown) => Promise<unknown> {
  return async (input: unknown, ctx: unknown) => {
    await grainBackstopAtExecute(name, fullKit(), ctx as BindableContext);
    if (name === "browser_evaluate") assertEvaluateArmedFor(ctx);
    noteBrowseHost(ctx, navigationTargetHost(name, input));
    const result = await entry.execute(input, ctx);
    noteBrowseHost(ctx, resultReportedHost(result));
    await auditToolAction(ctx as BindableContext, auditAction);
    return result;
  };
}

export function registerBrowserToolkit(entries: Readonly<Record<string, BrowserToolEntry>>): void {
  const armed: Record<string, BrowserToolEntry> = {};
  const evaluateArmedHosts = browserEvaluateHosts();
  for (const [name, entry] of Object.entries(entries)) {
    if (name === "browser_evaluate" && evaluateArmedHosts.size === 0) {
      console.log(
        "[open-everywhere:agent-browser] browser_evaluate NOT mounted — no declared host carries `evaluate: true` " +
          "(the kit is snapshot-driven by default; arm a host in agent/access/browser-hosts.ts to re-add page scripting)",
      );
      continue;
    }
    if (!(BROWSER_TOOL_NAMES as readonly string[]).includes(name)) {
      console.error(
        `[open-everywhere:agent-browser] skipping unknown tool "${name}" — not in core's BROWSER_TOOL_NAMES canonical list (a vendor upgrade that adds a tool must extend the list in access/browser-toolkit.ts)`,
      );
      continue;
    }
    if ((entry as { approval?: unknown }).approval !== undefined) {
      throw new Error(`registerBrowserToolkit: "${name}" carries an approval policy — browser toolkit entries must be approval-less`);
    }
    const auditAction = `browser.${name.slice("browser_".length)}`;
    const fenced = !BROWSER_UNFENCED_OPS.has(name);
    const backstopped = defineTool({
      ...entry,
      execute: browserBackstoppedExecute(name, entry, auditAction),
      ...(fenced ? { toModelOutput: (output: unknown) => browserContentModelOutput(name, output) } : {}),
    } as unknown as ToolDefinition) as unknown as BrowserToolEntry;
    preRegisterDynamicEntry(BROWSER_TOOLS_SLUG, name, backstopped);
    armed[name] = backstopped;
  }
  registered = armed;
}

export function registeredBrowserToolkit(): Readonly<Record<string, BrowserToolEntry>> | undefined {
  return registered;
}

export function resetBrowserToolkitForTest(): void {
  registered = undefined;
}

export function resolveBrowserKit(grain: WindowGrain): Readonly<Record<string, BrowserToolEntry>> | null {
  if (browserPlaneRefusal() !== undefined) return null;
  if (registered === undefined || Object.keys(registered).length === 0) return null;
  return fullKit().includes(grain) ? registered : null;
}
