import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, type MemoryRecallRoute } from "./window-gate-manifest.js";
import { DM_SEAT_CARVE_IN, allowedOnLeanSeat } from "./lean-seat.js";
import { WORKER_WITHHELD_TOOLS, allowedOnWorkerSeat } from "./worker-seat.js";
import type { WindowGrain } from "../identity/binding.js";

export interface WorkerCapabilityGroup {
  readonly id: string;
  readonly headline: string;
  readonly tools: readonly string[];
}

export const WORKER_INDEX_MACHINERY: ReadonlySet<string> = new Set(["sandbox_tools", "delegation_tools", "browser_tools"]);

export const WORKER_INDEX_LIFECYCLE: ReadonlySet<string> = new Set([
  "agent",
  "stop_task",
  "spawn_task",
  "spawn_thread_session",
  "complete_task",
  "complete_thread",
  "return_result",
  "task_peek",
  "task_cancel",
  "task_sleep",
  "task_update",
]);

export const WORKER_INDEX_SEAT_VERBS: ReadonlySet<string> = new Set([
  "reply",
  "edit_reply",
  "no_reply",
  "react",
  "update_status",
  "stand_down",
  "ask_question",
  "todo",
]);

export const WORKER_CAPABILITY_GROUPS: readonly WorkerCapabilityGroup[] = [
  {
    id: "workspace",
    headline: "Work in a real workspace — check out a repo, read and write files, run commands, inspect output",
    tools: ["bash", "glob", "grep", "read_file", "write_file", "checkout_repo", "extend_workspace_time"],
  },
  {
    id: "artifacts",
    headline: "Produce something and put it in front of people — a chart, a CSV, an image, a document, a reusable skill",
    tools: ["post_file", "create_skill", "delete_skill", "load_skill", "list_skills"],
  },
  {
    id: "code-changes",
    headline: "Propose and follow a change to code — open a pull request, read its feedback, walk somebody through it",
    tools: ["open_pull_request", "check_pr_status", "get_pr_feedback", "walk_pr", "post_pr_walkthrough", "subscribe_pr", "list_repos"],
  },
  {
    id: "external-reach",
    headline: "Reach the open web and the connected services — fetch a page, search, discover and offer connectors",
    tools: ["web_fetch", "web_search", "connection_search", "connector", "revoke_connector", "clear_connector_override"],
  },
  {
    id: "work-surfaces",
    headline: "Read and change the work surfaces — search and read Notion pages and comments, read Linear and GitHub issues, set their state, assignee and labels",
    tools: ["read_notion_page", "read_notion_comments", "notion_search", "read_linear_issue", "create_ticket", "set_state", "assign", "add_label"],
  },
  {
    id: "conversation-history",
    headline: "Re-read a room's own history in full, and open or describe what was uploaded into it",
    tools: ["read_channel", "read_thread", "read_slack_channel", "read_slack_thread", "read_file_upload", "describe_image", "read_routine_transcript"],
  },
  {
    id: "memory",
    headline:
      "Read, add to and correct the team's durable memory — the memory files are editable in the " +
      "worker's workspace and every edit is saved and audited when the task finishes, so brief a " +
      "fact or a correction as an ordinary edit. Only genuine ERASURE (remove this permanently) " +
      "goes through a human approval card, and auditing what is stored is its own read",
    tools: ["purge_memory", "memory_admin_list", "memory_admin_read"],
  },
  {
    id: "standing-behaviour",
    headline: "Arm, amend and disarm what this surface does on its own — scheduled and triggered routines, their rules and their run ledger",
    tools: [
      "create_routine",
      "cancel_routine",
      "edit_routine",
      "enable_routine",
      "run_routine_now",
      "add_routine_rule",
      "remove_routine_rule",
      "revoke_routine_permissions",
      "record_watch_state",
      "record_job_state",
      "complete_job",
      "report_run_failed",
      "list_routines",
    ],
  },
  {
    id: "inbound-webhooks",
    headline: "Stand up and diagnose an inbound webhook — declare one, rotate its secret, inspect what has been delivered",
    tools: ["declare_webhook", "rotate_webhook", "list_webhooks", "read_webhook_history", "capture_events", "list_recent_events"],
  },
  {
    id: "cloud",
    headline: "Run AWS commands under the role this scope has been granted",
    tools: ["aws"],
  },
  {
    id: "identity-and-access",
    headline: "Link somebody's other accounts, ask for access this scope lacks, stand up a new agent, explain why something is refused, review whether the access here still fits",
    tools: ["link_identity", "confirm_link", "unlink_identity", "request_access", "create_agent", "explain_permission", "permission_fit_report"],
  },
  {
    id: "spend-and-telemetry",
    headline: "Report on and move this deployment's own spend, usage and analytics",
    tools: ["session_cost", "spend_report", "usage_report", "query_analytics", "set_spend_limit", "clear_spend_limit"],
  },
  {
    id: "second-opinion",
    headline: "Get a zero-tool second read of a proposed change or a piece of reasoning",
    tools: ["fresh_eyes_review"],
  },
  {
    id: "own-manual",
    headline: "Look up how OE's own capabilities actually work",
    tools: ["read_docs"],
  },
];

