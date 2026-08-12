import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  rotationTrigger,
  shouldRotate,
  rotationClockMsFromDays,
  supervisorRotateExpiryMs,
  supervisorRotateQuietGapMs,
  supervisorRotateTurnBudget,
  supervisorRotateTokenBudget,
  type RotationTrigger,
} from "../agent/channels/turn-delivery.js";
import { DM_SEAT_ROTATE_EXPIRY_MS, dmSeatThresholds } from "../agent/channels/dm-seat.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const DAY = 86_400_000;
const NOW = "2026-08-09T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const iso = (msAgo: number): string => new Date(nowMs - msAgo).toISOString();
const quiet = { createdAt: NOW, lastWakeAt: NOW, turnCount: 0, inputTokensTotal: 0 };
const OFF = {
  expiryMs: Number.POSITIVE_INFINITY,
  quietGapMs: Number.POSITIVE_INFINITY,
  turnBudget: Number.MAX_SAFE_INTEGER,
  tokenBudget: Number.MAX_SAFE_INTEGER,
};

{
  eq(rotationTrigger(quiet, NOW), null, "a just-minted, just-woken, empty generation trips no trigger");
  ok(!shouldRotate(quiet, NOW), "…and shouldRotate is its boolean face");

  eq(
    rotationTrigger({ ...quiet, inputTokensTotal: null, createdAt: iso(999 * DAY), turnCount: 10_000 }, NOW),
    "unknown-accumulation" satisfies RotationTrigger,
    "a NULL token counter fails safe to rotate, and reports THAT even when the row would also have expired",
  );

  for (const [field, row] of [
    ["now", quiet],
    ["createdAt", { ...quiet, createdAt: "not-a-timestamp" }],
    ["lastWakeAt", { ...quiet, lastWakeAt: "not-a-timestamp" }],
  ] as const) {
    const at = field === "now" ? "not-a-timestamp" : NOW;
    eq(rotationTrigger(row, at), "unparseable-timestamp" satisfies RotationTrigger, `an unparseable ${field} fails safe to rotate`);
  }

  const everything = { createdAt: iso(400 * DAY), lastWakeAt: iso(400 * DAY), turnCount: 10_000, inputTokensTotal: 99_000_000 };
  eq(rotationTrigger(everything, NOW), "expiry" satisfies RotationTrigger, "🔴 a row that trips every rung reports EXPIRY — the primary is the time trigger, not a counter");
  eq(
    rotationTrigger(everything, NOW, { expiryMs: Number.POSITIVE_INFINITY }),
    "quiet-gap" satisfies RotationTrigger,
    "…with expiry disabled the next rung is the OTHER time trigger (idleness), still ahead of both counters",
  );
  eq(
    rotationTrigger(everything, NOW, { expiryMs: Number.POSITIVE_INFINITY, quietGapMs: Number.POSITIVE_INFINITY }),
    "turn-backstop" satisfies RotationTrigger,
    "…then the turn backstop",
  );
  eq(
    rotationTrigger(everything, NOW, { expiryMs: Number.POSITIVE_INFINITY, quietGapMs: Number.POSITIVE_INFINITY, turnBudget: Number.MAX_SAFE_INTEGER }),
    "token-backstop" satisfies RotationTrigger,
    "…and the token counter LAST — the rung OPE-345 demoted it to",
  );
}

{
  eq(supervisorRotateExpiryMs(), 7 * DAY, "the unified-window expiry clock defaults to 7 days (stated for tuning, not ratified as final)");
  eq(DM_SEAT_ROTATE_EXPIRY_MS, 30 * DAY, "the DM seat's clock defaults to 30 days — the SAME mechanism, deliberately longer");
  ok(DM_SEAT_ROTATE_EXPIRY_MS > supervisorRotateExpiryMs(), "🔴 a DM's clock is LONGER than a room's: a personal thread accrues staleness far more slowly than a channel full of other people");
  eq(dmSeatThresholds().expiryMs, DM_SEAT_ROTATE_EXPIRY_MS, "dmSeatThresholds() carries the expiry — this is the object getOrCreateDmSeat actually passes, so an omission here would silently give a DM the 7d clock");

  const busy = { createdAt: iso(7 * DAY + 1000), lastWakeAt: iso(60_000), turnCount: 12, inputTokensTotal: 50_000 };
  eq(rotationTrigger(busy, NOW), "expiry" satisfies RotationTrigger, "🔴 a constantly-woken, low-count generation older than its clock ROTATES — the population no counter trigger could reach");
  ok(!shouldRotate({ ...busy, createdAt: iso(7 * DAY - 1000) }, NOW), "…and the same seat one second under the clock does not (clock+1 fires, clock-1 does not)");

  ok(!shouldRotate({ ...quiet, createdAt: iso(7 * DAY) }, NOW), "exactly AT the clock does not rotate (strict >)");
  ok(shouldRotate({ ...quiet, createdAt: iso(7 * DAY + 1) }, NOW), "one millisecond over it does");
  ok(
    !shouldRotate({ ...quiet, createdAt: NOW, lastWakeAt: iso(400 * DAY) }, NOW, { quietGapMs: Number.POSITIVE_INFINITY }),
    "🔴 expiry ages CREATED_AT, never LAST_WAKE_AT — a freshly-ROTATED generation whose row carries an ancient wake stamp is young, and rotateChannelSession resets created_at precisely so this holds",
  );
}

