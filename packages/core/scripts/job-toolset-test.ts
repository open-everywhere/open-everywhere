import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-job-toolset-")), "ops.sqlite3");

import {
  JOB_FIRE_ATTR,
  JOB_TAINT_ATTR,
  jobFireAttrs,
  jobFireStamped,
  jobTaintStamped,
  resolveJobWakePosture,
  allowedOnRestrictedJobWake,
  restrictToolsetForJobWake,
  withheldFromJobWake,
} from "../agent/access/job-posture.js";
import {
  markJobSession,
  isJobSession,
  setJobWakeEscalated,
  jobWakeEscalated,
  currentJobWakePosture,
} from "../agent/access/job-session-state.js";
import {
  CONVERSATIONAL_ROOT_GRAINS,
  JOB_WAKE_TOOLS,
  WINDOW_GATED_TOOLS,
  WINDOW_UNGATED_TOOLS,
} from "../agent/access/window-gate-manifest.js";
import { TRIGGERED_FIRE_GRAIN } from "../agent/routines/fire-window.js";
import { grantToolName } from "../agent/operational/credential-grant-rows.js";
import { projectToolSet } from "../agent/access/untrusted-projection.js";
import { setNativeDelegationSeat } from "../agent/access/native-delegation-state.js";
import { grainBackstopAtExecute } from "../agent/access/window-gated.js";
import { isJobRoutine, JOB_STATE_MAX_BYTES, type Routine } from "../agent/routines/routine.js";
import { applyJobStateObservation, renderJobMessage } from "../agent/routines/job.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const posture = (jobFire: boolean, jobSession: boolean, humanPrincipal: boolean) =>
  resolveJobWakePosture({ jobFire, jobSession, humanPrincipal });

ok(posture(true, true, false) === "restricted", "a stamped fire on a job session is RESTRICTED (the ordinary case)");
ok(posture(true, false, false) === "restricted", "a stamped fire is RESTRICTED even before the session is known to be a job session (the FIRST fire)");
ok(
  posture(true, true, true) === "restricted",
  "a stamped fire is RESTRICTED even with a human signal present — a scheduler-built delivery cannot carry a principal, so that reading is a bug/forge and must not widen it",
);
ok(posture(false, true, true) === "unrestricted", "ESCALATION: a human addressing the job's thread runs with normal posture");
ok(
  posture(false, true, false) === "restricted",
  "FAIL CLOSED: an unstamped, unattributed wake on a job session is restricted — the unclassifiable shape gets the narrow kit, never the full one",
);
ok(posture(false, false, false) === "unrestricted", "an ordinary session with no job signal is untouched (this feature narrows jobs only)");
ok(posture(false, false, true) === "unrestricted", "an ordinary session with a human is untouched");

ok(jobFireAttrs(true)[JOB_FIRE_ATTR] === "true", "jobFireAttrs stamps the job-fire attribute for a job routine");
ok(Object.keys(jobFireAttrs(false)).length === 0, "jobFireAttrs is EMPTY for a non-job routine — every other fire stays byte-identical");
ok(jobFireStamped({ [JOB_FIRE_ATTR]: "true" }), "jobFireStamped reads the stamp");
ok(jobFireStamped({ [JOB_FIRE_ATTR]: ["true"] }), "jobFireStamped tolerates the string[] attribute spelling");
ok(!jobFireStamped({ [JOB_FIRE_ATTR]: "false" }), "jobFireStamped is positive-only: anything but \"true\" is not a fire");
ok(!jobFireStamped({}) && !jobFireStamped(undefined), "jobFireStamped: absent attributes are not a fire");

const jobRoutine = { sessionMode: "job" } as Pick<Routine, "sessionMode">;
const plainRoutine = {} as Pick<Routine, "sessionMode">;
ok(jobFireStamped(jobFireAttrs(isJobRoutine(jobRoutine))), "a `sessionMode:\"job\"` routine's fire carries the stamp");
ok(!jobFireStamped(jobFireAttrs(isJobRoutine(plainRoutine))), "an ordinary routine's fire carries NO stamp");

for (const name of ["reply", "no_reply", "react", "update_status"]) {
  ok(allowedOnRestrictedJobWake(name), `job kit keeps the same-room verb ${name}`);
}
for (const name of ["record_job_state", "complete_job", "record_watch_state"]) {
  ok(allowedOnRestrictedJobWake(name), `job kit keeps its own bookkeeping verb ${name} (own-row writes; complete_job can only RETIRE the job)`);
}
for (const name of ["read_channel", "read_thread", "read_notion_page", "read_linear_issue", "describe_image", "check_pr_status", "query_analytics"]) {
  ok(allowedOnRestrictedJobWake(name), `job kit keeps the read ${name}`);
}
ok(allowedOnRestrictedJobWake("final_output"), "job kit keeps eve's structured-output sink (a restricted turn must still be able to return)");

