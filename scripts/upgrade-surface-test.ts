import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONAL_TABLES } from "../packages/core/agent/operational/store.js";
import { NOTES_FILE, parseUpgradingNotes, type ReleaseNote } from "../packages/core/scripts/upgrade-notes.js";
import { slackAppManifestTemplate } from "../packages/providers/slack/agent/app-manifest.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = "scripts/upgrade-surface-baseline.json";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

type SurfaceKind = "table" | "roster" | "slackScope" | "slackEvent";
type Surface = Readonly<Record<SurfaceKind, readonly string[]>>;

const slackManifest = (line: string): boolean => /slack[^.]*manifest|surface_manifest/i.test(line);
const STEP: Readonly<Record<SurfaceKind, { readonly says: (line: string) => boolean; readonly what: string }>> = {
  table: { says: (l) => /owner/i.test(l) && l.includes("runtimeRoleGrantsSql"), what: "the owner boot and the `runtimeRoleGrantsSql` grants" },
  roster: { says: (l) => l.includes("oe build --accept"), what: "`oe build --accept`" },
  slackScope: { says: slackManifest, what: "a re-applied Slack manifest" },
  slackEvent: { says: slackManifest, what: "a re-applied Slack manifest" },
};
const KINDS = Object.keys(STEP) as SurfaceKind[];

const BASELINE_SIZE: Readonly<Record<SurfaceKind, number>> = { table: 40, roster: 169, slackScope: 20, slackEvent: 8 };

const linesOf = (r: ReleaseNote): readonly string[] => [r.summary, ...r.breaking, ...r.manualSteps, ...r.configMigrations.map((m) => m.description)];

function surfaceProblems(releases: readonly ReleaseNote[], surface: Surface, baseline: Surface, size: Readonly<Record<SurfaceKind, number>>): string[] {
  const entries = releases.map((r) => ({ version: r.version, lines: linesOf(r) }));
  const problems: string[] = [];
  for (const kind of KINDS) {
    const current = new Set(surface[kind]);
    const exempt = new Set(baseline[kind]);
    if (exempt.size !== baseline[kind].length) problems.push(`${BASELINE_FILE} lists a ${kind} name twice.`);
    if (baseline[kind].length !== size[kind]) {
      problems.push(
        baseline[kind].length > size[kind]
          ? `${BASELINE_FILE} holds ${baseline[kind].length} ${kind} names, over its pinned size of ${size[kind]}. A new name never enters the baseline: write its upgrade step.`
          : `${BASELINE_FILE} holds ${baseline[kind].length} ${kind} names, under its pinned size of ${size[kind]}. A name left the baseline: lower BASELINE_SIZE.${kind} to ${baseline[kind].length} in scripts/upgrade-surface-test.ts.`,
      );
    }
    for (const name of exempt) {
      if (!current.has(name)) problems.push(`${BASELINE_FILE} lists the ${kind} name \`${name}\`, and the tree no longer has it. Delete it from the baseline, and lower BASELINE_SIZE.${kind} by one.`);
    }
    for (const name of current) {
      if (exempt.has(name)) continue;
      const tick = `\`${name}\``;
      const naming = entries.filter((e) => e.lines.some((l) => l.includes(tick)));
      if (naming.some((e) => e.lines.some((l) => l.includes(tick) && STEP[kind].says(l)))) continue;
      problems.push(
        naming.length === 0
          ? `no release entry in packages/core/${NOTES_FILE} names the ${kind} \`${name}\`. Name it in the next release's entry, with ${STEP[kind].what}.`
          : `no line that names the ${kind} \`${name}\` (in ${naming.map((e) => e.version).join(", ")}) carries ${STEP[kind].what}.`,
      );
    }
  }
  return problems;
}

const note = (version: string, ...breaking: string[]): ReleaseNote => ({
  version,
  date: "2026-10-14",
  summary: "a release.",
  evePeer: "0.71.0",
  breaking,
  configMigrations: [],
  env: { added: [], removed: [] },
  manualSteps: [],
  removedFiles: [],
});
const empty: Surface = { table: [], roster: [], slackScope: [], slackEvent: [] };
const only = (kind: SurfaceKind, names: string[]): Surface => ({ ...empty, [kind]: names });
const sizeOf = (b: Surface): Record<SurfaceKind, number> => ({ table: b.table.length, roster: b.roster.length, slackScope: b.slackScope.length, slackEvent: b.slackEvent.length });
const check = (releases: readonly ReleaseNote[], surface: Surface, baseline: Surface, size = sizeOf(baseline)): string[] => surfaceProblems(releases, surface, baseline, size);
const GRANTS = "Run one owner boot, then `runtimeRoleGrantsSql`.";

