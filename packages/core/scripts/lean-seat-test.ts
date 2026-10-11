import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-lean-seat-")), "ops.sqlite3");

import { LEAN_SEAT_TOOLS, WORK_FORWARD_TOOL, WORK_SESSION_TOOLS, allowedOnLeanSeat, resolveLeanSeatPosture, restrictToolsetForLeanSeat, restrictToolsetForWorkSession, withheldFromLeanSeat } from "../agent/access/lean-seat.js";
import { setLeanSeatWake, currentLeanSeatPosture } from "../agent/access/lean-seat-state.js";
import { WORKER_WITHHELD_TOOLS, allowedOnWorkerSeat, chatArmGrain, restrictToolsetForWorkerSeat } from "../agent/access/worker-seat.js";
import { setWorkerWake, currentWorkerWake } from "../agent/access/worker-seat-state.js";
import { renderSupervisorPersona } from "../agent/instructions/access.js";
import { markJobSession, setJobWakeEscalated } from "../agent/access/job-session-state.js";
import { HARNESS_INTERNAL_TOOLS, allowedOnRestrictedJobWake } from "../agent/access/job-posture.js";
import { JOB_WAKE_TOOLS, WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { projectToolSet } from "../agent/access/untrusted-projection.js";
import { setNativeDelegationSeat } from "../agent/access/native-delegation-state.js";
import { grainBackstopAtExecute } from "../agent/access/window-gated.js";
import { workerOnlyTools } from "../agent/access/worker-capabilities.js";
import { approvalPreviewFor } from "../agent/access/approval-preview.js";
import { canDelegateFromSeat } from "../agent/access/delegation-mount.js";
import { FIRE_UNATTENDED_ATTR } from "../agent/identity/binding.js";
import { grantBorrowToolName, isGrantToolName } from "../agent/operational/credential-grant-rows.js";
import { parseQualifiedToolName } from "../agent/access/consequence.js";

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

const TASK_FAMILY = ["task_cancel", "task_wait"] as const;

const GRANT_TOOL = grantBorrowToolName("rowan", "notion", "notion_fetch_report");

const GRANT_DECOYS = [
  "grant__rowan",
  "grant__a__b__c",
  "grant__Rowan__read_page",
  "grant__rowan__read-page",
  "grants__rowan__read_page",
  "notion__grant__read",
] as const;

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
for (const name of ["agent", "spawn_thread_session", "complete_thread"]) {
  ok(allowedOnLeanSeat(name), `the lean roster keeps the delegation/lifecycle verb ${name} (the grain matrix still decides where it resolves)`);
}
for (const name of ["ask_question"]) {
  ok(!allowedOnLeanSeat(name), `🔴 the lean roster still keeps ${name} — a standing seat that parks a turn stops answering everybody else in the room`);
  ok(!LEAN_SEAT_TOOLS.has(name), `…and ${name} is gone from the roster by NAME, not merely failing some other default`);
  ok(workerOnlyTools("standing").includes(name), `…while the seat is TOLD to route ${name}: without the index line it can only refuse a job that needs it`);
}
ok(allowedOnLeanSeat("final_output"), "the lean roster keeps eve's structured-output sink (a lean turn must still be able to return)");

for (const name of ["task_cancel"]) {
  ok(allowedOnLeanSeat(name), `OPE-583: the lean roster keeps ${name} — the seat can stop work it itself delegated`);
  ok(LEAN_SEAT_TOOLS.has(name), `${name} is a NAMED LEAN_SEAT_TOOLS member, not merely surviving on a different default`);
}
ok(allowedOnLeanSeat("task_wait"), "🔴 OPE-2254: a delegating seat HOLDS task_wait — eve injects it and instructs it by name, so a per-wake filter that removed it would leave the model told to call a tool it does not have");
ok(HARNESS_INTERNAL_TOOLS.has("task_wait"), "…and it survives as a HARNESS-INTERNAL name, which is what makes the same exemption apply at every per-wake filter that shares this seam");
ok(!LEAN_SEAT_TOOLS.has("task_wait"), "…and NOT as a lean roster row: the roster is the seat's own kit, and this verb is eve's turn plumbing");
ok(!allowedOnLeanSeat("bash"), "…and the negative control holds: `bash` is still refused, so the filter is default-deny rather than open");
for (const [name, why] of [
  ["task_peek", "DELETED by eve 0.40.0 — the worker's output now arrives inline on the settlement notification, so no seat-side read verb exists to grant"],
  ["task_sleep", "DELETED by eve 0.42.0 — task-mode parents rely on lifecycle notifications instead of model-paced waits"],
  ["task_update", "DELETED by eve 0.54.1 — the tool and its child-to-parent progress callbacks are gone, and the release ships no replacement verb"],
] as const) {
  ok(!allowedOnLeanSeat(name), `lean seat does NOT hold ${name} — ${why}`);
  ok(!LEAN_SEAT_TOOLS.has(name), `${name} is NOT a named LEAN_SEAT_TOOLS member — the table tracks what the pinned eve mounts`);
}

for (const name of ["read_channel", "read_thread"]) {
  ok(allowedOnLeanSeat(name), `OPE-829: the lean roster holds ${name} — a seat with no reader can only guess or deny a referent it cannot see`);
  ok(LEAN_SEAT_TOOLS.has(name), `${name} is a NAMED LEAN_SEAT_TOOLS member, not merely surviving on a different default`);
}

const mustBeRelocated: readonly [string, string][] = [
  ["describe_image", "worker-side (final ruling, supersedes the plan's §7 'kept'): the seat's only taint ingress becomes the delegation return stamp"],
  ["read_notion_page", "cross-surface read"],
  ["read_linear_issue", "cross-surface read"],
  ["read_file_upload", "worker-side; the durable attachment mirror resolves the id cross-process"],
  ["get_pr_feedback", "PR read"],
  ["read_github_issue", "cross-surface read (OPE-2305)"],
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
ok(
  !withheldList.some((n) => n.startsWith("grant__")),
  "withheldFromLeanSeat names no grant tool — grant names are minted at resolve time, so they are in neither the gated table nor the ungated set this list is derived from. The seat's actual withholding of them is asserted against `allowedOnLeanSeat` in §2a",
);

ok(!allowedOnLeanSeat(GRANT_TOOL), `a mounted grant tool (${GRANT_TOOL}) is NOT held on a lean seat — the seat delegates, and the worker of this conversation holds it`);
ok(!allowedOnLeanSeat(GRANT_TOOL, true), "…nor on a DM seat: the DM carve-in is five named verbs, and a grant is not one of them");
ok(!LEAN_SEAT_TOOLS.has(GRANT_TOOL), "…and not by a name row either — a grant name is minted per grant row and can sit in no static roster");
ok(
  !allowedOnLeanSeat(grantBorrowToolName("someone_else", "linear", "read_issue")),
  "…the withholding is the DEFAULT-DENY rule rather than a fixture: a different owner, connector and tool are withheld too",
);
ok(
  !allowedOnLeanSeat(grantBorrowToolName("rowan", "notion", "create_page")),
  "…and it is TIER-BLIND in the same direction — no name in the namespace is admitted, whatever verb it spells",
);
ok(allowedOnLeanSeat("reply") && allowedOnLeanSeat("agent"), "control — the roster's own names are still admitted, so the refusals above discriminate");

ok(
  !allowedOnLeanSeat("post_message") && !allowedOnLeanSeat("dm_person"),
  "the sibling chat WRITE verbs still SHED — a worker holds them, so the seat routes; a granted tool is now the same shape",
);

for (const decoy of GRANT_DECOYS) {
  ok(!isGrantToolName(decoy), `isGrantToolName refuses "${decoy}" — the match is structural, never a prefix test`);
  ok(!allowedOnLeanSeat(decoy), `…and the lean roster still DENIES "${decoy}" — default-deny survives the new arm`);
  ok(!allowedOnLeanSeat(decoy, true), `…on a DM seat as well as a channel seat ("${decoy}")`);
}
ok(!allowedOnLeanSeat("grant"), "the bare namespace word is not a tool name and is denied");
ok(!allowedOnLeanSeat("some_tool_nobody_declared"), "…and an ordinary unknown name is STILL denied after the namespace arm landed");

for (const name of [GRANT_TOOL, grantBorrowToolName("a_b", "c_d", "e_f")]) {
  const parsed = parseQualifiedToolName(name);
  ok(parsed?.namespace === "grant", `S0 parses "${name}" as the reserved grant namespace — the roster admits no name S0 cannot read`);
  ok((parsed?.verb.length ?? 0) > 0, `…and yields a verb for "${name}", so the name has a statable tier`);
}
for (const decoy of GRANT_DECOYS.filter((d) => d.startsWith("grant__") && !d.includes("__R") && !d.includes("-"))) {
  ok(parseQualifiedToolName(decoy) === undefined, `S0 refuses to parse the malformed reserved name "${decoy}" — it would classify destructive, and this roster denies it too`);
}

ok(allowedOnWorkerSeat("ask_question"), "🔴 OPE-565: a delegated WORKER holds ask_question again — the question posts AND the room's answer routes back to the child");
ok(!allowedOnLeanSeat("ask_question"), "the INTERACTIVE seat still holds ask_question — parking a standing turn on a person stops the room being answered");
for (const name of ["bash", "read_file", "write_file", "post_file", "web_search", "describe_image", "complete_thread", "reply", "final_output", "notion__search", "some_tool_nobody_declared"]) {
  ok(allowedOnWorkerSeat(name), `the worker keeps ${name} — this set is ALLOW-by-default, an exclusion of BROKEN verbs, never a narrowing of the worker's kit`);
}
ok(!allowedOnWorkerSeat("stand_down"), "🔴 OPE-877: a worker does NOT hold stand_down — it marks the DELEGATING SEAT's engagement row (the worker inherits the seat's binding), so a worker could make its own parent stop following a channel the worker never followed");
ok(allowedOnLeanSeat("stand_down"), "…and the SEAT still holds stand_down — it is the only session a human can address 'stop following this' to");
ok(!allowedOnWorkerSeat("no_reply"), "🔴 OPE-877: a worker does NOT hold no_reply — it discharges a REPLY obligation a worker does not have, and on the native route the worker's last message IS its report, so a turn ending in silence hands the seat nothing");
ok(allowedOnLeanSeat("no_reply"), "…and the SEAT still holds no_reply — judged silence is a seat's normal output");
for (const name of ["update_status", "reply", "edit_reply", "react"]) {
  ok(allowedOnWorkerSeat(name), `the worker subtraction does NOT take ${name} — neither admission test admits it`);
}
ok(!allowedOnWorkerSeat("read_channel"), "🔴 OPE-929: a worker does NOT hold read_channel — it is the CHAT surface's verb on the chat credential, and a worker holds the WORK surface under the domain's work grant");
ok(allowedOnLeanSeat("read_channel"), "…and the SEAT still holds read_channel — the recovery read is what stops it inventing a referent it cannot see (OPE-829)");
ok(!allowedOnWorkerSeat("read_thread"), "🔴 OPE-929: a worker does NOT hold read_thread — same plane split as read_channel");
ok(allowedOnLeanSeat("read_thread"), "…and the SEAT still holds read_thread");
ok(
  allowedOnWorkerSeat("request_credential_grant"),
  "🔴 OPE-1343: a delegated WORKER holds request_credential_grant again — the seat is a router, so a seat-only ask verb had no reachable caller and prod never wrote a `grant.*` row. The scope key it writes is the ROOT seat's session (tools/request_credential_grant.ts `grantScopeKey`), never the worker's own",
);
ok(
  !allowedOnLeanSeat("request_credential_grant"),
  "🔴 OPE-2023: the SEAT no longer holds the ask. It is worker work like every other doing verb — the seat hands \"use my own account\" to a task, the task asks, and the grant still binds to the conversation (tools/request_credential_grant.ts `grantScopeKey`). A seat that held it would raise an ask for a tool it could never meet, since the granted tool mounts on the worker too",
);
ok(
  [...WORKER_WITHHELD_TOOLS].sort().join(",") === "no_reply,read_channel,read_thread,stand_down",
  `the withheld set is EXACTLY no_reply,read_channel,read_thread,stand_down (got "${[...WORKER_WITHHELD_TOOLS].sort().join(",")}") — it grows only for a verb that is structurally wrong on a worker by test (A), (B) or (C), never for 'tools a worker shouldn't use' (that is the lean roster's question, or the consequence registry's)`,
);
ok(chatArmGrain("task"), "🔴 OPE-1014: the vendor container reads' CHAT arm mounts on the `task` grain — the one grain this subtraction leaves without a generic container read");
for (const grain of ["standing", "native", "thread"] as const) {
  ok(chatArmGrain(grain) === false, `a ${grain} conversational seat does NOT hold the vendor chat arm — it reads its own container through read_channel/read_thread`);
}
ok(
  allowedOnLeanSeat("read_channel") && allowedOnLeanSeat("read_thread"),
  "…and the grains that lose the vendor chat arm provably KEEP the generic pair that replaces it (the lean roster holds both)",
);
for (const name of ["read_notion_page", "read_notion_comments", "read_linear_issue"]) {
  ok(
    WINDOW_UNGATED_TOOLS.has(name),
    `${name} stays a MOUNT-time UNGATED row — the grain decides its CHAT arm inside its own resolver, while its WORK arm mounts on every grain, so a WINDOW_GATED_TOOLS row would claim an absence that is not true`,
  );
}

for (const name of ["no_reply", "stand_down"]) {
  ok(WINDOW_UNGATED_TOOLS.has(name), `${name} stays a MOUNT-time ungated row — the worker narrowing is per-wake, not a grain matrix`);
}
ok(
  WINDOW_UNGATED_TOOLS.has("ask_question"),
  "ask_question stays a MOUNT-time ungated row: the narrowing is per-wake, and the tool is OE's own static mount of eve's opt-in definition (packages/core/agent/tools/ask_question.ts), so a grain matrix would have to come from a windowGatedKit resolver that nothing provides",
);
ok(
  existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "tools", "ask_question.ts")),
  "🔴 OPE-2254: packages/core/agent/tools/ask_question.ts EXISTS — eve stopped default-mounting the name at 0.65, so an app that authors nothing mounts nothing, and every claim above about a worker holding it would be false",
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
    GRANT_TOOL,
    ...GRANT_DECOYS,
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
  const expected = new Set<string>([...[...LEAN_SEAT_TOOLS, ...HARNESS_INTERNAL_TOOLS].filter((k) => k in before)]);
  ok(
    survivors.size === expected.size && [...expected].every((k) => survivors.has(k)),
    `the lean toolset is EXACTLY the conversational roster + the harness-internal names (got ${[...survivors].sort().join(",")})`,
  );
  ok(!survivors.has(GRANT_TOOL), `this chat's mounted grant (${GRANT_TOOL}) is REMOVED from a lean seat's toolset — the seat delegates the lent tool to a worker`);
  ok(removed.includes(GRANT_TOOL), "…and it is REPORTED as removed, so the audit row names what the seat gave up rather than losing it silently");
  ok(GRANT_DECOYS.every((d) => !survivors.has(d)), `every grant look-alike is removed by default-deny (survivors: ${[...survivors].sort().join(",")})`);
  ok(removed.length > 0 && removed.every((k) => !survivors.has(k)), "restrictToolsetForLeanSeat reports every removed name");
  ok(removed.join(",") === [...removed].sort().join(","), "the removed list is sorted");
  ok([...survivors].every((k) => toolset[k] === before[k]), "surviving tool OBJECTS keep their identity — eve keys approvals in a WeakMap on them");
  ok(!survivors.has("browser_navigate") && !survivors.has("notion__search"), "runtime-injected families are removed by default-deny (no static table could enumerate them)");
}

