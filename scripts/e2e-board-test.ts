import assert from "node:assert/strict";
import {
  DECLARED_GAP_SURFACES,
  LAUNCH_SURFACES,
  boardGaps,
  boardTotals,
  isDeclaredGap,
  releaseBoardProblems,
  renderBoard,
  rosterIds,
  type BoardLeg,
} from "../packages/core/scripts/e2e/board.js";
import {
  LAUNCH_RELEASE_SCOPE,
  releasePhaseProblem,
  releaseScopeIndex,
  releaseScopeProblems,
} from "../packages/core/scripts/e2e/release-scope.js";
import { SCENARIOS } from "../packages/core/scripts/e2e/scenarios.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const leg = (id: string, status: BoardLeg["status"], over: Partial<BoardLeg> = {}): BoardLeg => ({ id, surface: "slack", status, ...over });

{
  const legs = [leg("a", "GREEN"), leg("b", "RED"), leg("c", "RED"), leg("d", "DEFERRED"), leg("e", "FILTERED"), leg("f", "NOT_RUN")];
  const t = boardTotals(legs);
  ok(t.green === 1 && t.red === 2 && t.deferred === 1 && t.filtered === 1 && t.notRun === 1 && t.total === 6, "the totals count each status once and sum to the row count");
  ok(boardTotals([]).total === 0, "an empty board totals zero rather than throwing");
}

{
  const problems = releaseScopeProblems();
  ok(
    problems.missing.length === 0 &&
      problems.unknown.length === 0 &&
      problems.duplicate.length === 0 &&
      problems.invalidEquivalent.length === 0 &&
      problems.invalidReason.length === 0 &&
      problems.invalidPhase.length === 0,
    "the launch policy classifies every real scenario exactly once and every named equivalent is itself required",
  );
  ok(LAUNCH_RELEASE_SCOPE.length === SCENARIOS.length, "the launch policy has one visible accounting row per roster leg");

  const index = releaseScopeIndex();
  ok(index.get("S-SPEND-DM-MASK")?.requirement === "REQUIRED", "a shared security row stays REQUIRED even though its current live vehicle is Discord");
  ok(
    index.get("S8")?.requirement === "NON_LAUNCH" && index.get("S8")?.equivalents?.join(",") === "J2,J-UNI-X",
    "S8 is deferred only with both required launch-surface memory/isolation equivalents named",
  );
  ok(
    index.get("S-DISCORD-GRANT")?.requirement === "REQUIRED" &&
      index.get("S-DISCORD-GRANT")?.requiredPhase === "discord-grant-tapped" &&
      index.get("S-DISCORD-GRANT")?.reason.includes("Discord owner") === true,
    "grant.used to grant.notified remains REQUIRED and explicitly requires the human-tapped Discord phase",
  );
  const grantRow = index.get("S-DISCORD-GRANT")!;
  ok(
    releasePhaseProblem(grantRow, {})?.includes("E2E_DISCORD_GRANT_TAPPED=1") === true,
    "an ordinary raising-phase S-DISCORD-GRANT run cannot satisfy the launch release",
  );
  ok(
    releasePhaseProblem(grantRow, { E2E_DISCORD_GRANT_TAPPED: "1" }) === undefined,
    "the tapped phase clears the release phase prerequisite so its grant.used/notified gates decide the row",
  );

  const missing = releaseScopeProblems(LAUNCH_RELEASE_SCOPE.filter((row) => row.id !== "J1"));
  ok(missing.missing.join(",") === "J1", "a new or accidentally removed roster classification fails the policy closed");
  const duplicate = releaseScopeProblems([...LAUNCH_RELEASE_SCOPE, LAUNCH_RELEASE_SCOPE[0]!]);
  ok(duplicate.duplicate.join(",") === LAUNCH_RELEASE_SCOPE[0]!.id, "a duplicate policy row is reported rather than overwritten by an index");
  const badEquivalent = releaseScopeProblems(
    LAUNCH_RELEASE_SCOPE.map((row) => (row.id === "S8" ? { ...row, equivalents: ["J-DISC"] } : row)),
  );
  ok(badEquivalent.invalidEquivalent.join(",") === "S8->J-DISC", "a non-required equivalence target is refused");
  const blankReason = releaseScopeProblems(
    LAUNCH_RELEASE_SCOPE.map((row) => (row.id === "J1" ? { ...row, reason: " " } : row)),
  );
  ok(blankReason.invalidReason.join(",") === "J1", "an empty release-policy reason is refused");
  const phaseOnNonLaunch = releaseScopeProblems(
    LAUNCH_RELEASE_SCOPE.map((row) => (row.id === "J-DISC" ? { ...row, requiredPhase: "discord-grant-tapped" as const } : row)),
  );
  ok(phaseOnNonLaunch.invalidPhase.join(",") === "J-DISC:discord-grant-tapped", "a phase prerequisite cannot hide on a NON_LAUNCH row");
  const phaseOnWrongRequired = releaseScopeProblems(
    LAUNCH_RELEASE_SCOPE.map((row) => (row.id === "J1" ? { ...row, requiredPhase: "discord-grant-tapped" as const } : row)),
  );
  ok(phaseOnWrongRequired.invalidPhase.join(",") === "J1:discord-grant-tapped", "the Discord tap prerequisite cannot be copied onto an unrelated REQUIRED row");
}

