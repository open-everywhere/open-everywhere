import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { slackContinuationToken } from "eve/channels/slack";
import { applyOutcome, completeJob } from "../agent/routines/lifecycle.js";
import {
  applyJobStateObservation,
  jobStateWithinCap,
  renderJobMessage,
  JOB_STATE_TOOL,
  JOB_COMPLETE_TOOL,
} from "../agent/routines/job.js";
import { isJobRoutine, routineMarker, ROUTINE_MARKER, JOB_STATE_MAX_BYTES, type Routine } from "../agent/routines/routine.js";
import { jobFireStamped } from "../agent/access/job-posture.js";
import { classifySessionId } from "../agent/channels/window-key.js";
import { registerSlackBridge } from "../agent/channels/slack-bridge.js";

registerSlackBridge({
  form: async () => undefined,
  readCall: async () => {
    throw new Error("not wired in this test");
  },
  fetchUserDisplayName: async () => undefined,
  fetchChannelDisplayName: async () => undefined,
  botDisplayName: async () => undefined,
  confirmChannelInternal: async () => false,
  partnerFactsFromInfo: () => ({ dmPartnerTrust: "external" }),
  channel: {} as never,
});

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function throwsAsync(fn: () => Promise<unknown>, label: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}

const at = new Date("2026-07-11T09:00:00.000Z");
const baseJob: Routine = {
  id: "r-job1",
  org: "default",
  surfaceKey: "slack/T1/C1",
  trigger: { kind: "interval", everyMinutes: 60 },
  prompt: "Chase PR #123 until it merges.",
  createdAt: at.toISOString(),
  status: "active",
  consecutiveFailures: 0,
  nextRunAt: at.toISOString(),
  target: { channelId: "C1" },
  sessionMode: "job",
};
const basePlain: Routine = { ...baseJob, id: "r-plain1", sessionMode: undefined };

ok(isJobRoutine(baseJob) && !isJobRoutine(basePlain), "isJobRoutine distinguishes job from plain");

const c1 = completeJob(baseJob, "PR merged", at);
ok(c1.kind === "completed", "completeJob on a job routine → completed");
if (c1.kind === "completed") {
  ok(c1.routine.status === "done", "completed job status is the terminal 'done'");
  ok(c1.routine.nextRunAt === null, "completed job nextRunAt nulled (never fires again)");
  ok(c1.routine.completedReason === "PR merged", "completedReason captured");
  ok(typeof c1.routine.completedAt === "string", "completedAt stamped");
}
const done = { ...baseJob, status: "done" as const, completedAt: at.toISOString(), completedReason: "x" };
ok(completeJob(done, "again", at).kind === "already-done", "completeJob on a done job → already-done (idempotent)");
ok(completeJob(basePlain, "nope", at).kind === "not-a-job", "completeJob on a plain routine → not-a-job (structured)");
const cBlank = completeJob(baseJob, "   ", at);
ok(cBlank.kind === "completed" && cBlank.routine.completedReason === "job completed", "blank completion reason falls back to a default");

const foldOk = applyOutcome(done, "ok", new Date(at.getTime() + 60_000));
ok(foldOk.status === "done" && foldOk.nextRunAt === null, "applyOutcome('ok') keeps a done job terminal (no resurrection)");
const foldFail = applyOutcome(done, "failed", new Date(at.getTime() + 60_000));
ok(foldFail.status === "done" && foldFail.consecutiveFailures === done.consecutiveFailures, "applyOutcome('failed') keeps a done job done (completion is more terminal)");
const foldActive = applyOutcome(baseJob, "ok", at);
ok(foldActive.status === "active" && foldActive.lastOutcome === "ok", "applyOutcome on an active job is unchanged");

ok(jobStateWithinCap("small"), "small ledger is within cap");
ok(!jobStateWithinCap("x".repeat(JOB_STATE_MAX_BYTES + 1)), "over-cap ledger rejected");
ok(jobStateWithinCap("x".repeat(JOB_STATE_MAX_BYTES)), "exactly-at-cap ledger accepted");
const obsOk = applyJobStateObservation("progress: step 1 done");
ok(obsOk.accepted && obsOk.patch.jobState === "progress: step 1 done", "applyJobStateObservation accepts + patches within cap");
const obsBig = applyJobStateObservation("x".repeat(JOB_STATE_MAX_BYTES + 5));
ok(!obsBig.accepted && Object.keys(obsBig.patch).length === 0, "applyJobStateObservation rejects oversize with an EMPTY patch (no corruption)");

