import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkWindowGateManifest,
  WINDOW_GATED_TOOLS,
  WINDOW_UNGATED_TOOLS,
  FULL_KIT,
  withheldFromGrain,
  type WindowToolSource,
} from "../agent/access/window-gate-manifest.js";
import type { WindowGrain } from "../agent/identity/binding.js";

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { getAllFrameworkToolNames } = (await import(
  pathToFileURL(join(eveRoot, "dist/src/runtime/framework-tools/index.js")).href
)) as { getAllFrameworkToolNames(): ReadonlySet<string> };
const FRAMEWORK_TOOL_NAMES = [...getAllFrameworkToolNames(), "connection_search"];

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
function firesWith(problems: string[], needle: string, label: string): void {
  ok(
    problems.some((p) => p.includes(needle)),
    `${label} (got: ${JSON.stringify(problems)})`,
  );
}

const wrapped = (name: string) => `export default windowGated("${name}", defineTool({}));`;
const unwrapped = (name: string) => `export default defineTool({/* ${name} */});`;
const SENTINEL = "export default disableTool();";
const KIT = 'export default windowGatedKit("sandbox_tools", {\n  bash: defineTool(x),\n  web_fetch: defineTool(y),\n});';

const g = (t: Record<string, readonly WindowGrain[]>) => t;
const u = (...names: string[]) => new Set(names);

{
  const core: WindowToolSource[] = [{ name: "open_pull_request", source: wrapped("open_pull_request") }];
  const shims = new Map([
    ["open_pull_request", 'export { default } from "@open-everywhere/core/agent/tools/open_pull_request.js";'],
    ["reply", 'export { default } from "@open-everywhere/core/agent/tools/reply.js";'],
  ]);
  core.push({ name: "reply", source: "export default defineTool({});" });
  const problems = checkWindowGateManifest(core, shims, [], g({ open_pull_request: FULL_KIT }), u("reply"));
  ok(problems.length === 0, `a total, matching manifest is clean (got: ${JSON.stringify(problems)})`);
}

firesWith(
  checkWindowGateManifest([{ name: "mystery", source: "" }], new Map([["mystery", ""]]), [], g({}), u()),
  'tool "mystery" has NO window-gate posture',
  "a tool in NEITHER table FAILS (no default posture — the core Stage-E guard)",
);

firesWith(
  checkWindowGateManifest([{ name: "reply", source: "x" }], new Map([["reply", "x"]]), [], g({ reply: FULL_KIT }), u("reply")),
  'declared in BOTH',
  "a tool in both WINDOW_GATED_TOOLS and WINDOW_UNGATED_TOOLS FAILS",
);

firesWith(
  checkWindowGateManifest([], new Map(), [], g({ ghost: FULL_KIT }), u()),
  'WINDOW_GATED_TOOLS names "ghost"',
  "a stale WINDOW_GATED_TOOLS row FAILS",
);
firesWith(
  checkWindowGateManifest([], new Map(), [], g({}), u("phantom")),
  'WINDOW_UNGATED_TOOLS names "phantom"',
  "a stale WINDOW_UNGATED_TOOLS row FAILS",
);

firesWith(
  checkWindowGateManifest([{ name: "open_pull_request", source: wrapped("open_pull_request") }], new Map([["open_pull_request", ""]]), [], g({ open_pull_request: ["standing"] }), u()),
  'must be exactly ["task","native"]',
  "a wide-hands tool leaking onto a STANDING seat FAILS",
);
firesWith(
  checkWindowGateManifest([{ name: "spawn_task", source: wrapped("spawn_task") }], new Map([["spawn_task", ""]]), [], g({ spawn_task: ["task"] }), u()),
  'spawn_task"] must be exactly ["standing"]',
  "spawn_task scoped to a non-standing grain FAILS (no recursive spawn)",
);
firesWith(
  checkWindowGateManifest([{ name: "complete_task", source: wrapped("complete_task") }], new Map([["complete_task", ""]]), [], g({ complete_task: ["standing"] }), u()),
  'complete_task"] must be exactly ["task"]',
  "complete_task leaking onto a standing seat FAILS",
);

firesWith(
  checkWindowGateManifest([{ name: "post_file", source: unwrapped("post_file") }], new Map([["post_file", ""]]), [], g({ post_file: FULL_KIT }), u()),
  'does not wrap its export in windowGated("post_file"',
  "a gated authored tool that dropped its windowGated wrapper FAILS (silent static re-introduction)",
);
{
  const problems = checkWindowGateManifest(
    [{ name: "post_file", source: wrapped("post_file") }],
    new Map([["post_file", ""]]),
    [],
    g({ post_file: FULL_KIT }),
    u(),
  );
  ok(problems.length === 0, "the correctly-wrapped gated tool is clean");
}