{
  const scoped = [
    leg("required", "GREEN", { requirement: "REQUIRED", evidence: "1 gate" }),
    leg("deferred", "NOT_RUN", { requirement: "NON_LAUNCH", surface: "discord", reason: "outside launch" }),
  ];
  const clean = releaseBoardProblems(scoped);
  ok(
    clean.requiredNotGreen.length === 0 && clean.nonLaunchNotNotRun.length === 0 && clean.unearnedEquivalent.length === 0 && clean.unclassified.length === 0,
    "a required GREEN plus a visible non-launch NOT_RUN is a complete scoped board",
  );

  const requiredRed = releaseBoardProblems([leg("required", "RED", { requirement: "REQUIRED", reason: "fixture missing" })]);
  ok(requiredRed.requiredNotGreen.join(",") === "required:RED", "a required missing/failed leg cannot pass a scoped release");
  const hiddenRequired = releaseBoardProblems([leg("required", "NOT_RUN", { requirement: "REQUIRED", reason: "wrongly omitted" })]);
  ok(hiddenRequired.requiredNotGreen.join(",") === "required:NOT_RUN", "a required leg cannot disappear into NOT_RUN accounting");
  const ranNonLaunch = releaseBoardProblems([leg("deferred", "GREEN", { requirement: "NON_LAUNCH", evidence: "ran unexpectedly" })]);
  ok(ranNonLaunch.nonLaunchNotNotRun.join(",") === "deferred:GREEN", "a non-launch row that accidentally ran cannot be folded into the scoped verdict");
  const earnedEquivalent = releaseBoardProblems([
    leg("J2", "GREEN", { requirement: "REQUIRED", evidence: "memory isolation proved" }),
    leg("J-UNI-X", "GREEN", { requirement: "REQUIRED", evidence: "cross-surface recall proved" }),
    leg("S8", "NOT_RUN", { requirement: "NON_LAUNCH", equivalents: ["J2", "J-UNI-X"], reason: "Discord vehicle deferred" }),
  ]);
  ok(earnedEquivalent.unearnedEquivalent.length === 0, "S8 equivalence is earned only when J2 and J-UNI-X are both GREEN in this run");
  const unearnedEquivalent = releaseBoardProblems([
    leg("J2", "GREEN", { requirement: "REQUIRED", evidence: "memory isolation proved" }),
    leg("J-UNI-X", "RED", { requirement: "REQUIRED", reason: "failed" }),
    leg("S8", "NOT_RUN", { requirement: "NON_LAUNCH", equivalents: ["J2", "J-UNI-X"], reason: "Discord vehicle deferred" }),
  ]);
  ok(unearnedEquivalent.unearnedEquivalent.join(",") === "S8->J-UNI-X", "S8 cannot claim equivalence from a present but non-green J-UNI-X row");
  const missingIsolationEquivalent = releaseBoardProblems([
    leg("J-UNI-X", "GREEN", { requirement: "REQUIRED", evidence: "cross-surface recall proved" }),
    leg("S8", "NOT_RUN", { requirement: "NON_LAUNCH", equivalents: ["J2", "J-UNI-X"], reason: "Discord vehicle deferred" }),
  ]);
  ok(
    missingIsolationEquivalent.unearnedEquivalent.join(",") === "S8->J2",
    "S8 cannot claim equivalence from cross-surface recall alone without J2's memory/silo proof",
  );

  const lines = renderBoard(scoped, ["required", "deferred"]);
  ok(lines.some((line) => line === "| Leg | Surface | Requirement | Status | Evidence / reason |"), "a scoped board labels each row's requirement");
  ok(lines.some((line) => line.includes("1 NOT RUN outside this release scope")), "the headline counts non-launch work as NOT RUN, never green or absent");
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
  ok(isDeclaredGap("discord", "needs a second Discord identity"), "a reasoned Discord fixture gap IS a declared gap");
  ok(isDeclaredGap("teams", "needs a second Teams identity"), "…and so is a Teams one");
  ok(!isDeclaredGap("slack", "needs a Slack-reachable connector grant"), "🔴 a LAUNCH surface's missing fixture stays RED — the launch gates on it");
  ok(!isDeclaredGap("notion", "needs a fixture"), "…Notion too");
  ok(!isDeclaredGap("github", "needs a fixture"), "…and GitHub");
  ok(
    !isDeclaredGap("linear", "needs a fixture") && !isDeclaredGap("cross", "needs a fixture"),
    "🔴 a surface in NEITHER list stays RED — the gap set is an explicit ruling, never 'anything that is not a launch surface'",
  );
  ok(!isDeclaredGap("discord", ""), "🔴 an EMPTY reason is not a declared gap — the sentence naming the fixture is the whole of what a gap buys over a red");
  ok(!isDeclaredGap("discord", "   "), "…and whitespace does not count as a reason either");
  ok(!isDeclaredGap("discord", undefined), "…nor does an absent one");
  ok(
    LAUNCH_SURFACES.every((s) => !DECLARED_GAP_SURFACES.includes(s)),
    "no surface is both a launch surface and a declared-gap surface — the two rulings would contradict",
  );
}