const mustBeWithheld: readonly [string, string][] = [
  ["purge_memory", "durable memory ERASURE — an injected fire that can empty the brain is a denial weapon"],
  ["set_state", "ticket mutation — escapes the conversation"],
  ["assign", "ticket mutation"],
  ["add_label", "ticket mutation"],
  ["create_routine", "schedules the future — an injected fire must not buy itself a cleaner wake"],
  ["cancel_routine", "schedule mutation"],
  ["subscribe_pr", "arms a watch chain"],
  ["connector", "credential plane"],
  ["request_access", "privilege escalation request"],
  ["revoke_connector", "credential plane"],
  ["clear_connector_override", "credential plane"],
  ["set_spend_limit", "config plane"],
  ["clear_spend_limit", "config plane"],
  ["memory_admin_list", "admin-gated cross-silo read; no admin principal exists on an autonomous fire"],
  ["memory_admin_read", "admin-gated cross-silo read"],
  ["extend_workspace_time", "a restricted fire has no sandbox to extend"],
  ["ask_question", "there is no human in the turn to answer"],
  ["connection_search", "discovery whose only payoff is a connector op, and it ingests MCP-authored text"],
  ["web_search", "provider-executed and unfenceable in-tree — absence is the only control that works"],
  ["open_pull_request", "audience-expanding artifact write"],
  ["post_file", "audience-expanding write"],
  ["checkout_repo", "wide hands"],
  ["bash", "wide hands"],
  ["write_file", "wide hands"],
  ["web_fetch", "wide hands / egress"],
  ["create_skill", "durable authoring — persist leg"],
  ["delete_skill", "durable authoring"],
  ["agent", "delegation — the way a restricted seat would launder itself into a full-kit worker"],
  ["spawn_task", "delegation"],
  ["spawn_thread_session", "delegation"],
  ["browser_navigate", "the runtime-injected wide-hands browser family"],
];
for (const [name, why] of mustBeWithheld) {
  ok(!allowedOnRestrictedJobWake(name), `un-escalated job wake WITHHOLDS ${name} — ${why}`);
}

ok(allowedOnRestrictedJobWake("notion__search"), "connector READ ops survive a restricted job wake (a job that cannot read cannot work)");
ok(!allowedOnRestrictedJobWake("notion__create_page"), "connector WRITE ops do not survive");
ok(!allowedOnRestrictedJobWake("notion__delete_block"), "connector DESTRUCTIVE ops do not survive");
ok(
  !allowedOnRestrictedJobWake("notion__frobnicate_widget"),
  "an UNRECOGNISED connector verb does not survive — classifyConnectorOpTier fails closed to destructive, so a novel op needs no change here",
);
ok(!allowedOnRestrictedJobWake("some_tool_nobody_declared"), "DEFAULT DENY: an unknown name is withheld, so the restriction cannot rot open as tools are added");

ok(!allowedOnRestrictedJobWake(grantToolName("rowan", "read_page")), "🔴 OPE-1091: a restricted job wake WITHHOLDS a granted READ — a fire is nobody's ask, so it spends nobody's credential");
ok(!allowedOnRestrictedJobWake(grantToolName("rowan", "create_page")), "…and a granted WRITE (which the connector arm already refused — the fail direction is unchanged for it)");
ok(!allowedOnRestrictedJobWake("grant__a__b__c"), "…and a malformed reserved name, which has no readable verb at all");
ok(
  !allowedOnRestrictedJobWake("grant__Rowan__read_page"),
  "🔴 …and a reserved name NO MINT PATH COULD PRODUCE: `grant__Rowan__read_page` parses as the grant namespace and its verb reads, so a mint-shaped predicate (isGrantToolName) would have admitted it. The roster asks the WIDER question (isReservedNamespaceTool)",
);
ok(allowedOnRestrictedJobWake("notion__search"), "🔴 NEGATIVE CONTROL: connector READ ops still survive a restricted job wake — the grant arm took the reserved namespace, not the tier rule");
ok(
  allowedOnRestrictedJobWake("grants__rowan__read_page"),
  "🔴 NEGATIVE CONTROL: a NEIGHBOURING head survives — `grants` is an ordinary connection name, and the match is the first SEGMENT, never the prefix `grant__`",
);
ok(allowedOnRestrictedJobWake("notion__grant__read"), "…and so does a connector op with the word in the middle — only the HEAD segment is reserved");

