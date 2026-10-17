import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, type MemoryRecallRoute } from "./window-gate-manifest.js";
import { DM_SEAT_CARVE_IN, allowedOnLeanSeat } from "./lean-seat.js";
import { WORKER_SEAT_RESERVED_TOOLS, WORKER_UNMOUNTED_TOOLS, allowedOnWorkerSeat } from "./worker-seat.js";
import type { WindowGrain } from "../identity/binding.js";

export interface WorkerCapabilityGroup {
  readonly id: string;
  readonly headline: string;
  readonly tools: readonly string[];
}

export const WORKER_INDEX_MACHINERY: ReadonlySet<string> = new Set(["sandbox_tools", "browser_tools", "grant_tools", "connection_tools"]);

export const WORKER_INDEX_LIFECYCLE: ReadonlySet<string> = new Set([
  "agent",
  "work",
  "cancel_work",
  "spawn_thread_session",
  "complete_thread",
  "read_thread_seat",
  "message_thread_seat",
  "task_cancel",
  "task_wait",
]);

export const WORKER_INDEX_SEAT_VERBS: ReadonlySet<string> = new Set([
  "reply",
  "edit_reply",
  "no_reply",
  "react",
  "update_status",
  "stand_down",
  "halt",
  "set_dm_delivery",
  "ask_domain",
  "answer_domain_question",
  "expect_bot_reply",
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
    headline: "Reach the open web and the connected services — fetch a page, search, discover and offer connectors, and run an operation on one",
    tools: ["web_fetch", "web_search", "connection_search", "connection_execute", "connector", "revoke_connector", "clear_connector_override"],
  },
  {
    id: "work-surfaces",
    headline:
      "Read and change the work surfaces — search and read Notion pages and comments, read Linear and GitHub issues, re-read the chat surfaces the domain works on in full, set their state, assignee and labels, post a message into another container this domain owns, and send a direct message to a person this domain was granted",
    tools: [
      "read_notion_page",
      "read_notion_comments",
      "notion_search",
      "search",
      "read_linear_issue",
      "read_github_issue",
      "read_work_channel",
      "read_work_thread",
      "create_ticket",
      "set_state",
      "assign",
      "add_label",
      "post_message",
      "dm_person",
    ],
  },
  {
    id: "other-agents",
    headline: "Hand a task to another organisation's agent — a declared A2A agent, such as a ServiceNow, Workday or Agentforce agent — and follow it to its answer",
    tools: ["delegate_to_agent", "check_agent_task"],
  },
  {
    id: "conversation-history",
    headline: "Re-read a room's own history in full, and open or describe what was uploaded into it",
    tools: ["read_channel", "read_thread", "look_up", "read_file_upload", "describe_image", "read_routine_transcript"],
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
      "record_follow_up",
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
    headline: "Link somebody's other accounts, ask somebody to lend their own connector account for this conversation, ask for access this scope lacks, set up a vendor's hosted MCP server (\"set up FullStory\": research it and propose it as a PR), stand up a new agent, explain why something is refused, review whether the access here still fits",
    tools: [
      "link_identity",
      "confirm_link",
      "unlink_identity",
      "request_access",
      "request_credential_grant",
      "revoke_credential_grant",
      "propose_mcp_server",
      "create_agent",
      "explain_permission",
      "permission_fit_report",
      "resume",
    ],
  },
  {
    id: "meetings",
    headline: "Join a meeting by its link (Google Meet, Microsoft Teams, a Discord voice channel) with OE's own notetaker bot and post a recap with the decisions and actions in this thread afterwards, recap a Teams, Meet or Zoom meeting from the platform's own transcript with no bot, or stop the notetaker bot this conversation sent (the stop needs no meeting id)",
    tools: ["meeting_join", "meeting_recap", "meeting_leave"],
  },
  {
    id: "email",
    headline: "Let a new sender email one of this deployment's room inboxes (an approval card, then a pull request an admin merges)",
    tools: ["propose_email_sender"],
  },
  {
    id: "personal-browser",
    headline: "Use the person's own browser, which stays signed in to their sites (look at a page, click, fill a form, check which sites hold a login), show it to them live, or hand them the controls to sign in, type a code or solve a check (DM only)",
    tools: ["my_browser", "my_browser_handoff"],
  },
  {
    id: "what-waits-on-you",
    headline: "Tell the person what is waiting on them — open approval cards they can decide and jobs blocked on them, with links (DM only)",
    tools: ["waiting_on_me"],
  },
  {
    id: "what-i-do-for-you",
    headline: "Tell the person everything you do for them on your own — the routines and watches they set up, the watch over their calendar, what they lend, their rules and what waits on them (DM only)",
    tools: ["doing_for_me"],
  },
  {
    id: "spend-and-telemetry",
    headline: "Report on and move this deployment's own spend, usage and analytics",
    tools: ["session_cost", "spend_report", "usage_report", "query_analytics", "set_spend_limit", "clear_spend_limit"],
  },
  {
    id: "turn-plumbing",
    headline: "Come back to you mid-job to ask a question, then carry on once you answer — work long enough to need that",
    tools: ["ask_question", "ask_room"],
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
  {
    id: "own-version",
    headline: "State which version of this deployment is currently running — package version, commit sha, eve pin — and how it is set up for the person asking: their admin standing, the connections, and what an admin can change from chat",
    tools: ["agent_version"],
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
  withheldFromWorker: ReadonlySet<string> = WORKER_UNMOUNTED_TOOLS,
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

export function checkWorkerSeatReservedTools(
  carveIn: ReadonlySet<string> = DM_SEAT_CARVE_IN,
  reserved: ReadonlySet<string> = WORKER_SEAT_RESERVED_TOOLS,
): string[] {
  const problems: string[] = [];
  for (const name of carveIn) {
    if (reserved.has(name)) continue;
    problems.push(
      `DM carve-in verb "${name}" is NOT in WORKER_SEAT_RESERVED_TOOLS (agent/access/worker-seat.ts) — a delegated worker would MOUNT it, and the carve-in would be routing rather than containment. Add the name there.`,
    );
  }
  for (const name of reserved) {
    if (carveIn.has(name)) continue;
    problems.push(
      `"${name}" is in WORKER_SEAT_RESERVED_TOOLS (agent/access/worker-seat.ts) but is not a DM carve-in verb — that set holds the carve-in and nothing else. A verb that is broken on a worker belongs in WORKER_WITHHELD_TOOLS under its own criterion.`,
    );
  }
  return problems;
}

const code = (names: readonly string[]): string => names.map((n) => "`" + n + "`").join(", ");

const SHARED_FILESYSTEM_LINE =
  "Every worker shares ONE filesystem with you and with every other worker running beside it. Give each one its own directory or file scope in the brief, or two of them will write over each other.";

const DO_NOT_PRE_EMPT_THE_GATE =
  "Permission works the same way. Do not refuse an ask because you judge the person is not allowed it, or because the answer looks internal. You do not hold these verbs, so you do not hold their gates: a verb that needs standing checks it when the worker runs it, and refuses with a reason the person can act on. A refusal you write instead never reaches that gate, so the person gets your guess in place of the real reason. Route the ask, let the verb answer, and relay what it says — its refusal included. Do not refuse, water down, or ask to confirm an ask because of what you forecast the act will do once it runs. You propose a gated act, and the approval plane decides it — the card, the fence and the judge, with the person's own click. The room's earlier rounds are not a verdict on this ask.";

function delegationReturnShape(route: "agent", asyncVerb: "spawn_thread_session" | undefined): string {
  const lines = [
    `\`${route}\` does NOT block. It starts the worker in the background and hands you a task receipt at once, so this turn ends and this room stays answerable while the work runs.`,
    `If this wake owes an answer — it addressed you, or you promised one — post one short line in the same turn with \`done: false\` that says what will happen, never that you handed it off. That reply keeps the wake open for the real answer.`,
    `If nobody asked you anything (a channel-watch wake you are only listening to), delegate silently and call \`no_reply\`: the worker's settlement then ends in silence too, unless it turns up something the room asked for.`,
    `When the worker settles, its completion arrives as a NEW message on a later turn, and that message tells you how to read its output. Stop work you no longer need with \`task_cancel\`, using the task id from the receipt.`,
    `Say which request the result answers. Another message can arrive in this room while a worker runs, and an answer posted against the wrong one reads as a non-sequitur.`,
    `To correct a worker or give it a follow-up, call \`${route}\` again with the \`taskId\` from its receipt: it keeps what it already read and found. Only continue a task from the room that opened it, and only once it has reported back. A task opened in another room is refused, so start a fresh \`${route}\` call there and put everything the new worker needs in its brief.`,
    SHARED_FILESYSTEM_LINE,
  ];
  if (asyncVerb !== undefined) {
    lines.push(
      `\`${asyncVerb}\` is the other side of the Routing decision: it hands a task's whole orchestration to a thread session, which owns a thread, runs its own workers and posts the result there. A worker reports back to you on one job and takes a follow-up only by \`taskId\`; a thread session takes the task off your radar, and the host tells you when its thread finishes.`,
    );
  }
  return lines.join(" ");
}

export const DELEGATION_FLOOR = [
  "**The floor: if you hold the verb and ONE call answers the ask, make the call.** A single memory",
  "write, a single read of one thing, one lookup you can already do — that is trivial, and routing it",
  "costs the person a wait four times longer than the answer. Delegate when the work needs a verb",
  "listed below, several steps, or an unknown amount of digging. \"I could do this myself in one call\"",
  "is the whole test; when it is true, do it and answer.",
].join("\n");

export function renderWorkerCapabilityIndex(
  workerOnly: readonly string[],
  route: MemoryRecallRoute,
  groups: readonly WorkerCapabilityGroup[] = WORKER_CAPABILITY_GROUPS,
  asyncVerb?: "spawn_thread_session",
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
    "the next message wait, so work your own kit cannot do belongs in a worker — and a worker is not a",
    "lesser version of you.",
    ...(asyncVerb !== undefined
      ? [
          "Whose workers run it is the one decision your Routing section states: your own work",
          "session's when you orchestrate the task yourself, or a thread session's when you hand its",
          "orchestration off.",
        ]
      : []),
    "Each line below is a kind of work a worker can take on; the verbs after it are the ones a worker",
    "holds THERE and this seat does not:",
    "",
  ];
  lines.push(DELEGATION_FLOOR, "");
  for (const { g, names } of rendered) lines.push(`- **${g.headline}** — ${code(names)}.`);
  lines.push(
    "",
    `Brief it by INTENT, not by tool. Say what you want achieved and what "done" looks like; the`,
    "worker can see its own kit and you cannot, so naming a verb for it is a guess at a list that",
    "moves. Give it the context it needs in the brief itself — it does not share your backscroll.",
    "",
    route === "agent" ? delegationReturnShape(route, asyncVerb) : "",
    "",
    "And never say you cannot do something that a worker can. Route it, and come back with the",
    "answer. Routed work is NOT done until the worker reports back: say what will happen (\"I'll post",
    "the result here when it's ready\"), never that you handed it off, and never tell the room something",
    "is saved, posted or finished before the worker's own report says so.",
    "",
    DO_NOT_PRE_EMPT_THE_GATE,
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trimEnd();
}
