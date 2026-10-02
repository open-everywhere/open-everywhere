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

const PREAMBLE = [
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
  "A `devDependencies` key that still reads `create-open-everywhere` is RENAMED to",
  "`@open-everywhere/create`, not bumped. Every app scaffolded at 0.1.3 or earlier carries the old",
  "key, and the unscoped name is retired: it publishes no further version.",
  "",
  "Read the entries between your installed version and your target, oldest first.",
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
  const lines: string[] = [...PREAMBLE];
  for (const release of notes.releases) {
    lines.push(`## ${release.version} — ${release.date}`, "", release.summary, "", `eve peer: \`${release.evePeer}\``, "");
    lines.push(...section("Breaking", release.breaking));
    lines.push(...section("Config migrations", migrationLines(release.configMigrations)));
    lines.push(...section("Environment", envLines(release.env)));
    lines.push(...section("Manual steps", release.manualSteps));
    if (release.breaking.length + release.configMigrations.length + release.env.added.length + release.env.removed.length + release.manualSteps.length === 0) {
      lines.push("No breaking change, no config migration, no env change and no manual step.", "");
    }
  }
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}
