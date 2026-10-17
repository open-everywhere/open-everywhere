import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT_CONTRACT } from "../packages/core/agent/ops/contract.js";
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

type SurfaceKind = "table" | "roster" | "slackScope" | "slackEvent" | "env" | "route" | "schedule";
type Surface = Readonly<Record<SurfaceKind, readonly string[]>>;

type Step = { readonly what: string } & ({ readonly says: (line: string) => boolean } | { readonly holds: (r: ReleaseNote, name: string) => boolean });
const envStep = (r: ReleaseNote, name: string): boolean => r.env.added.includes(name) || r.manualSteps.some((l) => l.includes(`\`${name}\``));
const slackManifest = (line: string): boolean => /slack[^.]*manifest|surface_manifest/i.test(line);
const STEP: Readonly<Record<SurfaceKind, Step>> = {
  table: { says: (l) => /owner/i.test(l) && l.includes("runtimeRoleGrantsSql"), what: "the owner boot and the `runtimeRoleGrantsSql` grants" },
  roster: { says: (l) => l.includes("oe build --accept"), what: "`oe build --accept`" },
  slackScope: { says: slackManifest, what: "a re-applied Slack manifest" },
  slackEvent: { says: slackManifest, what: "a re-applied Slack manifest" },
  env: { holds: envStep, what: "the name in its `env.added`, or a manual step that names it" },
  route: { says: (l) => /edge allowlist/i.test(l), what: "the edge allowlist step (\"Update an edge allowlist …\")" },
  schedule: { says: (l) => /cron budget/i.test(l), what: "the cron budget step (\"Update a cron budget …\")" },
};
const KINDS = Object.keys(STEP) as SurfaceKind[];

const BASELINE_SIZE: Readonly<Record<SurfaceKind, number>> = { table: 40, roster: 169, slackScope: 20, slackEvent: 8, env: 6, route: 51, schedule: 6 };

const linesOf = (r: ReleaseNote): readonly string[] => [r.summary, ...r.breaking, ...r.manualSteps, ...r.configMigrations.map((m) => m.description)];