firesWith(
  checkWindowGateManifest(
    [{ name: "sandbox_tools", source: KIT }],
    new Map([
      ["bash", "export default someOtherThing();"],
      ["sandbox_tools", 'export { default } from "@open-everywhere/core/agent/tools/sandbox_tools.js";'],
    ]),
    ["bash"],
    g({ bash: FULL_KIT }),
    u("sandbox_tools"),
  ),
  "is not a `disableTool()` sentinel",
  "a framework-gated name whose app shim is NOT a disableTool() sentinel FAILS (built-in leaks onto standing)",
);
firesWith(
  checkWindowGateManifest(
    [{ name: "sandbox_tools", source: 'export default windowGatedKit("sandbox_tools", {\n  bash: defineTool(x),\n});' }],
    new Map([
      ["web_fetch", SENTINEL],
      ["sandbox_tools", 'export { default } from "@open-everywhere/core/agent/tools/sandbox_tools.js";'],
    ]),
    ["web_fetch"],
    g({ web_fetch: FULL_KIT }),
    u("sandbox_tools"),
  ),
  'framework tool "web_fetch" is grain-gated but no windowGatedKit(...) in packages/core/agent/tools/ re-provides it per grain',
  "a framework-gated name absent from EVERY windowGatedKit FAILS (the kit is no longer pinned to sandbox_tools — #96 added delegation_tools; the invariant is that SOME kit provides the name)",
);
{
  const problems = checkWindowGateManifest(
    [{ name: "delegation_tools", source: 'export default windowGatedKit("delegation_tools", {\n  agent: defineTool(x),\n});' }],
    new Map([
      ["agent", SENTINEL],
      ["delegation_tools", 'export { default } from "@open-everywhere/core/agent/tools/delegation_tools.js";'],
    ]),
    ["agent"],
    g({ agent: ["standing", "thread"] }),
    u("delegation_tools"),
  );
  ok(problems.length === 0, `a framework-named tool re-provided by a NON-sandbox kit (delegation_tools → agent) is clean (got: ${JSON.stringify(problems)})`);
}

firesWith(
  checkWindowGateManifest([{ name: "reply", source: "x" }], new Map(), [], g({}), u("reply")),
  "has NO deploy shim",
  "a core tool with no deploy shim FAILS (the Stage-C unmounted-tool bug)",
);
firesWith(
  checkWindowGateManifest(
    [],
    new Map([["ghosty", 'export { default } from "@open-everywhere/core/agent/tools/ghosty.js";']]),
    [],
    g({}),
    u("ghosty"),
  ),
  "dangling shim",
  "an app shim re-exporting a non-existent core file FAILS",
);

ok(JSON.stringify([...WINDOW_GATED_TOOLS.spawn_task]) === JSON.stringify(["standing"]), "spawn_task is standing-only");
ok(JSON.stringify([...WINDOW_GATED_TOOLS.spawn_thread_session]) === JSON.stringify(["standing"]), "spawn_thread_session is standing-only (window-only mint; no recursive thread trees)");
ok(JSON.stringify([...WINDOW_GATED_TOOLS.complete_task]) === JSON.stringify(["task"]), "complete_task is task-only");
ok(JSON.stringify([...WINDOW_GATED_TOOLS.complete_thread]) === JSON.stringify(["thread"]), "complete_thread is thread-only");
ok(JSON.stringify([...(WINDOW_GATED_TOOLS.agent ?? [])]) === JSON.stringify(["standing", "thread"]) && !WINDOW_UNGATED_TOOLS.has("agent"), "agent is grain-gated to standing+thread (a gated row again since #96; the disableTool() sentinel removes eve's built-in and delegation_tools.ts re-provides it per grain)");
ok([...FULL_KIT].sort().join(",") === "native,task", "FULL_KIT = task+native, flag-OFF (byte-identical Stage C; the T2 narrowing to task-only is flag-ON, pinned by the crafted case below)");
ok(
  withheldFromGrain("standing").includes("bash") && withheldFromGrain("standing").includes("complete_task") && withheldFromGrain("standing").includes("complete_thread"),
  "a standing seat withholds the wide-hands set + complete_task + complete_thread",
);
ok(
  withheldFromGrain("native").length === 6,
  "flag-off a native seat withholds the delegation/lifecycle set (agent/spawn_task/spawn_thread_session/complete_task/complete_thread/return_result) — it KEEPS the wide hands (Stage-C byte-identical; the flag-ON wide-hands narrowing is the crafted case below). `agent` joined this set at #96: it is standing/thread-only, so native withholds it too.",
);

