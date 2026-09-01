import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-routine-permission-wait-"));
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_EGRESS_SPOOF = "1";
delete process.env.OE_ORG;

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const routineDispatch = await import("../agent/schedules/routine-dispatch.js");
const { requestApproval, resolveApprovalClick, autoApprovedNote } = await import("../agent/approvals/flow.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { addRoutine, updateRoutine } = await import("../agent/routines/store.js");
const { routineGrantKey } = await import("../agent/routines/routine.js");
const { ROUTINE_GRANT_NO_EXPIRY } = await import("../agent/routines/grants.js");
const { ROUTINE_PERMISSION_KIND } = await import("../agent/approvals/routine-permission.js");
const { routinePermissionAskedMemo } = await import("../agent/approvals/session-grant.js");
const { consumeRoutineRunPermissionRefusals } = await import("../agent/approvals/card-signal.js");
const { readRoutinePermissionCardState, routineCardProbe } = await import("../agent/routines/permission-card.js");
const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
const {
  ROUTINE_CARD_WAIT_CEILING_SECONDS,
  FUNCTION_WALL_CEILING_SECONDS,
  ASSUMED_TURN_ELAPSED_SECONDS,
  TURN_TAIL_RESERVE_SECONDS,
  routineCardKeepsStateClause,
  routineCardWaitBudgetMs,
  routineCardWaitCeilingSeconds,
  routineCardWaitRefusalClause,
  waitForRoutineCardDecision,
} = await import("../agent/routines/permission-card-wait.js");
const { turnElapsedSeconds } = await import("../agent/observability/turn-clock.js");
const telemetryHook = (await import("../agent/hooks/telemetry.js")).default;
const { routinePermissionCardLines } = await import("../agent/approvals/routine-permission.js");
const { actionKind } = await import("../agent/approvals/actions.js");
type Probe = Awaited<ReturnType<typeof routineCardProbe>>;

const ORG = "acme";
const SURFACE = "slack/T1/C_ROOM";
const store = getOperationalStore();

class FakeSession {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}
function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}
async function inSession<T>(fn: () => T | Promise<T>): Promise<T> {
  return eveContextStorage().run(new FakeSession(), fn);
}
async function fireTelemetry(type: string, data: unknown, ctx: unknown = {}): Promise<void> {
  const events = telemetryHook.events as unknown as Record<string, (e: unknown, c: unknown) => unknown>;
  const handler = events[type];
  if (typeof handler !== "function") throw new Error(`hooks/telemetry.ts does not bind ${type}`);
  await handler({ type, data }, ctx);
}
async function inTurn<T>(sessionId: string, turnId: string, fn: () => T | Promise<T>): Promise<T> {
  return inSession(async () => {
    await fireTelemetry("turn.started", { turnId }, { session: { id: sessionId } });
    return fn();
  });
}

{
  ok(
    ROUTINE_CARD_WAIT_CEILING_SECONDS === FUNCTION_WALL_CEILING_SECONDS - ASSUMED_TURN_ELAPSED_SECONDS - TURN_TAIL_RESERVE_SECONDS,
    "§budget: the ceiling IS the stated arithmetic, not a number that drifted from the doc",
  );
  ok(ROUTINE_CARD_WAIT_CEILING_SECONDS === 120, `§budget: 300 − 120 − 60 = 120 (got ${ROUTINE_CARD_WAIT_CEILING_SECONDS})`);
  ok(routineCardWaitBudgetMs(0) === 0, "§budget: 0 is NO wait — the shipped default disarms the whole path");
  ok(routineCardWaitBudgetMs(30) === 30_000, "§budget: a value under the ceiling is spent as authored");
  ok(routineCardWaitBudgetMs(120) === 120_000, "§budget: the recommended armed value is spent whole");
  ok(routineCardWaitBudgetMs(200) === 120_000, "§budget: an over-ceiling value is CLAMPED to the ceiling, never spent");
  ok(routineCardWaitBudgetMs(-5) === 0, "§budget: a negative value disarms rather than waiting forever");
  ok(routineCardWaitBudgetMs(Number.NaN) === 0, "§budget: an unreadable value disarms — the fail-safe direction is the immediate refusal");
}