function surfaceProblems(releases: readonly ReleaseNote[], surface: Surface, baseline: Surface, size: Readonly<Record<SurfaceKind, number>>): string[] {
  const entries = releases.map((r) => ({ release: r, version: r.version, lines: linesOf(r) }));
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
    const step = STEP[kind];
    for (const name of current) {
      if (exempt.has(name)) continue;
      if ("holds" in step) {
        if (!entries.some((e) => step.holds(e.release, name))) {
          problems.push(
            `no release entry in packages/core/${NOTES_FILE} holds the ${kind} name \`${name}\` in its \`env.added\` or names it in a manual step. Add it to the next release's \`env.added\` when every host needs it, else write a manual step that says when to set it.`,
          );
        }
        continue;
      }
      const tick = `\`${name}\``;
      const naming = entries.filter((e) => e.lines.some((l) => l.includes(tick)));
      if (naming.some((e) => e.lines.some((l) => l.includes(tick) && step.says(l)))) continue;
      problems.push(
        naming.length === 0
          ? `no release entry in packages/core/${NOTES_FILE} names the ${kind} \`${name}\`. Name it in the next release's entry, with ${step.what}.`
          : `no line that names the ${kind} \`${name}\` (in ${naming.map((e) => e.version).join(", ")}) carries ${step.what}.`,
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
const withEnv = (r: ReleaseNote, added: string[], removed: string[] = []): ReleaseNote => ({ ...r, env: { added, removed } });
const empty: Surface = { table: [], roster: [], slackScope: [], slackEvent: [], env: [], route: [], schedule: [] };
const only = (kind: SurfaceKind, names: string[]): Surface => ({ ...empty, [kind]: names });
const sizeOf = (b: Surface): Record<SurfaceKind, number> => Object.fromEntries(KINDS.map((k) => [k, b[k].length])) as Record<SurfaceKind, number>;
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
ok(
  check([note("0.8.0", "Set `OE_NEW_URL` before you deploy.")], only("env", ["OE_NEW_URL"]), empty).some((p) => p.includes("env.added")),
  "🔴 a new contract env name that no release's `env.added` holds is refused, even when a line names it",
);
ok(check([withEnv(note("0.8.0", "nothing"), ["OE_NEW_URL"])], only("env", ["OE_NEW_URL"]), empty).length === 0, "…and `env.added` that holds it is clean");
ok(
  check([withEnv(note("0.8.0", "nothing"), [], ["OE_NEW_URL"])], only("env", ["OE_NEW_URL"]), empty).length === 1,
  "an `env.removed` entry is not the add step",
);
ok(check([withEnv(note("0.8.0", "nothing"), ["OE_NEW_URL_2"])], only("env", ["OE_NEW_URL"]), empty).length === 1, "a longer env name does not count for a shorter one");
const withSteps = (r: ReleaseNote, ...manualSteps: string[]): ReleaseNote => ({ ...r, manualSteps });
ok(
  check([withSteps(note("0.8.0", "nothing"), "On Docker, set `OE_NEW_URL` before you deploy.")], only("env", ["OE_NEW_URL"]), empty).length === 0,
  "🔴 a manual step that names a conditional contract env name clears it (no unconditional `oe upgrade` ENV line)",
);
ok(
  check([withSteps(note("0.8.0", "nothing"), "On Docker, set OE_NEW_URL before you deploy.")], only("env", ["OE_NEW_URL"]), empty).length === 1,
  "a manual step must name the env name in backticks",
);
ok(
  check([note("0.8.0", "Core mounts `POST /x/v1/hook`.")], only("route", ["POST /x/v1/hook"]), empty).length === 1 &&
    check([note("0.8.0", "Account for the new route `POST /x/v1/hook`. Update an edge allowlist that lists routes.")], only("route", ["POST /x/v1/hook"]), empty).length === 0,
  "🔴 a new route needs the edge allowlist step in its line (and the step clears it)",
);
ok(
  check([note("0.8.0", "Account for `/x/v1/hook`. Update an edge allowlist.")], only("route", ["POST /x/v1/hook"]), empty).length === 1,
  "a route is named with its method: a bare path does not count",
);
ok(
  check([note("0.8.0", "Account for `GET /x/v1/hook`. Update an edge allowlist.")], only("route", ["POST /x/v1/hook"]), empty).length === 1,
  "another method's route does not count",
);
ok(
  check([note("0.8.0", "Core mounts `cover`. Update an edge allowlist.")], only("schedule", ["cover"]), empty).length === 1 &&
    check([note("0.8.0", "Account for the new schedule `cover`. Update a cron budget that lists schedules.")], only("schedule", ["cover"]), empty).length === 0,
  "🔴 a new schedule needs the cron budget step in its line (the route step does not count; the right step clears it)",
);
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
type Contribution = { readonly kind: string; readonly name: string; readonly module: string };
const manifests: { readonly dir: string; readonly contributions: readonly Contribution[] }[] = [];
for (const base of ["packages", join("packages", "providers")]) {
  for (const e of readdirSync(join(ROOT, base), { withFileTypes: true })) {
    const file = join(ROOT, base, e.name, "agent", "contributions.ts");
    if (!e.isDirectory() || !existsSync(file)) continue;
    const mod = (await import(file)) as { CONTRIBUTIONS: { contributions: readonly Contribution[] } };
    manifests.push({ dir: join(ROOT, base, e.name), contributions: mod.CONTRIBUTIONS.contributions });
  }
}
ok(manifests.some((m) => m.dir.endsWith(join("packages", "core"))), "core's contribution manifest is read");
const routes: string[] = [];
for (const m of manifests) {
  for (const c of m.contributions.filter((x) => x.kind === "channel")) {
    const file = join(m.dir, c.module.replace(/\.js$/u, ".ts"));
    ok(existsSync(file), `the channel \`${c.name}\` has its module at ${file}`);
    const mod = (await import(file)) as { default?: { readonly routes?: readonly { readonly method?: string; readonly path?: string }[] } };
    for (const r of mod.default?.routes ?? []) {
      if (typeof r.method === "string" && typeof r.path === "string") routes.push(`${r.method.toUpperCase()} ${r.path.length > 1 ? r.path.replace(/\/+$/u, "") : r.path}`);
    }
  }
}
const surface: Surface = {
  table: [...OPERATIONAL_TABLES],
  roster: [...new Set(Object.values(lock.packages).flatMap((p) => Object.keys(p.contributions)))],
  slackScope: [...new Set([...manifest.oauth_config.scopes.bot, ...(manifest.oauth_config.scopes.user ?? [])])],
  slackEvent: [...new Set(manifest.settings.event_subscriptions.bot_events)],
  env: [...new Set(DEPLOYMENT_CONTRACT.flatMap((r) => r.env ?? []))],
  route: [...new Set(routes)],
  schedule: [...new Set(manifests.flatMap((m) => m.contributions.filter((c) => c.kind === "schedule").map((c) => c.name)))],
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
