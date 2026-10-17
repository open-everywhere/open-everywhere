# The coverage matrix — how a behaviour row gets an answer

`docs/inventory/` lists the behaviour rows — `npm run coverage-matrix` prints how many. Each row
names one thing the code does. This page says how a row gets the answer to one question: **is this
behaviour proven?**

Before this existed, the answer was a `?` on 2,157 of those rows, and the 41 rows that carried a
value carried it by hand. A hand-written cell is a claim nobody checks: a test could be deleted and
the page would go on naming it. The matrix replaces the hand-written cell with a **declaration that
lives beside the code that does the proving**, so the claim moves when the code moves and breaks
when the code goes.

## The two commands

```
npm run coverage-matrix        # the report: covered / n/a / pending / uncovered per page
npm run lint:coverage-matrix   # the gate: refuse the tree on any row with no answer
npm run coverage-board         # THE BOARD: the same coverage half, plus the last pack's legs
```

`lint:coverage-matrix` runs in the root `test:chain`.

## Five cells per row

A row is **covered** when at least one of these five cells is filled.

| Cell | Declared where | The cell reads |
| --- | --- | --- |
| unit | a `*.test.ts`, `*-test.ts` or `*.spec.ts` file carrying `// proves: <row-id>`, outside the integration tier | the file, and the npm leg that runs it |
| integration | the same `// proves:` line in a `*.test.ts` file under `tests/integration/` | the file, and the npm leg that runs it |
| e2e | a `proves` field on a scenario in `packages/core/scripts/e2e/scenarios.ts` | the scenario id |
| soak | a `// proves:` comment above an `export function check…` in `packages/core/scripts/soak/soak-invariants.ts` | the checker's name |
| audit | nothing — the row's own id is an action the post-ship census asserts | the action name |

**The unit cell and the integration cell are apart on purpose.** An integration test drives a real
agent host and a unit test does not, so the two prove different things and cost different amounts
to run. The scan picks the cell from the file's path. A file is `integration` exactly when
`npm run test:integration` schedules it: `INTEGRATION_INCLUDE_GLOBS` in `scripts/it-shards.ts` is
`tests/integration/**/*.test.ts`, and `npm run test:coverage-matrix` pins that constant. Before
OPE-2140 every test-file proof filed as unit, so the report could not say which rows had an
integration proof. `npm run coverage-matrix -- --json` prints both cells for every row.

**The audit cell is the weakest of the five, and it is narrower than the registry.** It does not
prove the behaviour the row describes. It says `npm run deploy:census` asserts that a row for this
action exists in one org's audit log, at any age — evidence that a path was driven some time, not
that it still does what the row says. Only a **consequential** declaration with no `notExercised`
reason counts. An operational action fills nothing (the registry's own header says that table
"carries names only" and the census asserts nothing about it), and neither does a declaration
carrying `notExercised`, whose field comment says the e2e pack does not exercise it. Counting the
whole registry would report 266 rows covered where 24 are.

### Annotating a test

Put the comment on its own line, anywhere in the file. A comma separates ids.

```ts
// proves: PAR-seat-catch-up, PAR-seat-context-admission
```

It must be a **whole line**. A `// proves:` that follows code on the same line is ignored on
purpose: accepting it would turn every string literal holding the word into a declaration site, and
a scanner that reads a claim out of test data reports coverage nobody wrote.

### Annotating an e2e scenario

The scenario is a definition object, so this one is a typed field rather than a comment — a typo is
then a build error:

```ts
{
  id: "J-MPIM",
  …
  proves: ["PAR-mpim"],
  run: async (ctx) => { … },
}
```

### Annotating a soak checker

A soak checker is a bare exported function; `CHECKERS` is a list of function references and there is
no definition object to put a field on. A parallel table would put the declaration somewhere other
than the checker, which is the one property that makes a declaration survive a refactor. So the
comment sits on the checker:

```ts
// proves: REPLY-06, REPLY-07
export function checkNoDoublePost(evidence: SoakInvariantEvidence): SoakInvariantFinding {
```

## The `Tested by` column is a declaration, not an answer

The inventory's own `Tested by` cell carries exactly two values:

- `?` — nothing declared. The derived answer, if there is one, comes from the matrix.
- `n/a: <reason>` — this row is out of scope, and here is why.

The reason is required. A bare `n/a` is refused, because an exemption nobody justified is an
exemption nobody revisits.

**The cell is never read as evidence of coverage.** That is the whole point: it is where a human
declares an exemption, and nowhere else.

## Pending is not exempt

`n/a: unannotated — lane F` is the seed reason. It marks a row nobody has annotated yet. The report
counts those rows as **pending** and prints them apart from a real exemption, because folding the
two together would report a tree as 98% settled when it is 98% unanswered.

Filling those cells is backlog work. Pick a row, find the test that already proves it, add the
annotation, and remove the `n/a` — the count moves from pending to covered.

## The matrix is a REPORT, not a ship condition

A ship is not gated on how full this matrix is. The release gate is the
board number. The matrix answers a different question — which behaviours have a proof and which do
not — and it answers it whether the tree is 3% joined or 100% joined.

The gate still holds one line: `lint:coverage-matrix` refuses a row with NO answer, so the ledger
cannot regress. That is a ratchet on the ledger, never a bar on the fill level.

No rung under `scripts/deploy/` reads this join, and `scripts/coverage-matrix-test.ts` asserts that
it stays that way — a ship rung that read the fill level would reverse the ruling silently.

## What the gate refuses

| Finding | What it means |
| --- | --- |
| `uncovered` | every cell empty, and no `n/a:` declaration. The row has no answer at all. |
| `stale-row-id` | a declaration names a row id no inventory table holds. The row was renamed or removed, and the declaration now proves nothing. |

It also refuses two shapes that would otherwise read as a perfectly covered tree: a scan that parses
no inventory row, and a scan that finds no declaration anywhere. Either one means the scanner broke,
not that the tree is clean.

## THE BOARD

`npm run coverage-board` prints two halves, and never combines them into one score — a tree can be
fully annotated and still ship red, and a pack can be all-green while most of the inventory has no
proof at all.

- **COVERAGE** — rows covered / n/a / pending / uncovered per inventory page. Static.
- **LEGS** — the last e2e pack's legs, green / red / not-run / declared gap per surface. Dynamic.

The launch surfaces (Slack, Notion, GitHub) take the headline line and Discord/Teams the second. Any
other surface lands on a third line rather than being dropped. The order is reporting, not severity:
a red on the second line is exactly as red as one on the first, and the board says so.

The leg half needs a pack's result. Pass one of:

```
npm run coverage-board -- --board <file>   # the table the e2e runner PRINTS
npm run coverage-board -- --legs <file>    # a BoardLeg[] JSON, for when one is written
```

The `--board` form is the one that works today. The e2e runner writes a single JSON per run,
`packages/core/scripts/e2e/results/e2e-timings-<iso>.json`, and it carries phase decomposition only
— no leg and no verdict. The leg verdicts exist as the `## Ship legs` table the runner prints, which
the shipper already copies into the ship report; save that output and point `--board` at it. Given
neither input, the board prints the coverage half and says the leg half was not supplied. It never
prints zeros, which would read as a clean pack.

## The files

| File | What it holds |
| --- | --- |
| `scripts/coverage-matrix-lib.ts` | the pure join: the table parse, the annotation grammar, the findings, the board's leg half |
| `scripts/coverage-scan-lib.ts` | the tree scan — finds the four inputs, so the gate and the board read the tree one way |
| `scripts/coverage-matrix.ts` | the generator and the gate (`--check`) |
| `scripts/coverage-board.ts` | THE BOARD printer |
| `scripts/coverage-matrix-test.ts` | the proving suite, over fixture trees |