{
  const legs = [leg("a", "GREEN"), leg("b", "RED"), leg("c", "GAP", { surface: "discord", reason: "needs a second identity" })];
  const t = boardTotals(legs);
  ok(t.gap === 1 && t.green === 1 && t.red === 1 && t.total === 3, "a GAP is counted in its own bucket and still counts toward the roster total");

  const lines = renderBoard(legs, ["a", "b", "c"]);
  ok(
    lines.some((l) => l.includes("2 legs scored") && l.includes("1 GREEN, 1 RED")),
    "🔴 the headline counts only the SCORED legs — a gap is not a verdict about this ship, so it must not move the number a shipper reads",
  );
  ok(lines.some((l) => l.includes("1 DECLARED GAP(S)") && l.includes("c (discord)")), "the gaps get their own line, and it NAMES them — an unnamed gap is one nobody provisions");
  ok(
    renderBoard([leg("a", "GREEN")], ["a"]).every((l) => !l.includes("DECLARED GAP")),
    "🔴 a board with no gaps prints no gap line at all, rather than a '0 declared gaps' line nobody needs",
  );
}

{
  const ids = rosterIds();
  ok(ids.length === SCENARIOS.length, "rosterIds covers every scenario");
  ok(new Set(ids).size === ids.length, "…and every scenario id is unique, or two legs would share one board row");
}

console.log(`✓ e2e-board: ${n} assertions passed`);
