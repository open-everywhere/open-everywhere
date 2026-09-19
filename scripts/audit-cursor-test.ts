import {
  AUDIT_CURSOR_LOOKBACK_MS,
  AUDIT_CURSOR_MARK_LIMIT,
  auditCursorSinceIso,
  cursorClockDriftMs,
  markFromRows,
  selectRowsAfterCursor,
  type AuditCursor,
} from "../tests/integration/audit-cursor.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WAKE_WALL_MS = Date.parse("2026-04-06T02:10:07.140Z");
const CURSOR: AuditCursor = { mark: 4200, wallMs: WAKE_WALL_MS, monoMs: 1_000 };

{
  const steppedRow = { seq: 4201, ts: "2026-04-06T02:10:06.396Z", action: "approval.requested" };
  const selected = selectRowsAfterCursor([steppedRow], CURSOR);
  ok(selected.length === 1, "a row written AFTER the cursor is selected even though its ts is EARLIER than the cursor's wall stamp");
  ok(selected[0] === steppedRow, "…and it is the same row object, not a copy");

  const byWallClock = [steppedRow].filter((r) => Date.parse(r.ts) >= CURSOR.wallMs);
  ok(byWallClock.length === 0, "the OLD `ts >= wakeAt` predicate loses that same row — the negative control");
}

{
  const rows = [
    { seq: 4203, ts: "2026-04-06T02:10:09.000Z", action: "approval.chain" },
    { seq: 4201, ts: "2026-04-06T02:10:06.396Z", action: "approval.requested" },
    { seq: 4200, ts: "2026-04-06T02:10:05.000Z", action: "control.service_call" },
    { seq: 4199, ts: "2026-04-06T02:10:04.000Z", action: "approval.requested" },
  ];
  const selected = selectRowsAfterCursor(rows, CURSOR);
  ok(selected.length === 2, "only the rows above the mark are selected");
  ok(
    selected.every((r) => r.seq > CURSOR.mark),
    "…and every selected row really is above it",
  );
  ok(selected[0]!.seq === 4203 && selected[1]!.seq === 4201, "the route's newest-first order is preserved, not re-sorted");
  ok(
    !selected.some((r) => r.seq === CURSOR.mark),
    "the mark is exclusive — the row that established the cursor is never re-selected",
  );
}

{
  ok(selectRowsAfterCursor([], CURSOR).length === 0, "an empty page selects nothing");
  const empty: AuditCursor = { mark: 0, wallMs: WAKE_WALL_MS, monoMs: 0 };
  ok(selectRowsAfterCursor([{ seq: 1, ts: "1970-01-01T00:00:00.000Z" }], empty).length === 1, "a zero mark selects every row the window holds, never none");
}

