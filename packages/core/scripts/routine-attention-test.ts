import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-routine-attention-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });
overrideSettingsForTest({ delegation: { oneshotAgent: false } });
overrideSettingsForTest({ window: { topology: false } });

const attention = await import("../agent/routines/attention.js");
const { SETTINGS } = await import("../agent/settings/settings.js");
type Routine = import("../agent/routines/routine.js").Routine;

{
  ok(SETTINGS.routines.attentionWarnRuns.shipped === 100, "shipped: the Keep going card comes after 100 runs with no check-in");
  ok(SETTINGS.routines.attentionPauseRuns.shipped === 24, "shipped: the pause comes 24 runs after the card — a full day of grace at an hourly cadence");
  ok(attention.attentionWarnRuns() === 100 && attention.attentionPauseRuns() === 24, "nothing overridden ⇒ the shipped numbers are what the dispatcher reads");

  const base = { status: "active" as const, trigger: { kind: "interval" as const, everyMinutes: 60 } };
  ok(attention.attentionStep({ ...base }, 3, 2).kind === "none", "verdict: a fresh routine has nothing to do");
  ok(attention.attentionStep({ ...base, attention: { runs: 2 } }, 3, 2).kind === "none", "verdict: below the warning count, nothing");
  const warn = attention.attentionStep({ ...base, attention: { runs: 3 } }, 3, 2);
  ok(warn.kind === "warn" && warn.runsLeft === 2, "verdict: AT the warning count it warns, and names the runs left");
  ok(attention.attentionStep({ ...base, attention: { runs: 4, warnedAtRun: 3, cardId: "c" } }, 3, 2).kind === "none", "verdict: once warned it does not warn again");
  ok(attention.attentionStep({ ...base, attention: { runs: 5, warnedAtRun: 3, cardId: "c" } }, 3, 2).kind === "pause", "verdict: `pause` runs after the warning, it pauses");
  ok(
    attention.attentionStep({ ...base, attention: { runs: 9 } }, 3, 2).kind === "warn",
    "🔴 verdict: a routine far past both counts but NEVER warned warns first — a routine never pauses without a posted card",
  );
  ok(attention.attentionStep({ ...base, attention: { runs: 500 } }, 0, 2).kind === "none", "verdict: `attentionWarnRuns: 0` turns the check off");
  ok(attention.attentionStep({ ...base, status: "disabled", attention: { runs: 500 } }, 3, 2).kind === "none", "verdict: a stopped routine is never asked");

  ok(Object.keys(attention.attentionCountPatch({ trigger: { kind: "once", at: "2026-07-02T00:00:00.000Z" } })).length === 0, "count: a one-shot is never counted — its row stays byte-identical");
  ok(Object.keys(attention.attentionCountPatch({ trigger: { kind: "event", source: "github" } })).length === 0, "count: an event routine is never counted");
  ok(attention.attentionCountPatch({ trigger: { kind: "cron", expr: "0 9 * * *" }, attention: { runs: 4, warnedAtRun: 3, cardId: "c" } }).attention?.runs === 5, "count: a cron routine counts one more run");
  ok(attention.attentionCountPatch({ trigger: { kind: "cron", expr: "0 9 * * *" }, attention: { runs: 4, warnedAtRun: 3, cardId: "c" } }).attention?.warnedAtRun === 3, "count: …and keeps the warning it carries");
  ok(attention.attentionRuns({ attention: { runs: -4 } }) === 0 && attention.attentionRuns({ attention: { runs: 2.5 } }) === 0, "count: a garbage stored count reads as zero");
}

const ORG = "acme";
const CHAN = "C-CHECKIN";
const SURFACE = `slack/T1/${CHAN}`;

const { registerSlackTestBridge, registerSlackFixtureMapper, registerSlackFixtureCodec } = await import("./_slack-test-stubs.js");
registerSlackTestBridge();
registerSlackFixtureMapper();
registerSlackFixtureCodec();

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { registerPostArm } = await import("../agent/channels/post-arms.js");
registerPostArm({ platform: "slack", dispatchUnified: async () => "ts-notice" });

