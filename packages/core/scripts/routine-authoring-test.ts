import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function refuses(fn: () => unknown, needle: RegExp, label: string): Promise<void> {
  let msg: string | null = null;
  try {
    await fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg !== null && needle.test(msg), `${label} (got: ${msg ?? "no throw"})`);
}

const dir = join(tmpdir(), `open-everywhere-routine-authoring-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";

const { registerSlackTestBridge, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const store = await import("../agent/routines/store.js");
const routineMod = await import("../agent/routines/routine.js");
const { describeTrigger, routineGrantGeneration, routineGrantKey, routineManualStamped, ROUTINE_MARKER } = routineMod;
const { renderFireMessage } = await import("../agent/routines/fire-message.js");
const { jobFireSeatKey } = await import("../agent/routines/fire-window.js");
const { routineFireAttributes } = await import("../agent/routines/fire-auth.js");
const { ROUTINE_AUDIT } = await import("../agent/routines/fire-audit.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { DISPATCH_TICK_MINUTES } = await import("../agent/routines/schedule.js");
await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { registerSlackBridge } = await import("../agent/channels/slack-bridge.js");

type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;

registerSlackFixtureMapper();
registerSlackTestBridge({ confirmChannelInternal: async () => true });

const ORG = "acme";
const SURFACE = "slack/T1/C1";

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: "C1" },
    trigger: { kind: "interval", everyMinutes: 30 },
    prompt: "Post the morning digest.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}

const ctx = {
  channel: { kind: "slack" },
  session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" }, principalId: "U1", principalType: "slack-user" } } },
} as never;
const P = resolvePartition(ctx);
const partition = P as never;
const rowsFor = async (action: string): Promise<AuditInput[]> => (await readAudit({ org: ORG, action })) as AuditInput[];
const detailOf = (row: AuditInput | undefined, key: string): unknown => row?.detail?.[key];

const createRoutineTool = (await import("../agent/tools/create_routine.js")).default;
const runNowTool = (await import("../agent/tools/run_routine_now.js")).default;
const editTool = (await import("../agent/tools/edit_routine.js")).default;
const enableTool = (await import("../agent/tools/enable_routine.js")).default;

{
  registerSlackBridge({
    form: async () => ({ ok: true, ts: "1700000000.0001" }),
    readCall: async () => {
      throw new Error("not wired in this test");
    },
    fetchUserDisplayName: async () => undefined,
    fetchChannelDisplayName: async () => undefined,
    botDisplayName: async () => undefined,
    confirmChannelInternal: async () => true,
    partnerFactsFromInfo: () => ({ dmPartnerTrust: "external" }),
    readableChannelList: () => [],
    channel: {} as never,
  });

  const out = (await createRoutineTool.execute(
    { prompt: "Summarise open PRs.", trigger: { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } } as never,
    ctx,
  )) as { pending: boolean; preview: string };
  ok(out.pending === true, "preview: create_routine still PROPOSES (nothing is armed by previewing)");
  ok(typeof out.preview === "string" && out.preview.length > 0, "preview: the output carries a rendered preview at all — the pre-OPE-147 output had no CONTENT field");
  ok(out.preview.includes("Summarise open PRs."), "preview: the prompt is in the rendered message");
  ok(out.preview.includes("[routine (pending)]"), "preview: it renders as a PROPOSED routine — no id is minted until a human arms it");
  ok(out.preview.includes("this is the FIRST run"), "preview: it describes the FIRST run (no lastRunAt), which is the run being previewed");
  ok(!out.preview.includes("[watch]") && !out.preview.includes("[job]"), "preview: a plain every-run cron gets no protocol block");

  const sameShape = renderFireMessage({
    id: "(pending)",
    prompt: "Summarise open PRs.",
    createdAt: "2026-07-01T00:00:00.000Z",
    trigger: { kind: "cron", expr: "0 9 * * 1-5" },
  });
  ok(
    sameShape.replace(/routine created: [^;]+;/, "") === out.preview.replace(/routine created: [^;]+;/, ""),
    "preview: rendered through the SAME routines/fire-message.ts seam the dispatcher renders from — a preview that could drift from the fire is not expressible",
  );

  const watch = routine({ id: "r-prev-watch", trigger: { kind: "watch", everyMinutes: 15 } });
  const job = routine({ id: "r-prev-job", sessionMode: "job", jobState: "step 2 of 4 done" });
  const silent = routine({ id: "r-prev-silent", report: { kind: "silent" } });
  ok(renderFireMessage(watch).includes("[watch]"), "preview seam: a watch routine renders the post-on-diff protocol");
  ok(renderFireMessage(job).includes("[job]") && renderFireMessage(job).includes("step 2 of 4 done"), "preview seam: a durable job renders the job protocol AND its ledger");
  ok(renderFireMessage(silent).includes("[silent]"), "preview seam: a silent routine renders the trusted silent block");
  const jobWatch = routine({ id: "r-prev-jw", sessionMode: "job", trigger: { kind: "watch", everyMinutes: 15 } });
  ok(renderFireMessage(jobWatch).includes("[job]") && !renderFireMessage(jobWatch).includes("[watch]"), "preview seam: job is checked FIRST — the job protocol supersedes the watch protocol, exactly as the dispatcher's ternary did");
}

{
  const r = routine({ id: "r-run", nextRunAt: "2099-01-01T00:00:00.000Z" });
  await store.addRoutine(partition, r);

  const out = (await runNowTool.execute({ id: "r-run" } as never, ctx)) as { queued: boolean; dueAt: string | null; withinMinutes: number };
  ok(out.queued === true, "run-now: the request is accepted");
  ok(out.withinMinutes === DISPATCH_TICK_MINUTES, "run-now: the tool reports the REAL worst-case wait (one dispatcher tick) rather than implying it ran instantly");

  const after = (await store.getRoutine(ORG, SURFACE, "r-run"))!;
  ok(after.nextRunAt !== null && Date.parse(after.nextRunAt!) <= Date.now(), "run-now: the routine is now DUE — the ordinary dispatcher tick fires it, so every gate applies by construction");
  ok(after.manualRunAt !== undefined, "run-now: the manual request is stamped on the row, so the fire it causes can be audited as off-schedule");
  ok(
    after.trigger.kind === "interval" && (after.trigger as { everyMinutes: number }).everyMinutes === 30,
    "run-now: the SCHEDULE is untouched — a manual run is one extra run, never a cadence change",
  );

  const runNowRows = await rowsFor(ROUTINE_AUDIT.runNow);
  ok(runNowRows.length === 1, "run-now: writes exactly one routine.run_now row");
  ok(runNowRows[0]!.principalId === "U1" && detailOf(runNowRows[0], "requestedBy") === "U1", "run-now: the row names the real human who asked — routine.fire is stamped with the dispatcher principal and cannot");

  const second = (await runNowTool.execute({ id: "r-run" } as never, ctx)) as { queued: boolean; message: string };
  ok(second.queued === false, "run-now: a second request inside the window is refused (host-side per-routine rate limit)");
  ok((await rowsFor(ROUTINE_AUDIT.runNow)).length === 1, "run-now: the refused request writes no second audit row");

  const stamped = routineFireAttributes(after, { team_id: "T1", channel_id: "C1" }, "channel", true);
  ok(routineManualStamped(stamped), "run-now: routineFireAttributes stamps the MANUAL marker off the stored request — host-set and model-unforgeable");
  const scheduledAttrs = routineFireAttributes(routine({ id: "r-sched" }), { team_id: "T1", channel_id: "C1" }, "channel", true);
  ok(!routineManualStamped(scheduledAttrs), "run-now: an ordinary scheduled fire stamps NOTHING — positive-only, so its attribute bag is byte-identical to before");
  ok(!(ROUTINE_MARKER.manual in scheduledAttrs), "run-now: the manual key is absent (not present-and-false) on a scheduled fire");

  await store.addRoutine(partition, routine({ id: "r-off", status: "disabled", disabledReason: "auto-disabled after 3 consecutive failures" }));
  await refuses(() => runNowTool.execute({ id: "r-off" } as never, ctx), /enable_routine/, "run-now: refuses a DISABLED routine and points at the re-arm verb");
  await store.addRoutine(partition, routine({ id: "r-fin", status: "done", sessionMode: "job", completedReason: "migration finished" }));
  await refuses(() => runNowTool.execute({ id: "r-fin" } as never, ctx), /terminal/, "run-now: refuses a COMPLETED job — done is terminal, not paused");
  await store.addRoutine(partition, routine({ id: "r-evt", trigger: { kind: "event", source: "github" } }));
  await refuses(() => runNowTool.execute({ id: "r-evt" } as never, ctx), /event subscription/, "run-now: refuses an EVENT subscription — moving nextRunAt would change nothing, so a queued run would be a lie");
  await refuses(() => runNowTool.execute({ id: "r-nope" } as never, ctx), /No routine/, "run-now: refuses an unknown id");

  const fireCtx = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", [ROUTINE_MARKER.id]: "r-run" }, principalType: "service" } } },
  } as never;
  await refuses(() => runNowTool.execute({ id: "r-run" } as never, fireCtx), /verified sender|re-trigger/, "run-now: a routine FIRE (no acting sender) is refused — a routine may not re-trigger itself into a loop");
}

{
  const editKind = actionKind("routine.edit")!;
  ok(editKind !== undefined && editKind.policy === "member", "edit: routine.edit is registered at MEMBER policy — rewriting standing autonomy gets the same bar as arming it");

  const r = routine({
    id: "r-edit",
    prompt: "Old instruction.",
    trigger: { kind: "watch", everyMinutes: 15 },
    lastStateHash: "deadbeef",
    lastRunAt: "2026-07-20T09:00:00.000Z",
    lastOutcome: "ok",
    consecutiveFailures: 2,
    createdBy: "U7",
    taintedAtCreation: true,
  });
  await store.addRoutine(partition, r);

  const proposed = (await editTool.execute({ id: "r-edit", prompt: "New instruction." } as never, ctx)) as { pending: boolean; id: string };
  ok(proposed.pending === true, "edit: PROPOSES a card — it does not edit on the spot");
  ok((await store.getRoutine(ORG, SURFACE, "r-edit"))!.prompt === "Old instruction.", "edit: NOTHING changes until a human confirms");

  const args = {
    org: ORG,
    partition,
    surfaceKey: SURFACE,
    id: "r-edit",
    prompt: "New instruction.",
    previousPrompt: "Old instruction.",
    description: describeTrigger(r.trigger, r.report),
    requestedBy: "U1",
    trigger: r.trigger,
    tainted: true,
    generation: 1,
  };
  const card = editKind.summarize(args as never).join("\n");
  ok(card.includes("Old instruction.") && card.includes("New instruction."), "edit: the card renders BEFORE and AFTER — the one thing cancel+create could never show");
  ok(/REVOKED/.test(card), "edit: the card says the routine's standing approvals are revoked — the clicker is told what else the click does");
  ok(/⚠/.test(card), "edit: a tainted proposal carries the same ⚠ line create_routine uses");

  const msg = await editKind.execute(args as never, "U9");
  const after = (await store.getRoutine(ORG, SURFACE, "r-edit"))!;
  ok(after.prompt === "New instruction.", "edit: the click applies the new text");
  ok(typeof msg === "string" && msg.includes("r-edit"), "edit: the click returns a human-readable confirmation naming the routine");

  ok(after.id === "r-edit", "edit: the ID is preserved — every routine.fire row keyed on it still resolves");
  ok(after.createdAt === "2026-07-01T00:00:00.000Z", "edit: createdAt is preserved");
  ok(after.lastStateHash === "deadbeef", "edit: a watch's diff BASELINE is preserved — a fresh routine would re-report its whole state as changed");
  ok(after.lastRunAt === "2026-07-20T09:00:00.000Z" && after.lastOutcome === "ok", "edit: the last-run record is preserved");
  ok(after.consecutiveFailures === 2, "edit: the failure counter is preserved — an edit is not a way to launder a routine past the three-strike guard");
  ok(after.createdBy === "U7", "edit: the original creator is preserved (routines are surface-owned; an edit is not a change of ownership)");
  ok(after.taintedAtCreation === true, "edit: taintedAtCreation still describes CREATION — an edit does not rewrite the routine's origin story");
  ok(after.trigger.kind === "watch", "edit: the TRIGGER is untouched — the shape a human approved on the original card is not editable here");

  const editRows = await rowsFor("routine.edit");
  ok(editRows.length === 1, "edit: writes one routine.edit audit row");
  ok(detailOf(editRows[0], "editedBy") === "U9" && detailOf(editRows[0], "requestedBy") === "U1", "edit: the row separates who ASKED from who CLICKED");
  ok(detailOf(editRows[0], "grantsInvalidated") === true, "edit: the row records that standing authority was revoked");
  ok(editRows[0]!.detail!["prompt"] === undefined && editRows[0]!.detail!["previousPrompt"] === undefined, "edit: the audit row carries LENGTHS, not a second copy of the prompt text");

  await refuses(() => editTool.execute({ id: "r-edit", prompt: "New instruction." } as never, ctx), /already has/, "edit: refuses a no-op edit — it would revoke grants for nothing");
  await refuses(() => editTool.execute({ id: "r-nope", prompt: "x" } as never, ctx), /No routine/, "edit: refuses an unknown id");
  await refuses(() => editTool.execute({ id: "r-fin", prompt: "x" } as never, ctx), /terminal/, "edit: refuses a COMPLETED job — editing a routine that will never fire again changes nothing");

  const gone = await editKind.execute({ ...args, id: "r-vanished" } as never, "U9");
  ok(typeof gone === "string" && /gone|cancelled/.test(gone), "edit: a routine cancelled between propose and click is reported, not re-created");
  ok((await store.getRoutine(ORG, SURFACE, "r-vanished")) === null, "edit: …and nothing was written");
}

{
  const revs = await store.listRoutinePromptRevisions(ORG, SURFACE, "r-edit");
  ok(
    revs.some((r) => r.prompt === "Old instruction."),
    `revisions: THE SUPERSEDED INSTRUCTION SURVIVES the patch that overwrote it (recorded prompts: ${JSON.stringify(revs.map((r) => r.prompt))})`,
  );
  ok(revs.length === 2 && revs[0]!.seq < revs[1]!.seq, `revisions: one edit records the text it destroyed AND the text that replaced it, oldest first by seq (got ${revs.length})`);
  ok(revs[1]!.prompt === "New instruction.", "revisions: the replacing text is recorded too — the log plus the live row is the whole history");

  ok(revs[0]!.generation === 1 && revs[1]!.generation === 2, `revisions: each row carries the generation its text ran under (got ${revs[0]!.generation}/${revs[1]!.generation})`);
  ok(routineGrantKey({ id: "r-edit", promptGeneration: revs[0]!.generation }) !== routineGrantKey({ id: "r-edit", promptGeneration: revs[1]!.generation }), "revisions: those two generations are the two DIFFERENT grant keys — the log is joinable to the authority it explains");

  ok(revs[0]!.authoredBy === "U7" && revs[0]!.recordedAt === "2026-07-01T00:00:00.000Z", `revisions: the genesis row carries the routine's OWN createdBy + createdAt (got ${revs[0]!.authoredBy}/${revs[0]!.recordedAt})`);
  ok(revs[0]!.armedBy === undefined && revs[0]!.approvalId === undefined, "revisions: the genesis row claims NO approver — the store knows who created a routine, never who clicked the card that armed it");
  ok(revs[1]!.authoredBy === "U1" && revs[1]!.armedBy === "U9", "revisions: the new text separates who ASKED from who ARMED, exactly as the audit row does");
  ok(revs[1]!.approvalId === undefined, "revisions: driven outside a real click, the card join is absent and the write still happened (fail-soft, never refuses)");

  await store.updateRoutine(ORG, SURFACE, "r-edit", { lastRunAt: "2026-07-22T09:00:00.000Z", consecutiveFailures: 0 });
  ok((await store.listRoutinePromptRevisions(ORG, SURFACE, "r-edit")).length === 2, "revisions: a fire's own patch (nextRunAt/lastRunAt/counters) records nothing — the log grows with approved edits, not with traffic");
  ok((await store.getRoutine(ORG, SURFACE, "r-edit"))!.lastRunAt === "2026-07-22T09:00:00.000Z", "revisions: …and that patch still applied normally");
}