{
  let threw = "";
  try {
    selectRowsAfterCursor([{ ts: "2026-04-06T02:10:09.000Z" }], CURSOR);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok(threw !== "", "a row carrying no seq throws rather than being silently kept or dropped");
  ok(threw.includes("seq"), "…and the message names the field that is missing");
  ok(selectRowsAfterCursor([{ seq: 4201, ts: "2026-04-06T02:10:09.000Z" }], CURSOR).length === 1, "…while the same row WITH a seq goes through");
}

{
  ok(markFromRows([]) === 0, "an empty page marks 0 — there is nothing to be after");
  ok(markFromRows([{ seq: 7 }, { seq: 12 }, { seq: 3 }]) === 12, "the mark is the page's MAXIMUM seq, not its first row");
  const tsOrdered = [
    { seq: 11, ts: "2026-04-06T02:10:09.000Z" },
    { seq: 12, ts: "2026-04-06T02:10:06.700Z" },
  ];
  ok(markFromRows(tsOrdered) === 12, "the mark is still the maximum when the ts order disagrees with the seq order");
  ok(markFromRows([{ ts: "2026-04-06T02:10:09.000Z" }]) === 0, "a page of rows with no seq marks 0 rather than NaN");
  ok(AUDIT_CURSOR_MARK_LIMIT > 1, "a cursor read asks for a page, because a one-row read would mark below rows that exist");
}

{
  const since = auditCursorSinceIso(CURSOR);
  ok(since === new Date(WAKE_WALL_MS - AUDIT_CURSOR_LOOKBACK_MS).toISOString(), "the query window starts a full lookback below the cursor's wall stamp");
  ok(Date.parse(since) < CURSOR.wallMs, "…which is BEFORE the wake, so a backward step cannot push a wanted row out of the page");
  ok(AUDIT_CURSOR_LOOKBACK_MS >= 60_000, "the lookback clears the drift the longest wait in this tier can accumulate, with an order of magnitude to spare");
}

{
  ok(cursorClockDriftMs(CURSOR, WAKE_WALL_MS + 5_000, CURSOR.monoMs + 5_000) === 0, "a steady host drifts 0 ms");
  ok(cursorClockDriftMs(CURSOR, WAKE_WALL_MS + 2_701, CURSOR.monoMs + 5_000) === -2_299, "a backward step reads as a NEGATIVE drift of exactly the step");
  ok(cursorClockDriftMs(CURSOR, WAKE_WALL_MS + 7_000, CURSOR.monoMs + 5_000) === 2_000, "a forward step reads as a POSITIVE drift");
}

{
  const STEP_BACK_MS = 2_300;
  const STEP_EVERY_MS = 28_000;
  const APPEND_EVERY_MS = 900;

  let monoMs = 0;
  let wallMs = WAKE_WALL_MS;
  let nextStepAtMono = STEP_EVERY_MS;
  let seq = 0;

  function append(): { seq: number; ts: string } {
    monoMs += APPEND_EVERY_MS;
    wallMs += APPEND_EVERY_MS;
    if (monoMs >= nextStepAtMono) {
      wallMs -= STEP_BACK_MS;
      nextStepAtMono += STEP_EVERY_MS;
    }
    seq += 1;
    return { seq, ts: new Date(wallMs).toISOString() };
  }

  const beforeCursor: { seq: number; ts: string }[] = [];
  while (monoMs + APPEND_EVERY_MS < nextStepAtMono) beforeCursor.push(append());
  const cursor: AuditCursor = { mark: markFromRows(beforeCursor), wallMs, monoMs };
  const afterCursor = Array.from({ length: 60 }, append);
  const page = [...beforeCursor, ...afterCursor];

  const selected = selectRowsAfterCursor(page, cursor);
  ok(selected.length === afterCursor.length, "the cursor selects every row appended after it, under a clock that steps backward");
  ok(
    selected.every((row, i) => row === afterCursor[i]),
    "…and exactly those rows, in the store's own insert order",
  );

  const byWallClock = afterCursor.filter((r) => Date.parse(r.ts) >= cursor.wallMs);
  ok(byWallClock.length < afterCursor.length, "the OLD `ts >= wakeAt` predicate DROPS rows the wait wanted — the defect this migration removes");

  const routeOrdered = [...page].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || b.seq - a.seq);
  ok(
    routeOrdered.at(-1)!.seq !== page.length,
    "the route's order really does disagree with the insert order — otherwise the next assertion proves nothing",
  );
  ok(markFromRows(routeOrdered) === page.length, "the mark is the page's MAXIMUM seq, whatever position the route served it in");

  let previousMark = 0;
  for (let i = 1; i <= page.length; i++) {
    const mark = markFromRows(page.slice(0, i));
    ok(mark >= previousMark, "the mark a growing log establishes never decreases");
    previousMark = mark;
  }

  ok(
    page.some((row, i) => i > 0 && Date.parse(row.ts) < Date.parse(page[i - 1]!.ts)),
    "the fake clock really did lose time — otherwise this whole block runs against a clock that never stepped",
  );
}

console.log(`✓ audit-cursor: ${passed} assertions passed`);