{
  const toolset = makeToolset();
  const before = { ...toolset };
  const removed = restrictToolsetForWorkerSeat(toolset);
  ok(
    removed.join(",") === "ask_domain,confirm_link,link_identity,no_reply,read_channel,read_thread,revoke_credential_grant,stand_down,unlink_identity",
    `🔴 OPE-877 + OPE-929 + OPE-1343 + OPE-1660 + OPE-2452: the worker subtraction removes EXACTLY the four verbs that are BROKEN on a worker (no_reply, read_channel, read_thread, stand_down) and the five the SEAT SHAPE reserves (the DM carve-in), sorted (got "${removed.join(",")}")`,
  );
  ok(
    !("link_identity" in toolset) && !("confirm_link" in toolset) && !("unlink_identity" in toolset) && !("revoke_credential_grant" in toolset) && !("ask_domain" in toolset),
    "🔴 OPE-1660: the DM carve-in verbs really leave a worker's assembled toolset — the carve-in is CONTAINMENT now, not only a routing rule the index obeys",
  );
  ok(!("no_reply" in toolset) && !("stand_down" in toolset), "…and both really leave the assembled toolset — ABSENCE, so the worker is never told it lost a verb and never retries into a refusal");
  ok(
    !("read_channel" in toolset) && !("read_thread" in toolset),
    "🔴 OPE-929: the abstract chat READS really leave a worker's assembled toolset — the chat API is the SEAT's vocabulary",
  );
  ok(Object.keys(toolset).length === Object.keys(before).length - 9, "…and NOTHING ELSE leaves — a worker's wide hands are still the design");
  ok("ask_question" in toolset, "…including ask_question itself, which is the name that left the set (OPE-565)");
  ok("reply" in toolset && "update_status" in toolset && "bash" in toolset && "post_file" in toolset, "…and the verbs OPE-877 checked alongside them stay: a worker still posts and still shows progress");
  ok(Object.keys(toolset).every((k) => toolset[k] === before[k]), "surviving tool OBJECTS keep their identity — eve keys approvals in a WeakMap on them");
  const armed = makeToolset();
  const removedArmed = restrictToolsetForWorkerSeat(armed, new Set(["ask_question", "bash"]));
  ok(removedArmed.join(",") === "ask_question,bash", `restrictToolsetForWorkerSeat still deletes what it is given, sorted (got "${removedArmed.join(",")}")`);
  ok(!("ask_question" in armed) && !("bash" in armed), "…and the named tools really leave the toolset");
  ok(
    "no_reply" in armed && "stand_down" in armed && "read_channel" in armed && "read_thread" in armed,
    "…while the DEFAULT set's four names survive an injected set that does not name them — the function reads its argument, never a constant",
  );
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
  ok(!("purge_memory" in toolset) && !("read_notion_page" in toolset) && !("aws" in toolset) && !("describe_image" in toolset) && !("web_search" in toolset), "projectToolSet withholds the relocated names on a lean wake");
  ok("reply" in toolset && "no_reply" in toolset && "agent" in toolset && "spawn_thread_session" in toolset, "projectToolSet keeps the conversational roster");
  ok(!("todo" in toolset) && !("ask_question" in toolset), "projectToolSet still hands a lean seat eve's turn plumbing — a standing seat must neither park a turn nor keep a planning scratch pad");
  ok("read_channel" in toolset && "read_thread" in toolset, "projectToolSet KEEPS the recovery reads on a lean wake (OPE-829)");
  ok("final_output" in toolset, "the harness sink survives");
  ok(!(GRANT_TOOL in toolset), `projectToolSet WITHHOLDS this chat's mounted grant on a lean wake (${GRANT_TOOL}) — the seat hands a lent tool to a worker of this same conversation`);
  ok(
    GRANT_DECOYS.every((d) => !(d in toolset)),
    "…and the seam still removes every grant look-alike — the arm reaches the seam as a structural match, not as a prefix",
  );
});

