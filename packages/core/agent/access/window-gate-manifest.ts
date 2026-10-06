import type { WindowGrain } from "../identity/binding.js";
import { oneshotAgentEnabled } from "./delegation-flag.js";

const WIDE_HANDS_ARMED: readonly WindowGrain[] = Object.freeze(["task"] as const);
const WIDE_HANDS_DISARMED: readonly WindowGrain[] = Object.freeze(["task", "native"] as const);

export function fullKit(): readonly WindowGrain[] {
  return oneshotAgentEnabled() ? WIDE_HANDS_ARMED : WIDE_HANDS_DISARMED;
}

export const CONVERSATIONAL_ROOT_GRAINS = ["standing", "native", "thread"] as const;

export const WINDOW_GATED_TOOLS: Readonly<Record<string, readonly WindowGrain[]>> = {
  get bash() { return fullKit(); },
  get glob() { return fullKit(); },
  get grep() { return fullKit(); },
  get read_file() { return fullKit(); },
  get write_file() { return fullKit(); },
  get web_fetch() { return fullKit(); },
  get checkout_repo() { return fullKit(); },
  get open_pull_request() { return fullKit(); },
  get post_file() { return fullKit(); },
  get create_skill() { return fullKit(); },
  get delete_skill() { return fullKit(); },
  agent: ["standing", "thread"],
  work: ["standing", "thread"],
  cancel_work: ["standing", "thread"],
  spawn_thread_session: ["standing"],
  complete_thread: ["thread"],
  read_thread_seat: ["standing"],
  message_thread_seat: ["standing"],
};

export const WINDOW_UNGATED_TOOLS: ReadonlySet<string> = new Set([
  "reply",
  "edit_reply",
  "no_reply",
  "react",
  "update_status",
  "stand_down",
  "halt",
  "resume",
  "check_pr_status",
  "get_pr_feedback",
  "read_github_issue",
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
  "notion_search",
  "read_linear_issue",
  "set_state",
  "assign",
  "add_label",
  "create_ticket",
  "post_message",
  "dm_person",
  "set_dm_delivery",
  "search",
  "aws",
  "read_channel",
  "read_thread",
  "read_work_channel",
  "read_work_thread",
  "session_cost",
  "agent_version",
  "spend_report",
  "usage_report",
  "query_analytics",
  "purge_memory",
  "link_identity",
  "confirm_link",
  "unlink_identity",
  "revoke_credential_grant",
  "request_access",
  "request_credential_grant",
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
  "record_follow_up",
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
  "browser_tools",
  "grant_tools",
  "web_search",
  "ask_question",
  "ask_room",
  "load_skill",
  "connection_tools",
  "connection_search",
  "connection_execute",
  "task_cancel",
  "task_wait",
  "fresh_eyes_review",
]);

export function withheldFromGrain(grain: WindowGrain): string[] {
  return Object.keys(WINDOW_GATED_TOOLS).filter((name) => !WINDOW_GATED_TOOLS[name].includes(grain));
}

export type MemoryRecallRoute = "file-tools" | "agent" | "none";

export function memoryRecallRouteFor(
  grain: WindowGrain,
  wideHandsGrains: readonly WindowGrain[] = fullKit(),
  armed: boolean = oneshotAgentEnabled(),
  canDelegate: boolean = true,
): MemoryRecallRoute {
  if (wideHandsGrains.includes(grain)) return "file-tools";
  if (!canDelegate || !armed) return "none";
  return WINDOW_GATED_TOOLS.agent.includes(grain) ? "agent" : "none";
}

export const JOB_WAKE_TOOLS: ReadonlySet<string> = new Set([
  "reply",
  "edit_reply",
  "no_reply",
  "react",
  "update_status",
  "record_job_state",
  "complete_job",
  "record_watch_state",
  "record_follow_up",
  "report_run_failed",
  "read_channel",
  "read_thread",
  "read_notion_page",
  "read_notion_comments",
  "read_linear_issue",
  "read_file_upload",
  "describe_image",
  "check_pr_status",
  "get_pr_feedback",
  "read_github_issue",
  "list_repos",
  "list_routines",
  "list_skills",
  "list_webhooks",
  "session_cost",
  "spend_report",
  "usage_report",
  "query_analytics",
  "permission_fit_report",
  "agent_version",
  "load_skill",
]);