const dispatch = await import("../agent/schedules/dispatch.js");
const routineStore = await import("../agent/routines/store.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { ROUTINE_AUDIT } = await import("../agent/routines/fire-audit.js");
const flow = await import("../agent/approvals/flow.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { pendingCardOptions } = await import("../agent/approvals/card-layout.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");

interface PostedCard {
  readonly channel: string;
  readonly text: string;
  readonly buttons: readonly string[];
}
const cards: PostedCard[] = [];
let onCardPost: (() => Promise<void>) | undefined;
const LATER = () => new Date(Date.now() + 60 * 60_000);
let cardSeq = 0;
const slackPost = async (method: string, body: string): Promise<Record<string, unknown>> => {
  if (method === "chat.postMessage") {
    const form = new URLSearchParams(body);
    const blocks = JSON.parse(form.get("blocks") ?? "[]") as { type: string; elements?: { text?: { text?: string } }[] }[];
    const buttons = blocks.filter((b) => b.type === "actions").flatMap((b) => (b.elements ?? []).map((e) => e.text?.text ?? ""));
    cards.push({ channel: form.get("channel") ?? "", text: form.get("text") ?? "", buttons });
    if (onCardPost) await onCardPost();
  }
  return { ok: true, ts: `1759836620.${String(++cardSeq).padStart(6, "0")}` };
};

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: CHAN },
    trigger: { kind: "interval", everyMinutes: 15 },
    prompt: "Post the open incident count.",
    createdBy: "U-OWNER",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2026-07-02T12:00:00.000Z",
    ...over,
  };
}

let receives = 0;
const okReceive = (() => ({
  send: async () => {
    receives++;
  },
})) as never;

let clock = Date.parse("2026-07-02T12:00:00.000Z");
async function tick(): Promise<void> {
  const now = new Date(clock);
  clock += 15 * 60_000;
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now,
    to: okReceive,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: {} },
    attention: { post: slackPost },
  } as never);
  await Promise.all(pending);
}

async function makeDue(id: string): Promise<void> {
  await routineStore.updateRoutine(ORG, SURFACE, id, { nextRunAt: new Date(clock).toISOString() });
}

async function pendingRow(id: string) {
  return getOperationalStore().getPendingAction(ORG, id);
}

async function press(cardId: string, who: string): Promise<string> {
  const row = await pendingRow(cardId);
  if (!row) throw new Error("no card row");
  return actionKind(row.kind)!.execute(JSON.parse(row.argsJson), who);
}

overrideSettingsForTest({ routines: { attentionWarnRuns: 3, attentionPauseRuns: 2 } });

