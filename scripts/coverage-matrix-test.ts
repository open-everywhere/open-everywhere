import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseInventoryRows,
  parseNaDeclaration,
  parseProvesAnnotations,
  soakCheckerAfter,
  buildMatrix,
  isCovered,
  findings,
  summarise,
  classifyRow,
  summaryDisagreements,
  totals,
  coverageReportLines,
  legVerdict,
  tallyBySurface,
  legBoardLines,
  parseLegsJson,
  parseLegsBoard,
  PENDING_REASON_PREFIX,
  type ProvesClaim,
} from "./coverage-matrix-lib.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_CLI = join(REPO_ROOT, "scripts", "coverage-matrix.ts");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const PAGE = [
  "# Fixture inventory",
  "",
  "| Column | Meaning |",
  "| --- | --- |",
  "| Id | not a behaviour table — no Tested by column |",
  "",
  "| Id | Behaviour | Code | Documented by | Tested by |",
  "| --- | --- | --- | --- | --- |",
  "| `FIX-covered` | Proven by a unit test. | `a.ts:1` | docs/x.md | ? |",
  "| FIX-na | Genuinely out of scope. | `b.ts:1` | docs/x.md | n/a: no offline tier can reach a live webhook |",
  "| FIX-pending | Nobody has annotated it yet. | `c.ts:1` | docs/x.md | n/a: unannotated — lane F |",
  "| FIX-uncovered | Nothing proves it and nothing declares it. | `d.ts:1` | docs/x.md | ? |",
  "| FIX-escaped | Holds `\"arms\" \\| \"disarms\"` in its behaviour cell. | `e.ts:1` | docs/x.md | ? |",
  "| FIX-malformed | too few cells |",
  "",
].join("\n");

{
  const warnings: string[] = [];
  const rows = parseInventoryRows(PAGE, "docs/inventory/fixture.md", warnings);
  const ids = rows.map((r) => r.id);
  ok(ids.join(",") === "FIX-covered,FIX-na,FIX-pending,FIX-uncovered,FIX-escaped", `the five behaviour rows parse in order, and nothing else does — got ${ids.join(",")}`);
  ok(!ids.includes("Id"), "the legend table's own row is not read as a behaviour row");
  ok(!ids.includes("FIX-malformed"), "a row whose cell count disagrees with its header is skipped, never guessed at");
  ok(warnings.length === 1 && warnings[0]?.includes("FIX-malformed") === false && warnings[0]?.includes("SKIPPED") === true, `a skipped row reaches the warnings channel — got ${warnings.length}: ${warnings[0] ?? "none"}`);
  const escaped = rows.find((r) => r.id === "FIX-escaped");
  ok(escaped !== undefined, "a row carrying a markdown-escaped `\\|` parses rather than being dropped");
  ok(escaped?.declared === "?", `…and its Tested by cell is read whole, not split — got ${escaped?.declared}`);
  ok((rows[0] as { line: number }).line === 9, `the row's line number is the page's own 1-based line — got ${(rows[0] as { line: number }).line}`);
  ok((rows[0] as { declared: string }).declared === "?", "the backticked id is unwrapped and the Tested by cell is read whole");
  ok(parseInventoryRows("no table here at all\n", "docs/inventory/x.md").length === 0, "a page with no behaviour table yields no rows");
}

{
  const real = parseNaDeclaration("n/a: no offline tier can reach a live webhook");
  ok(real !== undefined && real.pending === false, "a reasoned exemption parses and is NOT pending");
  const pending = parseNaDeclaration(`n/a: ${PENDING_REASON_PREFIX} — lane F`);
  ok(pending !== undefined && pending.pending === true, "the seed reason parses as PENDING, so a seeded gate cannot read as a finished one");
  ok(parseNaDeclaration("n/a") === undefined, "a bare `n/a` with no reason is NOT a declaration — an exemption nobody justified is one nobody revisits");
  ok(parseNaDeclaration("?") === undefined, "`?` is not a declaration");
  ok(parseNaDeclaration("`n/a: wrapped in a code span`") !== undefined, "a declaration still parses inside a markdown code span");
}

