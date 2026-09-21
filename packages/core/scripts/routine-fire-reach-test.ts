import { JOB_WAKE_TOOLS, WINDOW_UNGATED_TOOLS } from "../agent/access/window-gate-manifest.js";
import { TOOL_CONSEQUENCE } from "../agent/access/consequence.js";
import { allowedOnRestrictedJobWake, resolveJobWakePosture } from "../agent/access/job-posture.js";
import { resolveLeanSeatPosture } from "../agent/access/lean-seat.js";
import { eventPrompt } from "../agent/routines/events.js";
import { renderFireMessage } from "../agent/routines/fire-message.js";
import { renderJobMessage } from "../agent/routines/job.js";
import {
  CONNECTION_SEARCH_TOOL,
  firePreamble,
  renderFailureBlock,
  renderReachBlock,
  renderScheduledMessage,
  renderWatchMessage,
  RUN_FAILED_TOOL,
} from "../agent/routines/watch.js";
import type { Routine } from "../agent/routines/routine.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const REACH_MARKER = "[reach]";

{
  const block = renderReachBlock("full");

  ok(
    block.includes(REACH_MARKER),
    "the reach block is tagged `[reach]` — the tag is what §2 looks for on every render path, so it is part of the contract, not decoration",
  );
  ok(
    block.includes(`\`${CONNECTION_SEARCH_TOOL}\``),
    "rule 1: the block NAMES the search tool, interpolated from CONNECTION_SEARCH_TOOL — a renamed framework slot must not leave every fire quoting a tool that no longer exists",
  );
  ok(
    /FOUND by search/u.test(block),
    "rule 1: it says a connector operation is FOUND BY SEARCH. This is the whole correction — the fire read its opening tool list as the whole of its reach",
  );
  ok(
    /not always listed in this session/u.test(block),
    "rule 1: and it says WHY the list is not the answer — the operation is absent by construction until search mounts it, so an absent name proves nothing",
  );
  ok(
    /BEFORE you report/u.test(block) && /Attempt the operation/u.test(block),
    "rule 2: it puts the ATTEMPT before the report. Naming the tool alone leaves 'I can see it is not there' intact as a reason to skip the call",
  );
  ok(
    /report what came back/u.test(block) && /A refusal is what a call returned/u.test(block),
    "rule 3 (reach half): a refusal is what a CALL returned. The observed fire invented one, and an invented refusal is indistinguishable from a measured one in the audit row",
  );

  const job = renderReachBlock("job-restricted");
  ok(job.includes(REACH_MARKER), "job arm: it is the same block, so §2's marker finds it on the job path too");
  ok(
    job.includes(`\`${CONNECTION_SEARCH_TOOL}\``) && /holds no/u.test(job),
    "job arm: it names the search tool as something this wake does NOT hold — naming it is what stops the model reaching for it anyway",
  );
  ok(
    !/Call `connection_search` with a keyword/u.test(job),
    "job arm: and it does NOT carry the full arm's instruction to go searching — the assertion above would pass on a block that said both",
  );
  ok(
    /no connector operation beyond a read/u.test(job),
    "job arm: it states the second half of the narrowing — allowedOnRestrictedJobWake admits a connector op only at tier `read`",
  );
  ok(
    /do not describe the narrowing as a refusal: nothing refused you/u.test(job),
    "job arm: it forbids the SAME false report the full arm forbids — the withheld kit is not a refusal, and calling it one is the defect in a different costume",
  );
  ok(job.includes(`\`${RUN_FAILED_TOOL}\``), "job arm: it points at the declared-failure seam, which IS in the job kit, instead of leaving the fire with nothing to do");
  ok(
    /\[health\] block above/u.test(job) && /a fact about the kit, not a guess/u.test(job) && /Never invent one/u.test(job),
    "job arm: it discharges the health block's 'a guess unless a call returned it' demand — on this wake, naming a tool the kit lacks IS the earned answer, and no call has to sit behind it",
  );
  ok(renderReachBlock("full") !== job, "the two arms are different text — a single shared string would mean one of the two wakes is being told something false");

  const health = renderFailureBlock();
  ok(
    /what you TRIED/u.test(health) && /what the system ANSWERED/u.test(health),
    "rule 3 (health half): a declared failure names the attempt AND the answer. Before this the block demanded a reason but never that the reason be earned",
  );
  ok(
    /"not authorized" is a guess unless a call returned it/u.test(health),
    'rule 3 (health half): it names the exact bad shape — a bare "not authorized" — because that is the string the observed fire wrote, and a rule stated only in the abstract did not stop it',
  );

  ok(
    !firePreamble({ id: "r-neg", createdAt: "2026-07-01T00:00:00.000Z" }).includes(REACH_MARKER),
    "negative control: the temporal preamble alone does NOT carry the marker — so §2's predicate can tell a rendered block from an absent one",
  );
}