inSession(() => {
  setNativeDelegationSeat("allow");
  ok(currentLeanSeatPosture() === "full", "the slot's default is FULL — the fail direction that can never strand a seat");
  const toolset = makeToolset();
  const before = { ...toolset };
  projectToolSet(toolset as unknown as Record<string, unknown>);
  eq(removedBy(before, toolset), ["ask_room", "cancel_work", "work"], "an unmarked wake's toolset is unchanged by OPE-301 except the three-tier `work` verb, its stop `cancel_work` (OPE-2338, D15) and the work-session child's question card `ask_room` (OPE-2340), and there is no longer a child-only verb to lose (eve 0.54.1 removed `task_update`)");
  ok(GRANT_DECOYS.every((d) => d in toolset), "…and every grant look-alike SURVIVES an unmarked wake — nothing but the lean filter removes them");
});

{
  ok(currentLeanSeatPosture() === "full", "outside an eve context the posture read fails soft to full");
  const toolset = makeToolset();
  const beforeSet = { ...toolset };
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok(!("agent" in toolset), "…while the delegation verdict fails CLOSED outside a context (unclassified ⇒ deny)");
  eq(removedBy(beforeSet, toolset), ["agent", ...TASK_FAMILY, "ask_room", "cancel_work", "work"].sort(), "a context-less projectToolSet call withholds nothing from the LEAN plane — only the fail-closed `agent`, the task family that follows it (OPE-564), and the three-tier `work` verb with its stop `cancel_work` (OPE-2338, D15)");
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
  ok(!(GRANT_TOOL in toolset), "🔴 OPE-1091: a restricted JOB wake WITHHOLDS a granted READ — nobody is in the room, so there is no requester act to spend the owner's credential for");
  ok(!("grant__a__b__c" in toolset), "…and a malformed grant name too — it was already withheld, by the tier arm's fail-closed default");
  ok("notion__search" in toolset, "🔴 NEGATIVE CONTROL: the fire still keeps its connector READS — OPE-1091 took the reserved namespace, not the tier rule (a job that cannot read cannot work)");
});

