import type { WindowGrain } from "../identity/binding.js";
import { oneshotAgentEnabled } from "./delegation-flag.js";

export const FULL_KIT: readonly WindowGrain[] = oneshotAgentEnabled() ? (["task"] as const) : (["task", "native"] as const);

export const CONVERSATIONAL_ROOT_GRAINS = ["standing", "native", "thread"] as const;

export const WINDOW_GATED_TOOLS: Readonly<Record<string, readonly WindowGrain[]>> = {
  bash: FULL_KIT,
  glob: FULL_KIT,
  grep: FULL_KIT,
  read_file: FULL_KIT,
  write_file: FULL_KIT,
  web_fetch: FULL_KIT,
  checkout_repo: FULL_KIT,
  open_pull_request: FULL_KIT,
  post_file: FULL_KIT,
  create_skill: FULL_KIT,
  delete_skill: FULL_KIT,
  agent: ["standing", "thread"],
  spawn_task: ["standing"],
  spawn_thread_session: ["standing"],
  complete_task: ["task"],
  complete_thread: ["thread"],
  return_result: ["task"],
};

export const WINDOW_UNGATED_TOOLS: ReadonlySet<string> = new Set([
  "reply",
  "no_reply",
  "react",
  "update_status",
  "check_pr_status",
  "get_pr_feedback",
  "walk_pr",
  "post_pr_walkthrough",
  "describe_image",
  "list_repos",
  "list_routines",
  "read_routine_transcript",
  "list_skills",
  "explain_permission",
  "permission_fit_report",
  "list_webhooks",
  "read_webhook_history",
  "capture_events",
  "list_recent_events",
  "rotate_webhook",
  "declare_webhook",
  "read_docs",
  "read_file_upload",
  "read_notion_page",
  "read_notion_comments",
  "read_linear_issue",
  "set_state",
  "assign",
  "add_label",
  "create_ticket",
  "aws",
  "read_channel",
  "read_thread",
  "read_slack_channel",
  "read_slack_thread",
  "session_cost",
  "spend_report",
  "usage_report",
  "query_analytics",
  "remember",
  "forget",
  "link_identity",
  "confirm_link",
  "unlink_identity",
  "request_access",
  "create_agent",
  "connector",
  "cancel_routine",
  "create_routine",
  "edit_routine",
  "enable_routine",
  "run_routine_now",
  "add_routine_rule",
  "remove_routine_rule",
  "revoke_routine_permissions",
  "record_watch_state",
  "report_run_failed",
  "record_job_state",
  "complete_job",
  "subscribe_pr",
  "extend_workspace_time",
  "set_spend_limit",
  "clear_spend_limit",
  "revoke_connector",
  "clear_connector_override",
  "memory_admin_list",
  "memory_admin_read",
  "sandbox_tools",
  "delegation_tools",
  "browser_tools",
  "web_search",
  "ask_question",
  "todo",
  "load_skill",
  "connection_search",
  "fresh_eyes_review",
]);

export function withheldFromGrain(grain: WindowGrain): string[] {
  return Object.keys(WINDOW_GATED_TOOLS).filter((name) => !WINDOW_GATED_TOOLS[name].includes(grain));
}

export type MemoryRecallRoute = "file-tools" | "agent" | "spawn_task" | "none";

export function memoryRecallRouteFor(
  grain: WindowGrain,
  wideHandsGrains: readonly WindowGrain[] = FULL_KIT,
  armed: boolean = oneshotAgentEnabled(),
  canDelegate: boolean = true,
): MemoryRecallRoute {
  if (wideHandsGrains.includes(grain)) return "file-tools";
  if (!canDelegate) return "none";
  const delegator = armed ? "agent" : "spawn_task";
  return WINDOW_GATED_TOOLS[delegator].includes(grain) ? delegator : "none";
}

export const JOB_WAKE_TOOLS: ReadonlySet<string> = new Set([
  "reply",
  "no_reply",
  "react",
  "update_status",
  "record_job_state",
  "complete_job",
  "record_watch_state",
  "report_run_failed",
  "read_channel",
  "read_thread",
  "read_slack_channel",
  "read_slack_thread",
  "read_notion_page",
  "read_notion_comments",
  "read_linear_issue",
  "read_file_upload",
  "describe_image",
  "check_pr_status",
  "get_pr_feedback",
  "list_repos",
  "list_routines",
  "list_skills",
  "list_webhooks",
  "session_cost",
  "spend_report",
  "usage_report",
  "query_analytics",
  "permission_fit_report",
  "todo",
  "load_skill",
]);