{
  const { requestApproval, resolveApprovalClick } = await import("../agent/approvals/flow.js");

  await store.addRoutine(partition, routine({ id: "r-armed", prompt: "Genesis text.", createdBy: "U7", promptGeneration: 3 }));
  const posted = await requestApproval(
    {
      org: ORG,
      kind: "routine.edit",
      args: {
        org: ORG,
        partition,
        surfaceKey: SURFACE,
        id: "r-armed",
        prompt: "Armed replacement.",
        previousPrompt: "Genesis text.",
        description: "every 30 min",
        requestedBy: "U_ASKER",
        trigger: { kind: "interval", everyMinutes: 30 },
        generation: 3,
      },
      scopeKey: SURFACE,
      domain: null,
      requestedBy: "U_ASKER",
      channelId: "C1",
    },
    { postCard: async () => "ts-routine-1" },
  );
  const decided = await resolveApprovalClick({ org: ORG, id: posted.id, decision: "approve", clickerId: "U_ARMER" });
  ok(decided.outcome === "decided", `arming: the click decides (outcome ${decided.outcome})`);

  const armed = await store.listRoutinePromptRevisions(ORG, SURFACE, "r-armed");
  ok(armed.length === 2 && armed[0]!.prompt === "Genesis text." && armed[1]!.prompt === "Armed replacement.", `arming: the click records both texts (got ${JSON.stringify(armed.map((r) => r.prompt))})`);
  ok(armed[1]!.approvalId === posted.id, `arming: the new text names the CARD that armed it (${armed[1]!.approvalId} vs ${posted.id})`);
  ok(armed[1]!.armedBy === "U_ARMER" && armed[1]!.authoredBy === "U_ASKER", "arming: armer and asker are recorded separately — they are different people");
  ok(armed[0]!.approvalId === undefined, "arming: the genesis row is NOT credited to this card — that card armed the text that replaced it");
  ok(armed[0]!.generation === 3 && armed[1]!.generation === 4, "arming: the recorded generations bracket the authority the click revoked");
  ok((await store.getRoutine(ORG, SURFACE, "r-armed"))!.prompt === "Armed replacement.", "arming: the LIVE row is the latest text (the log is history, not a replacement)");

  await store.removeRoutine(partition, "r-armed");
  ok((await store.getRoutine(ORG, SURFACE, "r-armed")) === null, "arming: the routine is cancelled");
  const swept = await store.listRoutinePromptRevisions(ORG, SURFACE);
  ok(swept.filter((r) => r.routineId === "r-armed").length === 2, "arming: cancelling does NOT un-record what was armed — an append-only log doesn't retract");
  ok(swept.some((r) => r.routineId === "r-edit"), "arming: omitting the id sweeps the whole surface, not one routine");
  ok((await store.listRoutinePromptRevisions("other-org", SURFACE)).length === 0, "arming: another org's log never leaks into this one");
}

