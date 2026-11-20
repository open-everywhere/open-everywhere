// proves: AP-MOD-core-access-window-gate-manifest, AP-WG-agent, AP-WG-bash, AP-WG-checkout_repo
// proves: AP-WG-complete_thread, AP-WG-create_skill, AP-WG-delete_skill, AP-WG-glob, AP-WG-grep
// proves: AP-WG-message_thread_seat, AP-WG-open_pull_request, AP-WG-post_file, AP-WG-read_file
// proves: AP-WG-read_thread_seat, AP-WG-spawn_thread_session, AP-WG-web_fetch, AP-WG-write_file
// proves: AP-WG-edit_file
// proves: AP-WGU-add_label, AP-WGU-add_routine_rule, AP-WGU-agent_version, AP-WGU-ask_question, AP-WGU-assign
// proves: AP-WGU-aws, AP-WGU-browser_tools, AP-WGU-cancel_routine, AP-WGU-capture_events
// proves: AP-WGU-check_pr_status, AP-WGU-clear_connector_override, AP-WGU-clear_spend_limit
// proves: AP-WGU-complete_job, AP-WGU-confirm_link, AP-WGU-eve__search, AP-WGU-connector
// proves: AP-WGU-create_agent, AP-WGU-create_routine, AP-WGU-create_ticket, AP-WGU-declare_webhook
// proves: AP-WGU-describe_image, AP-WGU-dm_person, AP-WGU-edit_reply, AP-WGU-edit_routine
// proves: AP-WGU-enable_routine, AP-WGU-explain_permission, AP-WGU-extend_workspace_time
// proves: AP-WGU-fresh_eyes_review, AP-WGU-get_pr_feedback, AP-WGU-grant_tools, AP-WGU-halt
// proves: AP-WGU-link_identity, AP-WGU-list_recent_events, AP-WGU-list_repos, AP-WGU-list_routines
// proves: AP-WGU-list_skills, AP-WGU-list_webhooks, AP-WGU-eve__skill, AP-WGU-memory_admin_list
// proves: AP-WGU-memory_admin_read, AP-WGU-no_reply, AP-WGU-notion_search, AP-WGU-permission_fit_report
// proves: AP-WGU-post_message, AP-WGU-post_pr_walkthrough, AP-WGU-purge_memory, AP-WGU-query_analytics
// proves: AP-WGU-react, AP-WGU-read_channel, AP-WGU-read_docs, AP-WGU-read_file_upload
// proves: AP-WGU-read_linear_issue, AP-WGU-read_notion_comments, AP-WGU-read_notion_page
// proves: AP-WGU-read_routine_transcript, AP-WGU-read_thread, AP-WGU-read_webhook_history
// proves: AP-WGU-read_work_channel, AP-WGU-read_work_thread, AP-WGU-record_follow_up, AP-WGU-record_job_state
// proves: AP-WGU-record_watch_state, AP-WGU-remove_routine_rule, AP-WGU-reply, AP-WGU-report_run_failed
// proves: AP-WGU-request_access, AP-WGU-request_credential_grant, AP-WGU-resume, AP-WGU-revoke_connector
// proves: AP-WGU-revoke_credential_grant, AP-WGU-revoke_routine_permissions, AP-WGU-rotate_webhook
// proves: AP-WGU-run_routine_now, AP-WGU-sandbox_tools, AP-WGU-search, AP-WGU-session_cost
// proves: AP-WGU-set_dm_delivery, AP-WGU-set_spend_limit, AP-WGU-set_state, AP-WGU-spend_report
// proves: AP-WGU-eve__tool, AP-WGU-eve__reply, AP-WGU-stand_down, AP-WGU-subscribe_pr
// proves: AP-WGU-eve__task_cancel, AP-WGU-eve__task_wait, AP-WGU-unlink_identity
// proves: AP-WGU-update_status, AP-WGU-usage_report, AP-WGU-walk_pr, AP-WGU-web_search
// proves: AP-WGU-read_github_issue, AP-WGU-notion, AP-WGU-slack-as-you

import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEveFrameworkTools } from "./eve-framework-tools.js";
import {
  checkWindowGateManifest,
  classifyFrameworkTools,
  WINDOW_GATED_TOOLS,
  WINDOW_UNGATED_TOOLS,
  fullKit,
  JOB_WAKE_TOOLS,
  withheldFromGrain,
  type FrameworkToolMount,
  type WindowToolSource,
} from "../agent/access/window-gate-manifest.js";
import type { WindowGrain } from "../agent/identity/binding.js";
import { renderMcpServerStub, renderMountedShim } from "../agent/scaffold/roster-plan.js";