{
  const id = "r-digest";
  await routineStore.addRoutine({} as never, routine({ id }));
  const before = receives;

  for (let i = 0; i < 3; i++) await tick();
  ok(receives - before === 3, "e2e: three runs, three fires — the check-in does not interfere before its count");
  ok(cards.length === 0, "e2e: and no card yet");
  ok((await routineStore.getRoutine(ORG, SURFACE, id))?.attention?.runs === 3, "e2e: the row counts the three runs");

  await tick();
  ok(cards.length === 1, "🔴 e2e: after three runs with no check-in the routine posts ONE Keep going card — remove the check-in and no card ever posts");
  const warnCard = cards[0]!;
  ok(warnCard.channel === CHAN, "e2e: the card lands where the routine's reports land");
  ok(warnCard.buttons[0] === "Keep going" && warnCard.buttons.at(-1) === "Let it pause", "e2e: its buttons say Keep going and Let it pause, not Approve and Reject");
  ok(/^\*?Keep the routine that runs every 15 min running\?/u.test(warnCard.text), "e2e: the headline names the routine in friendly words");
  ok(/2 more/u.test(warnCard.text), "e2e: the card says how many runs are left before the pause");
  ok(!warnCard.text.includes(id) && !warnCard.text.includes(CHAN), "e2e: no raw routine or channel id reaches the card");
  ok(receives - before === 4, "e2e: the warning tick still fires — the card is a warning, not the stop");
  const warned = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(warned?.attention?.warnedAtRun === 3 && typeof warned.attention.cardId === "string", "e2e: the row records the run the card posted at, and the card");
  ok(warned?.attention?.runs === 4, "🔴 e2e: the run-count write builds on the fresh warning — the warning survives the same tick's count");
  const warnCardId = warned!.attention!.cardId!;

  await tick();
  ok(receives - before === 5, "e2e: the grace run fires");
  ok(cards.length === 1, "e2e: and posts no second Keep going card");

  await tick();
  const paused = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(receives - before === 5, "🔴 e2e: after its grace, the next tick does NOT fire — remove the pause and this is 6, and climbs forever");
  ok(paused?.status === "disabled" && paused.nextRunAt === null, "🔴 e2e: the routine paused itself");
  ok(attention.isPausedForCheckIn(paused!), "e2e: …and the row says the check-in paused it");
  ok(paused?.consecutiveFailures === 0, "e2e: with no failure recorded, because nothing failed");
  ok(cards.length === 2, "e2e: the pause says so ONCE, with a card");
  const resumeCard = cards[1]!;
  ok(resumeCard.buttons[0] === "Resume" && resumeCard.buttons.at(-1) === "Leave paused", "e2e: the pause card's buttons say Resume and Leave paused");
  ok(/^\*?Resume the routine that runs every 15 min\?/u.test(resumeCard.text), "e2e: the pause card's headline");
  ok(paused?.attention?.cardId !== warnCardId, "e2e: the Resume card is now the routine's live card");

  const rows = await readAudit({ org: ORG, limit: 500 });
  const disabled = rows.filter((r) => r.action === ROUTINE_AUDIT.disabled && (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok(disabled.length === 1 && (disabled[0]!.detail as Record<string, unknown>)["checkIn"] === true, "forensics: one routine.disabled row, marked as a check-in pause");

  await tick();
  ok(receives - before === 5 && cards.length === 2, "e2e: a paused routine is not dispatched again, and posts nothing more");

  const answer = await press(paused!.attention!.cardId!, "U-MEMBER");
  const resumed = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(resumed?.status === "active" && resumed.disabledReason === undefined, "🔴 resume: a Resume press starts the routine again");
  ok(resumed?.attention === undefined, "resume: the check-in count starts again from zero");
  ok(typeof resumed?.nextRunAt === "string" && Date.parse(resumed.nextRunAt) > Date.parse("2026-07-01T00:00:00.000Z"), "resume: with a fresh next run");
  ok(answer.startsWith("resumed the routine that runs every 15 min"), "resume: the outcome line names the routine in friendly words");
  ok(!answer.includes(id), "resume: …and no raw id");
  const checkins = (await readAudit({ org: ORG, limit: 500 })).filter((r) => r.action === "routine.checkin");
  ok(checkins.length === 1 && (checkins[0]!.detail as Record<string, unknown>)["resumed"] === true && checkins[0]!.principalId === "U-MEMBER", "resume: one routine.checkin row names who pressed");

  ok((await flow.reapSupersededRoutineCards(ORG)) === 0, "🔴 sweep: a card younger than two ticks is never reaped, even when its routine does not name it");
  const reaped = await flow.reapSupersededRoutineCards(ORG, LATER());
  ok(reaped === 2, "🔴 sweep: both check-in cards stopped being live, and the sweep expires both");
  ok((await pendingRow(warnCardId))?.status === "expired", "sweep: the old Keep going card no longer has live buttons");

  await makeDue(id);
  const fired = receives;
  await tick();
  ok(receives === fired + 1, "resume: the next tick fires it again");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const id = "r-monitor";
  await routineStore.addRoutine({} as never, routine({ id, nextRunAt: new Date(clock).toISOString() }));
  const cardsBefore = cards.length;
  for (let i = 0; i < 4; i++) await tick();
  ok(cards.length === cardsBefore + 1, "keep going: the card posted");
  const warned = await routineStore.getRoutine(ORG, SURFACE, id);
  const answer = await press(warned!.attention!.cardId!, "U-MEMBER");
  ok(answer.startsWith("kept the routine that runs every 15 min running"), "keep going: the outcome line");
  ok((await routineStore.getRoutine(ORG, SURFACE, id))?.attention === undefined, "🔴 keep going: a press clears the count — remove the reset and the next ticks pause it");
  const before = receives;
  for (let i = 0; i < 3; i++) await tick();
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.status === "active" && receives - before === 3, "keep going: the routine keeps firing past the old pause point");
  ok(after?.attention?.runs === 3 && after.attention.warnedAtRun === undefined, "keep going: …and counts again from zero");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const id = "r-race";
  await routineStore.addRoutine({} as never, routine({ id, nextRunAt: new Date(clock).toISOString(), attention: { runs: 3 } }));
  onCardPost = async () => {
    await routineStore.updateRoutine(ORG, SURFACE, id, attention.attentionResetPatch());
  };
  const before = cards.length;
  await tick();
  onCardPost = undefined;
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(cards.length === before + 1, "race: the card posted");
  ok(after?.attention?.warnedAtRun === undefined, "🔴 race: the warning is not written over a check-in that landed while the card posted");
  ok(after?.attention?.runs === 1, "🔴 race: the run count builds on the live, cleared count — the listed copy would put 4 back");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const id = "r-broken";
  await routineStore.addRoutine({} as never, routine({ id, nextRunAt: new Date(clock).toISOString() }));
  for (let i = 0; i < 4; i++) await tick();
  const warned = await routineStore.getRoutine(ORG, SURFACE, id);
  const cardId = warned!.attention!.cardId!;
  await routineStore.updateRoutine(ORG, SURFACE, id, { status: "disabled", disabledReason: "failed 3 times in a row", nextRunAt: null, consecutiveFailures: 3 });
  const answer = await press(cardId, "U-MEMBER");
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.status === "disabled" && after.disabledReason === "failed 3 times in a row", "🔴 stale: a Keep going press on a routine that stopped for another reason changes nothing");
  ok(/another reason/u.test(answer), "stale: …and says so");
  ok(!attention.isPausedForCheckIn({ status: "disabled", disabledReason: "failed 3 times in a row", attention: { runs: 9, pausedAt: "2026-07-02T00:00:00.000Z" } }), "stale: a stamp alone does not make a routine resumable — the reason must be the check-in's");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
  ok(/no longer exists/u.test(await press(cardId, "U-MEMBER")), "stale: a press after a delete changes nothing and says so");
}