{
  const before = (await store.getRoutine(ORG, SURFACE, "r-edit"))!;
  ok(routineGrantGeneration(before) === 2, "invalidate: the edit above advanced the routine's authority generation");

  const g1 = routineGrantKey({ id: "r-edit", promptGeneration: 1 });
  const g2 = routineGrantKey(before);
  ok(g1 !== g2, "invalidate: the standing-grant key MOVED — every grant frozen against the old text is now unreachable by lookup, declared and accumulated alike");
  ok(g2.includes("r-edit") && /:g2$/.test(g2), "invalidate: the key names the routine AND its generation (the shape a session grant already uses for window rotation)");
  ok(routineGrantKey({ id: "r-edit" }) === g1, "invalidate: an absent generation reads as 1 — every pre-OPE-147 row keeps the key it already had, no migration");
  ok(routineGrantKey({ id: "r-x", promptGeneration: 0 }) === routineGrantKey({ id: "r-x", promptGeneration: 1 }), "invalidate: a zero/garbage generation floors to 1 rather than minting a key that collides with another generation's");

  ok(jobFireSeatKey("r-edit", 1) !== jobFireSeatKey("r-edit", 2), "invalidate: an edited JOB rotates onto a FRESH eve seat — a long-lived seat answers from its own backscroll, so keeping it would keep the pre-edit behaviour");
  ok(jobFireSeatKey("r-edit", 1) === jobFireSeatKey("r-edit"), "invalidate: generation 1 is the default seat — every job created before OPE-147 keeps the seat it already has");
  ok(jobFireSeatKey("r-edit", 2) === jobFireSeatKey("r-edit", 2), "invalidate: the rotated seat is STABLE across fires within a generation (the OPE-55 durable-job join survives)");
  ok(!jobFireSeatKey("a:b", 3).includes(":"), "invalidate: the seat key stays colon-free at any generation (a windowId is `[^:]+`)");

  const enableKind = actionKind("routine.enable")!;
  await store.addRoutine(partition, routine({ id: "r-gen", promptGeneration: 4, status: "disabled", disabledReason: "auto-disabled after 3 consecutive failures", consecutiveFailures: 3 }));
  await enableKind.execute(
    { org: ORG, partition, surfaceKey: SURFACE, id: "r-gen", description: "every 30 min", disabledReason: "auto-disabled after 3 consecutive failures", consecutiveFailures: 3, prompt: "Post the morning digest.", trigger: { kind: "interval", everyMinutes: 30 }, requestedBy: "U1" } as never,
    "U9",
  );
  const rearmed = (await store.getRoutine(ORG, SURFACE, "r-gen"))!;
  ok(routineGrantGeneration(rearmed) === 4, "invalidate: enable_routine does NOT bump the generation — re-arming changes no text, so a grant given to this exact instruction still applies");
}