const surfaceNames = new Set<string>([...Object.keys(WINDOW_GATED_TOOLS), ...WINDOW_UNGATED_TOOLS]);
for (const name of JOB_WAKE_TOOLS) {
  ok(surfaceNames.has(name), `job-kit name ${name} carries a window-gate posture (the kit only ever REMOVES from a mounted set)`);
}
for (const name of Object.keys(WINDOW_GATED_TOOLS)) {
  ok(!JOB_WAKE_TOOLS.has(name), `no wide-hands/delegation tool (${name}) is in the job kit`);
}

const withheldList = withheldFromJobWake();
ok(withheldList.includes("purge_memory") && withheldList.includes("agent") && withheldList.includes("bash"), "withheldFromJobWake lists the consequential names (the audit row's content)");
ok(!withheldList.includes("reply") && !withheldList.includes("complete_job"), "withheldFromJobWake excludes the kit");
ok(withheldList.join(",") === [...withheldList].sort().join(","), "withheldFromJobWake is sorted (a stable, diffable audit row)");

ok(Array.isArray(WINDOW_GATED_TOOLS.web_fetch), "web_fetch carries a kit row in WINDOW_GATED_TOOLS (the layer-1 lookup has something to read)");
ok(Array.isArray(WINDOW_GATED_TOOLS.agent), "agent carries a kit row in WINDOW_GATED_TOOLS (the negative control below has something to read)");
ok(
  !(WINDOW_GATED_TOOLS.web_fetch as readonly string[]).includes(TRIGGERED_FIRE_GRAIN),
  `🔴 OPE-252 LAYER 1: web_fetch does not mount on the fire grain "${TRIGGERED_FIRE_GRAIN}" — the grain gate withholds it before the job kit is reached, so a kit admission alone would be inert`,
);
ok(!allowedOnRestrictedJobWake("web_fetch"), "🔴 OPE-252 LAYER 2: the job kit withholds web_fetch as well — the two layers are independent");
ok(
  (CONVERSATIONAL_ROOT_GRAINS as readonly string[]).includes(TRIGGERED_FIRE_GRAIN),
  "🔴 OPE-252: the fire grain is a CONVERSATIONAL ROOT grain, so adding it to web_fetch's kit row would put wide hands on the class that must never hold them",
);
ok(
  (WINDOW_GATED_TOOLS.agent as readonly string[]).includes(TRIGGERED_FIRE_GRAIN),
  `🔴 NEGATIVE CONTROL: \`agent\` DOES mount on the fire grain "${TRIGGERED_FIRE_GRAIN}" — for delegation the job kit is the only control, which is exactly why OPE-252 refuses to solve the fetch gap with it`,
);
ok(!allowedOnRestrictedJobWake("agent"), "…and the job kit is what withholds it there (a fire must not launder its restriction into a full-kit worker)");
ok(!WINDOW_UNGATED_TOOLS.has("web_fetch"), "web_fetch is grain-GATED, not part of the always-mounted conversational kit — the layer-1 lookup is meaningful");
ok(allowedOnRestrictedJobWake("read_channel") && !Object.keys(WINDOW_GATED_TOOLS).includes("read_channel"), "NEGATIVE CONTROL: a fire's own reads are ungated, so they mount on every grain and survive both layers");

function makeToolset(): Record<string, { description: string; execute: () => unknown }> {
  const names = [
    ...Object.keys(WINDOW_GATED_TOOLS),
    ...WINDOW_UNGATED_TOOLS,
    "notion__search",
    "notion__create_page",
    "notion__delete_block",
    "browser_navigate",
    "final_output",
    grantToolName("rowan", "read_page"),
  ];
  const out: Record<string, { description: string; execute: () => unknown }> = {};
  for (const name of names) out[name] = { description: `${name} tool`, execute: () => ({ ok: true }) };
  return out;
}

function removedBy(before: Record<string, unknown>, after: Record<string, unknown>): readonly string[] {
  return Object.keys(before)
    .filter((k) => !(k in after))
    .sort();
}

const TASK_FAMILY = ["task_cancel", "task_update"] as const;