function mountedOn(name: string, grain: WindowGrain, gated: Readonly<Record<string, readonly WindowGrain[]>>, ungated: ReadonlySet<string>): boolean {
  const grains = gated[name];
  return grains ? grains.includes(grain) : ungated.has(name);
}

export function workerOnlyTools(
  grain: WindowGrain,
  gated: Readonly<Record<string, readonly WindowGrain[]>> = WINDOW_GATED_TOOLS,
  ungated: ReadonlySet<string> = WINDOW_UNGATED_TOOLS,
  withheldFromWorker: ReadonlySet<string> = WORKER_WITHHELD_TOOLS,
): readonly string[] {
  const surface = [...new Set([...Object.keys(gated), ...ungated])];
  return surface
    .filter((n) => !WORKER_INDEX_MACHINERY.has(n) && !WORKER_INDEX_LIFECYCLE.has(n) && !DM_SEAT_CARVE_IN.has(n))
    .filter((n) => allowedOnWorkerSeat(n, withheldFromWorker))
    .filter((n) => mountedOn(n, "task", gated, ungated) && (!mountedOn(n, grain, gated, ungated) || !allowedOnLeanSeat(n)))
    .sort();
}

export function checkWorkerCapabilityGroups(
  gated: Readonly<Record<string, readonly WindowGrain[]>> = WINDOW_GATED_TOOLS,
  ungated: ReadonlySet<string> = WINDOW_UNGATED_TOOLS,
  groups: readonly WorkerCapabilityGroup[] = WORKER_CAPABILITY_GROUPS,
): string[] {
  const problems: string[] = [];
  const surface = new Set<string>([...Object.keys(gated), ...ungated]);
  const seen = new Map<string, string>();
  for (const g of groups) {
    for (const t of g.tools) {
      const prior = seen.get(t);
      if (prior !== undefined) {
        problems.push(`tool "${t}" is in BOTH worker-capability groups "${prior}" and "${g.id}" — a tool describes exactly ONE capability to a router (agent/access/worker-capabilities.ts)`);
        continue;
      }
      seen.set(t, g.id);
      if (!surface.has(t)) {
        problems.push(`worker-capability group "${g.id}" names "${t}", which is in neither window-gate posture table — remove it or fix the name (a stale row makes the index promise a worker capability that does not exist)`);
      }
    }
  }
  for (const name of surface) {
    if (seen.has(name) || WORKER_INDEX_MACHINERY.has(name) || WORKER_INDEX_LIFECYCLE.has(name) || WORKER_INDEX_SEAT_VERBS.has(name)) continue;
    problems.push(
      `tool "${name}" has NO worker-capability group — add it to a group in agent/access/worker-capabilities.ts (or, if it is kit machinery, grain lifecycle, or one of the seat's own conversational verbs, to the matching exclusion set). There is deliberately no default: a tool with no group is a capability a delegating seat can never be told about.`,
    );
  }
  return problems;
}

const code = (names: readonly string[]): string => names.map((n) => "`" + n + "`").join(", ");

const SHARED_FILESYSTEM_LINE =
  "Every worker shares ONE filesystem with you and with every other worker running beside it. Give each one its own directory or file scope in the brief, or two of them will write over each other.";