{
  const id = "r-roomless";
  const r = routine({ id, nextRunAt: new Date(clock).toISOString(), attention: { runs: 50 } });
  const { applyRoutineAttention } = await import("../agent/schedules/routine-attention.js");
  const outcome = await applyRoutineAttention(r, new Date(clock), { conversationId: "19:abc" }, { post: slackPost });
  ok(outcome.kind === "none", "roomless: a routine whose room cannot take a card is not warned");
  ok(attention.attentionStep({ ...r }).kind === "warn", "roomless: …even though its count says it is due — so it can never reach the pause");
}

{
  const id = "r-edited";
  await routineStore.addRoutine({} as never, routine({ id, attention: { runs: 4, warnedAtRun: 3, cardId: "card-x" } }));
  const partition = { org: ORG, platform: "slack", workspace: "T1", surface: CHAN, workspaceKey: "slack/T1", surfaceKey: SURFACE, key: SURFACE };
  await actionKind("routine.edit")!.execute(
    {
      org: ORG,
      partition,
      surfaceKey: SURFACE,
      id,
      prompt: "Post the open incident count, grouped by team.",
      previousPrompt: "Post the open incident count.",
      description: "every 15 min (posts every run)",
      requestedBy: "U-OWNER",
      trigger: { kind: "interval", everyMinutes: 15 },
      generation: 1,
    },
    "U-MEMBER",
  );
  ok((await routineStore.getRoutine(ORG, SURFACE, id))?.attention === undefined, "🔴 edit: a carded edit clears the check-in count");

  await routineStore.updateRoutine(ORG, SURFACE, id, { status: "disabled", disabledReason: attention.attentionPauseReason(5), nextRunAt: null, attention: { runs: 5, warnedAtRun: 3, cardId: "card-y", pausedAt: "2026-07-02T00:00:00.000Z" } });
  await actionKind("routine.enable")!.execute(
    {
      org: ORG,
      partition,
      surfaceKey: SURFACE,
      id,
      description: "every 15 min (posts every run)",
      disabledReason: attention.attentionPauseReason(5),
      consecutiveFailures: 0,
      prompt: "Post the open incident count, grouped by team.",
      trigger: { kind: "interval", everyMinutes: 15 },
      requestedBy: "U-OWNER",
    },
    "U-MEMBER",
  );
  const enabled = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(enabled?.status === "active" && enabled.attention === undefined, "🔴 enable: `enable_routine` lifts a check-in pause and starts the count again — otherwise it would pause on its very next tick");
}