firesWith(
  checkWindowGateManifest(
    [{ name: "delegation_tools", source: 'export default windowGatedKit("delegation_tools", {\n  agent: defineTool(x),\n});' }],
    new Map([["agent", SENTINEL], ["delegation_tools", 'export { default } from "@open-everywhere/core/agent/tools/delegation_tools.js";']]),
    ["agent"],
    g({ agent: ["standing"] }),
    u("delegation_tools"),
  ),
  'WINDOW_GATED_TOOLS["agent"] must be exactly ["standing", "thread"]',
  "agent gated to the wrong grain FAILS (a task-leaf delegation is a recursion hole)",
);
firesWith(
  checkWindowGateManifest(
    [{ name: "delegation_tools", source: 'export default windowGatedKit("delegation_tools", {\n  agent: defineTool(x),\n});' }],
    new Map([["agent", "export default someOtherThing();"], ["delegation_tools", 'export { default } from "@open-everywhere/core/agent/tools/delegation_tools.js";']]),
    ["agent"],
    g({ agent: ["standing", "thread"] }),
    u("delegation_tools"),
  ),
  "is not a `disableTool()` sentinel",
  "agent whose app shim is NOT a disableTool() sentinel FAILS (eve's built-in recursive subagent stays mounted and wins the name — the 2026-07-16 credential-broken path)",
);
{
  const problems = checkWindowGateManifest(
    [{ name: "delegation_tools", source: 'export default windowGatedKit("delegation_tools", {\n  agent: defineTool(x),\n});' }],
    new Map([["agent", SENTINEL], ["delegation_tools", 'export { default } from "@open-everywhere/core/agent/tools/delegation_tools.js";']]),
    ["agent"],
    g({ agent: ["standing", "thread"] }),
    u("delegation_tools"),
  );
  ok(problems.length === 0, `agent gated [standing,thread] + kit + sentinel is clean (the #96 post-fix shape) (got: ${JSON.stringify(problems)})`);
}

firesWith(
  checkWindowGateManifest([{ name: "spawn_thread_session", source: wrapped("spawn_thread_session") }], new Map([["spawn_thread_session", ""]]), [], g({ spawn_thread_session: ["thread"] }), u()),
  'spawn_thread_session"] must be exactly ["standing"]',
  "spawn_thread_session on a non-standing grain FAILS (window-only spawner; a thread seat must not recurse)",
);
firesWith(
  checkWindowGateManifest([{ name: "complete_thread", source: wrapped("complete_thread") }], new Map([["complete_thread", ""]]), [], g({ complete_thread: ["standing"] }), u()),
  'complete_thread"] must be exactly ["thread"]',
  "complete_thread leaking off the thread grain FAILS",
);

for (const badGrain of [["task", "native"], ["standing", "task"], ["task", "thread"], ["native"]] as WindowGrain[][]) {
  firesWith(
    checkWindowGateManifest([{ name: "open_pull_request", source: wrapped("open_pull_request") }], new Map([["open_pull_request", ""]]), [], g({ open_pull_request: badGrain }), u(), ["task"]),
    'must be exactly ["task"]',
    `flag-ON: a wide-hands tool on grain [${badGrain.join(",")}] FAILS (no wide hands on any conversational-root grain — standing/native/thread)`,
  );
}
{
  const clean = checkWindowGateManifest([{ name: "open_pull_request", source: wrapped("open_pull_request") }], new Map([["open_pull_request", ""]]), [], g({ open_pull_request: ["task"] }), u(), ["task"]);
  ok(clean.length === 0, "flag-ON: a wide-hands tool on EXACTLY [task] (the one-shot worker) is clean — task is the one root grain permitted wide hands");
}

for (const name of Object.keys(WINDOW_GATED_TOOLS)) {
  ok(!WINDOW_UNGATED_TOOLS.has(name), `"${name}" is not double-declared`);
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const coreDir = join(here, "../agent/tools");
  const appDir = join(here, "../../../agent/tools");
  const coreTools: WindowToolSource[] = readdirSync(coreDir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => ({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(coreDir, f), "utf8") }));
  const appShims = new Map<string, string>();
  for (const f of readdirSync(appDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
    appShims.set(f.replace(/\.ts$/u, ""), readFileSync(join(appDir, f), "utf8"));
  }
  const subagentDir = join(here, "../../../agent/subagents");
  const subagentNames = existsSync(subagentDir)
    ? readdirSync(subagentDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  const problems = checkWindowGateManifest(coreTools, appShims, FRAMEWORK_TOOL_NAMES, undefined, undefined, undefined, subagentNames);
  ok(problems.length === 0, `the REAL tool surface carries a clean, total window-gate manifest (problems: ${JSON.stringify(problems)})`);
  ok(coreTools.length >= 37, `the real scan actually covered the core tools dir (saw ${coreTools.length})`);
  ok(appShims.size >= 40, `the real scan covered the deploy shims (saw ${appShims.size})`);
  ok(FRAMEWORK_TOOL_NAMES.length >= 10, `the eve framework enumeration is populated (saw ${FRAMEWORK_TOOL_NAMES.length})`);
}

console.log(`✓ ${n} window-gate-manifest assertions passed`);