{
  const found = parseProvesAnnotations(["// proves: A-1, A-2", "const x = 1;", " * proves: B-1", ""].join("\n"));
  ok(found.length === 2, `both comment forms are read — got ${found.length}`);
  ok(found[0]?.ids.join(",") === "A-1,A-2" && found[0]?.line === 1, "a comma list parses into ids, with the 1-based line");
  ok(found[1]?.ids.join(",") === "B-1", "a jsdoc continuation line is read too");
  ok(parseProvesAnnotations(`const s = "// proves: FAKE-1";\n`).length === 0, "a `// proves:` that follows code on the same line is NOT a declaration");
  ok(parseProvesAnnotations("// proves:\n").length === 0, "a `proves:` naming nothing is not a declaration");
}

{
  const text = ["// proves: S-1", "export function checkThing(e: E): F {", "  return e;", "}", "// proves: S-2", "const notAFunction = 1;"].join("\n");
  ok(soakCheckerAfter(text, 1) === "checkThing", "an annotation is attributed to the checker that follows it");
  ok(soakCheckerAfter(text, 5) === undefined, "an annotation followed by no checker is attributed to NOTHING rather than to the nearest thing");
}

{
  const rows = parseInventoryRows(PAGE, "docs/inventory/fixture.md");
  const claims: readonly ProvesClaim[] = [
    { ids: ["FIX-covered"], source: "scripts/a-test.ts", line: 1, kind: "unit", cell: "scripts/a-test.ts" },
    { ids: ["FIX-renamed-away"], source: "scripts/b-test.ts", line: 3, kind: "unit", cell: "scripts/b-test.ts" },
  ];
  const matrix = buildMatrix(rows, claims, new Set(["FIX-audit-only"]));
  const byId = new Map(matrix.map((m) => [m.row.id, m]));

  ok(isCovered(byId.get("FIX-covered") as never), "a row a unit annotation names is covered");
  ok(!isCovered(byId.get("FIX-uncovered") as never), "a row nothing names is NOT covered — the negative control for the line above");
  ok(byId.get("FIX-covered")?.cells.unit.join(",") === "scripts/a-test.ts", "the unit cell carries what runs the proof, not a tick");
  ok((byId.get("FIX-na")?.na?.pending ?? true) === false, "the reasoned exemption rides the row as a non-pending declaration");

  const found = findings(matrix, claims);
  const uncovered = found.filter((f) => f.kind === "uncovered");
  const stale = found.filter((f) => f.kind === "stale-row-id");
  const uncoveredIds = uncovered.map((f) => (f.message.match(/`([^`]+)`/u) ?? [])[1]).join(",");
  ok(uncoveredIds === "FIX-uncovered,FIX-escaped", `exactly the two undeclared, unproven rows are reported uncovered — got ${uncoveredIds}`);
  ok(!found.some((f) => f.message.includes("FIX-na") || f.message.includes("FIX-pending")), "a declared row is never reported uncovered — a declaration is the whole escape hatch");
  ok(stale.length === 1 && stale[0]?.message.includes("FIX-renamed-away"), `a declaration naming a row the inventory lost is reported stale — got ${stale.length}`);
  ok(stale[0]?.file === "scripts/b-test.ts" && stale[0]?.line === 3, "a stale finding points at the DECLARATION, which is the thing to fix");

  const auditMatrix = buildMatrix(parseInventoryRows("| Id | B | Tested by |\n| --- | --- | --- |\n| FIX-audit-only | x | ? |\n", "f.md"), [], new Set(["FIX-audit-only"]));
  ok(isCovered(auditMatrix[0] as never), "a row whose id the audit registry declares is covered by the audit cell alone");
  ok(findings(auditMatrix, []).length === 0, "…and therefore reds nothing");
}

{
  const rows = parseInventoryRows(PAGE, "docs/inventory/fixture.md");
  const matrix = buildMatrix(rows, [{ ids: ["FIX-covered"], source: "t.ts", line: 1, kind: "unit", cell: "t.ts" }], new Set());
  const summary = summarise(matrix);
  const all = totals(summary);
  ok(all.rows === 5 && all.covered === 1 && all.naDeclared === 1 && all.pending === 1 && all.uncovered === 2, `each row lands in exactly one bucket — got ${JSON.stringify(all)}`);
  ok(all.covered + all.naDeclared + all.pending + all.uncovered === all.rows, "the four buckets sum to the row count, so no row can be double-counted or lost");
  const printed = coverageReportLines(matrix).join("\n");
  ok(printed.includes("| docs/inventory/fixture.md | 5 | 1 | 1 | 1 | 2 |"), "the report prints the per-page row it computed");
  ok(printed.includes("unit 1"), "…and the per-cell counts beside it");
}

{
  const rows = parseInventoryRows(PAGE, "docs/inventory/fixture.md");
  const claims: ProvesClaim[] = [
    { ids: ["FIX-covered"], source: "t.ts", line: 1, kind: "unit", cell: "t.ts" },
    { ids: ["FIX-pending"], source: "t.ts", line: 2, kind: "unit", cell: "t.ts" },
  ];
  const matrix = buildMatrix(rows, claims, new Set());
  const seeded = matrix.find((e) => e.row.id === "FIX-pending");
  ok(seeded?.na?.pending === true, "the fixture row really does still carry its seed `n/a: unannotated` cell");
  ok(isCovered(seeded as never), "…and really is covered, so it is the double-counted shape");
  ok(classifyRow(seeded as never) === "covered", "a covered row classifies as covered, whatever its cell still says");

  const summaries = summarise(matrix);
  const all = totals(summaries);
  ok(all.covered === 2 && all.pending === 0, `the seeded-and-covered row is counted ONCE, as covered — got ${JSON.stringify(all)}`);
  ok(summaryDisagreements(matrix, summaries).length === 0, "the table and the totals agree on a matrix classified once");

  const doubled = summaries.map((s) => ({ ...s, pending: s.pending + 1 }));
  const problems = summaryDisagreements(matrix, doubled);
  ok(problems.length > 0, "a bucket counted twice is a disagreement, not a silent number");
  ok(problems.some((p) => p.includes("docs/inventory/fixture.md") && p.includes("counted twice")), `…and the problem names the page — got ${JSON.stringify(problems)}`);
  ok(summaryDisagreements(matrix, summaries.map((s) => ({ ...s, covered: s.covered - 1 }))).length > 0, "a bucket counted too FEW times reds the same way");
  ok(summaryDisagreements(matrix, []).length > 0, "a table that dropped every page reds rather than reporting zero rows");
}

{
  const deployDir = join(dirname(fileURLToPath(import.meta.url)), "deploy");
  const readers: string[] = [];
  for (const entry of readdirSync(deployDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const text = readFileSync(join(deployDir, entry.name), "utf8");
    if (/coverage-(matrix|scan|board)/.test(text)) readers.push(entry.name);
  }
  ok(readers.length === 0, `no ship rung reads the coverage matrix — got ${JSON.stringify(readers)}`);
  const here = readdirSync(dirname(fileURLToPath(import.meta.url)), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && /coverage-(matrix|scan|board)/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), e.name), "utf8")))
    .length;
  ok(here > 0, `the scan finds coverage-matrix readers where they do exist — got ${here}`);
}

{
  ok(legVerdict("GREEN") === "green", "GREEN is green");
  ok(legVerdict("RED") === "red", "RED is red");
  ok(legVerdict("DEFERRED") === "not-run" && legVerdict("FILTERED") === "not-run", "a leg nobody ran is not-run, whichever way it was skipped");
  ok(legVerdict("GAP") === "gap", "a declared gap is its own verdict, never a red");
  ok(legVerdict("SOMETHING-NEW") === "red", "a status this board does not know is RED, never not-run");

  const legs = [
    { id: "J1", surface: "slack", status: "GREEN" },
    { id: "J-NOT", surface: "notion", status: "RED", reason: "reply timeout" },
    { id: "J-GH", surface: "github", status: "FILTERED" },
    { id: "J-DISC", surface: "discord", status: "GREEN" },
    { id: "J-LIN", surface: "linear", status: "GREEN" },
    { id: "J-TEAM", surface: "teams", status: "GAP", reason: "declared gap — no Teams tenant fixture" },
  ];
  const tally = tallyBySurface(legs);
  ok(tally.length === 6, `every surface the legs name gets a tally — got ${tally.length}`);
  ok(tally.find((t) => t.surface === "notion")?.red === 1, "a red is counted against its own surface");
  const teams = tally.find((t) => t.surface === "teams");
  ok(teams?.gap === 1 && teams?.red === 0, `a declared gap lands in its own bucket, not the red one — got gap=${teams?.gap} red=${teams?.red}`);

  const lines = legBoardLines(legs);
  const text = lines.join("\n");
  ok((lines[0] ?? "").startsWith("LAUNCH") && (lines[0] ?? "").includes("slack") && (lines[0] ?? "").includes("notion") && (lines[0] ?? "").includes("github"), `the headline line carries the three launch surfaces — got ${lines[0]}`);
  ok((lines[1] ?? "").includes("discord") && (lines[1] ?? "").includes("teams"), `the second line carries discord and teams — got ${lines[1]}`);
  ok(text.includes("linear"), "a surface on neither named line still reaches the board rather than being dropped");
  ok(
    legBoardLines([{ id: "J1", surface: "slack", status: "GREEN" }]).join("\n").includes("teams —"),
    "a surface with no legs this pass prints as absent, never as zero-red",
  );
  ok(text.includes("J-NOT (notion) — reply timeout"), "a red leg is named with its reason, so the board is actionable");
  ok(!legBoardLines([{ id: "J1", surface: "slack", status: "GREEN" }]).join("\n").includes("RED legs:"), "an all-green pack prints no red list — the negative control for the line above");

  ok(text.includes("1 red,"), `the summary counts the one real red only, not the gap — got ${lines.find((l) => l.includes(" legs — "))}`);
  ok(text.includes("1 declared gap"), "…and counts the gap separately, where a reader can see it");
  const redBlock = text.slice(text.indexOf("RED legs:"), text.indexOf("DECLARED GAPS"));
  ok(!redBlock.includes("J-TEAM"), "a declared gap is never listed as a red leg");
  ok(text.includes("J-TEAM (teams) — declared gap — no Teams tenant fixture"), "a declared gap IS named with the fixture it waits on — an unnamed gap is one nobody provisions");
  ok(
    !legBoardLines([{ id: "J1", surface: "slack", status: "GREEN" }]).join("\n").includes("DECLARED GAPS"),
    "a pack with no gaps prints no gap list — the negative control for the two lines above",
  );
}

{
  ok(parseLegsJson(`[{"id":"J1","surface":"slack","status":"GREEN"}]`).length === 1, "a bare array of legs parses");
  ok(parseLegsJson(`{"legs":[{"id":"J1","surface":"slack","status":"RED","reason":"x"}]}`)[0]?.reason === "x", "the wrapped shape parses, reason and all");
  assert.throws(() => parseLegsJson("[]"), /holds no leg/u, "an empty results file THROWS — rendering it as `0 red` is the one thing a reader must never be told by mistake");
  n++;

  const printed = ["## Ship legs", "", "| Leg | Surface | Status | Evidence / reason |", "| --- | --- | --- | --- |", "| J1 | slack | GREEN | 4 gates |", "| J-NOT | notion | RED | timeout |"].join("\n");
  const fromBoard = parseLegsBoard(printed);
  ok(fromBoard.length === 2 && fromBoard[1]?.status === "RED", `the runner's printed board parses back into legs — got ${fromBoard.length}`);

  const piped = ["| Leg | Surface | Status | Evidence / reason |", "| --- | --- | --- | --- |", "| J-X | slack | RED | expected `a \\| b`, got `c` |"].join("\n");
  ok(parseLegsBoard(piped)[0]?.reason === "expected `a | b`, got `c`", `a reason carrying an escaped pipe survives whole — got ${parseLegsBoard(piped)[0]?.reason}`);
  ok(parseLegsBoard(piped)[0]?.status === "RED", "…and the escaped pipe did not shift the status column");
  assert.throws(() => parseLegsBoard("| a | b | c | d |\n"), /no .* table found/u, "a four-column table with no `Leg | Surface | Status` header is NOT read as a board");
  n++;
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-coverage-"));
  const DEFAULT_FIXTURE = { scenarios: [{ id: "S-FIX", proves: ["FIX-e2e"] }], auditActions: ["FIX-audit"] };
  const tree = (name: string, page: string, annotation: string, fixture: unknown = DEFAULT_FIXTURE): string => {
    const root = join(dir, name);
    mkdirSync(join(root, "docs", "inventory"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "docs", "inventory", "fixture.md"), page);
    writeFileSync(join(root, "scripts", "fixture-test.ts"), annotation);
    writeFileSync(join(root, "coverage-fixture.json"), JSON.stringify(fixture));
    return root;
  };
  const run = (root: string): { code: number; out: string } => {
    try {
      const out = execFileSync("npx", ["tsx", MATRIX_CLI, "--root", root, "--check"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const header = "| Id | Behaviour | Tested by |\n| --- | --- | --- |\n";
  const ANNOTATION = "// proves: FIX-unit\n";

  const green = run(tree("green", `${header}| FIX-unit | u | ? |\n| FIX-e2e | e | ? |\n| FIX-audit | a | ? |\n| FIX-off | o | n/a: out of scope, and here is why |\n`, ANNOTATION));
  ok(green.code === 0, `a tree where every row is proven or declared EXITS 0 — got ${green.code}\n${green.out}`);
  ok(green.out.includes("3 covered"), `…and all three cell roads reached the count — got: ${green.out.split("\n").filter((l) => l.includes("covered")).join(" / ")}`);
  ok(green.out.includes("1 exempt, 0 PENDING"), `the pass line splits exempt from pending — got: ${green.out.split("\n").filter((l) => l.startsWith("✓")).join(" / ")}`);

  const uncovered = run(tree("uncovered", `${header}| FIX-unit | u | ? |\n| FIX-orphan | nothing proves this | ? |\n`, ANNOTATION));
  ok(uncovered.code === 1, `a tree holding an undeclared, unproven row EXITS 1 — got ${uncovered.code}`);
  ok(uncovered.out.includes("FIX-orphan") && uncovered.out.includes("[uncovered]"), "…and the failure names the row and what to do about it");

  const stale = run(tree("stale", `${header}| FIX-unit | u | ? |\n`, "// proves: FIX-unit, FIX-deleted-row\n"));
  ok(stale.code === 1, `a declaration naming a row the inventory no longer holds EXITS 1 — got ${stale.code}`);
  ok(stale.out.includes("FIX-deleted-row") && stale.out.includes("[stale-row-id]"), "…and the failure names the dead id, at the declaration");

  const noRows = run(tree("norows", "# a page with no behaviour table at all\n", ANNOTATION));
  ok(noRows.code === 1 && noRows.out.includes("broken scan"), `a scan that parses no inventory row is a RED, never a pass — got ${noRows.code}`);

  const noClaims = run(tree("noclaims", `${header}| FIX-off | o | n/a: out of scope, and here is why |\n`, "// nothing declared here\n", {}));
  ok(noClaims.code === 1 && noClaims.out.includes("scanner broke"), `a scan that finds no declaration anywhere is a RED, never a pass — got ${noClaims.code}`);

  rmSync(dir, { recursive: true, force: true });
}

console.log(`✓ coverage matrix: ${n} assertions`);