{
  ok(routineCardWaitCeilingSeconds(120) === ROUTINE_CARD_WAIT_CEILING_SECONDS, "§elapsed: at the assumed elapsed the ceiling is the old constant, unchanged");
  ok(routineCardWaitCeilingSeconds(5) === 235, `§elapsed: a turn 5s in may still afford 300 − 5 − 60 (got ${routineCardWaitCeilingSeconds(5)})`);
  ok(routineCardWaitCeilingSeconds(240) === 0, "§elapsed: a turn 240s in has exactly nothing left");
  ok(routineCardWaitCeilingSeconds(250) === -10, "§elapsed: and a turn past that is already over budget — the arithmetic says so rather than clamping to zero");

  ok(routineCardWaitBudgetMs(120, routineCardWaitCeilingSeconds(250)) === 0, "🔴 §elapsed: a turn with no room left waits NOT AT ALL — it refuses immediately instead of dying mid-report");
  ok(routineCardWaitBudgetMs(120, routineCardWaitCeilingSeconds(240)) === 0, "🔴 §elapsed: and a ceiling of exactly zero disarms too — the boundary is not a one-off wait");
  ok(routineCardWaitBudgetMs(200, routineCardWaitCeilingSeconds(5)) === 200_000, "🔴 §elapsed: a young turn spends its configured 200s — the assumed ceiling no longer clamps a wait the turn can afford");
  ok(routineCardWaitBudgetMs(120, routineCardWaitCeilingSeconds(150)) === 90_000, "§elapsed: and a mid-life turn is clamped to what is actually left (300 − 150 − 60)");

  ok(turnElapsedSeconds() === undefined, "🔴 §elapsed: with no turn to measure the read is UNDEFINED, never 0 — a caller must not read it as 'the turn just started'");
  ok(routineCardWaitCeilingSeconds() === ROUTINE_CARD_WAIT_CEILING_SECONDS, "§elapsed: so the default ceiling is the assumed arm, identical to the pre-OPE-1347 number");
  ok(routineCardWaitCeilingSeconds(Number.NaN) === ROUTINE_CARD_WAIT_CEILING_SECONDS, "§elapsed: an unreadable elapsed falls back rather than producing a NaN budget");
  ok(routineCardWaitCeilingSeconds(-3) === ROUTINE_CARD_WAIT_CEILING_SECONDS, "§elapsed: so does a clock that moved backwards — an elapsed nobody observed is never reported as one");
}

{
  const started = Date.now();
  await inSession(async () => {
    await fireTelemetry("turn.started", { turnId: "t-wired" });

    const elapsed = turnElapsedSeconds();
    ok(elapsed !== undefined, "🔴 §wired: inside a real turn the elapsed read answers a NUMBER — the hook's slot is reachable from the wait");
    ok(elapsed! >= 0 && elapsed! < 30, `§wired: and it is this turn's own age, not a stale one (got ${String(elapsed)}s)`);
    const later = turnElapsedSeconds(started + 200_000);
    ok(later !== undefined && later >= 199 && later <= 201, `§wired: 200s after the stamp the read says ~200s (got ${String(later)}s)`);

    const ceiling = routineCardWaitCeilingSeconds();
    ok(ceiling > ROUTINE_CARD_WAIT_CEILING_SECONDS, `🔴 §wired: the DEFAULT ceiling follows the live turn (${ceiling}s), not the ${ROUTINE_CARD_WAIT_CEILING_SECONDS}s fallback`);
    ok(ceiling >= 235 && ceiling <= 240, `§wired: 300 − (a few seconds) − 60 (got ${ceiling}s)`);
    ok(routineCardWaitBudgetMs(200) === 200_000, "🔴 §wired: so a 200s wait is spent WHOLE inside a young turn — the clamp that used to cut it to 120 is gone");
  });
  ok(turnElapsedSeconds() === undefined, "§wired: and outside the session scope the read is undefined once more");
  ok(routineCardWaitBudgetMs(200) === 120_000, "§wired: so the same 200s wait is clamped to the fallback ceiling — the two answers are not the same answer");
}