{
  const id = "r-paused-edit";
  const pausedAt = "2026-07-02T00:00:00.000Z";
  await routineStore.addRoutine(
    {} as never,
    routine({ id, status: "disabled", disabledReason: attention.attentionPauseReason(124), nextRunAt: null, attention: { runs: 124, warnedAtRun: 100, cardId: "card-z", pausedAt } }),
  );
  const partition = { org: ORG, platform: "slack", workspace: "T1", surface: CHAN, workspaceKey: "slack/T1", surfaceKey: SURFACE, key: SURFACE };
  await actionKind("routine.edit")!.execute(
    {
      org: ORG,
      partition,
      surfaceKey: SURFACE,
      id,
      prompt: "Post the open incident count, by severity.",
      previousPrompt: "Post the open incident count.",
      description: "every 15 min (posts every run)",
      requestedBy: "U-OWNER",
      trigger: { kind: "interval", everyMinutes: 15 },
      generation: 1,
    },
    "U-MEMBER",
  );
  const edited = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(edited !== null && attention.isPausedForCheckIn(edited), "🔴 paused edit: an edit on a routine the check-in paused keeps the pause record — clearing it would break the Resume card");
  const resumeArgs = attention.attentionCardArgs(edited!, "paused", 124);
  const answer = await actionKind(attention.ROUTINE_ATTENTION_KIND)!.execute(resumeArgs, "U-MEMBER");
  ok((await routineStore.getRoutine(ORG, SURFACE, id))?.status === "active" && answer.startsWith("resumed"), "paused edit: …so a Resume press still starts it again");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const id = "r-paused-rule";
  const pausedAt = "2026-07-02T00:00:00.000Z";
  await routineStore.addRoutine(
    {} as never,
    routine({ id, status: "disabled", disabledReason: attention.attentionPauseReason(124), nextRunAt: null, attention: { runs: 124, warnedAtRun: 100, cardId: "card-r", pausedAt } }),
  );
  const partition = { org: ORG, platform: "slack", workspace: "T1", surface: CHAN, workspaceKey: "slack/T1", surfaceKey: SURFACE, key: SURFACE };
  const common = { org: ORG, partition, surfaceKey: SURFACE, routineId: id, description: "every 15 min (posts every run)", ruleId: "p-checkin-1", requestedBy: "U-OWNER" };
  await actionKind("routine.policy.add")!.execute({ ...common, rule: "Skip weekends.", why: "Nobody reads it then.", source: "human", countBefore: 0 }, "U-MEMBER");
  const added = await routineStore.getRoutine(ORG, SURFACE, id);
  ok((added?.policy ?? []).length === 1 && attention.isPausedForCheckIn(added!), "🔴 paused rule: adding a rule to a paused routine keeps its pause record");
  await actionKind("routine.policy.remove")!.execute(
    { ...common, ruleText: "Skip weekends.", why: "Nobody reads it then.", addedAt: added!.policy![0]!.addedAt, addedBy: "U-MEMBER", countBefore: 1 },
    "U-MEMBER",
  );
  const removed = await routineStore.getRoutine(ORG, SURFACE, id);
  ok((removed?.policy ?? []).length === 0 && attention.isPausedForCheckIn(removed!), "🔴 paused rule: removing it keeps the pause record too");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const id = "r-press-during-pause";
  const r0 = routine({ id, nextRunAt: new Date(clock).toISOString(), attention: { runs: 5, warnedAtRun: 3, cardId: "card-w" } });
  await routineStore.addRoutine({} as never, r0);
  onCardPost = async () => {
    await actionKind(attention.ROUTINE_ATTENTION_KIND)!.execute(attention.attentionCardArgs(r0, "warn", 3, 2), "U-MEMBER");
  };
  await tick();
  onCardPost = undefined;
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.status === "active", "press during pause: the press resumed the routine");
  ok(after?.attention === undefined, "🔴 press during pause: the Resume card's id is not written back over the press — that would pause it again next tick");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const id = "r-line";
  const r0 = routine({ id, attention: { runs: 3, warnedAtRun: 3, cardId: "card-l" } });
  await routineStore.addRoutine({} as never, r0);
  const press = () => actionKind(attention.ROUTINE_ATTENTION_KIND)!.execute(attention.attentionCardArgs(r0, "warn", 3, 2), "U-MEMBER");
  ok(/check again after 3 more runs/u.test(await press()), "line: with the check on, the line names the next check");
  overrideSettingsForTest({ routines: { attentionWarnRuns: 0 } });
  const off = await press();
  ok(!/check again/u.test(off) && off.startsWith("kept the routine"), "🔴 line: with the check off, it promises no next check — 'after 0 more runs' would be false");
  overrideSettingsForTest({ routines: { attentionWarnRuns: 3 } });
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const { registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
  const real = getOperationalStore();
  let between: { readonly id: string; readonly land: () => Promise<unknown> } | undefined;
  const take = (id: string): (() => Promise<unknown>) | undefined => {
    if (between?.id !== id) return undefined;
    const land = between.land;
    between = undefined;
    return land;
  };
  registerOperationalStore({
    ...real,
    async getRoutine(org, surfaceKey, id) {
      const read = await real.getRoutine(org, surfaceKey, id);
      await take(id)?.();
      return read;
    },
    async updateRoutineIf(org, surfaceKey, id, precondition, patch, provenance) {
      await take(id)?.();
      return real.updateRoutineIf(org, surfaceKey, id, precondition, patch, provenance);
    },
  });
  resetOperationalStore();

  {
    const id = "r-press-meets-pause";
    const r0 = routine({ id, attention: { runs: 5, warnedAtRun: 3, cardId: "card-pp" } });
    await routineStore.addRoutine({} as never, r0);
    between = { id, land: () => routineStore.updateRoutine(ORG, SURFACE, id, attention.attentionPausePatch(r0, 5, new Date(clock))) };
    const answer = await actionKind(attention.ROUTINE_ATTENTION_KIND)!.execute(attention.attentionCardArgs(r0, "warn", 3, 2), "U-MEMBER");
    const after = await routineStore.getRoutine(ORG, SURFACE, id);
    ok(between === undefined, "precondition: the pause landed inside the press");
    ok(!(after?.status === "disabled" && !attention.isPausedForCheckIn(after)), "🔴 press meets pause: the routine is never left disabled with no pause record — that row no card can resume");
    ok(after?.status === "active" && after.attention === undefined && answer.startsWith("resumed"), `🔴 press meets pause: the press decides on the paused row and resumes it (answer: ${answer})`);
    await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
  }

  {
    const id = "r-pause-meets-reply";
    await routineStore.addRoutine({} as never, routine({ id, nextRunAt: new Date(clock).toISOString(), attention: { runs: 5, warnedAtRun: 3, cardId: "card-pr" } }));
    between = { id, land: () => routineStore.updateRoutine(ORG, SURFACE, id, attention.attentionResetPatch()) };
    const before = receives;
    await tick();
    const after = await routineStore.getRoutine(ORG, SURFACE, id);
    ok(between === undefined, "precondition: the check-in landed inside the tick");
    ok(after?.status === "active", "🔴 pause meets reply: a check-in that lands after the tick's read wins, and the routine is not paused");
    ok(receives - before === 1 && after?.attention?.runs === 1, "pause meets reply: …so it fires as usual and counts again from zero");
    await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
  }

  {
    const id = "r-count-meets-reply";
    await routineStore.addRoutine({} as never, routine({ id, nextRunAt: new Date(clock).toISOString(), attention: { runs: 2 } }));
    between = { id, land: () => routineStore.updateRoutine(ORG, SURFACE, id, attention.attentionResetPatch()) };
    await tick();
    const after = await routineStore.getRoutine(ORG, SURFACE, id);
    ok(between === undefined, "precondition: the check-in landed inside the tick's count write");
    ok(after?.attention?.runs === 1, `🔴 count meets reply: the count builds on the cleared record, so the check-in stands (runs ${after?.attention?.runs})`);
    await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
  }

  {
    const partition = { org: ORG, platform: "slack", workspace: "T1", surface: CHAN, workspaceKey: "slack/T1", surfaceKey: SURFACE, key: SURFACE };
    const id = "r-edit-meets-pause";
    const r0 = routine({ id, attention: { runs: 5, warnedAtRun: 3, cardId: "card-ep" } });
    await routineStore.addRoutine({} as never, r0);
    between = { id, land: () => routineStore.updateRoutine(ORG, SURFACE, id, attention.attentionPausePatch(r0, 5, new Date(clock))) };
    await actionKind("routine.edit")!.execute(
      {
        org: ORG,
        partition,
        surfaceKey: SURFACE,
        id,
        prompt: "Post the open incident count, by team.",
        previousPrompt: "Post the open incident count.",
        description: "every 15 min (posts every run)",
        requestedBy: "U-OWNER",
        trigger: { kind: "interval", everyMinutes: 15 },
        generation: 1,
      },
      "U-MEMBER",
    );
    const edited = await routineStore.getRoutine(ORG, SURFACE, id);
    ok(between === undefined && edited?.prompt === "Post the open incident count, by team.", "precondition: the pause landed inside the edit, and the edit wrote");
    ok(edited !== null && attention.isPausedForCheckIn(edited), "🔴 edit meets pause: the edit keeps the pause record, so the Resume card still works");
    await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);

    const ruled = "r-rule-meets-pause";
    const r1 = routine({ id: ruled, attention: { runs: 5, warnedAtRun: 3, cardId: "card-rp" } });
    await routineStore.addRoutine({} as never, r1);
    between = { id: ruled, land: () => routineStore.updateRoutine(ORG, SURFACE, ruled, attention.attentionPausePatch(r1, 5, new Date(clock))) };
    const common = { org: ORG, partition, surfaceKey: SURFACE, routineId: ruled, description: "every 15 min (posts every run)", ruleId: "p-race-1", requestedBy: "U-OWNER" };
    await actionKind("routine.policy.add")!.execute({ ...common, rule: "Skip weekends.", why: "Nobody reads it then.", source: "human", countBefore: 0 }, "U-MEMBER");
    const after = await routineStore.getRoutine(ORG, SURFACE, ruled);
    ok(between === undefined && (after?.policy ?? []).length === 1, "precondition: the pause landed inside the rule change, and the rule landed");
    ok(after !== null && attention.isPausedForCheckIn(after), "🔴 rule meets pause: the rule change keeps the pause record, so the Resume card still works");
    await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, ruled);
  }

  registerOperationalStore(real);
  resetOperationalStore();
}