export function withheldFromJobWake(
  gated: Readonly<Record<string, readonly WindowGrain[]>> = WINDOW_GATED_TOOLS,
  ungated: ReadonlySet<string> = WINDOW_UNGATED_TOOLS,
  jobKit: ReadonlySet<string> = JOB_WAKE_TOOLS,
  harnessInternal: ReadonlySet<string> = new Set(),
): string[] {
  return [...new Set([...Object.keys(gated), ...ungated])].filter((name) => !jobKit.has(name) && !harnessInternal.has(name)).sort();
}

export interface WindowToolSource {
  readonly name: string;
  readonly source: string;
}

export type FrameworkToolMount = "default" | "opt-in" | "reserved" | "unknown";

export function classifyFrameworkTools(
  allNames: Iterable<string>,
  defaultMountedNames: Iterable<string> | undefined,
  optInNames: Iterable<string> | undefined,
  reservedNames: Iterable<string> = [],
): Map<string, FrameworkToolMount> {
  const out = new Map<string, FrameworkToolMount>();
  const reserved = new Set(reservedNames);
  if (defaultMountedNames === undefined || optInNames === undefined) {
    for (const name of allNames) out.set(name, reserved.has(name) ? "reserved" : "unknown");
    return out;
  }
  const mountedByDefault = new Set(defaultMountedNames);
  const optIn = new Set(optInNames);
  for (const name of allNames) {
    out.set(name, reserved.has(name) ? "reserved" : mountedByDefault.has(name) ? "default" : optIn.has(name) ? "opt-in" : "unknown");
  }
  return out;
}

const grainKey = (grains: readonly WindowGrain[]): string => [...grains].sort().join(",");
const grainList = (grains: readonly WindowGrain[]): string => grains.map((g) => `"${g}"`).join(",");