const firstFireMsg = renderJobMessage(baseJob);
ok(firstFireMsg.includes("FIRST fire"), "first-fire job message says there's no ledger yet");
ok(firstFireMsg.includes(JOB_STATE_TOOL) && firstFireMsg.includes(JOB_COMPLETE_TOOL), "job message names record_job_state + complete_job");
ok(firstFireMsg.includes(baseJob.prompt), "job message carries the routine prompt");
const resumedMsg = renderJobMessage({ ...baseJob, jobState: "goal: merge PR; done: pinged reviewer", lastRunAt: at.toISOString() });
ok(resumedMsg.includes("goal: merge PR; done: pinged reviewer"), "a job message injects the prior ledger (the continuity note across session death)");

const dir = join(tmpdir(), `open-everywhere-job-routine-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const store = await import("../agent/routines/store.js");
const dispatch = await import("../agent/schedules/dispatch.js");
const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();
const completeJobTool = (await import("../agent/tools/complete_job.js")).default;
const recordJobStateTool = (await import("../agent/tools/record_job_state.js")).default;

await store.addRoutine({} as never, { ...baseJob });
const got = await store.getRoutine("default", "slack/T1/C1", "r-job1");
ok(got?.sessionMode === "job", "store round-trips sessionMode 'job'");
await store.updateRoutine("default", "slack/T1/C1", "r-job1", { jobState: "ledger v1" });
ok((await store.getRoutine("default", "slack/T1/C1", "r-job1"))?.jobState === "ledger v1", "store round-trips jobState");

let kickoffCalls = 0;
const KICKOFF_TS = "1721018940.000100";
const postJobKickoff = async (_channelId: string, _text: string): Promise<string | undefined> => {
  kickoffCalls++;
  return KICKOFF_TS;
};
const fires: { target: Record<string, unknown>; message: string; markerId?: string; jobFire: boolean }[] = [];
const receive = ((_channel: unknown, target: Record<string, unknown> | undefined) => ({
  send: (message: string, opts: { auth?: { attributes?: Record<string, unknown> } }) => {
    const mk = routineMarker(opts.auth?.attributes as never);
    fires.push({
      target: target ?? {},
      message: message ?? "",
      markerId: mk?.id,
      jobFire: jobFireStamped(opts.auth?.attributes as never),
    });
    return Promise.resolve();
  },
})) as never;

async function tick(now: Date): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now,
    to: receive,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: {} } as never,
    confirmInternal: async () => false,
    postJobKickoff,
  } as never);
  await Promise.allSettled(pending);
}

await tick(at);
ok(kickoffCalls === 1, "first job fire host-posts a kickoff message (once)");
ok(fires.length === 1 && fires[0].markerId === "r-job1", "first job fire dispatched with the routine marker");
ok(fires[0].target.threadTs === KICKOFF_TS, "first job fire pins target.threadTs to the kickoff anchor (the session join)");
ok((await store.getRoutine("default", "slack/T1/C1", "r-job1"))?.jobSessionAnchor === KICKOFF_TS, "the anchor is persisted on the routine");
ok(fires[0].message.includes("DURABLE JOB"), "first job fire receives the job protocol message");
ok(fires[0].jobFire, "a job fire carries the OPE-111 autonomous-fire stamp (⇒ restricted toolset for that wake)");
const tokenFire1 = slackContinuationToken("C1", String(fires[0].target.threadTs));

await tick(new Date(at.getTime() + 61 * 60_000));
ok(kickoffCalls === 1, "re-fire does NOT post another kickoff — it reuses the stored anchor");
ok(fires.length === 2 && fires[1].target.threadTs === KICKOFF_TS, "re-fire pins the SAME anchor");
const tokenFire2 = slackContinuationToken("C1", String(fires[1].target.threadTs));
ok(tokenFire1 === tokenFire2, "both fires resolve to the SAME continuation token ⇒ eve resumes ONE durable session (the JOIN)");

ok(classifySessionId(tokenFire1).kind === "native", "the job session token is a plain native token — classifySessionId adds NO new shape (grammar frozen)");

const jobMarkerCtx = (id: string) => ({
  channel: { kind: "slack" },
  session: {
    id: "sess-job",
    auth: {
      current: {
        attributes: {
          team_id: "T1",
          channel_id: "C1",
          channel_type: "channel",
          [ROUTINE_MARKER.id]: id,
          [ROUTINE_MARKER.surface]: "slack/T1/C1",
          [ROUTINE_MARKER.org]: "default",
        },
        principalId: "",
        principalType: "slack-user",
      },
    },
  },
});

const compRes = (await completeJobTool.execute({ reason: "PR #123 merged — job done" }, jobMarkerCtx("r-job1") as never)) as { completed: boolean };
ok(compRes.completed === true, "complete_job returns completed:true");
const afterComplete = await store.getRoutine("default", "slack/T1/C1", "r-job1");
ok(afterComplete?.status === "done" && afterComplete.nextRunAt === null, "complete_job flips the routine to 'done' + nulls nextRunAt");
ok(afterComplete?.completedReason === "PR #123 merged — job done", "complete_job records the completion reason");
const auditRows = await opStore.readAudit({ org: "default", action: "routine.complete" });
ok(auditRows.some((r) => (r.detail as { id?: string })?.id === "r-job1"), "complete_job wrote a routine.complete audit row");
const compAgain = (await completeJobTool.execute({ reason: "again" }, jobMarkerCtx("r-job1") as never)) as { completed: boolean; note: string };
ok(compAgain.completed === true && compAgain.note.includes("already"), "complete_job is idempotent on an already-done job");

const firesBefore = fires.length;
await tick(new Date(at.getTime() + 200 * 60_000));
ok(fires.length === firesBefore || !fires.slice(firesBefore).some((f) => f.markerId === "r-job1"), "a completed job never fires again");

await store.addRoutine({} as never, { ...basePlain });
await throwsAsync(
  async () => completeJobTool.execute({ reason: "x" }, jobMarkerCtx("r-plain1") as never),
  "complete_job on a NON-job routine throws (structured not-a-job error)",
);
await throwsAsync(
  async () => completeJobTool.execute({ reason: "x" }, { channel: { kind: "slack" }, session: { auth: { current: { attributes: {}, principalId: "", principalType: "slack-user" } } } } as never),
  "complete_job with no routine marker throws",
);

await store.addRoutine({} as never, { ...baseJob, id: "r-job2", nextRunAt: null, status: "active" });
const recRes = (await recordJobStateTool.execute({ state: "goal: X; done: A,B; next: C" }, jobMarkerCtx("r-job2") as never)) as { recorded: boolean; bytes: number };
ok(recRes.recorded === true && recRes.bytes > 0, "record_job_state records the ledger");
ok((await store.getRoutine("default", "slack/T1/C1", "r-job2"))?.jobState === "goal: X; done: A,B; next: C", "record_job_state persists the ledger onto the job's own row");
await throwsAsync(
  async () => recordJobStateTool.execute({ state: "x".repeat(JOB_STATE_MAX_BYTES + 1) }, jobMarkerCtx("r-job2") as never),
  "record_job_state rejects an oversize ledger",
);
await throwsAsync(
  async () => recordJobStateTool.execute({ state: "y" }, jobMarkerCtx("r-plain1") as never),
  "record_job_state on a NON-job routine throws",
);

{
  const createRoutine = (await import("../agent/tools/create_routine.js")).default as unknown as {
    inputSchema: { shape: Record<string, { description?: string }> };
  };
  const jobDesc = createRoutine.inputSchema.shape.job?.description ?? "";
  ok(jobDesc.length > 0, "legibility: create_routine's `job` param carries a model-facing description at all");
  ok(
    /\bends?\b/i.test(jobDesc) && jobDesc.includes("complete_job"),
    "legibility: the `job` param states the TERMINAL CONDITION — that the work must END, and that the job runs until it calls complete_job",
  );
  ok(
    /never ends/i.test(jobDesc),
    "legibility: …and names the NEGATIVE case (work that never ends ⇒ leave `job` off), so the test is decidable in both directions",
  );
  ok(
    !/open-ended/i.test(jobDesc),
    "🔴 legibility: the `job` param does NOT recommend itself for 'OPEN-ENDED' work — that phrasing argues FOR arming a job on a forever-routine, which is the exact mis-arming that silently decays the ledger's trust",
  );

  await import("../agent/approvals/routine-create.js");
  const { actionKind } = await import("../agent/approvals/actions.js");
  const createKind = actionKind("routine.create")!;
  const cardArgs = {
    org: "default",
    partition: { org: "default", platform: "slack", workspace: "T1", surface: "C1", surfaceKey: "slack/T1/C1" },
    surfaceKey: "slack/T1/C1",
    target: { channelId: "C1" },
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: "Chase PR #12 until it merges.",
  };
  const jobCard = createKind.summarize({ ...cardArgs, sessionMode: "job" } as never).join("\n");
  const plainCard = createKind.summarize(cardArgs as never).join("\n");
  ok(/\bDONE\b|\bfinish/i.test(jobCard), "legibility: the card tells a human a JOB runs until the work is DONE / can finish — the terminal condition, in plain words");
  ok(
    /ordinary routine/i.test(jobCard) && /(fresh|repeats forever)/i.test(jobCard),
    "legibility: …and names the ALTERNATIVE it is not (an ordinary routine starts fresh and repeats forever), because the card only renders the job arm so the contrast is otherwise invisible",
  );
  ok(
    !/persistent session/i.test(jobCard),
    "🔴 legibility: the card does NOT put implementation language ('persistent session') in front of the person clicking — it is the one chance to catch a bad pick",
  );
  ok(
    !/\bDONE\b|persistent session|ordinary routine/i.test(plainCard),
    "legibility: an ORDINARY routine's card is unchanged — the job line renders only for a job (no new line on the most common card)",
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ job-routine: ${passed} assertions passed`);