const CONNECTOR_MOUNTS = ["notion", "slack-as-you"] as const;

const eveFrameworkTools = await readEveFrameworkTools();
const FRAMEWORK_TOOL_NAMES = [...eveFrameworkTools.all];
const FRAMEWORK_TOOLS = classifyFrameworkTools(FRAMEWORK_TOOL_NAMES, eveFrameworkTools.defaultMounted, eveFrameworkTools.optIn, [
  ...eveFrameworkTools.reserved,
  ...eveFrameworkTools.taskTools,
]);

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
  const problems = checkWindowGateManifest(core, shims, [], g({ open_pull_request: fullKit() }), u("reply"));
  ok(problems.length === 0, `a total, matching manifest is clean (got: ${JSON.stringify(problems)})`);
}

firesWith(
  checkWindowGateManifest([{ name: "mystery", source: "" }], new Map([["mystery", ""]]), [], g({}), u()),
  'tool "mystery" has NO window-gate posture',
  "a tool in NEITHER table FAILS (no default posture — the core Stage-E guard)",
);

firesWith(
  checkWindowGateManifest([{ name: "reply", source: "x" }], new Map([["reply", "x"]]), [], g({ reply: fullKit() }), u("reply")),
  'declared in BOTH',
  "a tool in both WINDOW_GATED_TOOLS and WINDOW_UNGATED_TOOLS FAILS",
);

firesWith(
  checkWindowGateManifest([], new Map(), [], g({ ghost: fullKit() }), u()),
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
  'must be exactly ["task"]',
  "a wide-hands tool leaking onto a STANDING seat FAILS (ambient = the ARMED shipped default since OPE-370, so fullKit() is task-only)",
);
firesWith(
  checkWindowGateManifest([{ name: "open_pull_request", source: wrapped("open_pull_request") }], new Map([["open_pull_request", ""]]), [], g({ open_pull_request: ["task"] }), u(), ["task", "native"]),
  'must be exactly ["task","native"]',
  "flag-OFF (injected): a wide-hands tool missing the native grain FAILS under the disarmed Stage-C matrix",
);
firesWith(
  checkWindowGateManifest([{ name: "spawn_thread_session", source: wrapped("spawn_thread_session") }], new Map([["spawn_thread_session", ""]]), [], g({ spawn_thread_session: ["task"] }), u()),
  'spawn_thread_session"] must be exactly ["standing"]',
  "spawn_thread_session scoped to a non-standing grain FAILS (no recursive thread trees)",
);
firesWith(
  checkWindowGateManifest([{ name: "complete_thread", source: wrapped("complete_thread") }], new Map([["complete_thread", ""]]), [], g({ complete_thread: ["standing"] }), u()),
  'complete_thread"] must be exactly ["thread"]',
  "complete_thread leaking onto a standing seat FAILS",
);

firesWith(
  checkWindowGateManifest([{ name: "post_file", source: unwrapped("post_file") }], new Map([["post_file", ""]]), [], g({ post_file: fullKit() }), u()),
  'does not wrap its export in windowGated("post_file"',
  "a gated authored tool that dropped its windowGated wrapper FAILS (silent static re-introduction)",
);
{
  const problems = checkWindowGateManifest(
    [{ name: "post_file", source: wrapped("post_file") }],
    new Map([["post_file", ""]]),
    [],
    g({ post_file: fullKit() }),
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
    g({ bash: fullKit() }),
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
    g({ web_fetch: fullKit() }),
    u("sandbox_tools"),
  ),
  'framework tool "web_fetch" is grain-gated but no windowGatedKit(...) in packages/core/agent/tools/ re-provides it per grain',
  "a framework-gated name absent from EVERY windowGatedKit FAILS (the invariant is that SOME kit provides it — the check is not pinned to sandbox_tools)",
);
{
  const problems = checkWindowGateManifest(
    [{ name: "other_tools", source: 'export default windowGatedKit("other_tools", {\n  web_fetch: defineTool(x),\n});' }],
    new Map([
      ["web_fetch", SENTINEL],
      ["other_tools", 'export { default } from "@open-everywhere/core/agent/tools/other_tools.js";'],
    ]),
    ["web_fetch"],
    g({ web_fetch: fullKit() }),
    u("other_tools"),
  );
  ok(problems.length === 0, `a framework-named tool re-provided by a NON-sandbox kit (other_tools → web_fetch) is clean (got: ${JSON.stringify(problems)})`);
}

