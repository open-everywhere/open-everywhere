import assert from "node:assert/strict";
import { join } from "node:path";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

process.env.OE_SQLITE_PATH = join("/tmp", `oe-changed-relevant-map-test-${process.pid}.sqlite3`);

const { SCENARIOS } = await import("./e2e/scenarios.js");
const { CHANGED_RELEVANT_MAP, ALWAYS_RELEVANT, LAUNCH_SURFACE_FLOOR, SMOKE_FLOOR, SPEND_CAP_FLOOR, UNMAPPED_BY_DESIGN, relevantScenarios } = await import(
  "./e2e/changed-relevant-map.js"
);

const rosterIds = new Set(SCENARIOS.map((s) => s.id));
ok("the scenario roster holds its floor (a collapse here would make every check below vacuous)", rosterIds.size >= 40);

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

let notionNotes = 0;
for (const area of CHANGED_RELEVANT_MAP) {
  if (!area.scenarios.includes("J-ENGAGED-notion") && !area.why.includes("J-ENGAGED-notion")) continue;
  notionNotes++;
  ok(
    `area "${area.area}" does not call a J-ENGAGED-notion red a "fixture fact" — the driver is declared, so a red there is a product defect (OPE-1846)`,
    !area.why.includes("fixture fact"),
  );
}
ok("at least one area's note is about J-ENGAGED-notion, so the wording check above really ran", notionNotes > 0);

const discordOnly = relevantScenarios(["packages/providers/discord/agent/channels/discord-events.ts"]);
ok("a Discord-only change selects J-DISC", discordOnly.includes("J-DISC"));
const githubArea = CHANGED_RELEVANT_MAP.find((a) => a.area === "github-provider")!;
ok(
  "a Discord-only change selects nothing from the github-provider area beyond the floor",
  githubArea.scenarios.filter((id) => discordOnly.includes(id)).every((id) => ALWAYS_RELEVANT.includes(id)),
);
ok("a Discord-only change does NOT select J-LIN (linear-only surface)", !discordOnly.includes("J-LIN"));

const linearOnly = relevantScenarios(["packages/providers/linear/agent/whatever.ts"]);
ok("a Linear-only change selects J-LIN", linearOnly.includes("J-LIN"));
ok("a Linear-only change does NOT select J-DISC (discord-only surface)", !linearOnly.includes("J-DISC"));

for (const [path, label] of [
  ["packages/providers/github/agent/channels/github.ts", "GitHub provider"],
  ["packages/providers/notion/agent/channels/notion-api.ts", "Notion provider"],
  ["agent/access/bundles.ts", "domain access binding"],
  ["agent/plugins/skill-content.ts", "notion-rest plugin skill"],
  ["packages/core/agent/access/egress.ts", "sandbox egress compiler"],
] as const) {
  ok(
    `${label} changes select S-GITHUB-NOTION-REST`,
    relevantScenarios([path]).includes("S-GITHUB-NOTION-REST"),
  );
}

const unrelatedPluginGenerated = relevantScenarios(["agent/plugins/generated/unrelated.ts"]);
ok(
  "an unrelated generated plugin file does NOT select S-GITHUB-NOTION-REST through an over-broad plugin glob",
  !unrelatedPluginGenerated.includes("S-GITHUB-NOTION-REST"),
);

ok("ALWAYS_RELEVANT scenarios ride along on an unrelated change", ALWAYS_RELEVANT.every((id) => discordOnly.includes(id)));
const noChanges = relevantScenarios([]);
ok(
  "relevantScenarios([]) returns exactly ALWAYS_RELEVANT (no changed path ⇒ no area matches)",
  noChanges.length === ALWAYS_RELEVANT.length && ALWAYS_RELEVANT.every((id) => noChanges.includes(id)),
);

const DRIVER = { github: "github", notion: "notionAmbient" } as const;
const legStartsOn = (s: { readonly surface: string; readonly requires: readonly string[] } | undefined, surface: keyof typeof DRIVER): boolean =>
  s !== undefined && s.surface === surface && s.requires.includes(DRIVER[surface]) && !s.requires.includes("slack");
const startsOn = (id: string, surface: keyof typeof DRIVER): boolean => legStartsOn(SCENARIOS.find((x) => x.id === id), surface);
for (const id of [...SMOKE_FLOOR, ...LAUNCH_SURFACE_FLOOR, ...SPEND_CAP_FLOOR]) {
  ok(`floor id ${id} is in ALWAYS_RELEVANT`, ALWAYS_RELEVANT.includes(id));
}
for (const id of ["J-GH", "J-ENGAGED-github", "J-NOT", "J-ENGAGED-notion"]) {
  ok(`${id} is on the launch-surface floor (OPE-2494)`, LAUNCH_SURFACE_FLOOR.includes(id));
}
ok("S10 is on the spend-cap floor (OPE-2503)", SPEND_CAP_FLOOR.includes("S10"));
for (const [paths, label] of [
  [[], "no changed path"],
  [["README.md"], "an unrelated top-level file"],
  [["packages/providers/discord/agent/channels/discord-events.ts"], "a Discord-only change"],
  [["packages/providers/slack/agent/channels/slack-events.ts"], "a Slack-only change"],
  [["packages/core/agent/memory/write-road.ts"], "a core memory change"],
] as const) {
  const picked = relevantScenarios(paths);
  for (const surface of ["github", "notion"] as const) {
    ok(`${label} starts at least one leg on ${surface} (OPE-2494)`, picked.some((id) => startsOn(id, surface)));
    ok(`${label} starts BOTH ${surface} floor legs, the mention leg and the engaged leg`, picked.filter((id) => LAUNCH_SURFACE_FLOOR.includes(id) && startsOn(id, surface)).length === 2);
  }
  ok(`${label} runs S10, the spend-cap refusal leg (OPE-2503)`, picked.includes("S10"));
}
ok("negative control: a leg labelled github that requires the Slack driver does not start on GitHub", !legStartsOn({ surface: "github", requires: ["github", "slack"] }, "github"));
ok("negative control: S-NOTION-WRITE (labelled notion, started in Slack) does not start on Notion", !startsOn("S-NOTION-WRITE", "notion"));
ok("positive control: J-GH starts on GitHub and J-NOT starts on Notion", startsOn("J-GH", "github") && startsOn("J-NOT", "notion"));

