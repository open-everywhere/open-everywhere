import assert from "node:assert/strict";
import { boardGaps, boardTotals, renderBoard, rosterIds, type BoardLeg } from "../packages/core/scripts/e2e/board.js";
import { SCENARIOS } from "../packages/core/scripts/e2e/scenarios.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const leg = (id: string, status: BoardLeg["status"], over: Partial<BoardLeg> = {}): BoardLeg => ({ id, surface: "slack", status, ...over });

{
  const legs = [leg("a", "GREEN"), leg("b", "RED"), leg("c", "RED"), leg("d", "DEFERRED"), leg("e", "FILTERED")];
  const t = boardTotals(legs);
  ok(t.green === 1 && t.red === 2 && t.deferred === 1 && t.filtered === 1 && t.total === 5, "the totals count each status once and sum to the row count");
  ok(boardTotals([]).total === 0, "an empty board totals zero rather than throwing");
}

{
  const gaps = boardGaps([leg("a", "GREEN")], ["a", "b"]);
  ok(gaps.missing.join(",") === "b", "a roster leg with no row is reported missing");
  ok(gaps.unknown.length === 0, "…and nothing is reported unknown");

  const ghost = boardGaps([leg("a", "GREEN"), leg("ghost", "RED")], ["a"]);
  ok(ghost.unknown.join(",") === "ghost", "a row naming an id the roster does not hold is reported unknown");
  ok(ghost.missing.length === 0, "…and nothing is reported missing");

  const clean = boardGaps([leg("a", "GREEN"), leg("b", "RED")], ["a", "b"]);
  ok(clean.missing.length === 0 && clean.unknown.length === 0, "🔴 NEGATIVE CONTROL: a complete board reports no gap in either direction");
}

{
  const legs = [
    leg("B-LEG", "RED", { surface: "teams", reason: "cannot run — missing teams driver (set E2E_TEAMS_REFRESH_TOKEN)" }),
    leg("A-LEG", "GREEN", { evidence: "7 gates, 2 judged, 31.4s" }),
  ];
  const lines = renderBoard(legs, ["A-LEG", "B-LEG"]);
  ok(lines[0] === "## Ship legs", "the board opens with the heading the ship report uses, so it pastes straight in");
  ok(lines.some((l) => l === "| Leg | Surface | Status | Evidence / reason |"), "it carries a header row");
  const rows = lines.filter((l) => l.startsWith("| ") && !l.startsWith("| Leg") && !l.startsWith("| ---"));
  ok(rows.length === 2, "one row per leg");
  ok(rows[0]?.startsWith("| A-LEG |") === true, "rows come out in ROSTER order even though B-LEG finished first");
  ok(rows[1]?.includes("RED") === true && rows[1]?.includes("E2E_TEAMS_REFRESH_TOKEN") === true, "a RED row carries its reason, including the variable that would arm it");
  ok(rows[0]?.includes("7 gates") === true, "a GREEN row carries its evidence rather than a reason");
  ok(lines.some((l) => l.includes("1 GREEN, 1 RED")), "the summary line counts the statuses");
}

{
  const rows = renderBoard([leg("X", "RED", { reason: "a | b\nc   d" })], ["X"]).filter((l) => l.startsWith("| X |"));
  ok(rows.length === 1, "the leg renders as exactly one row");
  ok(rows[0]?.includes("\\|") === true, "a pipe inside a reason is escaped rather than splitting the row into columns");
  ok(rows[0]?.includes("\n") === false, "a newline inside a reason is flattened, so one leg stays one row");
}

{
  const rows = renderBoard([leg("known", "GREEN"), leg("stray", "RED")], ["known"]).filter((l) => l.startsWith("| ") && !l.startsWith("| Leg") && !l.startsWith("| ---"));
  ok(rows.length === 2, "a row for an unknown id is still rendered, after the roster rows");
  ok(rows[1]?.startsWith("| stray |") === true, "…and it comes last, so the roster block stays stable");
}

{
  const ids = rosterIds();
  ok(ids.length === SCENARIOS.length, "rosterIds covers every scenario");
  ok(new Set(ids).size === ids.length, "…and every scenario id is unique, or two legs would share one board row");
}

console.log(`✓ e2e-board: ${n} assertions passed`);