const OPTIN_KIT = [{ name: "sandbox_tools", source: 'export default windowGatedKit("sandbox_tools", {\n  bash: defineTool(x),\n  glob: defineTool(y),\n});' }];
const KIT_SHIM = 'export { default } from "@open-everywhere/core/agent/tools/sandbox_tools.js";';
const AUTHORED = "export default defineTool({});";
const fw = (entries: Record<string, FrameworkToolMount>): ReadonlyMap<string, FrameworkToolMount> => new Map(Object.entries(entries));

firesWith(
  checkWindowGateManifest(OPTIN_KIT, new Map([["sandbox_tools", KIT_SHIM]]), fw({ bash: "default" }), g({ bash: fullKit() }), u("sandbox_tools")),
  "is not a `disableTool()` sentinel",
  "a DEFAULT-MOUNTED framework tool with NO app shim FAILS — the A6 guard is untouched for the class it was written for",
);
firesWith(
  checkWindowGateManifest(OPTIN_KIT, new Map([["bash", AUTHORED], ["sandbox_tools", KIT_SHIM]]), fw({ bash: "default" }), g({ bash: fullKit() }), u("sandbox_tools")),
  "is not a `disableTool()` sentinel",
  "a DEFAULT-MOUNTED framework tool whose shim is an authored tool FAILS",
);

firesWith(
  checkWindowGateManifest(OPTIN_KIT, new Map([["glob", AUTHORED], ["sandbox_tools", KIT_SHIM]]), fw({ glob: "opt-in" }), g({ glob: fullKit() }), u("sandbox_tools")),
  "which IS opting in",
  "an OPT-IN framework tool the app OPTS INTO (authored shim, not a sentinel) FAILS — the guard's purpose survives the loosening",
);

for (const [shims, label] of [
  [new Map([["sandbox_tools", KIT_SHIM]]), "NO app shim at all"],
  [new Map([["glob", SENTINEL], ["sandbox_tools", KIT_SHIM]]), "the (inert) disableTool() sentinel the tree ships today"],
] as const) {
  const problems = checkWindowGateManifest(OPTIN_KIT, shims, fw({ glob: "opt-in" }), g({ glob: fullKit() }), u("sandbox_tools"));
  ok(problems.length === 0, `an OPT-IN framework tool with ${label} is clean — eve mounts nothing under the name, so there is nothing to disable (got: ${JSON.stringify(problems)})`);
}

for (const [surfaceSpelling, label] of [
  [fw({ glob: "unknown" }), 'an UNCLASSIFIED ("unknown") framework tool'],
  [["glob"], "the plain-ARRAY surface spelling (no classification at all)"],
] as const) {
  firesWith(
    checkWindowGateManifest(OPTIN_KIT, new Map([["sandbox_tools", KIT_SHIM]]), surfaceSpelling, g({ glob: fullKit() }), u("sandbox_tools")),
    "is not a `disableTool()` sentinel",
    `${label} with no sentinel FAILS — the check fails CLOSED on every name it cannot prove is opt-in`,
  );
}

for (const name of ["connection_tools", "eve__task_wait"]) {
  firesWith(
    checkWindowGateManifest(OPTIN_KIT, new Map([["sandbox_tools", KIT_SHIM]]), fw({ [name]: "reserved" }), g({ [name]: fullKit() }), u("sandbox_tools")),
    "Move the row to WINDOW_UNGATED_TOOLS",
    `a RESERVED framework tool with a GATED row FAILS, and the fix it names is the row — "${name}" can carry neither a sentinel nor a kit key`,
  );
  const clean = checkWindowGateManifest(OPTIN_KIT, new Map([["sandbox_tools", KIT_SHIM]]), fw({ [name]: "reserved" }), g({}), u("sandbox_tools", name));
  ok(clean.length === 0, `…and the SAME name as an UNGATED row is clean, with no sentinel and no kit (got: ${JSON.stringify(clean)})`);
}
firesWith(
  checkWindowGateManifest(OPTIN_KIT, new Map([["sandbox_tools", KIT_SHIM]]), fw({ connection_tools: "default" }), g({ connection_tools: fullKit() }), u("sandbox_tools")),
  "is not a `disableTool()` sentinel",
  "…while the same name classified DEFAULT gets the ordinary sentinel demand — so (e) measures the class, not the spelling",
);

