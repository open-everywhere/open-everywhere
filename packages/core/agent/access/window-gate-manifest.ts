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
  browser_qa: FULL_KIT,
  create_skill: FULL_KIT,
  delete_skill: FULL_KIT,
  spawn_task: ["standing"],
  spawn_thread_session: ["standing"],
  complete_task: ["task"],
  complete_thread: ["thread"],
  return_result: ["task"],
  agent: ["standing", "thread"],
};

export const WINDOW_UNGATED_TOOLS: ReadonlySet<string> = new Set([
  "reply",
  "no_reply",
  "react",
  "update_status",
  "check_pr_status",
  "describe_image",
  "list_repos",
  "list_routines",
  "list_skills",
  "read_notion_page",
  "read_channel",
  "read_thread",
  "read_slack_channel",
  "read_slack_thread",
  "session_cost",
  "spend_report",
  "usage_report",
  "remember",
  "forget",
  "request_access",
  "cancel_routine",
  "create_routine",
  "record_watch_state",
  "subscribe_pr",
  "extend_workspace_time",
  "set_spend_limit",
  "clear_spend_limit",
  "revoke_connector",
  "clear_connector_override",
  "memory_admin_list",
  "memory_admin_read",
  "sandbox_tools",
  "web_search",
  "ask_question",
  "todo",
  "load_skill",
  "connection_search",
]);

export function withheldFromGrain(grain: WindowGrain): string[] {
  return Object.keys(WINDOW_GATED_TOOLS).filter((name) => !WINDOW_GATED_TOOLS[name].includes(grain));
}

export interface WindowToolSource {
  readonly name: string;
  readonly source: string;
}

const grainKey = (grains: readonly WindowGrain[]): string => [...grains].sort().join(",");
const grainList = (grains: readonly WindowGrain[]): string => grains.map((g) => `"${g}"`).join(",");
const AGENT_KEY = grainKey(["standing", "thread"]);

export function checkWindowGateManifest(
  coreTools: readonly WindowToolSource[],
  appShims: ReadonlyMap<string, string>,
  frameworkToolNames: readonly string[],
  gated: Readonly<Record<string, readonly WindowGrain[]>> = WINDOW_GATED_TOOLS,
  ungated: ReadonlySet<string> = WINDOW_UNGATED_TOOLS,
  wideHandsGrains: readonly WindowGrain[] = FULL_KIT,
): string[] {
  const WIDE_HANDS_KEY = grainKey(wideHandsGrains);
  const problems: string[] = [];
  const coreByName = new Map(coreTools.map((t) => [t.name, t.source] as const));
  const sandboxKit = coreByName.get("sandbox_tools") ?? "";
  const surface = new Set<string>([...coreByName.keys(), ...appShims.keys(), ...frameworkToolNames]);

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
      if (grainKey(grains) !== AGENT_KEY) {
        problems.push(`WINDOW_GATED_TOOLS["agent"] must be exactly ["standing","thread"] (the worker-delegation tool: the conversational-root seats that delegate — not native until T5, never a task leaf) — got [${grains.join(", ")}]`);
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

  for (const name of Object.keys(gated)) {
    const coreSrc = coreByName.get(name);
    if (coreSrc === undefined) {
      if (!/windowGatedKit\s*\(/.test(sandboxKit) || !new RegExp(`\\n\\s*${name}\\s*:`).test(sandboxKit)) {
        problems.push(
          `framework tool "${name}" is grain-gated but is not re-provided per-grain by the sandbox_tools kit — it must be a key in windowGatedKit(...) in packages/core/agent/tools/sandbox_tools.ts`,
        );
      }
      const shim = appShims.get(name);
      if (shim === undefined || !/\bdisableTool\s*\(\s*\)/.test(shim)) {
        problems.push(
          `framework tool "${name}" is grain-gated but its app shim agent/tools/${name}.ts is not a \`disableTool()\` sentinel — without it eve's static built-in of that name stays mounted on EVERY session incl. standing seats, silently bypassing the grain gate`,
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

  return problems;
}