{
  const enableKind = actionKind("routine.enable")!;
  ok(enableKind.policy === "member", "enable: routine.enable is registered at MEMBER policy — re-arming standing autonomy gets the same bar as arming it");

  const r = routine({
    id: "r-revive",
    status: "disabled",
    disabledReason: "auto-disabled after 3 consecutive failures",
    consecutiveFailures: 3,
    nextRunAt: null,
    lastStateHash: "cafe1234",
    sessionMode: "job",
    jobState: "chased 4 of 9 tickets",
    jobSessionAnchor: "1700000000.9999",
    trigger: { kind: "interval", everyMinutes: 30 },
  });
  await store.addRoutine(partition, r);

  const proposed = (await enableTool.execute({ id: "r-revive" } as never, ctx)) as { pending: boolean };
  ok(proposed.pending === true, "enable: PROPOSES a card — it does not re-arm on the spot");
  ok((await store.getRoutine(ORG, SURFACE, "r-revive"))!.status === "disabled", "enable: NOTHING changes until a human confirms");

  const args = {
    org: ORG,
    partition,
    surfaceKey: SURFACE,
    id: "r-revive",
    description: "every 30 min (posts every run)",
    disabledReason: "auto-disabled after 3 consecutive failures",
    consecutiveFailures: 3,
    prompt: r.prompt,
    trigger: r.trigger,
    requestedBy: "U1",
  };
  const card = enableKind.summarize(args as never).join("\n");
  ok(/Stopped because/.test(card) && card.includes("3 consecutive failures"), "enable: the card names WHY it stopped — the clicker confirms a diagnosis, not just a button");
  ok(/WITHOUT a fresh @-mention/.test(card), "enable: the card states plainly that it will fire unattended again");

  await enableKind.execute(args as never, "U9");
  const after = (await store.getRoutine(ORG, SURFACE, "r-revive"))!;
  ok(after.status === "active", "enable: the click revives the routine");
  ok(after.consecutiveFailures === 0, "enable: the failure counter is CLEARED — leaving it at the threshold would re-disable on the very next failure, which reads as 'enable didn't work'");
  ok(after.disabledReason === undefined, "enable: the stale disable reason is cleared");
  ok(after.nextRunAt !== null && Date.parse(after.nextRunAt!) > Date.now(), "enable: the next run is recomputed at CLICK time — a routine that sat disabled for days must not fire against an ancient due instant");

  ok(after.id === "r-revive" && after.createdAt === "2026-07-01T00:00:00.000Z", "enable: the id and createdAt survive — the forensic rows keyed on the id still resolve");
  ok(after.lastStateHash === "cafe1234", "enable: a watch's diff baseline survives");
  ok(after.jobState === "chased 4 of 9 tickets", "enable: a durable job's PROGRESS LEDGER survives — recovery does not restart the work");
  ok(after.jobSessionAnchor === "1700000000.9999", "enable: the job's thread anchor survives");

  const enableRows = await rowsFor("routine.enable");
  ok(enableRows.length >= 1, "enable: writes a routine.enable audit row");
  const row = enableRows.find((e) => detailOf(e, "id") === "r-revive");
  ok(detailOf(row, "armedBy") === "U9" && detailOf(row, "requestedBy") === "U1", "enable: the row separates who ASKED from who CLICKED");
  ok(detailOf(row, "clearedFailures") === 3, "enable: the row records how many strikes were cleared — a routine repeatedly revived is visible");

  await refuses(() => enableTool.execute({ id: "r-revive" } as never, ctx), /already active/, "enable: refuses an already-active routine");
  await refuses(() => enableTool.execute({ id: "r-fin" } as never, ctx), /terminal/, "enable: refuses a COMPLETED job — complete_job is an objective finishing, not a failure to recover from");
  await store.addRoutine(partition, routine({ id: "r-spent", status: "disabled", disabledReason: "once: fired at 2026-07-01T00:00:00.000Z", trigger: { kind: "once", at: "2026-07-01T00:00:00.000Z" } }));
  await refuses(() => enableTool.execute({ id: "r-spent" } as never, ctx), /one-shot/, "enable: refuses a SPENT one-shot — computeNextRun returns null for `once`, so enabling it would leave an active routine that can never fire");
  await refuses(() => enableTool.execute({ id: "r-nope" } as never, ctx), /No routine/, "enable: refuses an unknown id");
}