{
  const m = classifyFrameworkTools(["bash", "glob", "agent"], ["bash"], ["glob"]);
  ok(m.get("bash") === "default", 'classifyFrameworkTools: a name eve mounts by default classifies "default"');
  ok(m.get("glob") === "opt-in", 'classifyFrameworkTools: a name in eve\'s opt-in set classifies "opt-in"');
  ok(m.get("agent") === "unknown", 'classifyFrameworkTools: a name in NEITHER eve set classifies "unknown" (fail closed)');
  const noDefaults = classifyFrameworkTools(["bash", "glob"], undefined, ["glob"]);
  ok(
    noDefaults.get("glob") === "unknown" && noDefaults.get("bash") === "unknown",
    "classifyFrameworkTools: an eve that exports no getFrameworkToolDefinitions classifies EVERY name unknown (fail closed)",
  );
  const noOptIn = classifyFrameworkTools(["bash", "glob"], ["bash"], undefined);
  ok(
    noOptIn.get("glob") === "unknown" && noOptIn.get("bash") === "unknown",
    "classifyFrameworkTools: an eve that exports no getOptInFrameworkToolNames classifies EVERY name unknown (fail closed)",
  );
  ok(classifyFrameworkTools(["x"], ["x"], ["x"]).get("x") === "default", 'classifyFrameworkTools: a name in BOTH eve sets classifies "default" — the stricter answer');
  const withReserved = classifyFrameworkTools(["bash", "glob", "connection_tools"], ["bash", "connection_tools"], ["glob"], ["connection_tools"]);
  ok(withReserved.get("connection_tools") === "reserved", 'classifyFrameworkTools: a RESERVED name classifies "reserved" even though eve also default-mounts it');
  ok(withReserved.get("bash") === "default" && withReserved.get("glob") === "opt-in", "…and the other two classes are untouched (the negative control on the new arm)");
  const driftedReserved = classifyFrameworkTools(["bash", "connection_tools"], ["bash", "connection_tools"], undefined, ["connection_tools"]);
  ok(
    driftedReserved.get("connection_tools") === "reserved" && driftedReserved.get("bash") === "unknown",
    "classifyFrameworkTools: a drifted opt-in snapshot degrades every OTHER name to unknown and leaves a reserved name reserved — stricter where strictness is reachable, never where it is impossible",
  );
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

ok(JSON.stringify([...WINDOW_GATED_TOOLS.spawn_thread_session]) === JSON.stringify(["standing"]), "spawn_thread_session is standing-only (window-only mint; no recursive thread trees)");
ok(JSON.stringify([...WINDOW_GATED_TOOLS.complete_thread]) === JSON.stringify(["thread"]), "complete_thread is thread-only");
ok(JSON.stringify([...(WINDOW_GATED_TOOLS.agent ?? [])]) === JSON.stringify(["standing", "thread"]) && !WINDOW_UNGATED_TOOLS.has("agent"), "agent is grain-gated to standing+thread — the ADMITTED-GRAIN table hooks/lean-seat.ts reads; the gate itself is the projection seam, since the tool is eve's built-in");
ok(WINDOW_GATED_TOOLS.stop_task === undefined && WINDOW_GATED_TOOLS.return_result === undefined, "🔴 OPE-1145 item 2: the roll-own regime's two verbs carry NO manifest row — they are deleted, not merely disarmed");
ok([...fullKit()].sort().join(",") === "task", "fullKit() = task-only — the ARMED shipped default since OPE-370 (default==prod); the flag-OFF Stage-C widening to task+native is pinned by the injected crafted case above");
ok(
  withheldFromGrain("standing").includes("bash") && withheldFromGrain("standing").includes("complete_thread"),
  "a standing seat withholds the wide-hands set + complete_thread",
);
ok(
  withheldFromGrain("native").length === 22,
  `under the ARMED shipped default (OPE-370) a native seat withholds the delegation/lifecycle/coordinator set (agent/spawn_thread_session/complete_thread, since OPE-1696 read_thread_seat/message_thread_seat, and since OPE-2338 work and cancel_work), since OPE-2452 the domain question pair (ask_domain/answer_domain_question), since OPE-2426 the asked-thread verb (expect_bot_reply), AND the 12 wide-hands tools — 22 of them. The T2 narrowing is the default posture (flag-off, native regains wide hands: the Stage-C byte-identical state, exercised via the injected crafted case above). Got ${withheldFromGrain("native").length}: ${JSON.stringify(withheldFromGrain("native"))}`,
);

firesWith(
  checkWindowGateManifest([], new Map(), ["agent"], g({ agent: ["standing"] }), u()),
  'WINDOW_GATED_TOOLS["agent"] must be exactly ["standing", "thread"]',
  "agent gated to the wrong grain FAILS (a task-leaf delegation is a recursion hole)",
);

firesWith(
  checkWindowGateManifest(
    [{ name: "delegation_tools", source: 'export default windowGatedKit("delegation_tools", {\n  agent: defineTool(x),\n});' }],
    new Map([["delegation_tools", 'export { default } from "@open-everywhere/core/agent/tools/delegation_tools.js";']]),
    ["agent"],
    g({ agent: ["standing", "thread"] }),
    u("delegation_tools"),
  ),
  "is re-provided by a windowGatedKit",
  "a kit that re-provides `agent` FAILS — a dynamic tool of that name COLLIDES with the built-in and kills the model call",
);
firesWith(
  checkWindowGateManifest([], new Map([["agent", SENTINEL]]), ["agent"], g({ agent: ["standing", "thread"] }), u()),
  "is a disableTool() sentinel",
  "an `agent` disableTool() sentinel FAILS — it strips the built-in and nothing re-provides it, so every seat loses delegation entirely",
);
{
  const problems = checkWindowGateManifest([], new Map(), ["agent"], g({ agent: ["standing", "thread"] }), u());
  ok(
    problems.length === 0,
    `NEGATIVE CONTROL: agent gated [standing,thread] with NO kit and NO sentinel is clean — the shipped shape, so the two firesWith cases above read as real refusals rather than a rule that refuses everything (got: ${JSON.stringify(problems)})`,
  );
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
  const problems = checkWindowGateManifest(coreTools, appShims, FRAMEWORK_TOOLS, undefined, undefined, undefined, subagentNames);
  ok(problems.length === 0, `the REAL tool surface carries a clean, total window-gate manifest (problems: ${JSON.stringify(problems)})`);
  ok(coreTools.length >= 37, `the real scan actually covered the core tools dir (saw ${coreTools.length})`);
  ok(appShims.size >= 40, `the real scan covered the deploy shims (saw ${appShims.size})`);
  ok(FRAMEWORK_TOOL_NAMES.length >= 10, `the eve framework enumeration is populated (saw ${FRAMEWORK_TOOL_NAMES.length})`);

  for (const name of ["glob", "grep"]) {
    ok(
      FRAMEWORK_TOOLS.get(name) === "opt-in",
      `installed eve: \`${name}\` is OPT-IN (got "${FRAMEWORK_TOOLS.get(name)}") — eve mounts nothing under the name, so its roster sentinel is inert. If this fails, eve moved it back into the default set: its sentinel is load-bearing again and roster.config.ts must keep it.`,
    );
  }
  for (const name of ["bash", "read_file", "write_file", "web_fetch"]) {
    ok(
      FRAMEWORK_TOOLS.get(name) === "default",
      `installed eve: \`${name}\` is DEFAULT-MOUNTED (got "${FRAMEWORK_TOOLS.get(name)}") — its disableTool() sentinel is load-bearing`,
    );
  }
  ok(
    FRAMEWORK_TOOLS.get("agent") === "unknown",
    `installed eve: \`agent\` is in NEITHER eve mount set (got "${FRAMEWORK_TOOLS.get("agent")}") — the harness injects it on its own path, so the check fails closed and keeps demanding its sentinel`,
  );

  const shimsWithout = (...names: string[]) => new Map([...appShims].filter(([slug]) => !names.includes(slug)));
  const realArgs = [undefined, undefined, undefined, subagentNames] as const;
  const droppedOptIn = checkWindowGateManifest(coreTools, shimsWithout("glob", "grep"), FRAMEWORK_TOOLS, ...realArgs);
  ok(
    droppedOptIn.length === 0,
    `REAL surface: dropping the glob + grep sentinels raises NO problem — eve mounts neither by default, so those sentinels guard nothing (got: ${JSON.stringify(droppedOptIn)})`,
  );
  for (const name of ["bash", "read_file", "write_file", "web_fetch"]) {
    firesWith(
      checkWindowGateManifest(coreTools, shimsWithout(name), FRAMEWORK_TOOLS, ...realArgs),
      `framework tool "${name}" is grain-gated`,
      `REAL surface: dropping the ${name} sentinel still FAILS — it is default-mounted, so its built-in would re-mount on every standing seat`,
    );
  }
  firesWith(
    checkWindowGateManifest(coreTools, new Map([...appShims, ["glob", "export default defineTool({});"]]), FRAMEWORK_TOOLS, ...realArgs),
    "which IS opting in",
    "REAL surface: replacing the glob sentinel with an authored tool FAILS — that IS the opt-in, and an authored tool of a framework name mounts on every grain",
  );

  const stale = checkWindowGateManifest(
    coreTools,
    appShims,
    FRAMEWORK_TOOLS,
    WINDOW_GATED_TOOLS,
    WINDOW_UNGATED_TOOLS,
    fullKit(),
    subagentNames,
    new Set([...JOB_WAKE_TOOLS, "ghost_job_verb"]),
  );
  firesWith(stale, 'JOB_WAKE_TOOLS names "ghost_job_verb"', "a stale JOB_WAKE_TOOLS row FAILS (rule 6)");
  const cleanKit = checkWindowGateManifest(coreTools, appShims, FRAMEWORK_TOOLS, WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, fullKit(), subagentNames, JOB_WAKE_TOOLS);
  ok(cleanKit.length === 0, `the REAL job kit is clean against the real surface (problems: ${JSON.stringify(cleanKit)})`);

  for (const name of CONNECTOR_MOUNTS) {
    const shim = appShims.get(name);
    ok(
      shim !== undefined && /\bseatCut\(/u.test(shim),
      `REAL surface: the generated connector mount agent/tools/${name}.ts exists and passes through seatCut (so the posture rows below are not vacuous)`,
    );
    ok(
      WINDOW_UNGATED_TOOLS.has(name) && !Object.prototype.hasOwnProperty.call(WINDOW_GATED_TOOLS, name),
      `connector mount "${name}" is WINDOW-UNGATED, as eve__tool and eve__search are: the seat cut decides per op, the connector grant per connection, not the window grain`,
    );
    firesWith(
      checkWindowGateManifest(coreTools, appShims, FRAMEWORK_TOOLS, WINDOW_GATED_TOOLS, new Set([...WINDOW_UNGATED_TOOLS].filter((n) => n !== name)), fullKit(), subagentNames),
      `tool "${name}" has NO window-gate posture`,
      `REAL surface: connector mount "${name}" with its WINDOW_UNGATED_TOOLS row removed FAILS (no default posture)`,
    );
  }

  for (const [label, slug, shim] of [
    ["a roster tool/<name> connector mount", "later_mount", renderMountedShim("@open-everywhere/core/agent/connections/later_mount.js", undefined, "later_mount")],
    ["a declared MCP server", "later-mcp", renderMcpServerStub("later-mcp")],
  ] as const) {
    firesWith(
      checkWindowGateManifest(coreTools, new Map([...appShims, [slug, shim]]), FRAMEWORK_TOOLS, ...realArgs),
      `tool "${slug}" has NO window-gate posture`,
      `REAL surface: a later generated mount from ${label} FAILS until its posture is declared`,
    );
    const declared = checkWindowGateManifest(
      coreTools,
      new Map([...appShims, [slug, shim]]),
      FRAMEWORK_TOOLS,
      WINDOW_GATED_TOOLS,
      new Set([...WINDOW_UNGATED_TOOLS, slug]),
      fullKit(),
      subagentNames,
    );
    ok(
      declared.length === 0,
      `REAL surface: the same later mount from ${label} is clean once its WINDOW_UNGATED_TOOLS row exists (problems: ${JSON.stringify(declared)})`,
    );
  }
}

console.log(`✓ ${n} window-gate-manifest assertions passed`);

// proves: ROSTER-lint-window-gate, SEAT-grain-gate, SEAT-root-grain-ban, SEAT-ungated, SEAT-wide-hands
// proves: TOOL-sandbox_tools
