import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-lean-seat-")), "ops.sqlite3");

import { LEAN_SEAT_TOOLS, allowedOnLeanSeat, resolveLeanSeatPosture, restrictToolsetForLeanSeat, withheldFromLeanSeat } from "../agent/access/lean-seat.js";
import { setLeanSeatWake, currentLeanSeatPosture } from "../agent/access/lean-seat-state.js";
import { WORKER_WITHHELD_TOOLS, allowedOnWorkerSeat, restrictToolsetForWorkerSeat } from "../agent/access/worker-seat.js";
import { setWorkerWake, currentWorkerWake } from "../agent/access/worker-seat-state.js";
import { renderSupervisorPersona } from "../agent/instructions/access.js";
import { markJobSession, setJobWakeEscalated } from "../agent/access/job-session-state.js";
import { JOB_WAKE_TOOLS, WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { projectToolSet } from "../agent/access/untrusted-projection.js";
import { setNativeDelegationSeat } from "../agent/access/native-delegation-state.js";
import { grainBackstopAtExecute } from "../agent/access/window-gated.js";
import { workerOnlyTools } from "../agent/access/worker-capabilities.js";
import { approvalPreviewFor } from "../agent/access/approval-preview.js";
import { canDelegateFromSeat } from "../agent/access/delegation-mount.js";
import { FIRE_UNATTENDED_ATTR } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

function removedBy(before: Record<string, unknown>, after: Record<string, unknown>): readonly string[] {
  return Object.keys(before)
    .filter((k) => !(k in after))
    .sort();
}

const TASK_FAMILY = ["task_cancel", "task_peek", "task_sleep", "task_update"] as const;

const posture = (grain: "standing" | "thread" | "native" | "task", canDelegate: boolean, unattendedFire = false) =>
  resolveLeanSeatPosture({ grain, canDelegate, unattendedFire });

ok(posture("standing", true) === "lean", "a DELEGATING standing seat (a unified/solo window root) runs LEAN — the ordinary case, the whole cut");
ok(posture("thread", true) === "lean", "a delegating THREAD seat runs lean too — one roster, no variants");
ok(
  posture("standing", false) === "full",
  "🔴 THE PINNED PROPERTY: a NON-delegating standing seat (a DM / group-DM / per-container root — no window to mint a worker into) keeps the FULL kit. Narrowing it would strand it: the formerly-BLOCKED S14 / S-LINK-SLACK / S-DM-NOTION shape.",
);
ok(posture("thread", false) === "full", "a non-delegating thread seat keeps the full kit for the same reason");
ok(posture("task", true) === "full", "a task WORKER is never lean — it IS the full kit the seat delegates into");
ok(posture("native", true) === "full", "a native @mention seat is never lean — it holds no delegation verb (NOT native until T5), so narrowing it would strand it");
ok(posture("standing", true, true) === "full", "a FIRE is never lean — fires are a separate seat class whose posture this cut does not touch");

for (const name of ["reply", "no_reply", "react", "update_status"]) {
  ok(allowedOnLeanSeat(name), `the lean roster keeps the speak verb ${name}`);
}
for (const name of ["agent", "spawn_task", "spawn_thread_session", "complete_thread"]) {
  ok(allowedOnLeanSeat(name), `the lean roster keeps the delegation/lifecycle verb ${name} (the grain matrix still decides where it resolves)`);
}
for (const name of ["ask_question", "todo"]) {
  ok(allowedOnLeanSeat(name), `the lean roster keeps eve's conversational plumbing ${name}`);
}
ok(allowedOnLeanSeat("final_output"), "the lean roster keeps eve's structured-output sink (a lean turn must still be able to return)");

for (const name of ["task_peek", "task_cancel"]) {
  ok(allowedOnLeanSeat(name), `OPE-583: the lean roster keeps ${name} — the seat can read back and stop work it itself delegated`);
  ok(LEAN_SEAT_TOOLS.has(name), `${name} is a NAMED LEAN_SEAT_TOOLS member, not merely surviving on a different default`);
}
for (const [name, why] of [
  ["task_sleep", "no measured seat-side need — pausing delegated work is a worker's own decision, not a routing one"],
  ["task_update", "CHILD-only: eve's isTaskToolAvailable never mounts it on a seat (measured on the T1 probe)"],
] as const) {
  ok(!allowedOnLeanSeat(name), `lean seat does NOT hold ${name} — ${why}`);
}

const mustBeRelocated: readonly [string, string][] = [
  ["describe_image", "worker-side (final ruling, supersedes the plan's §7 'kept'): the seat's only taint ingress becomes the delegation return stamp"],
  ["read_channel", "own-conversation read — the wake envelope already renders the backscroll"],
  ["read_thread", "own-conversation read"],
  ["read_slack_channel", "per-surface read pair"],
  ["read_slack_thread", "per-surface read pair"],
  ["read_notion_page", "cross-surface read"],
  ["read_linear_issue", "cross-surface read"],
  ["read_file_upload", "worker-side; the durable attachment mirror resolves the id cross-process"],
  ["get_pr_feedback", "PR read"],
  ["check_pr_status", "PR read"],
  ["set_state", "ticket mutation — belongs to the worker handling the task"],
  ["assign", "ticket mutation"],
  ["purge_memory", "memory erasure runs worker-side"],
  ["create_routine", "routine authoring"],
  ["edit_routine", "routine authoring"],
  ["declare_webhook", "webhook plane"],
  ["rotate_webhook", "webhook plane"],
  ["link_identity", "identity linking (a DM seat keeps it — it cannot delegate; a channel seat routes it)"],
  ["connector", "connector discovery/offer"],
  ["connection_search", "connector discovery"],
  ["request_access", "access plane"],
  ["create_agent", "config plane"],
  ["aws", "worker-only from conversation; fires keep it via granted capabilities"],
  ["explain_permission", "worker kit — the answer travels back in the worker's result"],
  ["web_search", "provider-executed read"],
  ["load_skill", "worker-side"],
  ["session_cost", "telemetry read"],
  ["query_analytics", "analytics read"],
  ["memory_admin_list", "admin read"],
  ["fresh_eyes_review", "worker-only: its caller is the worker authoring a change, never the seat"],
];
for (const [name, why] of mustBeRelocated) {
  ok(!allowedOnLeanSeat(name), `lean seat does NOT hold ${name} — ${why}`);
}
ok(!allowedOnLeanSeat("some_tool_nobody_declared"), "DEFAULT DENY: an unknown name is withheld, so the roster cannot rot open as tools are added");
ok(!allowedOnLeanSeat("notion__search") && !allowedOnLeanSeat("notion__create_page"), "runtime-injected connector OPS are withheld too — operations are worker/DM business, and the seat cannot even discover them (connection_search is relocated)");

const surfaceNames = new Set<string>([...Object.keys(WINDOW_GATED_TOOLS), ...WINDOW_UNGATED_TOOLS, "ask_question", "todo"]);
for (const name of LEAN_SEAT_TOOLS) {
  ok(surfaceNames.has(name), `lean-roster name ${name} carries a window-gate posture`);
}

const withheldList = withheldFromLeanSeat(WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS);
ok(withheldList.includes("purge_memory") && withheldList.includes("aws") && withheldList.includes("describe_image"), "withheldFromLeanSeat lists the relocated names (the audit row's content)");
ok(!withheldList.includes("reply") && !withheldList.includes("agent"), "withheldFromLeanSeat excludes the roster");
ok(withheldList.join(",") === [...withheldList].sort().join(","), "withheldFromLeanSeat is sorted (a stable, diffable audit row)");

ok(allowedOnWorkerSeat("ask_question"), "🔴 OPE-565: a delegated WORKER holds ask_question again — the question posts AND the room's answer routes back to the child");
ok(allowedOnLeanSeat("ask_question"), "…and the INTERACTIVE seat still holds it, as it always did");
for (const name of ["bash", "read_file", "write_file", "post_file", "web_search", "return_result", "complete_task", "reply", "final_output", "notion__search", "some_tool_nobody_declared"]) {
  ok(allowedOnWorkerSeat(name), `the worker keeps ${name} — this set is ALLOW-by-default, an exclusion of BROKEN verbs, never a narrowing of the worker's kit`);
}
ok(
  WORKER_WITHHELD_TOOLS.size === 0,
  `the withheld set is EMPTY (got "${[...WORKER_WITHHELD_TOOLS].join(",")}") — it grows only for a structurally-unanswerable verb, never for 'tools a worker shouldn't use' (that is the lean roster's question, or the consequence registry's)`,
);
ok(
  WINDOW_UNGATED_TOOLS.has("ask_question"),
  "ask_question stays a MOUNT-time ungated row: the narrowing is per-wake, and a grain row is not even available — manifest rule 4 needs a windowGatedKit to re-provide a framework tool, and eve exports no ask_question definition to re-provide",
);

function makeToolset(): Record<string, { description: string; execute: () => unknown }> {
  const names = [
    ...Object.keys(WINDOW_GATED_TOOLS),
    ...WINDOW_UNGATED_TOOLS,
    "ask_question",
    "todo",
    "notion__search",
    "notion__create_page",
    "browser_navigate",
    "final_output",
  ];
  const out: Record<string, { description: string; execute: () => unknown }> = {};
  for (const name of names) out[name] = { description: `${name} tool`, execute: () => ({ ok: true }) };
  return out;
}

{
  const toolset = makeToolset();
  const before = { ...toolset };
  const removed = restrictToolsetForLeanSeat(toolset);
  const survivors = new Set(Object.keys(toolset));
  const expected = new Set<string>([...[...LEAN_SEAT_TOOLS].filter((k) => k in before), "final_output"]);
  ok(
    survivors.size === expected.size && [...expected].every((k) => survivors.has(k)),
    `the lean toolset is EXACTLY the conversational roster + the harness sink (got ${[...survivors].sort().join(",")})`,
  );
  ok(removed.length > 0 && removed.every((k) => !survivors.has(k)), "restrictToolsetForLeanSeat reports every removed name");
  ok(removed.join(",") === [...removed].sort().join(","), "the removed list is sorted");
  ok([...survivors].every((k) => toolset[k] === before[k]), "surviving tool OBJECTS keep their identity — eve keys approvals in a WeakMap on them");
  ok(!survivors.has("browser_navigate") && !survivors.has("notion__search"), "runtime-injected families are removed by default-deny (no static table could enumerate them)");
}

{
  const toolset = makeToolset();
  const before = { ...toolset };
  const removed = restrictToolsetForWorkerSeat(toolset);
  ok(removed.length === 0, `🔴 OPE-565: the worker subtraction removes NOTHING (got "${removed.join(",")}") — an empty set means a delegated worker's assembled kit passes through untouched`);
  ok(Object.keys(toolset).length === Object.keys(before).length, "…and the toolset keeps every name it arrived with — a worker's wide hands are the design");
  ok("ask_question" in toolset, "…including ask_question itself, which is the name that left the set");
  ok(Object.keys(toolset).every((k) => toolset[k] === before[k]), "surviving tool OBJECTS keep their identity — eve keys approvals in a WeakMap on them");
  const armed = makeToolset();
  const removedArmed = restrictToolsetForWorkerSeat(armed, new Set(["ask_question", "bash"]));
  ok(removedArmed.join(",") === "ask_question,bash", `restrictToolsetForWorkerSeat still deletes what it is given, sorted (got "${removedArmed.join(",")}")`);
  ok(!("ask_question" in armed) && !("bash" in armed), "…and the named tools really leave the toolset");
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

function inSession<T>(fn: () => T): T {
  return contextStorage.run(new ContextContainer(), fn);
}

inSession(() => {
  setNativeDelegationSeat("allow");
  setLeanSeatWake(true);
  ok(currentLeanSeatPosture() === "lean", "a marked wake resolves LEAN inside a live session");
  const toolset = makeToolset();
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok(!("purge_memory" in toolset) && !("read_channel" in toolset) && !("aws" in toolset) && !("describe_image" in toolset) && !("web_search" in toolset), "projectToolSet withholds the relocated names on a lean wake");
  ok("reply" in toolset && "no_reply" in toolset && "agent" in toolset && "spawn_thread_session" in toolset && "todo" in toolset, "projectToolSet keeps the conversational roster");
  ok("final_output" in toolset, "the harness sink survives");
});

inSession(() => {
  setNativeDelegationSeat("allow");
  ok(currentLeanSeatPosture() === "full", "the slot's default is FULL — the fail direction that can never strand a seat");
  const toolset = makeToolset();
  const before = { ...toolset };
  projectToolSet(toolset as unknown as Record<string, unknown>);
  eq(removedBy(before, toolset), ["task_update"], "an unmarked wake's toolset is unchanged by OPE-301 — its only loss is the child-only `task_update` (OPE-564)");
});

{
  ok(currentLeanSeatPosture() === "full", "outside an eve context the posture read fails soft to full");
  const toolset = makeToolset();
  const beforeSet = { ...toolset };
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok(!("agent" in toolset), "…while the delegation verdict fails CLOSED outside a context (unclassified ⇒ deny)");
  eq(removedBy(beforeSet, toolset), ["agent", ...TASK_FAMILY].sort(), "a context-less projectToolSet call withholds nothing from the LEAN plane — only the fail-closed `agent` and the task family that follows it (OPE-564)");
}

inSession(() => {
  markJobSession();
  setJobWakeEscalated(false);
  setLeanSeatWake(true);
  const toolset = makeToolset();
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok("read_channel" in toolset && "record_job_state" in toolset, "a restricted JOB wake keeps the job kit's reads + ledger verbs — the lean filter never runs over it");
  ok(!("agent" in toolset) && !("spawn_thread_session" in toolset), "…and holds NO delegation verb (the job kit's own rule wins)");
  ok([...JOB_WAKE_TOOLS].filter((k) => k in makeToolset()).every((k) => k in toolset), "every job-kit name present in the assembled set survived — the lean filter subtracted nothing from the job wake");
});

inSession(() => {
  setNativeDelegationSeat("allow");
  setWorkerWake(true);
  ok(currentWorkerWake(), "a marked wake resolves as a WORKER inside a live session");
  const toolset = makeToolset();
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok("ask_question" in toolset, "🔴 OPE-565: projectToolSet leaves ask_question ON a worker wake — the room's answer now routes back to the child, so there is nothing to withhold");
  ok("bash" in toolset && "write_file" in toolset && "post_file" in toolset && "web_search" in toolset && "purge_memory" in toolset, "…and the worker keeps everything else — this is NOT a second lean cut");
});

inSession(() => {
  setNativeDelegationSeat("allow");
  ok(!currentWorkerWake(), "the worker slot's default is FALSE");
  const toolset = makeToolset();
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok("ask_question" in toolset, "an unmarked (non-worker) wake keeps ask_question");
});

{
  const hookSrc = readFileSync(new URL("../agent/hooks/lean-seat.ts", import.meta.url), "utf8");
  ok(/setWorkerWake\(grainOf\([\s\S]{0,80}?\) === "task"\)/.test(hookSrc), "hooks/lean-seat.ts classifies the worker bit off grain `task`");
  ok(/setWorkerWake\(false\)/.test(hookSrc), "…written CLEAR-FIRST, so no early return can leave a stale verdict");
}

{
  const persona = (token: string) => renderSupervisorPersona({ channel: { kind: "unified", continuationToken: token } } as never);
  const workerText = persona("unified:oe-dom:acme:win:t/C1/1721018940.000100:oe-sup:g3");
  const seatText = persona("unified:oe-dom:acme:oe-sup:g3");
  ok(workerText.length > 0 && seatText.length > 0, "fixture sanity: the persona renders for BOTH a task token and a standing one");
  ok(
    !/cannot receive an answer/i.test(workerText),
    "🔴 OPE-565: a WORKER's valve no longer claims the answer cannot reach it — that sentence is false now, and a prompt must never tell the model something it can disprove",
  );
  ok(workerText.includes("return_result"), "…the report verb is still named, because it is still the route that always reaches a person");
  ok(workerText.indexOf("return_result") < workerText.indexOf("ask_question"), "…and named FIRST — the valve steers on cost, and a question parks the worker while a report does not");
  ok(workerText.includes("ask_question"), "…while `ask_question` is named as the real second route it now is");
  ok(seatText.includes("ask_question") && !seatText.includes("return_result"), "the interactive seat's valve is unchanged — it still asks the room, and never names a worker verb");
}

const windowSeatCtx = () => ({
  channel: { kind: "slack", continuationToken: "unified:oe-dom:acme:oe-sup:g3" },
  session: { id: "sess-lean", auth: { current: { attributes: { channel_id: "C1" }, principalId: "U1", principalType: "slack-user" } } },
});
const dmSeatCtx = () => ({
  channel: { kind: "slack", continuationToken: "D0PERSONAL:1721018940.000100" },
  session: { id: "sess-dm", auth: { current: { attributes: { channel_id: "D0PERSONAL", oe_grain: "standing" }, principalId: "U1", principalType: "slack-user" } } },
});
const fireSeatCtx = () => {
  const c = windowSeatCtx();
  (c.session.auth.current.attributes as Record<string, string>)[FIRE_UNATTENDED_ATTR] = "true";
  return c;
};

ok(canDelegateFromSeat(windowSeatCtx() as never), "fixture sanity: the window-token seat CAN delegate");
ok(!canDelegateFromSeat(dmSeatCtx() as never), "fixture sanity: the DM-shaped seat CANNOT delegate (native token, no window)");

let refused: string | undefined;
try {
  await grainBackstopAtExecute("purge_memory", ["task", "native", "standing", "thread"], windowSeatCtx() as never);
} catch (err) {
  refused = String(err);
}
ok(refused !== undefined, "the execute backstop refuses a relocated name on a delegating conversational seat even when the grain matrix would admit it");
ok(refused?.includes("talks and delegates") === true && refused?.includes("agent") === true, "the refusal states the seat's shape and names the delegation route — a clean refusal, never a crash");

let rosterVerbThrew = false;
try {
  await grainBackstopAtExecute("agent", ["standing", "thread"], windowSeatCtx() as never);
} catch {
  rosterVerbThrew = true;
}
ok(!rosterVerbThrew, "the backstop lets a roster verb through on a lean seat");

let dmSeatThrew = false;
try {
  await grainBackstopAtExecute("purge_memory", ["task", "native", "standing", "thread"], dmSeatCtx() as never);
} catch {
  dmSeatThrew = true;
}
ok(!dmSeatThrew, "a NON-delegating standing seat is untouched by the lean backstop — it keeps the verbs it cannot delegate");

let fireThrew = false;
try {
  await grainBackstopAtExecute("purge_memory", ["task", "native", "standing", "thread"], fireSeatCtx() as never);
} catch {
  fireThrew = true;
}
ok(!fireThrew, "a stamped unattended FIRE is untouched by the lean backstop — fires keep their own posture");

const staleInitiatorSeatCtx = () => ({
  channel: { kind: "slack", continuationToken: "unified:oe-dom:acme:oe-sup:g3" },
  session: {
    id: "sess-stale-initiator",
    auth: {
      current: { principalId: "U1", principalType: "slack-user" },
      initiator: { attributes: { channel_id: "C1", [FIRE_UNATTENDED_ATTR]: "true" }, principalId: "U1" },
    },
  },
});
let staleRefused: string | undefined;
try {
  await grainBackstopAtExecute("purge_memory", ["task", "native", "standing", "thread"], staleInitiatorSeatCtx() as never);
} catch (err) {
  staleRefused = String(err);
}
ok(staleRefused !== undefined, "a delivery with NO `current` attributes does NOT inherit the session-opening fire stamp — the posture fallback fails NARROW (OPE-421)");

let currentFireThrew = false;
try {
  await grainBackstopAtExecute("purge_memory", ["task", "native", "standing", "thread"], fireSeatCtx() as never);
} catch {
  currentFireThrew = true;
}
ok(!currentFireThrew, "…while a fire stamp on THIS delivery's own `current` still keeps the fire's posture");

const standingWorkerOnly = workerOnlyTools("standing");
ok(standingWorkerOnly.includes("purge_memory") && standingWorkerOnly.includes("aws") && standingWorkerOnly.includes("describe_image") && standingWorkerOnly.includes("read_channel"), "the worker-capability index counts the relocated tools as worker-only from a delegating standing seat");
ok(!standingWorkerOnly.includes("reply") && !standingWorkerOnly.includes("update_status"), "…and never the seat's own roster verbs");
ok(standingWorkerOnly.length >= 60, `the index grew to the relocated surface (${standingWorkerOnly.length} worker-only tools — the roster cut, seen from the routing table)`);

const leanPreview = approvalPreviewFor("standing", undefined, undefined, undefined, "agent");
ok(!leanPreview.member.includes("purge_memory") && leanPreview.elsewhere.includes("purge_memory"), "a delegating seat's approval preview moves `purge_memory` to elsewhere (a worker holds it; the card is unchanged)");
ok(leanPreview.member.length === 0 || leanPreview.member.every((t) => allowedOnLeanSeat(t)), "a delegating seat's preview only claims verbs the lean roster actually holds");
const dmPreview = approvalPreviewFor("standing", undefined, undefined, undefined, "none");
ok(dmPreview.member.includes("purge_memory"), "a NON-delegating standing seat's preview still holds `purge_memory` — the preview never contradicts the filter");

console.log(`\n✓ lean-seat (OPE-301 + the OPE-420 worker subtraction): ${n} assertions passed (posture truth table, roster membership, toolset filter, live-context wiring incl. job mutual-exclusion, execute backstop, derived surfaces)\n`);