{
  const outcomeHook = (await import("../agent/hooks/routine-outcome.js")).default;
  const r = routine({ id: "r-manual-fold" });
  await store.addRoutine(partition, r);

  const firedCtx = (manual: boolean, sessionId: string) =>
    ({
      channel: { kind: "slack" },
      session: {
        id: sessionId,
        auth: {
          current: {
            attributes: {
              team_id: "T1",
              channel_id: "C1",
              [ROUTINE_MARKER.id]: r.id,
              [ROUTINE_MARKER.surface]: r.surfaceKey,
              [ROUTINE_MARKER.org]: r.org,
              ...(manual ? { [ROUTINE_MARKER.manual]: "true" } : {}),
            },
            principalType: "service",
          },
        },
      },
    }) as never;

  await outcomeHook.events!["session.completed"]!({} as never, firedCtx(true, "sess-manual"));
  const manualRow = (await rowsFor(ROUTINE_AUDIT.fire)).find((e) => detailOf(e, "sessionId") === "sess-manual");
  ok(detailOf(manualRow, "manual") === true, "fold: a MANUAL fire's routine.fire row says so — 'why did this run at 14:07 when it is a 03:00 cron?' is answerable from the audit trail");

  await outcomeHook.events!["session.completed"]!({} as never, firedCtx(false, "sess-clock"));
  const clockRow = (await rowsFor(ROUTINE_AUDIT.fire)).find((e) => detailOf(e, "sessionId") === "sess-clock");
  ok(clockRow !== undefined && clockRow!.detail!["manual"] === undefined, "fold: a SCHEDULED fire's row omits the field entirely — positive-only, so no existing reader has to learn a new default");
}

{
  const checkIn = await import("../agent/routines/check-in.js");
  const exported = Object.keys(checkIn).sort();
  ok(
    JSON.stringify(exported) === JSON.stringify(["CHECK_IN_CAP_MS", "CHECK_IN_DOCTRINE", "CHECK_IN_START_MS"]),
    `backoff: check-in.ts exports ONLY the two constants and the doctrine string the model actually reads — anything else is uncalled math (got: ${exported.join(", ")})`,
  );
  ok(checkIn.CHECK_IN_DOCTRINE.includes(String(checkIn.CHECK_IN_START_MS / 60_000)), "backoff: the doctrine string is BUILT from the constants, so prose and numbers cannot drift");
  ok(DISPATCH_TICK_MINUTES > checkIn.CHECK_IN_START_MS / 60_000, "backoff: the dispatcher tick is COARSER than the deleted 1-min floor — which is why enforcing that floor in code enforced nothing");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ routine authoring (OPE-147): ${passed} assertions passed (preview + run-now + edit + grant invalidation + prompt revisions + re-arm)`);
