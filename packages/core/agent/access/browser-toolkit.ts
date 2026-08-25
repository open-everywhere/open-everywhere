import { defineTool, type ToolDefinition } from "eve/tools";
import type { WindowGrain } from "../identity/binding.js";
import { preRegisterDynamicEntry, grainBackstopAtExecute, fullKit } from "./window-gated.js";
import type { BindableContext } from "../identity/binding.js";
import { auditToolAction } from "../audit/tool-action.js";
import { ingestUntrustedModelOutput } from "./untrusted.js";

export interface BrowserToolEntry {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  execute(input: any, ctx: any): any;
  toModelOutput?(output: any): any;
}

export const BROWSER_TOOLS_SLUG = "browser_tools";

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

export function browserContentModelOutput(name: string, output: unknown): { type: "text"; value: string } {
  const op = name.startsWith("browser_") ? name.slice("browser_".length) : name;
  const domain = browserDomainOf(output);
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return ingestUntrustedModelOutput(text, {
    source: domain ? `browser ${op} ${domain}` : `browser ${op}`,
    ingestion: { kind: "web", label: `browser_${op}` },
  });
}

let registered: Readonly<Record<string, BrowserToolEntry>> | undefined;

function browserBackstoppedExecute(name: string, entry: BrowserToolEntry, auditAction: string): (input: unknown, ctx: unknown) => Promise<unknown> {
  return async (input: unknown, ctx: unknown) => {
    await grainBackstopAtExecute(name, fullKit(), ctx as BindableContext);
    const result = await entry.execute(input, ctx);
    await auditToolAction(ctx as BindableContext, auditAction);
    return result;
  };
}

export function registerBrowserToolkit(entries: Readonly<Record<string, BrowserToolEntry>>): void {
  const armed: Record<string, BrowserToolEntry> = {};
  for (const [name, entry] of Object.entries(entries)) {
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
  if (registered === undefined || Object.keys(registered).length === 0) return null;
  return fullKit().includes(grain) ? registered : null;
}