ok(check([note("0.8.0", "nothing")], empty, empty).length === 0, "an empty surface needs nothing — the negative control for every refusal below");
ok(
  check([note("0.8.0", "nothing")], only("table", ["cover"]), empty).some((p) => p.includes("names the table `cover`")),
  "🔴 a new table that no entry names is refused",
);
ok(
  check([note("0.8.0", "The store gains `cover`.")], only("table", ["cover"]), empty).some((p) => p.includes("carries")),
  "🔴 an entry that names a new table without the grants step is refused",
);
ok(check([note("0.8.0", `The store gains \`cover\`. ${GRANTS}`)], only("table", ["cover"]), empty).length === 0, "…and a line that names it with the grants step is clean");
ok(
  check([note("0.8.0", "The store gains `cover`.", `The store gains \`watch\`. ${GRANTS}`)], only("table", ["cover"]), empty).length === 1,
  "🔴 the step must sit in the line that names the table: the next bullet's grants do not count",
);
ok(
  check([note("0.8.0", "The store gains `cover`. Run `runtimeRoleGrantsSql`.")], only("table", ["cover"]), empty).length === 1,
  "the grants without the owner boot are refused",
);
ok(check([note("0.8.0", `The store gains cover. ${GRANTS}`)], only("table", ["cover"]), empty).length > 0, "a bare word is not a name: the table must be in backticks");
ok(check([note("0.8.0", `The store gains \`cover_recap\`. ${GRANTS}`)], only("table", ["cover"]), empty).length > 0, "a longer name does not count for a shorter one");
ok(
  check([note("0.8.0", "Core offers `tool/x`.")], only("roster", ["tool/x"]), empty).length === 1 &&
    check([note("0.8.0", "Core offers `tool/x`. Run `npx oe build --accept`.")], only("roster", ["tool/x"]), empty).length === 0,
  "🔴 a new roster name needs `oe build --accept` in its line (and the step clears it)",
);
ok(
  check([note("0.8.0", "Subscribe `e_one`.")], only("slackEvent", ["e_one"]), empty).length === 1 &&
    check([note("0.8.0", "Re-apply the Slack manifest: `e_one`.")], only("slackEvent", ["e_one"]), empty).length === 0,
  "🔴 a new Slack event needs the Slack manifest step in its line (and the step clears it)",
);
ok(
  check([note("0.8.0", "Add `s:one`.")], only("slackScope", ["s:one"]), empty).length === 1 &&
    check([note("0.8.0", "Run `surface_manifest` and paste it: `s:one`.")], only("slackScope", ["s:one"]), empty).length === 0,
  "🔴 a new Slack scope needs the Slack manifest step in its line (and the step clears it)",
);
ok(
  check([note("0.8.0", "The GitHub App manifest gains `s:one`.")], only("slackScope", ["s:one"]), empty).length === 1,
  "another surface's manifest is not the Slack manifest step",
);
ok(
  check([note("0.8.0", "Paste the Slack manifest: `s:one`."), note("0.7.0", "Core offers `s:one`.")], only("slackScope", ["s:one"]), empty).length === 0,
  "one line anywhere in the record that names the scope with its step is enough",
);
ok(check([note("0.8.0", "nothing")], only("table", ["old"]), only("table", ["old"])).length === 0, "a baseline name needs no entry");
ok(
  check([note("0.8.0", "nothing")], empty, only("table", ["gone"])).some((p) => p.includes("no longer has it")),
  "🔴 a retired name must leave the baseline",
);
ok(check([note("0.8.0", "nothing")], only("table", ["old"]), only("table", ["old", "old"])).some((p) => p.includes("twice")), "a baseline name listed twice is refused");
const events = ["e_0", "e_1", "e_2"];
const pinTwo = { ...sizeOf(empty), slackEvent: 2 };
ok(
  check([note("0.8.0", "nothing")], only("slackEvent", events), only("slackEvent", events), pinTwo).some((p) => p.includes("over its pinned size")),
  "🔴 the baseline is shrink-only: a list over its pinned size is refused, so a new name cannot hide there",
);
ok(
  check([note("0.8.0", "nothing")], only("slackEvent", events.slice(1)), only("slackEvent", events.slice(1)), pinTwo).length === 0,
  "…and a list at its pinned size is clean (the negative control)",
);
ok(
  check([note("0.8.0", "nothing")], only("slackEvent", events.slice(2)), only("slackEvent", events.slice(2)), pinTwo).some((p) => p.includes("under its pinned size")),
  "🔴 a list under its pinned size is refused: a retired name's room cannot later hold a new name unseen",
);

const parsed = parseUpgradingNotes(JSON.parse(readFileSync(join(ROOT, "packages", "core", NOTES_FILE), "utf8")));
ok(parsed.notes !== undefined, `packages/core/${NOTES_FILE} parses clean — problems: ${parsed.problems.join("; ")}`);

const lock = JSON.parse(readFileSync(join(ROOT, "packages", "create", "template", "roster.lock.json"), "utf8")) as {
  packages: Record<string, { contributions: Record<string, string> }>;
};
const manifest = JSON.parse(slackAppManifestTemplate({ personalMcp: true })) as {
  oauth_config: { scopes: { bot: string[]; user?: string[] } };
  settings: { event_subscriptions: { bot_events: string[] } };
};
const surface: Surface = {
  table: [...OPERATIONAL_TABLES],
  roster: [...new Set(Object.values(lock.packages).flatMap((p) => Object.keys(p.contributions)))],
  slackScope: [...new Set([...manifest.oauth_config.scopes.bot, ...(manifest.oauth_config.scopes.user ?? [])])],
  slackEvent: [...new Set(manifest.settings.event_subscriptions.bot_events)],
};
for (const kind of KINDS) ok(surface[kind].length > 0, `the tree's ${kind} list is not empty — an empty list would pass the rule with nothing checked`);

const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_FILE), "utf8")) as Surface;
for (const kind of KINDS) ok(Array.isArray(baseline[kind]), `${BASELINE_FILE} has a "${kind}" list`);

const problems = surfaceProblems(parsed.notes!.releases, surface, baseline, BASELINE_SIZE);
if (problems.length > 0) {
  console.error(`✗ upgrade surface: ${problems.length} name(s) an upgrading host must act on have no step in the release record.`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
passed++;

console.log(
  `✓ upgrade surface: ${passed} assertions — ${KINDS.map((k) => `${surface[k].length} ${k}`).join(", ")}; ${KINDS.reduce((n, k) => n + baseline[k].length, 0)} baseline name(s).`,
);
