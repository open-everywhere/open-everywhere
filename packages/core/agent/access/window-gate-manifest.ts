import type { WindowGrain } from "../identity/binding.js";

export const FULL_KIT = ["task", "native"] as const;

export const WORKER_FRAMEWORK_TOOLS = ["bash", "glob", "grep", "read_file", "write_file", "web_fetch"] as const;
export const WORKER_AUTHORED_TOOLS = ["checkout_repo", "open_pull_request", "post_file", "browser_qa", "create_skill", "delete_skill"] as const;

export const WORKER_KIT: ReadonlySet<string> = new Set<string>([...WORKER_FRAMEWORK_TOOLS, ...WORKER_AUTHORED_TOOLS]);

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
  complete_task: ["task"],
  agent: ["standing"],
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
  "workflow",
]);

export function withheldFromGrain(grain: WindowGrain): string[] {
  return Object.keys(WINDOW_GATED_TOOLS).filter((name) => !WINDOW_GATED_TOOLS[name].includes(grain));
}

export interface WindowToolSource {
  readonly name: string;
  readonly source: string;
}

const grainKey = (grains: readonly WindowGrain[]): string => [...grains].sort().join(",");
const WIDE_HANDS_KEY = grainKey(FULL_KIT);

export function checkWindowGateManifest(
  coreTools: readonly WindowToolSource[],
  appShims: ReadonlyMap<string, string>,
  frameworkToolNames: readonly string[],
  gated: Readonly<Record<string, readonly WindowGrain[]>> = WINDOW_GATED_TOOLS,
  ungated: ReadonlySet<string> = WINDOW_UNGATED_TOOLS,
  workerShims: ReadonlyMap<string, string> = new Map(),
): string[] {
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
    if (name === "spawn_task" || name === "agent") {
      if (grainKey(grains) !== "standing") {
        problems.push(`WINDOW_GATED_TOOLS["${name}"] must be exactly ["standing"] (a delegation tool: a task/native session must never spawn recursively) — got [${grains.join(", ")}]`);
      }
    } else if (name === "complete_task") {
      if (grainKey(grains) !== "task") {
        problems.push(`WINDOW_GATED_TOOLS["complete_task"] must be exactly ["task"] (only a worker owns a thread) — got [${grains.join(", ")}]`);
      }
    } else if (grainKey(grains) !== WIDE_HANDS_KEY) {
      problems.push(
        `WINDOW_GATED_TOOLS["${name}"] is a wide-hands tool and must be exactly ["task","native"] (withheld from every standing seat) — got [${grains.join(", ")}]; mounting it on "standing" would give an always-on ambient watcher heavy hands`,
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

  if (workerShims.size > 0) {
    for (const [slug, src] of workerShims) {
      if (!WORKER_KIT.has(slug)) {
        problems.push(
          `agent/subagents/worker/tools/${slug}.ts is not a declared WORKER_KIT member — add "${slug}" to WORKER_AUTHORED_TOOLS in access/window-gate-manifest.ts (or remove the shim). A worker tool must state that it belongs to the worker surface.`,
        );
      }
      const m = src.match(/@open-everywhere\/core\/agent\/tools\/([\w-]+)\.js/u);
      if (!m) {
        problems.push(`agent/subagents/worker/tools/${slug}.ts must re-export a core tool (\`export { default } from "@open-everywhere/core/agent/tools/${slug}.js"\`) — the worker carries the SAME tool the root authors, not a fork`);
      } else if (!coreByName.has(m[1])) {
        problems.push(`agent/subagents/worker/tools/${slug}.ts re-exports @open-everywhere/core/agent/tools/${m[1]}.js but no such core tool file exists (dangling worker shim)`);
      }
    }
    for (const name of WORKER_AUTHORED_TOOLS) {
      if (!workerShims.has(name)) {
        problems.push(
          `WORKER_AUTHORED_TOOLS names "${name}" but agent/subagents/worker/tools/${name}.ts is missing — the worker would not carry it; add the shim \`export { default } from "@open-everywhere/core/agent/tools/${name}.js"\``,
        );
      }
    }
  }

  return problems;
}