{
  const plain: Routine = {
    id: "r-reach",
    org: "acme",
    surfaceKey: "slack/T/C",
    trigger: { kind: "interval", everyMinutes: 15 },
    prompt: "create the weekly digest page in Notion",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
  };

  ok(renderScheduledMessage(plain).includes(REACH_MARKER), "reach: a plain interval/cron fire is told");
  ok(
    renderWatchMessage({ id: plain.id, prompt: plain.prompt, createdAt: plain.createdAt }).includes(REACH_MARKER),
    "reach: a WATCH fire is told — its observation can need a connector as readily as any other work",
  );
  {
    const msg = renderJobMessage({ id: plain.id, prompt: plain.prompt, createdAt: plain.createdAt });
    ok(msg.includes(REACH_MARKER), "reach: a durable JOB fire is told");
    ok(msg.includes(renderReachBlock("job-restricted")), "reach: and it is told the JOB-RESTRICTED arm verbatim — its wake holds no search tool");
    ok(!msg.includes(renderReachBlock("full")), "reach: the job leg does NOT carry the full arm — the two are mutually exclusive, and only this assertion can tell them apart");
  }
  ok(
    renderFireMessage({ ...plain, report: { kind: "silent" } }).includes(REACH_MARKER),
    "reach: a SILENT fire is told — it posts nothing, so a refusal it invented reaches a human only through the strike counter that disables it",
  );
  ok(
    renderFireMessage({ ...plain, trigger: { kind: "once", at: "2026-07-02T00:00:00.000Z" } }).includes(REACH_MARKER),
    "reach: a `once` fire is told — the observed defect was a one-shot fire, so this is the shape the ticket was filed on",
  );

  {
    const msg = eventPrompt({ prompt: "file the triage note" }, { summary: "issue opened: Fix the thing", url: "https://example.test/1" });
    ok(msg.includes(REACH_MARKER), "reach: an EVENT fire is told too — eventPrompt bypasses renderFireMessage, so it needs its own line");
    ok(msg.includes(renderReachBlock("full")), "reach: an ordinary event routine takes the FULL arm — its wake is assembled normally");
    ok(
      msg.indexOf(REACH_MARKER) < msg.indexOf("issue opened"),
      "reach: and the trusted block sits BEFORE the untrusted payload — a block below the fence is one an attacker-authored body can argue with",
    );

    const jobEvent = eventPrompt({ prompt: "drive the migration", sessionMode: "job" }, { summary: "issue opened: Fix the thing" });
    ok(
      jobEvent.includes(renderReachBlock("job-restricted")) && !jobEvent.includes(renderReachBlock("full")),
      "reach: an event fire of a JOB routine takes the job-restricted arm — the arm is derived from the routine, never from which renderer ran",
    );
  }

  {
    const msg = renderScheduledMessage(plain);
    ok(
      msg.indexOf(REACH_MARKER) < msg.indexOf(plain.prompt),
      "reach: the block sits ABOVE the routine's own prompt — it constrains the prompt, so a prompt cannot be read as having already answered it",
    );
  }
}

{
  ok(
    WINDOW_UNGATED_TOOLS.has(CONNECTION_SEARCH_TOOL),
    "achievable: the search tool is UNGATED on window grain, so it mounts on every grain — including the thread-grain fire session the ticket observed",
  );
  ok(
    TOOL_CONSEQUENCE[CONNECTION_SEARCH_TOOL]?.tier === "open",
    "achievable: and the consequence table asks no approval for it, so a fire with nobody present can still run the search the block demands",
  );
  ok(
    resolveLeanSeatPosture({ grain: "thread", canDelegate: true, unattendedFire: true }) === "full",
    "achievable: the LEAN-SEAT arm never narrows a fire — the cut that deletes connector tools at the model-call seam on a delegating conversational seat does not apply here",
  );
  ok(
    resolveLeanSeatPosture({ grain: "thread", canDelegate: true, unattendedFire: false }) === "lean",
    "achievable (negative control): the SAME thread-grain seat without the fire stamp IS lean — so the assertion above measures the fire carve-out, not a posture that is 'full' for everyone",
  );

  ok(resolveJobWakePosture({ jobFire: true, jobSession: true, humanPrincipal: false }) === "restricted", "achievable: the EXECUTE BACKSTOP's shape — a stamped durable-job fire is restricted");
  ok(
    resolveJobWakePosture({ jobFire: true, jobSession: true, humanPrincipal: true }) === "restricted",
    "achievable: and at that shape unconditionally — `jobFire` is answered before the human-principal arm, so a stamped bag never escapes the kit",
  );
  ok(
    resolveJobWakePosture({ jobFire: false, jobSession: true, humanPrincipal: false }) === "restricted",
    "achievable: the MODEL-CALL seam's own shape (job-session-state.ts currentJobWakePosture) — a job session whose wake never escalated is restricted, which is the state hooks/job-posture.ts leaves a stamped fire in: its branch calls markJobSession() and RETURNS before the escalation arm, so `escalated` stays false",
  );
  ok(
    resolveJobWakePosture({ jobFire: false, jobSession: true, humanPrincipal: true }) === "unrestricted",
    "achievable (negative control): the SAME seam shape with the escalation bit up is unrestricted — so the line above measures the un-escalated fire, not a policy that refuses everyone",
  );
  ok(
    !JOB_WAKE_TOOLS.has(CONNECTION_SEARCH_TOOL) && !allowedOnRestrictedJobWake(CONNECTION_SEARCH_TOOL),
    "achievable: that kit withholds the search tool BY NAME — which is why the job leg carries the job-restricted arm and not the full one",
  );
  ok(
    !allowedOnRestrictedJobWake("notion__create_page") && allowedOnRestrictedJobWake("notion__read_page"),
    "achievable: and it admits a connector op only at tier `read` — so the job arm's 'no connector operation beyond a read' is measured, not asserted",
  );
  ok(
    WINDOW_UNGATED_TOOLS.has(CONNECTION_SEARCH_TOOL) && !JOB_WAKE_TOOLS.has(CONNECTION_SEARCH_TOOL),
    "achievable (negative control): ungated on window grain AND absent from the job kit — the two arms of the block track exactly that split",
  );
}

console.log(`✓ routine-fire-reach: ${passed} assertions passed`);