const beyondFloor = (ids: string[]) => ids.filter((id) => !ALWAYS_RELEVANT.includes(id));
for (const path of [
  "packages/providers/slack/agent/channels/slack-memory-canvas.ts",
  "packages/core/agent/memory/write-road.ts",
  "packages/core/agent/memory/visible.ts",
  "packages/core/agent/channels/slack-canvas-list.ts",
]) {
  ok(`${path} selects S-MEMORY-CANVAS`, beyondFloor(relevantScenarios([path])).includes("S-MEMORY-CANVAS"));
}
ok("S-MEMORY-CANVAS is NOT on the floor (it is a diff-selected leg)", !ALWAYS_RELEVANT.includes("S-MEMORY-CANVAS"));
ok(
  "a canvas-only change does not select S-APP-HOME (S-APP-HOME never reads a canvas)",
  !relevantScenarios(["packages/providers/slack/agent/channels/slack-memory-canvas.ts"]).includes("S-APP-HOME"),
);
const homeOnly = relevantScenarios(["packages/providers/slack/agent/channels/slack-home.ts"]);
ok("negative control: a Home-tab file selects S-APP-HOME", homeOnly.includes("S-APP-HOME"));
const coreHomeOnly = relevantScenarios(["packages/core/agent/home/memory-home.ts"]);
ok("negative control: a core Home-tab file does NOT select S-MEMORY-CANVAS", !coreHomeOnly.includes("S-MEMORY-CANVAS"));

const unrelated = relevantScenarios(["README.md"]);
ok("an unrelated top-level file selects nothing beyond ALWAYS_RELEVANT", unrelated.length === ALWAYS_RELEVANT.length);

const awsOnly = relevantScenarios(["packages/core/agent/tools/aws.ts"]);
ok("the AWS tool file selects S-AWS-BOUNDARY", awsOnly.includes("S-AWS-BOUNDARY"));
const siblingTool = relevantScenarios(["packages/core/agent/tools/react.ts"]);
ok(
  "a SIBLING tool file (react.ts, not aws.ts itself) does NOT select S-AWS-BOUNDARY",
  !siblingTool.includes("S-AWS-BOUNDARY"),
);

const taskWakeOnly = relevantScenarios(["packages/core/agent/channels/task-wake.ts"]);
const dispatchOriginOnly = relevantScenarios(["packages/core/agent/access/dispatch-origin-signal.ts"]);
const settlementFlushOnly = relevantScenarios(["packages/core/agent/hooks/settlement-flush.ts"]);
const beyondAlways = (ids: string[]) => ids.filter((id) => !ALWAYS_RELEVANT.includes(id));

ok(
  "task-wake.ts routes to a live scenario beyond ALWAYS_RELEVANT",
  beyondAlways(taskWakeOnly).length > 0,
);
ok(
  "dispatch-origin-signal.ts routes to a live scenario beyond ALWAYS_RELEVANT",
  beyondAlways(dispatchOriginOnly).length > 0,
);
ok(
  "settlement-flush.ts routes to a live scenario beyond ALWAYS_RELEVANT",
  beyondAlways(settlementFlushOnly).length > 0,
);
ok(
  "S-DELEGATED-slack (a live delegated-worker leg; S-TAINT-ROUTE-LIVE held this pin until OPE-2726 removed it) covers all three delegation-identity paths",
  taskWakeOnly.includes("S-DELEGATED-slack") &&
    dispatchOriginOnly.includes("S-DELEGATED-slack") &&
    settlementFlushOnly.includes("S-DELEGATED-slack"),
);

const siblingHook = relevantScenarios(["packages/core/agent/hooks/memory.ts"]);
ok(
  "a sibling hook file (memory.ts, not settlement-flush.ts) does NOT pick up S-DELEGATED-slack via delegation-identity",
  !siblingHook.includes("S-DELEGATED-slack"),
);

console.log(`\n✓ changed-relevant map: ${n} assertions passed (${CHANGED_RELEVANT_MAP.length} areas, ${rosterIds.size} roster scenarios, ${UNMAPPED_BY_DESIGN.length} unmapped-by-design)\n`);