{
  async function drive(budgetMs: number, script: readonly Probe[]): Promise<{ outcome: string; probes: number; slept: number }> {
    let clock = 1_000_000;
    let probes = 0;
    let slept = 0;
    const outcome = await waitForRoutineCardDecision(budgetMs, {
      probe: async () => {
        const step = script[Math.min(probes, script.length - 1)]!;
        probes++;
        return step;
      },
      sleep: async (ms) => {
        slept += ms;
        clock += ms;
      },
      nowMs: () => clock,
    });
    return { outcome, probes, slept };
  }
  const pending: Probe = { status: "pending", armed: false };

  const disarmed = await drive(0, [pending]);
  ok(disarmed.outcome === "disarmed" && disarmed.probes === 0, "§loop: a zero budget probes the store ZERO times — the disarmed path costs nothing");

  const deadline = await drive(120_000, [pending]);
  ok(deadline.outcome === "deadline", "§loop: a card nobody answers ends at the deadline");
  ok(deadline.slept === 120_000, `§loop: and it spends EXACTLY the budget, never more (slept ${deadline.slept}ms)`);
  ok(deadline.probes === 61, `§loop: 120s at a 2s interval is 61 probes — one before the first sleep, one after the last (got ${deadline.probes})`);

  const approved = await drive(120_000, [pending, pending, { status: "approved", armed: true }]);
  ok(approved.outcome === "approved" && approved.probes === 3, "§loop: an approval mid-window ends the wait at once, without spending the rest");
  ok(approved.slept === 4_000, `§loop: having slept only the two intervals it actually waited (got ${approved.slept}ms)`);

  const declined = await drive(120_000, [pending, { status: "rejected", armed: false }]);
  ok(declined.outcome === "declined", "§loop: a decline mid-window ends the wait too — the run does not sit out a window whose answer is in");

  const stale = await drive(120_000, [{ status: "approved", armed: false }]);
  ok(stale.outcome === "stale", "§loop: an APPROVED row with no grant behind it is `stale`, never `approved` — a click that armed nothing lifts nothing");
  ok(stale.slept === 120_000, "🔴 §loop: and it spends the WHOLE budget first — the CAS lands before the grant write, so an unarmed approval is a race until the deadline says otherwise");

  const catchUp = await drive(120_000, [
    { status: "approved", armed: false },
    { status: "approved", armed: false },
    { status: "approved", armed: true },
  ]);
  ok(catchUp.outcome === "approved", "🔴 §loop: an approval whose grant row lands a few polls later is APPROVED — the run is not refused over a store round trip");
  ok(catchUp.slept === 4_000, `§loop: and it proceeds the moment the row appears (slept ${catchUp.slept}ms)`);

  const gone = await drive(120_000, [{ status: "expired", armed: false }]);
  ok(gone.outcome === "gone", "§loop: an expired card stops the wait rather than burning the budget on a row nobody can answer");
  const missing = await drive(120_000, [{ status: "gone", armed: false }]);
  ok(missing.outcome === "gone", "§loop: so does a row that is simply not there");

  let thrown = 0;
  let clock = 0;
  const flaky = await waitForRoutineCardDecision(10_000, {
    probe: async () => {
      thrown++;
      if (thrown <= 2) throw new Error("store blip");
      return { status: "approved", armed: true };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    nowMs: () => clock,
  });
  ok(flaky === "approved" && thrown === 3, "§loop: a probe that THROWS is retried, not read as a deadline — a store blip must not auto-decline a run");

  let downClock = 0;
  const down = await waitForRoutineCardDecision(120_000, {
    probe: async () => {
      throw new Error("store down");
    },
    sleep: async (ms) => {
      downClock += ms;
    },
    nowMs: () => downClock,
  });
  ok(down === "unreadable", "🔴 §loop: a window whose probes never answered is `unreadable`, NEVER `deadline` — the run did not observe an absence, it observed nothing");

  let mixed = 0;
  let mixedClock = 0;
  const recovered = await waitForRoutineCardDecision(6_000, {
    probe: async () => {
      mixed++;
      if (mixed === 1) throw new Error("one blip");
      return pending;
    },
    sleep: async (ms) => {
      mixedClock += ms;
    },
    nowMs: () => mixedClock,
  });
  ok(recovered === "deadline", "§loop: a blip the window RECOVERED from still ends in an honest `deadline` — the final look saw the card pending");

  const short = await drive(500, [pending]);
  ok(short.outcome === "deadline" && short.slept === 500, `§loop: a sub-interval budget sleeps only what it has (slept ${short.slept}ms)`);
}

{
  const deadline = routineCardWaitRefusalClause("deadline", 120);
  ok(deadline.includes("nobody was present to action it"), "§copy: the deadline says plainly WHY it was declined — nobody was there");
  ok(deadline.includes("120s"), "§copy: and how long it actually waited, so the number is not a mystery");
  ok(deadline.includes("still waiting") && deadline.includes("still clickable"), "🔴 §copy: and that the CARD is not dead — the auto-decline is a turn outcome, not a card death");
  const declined = routineCardWaitRefusalClause("declined", 120);
  ok(declined.includes("a person declined it while this run waited"), "§copy: an in-window decline names the person's decision, not an absence");
  ok(!declined.includes("nobody"), "§copy: and never claims nobody was there — someone was, and they said no");
  ok(!declined.includes("until its instruction is edited"), "🔴 §copy: and claims NO durability — the run never read the row that would make that true");
  const stale = routineCardWaitRefusalClause("stale", 120);
  ok(stale.includes("nothing was armed"), "§copy: a stale approval says the click bought nothing rather than reporting success");
  ok(stale.includes("check whether the instruction changed"), "🔴 §copy: it names the likely cause as something to CHECK, not as something it verified");
  ok(!stale.includes("had already been edited"), "🔴 §copy: never asserting the edit outright — the probe read a grant row, not a routine");
  ok(routineCardWaitRefusalClause("gone", 120).includes("fresh one"), "§copy: a dead card points at the next card, never at itself");
  const unreadable = routineCardWaitRefusalClause("unreadable", 120);
  ok(unreadable.includes("could not read it"), "§copy: an unreadable window says the card could not be read");
  ok(unreadable.includes("Nothing here says nobody did"), "🔴 §copy: and explicitly disclaims the absence it did NOT observe");
  ok(!unreadable.includes("nobody was present to action it"), "🔴 §copy: never borrowing the deadline's sentence — the owner may well have clicked");
  ok(unreadable.includes("The card is unaffected"), "§copy: and it says the card survives, same as the deadline does");

  for (const arm of ["declined", "stale", "gone", "unreadable"] as const) {
    ok(routineCardKeepsStateClause(arm) === false, `§copy: the pre-wait state sentence is dropped for \`${arm}\` — it described the card before it moved`);
    ok(routineCardWaitRefusalClause(arm, 120).includes("permission card"), `§copy: so the \`${arm}\` clause introduces the card itself`);
  }
  ok(routineCardKeepsStateClause("deadline"), "§copy: the DEADLINE keeps it — there the card really is where the first sentence said it was");
  ok(routineCardWaitRefusalClause("approved", 120) === "", "§copy: an approval appends NOTHING — that run does not refuse, so it has no refusal to append to");
  ok(routineCardWaitRefusalClause("disarmed", 0) === "", "§copy: and a disarmed wait says nothing at all");

  const human = autoApprovedNote("PR \"bump\"", { outcome: "opened #7", resolvedBy: "routine-permission-card", grantedBy: "U_CLICKER" });
  ok(human.includes("U_CLICKER") && human.includes("approved it while the run was still waiting"), "§copy: a card a PERSON answered is reported as a person's decision");
  ok(!human.includes("auto-approved"), "🔴 §copy: never as a chain auto-approval — that would tell a routine's owner the machine decided what they decided");
  const chain = autoApprovedNote("PR \"bump\"", { outcome: "opened #7", resolvedBy: "config" });
  ok(chain.includes("the approver chain auto-approved this (config)"), "§copy: and the chain sentence is unchanged for every chain lift — the negative control");

  const cardArgs = { org: ORG, scopeKey: SURFACE, grantKey: "oe-routine:r-x:g1", routineId: "r-x", routineSurfaceKey: SURFACE, grantKind: "pr.open", declaration: "pr.open", prompt: "nightly" };
  overrideSettingsForTest({ approvals: { routineCardWaitSeconds: 0 } });
  const shipped = routinePermissionCardLines(cardArgs)[1] ?? "";
  ok(shipped === "It asked for this while running unattended, so the run was refused and has already finished. This decides FUTURE runs.", `🔴 §copy: at the shipped 0 the card is byte-identical to PR 1's (got "${shipped}")`);
  overrideSettingsForTest({ approvals: { routineCardWaitSeconds: 120 } });
  const armed = routinePermissionCardLines(cardArgs)[1] ?? "";
  ok(armed.includes("any run still waiting on this card when you answer"), "§copy: armed, it names whichever run may still be waiting instead");
  ok(!armed.includes("has already finished"), "🔴 §copy: and drops the reassurance the armed wait makes false");
  ok(!armed.includes("the run that asked"), "🔴 §copy: and never claims the waiting run is the one that raised the card — on a re-point it is not");
  overrideSettingsForTest({ approvals: { routineCardWaitSeconds: 0 } });
}

{
  const kind = actionKind(ROUTINE_PERMISSION_KIND);
  ok(typeof kind?.execute === "function", "§clicker: the kind is registered with an execute");
  const clickerRoutine = await addRoutine({ org: ORG, surfaceKey: SURFACE } as never, {
    id: "r-clicker",
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: "C_ROOM" },
    trigger: { kind: "cron", cron: "0 3 * * *" },
    prompt: "Nightly, open a pull request.",
    createdBy: "U_OWNER",
    createdAt: new Date().toISOString(),
    status: "active",
  } as never);
  const clickerArgs = {
    org: ORG,
    scopeKey: SURFACE,
    grantKey: routineGrantKey(clickerRoutine),
    routineId: "r-clicker",
    routineSurfaceKey: SURFACE,
    grantKind: "pr.open",
    declaration: "pr.open",
    prompt: "Nightly, open a pull request.",
  };
  overrideSettingsForTest({ approvals: { routineCardWaitSeconds: 0 } });
  const shippedLine = await kind!.execute(clickerArgs as never, "U_CLICKER");
  ok(shippedLine.includes("from its next run"), `🔴 §clicker: at the shipped 0 the clicker is told the grant starts next run (got "${shippedLine}")`);
  ok(!shippedLine.includes("still waiting"), "§clicker: with no mention of a run that cannot be waiting");
  overrideSettingsForTest({ approvals: { routineCardWaitSeconds: 120 } });
  const armedLine = await kind!.execute(clickerArgs as never, "U_CLICKER");
  ok(armedLine.includes("including any run still waiting on this card"), "🔴 §clicker: armed, the clicker is told their press may have lifted a run holding right now");
  ok(!armedLine.includes("from its next run"), "§clicker: and is NOT told the work starts next time while it is in fact happening");
  ok(armedLine.includes("until its instruction is edited"), "§clicker: both arms keep the revocation half — an edit still clears it");
  overrideSettingsForTest({ approvals: { routineCardWaitSeconds: 0 } });
}

