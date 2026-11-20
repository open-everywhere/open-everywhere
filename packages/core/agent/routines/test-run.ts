import { classifyConnectorOpTier, isConnectorOpTool, isReservedNamespaceTool } from "../access/consequence.js";
import { oneAttrValue, routineMarker } from "./routine.js";
import type { NormalizedEvent } from "./event-model.js";

export const ROUTINE_TEST_ATTR = "open_everywhere_routine_test";
export const ROUTINE_TEST_BY_ATTR = "open_everywhere_routine_test_by";
export const ROUTINE_TEST_ANCHOR_ATTR = "open_everywhere_routine_test_anchor";

export const ROUTINE_TEST_BLOCKED_ACTION = "routine.test_blocked";
export const ROUTINE_TEST_REQUESTED_ACTION = "routine.test_requested";
export const ROUTINE_TEST_FIRED_ACTION = "routine.test_fired";

export interface RoutineTestRequest {
  readonly id: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

type Attrs = Readonly<Record<string, string | readonly string[]>> | undefined;

export interface TestRunStamp {
  readonly testId: string;
  readonly routineId: string;
  readonly surfaceKey: string;
  readonly org: string;
  readonly requestedBy?: string;
  readonly anchor?: string;
}

export function routineTestStamped(attributes: Attrs): TestRunStamp | null {
  const testId = oneAttrValue(attributes?.[ROUTINE_TEST_ATTR]);
  if (testId === undefined || testId.length === 0) return null;
  const marker = routineMarker(attributes);
  const requestedBy = oneAttrValue(attributes?.[ROUTINE_TEST_BY_ATTR]);
  const anchor = oneAttrValue(attributes?.[ROUTINE_TEST_ANCHOR_ATTR]);
  return {
    testId,
    routineId: marker?.id ?? "",
    surfaceKey: marker?.surfaceKey ?? "",
    org: marker?.org ?? "default",
    ...(requestedBy !== undefined && requestedBy.length > 0 ? { requestedBy } : {}),
    ...(anchor !== undefined && anchor.length > 0 ? { anchor } : {}),
  };
}

export function testRunAttrs(request: RoutineTestRequest, anchor?: string): Record<string, string> {
  return {
    [ROUTINE_TEST_ATTR]: request.id,
    [ROUTINE_TEST_BY_ATTR]: request.requestedBy,
    ...(anchor !== undefined && anchor.length > 0 ? { [ROUTINE_TEST_ANCHOR_ATTR]: anchor } : {}),
  };
}

const TEST_RUN_SURFACES = new Set<string>(["slack"]);

export function noteTestRunSurface(platform: string, testable: boolean): void {
  if (platform === "slack") return;
  if (testable) TEST_RUN_SURFACES.add(platform);
  else TEST_RUN_SURFACES.delete(platform);
}

export function testRunSurfaceSupported(platform: string): boolean {
  return TEST_RUN_SURFACES.has(platform);
}

export interface RoutineReplayEvent {
  readonly at: string;
  readonly event: NormalizedEvent;
}

export const REPLAY_EVENT_MAX_CHARS = 16_384;

export function replayEventFor(ev: NormalizedEvent, at: string): RoutineReplayEvent | undefined {
  const { actor: _actor, ...rest } = ev;
  const kept: RoutineReplayEvent = { at, event: rest };
  try {
    return JSON.stringify(kept).length <= REPLAY_EVENT_MAX_CHARS ? kept : undefined;
  } catch {
    return undefined;
  }
}

export function storedReplayEvent(r: { readonly lastEvent?: unknown }): RoutineReplayEvent | undefined {
  const v = r.lastEvent as Partial<RoutineReplayEvent> | undefined;
  if (v === undefined || v === null || typeof v !== "object") return undefined;
  const ev = v.event as Partial<NormalizedEvent> | undefined;
  if (typeof v.at !== "string" || ev === undefined || ev === null || typeof ev !== "object") return undefined;
  if (typeof ev.source !== "string" || typeof ev.event !== "string" || typeof ev.summary !== "string" || !Array.isArray(ev.scope)) return undefined;
  if (ev.fields === null || typeof ev.fields !== "object") return undefined;
  return v as RoutineReplayEvent;
}

function eventNameWords(value: string): string {
  return value.replace(/[^A-Za-z0-9 _.-]+/gu, "").replace(/[_.-]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 60);
}

export function replayEventWords(replay: RoutineReplayEvent): string {
  const kind = [eventNameWords(replay.event.event), replay.event.action !== undefined ? eventNameWords(replay.event.action) : ""].filter((w) => w.length > 0).join(" ");
  const when = Number.isFinite(Date.parse(replay.at)) ? `${new Date(replay.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : undefined;
  return [kind.length > 0 ? `a “${kind}” event` : "an event", ...(when !== undefined ? [`from ${when}`] : [])].join(" ");
}

export const TEST_RUN_OPEN_TOOLS: ReadonlySet<string> = new Set([
  "glob",
  "grep",
  "read_file",
  "sandbox_tools",
  "web_search",
  "web_fetch",
  "eve__search",
  "eve__skill",
  "agent_version",
  "session_cost",
  "spend_report",
  "usage_report",
  "query_analytics",
  "explain_permission",
  "permission_fit_report",
  "list_routines",
  "read_routine_transcript",
  "list_skills",
  "read_docs",
  "list_repos",
  "list_webhooks",
  "read_webhook_history",
  "list_recent_events",
  "waiting_on_me",
  "doing_for_me",
  "check_agent_task",
  "read_channel",
  "read_thread",
  "read_work_channel",
  "read_work_thread",
  "read_thread_seat",
  "look_up",
  "read_file_upload",
  "describe_image",
  "check_pr_status",
  "read_github_issue",
  "get_pr_feedback",
  "walk_pr",
  "checkout_repo",
  "read_notion_page",
  "read_notion_comments",
  "notion_search",
  "search",
  "read_linear_issue",
  "reply",
  "no_reply",
  "fresh_eyes_review",
  "agent",
  "eve__task_wait",
  "eve__task_cancel",
]);

export type TestRunToolVerdict = "run" | "block";

/** The verdict depends on the tool name only. `_input` stays so that callers need not change. */
export function testRunToolVerdict(toolName: string, _input?: unknown): TestRunToolVerdict {
  if (isReservedNamespaceTool(toolName)) return "block";
  if (isConnectorOpTool(toolName)) return classifyConnectorOpTier(toolName) === "read" ? "run" : "block";
  return TEST_RUN_OPEN_TOOLS.has(toolName) ? "run" : "block";
}

const PREVIEW_FIELDS = ["text", "message", "body", "title", "content", "summary", "prompt", "comment", "rule", "name"] as const;
export const TEST_RUN_PREVIEW_CHARS = 120;

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function connectorWords(toolName: string, input: unknown): string | undefined {
  const i = toolName.lastIndexOf("__");
  if (i < 0) return undefined;
  return `${toolName.slice(i + 2).replace(/[_-]+/gu, " ")} on ${toolName.slice(0, i).replace(/__/gu, " ")}`;
}

export function describeBlockedCall(toolName: string, input: unknown): { readonly tool: string; readonly what: string } {
  const connector = connectorWords(toolName, input);
  const action = connector ?? toolName.replace(/_/gu, " ");
  const inner = input;
  let quote: string | undefined;
  if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
    const rec = inner as Record<string, unknown>;
    for (const field of PREVIEW_FIELDS) {
      const v = rec[field];
      if (typeof v === "string" && v.trim().length > 0) {
        quote = oneLine(v, TEST_RUN_PREVIEW_CHARS);
        break;
      }
    }
  }
  return { tool: toolName, what: quote === undefined ? action : `${action}: “${quote}”` };
}

export function testRunBlockedMessage(toolName: string): string {
  return (
    `TEST RUN: "${toolName}" was blocked and did NOT run. This is a test run of the routine, asked for by a person. ` +
    "It blocks every write and every post other than its own answer, and the person sees a list of what was blocked. " +
    "Do not retry it and do not report it as a failure. Carry on as if it had worked, and write your answer exactly as the real run would."
  );
}

let fenceMounted = false;

export const TEST_RUN_UNFENCED_REFUSAL = "this deployment has no way to block a test's writes, so the test would change things for real";

export function noteTestRunFenceMounted(): void {
  fenceMounted = true;
}

export function testRunFenceMounted(): boolean {
  return fenceMounted;
}

export function _setTestRunFenceMountedForTest(mounted: boolean): void {
  fenceMounted = mounted;
}

export interface TestRunRefusalFacts {
  readonly status: string;
  readonly trigger: { readonly kind: string };
  readonly surfaceKey: string;
  readonly lastEvent?: unknown;
}

export const TEST_RUN_NO_EVENT_REFUSAL = "it runs when an event arrives, and it has not matched an event yet, so a test has no event to replay";

export function testRunRefusal(r: TestRunRefusalFacts): string | null {
  if (!testRunFenceMounted()) return TEST_RUN_UNFENCED_REFUSAL;
  if (r.status === "done") return "it is a finished job, and a finished job does not run again";
  if (r.trigger.kind === "event" && storedReplayEvent(r) === undefined) return TEST_RUN_NO_EVENT_REFUSAL;
  if (!testRunSurfaceSupported(r.surfaceKey.split("/")[0] ?? "")) return "a test run is not available on this platform";
  return null;
}

export function testRunOffer(r: TestRunRefusalFacts): string {
  return testRunRefusal(r) === null ? "; say “test it” to run it once with every write blocked" : "";
}

export function testRunKickoffText(args: {
  readonly routine: string;
  readonly askedBy: string;
  readonly gateSkip?: string;
  readonly threaded?: boolean;
  readonly replay?: string;
  readonly filterSkip?: boolean;
}): string {
  return [
    `🧪 Test run of ${args.routine}, asked by ${args.askedBy}.`,
    args.threaded === false
      ? "It runs the real collectors and model. It blocks every write, and it posts only its answer, in this room."
      : "It runs the real collectors and model. It blocks every write, and it posts nothing outside this thread.",
    ...(args.replay !== undefined ? [`It replays the last event the routine matched: ${args.replay}.`] : []),
    ...(args.filterSkip === true ? ["Its filter would not match that event now. The test runs it anyway."] : []),
    ...(args.gateSkip !== undefined ? [`Its condition says the real run would skip now (${oneLine(args.gateSkip, 160)}). The test runs it anyway.`] : []),
  ].join("\n");
}

export interface BlockedCall {
  readonly tool: string;
  readonly what: string;
}

export const TEST_RUN_SUMMARY_MAX_LINES = 12;

export function renderTestRunSummary(args: {
  readonly routine: string;
  readonly blocked: readonly BlockedCall[];
  readonly failed?: boolean;
  readonly unreadable?: boolean;
  readonly counted?: number;
  readonly threaded?: boolean;
}): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const b of args.blocked) {
    if (seen.has(b.what)) continue;
    seen.add(b.what);
    lines.push(b.what);
  }
  const head = args.failed === true ? `🧪 The test run of ${args.routine} stopped with an error.` : `🧪 Test run of ${args.routine} finished.`;
  if (args.unreadable === true) return `${head}\nI blocked every write it tried, but I could not read the list of them back, so I can't say which writes it would have made.`;
  const lost = Math.max(0, (args.counted ?? 0) - args.blocked.length);
  const lostLine = lost > 0 ? [`${lost} more blocked ${lost === 1 ? "write" : "writes"} could not be listed.`] : [];
  if (lines.length === 0 && lost === 0) {
    return `${head}\nIt tried no writes. Nothing was changed, and ${args.threaded === false ? "nothing was posted but its answer" : "nothing was posted outside this thread"}.`;
  }
  if (lines.length === 0) return [head, "I blocked every write it tried, so nothing was changed.", ...lostLine].join("\n");
  const shown = lines.slice(0, TEST_RUN_SUMMARY_MAX_LINES).map((l) => `• ${l}`);
  const more = lines.length - shown.length;
  return [
    head,
    `It would have made ${lines.length === 1 ? "this write" : `these ${lines.length} writes`}. I blocked ${lines.length === 1 ? "it" : "all of them"}, so nothing was changed:`,
    ...shown,
    ...(more > 0 ? [`…and ${more} more.`] : []),
    ...lostLine,
  ].join("\n");
}