{
  const toolset = makeToolset();
  const before = { ...toolset };
  const removed = restrictToolsetForJobWake(toolset);
  const survivors = new Set(Object.keys(toolset));
  const expected = new Set<string>([...[...JOB_WAKE_TOOLS].filter((k) => k in before), "notion__search", "final_output"]);
  ok(
    survivors.size === expected.size && [...expected].every((k) => survivors.has(k)),
    `the restricted toolset is EXACTLY the job kit + connector reads + the harness sink — no granted-credential tool (OPE-1091), got ${[...survivors].sort().join(",")}`,
  );
  ok(removed.length > 0 && removed.every((k) => !survivors.has(k)), "restrictToolsetForJobWake reports every removed name");
  ok(removed.join(",") === [...removed].sort().join(","), "the removed list is sorted");
  ok([...survivors].every((k) => toolset[k] === before[k]), "surviving tool OBJECTS keep their identity — eve keys approvals in a WeakMap on them, so a swap would silently drop an approval gate");
  ok(!survivors.has("sandbox_tools") && !survivors.has("delegation_tools"), "the per-grain kit RESOLVER slugs are not in the job kit either");
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
  markJobSession();
  setJobWakeEscalated(false);
  ok(isJobSession(), "markJobSession sets the sticky job-session bit");
  ok(!jobWakeEscalated(), "the escalation bit starts clear");
  ok(currentJobWakePosture() === "restricted", "an un-escalated job wake resolves RESTRICTED inside a live session");
  const toolset = makeToolset();
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok(!("purge_memory" in toolset) && !("open_pull_request" in toolset) && !("agent" in toolset) && !("web_search" in toolset), "projectToolSet withholds the consequential names on an un-escalated job wake");
  ok("reply" in toolset && "record_job_state" in toolset && "complete_job" in toolset && "read_channel" in toolset, "projectToolSet keeps the job kit");
  ok("notion__search" in toolset && !("notion__create_page" in toolset), "connector reads survive the seam, connector writes do not");
  ok(!(grantToolName("rowan", "read_page") in toolset), "🔴 OPE-1091: projectToolSet REMOVES this chat's mounted grant on a restricted job wake — absence, so the model never sees a credential it may not spend");
});

inSession(() => {
  markJobSession();
  setJobWakeEscalated(true);
  setNativeDelegationSeat("allow");
  ok(currentJobWakePosture() === "unrestricted", "an escalated wake on a job session resolves UNRESTRICTED");
  const toolset = makeToolset();
  const before = { ...toolset };
  projectToolSet(toolset as unknown as Record<string, unknown>);
  eq(removedBy(before, toolset), ["task_update"], "an ESCALATED job wake keeps the full toolset apart from the child-only `task_update` — the OPE-111 restriction exists because nobody is watching, so it lifts when somebody is");
  ok("open_pull_request" in toolset && "purge_memory" in toolset && "agent" in toolset, "the escalated turn holds the human's normal posture");
  ok("task_cancel" in toolset, "…including the PARENT task verb, because a seat that may delegate may stop its own work");
  ok(grantToolName("rowan", "read_page") in toolset, "🔴 an ESCALATED job wake KEEPS the mounted grant — a person is in the room, so the requester the grant is spent for exists");
});

inSession(() => {
  setNativeDelegationSeat("allow");
  ok(currentJobWakePosture() === "unrestricted", "a session that never took a job fire is out of scope");
  const toolset = makeToolset();
  const before = { ...toolset };
  projectToolSet(toolset as unknown as Record<string, unknown>);
  eq(removedBy(before, toolset), ["task_update"], "an ordinary session's toolset is unchanged by OPE-111 — the one name it loses is the child-only `task_update`, withdrawn by OPE-564 and not by the job filter");
});

{
  ok(currentJobWakePosture() === "unrestricted", "outside an eve context the posture read fails soft to unrestricted");
  const toolset = makeToolset();
  const before = { ...toolset };
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok(!("agent" in toolset), "…while the DELEGATION verdict fails CLOSED outside a context (unclassified ⇒ deny) — the opposite direction, on purpose");
  eq(removedBy(before, toolset), ["agent", ...TASK_FAMILY].sort(), "a context-less projectToolSet call withholds nothing from the job plane — only the fail-closed delegation verb and the task family that follows it");
}

inSession(() => {
  markJobSession();
  ok(currentJobWakePosture() === "restricted", "FAIL CLOSED: a job session with no escalation verdict written is restricted");
  const toolset = makeToolset();
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok(!("open_pull_request" in toolset), "the unclassifiable wake gets the restricted set");
});