routineDispatch.registerRoutineDispatch("slack", {
  resolveTarget: (r) => {
    const channelId = (r.target as { channelId?: string } | undefined)?.channelId;
    if (!channelId) return null;
    return { channel: {} as never, target: { channelId }, mode: "channel", attributes: {}, origin: { platform: "slack", channelId } };
  },
});
const routine = await addRoutine({ org: ORG, surfaceKey: SURFACE } as never, {
  id: "r-nightly",
  org: ORG,
  surfaceKey: SURFACE,
  target: { channelId: "C_ROOM" },
  trigger: { kind: "cron", cron: "0 3 * * *" },
  prompt: "Every night, open a pull request that bumps the changelog.",
  createdBy: "U_OWNER",
  createdAt: new Date().toISOString(),
  status: "active",
} as never);
const KEY = routineGrantKey(routine);

const proposal = {
  org: ORG,
  kind: "pr.open",
  args: { org: ORG, scopeKey: SURFACE, repo: "acme/site", head: "bump", base: "main", title: "bump", body: "", headSha: "abc", requestedBy: "U_OWNER", tainted: false, sessionId: KEY },
  scopeKey: SURFACE,
  domain: null,
  requestedBy: "U_OWNER",
  channelId: "C_ELSEWHERE",
  chain: { unattended: true },
};
async function fire(title: string): Promise<string> {
  try {
    await requestApproval({ ...proposal, args: { ...proposal.args, title } } as never, {});
    return "";
  } catch (e) {
    return String(e);
  }
}
const cards = async (): Promise<{ id: string; status: string; decidedBy: string | null }[]> =>
  (await store.listPendingActions(ORG)).filter((r) => r.kind === ROUTINE_PERMISSION_KIND) as never;