{
  const id = "r-live-card";
  await routineStore.addRoutine({} as never, routine({ id, nextRunAt: new Date(clock).toISOString() }));
  for (let i = 0; i < 4; i++) await tick();
  const live = (await routineStore.getRoutine(ORG, SURFACE, id))!.attention!.cardId!;
  await flow.reapSupersededRoutineCards(ORG, LATER());
  ok((await pendingRow(live))?.status === "pending", "🔴 sweep: the routine's live card survives the sweep — a reap that expired every check-in card would pass §2");
  ok((await pendingRow(live))?.expiresAt.startsWith("9999") === true || Date.parse((await pendingRow(live))!.expiresAt) > Date.parse("2100-01-01T00:00:00.000Z"), "sweep: the card carries no clock, because a weekly routine's grace is weeks long");
  const row = (await pendingRow(live))!;
  const labels = pendingCardOptions(row).map((o) => o.label);
  ok(labels[0] === "Keep going" && labels.at(-1) === "Let it pause", "layout: every surface reads the same button words from the shared layout");
  const plain = pendingCardOptions({ ...row, kind: "routine.enable" }).map((o) => o.label);
  ok(plain[0] === "Approve" && plain.at(-1) === "Reject", "layout: a kind with no words of its own keeps Approve and Reject");
}

