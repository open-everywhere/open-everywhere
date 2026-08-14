import assert from "node:assert/strict";
import { join } from "node:path";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

process.env.OE_SQLITE_PATH ??= join("/tmp", `oe-changed-relevant-map-test-${process.pid}.sqlite3`);

const { SCENARIOS } = await import("./e2e/scenarios.js");
const { CHANGED_RELEVANT_MAP, ALWAYS_RELEVANT, UNMAPPED_BY_DESIGN, relevantScenarios } = await import(
  "./e2e/changed-relevant-map.js"
);

const rosterIds = new Set(SCENARIOS.map((s) => s.id));
ok("the scenario roster is non-empty (a change here would make every check below vacuous)", rosterIds.size > 0);

const mappedIds = new Set<string>();
for (const area of CHANGED_RELEVANT_MAP) for (const id of area.scenarios) mappedIds.add(id);
for (const id of ALWAYS_RELEVANT) mappedIds.add(id);
for (const u of UNMAPPED_BY_DESIGN) mappedIds.add(u.id);

for (const id of mappedIds) {
  ok(`mapped scenario id "${id}" is a real roster id (not a typo/stale reference)`, rosterIds.has(id));
}

function coverage(ids: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  for (const id of ids) {
    const inArea = CHANGED_RELEVANT_MAP.some((a) => a.scenarios.includes(id));
    const inAlways = ALWAYS_RELEVANT.includes(id);
    const inUnmapped = UNMAPPED_BY_DESIGN.some((u) => u.id === id);
    if (!inArea && !inAlways && !inUnmapped) missing.push(id);
  }
  return missing;
}

const missing = coverage(rosterIds);
ok(
  `every roster scenario (${rosterIds.size}) is covered by an area, ALWAYS_RELEVANT, or UNMAPPED_BY_DESIGN` +
    (missing.length > 0 ? ` — MISSING: ${missing.join(", ")}` : ""),
  missing.length === 0,
);

const fakeMissing = coverage(new Set(["S-DOES-NOT-EXIST"]));
ok("coverage() correctly reports an unmapped id as missing (negative control)", fakeMissing.length === 1);

for (const u of UNMAPPED_BY_DESIGN) {
  ok(`UNMAPPED_BY_DESIGN entry ${u.id} carries a non-empty reason`, u.why.trim().length > 0);
}

const areaNames = new Set<string>();
for (const area of CHANGED_RELEVANT_MAP) {
  ok(`area "${area.area}" has a unique name`, !areaNames.has(area.area));
  areaNames.add(area.area);
  ok(`area "${area.area}" declares at least one glob`, area.globs.length > 0);
  ok(`area "${area.area}" maps to at least one scenario`, area.scenarios.length > 0);
  ok(`area "${area.area}" gives a non-empty reason`, area.why.trim().length > 0);
}

const discordOnly = relevantScenarios(["packages/providers/discord/agent/channels/discord-events.ts"]);
ok("a Discord-only change selects J-DISC", discordOnly.includes("J-DISC"));
ok("a Discord-only change does NOT select J-GH (github-only surface)", !discordOnly.includes("J-GH"));
ok("a Discord-only change does NOT select J-LIN (linear-only surface)", !discordOnly.includes("J-LIN"));

const linearOnly = relevantScenarios(["packages/providers/linear/agent/whatever.ts"]);
ok("a Linear-only change selects J-LIN", linearOnly.includes("J-LIN"));
ok("a Linear-only change does NOT select J-DISC (discord-only surface)", !linearOnly.includes("J-DISC"));

ok("ALWAYS_RELEVANT scenarios ride along on an unrelated change", ALWAYS_RELEVANT.every((id) => discordOnly.includes(id)));
const noChanges = relevantScenarios([]);
ok(
  "relevantScenarios([]) returns exactly ALWAYS_RELEVANT (no changed path ⇒ no area matches)",
  noChanges.length === ALWAYS_RELEVANT.length && ALWAYS_RELEVANT.every((id) => noChanges.includes(id)),
);

const unrelated = relevantScenarios(["README.md"]);
ok("an unrelated top-level file selects nothing beyond ALWAYS_RELEVANT", unrelated.length === ALWAYS_RELEVANT.length);

const awsOnly = relevantScenarios(["packages/core/agent/tools/aws.ts"]);
ok("the AWS tool file selects S-AWS-BOUNDARY", awsOnly.includes("S-AWS-BOUNDARY"));
const siblingTool = relevantScenarios(["packages/core/agent/tools/react.ts"]);
ok(
  "a SIBLING tool file (react.ts, not aws.ts itself) does NOT select S-AWS-BOUNDARY",
  !siblingTool.includes("S-AWS-BOUNDARY"),
);

console.log(`\n✓ changed-relevant map: ${n} assertions passed (${CHANGED_RELEVANT_MAP.length} areas, ${rosterIds.size} roster scenarios, ${UNMAPPED_BY_DESIGN.length} unmapped-by-design)\n`);
