import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineDurableSchema, defineTool, type ToolDefinition } from "eve/tools";
import { z } from "zod";
import { registerBrowserToolkit, registeredBrowserToolkit, resetBrowserToolkitForTest, type BrowserToolEntry } from "../agent/access/browser-toolkit.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
const lifecycle = (await import(pathToFileURL(join(eveRoot, "dist", "src", "context", "dynamic-tool-lifecycle.js")).href)) as {
  validateDurableDynamicToolCallbacks(name: string, entry: unknown, owner: Record<string, string>): Record<string, unknown>;
};

function validate(name: string, entry: unknown): Record<string, unknown> {
  return lifecycle.validateDurableDynamicToolCallbacks(name, entry, {
    sessionId: "sess-browser-durable-schema",
    scope: "session",
    resolverSlug: "browser_tools",
    entryKey: name,
    name,
  });
}

const navigateSchema = () => z.object({ url: z.string().describe("The URL to open.") });
const screenshotSchema = () => z.object({ fullPage: z.boolean().default(false) });

function builtVendorEntry(description: string, schema: () => z.ZodType): BrowserToolEntry {
  return defineTool({
    description,
    inputSchema: defineDurableSchema({ closure: {} as Record<string, never>, schema: () => schema() as never }),
    execute: async () => ({ ok: true }),
  } as unknown as ToolDefinition) as unknown as BrowserToolEntry;
}

function sourceVendorEntry(description: string, schema: () => z.ZodType): BrowserToolEntry {
  return defineTool({ description, inputSchema: schema(), execute: async () => ({ ok: true }) } as unknown as ToolDefinition) as unknown as BrowserToolEntry;
}

{
  resetBrowserToolkitForTest();
  registerBrowserToolkit({
    browser_navigate: builtVendorEntry("Open a URL.", navigateSchema),
    browser_screenshot: builtVendorEntry("Take a screenshot.", screenshotSchema),
  });
  const kit = registeredBrowserToolkit();
  ok(kit !== undefined, "fixture check: the toolkit registered");
  eq(Object.keys(kit ?? {}).sort(), ["browser_navigate", "browser_screenshot"], "fixture check: both ops mounted");
  for (const name of ["browser_navigate", "browser_screenshot"] as const) {
    const entry = kit?.[name];
    let callbacks: Record<string, unknown> | undefined;
    let refusal: unknown;
    try {
      callbacks = validate(name, entry);
    } catch (e) {
      refusal = e;
    }
    ok(refusal === undefined, `🔴 eve ACCEPTS the wrapped ${name}: ${String(refusal)}`);
    eq(callbacks?.inputSchema, { closure: {} }, `🔴 ${name}'s inputSchema descriptor survives the wrapper's spread, with an empty closure`);
    ok(callbacks?.execute !== undefined, `${name}'s execute descriptor is filled by preRegisterDynamicEntry`);
  }
  ok(validate("browser_navigate", kit?.browser_navigate).toModelOutput !== undefined, "the fenced op's toModelOutput descriptor sits beside the schema descriptor");
  ok(validate("browser_screenshot", kit?.browser_screenshot).toModelOutput === undefined, "the unfenced FIXTURE op authors no toModelOutput, so the wrapper adds no descriptor for it (the real vendor screenshot authors its own)");
}

{
  resetBrowserToolkitForTest();
  registerBrowserToolkit({ browser_navigate: sourceVendorEntry("Open a URL.", navigateSchema) });
  const entry = registeredBrowserToolkit()?.browser_navigate;
  ok(entry !== undefined, "fixture check: the source-shaped op registered");
  assert.throws(
    () => validate("browser_navigate", entry),
    /callback "inputSchema" does not have a durable descriptor/u,
    "🔴 eve REFUSES a browser op whose vendor schema carries no descriptor, because today's wrapper adds none (if registerBrowserToolkit adopts withDurableSchemas, invert this section to expect acceptance)",
  );
  n++;
  resetBrowserToolkitForTest();
}

console.log(`\n✓ browser-toolkit-durable-schema: ${n} assertions passed (the vendor's described schema rides through registerBrowserToolkit and eve accepts it; a bare one is refused)\n`);
