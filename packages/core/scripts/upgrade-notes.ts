export const NOTES_FILE = "upgrading.json";
export const PAGE_FILE = "UPGRADING.md";

export interface ReleaseNote {
  readonly version: string;
  readonly date: string;
  readonly summary: string;
  readonly evePeer: string;
  readonly breaking: readonly string[];
  readonly configMigrations: readonly ConfigMigration[];
  readonly env: ReleaseEnvChange;
  readonly manualSteps: readonly string[];
  readonly removedFiles: readonly string[];
}

export interface ConfigMigration {
  readonly description: string;
  readonly codemod?: string;
}

export interface ReleaseEnvChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface UpgradingNotes {
  readonly schemaVersion: 1;
  readonly releases: readonly ReleaseNote[];
}

export interface ParsedNotes {
  readonly notes?: UpgradingNotes;
  readonly problems: readonly string[];
}

const VERSION = /^\d+\.\d+\.\d+$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
const CODEMOD_ID = /^[a-z0-9][a-z0-9-]*$/u;
const REL_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^/\\]+(?:\/[^/\\]+)*$/u;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(value: unknown, where: string, problems: string[]): string[] {
  if (!Array.isArray(value)) {
    problems.push(`${where}: expected an array of strings.`);
    return [];
  }
  const out: string[] = [];
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") problems.push(`${where}[${i}]: expected a non-empty string.`);
    else out.push(entry);
  }
  return out;
}

function parseMigrations(value: unknown, where: string, problems: string[]): ConfigMigration[] {
  if (!Array.isArray(value)) {
    problems.push(`${where}: expected an array of config migrations.`);
    return [];
  }
  const out: ConfigMigration[] = [];
  for (const [i, entry] of value.entries()) {
    const at = `${where}[${i}]`;
    if (!isRecord(entry)) {
      problems.push(`${at}: expected an object with a description.`);
      continue;
    }
    const description = entry.description;
    if (typeof description !== "string" || description.trim() === "") {
      problems.push(`${at}.description: expected a non-empty string.`);
      continue;
    }
    const codemod = entry.codemod;
    if (codemod === undefined) {
      out.push({ description });
      continue;
    }
    if (typeof codemod !== "string" || !CODEMOD_ID.test(codemod)) {
      problems.push(`${at}.codemod: expected a lower-case id like "pin-undici-overrides".`);
      continue;
    }
    out.push({ description, codemod });
  }
  return out;
}

function parseEnv(value: unknown, where: string, problems: string[]): ReleaseEnvChange {
  if (!isRecord(value)) {
    problems.push(`${where}: expected an object with "added" and "removed".`);
    return { added: [], removed: [] };
  }
  const added = stringList(value.added, `${where}.added`, problems);
  const removed = stringList(value.removed, `${where}.removed`, problems);
  for (const [field, names] of [
    ["added", added],
    ["removed", removed],
  ] as const) {
    for (const name of names) {
      if (!ENV_NAME.test(name)) problems.push(`${where}.${field}: "${name}" is not an env NAME — names are upper case, and a value never belongs here.`);
    }
  }
  return { added, removed };
}

function parseRelease(value: unknown, index: number, problems: string[]): ReleaseNote | undefined {
  const at = `releases[${index}]`;
  if (!isRecord(value)) {
    problems.push(`${at}: expected an object.`);
    return undefined;
  }
  const { version, date, summary, evePeer } = value;
  let bad = false;
  if (typeof version !== "string" || !VERSION.test(version)) {
    problems.push(`${at}.version: expected "x.y.z".`);
    bad = true;
  }
  if (typeof date !== "string" || !DATE.test(date)) {
    problems.push(`${at}.date: expected "YYYY-MM-DD".`);
    bad = true;
  }
  if (typeof summary !== "string" || summary.trim() === "") {
    problems.push(`${at}.summary: expected a non-empty one-line summary.`);
    bad = true;
  }
  if (typeof evePeer !== "string" || evePeer.trim() === "") {
    problems.push(`${at}.evePeer: expected the eve version core declares as its peer.`);
    bad = true;
  }
  const breaking = stringList(value.breaking, `${at}.breaking`, problems);
  const configMigrations = parseMigrations(value.configMigrations, `${at}.configMigrations`, problems);
  const env = parseEnv(value.env, `${at}.env`, problems);
  const manualSteps = stringList(value.manualSteps, `${at}.manualSteps`, problems);
  const removedFiles = value.removedFiles === undefined ? [] : stringList(value.removedFiles, `${at}.removedFiles`, problems);
  for (const path of removedFiles) {
    if (!REL_PATH.test(path)) problems.push(`${at}.removedFiles: "${path}" is not an app-relative path like "agent/instrumentation.ts".`);
  }
  if (bad) return undefined;
  return {
    version: version as string,
    date: date as string,
    summary: summary as string,
    evePeer: evePeer as string,
    breaking,
    configMigrations,
    env,
    manualSteps,
    removedFiles,
  };
}