inSession(() => {
  setNativeDelegationSeat("allow");
  setWorkerWake(true);
  ok(currentWorkerWake(), "a marked wake resolves as a WORKER inside a live session");
  const toolset = makeToolset();
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok(!("no_reply" in toolset), "🔴 OPE-877: projectToolSet REMOVES no_reply on a worker wake — a worker owes its caller a report, not the room a reply, and on the native route a silent turn hands the seat nothing");
  ok(!("stand_down" in toolset), "🔴 OPE-877: projectToolSet REMOVES stand_down on a worker wake — it would mark the DELEGATING SEAT's engagement row, which the worker inherited by binding");
  ok("ask_question" in toolset, "🔴 OPE-565: projectToolSet leaves ask_question ON a worker wake — the room's answer now routes back to the child, so there is nothing to withhold");
  ok("reply" in toolset && "update_status" in toolset, "…and the worker still POSTS and still shows progress — OPE-877 took two verbs, not the conversational family");
  ok("bash" in toolset && "write_file" in toolset && "post_file" in toolset && "web_search" in toolset && "purge_memory" in toolset, "…and the worker keeps everything else — this is NOT a second lean cut");
});

inSession(() => {
  setNativeDelegationSeat("allow");
  ok(!currentWorkerWake(), "the worker slot's default is FALSE");
  const toolset = makeToolset();
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok("ask_question" in toolset, "an unmarked (non-worker) wake keeps ask_question");
  ok("no_reply" in toolset && "stand_down" in toolset, "🔴 an unmarked (non-worker) wake KEEPS no_reply and stand_down — the OPE-877 subtraction is keyed on the worker bit, and its fail direction is toward keeping the tool");
});