const setWait = (seconds: number): void => overrideSettingsForTest({ approvals: { routineCardWaitSeconds: seconds } });

{
  setWait(0);
  const started = Date.now();
  const refusal = await fire("disarmed");
  ok(refusal.includes("ask-unattended"), "§fire: at the shipped 0 the run is refused, exactly as before the wait existed");
  ok(refusal.includes("is now waiting in the routine's own room"), "§fire: with PR 1's card sentence and nothing appended to it");
  ok(!refusal.includes("nobody was present"), "§fire: no auto-decline sentence — no wait ran to produce one");
  ok(refusal.includes("An unattended run cannot wait on an approval card"), "§fire: and the standing advice is intact — the negative control for the sentence the armed path drops");
  ok(Date.now() - started < 1_000, "§fire: and it refuses immediately — a disarmed wait costs the turn no time");
  const rows = await cards();
  ok(rows.length === 1 && rows[0]!.status === "pending", "§fire: the card is posted and pending");
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())).state === "live", "§fire: and the ask-memo is written");
}

{
  setWait(1);
  const liveCard = (await cards())[0]!;
  const before = await routineCardProbe(ORG, liveCard.id, KEY, "pr.open");
  ok(before.status === "pending", "§fire: the card this fire will wait on is pending going in");
  const started = Date.now();
  const refusal = await fire("nobody home");
  const waited = Date.now() - started;
  ok(refusal.includes("ask-unattended"), "§fire: the deadline still refuses the run");
  ok(refusal.includes("nobody was present to action it"), "🔴 §fire: and says so plainly — the model is told it was declined for want of a person, not that the tool is broken");
  ok(refusal.includes("is already waiting"), "§fire: the fire re-pointed at the LIVE card rather than posting a second one");
  ok(!refusal.includes("cannot wait on an approval card"), "🔴 §fire: the refusal does not say the run cannot wait AND report how long it waited");
  ok(refusal.includes("Arm the permission on the routine's creation card"), "§fire: the half of the advice that is still true survives");
  ok(waited >= 900, `§fire: the call really held for its budget (${waited}ms) rather than falling through`);
  const after = await cards();
  ok(after.length === 1, "§fire: still exactly one card — a deadline mints nothing");
  ok(after[0]!.id === liveCard.id && after[0]!.status === "pending", "🔴 §fire: THE CARD IS STILL PENDING. The fence never decides the row — a later click still arms every future fire");
  ok(after[0]!.decidedBy === null, "§fire: and nothing was recorded against a human who never clicked");
  ok(
    (await store.getSessionApproval(ORG, KEY, routinePermissionAskedMemo("pr.open"), new Date().toISOString())) !== null,
    "§fire: the ask-memo survives the deadline, so the next fire points at this same card instead of posting a duplicate",
  );
  ok((await store.getSessionApproval(ORG, KEY, "pr.open", new Date().toISOString())) === null, "§fire: and no permission was armed by a wait nobody answered");
  ok((await approvedPrOpenWedges()).length === 0, "🔴 §fire: and the act NEVER ran — a deadline refuses, it does not quietly proceed");
}