export function withheldFromJobWake(
  gated: Readonly<Record<string, readonly WindowGrain[]>> = WINDOW_GATED_TOOLS,
  ungated: ReadonlySet<string> = WINDOW_UNGATED_TOOLS,
  jobKit: ReadonlySet<string> = JOB_WAKE_TOOLS,
): string[] {
  return [...new Set([...Object.keys(gated), ...ungated])].filter((name) => !jobKit.has(name)).sort();
}

export interface WindowToolSource {
  readonly name: string;
  readonly source: string;
}

const grainKey = (grains: readonly WindowGrain[]): string => [...grains].sort().join(",");
const grainList = (grains: readonly WindowGrain[]): string => grains.map((g) => `"${g}"`).join(",");

export function checkWindowGateManifest(
  coreTools: readonly WindowToolSource[],
  appShims: ReadonlyMap<string, string>,
  frameworkToolNames: readonly string[],
  gated: Readonly<Record<string, readonly WindowGrain[]>> = WINDOW_GATED_TOOLS,
  ungated: ReadonlySet<string> = WINDOW_UNGATED_TOOLS,
  wideHandsGrains: readonly WindowGrain[] = FULL_KIT,
  subagentNames: readonly string[] = [],
  jobKit: ReadonlySet<string> = JOB_WAKE_TOOLS,
): string[] {
  const WIDE_HANDS_KEY = grainKey(wideHandsGrains);
  const problems: string[] = [];
  const coreByName = new Map(coreTools.map((t) => [t.name, t.source] as const));
  const surface = new Set<string>([...coreByName.keys(), ...appShims.keys(), ...frameworkToolNames, ...subagentNames]);

  const kitKeyProviders = new Map<string, string>();
  for (const [slug, src] of coreByName) {
    if (!/windowGatedKit\s*\(/.test(src)) continue;
    for (const m of src.matchAll(/\n\s+([a-z_][\w]*)\s*:/gu)) kitKeyProviders.set(m[1], slug);
  }

  for (const name of surface) {
    const inGated = Object.prototype.hasOwnProperty.call(gated, name);
    const inUngated = ungated.has(name);
    if (inGated && inUngated) {
      problems.push(
        `tool "${name}" is declared in BOTH WINDOW_GATED_TOOLS and WINDOW_UNGATED_TOOLS — a tool has exactly ONE window-gate posture; remove one (access/window-gate-manifest.ts)`,
      );
    } else if (!inGated && !inUngated) {
      problems.push(
        `tool "${name}" has NO window-gate posture — declare it in access/window-gate-manifest.ts: add a grain matrix to WINDOW_GATED_TOOLS if it is a wide-hands (sandbox/egress/audience) or delegation tool, OR add its name to WINDOW_UNGATED_TOOLS if it is an always-available conversational/read verb. There is deliberately no default — a new tool must state its posture or it lands wide-open on standing seats.`,
      );
    }
  }

  for (const name of Object.keys(gated)) {
    if (!surface.has(name)) {
      problems.push(
        `WINDOW_GATED_TOOLS names "${name}" which is neither a tool file (packages/core/agent/tools ∪ agent/tools) nor a mounted framework tool — remove the row or fix the name (a stale row hides a real gap)`,
      );
    }
  }
  for (const name of ungated) {
    if (!surface.has(name)) {
      problems.push(`WINDOW_UNGATED_TOOLS names "${name}" which is neither a tool file nor a mounted framework tool — remove it or fix the name`);
    }
  }

  for (const [name, grains] of Object.entries(gated)) {
    if (name === "spawn_task" || name === "spawn_thread_session") {
      if (grainKey(grains) !== "standing") {
        problems.push(`WINDOW_GATED_TOOLS["${name}"] must be exactly ["standing"] (a window-only spawner: no recursive spawn from a task/native/thread seat) — got [${grains.join(", ")}]`);
      }
    } else if (name === "agent") {
      if (grainKey(grains) !== grainKey(["standing", "thread"])) {
        problems.push(`WINDOW_GATED_TOOLS["agent"] must be exactly ["standing", "thread"] (the conversational-root seats delegate; NEVER task — a worker leaf holds the wide hands already and must not spawn recursively) — got [${grains.join(", ")}]`);
      }
    } else if (name === "complete_task") {
      if (grainKey(grains) !== "task") {
        problems.push(`WINDOW_GATED_TOOLS["complete_task"] must be exactly ["task"] (only a task worker owns a thread) — got [${grains.join(", ")}]`);
      }
    } else if (name === "complete_thread") {
      if (grainKey(grains) !== "thread") {
        problems.push(`WINDOW_GATED_TOOLS["complete_thread"] must be exactly ["thread"] (only a thread seat owns a thread) — got [${grains.join(", ")}]`);
      }
    } else if (name === "return_result") {
      if (grainKey(grains) !== "task") {
        problems.push(`WINDOW_GATED_TOOLS["return_result"] must be exactly ["task"] (only a one-shot task returns a result) — got [${grains.join(", ")}]`);
      }
    } else if (grainKey(grains) !== WIDE_HANDS_KEY) {
      problems.push(
        `WINDOW_GATED_TOOLS["${name}"] is a wide-hands tool and must be exactly [${grainList(wideHandsGrains)}] (the worker grain(s); withheld from every CONVERSATIONAL-ROOT seat — standing/native/thread) — got [${grains.join(", ")}]; mounting it on any conversational-root grain would give a talking seat heavy hands`,
      );
    }
  }

  const subagentSet = new Set(subagentNames);
  for (const name of Object.keys(gated)) {
    if (subagentSet.has(name)) continue;
    const coreSrc = coreByName.get(name);
    if (coreSrc === undefined) {
      if (!kitKeyProviders.has(name)) {
        problems.push(
          `framework tool "${name}" is grain-gated but no windowGatedKit(...) in packages/core/agent/tools/ re-provides it per grain — add it as a key to a kit resolver (e.g. sandbox_tools.ts for the sandbox/egress names, delegation_tools.ts for the delegation ones), or the tool is simply absent on every grain`,
        );
      }
      const shim = appShims.get(name);
      if (shim === undefined || !/\bdisableTool\s*\(\s*\)/.test(shim)) {
        problems.push(
          `framework tool "${name}" is grain-gated but its app shim agent/tools/${name}.ts is not a \`disableTool()\` sentinel — without it eve's built-in of that name stays mounted on EVERY session incl. standing seats, silently bypassing the grain gate (for \`agent\` specifically: eve's harness injects its built-in recursive subagent unless disabledFrameworkTools carries the name, and that built-in is the credential-broken path live-hit on 2026-07-16)`,
        );
      }
    } else if (!new RegExp(`windowGated\\(\\s*"${name}"`).test(coreSrc)) {
      problems.push(
        `gated tool "${name}" does not wrap its export in windowGated("${name}", …) — packages/core/agent/tools/${name}.ts must \`export default windowGated("${name}", defineTool({…}))\` or the wide-hands tool mounts statically on standing seats (silent static re-introduction). If it should no longer be gated, move it to WINDOW_UNGATED_TOOLS.`,
      );
    }
  }

  for (const name of coreByName.keys()) {
    if (!appShims.has(name)) {
      problems.push(
        `core tool packages/core/agent/tools/${name}.ts has NO deploy shim agent/tools/${name}.ts — it will not be mounted in the deployed app; add \`export { default } from "@open-everywhere/core/agent/tools/${name}.js"\``,
      );
    }
  }
  for (const [slug, src] of appShims) {
    const m = src.match(/@open-everywhere\/core\/agent\/tools\/([\w-]+)\.js/u);
    if (m && !coreByName.has(m[1])) {
      problems.push(`agent/tools/${slug}.ts re-exports @open-everywhere/core/agent/tools/${m[1]}.js but no such core tool file exists (dangling shim)`);
    }
  }

  if (gated === WINDOW_GATED_TOOLS && ungated === WINDOW_UNGATED_TOOLS) {
    for (const name of jobKit) {
      if (!surface.has(name)) {
        problems.push(
          `JOB_WAKE_TOOLS names "${name}" which is neither a tool file nor a mounted framework tool — remove it or fix the name (a stale job-kit row misrepresents what an un-escalated durable-job wake can do)`,
        );
      }
    }
  }

  return problems;
}
