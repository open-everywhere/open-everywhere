import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-entry-collision-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import { registeredMountedEntries } from "../agent/access/window-gated.js";
import { BROWSER_TOOL_NAMES } from "../agent/access/browser-toolkit.js";
import { WINDOW_GATED_TOOLS } from "../agent/access/window-gate-manifest.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const DYNAMIC_MARKERS = /\b(?:defineDynamic|sessionMountedTool|sessionVariantTool|windowGated|windowGatedKit)\s*\(/;

function staticDynamicCollisions(staticNames: Iterable<string>, dynamicNames: Iterable<string>): string[] {
  const statics = new Set(staticNames);
  return [...new Set(dynamicNames)].filter((name) => statics.has(name)).sort();
}

console.log("1. the real core tool inventory:");
const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");
const files = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
const dynamicFiles = files.filter((f) => DYNAMIC_MARKERS.test(readFileSync(join(toolsDir, f), "utf8")));
const staticNames = files.filter((f) => !dynamicFiles.includes(f)).map((f) => f.replace(/\.ts$/, ""));
ok(dynamicFiles.length > 40, `the scan found the dynamic tool inventory (${dynamicFiles.length} files)`);
ok(staticNames.length > 40, `…and the static tool inventory (${staticNames.length} files)`);
for (const f of dynamicFiles) await import(`../agent/tools/${f.replace(/\.ts$/, "")}.js`);

const kitNames = (src: string): string[] => [...src.matchAll(/\n\s+([a-z_][\w]*)\s*:\s*defineTool\(/gu)].map((m) => m[1]);
const dynamicNames = new Set<string>([...registeredMountedEntries().keys(), ...BROWSER_TOOL_NAMES, ...Object.keys(WINDOW_GATED_TOOLS)]);
for (const f of dynamicFiles) {
  const src = readFileSync(join(toolsDir, f), "utf8");
  if (/windowGatedKit\s*\(/.test(src)) for (const name of kitNames(src)) dynamicNames.add(name);
  else if (!/\bgrant_tools\b|\bbrowser_tools\b/.test(f)) dynamicNames.add(f.replace(/\.ts$/, ""));
}
ok(dynamicNames.has("bash") && dynamicNames.has("reply") && dynamicNames.has("work"), "the dynamic name set holds the kit, variant and single-tool names");

eq(
  staticDynamicCollisions(staticNames, dynamicNames),
  [],
  "🔴 no dynamic tool name equals a static tool file name. On eve 1.x a dynamic tool no longer replaces a static tool of the same name, " +
    "so a collision would let the static tool win and silently change a seat. Define a per-session tool ONLY in a dynamic file.",
);
eq(
  staticDynamicCollisions(["work", "read_file"], ["work", "bash"]),
  ["work"],
  "NEGATIVE CONTROL: the check names a collision when one exists",
);

console.log("2. eve's default tools:");
{
  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const src = readFileSync(join(eveRoot, "dist/src/framework/sources/default-tools.js"), "utf8");
  const listed = /const DEFAULT_TOOLS=\[([^\]]*)\]/.exec(src)?.[1];
  ok(listed !== undefined, "the installed eve still declares its DEFAULT_TOOLS list");
  const defaults = [...(listed ?? "").matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  eq(
    staticDynamicCollisions(defaults, dynamicNames),
    ["bash", "edit_file", "read_file", "web_fetch", "write_file"],
    "🔴 exactly these five eve default tools are re-provided per grain by the sandbox kit. Each needs its roster `framework.disable` sentinel, " +
      "or eve's static default wins over the gated kit member. A new name here (eve adds a default that the kit also provides) needs a sentinel first.",
  );
}

console.log("3. the reply plane's variant pairs:");
{
  eq(registeredMountedEntries().get("reply")?.size, 2, "reply registers its unified and per-surface variants under one name");
  eq(registeredMountedEntries().get("edit_reply")?.size, 2, "edit_reply does the same");
}

console.log(`\n✓ dynamic-entry-collision: ${n} assertions passed.`);