{
  setWait(10);
  const card = (await cards())[0]!;
  const clicked = new Promise<void>((resolve) => {
    setTimeout(() => {
      void resolveApprovalClick({ org: ORG, id: card.id, clickerId: "U_CLICKER", decision: "reject" } as never).then(() => resolve());
    }, 200);
  });
  const refusal = await fire("someone says no");
  await clicked;
  ok(refusal.includes("ask-unattended"), "§fire: an in-window DECLINE still refuses the run");
  ok(refusal.includes("a person declined it while this run waited"), "§fire: naming the person's decision rather than an absence");
  ok(!refusal.includes("nobody was present"), "🔴 §fire: and NEVER the auto-decline sentence — someone was present and they said no");
  ok(!refusal.includes("nobody has decided it yet"), "🔴 §fire: the refusal does not say nobody decided the card AND report who decided it");
  ok(!refusal.includes("is already waiting"), "§fire: the whole pre-wait state sentence is dropped, not just its tail");
  ok((await store.getSessionApproval(ORG, KEY, "pr.open", new Date().toISOString())) === null, "§fire: a decline arms nothing");
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())).state === "declined", "§fire: and the durable decline is written, so later fires refuse quietly");
}

{
  await store.revokeSessionApprovals(ORG, KEY);
  setWait(10);
  const posted = await (async () => {
    setWait(0);
    await fire("fresh card");
    setWait(10);
    return (await cards()).find((r) => r.status === "pending")!;
  })();
  ok(posted !== undefined, "§fire: a fresh card is pending for the approve leg");

  const wedgesBefore = await approvedPrOpenWedges();
  ok(wedgesBefore.length === 0, "§fire: no approved pr.open wedge exists before the approval — the real negative control");
  const clicked = new Promise<void>((resolve) => {
    setTimeout(() => {
      void resolveApprovalClick({ org: ORG, id: posted.id, clickerId: "U_CLICKER", decision: "approve" } as never).then(() => resolve());
    }, 200);
  });
  const refusal = await fire("someone says yes");
  await clicked;

  ok(!refusal.includes("was DENIED by the approver chain"), "🔴 §fire: THE DENY IS LIFTED — an approval inside the window is not answered with the refusal it was raised by");
  ok(!refusal.includes("nobody was present"), "§fire: and certainly not with the auto-decline sentence");
  const grant = await store.getSessionApproval(ORG, KEY, "pr.open", new Date().toISOString());
  ok(grant?.grantedBy === "U_CLICKER" && grant.expiresAt === ROUTINE_GRANT_NO_EXPIRY, "§fire: the click armed the standing row every FUTURE fire reads");
  const wedges = await approvedPrOpenWedges();
  ok(wedges.length === 1, "🔴 §fire: the decided WEDGE row is in the store — the run reached the act rather than throwing the refusal");
  ok(wedges[0]?.decidedBy === "U_CLICKER", "§fire: attributed to the human who clicked, never to the fire");
}