export function parseUpgradingNotes(raw: unknown): ParsedNotes {
  const problems: string[] = [];
  if (!isRecord(raw)) return { problems: ["upgrading.json: expected a JSON object at the top level."] };
  if (raw.schemaVersion !== 1) problems.push(`schemaVersion: expected 1, got ${JSON.stringify(raw.schemaVersion)}.`);
  if (!Array.isArray(raw.releases)) return { problems: [...problems, "releases: expected an array."] };
  if (raw.releases.length === 0) problems.push("releases: the record is empty — every published version needs an entry.");

  const releases: ReleaseNote[] = [];
  for (const [i, entry] of raw.releases.entries()) {
    const parsed = parseRelease(entry, i, problems);
    if (parsed) releases.push(parsed);
  }

  const seen = new Set<string>();
  for (const r of releases) {
    if (seen.has(r.version)) problems.push(`releases: ${r.version} has more than one entry.`);
    seen.add(r.version);
  }
  for (let i = 1; i < releases.length; i++) {
    if (compareVersions(releases[i - 1]!.version, releases[i]!.version) <= 0) {
      problems.push(`releases: ${releases[i - 1]!.version} is listed before ${releases[i]!.version} — the record is newest first.`);
    }
  }

  if (problems.length > 0) return { problems };
  return { notes: { schemaVersion: 1, releases }, problems: [] };
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((p) => Number.parseInt(p, 10));
  const right = b.split(".").map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function noteFor(notes: UpgradingNotes, version: string): ReleaseNote | undefined {
  return notes.releases.find((r) => r.version === version);
}

export function notesBetween(notes: UpgradingNotes, installed: string, target: string): readonly ReleaseNote[] {
  return notes.releases
    .filter((r) => compareVersions(r.version, installed) > 0 && compareVersions(r.version, target) <= 0)
    .slice()
    .sort((a, b) => compareVersions(a.version, b.version));
}

export function codemodIdsIn(releases: readonly ReleaseNote[]): readonly string[] {
  const out: string[] = [];
  for (const release of releases) {
    for (const migration of release.configMigrations) {
      if (migration.codemod !== undefined && !out.includes(migration.codemod)) out.push(migration.codemod);
    }
  }
  return out;
}

export function removedFilesUpTo(notes: UpgradingNotes, target: string): readonly string[] {
  const out: string[] = [];
  for (const release of notes.releases) {
    if (compareVersions(release.version, target) > 0) continue;
    for (const path of release.removedFiles) if (!out.includes(path)) out.push(path);
  }
  return out;
}

export const BOOTSTRAP_PREFIX = ".open-everywhere/bootstrap";

export function bootstrapCommands(target: string): readonly [install: string, run: string] {
  return [
    `npm install --prefix ${BOOTSTRAP_PREFIX} @open-everywhere/core@${target} tsx@4`,
    `node ${BOOTSTRAP_PREFIX}/node_modules/@open-everywhere/core/bin/oe.js upgrade --to ${target}`,
  ];
}

const preamble = (newest: string): readonly string[] => [
  "# Upgrading Open Everywhere",
  "",
  "This page is GENERATED from `upgrading.json` beside it. A hand edit here is lost at the next",
  "regenerate. To change it, edit that file and run `npx tsx scripts/upgrading-notes-generate.ts`",
  "in the Open Everywhere repository; `npm run lint:upgrading-notes` there refuses a tree where the",
  "page and the record disagree.",
  "",
  "`npx oe upgrade` reads the same record. It bumps every `@open-everywhere/*` package together, pins",
  "`eve` to the target release's declared peer, installs, runs the config codemods the notes name,",
  "then `oe build --accept`, `npm run typecheck` and `npm run build`. `npx oe upgrade --plan` prints",
  "the plan and writes nothing.",
  "",
  "Before the install, `npx oe upgrade --plan` runs the INSTALLED core, and its record never holds",
  "the target's entry. So it cannot print the target's BREAKING, ENV and MANUAL lines, which are the",
  "steps to take before you deploy. Run the TARGET's own `oe` for the plan instead:",
  "`npx -p @open-everywhere/core@<target> oe upgrade --plan --to <target>`. A core after 0.3.0 reads",
  "its own record when the installed one has no entry for the target, so that command prints every",
  "entry you cross.",
  "",
  "Before the install, a core after 0.2.1 drops the `package-lock.json` entries of `eve`, of every",
  "`@open-everywhere/*` package and of every package that peers on one of them. npm then resolves",
  "that set again from the new pins. A core at 0.2.1 or earlier installs over the old lockfile, and",
  "npm exits ERESOLVE when the eve peer changes. Then run `rm package-lock.json && npm install`, and",
  "run `npx oe upgrade` again: it resumes. Read the lockfile diff before you commit it.",
  "",
  "The codemods run from the TARGET release's own registry, so a release can ship a codemod for its",
  "own upgrade. A core at 0.1.4 runs them from its OWN registry instead: after the install, it",
  "refuses a codemod a later release introduces. Run `npx oe upgrade` again: the target's own `oe`",
  "is installed by then, and it runs the codemod.",
  "",
  "A `devDependencies` key that still reads `create-open-everywhere` is RENAMED to",
  "`@open-everywhere/create`, not bumped. Every app scaffolded at 0.1.3 or earlier carries the old",
  "key, and the unscoped name is retired: it publishes no further version.",
  "",
  "A core that carries the template drift report prints it in `npx oe upgrade` and in `--plan`:",
  "every scaffolded file that differs from the target release's `@open-everywhere/create` template,",
  "with a one-line size of its diff. An upgrade never overwrites an app file. `npx oe upgrade` runs",
  "the INSTALLED core's code, so an upgrade from a core without the report prints none. Run",
  "`npx oe upgrade --plan --to <target>` once more after it: the target's own code then prints the",
  "report, even when there is nothing left to install. A stale template-owned file can typecheck and build and",
  "still break the deployment, so read each SYNC line and copy the target's file after you read the",
  "diff.",
  "",
  "A core after 0.2.1 also prints a DELETE line for each file that a release up to the target removed",
  "from the template, while the app still has it. A release names those files in its \"Removed",
  "template files\" list below. To mark a template file as the app's own, name it in",
  "`.oe-template-ignore` at the app root: one app-relative path per line, a trailing `/` for a",
  "directory, and `#` for a comment. The report prints nothing for an ignored file that the app does",
  "not have, and one `app-owned` line for an ignored file that it has. An ignored file never counts as",
  "a SYNC or a DELETE.",
  "",
  "An app with no `agent/access/pre-approval-rules.ts` (every app scaffolded before 0.2.1) is OFFERED the",
  "target template's starter pre-approval rules, in `npx oe upgrade` and in `--plan`. The upgrade",
  "never writes the file and never overwrites one you have. Without a bound rule the approval judge,",
  "shipped in `enforce`, has nothing to cite, so every gated act asks a person. To take the rules,",
  "read each one, copy the file, and bind it as the template's `agent/access/bundles.ts` does (the",
  "`approval-policy` bundle at org scope). An app that names the file in `.oe-template-ignore` is",
  "not offered it. A core without the offer prints none: run `npx oe upgrade --plan --to <target>`",
  "after the upgrade to see it.",
  "",
  "Read the entries between your installed version and your target, oldest first.",
  "",
  "## An app below 0.1.4",
  "",
  "An app scaffolded at 0.1.3 or earlier has no `oe upgrade`. The subcommand first shipped in 0.1.4,",
  "and the installed core ships no `upgrading.json`. Install the target core beside the app, in its",
  "gitignored `.open-everywhere/` directory, and run that core's `oe` from the app root:",
  "",
  "```sh",
  ...bootstrapCommands(newest),
  "```",
  "",
  "The run renames `create-open-everywhere`, bumps every pin, installs, and then reads the target's",
  "own record for every entry above your version. If the run stops at any step, run the second",
  "command again. The run resumes, and it keeps the version you started from. After a green run,",
  "delete `.open-everywhere/bootstrap`. From then on, `npx oe upgrade` is the command.",
  "",
  "Up to 0.1.5, the `oe` bin needs `tsx`. `npx -p` installs core into its own cache, where no `tsx`",
  "resolves, so `npx -p @open-everywhere/core@<version> oe upgrade` fails with 0.1.5 or earlier as",
  "the target. The first release after 0.1.5 ships a compiled `oe` bin that needs no `tsx`. With",
  "that release or a later one as the target, this one-liner is the bootstrap too:",
  "",
  "```sh",
  "npx -p @open-everywhere/core@<version> oe upgrade --to <version>",
  "```",
  "",
];

function section(title: string, lines: readonly string[]): readonly string[] {
  if (lines.length === 0) return [];
  return [`**${title}**`, "", ...lines.map((l) => `- ${l}`), ""];
}

function migrationLines(migrations: readonly ConfigMigration[]): readonly string[] {
  return migrations.map((m) => (m.codemod === undefined ? `${m.description} (apply by hand)` : `${m.description} (codemod \`${m.codemod}\`)`));
}

function envLines(env: ReleaseEnvChange): readonly string[] {
  return [...env.added.map((n) => `add \`${n}\``), ...env.removed.map((n) => `remove \`${n}\``)];
}

export function renderUpgradingMarkdown(notes: UpgradingNotes): string {
  const lines: string[] = [...preamble(notes.releases[0]!.version)];
  for (const release of notes.releases) {
    lines.push(`## ${release.version} — ${release.date}`, "", release.summary, "", `eve peer: \`${release.evePeer}\``, "");
    lines.push(...section("Breaking", release.breaking));
    lines.push(...section("Config migrations", migrationLines(release.configMigrations)));
    lines.push(...section("Environment", envLines(release.env)));
    lines.push(...section("Manual steps", release.manualSteps));
    lines.push(...section("Removed template files (delete each one the app still has)", release.removedFiles.map((p) => `\`${p}\``)));
    if (
      release.breaking.length + release.configMigrations.length + release.env.added.length + release.env.removed.length + release.manualSteps.length + release.removedFiles.length ===
      0
    ) {
      lines.push("No breaking change, no config migration, no env change and no manual step.", "");
    }
  }
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}
