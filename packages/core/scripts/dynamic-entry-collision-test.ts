import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-entry-collision-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import { mountedEntryCollisions, preRegisterDynamicEntry, preRegisterDynamicVariants, type ReplayableToolEntry } from "../agent/access/window-gated.js";
import { registerBrowserToolkit } from "../agent/access/browser-toolkit.js";

registerBrowserToolkit({
  browser_navigate: { description: "fake", inputSchema: {}, execute: () => ({ ok: true }) },
  browser_screenshot: { description: "fake", inputSchema: {}, execute: () => ({ ok: true }) },
});

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const DURABLE_TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");
interface Descriptor {
  readonly callback: (closure: Record<string, unknown>, ...args: unknown[]) => unknown;
  readonly closure: Record<string, unknown>;
}
const describedExecute = (entry: unknown): Descriptor | undefined =>
  ((entry as Record<symbol, unknown>)[DURABLE_TOOL_CALLBACKS] as Record<string, Descriptor | undefined> | undefined)?.execute;

console.log("1. the real core tool inventory:");
const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");
const toolFiles = readdirSync(toolsDir).filter((f) => f.endsWith(".ts") && readFileSync(join(toolsDir, f), "utf8").includes("defineDynamic("));
for (const f of toolFiles) await import(`../agent/tools/${f.replace(/\.ts$/, "")}.js`);
ok(toolFiles.length > 20, `the scan imported the tool inventory (${toolFiles.length} defineDynamic files)`);

{
  const collisions = mountedEntryCollisions();
  const unmanaged = collisions.filter((c) => !c.variantManaged);
  eq(
    unmanaged.map((c) => c.name),
    [],
    "no mounted tool name holds two entries registered as separate singles — eve keeps ONE execute per (toolName, phase), " +
      "so the second registration would silently take over the first's contract on a replayed turn. Use preRegisterDynamicVariants.",
  );
  const split = collisions.filter((c) => c.distinctExecuteCallbacks !== 1);
  eq(
    split.map((c) => `${c.name} (${String(c.distinctExecuteCallbacks)} callbacks)`),
    [],
    "every multi-entry tool name resolves to exactly ONE execute callback — a second callback means a descriptor was not overwritten " +
      "(eve's build transform stamps each inline execute body as its own callback)",
  );
  eq(
    collisions.map((c) => c.name).sort(),
    ["edit_reply", "reply"],
    "exactly two core tool names mount several entries, and both are the reply plane's unified/per-surface pair",
  );
}

console.log("2. reply / edit_reply descriptor identity:");
{
  const reply = (await import("../agent/tools/reply.js")) as { unifiedReplyEntry: unknown; baseReplyEntry: unknown };
  const unified = describedExecute(reply.unifiedReplyEntry);
  const base = describedExecute(reply.baseReplyEntry);
  ok(unified !== undefined && base !== undefined, "both reply variants carry a durable execute descriptor");
  ok(unified!.callback === base!.callback, "both reply variants describe the SAME execute callback — one dispatcher owns eve's (reply, execute) slot");
  eq(unified!.closure, { entryKey: "_single" }, "the unified reply variant's closure names it, and eve persists that closure with the tool");
  eq(base!.closure, { entryKey: "_base" }, "the per-surface reply variant's closure names it — the two are what replay tells apart");
}

console.log("3. installed-eve replay picks the variant the closure names:");
const require2 = createRequire(import.meta.url);
const eveRoot = dirname(require2.resolve("eve/package.json"));
const distUrl = (rel: string): string => pathToFileURL(join(eveRoot, "dist", "src", rel)).href;
const lifecycle = (await import(distUrl("context/dynamic-tool-lifecycle.js"))) as {
  validateDurableDynamicToolCallbacks(name: string, entry: unknown): { execute: { closure: Record<string, unknown> } };
};
const durable = (await import(distUrl("tools/durable-callbacks.js"))) as {
  lookupDurableDynamicCallback(toolName: string, phase: string): ((closure: Record<string, unknown>, ...args: unknown[]) => unknown) | undefined;
};

function fixturePair(): { unified: ReplayableToolEntry; base: ReplayableToolEntry } {
  return {
    base: { execute: () => "BASE" },
    unified: { execute: () => "UNIFIED" },
  };
}

{
  const { unified, base } = fixturePair();
  preRegisterDynamicVariants("pretend_reply_dispatched", { _base: base, _single: unified });
  const unifiedClosure = lifecycle.validateDurableDynamicToolCallbacks("pretend_reply_dispatched", unified).execute.closure;
  lifecycle.validateDurableDynamicToolCallbacks("pretend_reply_dispatched", base);
  eq(unifiedClosure, { entryKey: "_single" }, "eve persists the unified variant's key in the durable closure");
  const bound = durable.lookupDurableDynamicCallback("pretend_reply_dispatched", "execute");
  ok(typeof bound === "function", "eve bound a callback under (pretend_reply_dispatched, execute)");
  eq(bound!(unifiedClosure), "UNIFIED", "a replay driven from the UNIFIED closure runs the UNIFIED implementation, though the per-surface variant registered LAST");
  eq(bound!({ entryKey: "_base" }), "BASE", "…and the per-surface closure still runs the per-surface implementation");
  assert.throws(
    () => bound!({}),
    /no variant key in its durable closure/,
    "a closure with no variant key FAILS CLOSED — guessing there is the defect this gate exists for",
  );
  n++;
}

console.log("4. negative control — the pre-fix registration shape runs the WRONG implementation:");
{
  const { unified, base } = fixturePair();
  preRegisterDynamicEntry("pretend_reply_collided", "_single", unified);
  preRegisterDynamicEntry("pretend_reply_collided", "_base", base);
  const unifiedClosure = lifecycle.validateDurableDynamicToolCallbacks("pretend_reply_collided", unified).execute.closure;
  lifecycle.validateDurableDynamicToolCallbacks("pretend_reply_collided", base);
  const bound = durable.lookupDurableDynamicCallback("pretend_reply_collided", "execute");
  eq(bound!(unifiedClosure), "BASE", "the pre-fix shape runs the PER-SURFACE implementation from the UNIFIED closure — the measured defect, reproduced");
  const collided = mountedEntryCollisions().find((c) => c.name === "pretend_reply_collided");
  ok(collided !== undefined && !collided.variantManaged, "…and leg 1's check sees it as an unmanaged collision");
  ok(collided!.distinctExecuteCallbacks === 2, "…with two distinct execute callbacks, which is leg 1's second discriminator");
}

console.log(`\ndynamic-entry-collision: ${n} assertions passed.`);