{
  await store.revokeSessionApprovals(ORG, KEY);
  for (const row of await cards()) {
    await store.decidePendingAction(ORG, row.id, "expired", "system", new Date().toISOString());
  }

  setWait(1);
  const lost = await inTurn("s-ledger", "turn_1", async () => {
    await fire("deadline, nobody home");
    return consumeRoutineRunPermissionRefusals();
  });
  ok(lost.length === 1, "⭐ §runledger: a run whose card timed out REPORTS the loss");
  ok(lost[0]?.permission === "open pull requests" && lost[0]?.cardKnown === true, "⭐ §runledger: naming the permission, with the card's fate established");

  setWait(10);
  const armedCard = (await cards()).find((r) => r.status === "pending")!;
  ok(armedCard !== undefined, "§runledger: the deadline left its card pending for this leg to answer");
  const clicked = new Promise<void>((resolve) => {
    setTimeout(() => {
      void resolveApprovalClick({ org: ORG, id: armedCard.id, clickerId: "U_CLICKER", decision: "approve" } as never).then(() => resolve());
    }, 200);
  });
  const proceeded = await inTurn("s-ledger", "turn_2", async () => {
    await fire("someone says yes in time");
    return consumeRoutineRunPermissionRefusals();
  });
  await clicked;
  ok((await store.getSessionApproval(ORG, KEY, "pr.open", new Date().toISOString())) !== null, "§runledger: the click really armed the grant, so this run really did proceed");
  ok(proceeded.length === 0, "🔴 §runledger: and its report claims NO loss — a run that got the permission mid-run was not refused");

  await store.revokeSessionApprovals(ORG, KEY);
  for (const row of await cards()) {
    await store.decidePendingAction(ORG, row.id, "expired", "system", new Date().toISOString());
  }
  setWait(0);
  const [sameTurn, nextTurn] = await inSession(async () => {
    await fireTelemetry("turn.started", { turnId: "turn_3" }, { session: { id: "s-stale" } });
    await fire("refused, and this fire posts nothing");
    const mine = consumeRoutineRunPermissionRefusals();
    await fire("refused again, still posting nothing");
    await fireTelemetry("turn.started", { turnId: "turn_4" }, { session: { id: "s-stale" } });
    return [mine, consumeRoutineRunPermissionRefusals()] as const;
  });
  ok(sameTurn.length === 1, "⭐ §runledger: the turn that was refused reads its own ledger — the control that makes the next assertion mean something");
  ok(nextTurn.length === 0, "🔴 §runledger: a LATER turn of the same session reads nothing — one fire's losses can never ride another fire's report");
}