export function checkWindowGateManifest(
  coreTools: readonly WindowToolSource[],
  appShims: ReadonlyMap<string, string>,
  frameworkTools: readonly string[] | ReadonlyMap<string, FrameworkToolMount>,
  gated: Readonly<Record<string, readonly WindowGrain[]>> = WINDOW_GATED_TOOLS,
  ungated: ReadonlySet<string> = WINDOW_UNGATED_TOOLS,
  wideHandsGrains: readonly WindowGrain[] = fullKit(),
  subagentNames: readonly string[] = [],
  jobKit: ReadonlySet<string> = JOB_WAKE_TOOLS,
): string[] {
  const WIDE_HANDS_KEY = grainKey(wideHandsGrains);
  const problems: string[] = [];
  const coreByName = new Map(coreTools.map((t) => [t.name, t.source] as const));
  const frameworkMount = frameworkTools instanceof Map ? (frameworkTools as ReadonlyMap<string, FrameworkToolMount>) : undefined;
  const frameworkToolNames: readonly string[] = frameworkMount ? [...frameworkMount.keys()] : (frameworkTools as readonly string[]);
  const mountOf = (name: string): FrameworkToolMount => frameworkMount?.get(name) ?? "unknown";
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
    if (name === "spawn_thread_session") {
      if (grainKey(grains) !== "standing") {
        problems.push(`WINDOW_GATED_TOOLS["${name}"] must be exactly ["standing"] (a window-only spawner: no recursive spawn from a task/native/thread seat) — got [${grains.join(", ")}]`);
      }
    } else if (name === "agent") {
      if (grainKey(grains) !== grainKey(["standing", "thread"])) {
        problems.push(`WINDOW_GATED_TOOLS["agent"] must be exactly ["standing", "thread"] (the conversational-root seats delegate; NEVER task — a worker leaf holds the wide hands already and must not spawn recursively) — got [${grains.join(", ")}]`);
      }
    } else if (name === "cancel_work") {
      if (grainKey(grains) !== grainKey(["standing", "thread"])) {
        problems.push(`WINDOW_GATED_TOOLS["cancel_work"] must be exactly ["standing", "thread"] (the conversation seat that forwarded a job stops it; never a worker leaf) — got [${grains.join(", ")}]`);
      }
    } else if (name === "work") {
      if (grainKey(grains) !== grainKey(["standing", "thread"])) {
        problems.push(`WINDOW_GATED_TOOLS["work"] must be exactly ["standing", "thread"] (a conversation seat forwards to its own work session; never a worker leaf) — got [${grains.join(", ")}]`);
      }
    } else if (name === "complete_thread") {
      if (grainKey(grains) !== "thread") {
        problems.push(`WINDOW_GATED_TOOLS["complete_thread"] must be exactly ["thread"] (only a thread seat owns a thread) — got [${grains.join(", ")}]`);
      }
    } else if (name === "read_thread_seat" || name === "message_thread_seat") {
      if (grainKey(grains) !== "standing") {
        problems.push(`WINDOW_GATED_TOOLS["${name}"] must be exactly ["standing"] (the coordinator verbs: the seat that OPENED a thread reads and steers it; never a thread seat's sibling reach, never a worker) — got [${grains.join(", ")}]`);
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
      const shim = appShims.get(name);
      const isSentinel = shim !== undefined && /\bdisableTool\s*\(\s*\)/.test(shim);
      if (mountOf(name) === "reserved") {
        problems.push(
          `framework tool "${name}" is in WINDOW_GATED_TOOLS, but the installed eve RESERVES the name: it throws on any authored module at that slot and provides the tool itself at runtime. So neither half of the gate exists — a \`disableTool()\` sentinel fails \`eve build\` and a windowGatedKit(...) key collides with eve's own provision. Move the row to WINDOW_UNGATED_TOOLS; its real gate is eve's own (a connector tool mounts only while the agent has connections, a task verb only while the toolset offers a task-starting tool).`,
        );
      } else if (name === "agent") {
        if (kitKeyProviders.has(name)) {
          problems.push(
            `"agent" is re-provided by a windowGatedKit(...) — it must NOT be: eve's built-in \`agent\` is this deployment's delegation route, and a dynamic tool of that name COLLIDES with it (eve harness/tool-loop.js throws and kills the model call). Delete the kit key; the gate is access/untrusted-projection.ts.`,
          );
        }
        if (isSentinel) {
          problems.push(
            `agent/tools/agent.ts is a disableTool() sentinel — it must NOT be: the sentinel removes eve's built-in \`agent\`, and since OPE-1145 item 2 nothing re-provides it, so every seat would lose delegation entirely. Roster artefacts are stale; run \`oe build --accept\`.`,
          );
        }
      } else {
        if (!kitKeyProviders.has(name)) {
          problems.push(
            `framework tool "${name}" is grain-gated but no windowGatedKit(...) in packages/core/agent/tools/ re-provides it per grain — add it as a key to a kit resolver (e.g. sandbox_tools.ts for the sandbox/egress names), or the tool is simply absent on every grain`,
          );
        }
        if (mountOf(name) === "opt-in") {
          if (shim !== undefined && !isSentinel) {
            problems.push(
              `framework tool "${name}" is grain-gated, and the installed eve mounts it only when the app OPTS IN — but its app shim agent/tools/${name}.ts is an authored tool rather than a \`disableTool()\` sentinel, which IS opting in. An authored tool of a framework name mounts on EVERY session incl. standing seats, silently bypassing the grain gate; make the shim a \`disableTool()\` sentinel and let the windowGatedKit(...) resolver provide it per grain.`,
            );
          }
        } else if (!isSentinel) {
          problems.push(
            `framework tool "${name}" is grain-gated but its app shim agent/tools/${name}.ts is not a \`disableTool()\` sentinel — without it eve's built-in of that name stays mounted on EVERY session incl. standing seats, silently bypassing the grain gate`,
          );
        }
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