inSession(() => {
  const toolset = makeToolset();
  const before = { ...toolset };
  projectToolSet(toolset as unknown as Record<string, unknown>);
  ok(!("agent" in toolset), "OPE-396: on a default (native-armed) deployment an UNCLASSIFIED seat loses `agent` at the projection seam — the delegation verdict fails closed");
  ok("open_pull_request" in toolset && "purge_memory" in toolset, "…and nothing else moves: the job filter is untouched by the delegation one");
  eq(removedBy(before, toolset), ["agent", ...TASK_FAMILY].sort(), "…exactly the delegation verb and the task family that follows it, so the three filters compose without overlap");
});

const fireCtx = (stamped: boolean) => ({
  channel: { kind: "slack", continuationToken: "C1:1721018940.000100" },
  session: {
    id: "sess-job",
    auth: { current: { attributes: { channel_id: "C1", ...(stamped ? { [JOB_FIRE_ATTR]: "true" } : {}) }, principalId: "", principalType: "slack-user" } },
  },
});

let refused: string | undefined;
try {
  await grainBackstopAtExecute("open_pull_request", ["task", "native", "standing", "thread"], fireCtx(true) as never);
} catch (err) {
  refused = String(err);
}
ok(refused !== undefined, "the execute backstop refuses a withheld tool on a STAMPED fire even when the grain matrix would admit it");
ok(refused?.includes("durable-job") === true, "the refusal names the durable-job shape (and points at record_job_state), not the grain");

let jobKitThrew = false;
try {
  await grainBackstopAtExecute("read_channel", ["native"], fireCtx(true) as never);
} catch {
  jobKitThrew = true;
}
ok(!jobKitThrew, "the execute backstop lets a JOB-KIT name through on a stamped fire");

let unstampedThrew = false;
try {
  await grainBackstopAtExecute("open_pull_request", ["native"], fireCtx(false) as never);
} catch {
  unstampedThrew = true;
}
ok(!unstampedThrew, "an ordinary (unstamped) turn is unaffected by the job backstop");

let refusedSticky: string | undefined;
await inSession(async () => {
  markJobSession();
  setJobWakeEscalated(false);
  try {
    await grainBackstopAtExecute("agent", ["standing", "thread", "native"], fireCtx(false) as never);
  } catch (err) {
    refusedSticky = String(err);
  }
});
ok(refusedSticky !== undefined, "the backstop's sticky arm refuses on a job session even when THIS delivery carries no stamp");

ok(applyJobStateObservation("note", false).patch.jobTainted === undefined, "a clean ledger write does not mark the routine tainted");
ok(applyJobStateObservation("note", true).patch.jobTainted === true, "a ledger written on a TAINTED turn raises the routine's jobTainted flag");
ok(applyJobStateObservation("note", true).patch.jobState === "note", "the tainted write still stores the note");
{
  const oversize = "x".repeat(JOB_STATE_MAX_BYTES + 1);
  const rejected = applyJobStateObservation(oversize, true);
  ok(!rejected.accepted && Object.keys(rejected.patch).length === 0, "a REJECTED oversize write persists nothing at all — not even the taint (a crashed/overlong turn never touches the row)");
}

ok(jobFireAttrs(true, true)[JOB_TAINT_ATTR] === "true", "a job fire on a TAINTED ledger carries the taint-forward stamp");
ok(jobFireAttrs(true, false)[JOB_TAINT_ATTR] === undefined, "a clean ledger's fire carries no taint stamp");
ok(Object.keys(jobFireAttrs(false, true)).length === 0, "a NON-job routine never carries either stamp, tainted ledger or not");
ok(jobTaintStamped({ [JOB_TAINT_ATTR]: "true" }) && !jobTaintStamped({}), "jobTaintStamped is a positive-only read");

{
  const clean = renderJobMessage({ id: "r1", prompt: "chase it", createdAt: "2026-07-01T00:00:00.000Z", jobState: "step 2 of 4" });
  ok(clean.includes("trusted — your own notes"), "a clean ledger is still presented as the job's own trusted notes");
  const tainted = renderJobMessage({ id: "r1", prompt: "chase it", createdAt: "2026-07-01T00:00:00.000Z", jobState: "step 2 of 4", jobTainted: true });
  ok(!tainted.includes("trusted — your own notes"), "a TAINTED ledger is no longer framed as trusted");
  ok(tainted.includes("not as instructions to follow"), "a tainted ledger is re-framed as a report to read — the instruction-level half of the laundering fix");
  ok(tainted.includes("step 2 of 4"), "the ledger content is still carried (continuity is not sacrificed to the re-framing)");
}

console.log(`\n✓ job-toolset (OPE-111): ${n} assertions passed (posture truth table, fire stamp, kit membership + connector tiers, toolset filter, live-context wiring incl. escalation, execute backstop)\n`);