{
  const hookSrc = readFileSync(new URL("../agent/hooks/lean-seat.ts", import.meta.url), "utf8");
  ok(/const worker = grainOf\([\s\S]{0,80}?\) === "task";/.test(hookSrc), "hooks/lean-seat.ts classifies the worker bit off grain `task`");
  ok(/setWorkerWake\(worker\);/.test(hookSrc), "…and that ONE verdict is what the worker slot receives");
  ok(/setWorkerWake\(false\)/.test(hookSrc), "…written CLEAR-FIRST, so no early return can leave a stale verdict");
  ok(/setWorkerToolsetIdentity\(worker \?/.test(hookSrc), "…and the evidence identity (OPE-1497) is stamped off the SAME verdict, never a second classification");
  ok(/setWorkerToolsetIdentity\(null\)/.test(hookSrc), "…also written CLEAR-FIRST, so a seat can never inherit a worker's ids");
}

{
  const persona = (token: string, oneshot?: boolean) =>
    renderSupervisorPersona({
      channel: { kind: "unified", continuationToken: token },
      session: {
        auth: {
          current: {
            attributes: oneshot
              ? { oe_oneshot: { taskId: "task_1", callerToken: "unified:oe-dom:acme:oe-sup:g3", callerOrigin: { kind: "slack" } } }
              : {},
          },
        },
      },
    } as never);
  const TASK_TOKEN = "unified:oe-dom:acme:win:t/C1/1721018940.000100:oe-sup:g3";
  const markedText = persona(TASK_TOKEN, true);
  const nativeText = persona(TASK_TOKEN);
  const seatText = persona("unified:oe-dom:acme:oe-sup:g3");
  ok(markedText.length > 0 && nativeText.length > 0 && seatText.length > 0, "fixture sanity: the persona renders for BOTH a task token and a standing one");
  ok(
    !/cannot receive an answer/i.test(nativeText),
    "🔴 OPE-565: a WORKER's valve no longer claims the answer cannot reach it — that sentence is false now, and a prompt must never tell the model something it can test",
  );
  ok(!nativeText.includes("return_result"), "🔴 the worker is NEVER sent at `return_result` — the verb is deleted, so naming it would name nothing");
  ok(markedText === nativeText, "🔴 OPE-1145 item 2: a stale `oe_oneshot` marker changes NOTHING about the persona — the roll-own arm it used to select is gone, so a leftover stamp on a live deployment can reach no second route");
  ok(nativeText.includes("Your LAST message of this session is your report"), "…that worker is pointed at its last message instead, which is what eve carries back");
  for (const [label, workerText] of [["native", nativeText]] as const) {
    ok(workerText.includes("ask_question"), `${label}: \`ask_question\` is named as the real second route it now is`);
    ok(workerText.includes("PARKS this session"), `${label}: …and the COST is stated plainly: a question parks the worker`);
    ok(
      !/until somebody answers/i.test(workerText),
      `🔴 ${label}: the valve does NOT promise an answer — the return leg is undriven, so "parks you until somebody answers" would be a false promise`,
    );
    ok(
      /an answer might not/i.test(workerText),
      `🔴 ${label}: …it says so positively rather than by omission: the worker is told the answer may never arrive, which is what makes the report the steer`,
    );
  }
  ok(!seatText.includes("ask_question") && !seatText.includes("return_result"), "the interactive seat's persona names a verb it does not hold — it replies in the room instead of parking the turn");
  ok(seatText.includes("say so in the room and wait for a person"), "…and it positively says what the seat DOES instead, so the absence above is a replacement rather than a deletion");
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

let grantThrew = false;
try {
  await grainBackstopAtExecute(GRANT_TOOL, ["standing", "thread"], windowSeatCtx() as never);
} catch {
  grantThrew = true;
}
ok(grantThrew, `the backstop REFUSES this chat's mounted grant on a lean seat (${GRANT_TOOL}) — the seam and the backstop read one decision function, so neither admits it`);

let decoyRefusal: string | undefined;
try {
  await grainBackstopAtExecute("grant__a__b__c", ["standing", "thread"], windowSeatCtx() as never);
} catch (err) {
  decoyRefusal = String(err);
}
ok(decoyRefusal !== undefined, "…while a malformed grant name is REFUSED at the backstop — default-deny is intact behind the namespace arm");
ok(decoyRefusal?.includes("talks and delegates") === true, "…with the lean seat's own refusal copy, so the refusal names the right boundary");

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
ok(standingWorkerOnly.includes("purge_memory") && standingWorkerOnly.includes("aws") && standingWorkerOnly.includes("describe_image") && standingWorkerOnly.includes("read_notion_page"), "the worker-capability index counts the relocated tools as worker-only from a delegating standing seat");
ok(!standingWorkerOnly.includes("reply") && !standingWorkerOnly.includes("update_status"), "…and never the seat's own roster verbs");
ok(!standingWorkerOnly.includes("read_channel") && !standingWorkerOnly.includes("read_thread"), "…and the recovery reads have LEFT the worker-only index — the seat holds them directly now (OPE-829)");
ok(standingWorkerOnly.length >= 60, `the index grew to the relocated surface (${standingWorkerOnly.length} worker-only tools — the roster cut, seen from the routing table)`);

const leanPreview = approvalPreviewFor("standing", undefined, undefined, undefined, "agent");
ok(!leanPreview.member.includes("purge_memory") && leanPreview.elsewhere.includes("purge_memory"), "a delegating seat's approval preview moves `purge_memory` to elsewhere (a worker holds it; the card is unchanged)");
ok(leanPreview.member.length === 0 || leanPreview.member.every((t) => allowedOnLeanSeat(t)), "a delegating seat's preview only claims verbs the lean roster actually holds");
const dmPreview = approvalPreviewFor("standing", undefined, undefined, undefined, "none");
ok(dmPreview.member.includes("purge_memory"), "a NON-delegating standing seat's preview still holds `purge_memory` — the preview never contradicts the filter");

ok(
  HARNESS_INTERNAL_TOOLS.size === 2 && HARNESS_INTERNAL_TOOLS.has("final_output") && HARNESS_INTERNAL_TOOLS.has("task_wait"),
  `the harness-internal set is exactly { final_output, task_wait } — eve's structured-output sink and eve's own park verb, which its task system block instructs by name (got ${[...HARNESS_INTERNAL_TOOLS].sort().join(",")})`,
);
for (const name of HARNESS_INTERNAL_TOOLS) {
  ok(allowedOnLeanSeat(name), `the lean filter admits harness-internal "${name}" (a lean turn must still be able to return)`);
  ok(allowedOnRestrictedJobWake(name), `the job filter admits the SAME harness-internal "${name}" — one list, so the two cannot drift`);
}
ok(!allowedOnLeanSeat("final_output_sink") && !allowedOnRestrictedJobWake("final_output_sink"), "a name outside the harness-internal set is withheld by BOTH filters");

ok(
  WORK_SESSION_TOOLS.size === 2 && WORK_SESSION_TOOLS.has("agent") && WORK_SESSION_TOOLS.has("task_cancel"),
  `🔴 the work session's kit is exactly { agent, task_cancel } (got ${[...WORK_SESSION_TOOLS].sort().join(",")})`,
);
{
  const toolset: Record<string, unknown> = { agent: {}, task_cancel: {}, task_wait: {}, final_output: {}, reply: {}, bash: {}, work: {}, connection_execute: {}, ask_question: {} };
  const removed = restrictToolsetForWorkSession(toolset);
  ok(
    JSON.stringify(Object.keys(toolset).sort()) === JSON.stringify(["agent", "final_output", "task_cancel", "task_wait"]),
    `the work-session cut keeps its kit plus the harness internals only (kept ${Object.keys(toolset).sort().join(",")})`,
  );
  ok(removed.includes("reply") && removed.includes("ask_question") && removed.includes("work") && removed.includes("bash"), "🔴 …and withholds `reply`, `ask_question`, `work` and `bash`: W speaks to no room, asks no person, forwards to nobody and touches no sandbox itself");
}
ok(LEAN_SEAT_TOOLS.has(WORK_FORWARD_TOOL) && WORK_FORWARD_TOOL === "work", "the forwarding seat's verb `work` is on the lean seat roster");

console.log(`\n✓ lean-seat (OPE-301 + the OPE-420 worker subtraction): ${n} assertions passed (posture truth table, roster membership, toolset filter, live-context wiring incl. job mutual-exclusion, execute backstop, derived surfaces)\n`);
