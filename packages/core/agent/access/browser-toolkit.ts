import { defineTool, type ToolDefinition } from "eve/tools";
import type { WindowGrain } from "../identity/binding.js";
import { preRegisterDynamicEntry, grainBackstopAtExecute, FULL_KIT } from "./window-gated.js";
import type { BindableContext } from "../identity/binding.js";

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

let registered: Readonly<Record<string, BrowserToolEntry>> | undefined;

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
    const backstopped = defineTool({
      ...entry,
      execute: async (input: unknown, ctx: unknown) => {
        await grainBackstopAtExecute(name, FULL_KIT, ctx as BindableContext);
        return entry.execute(input, ctx);
      },
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
  return FULL_KIT.includes(grain) ? registered : null;
}