await inTurn("sess-card", "turn_0", async () => {
  const idsBefore = new Set((await approvedPrOpenWedges()).map((w) => w.id));
  const before = idsBefore.size;

  const armAndFire = async (): Promise<string> => {
    await store.revokeSessionApprovals(ORG, KEY);
    setWait(0);
    await fire("someone says yes");
    setWait(10);
    const posted = (await cards()).find((r) => r.status === "pending");
    ok(posted !== undefined, "§redelivery: a fresh card is pending for this delivery");
    const clicked = new Promise<void>((resolve) => {
      setTimeout(() => {
        void resolveApprovalClick({ org: ORG, id: posted!.id, clickerId: "U_CLICKER", decision: "approve" } as never).then(() => resolve());
      }, 200);
    });
    const refusal = await fire("someone says yes");
    await clicked;
    return refusal;
  };

  const firstRefusal = await armAndFire();
  ok(!firstRefusal.includes("was DENIED by the approver chain"), "§redelivery: the first delivery reached the act");
  const afterFirst = await approvedPrOpenWedges();
  ok(afterFirst.length === before + 1, "§redelivery: and minted its wedge row");
  const wedgeId = afterFirst.find((w) => !idsBefore.has(w.id))?.id;
  ok(wedgeId !== undefined, "§redelivery: and the new row is identifiable — not one an earlier block left behind");

  const secondRefusal = await armAndFire();
  ok(!secondRefusal.includes("was DENIED by the approver chain"), "§redelivery: the second delivery reached the act too — the leg is not passing by refusing early");
  const afterSecond = await approvedPrOpenWedges();
  ok(afterSecond.length === before + 1, `🔴 §redelivery: STILL THE SAME NUMBER OF WEDGE ROWS — one authorisation in one turn of one session writes one row (got ${afterSecond.length}, was ${before + 1})`);
  ok(afterSecond.some((w) => w.id === wedgeId), "🔴 §redelivery: and it is the SAME row — the id is derived from the (session, turn) and the decision, not minted per delivery");
});

{
  await store.revokeSessionApprovals(ORG, KEY);
  ok((await readRoutinePermissionCardState(ORG, KEY, "pr.open", new Date().toISOString())).state === "absent", "§fire: the slate is clean, so this fire POSTS rather than re-points");
  const before = (await cards()).length;
  setWait(1);
  const started = Date.now();
  const refusal = await fire("first refusal of this generation");
  const waited = Date.now() - started;
  ok(refusal.includes("is now waiting in the routine's own room"), "§fire: this fire POSTED the card");
  ok(refusal.includes("nobody was present to action it"), "🔴 §fire: and the SAME call then waited on the card it had just posted");
  ok(waited >= 900, `§fire: for its whole budget (${waited}ms)`);
  const now = await cards();
  ok(now.length === before + 1, "§fire: exactly one new card, still pending after the deadline");

  const fresh = now.find((r) => r.status === "pending")!;
  ok((await routineCardProbe(ORG, fresh.id, KEY, "pr.open")).armed === false, "§probe: a pending card is not armed");
  await updateRoutine(ORG, SURFACE, "r-nightly", { promptGeneration: 9 });
  await resolveApprovalClick({ org: ORG, id: fresh.id, clickerId: "U_CLICKER", decision: "approve" } as never);
  const stale = await routineCardProbe(ORG, fresh.id, KEY, "pr.open");
  ok(stale.status === "approved", "§probe: the stale click still DECIDED the row — the human's press was not swallowed");
  ok(stale.armed === false, "🔴 §probe: but nothing is armed, and the probe READS that off the grant row rather than trusting the status");
  ok((await store.getSessionApproval(ORG, KEY, "pr.open", new Date().toISOString())) === null, "§probe: the negative control — there really is no grant row to read");
  await updateRoutine(ORG, SURFACE, "r-nightly", { promptGeneration: 1 });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ routine permission wait: ${passed} assertions passed`);

async function allPendingActionIds(): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.OE_SQLITE_PATH!, { readOnly: true });
  try {
    return (db.prepare("SELECT id FROM pending_actions").all() as unknown as { id: string }[]).map((r) => r.id);
  } finally {
    db.close();
  }
}

async function approvedPrOpenWedges(): Promise<{ id: string; decidedBy: string | null }[]> {
  const out: { id: string; decidedBy: string | null }[] = [];
  for (const id of await allPendingActionIds()) {
    const row = await store.getPendingAction(ORG, id);
    if (row?.kind === "pr.open" && row.status === "approved") out.push(row);
  }
  return out;
}