const DO_NOT_PRE_EMPT_THE_GATE =
  "Permission works the same way. Do not refuse an ask because you judge the person is not allowed it, or because the answer looks internal. You do not hold these verbs, so you do not hold their gates: a verb that needs standing checks it when the worker runs it, and refuses with a reason the person can act on. A refusal you write instead never reaches that gate, so the person gets your guess in place of the real reason. Route the ask, let the verb answer, and relay what it says — its refusal included.";

function delegationReturnShape(route: "agent" | "spawn_task", asyncVerb: "spawn_thread_session" | undefined, backgroundTasks: boolean): string {
  if (!backgroundTasks) {
    const blocking = asyncVerb
      ? `\`${route}\` runs the worker and BLOCKS this turn until it answers — right for short work the person is waiting on, wrong for anything long, because nothing else in this room is delivered while you wait. For work that will take a while, use \`${asyncVerb}\`: it mints a durable seat that runs alongside you and reports back on its own.`
      : `\`${route}\` runs the worker and BLOCKS this turn until it answers, so keep what you hand it bounded. Nothing else in this room is delivered while you wait.`;
    return `${blocking} ${SHARED_FILESYSTEM_LINE}`;
  }
  const lines = [
    `\`${route}\` does NOT block. It starts the worker in the background and hands you a task receipt at once, so this turn ends and this room stays answerable while the work runs.`,
    `Acknowledge the hand-off in the same turn and pass \`done: false\`, which keeps the wake open for the real answer.`,
    `When the worker settles, its completion arrives as a NEW message on a later turn, and that message tells you how to read its output. Stop work you no longer need with \`task_cancel\`, using the task id from the receipt.`,
    `Say which request the result answers. Another message can arrive in this room while a worker runs, and an answer posted against the wrong one reads as a non-sequitur.`,
    `A worker does ONE job. You cannot send more work to a worker that has already run: \`agentId\` is refused. Start a fresh \`${route}\` call and put everything the new worker needs in its brief, including whatever the last one found.`,
    SHARED_FILESYSTEM_LINE,
  ];
  if (asyncVerb !== undefined) {
    lines.push(
      `\`${asyncVerb}\` is a different move and still worth knowing: it mints a durable SEAT that joins the room and keeps talking, where a worker does one job and reports back.`,
    );
  }
  return lines.join(" ");
}

export function renderWorkerCapabilityIndex(
  workerOnly: readonly string[],
  route: MemoryRecallRoute,
  groups: readonly WorkerCapabilityGroup[] = WORKER_CAPABILITY_GROUPS,
  asyncVerb?: "spawn_thread_session",
  backgroundTasks: boolean = false,
): string {
  if (route === "none" || route === "file-tools") return "";
  const present = new Set(workerOnly);
  const rendered = groups
    .map((g) => ({ g, names: g.tools.filter((t) => present.has(t)) }))
    .filter((r) => r.names.length > 0);
  if (rendered.length === 0) return "";
  const lines: string[] = [
    "## What a worker can do that you cannot",
    "",
    "You are the router for this room. Doing the work yourself in this context window is what makes",
    "the next message wait, so all but trivial work belongs in a worker — and a worker is not a",
    "lesser version of you. Each line below is a kind of work a worker can take on; the verbs after",
    "it are the ones a worker holds THERE and this seat does not:",
    "",
  ];
  for (const { g, names } of rendered) lines.push(`- **${g.headline}** — ${code(names)}.`);
  lines.push(
    "",
    `Brief it by INTENT, not by tool. Say what you want achieved and what "done" looks like; the`,
    "worker can see its own kit and you cannot, so naming a verb for it is a guess at a list that",
    "moves. Give it the context it needs in the brief itself — it does not share your backscroll.",
    "",
    route === "agent" || route === "spawn_task" ? delegationReturnShape(route, asyncVerb, backgroundTasks) : "",
    "",
    "And never say you cannot do something that a worker can. Route it, say you have routed it, and",
    "come back with the answer. Routed work is NOT done until the worker reports back: acknowledge",
    'it is underway ("handing this off — will report back"), and never tell the room something is',
    "saved, posted or finished before the worker's own report says so.",
    "",
    DO_NOT_PRE_EMPT_THE_GATE,
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trimEnd();
}