{
  const { dmWindowRegistryKey } = await import("../agent/channels/unified-supervisor.js");
  const DM = "D0CHECKIN1";
  const DM_SURFACE = `slack/T1/${DM}`;
  await getOperationalStore().rotateChannelSession(ORG, dmWindowRegistryKey(DM_SURFACE), `oe-dom:oe-dm/${DM_SURFACE}:oe-sup:g1-abc123`, new Date().toISOString());
  const notices: string[] = [];
  let dispatched = 0;
  const row = (kind: string, argsJson: string) => ({
    id: `p-${kind}`,
    org: ORG,
    kind,
    argsJson,
    scopeKey: DM_SURFACE,
    domain: null,
    requestedBy: "U-OWNER",
    channelId: DM,
    threadTs: null,
    messageTs: "1760009420.000001",
    postedTo: DM_SURFACE,
    status: "approved" as const,
    createdAt: "2026-07-02T00:00:00.000Z",
    expiresAt: "9999-12-31T23:59:59.000Z",
    decidedBy: "U-MEMBER",
    decidedAt: "2026-07-02T01:00:00.000Z",
  });
  const feedback = (r: ReturnType<typeof row>, cardShowsOutcome: boolean) => ({
    row: r,
    summaryLines: ["the card"],
    outcome: "approved" as const,
    outcomeLine: "kept the routine running",
    executed: "ok" as const,
    clickerId: "U-MEMBER",
    target: { surfaceKey: DM_SURFACE, origin: { platform: "slack", channelId: DM } as never },
    noticeThread: null,
    cardShowsOutcome,
    postNotice: async (text: string) => void notices.push(text),
  });
  const wake = {
    dispatch: (async () => {
      dispatched++;
      return true;
    }) as never,
  };
  await flow.deliverDecisionFeedback(feedback(row("routine.enable", "{}"), true), wake);
  ok(dispatched === 1, "feedback control: an ordinary kind's decision wakes the live seat");
  const checkIn = row(attention.ROUTINE_ATTENTION_KIND, JSON.stringify(attention.attentionCardArgs(routine({ id: "r-x" }), "warn", 3, 2)));
  notices.length = 0;
  await flow.deliverDecisionFeedback(feedback(checkIn, true), wake);
  ok(dispatched === 1, "🔴 feedback: a check-in press wakes no seat, because no session asked");
  ok(notices.length === 0, "🔴 feedback: and posts no second message beside the redrawn card — its owner asked nothing, so 'approved your request' would be false");
  await flow.deliverDecisionFeedback(feedback(checkIn, false), wake);
  ok(notices.length === 1, "feedback: where the card could not be redrawn, the notice still states the outcome — the room needs one record");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ routine-attention: ${passed} assertions passed`);