{
  eq(supervisorRotateTurnBudget(), 60, "the unified turn BACKSTOP is 60 (OPE-345; was 150)");
  eq(supervisorRotateTokenBudget(), 4_000_000, "the token BACKSTOP is unchanged at 4M — OPE-345 demoted it, it did not re-value it");
  eq(supervisorRotateQuietGapMs(), 24 * 3_600_000, "the quiet gap is unchanged at 24h (backscroll-cluster.ts derives its cluster boundary from this exact value)");

  eq(rotationTrigger({ ...quiet, turnCount: supervisorRotateTurnBudget() + 1 }, NOW), "turn-backstop" satisfies RotationTrigger, "one turn over the backstop rotates");
  ok(!shouldRotate({ ...quiet, turnCount: supervisorRotateTurnBudget() }, NOW), "…exactly AT it does not (strict >)");
  eq(rotationTrigger({ ...quiet, inputTokensTotal: supervisorRotateTokenBudget() }, NOW), "token-backstop" satisfies RotationTrigger, "the token backstop is inclusive (>=)");
  ok(!shouldRotate({ ...quiet, inputTokensTotal: supervisorRotateTokenBudget() - 1 }, NOW), "…one token under it does not");

  const MAX_EVENTS_PER_RUN = 25_000;
  const EVENTS_PER_TURN = 295;
  const wallTurns = MAX_EVENTS_PER_RUN / EVENTS_PER_TURN;
  ok(wallTurns < 150, `the event wall binds at ~${wallTurns.toFixed(0)} turns — BELOW the old 150 backstop, which is why 150 was never a backstop at all`);
  ok(
    supervisorRotateTurnBudget() < wallTurns,
    `the backstop (${supervisorRotateTurnBudget()}) binds BEFORE the ~${wallTurns.toFixed(0)}-turn event wall`,
  );
  ok(
    supervisorRotateTurnBudget() <= wallTurns * 0.75,
    `…with ≥25% headroom (${supervisorRotateTurnBudget()} ≤ ${(wallTurns * 0.75).toFixed(1)}) — the ~295 events/turn is a MEAN over one seat, and a tool-heavy turn is a multiple of it, so a backstop set at the mean-derived limit protects only an average seat`,
  );

  const projected = (turns: number, k: number, prefix: number, g: number): number => k * (prefix * turns + (g * turns * turns) / 2);
  ok(projected(supervisorRotateTurnBudget(), 2, 10_500, 1_000) < 40_000_000, `backstop ${supervisorRotateTurnBudget()}: C=${Math.round(projected(supervisorRotateTurnBudget(), 2, 10_500, 1_000))} < 40M (cost-model g=1000)`);
  ok(projected(300, 2, 10_500, 1_000) >= 40_000_000, "300 still FAILS the 40M wall — the older derivation is preserved, not replaced");

  ok(dmSeatThresholds().turnBudget < wallTurns, `the DM turn backstop (${dmSeatThresholds().turnBudget}) is under the event wall too`);
  ok(dmSeatThresholds().turnBudget !== supervisorRotateTurnBudget(), "🔴 DM and unified turn backstops are DIFFERENT numbers — the policies are deliberately not the same, and a re-point to one number must fail a test");
}

{
  ok(!shouldRotate({ createdAt: iso(9_999 * DAY), lastWakeAt: iso(9_999 * DAY), turnCount: 10_000, inputTokensTotal: 99_000_000 }, NOW, OFF), "with every threshold at its DISABLED spelling, a maximally-aged row does not rotate — the off-switch really is off");
  eq(dmSeatThresholds().quietGapMs, Number.POSITIVE_INFINITY, "the DM quiet gap ships DISABLED — idleness is not evidence a DM's context went stale (that argument is the expiry clock's now)");
  ok(shouldRotate({ ...quiet, createdAt: iso(31 * DAY), lastWakeAt: iso(31 * DAY) }, NOW, dmSeatThresholds()), "…but a 31-day-old DM generation still rotates: the DM's freshness lever is expiry, not idleness");
}

{
  eq(rotationClockMsFromDays(undefined, 7), 7 * DAY, "unset ⇒ the committed default");
  eq(rotationClockMsFromDays("   ", 7), 7 * DAY, "blank ⇒ the committed default");
  eq(rotationClockMsFromDays("14", 7), 14 * DAY, "a valid override is taken");
  eq(rotationClockMsFromDays("0.5", 7), 0.5 * DAY, "…including a fractional one (a half-day clock is a legitimate ops choice)");
  eq(rotationClockMsFromDays("0", 7), Number.POSITIVE_INFINITY, "an explicit 0 DISABLES the clock — the same spelling the DM quiet gap already used for off");
  eq(rotationClockMsFromDays("-3", 7), Number.POSITIVE_INFINITY, "…as does a negative value");
  eq(
    rotationClockMsFromDays("seven", 7),
    7 * DAY,
    "🔴 an UNPARSEABLE override falls back to the DEFAULT, never to disabled — a typo in an env var must not silently switch a rotation trigger off",
  );
}

{
  const mustNotRotate = [
    "packages/core/agent/routines/job.ts",
    "packages/core/agent/tools/spawn_task.ts",
    "packages/core/agent/tools/delegation_tools.ts",
    "packages/core/agent/channels/oneshot-wake.ts",
  ];
  for (const rel of mustNotRotate) {
    let src: string;
    try {
      src = readFileSync(join(REPO_ROOT, rel), "utf8");
    } catch {
      ok(false, `${rel} no longer exists — re-point this list at the module that mints that seat kind, or drop the entry with a reason`);
      continue;
    }
    ok(!/\bshouldRotate\s*\(|\brotationTrigger\s*\(/.test(src), `🔴 ${rel} does not consult the rotation chain — a one-shot worker / fire-scoped job seat has no context to keep fresh, so a clock over it measures nothing`);
  }
}

console.log(`✓ rotation-trigger: ${n} assertions passed (OPE-345 chain: expiry primary, counters demoted to backstops)`);
