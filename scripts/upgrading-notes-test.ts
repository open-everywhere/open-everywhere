import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTES_FILE,
  PAGE_FILE,
  bootstrapCommands,
  codemodIdsIn,
  compareVersions,
  noteFor,
  notesBetween,
  parseUpgradingNotes,
  renderUpgradingMarkdown,
  type ReleaseNote,
} from "../packages/core/scripts/upgrade-notes.js";
import { CODEMODS, codemodById, unknownCodemods } from "../packages/core/scripts/upgrade-codemods.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages", "core");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const release = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: "0.2.0",
  date: "2026-10-03",
  summary: "a release.",
  evePeer: "0.54.3",
  breaking: [],
  configMigrations: [],
  env: { added: [], removed: [] },
  manualSteps: [],
  ...over,
});
const record = (...releases: Record<string, unknown>[]): Record<string, unknown> => ({ schemaVersion: 1, releases });
const problemsOf = (raw: unknown): readonly string[] => parseUpgradingNotes(raw).problems;
const notesOf = (raw: unknown) => {
  const parsed = parseUpgradingNotes(raw);
  if (parsed.notes === undefined) throw new Error(`fixture did not parse: ${parsed.problems.join("; ")}`);
  return parsed.notes;
};

ok(problemsOf(record(release())).length === 0, "a well-formed record parses clean — the negative control for every rule below");
ok(parseUpgradingNotes(record(release())).notes !== undefined, "…and hands back the parsed record");

ok(notesOf(record(release())).releases[0]!.removedFiles.length === 0, "an entry with no removedFiles reads as an empty list — an older published record still parses");
ok(notesOf(record(release({ removedFiles: ["agent/instrumentation.ts"] }))).releases[0]!.removedFiles[0] === "agent/instrumentation.ts", "…and a listed path is kept");
ok(problemsOf(record(release({ removedFiles: ["/etc/passwd"] }))).some((p) => p.includes("removedFiles")), "🔴 an absolute removed path is refused");
ok(problemsOf(record(release({ removedFiles: "agent/instrumentation.ts" }))).some((p) => p.includes("removedFiles")), "a removedFiles that is not an array is refused");
ok(
  renderUpgradingMarkdown(notesOf(record(release({ removedFiles: ["agent/instrumentation.ts"] })))).includes("**Removed template files (delete each one the app still has)**\n\n- `agent/instrumentation.ts`"),
  "the page lists a release's removed template files",
);

ok(problemsOf("not an object").length === 1, "a non-object record is refused");
ok(problemsOf({ schemaVersion: 2, releases: [release()] }).some((p) => p.includes("schemaVersion")), "an unknown schemaVersion is refused");
ok(problemsOf({ schemaVersion: 1 }).some((p) => p.includes("releases")), "a record with no releases array is refused");
ok(problemsOf(record()).some((p) => p.includes("empty")), "🔴 an EMPTY record is refused — a record with no entries hides every release");

ok(problemsOf(record(release({ version: "0.2" }))).some((p) => p.includes("version")), "a version that is not x.y.z is refused");
ok(problemsOf(record(release({ version: "0.2.0-rc.1" }))).some((p) => p.includes("version")), "a pre-release version is refused — the comparison below assumes three numbers");
ok(problemsOf(record(release({ date: "02/10/2026" }))).some((p) => p.includes("date")), "a date that is not YYYY-MM-DD is refused");
ok(problemsOf(record(release({ summary: "  " }))).some((p) => p.includes("summary")), "an empty summary is refused");
ok(problemsOf(record(release({ evePeer: "" }))).some((p) => p.includes("evePeer")), "🔴 a missing eve peer is refused — the gate holds that field equal to the peer `oe upgrade` pins");

ok(problemsOf(record(release({ version: "0.2.0" }), release({ version: "0.2.0" }))).some((p) => p.includes("more than one entry")), "a duplicated version is refused");
ok(
  problemsOf(record(release({ version: "0.1.9" }), release({ version: "0.2.0" }))).some((p) => p.includes("newest first")),
  "🔴 a record listed oldest-first is refused — the renderer and the reader both assume newest first",
);
ok(problemsOf(record(release({ version: "0.2.0" }), release({ version: "0.1.9" }))).length === 0, "…and newest-first is clean (the negative control)");

ok(problemsOf(record(release({ env: { added: ["slack_token"], removed: [] } }))).some((p) => p.includes("env NAME")), "a lower-case env entry is refused");
ok(
  problemsOf(record(release({ env: { added: ["SLACK_BOT_TOKEN=xoxb-real"], removed: [] } }))).some((p) => p.includes("env NAME")),
  "🔴 an entry shaped like NAME=VALUE is refused — only NAMES belong in a tracked record",
);
ok(problemsOf(record(release({ env: { added: ["SLACK_BOT_TOKEN"], removed: ["OE_OLD_NAME"] } }))).length === 0, "…and plain upper-case names are clean");

ok(problemsOf(record(release({ configMigrations: [{ codemod: "x" }] }))).some((p) => p.includes("description")), "a config migration with no description is refused");
ok(problemsOf(record(release({ configMigrations: [{ description: "d", codemod: "Pin_Undici" }] }))).some((p) => p.includes("codemod")), "a codemod id that is not a lower-case slug is refused");
ok(problemsOf(record(release({ configMigrations: [{ description: "d", codemod: "pin-undici" }] }))).length === 0, "…and a lower-case slug is clean");
ok(problemsOf(record(release({ breaking: ["", "real"] }))).some((p) => p.includes("non-empty")), "an empty string in a list is refused");

ok(compareVersions("0.1.10", "0.1.9") > 0, "🔴 0.1.10 is NEWER than 0.1.9 — a lexical compare would call the tenth patch a downgrade");
ok(compareVersions("0.1.3", "0.1.3") === 0, "a version equals itself");
ok(compareVersions("0.2.0", "0.10.0") < 0, "the minor field compares numerically too");
ok(compareVersions("1.0.0", "0.99.99") > 0, "the major field wins");

const window3 = notesOf(record(release({ version: "0.1.4" }), release({ version: "0.1.3" }), release({ version: "0.1.2" }), release({ version: "0.1.1" })));
const crossed = notesBetween(window3, "0.1.1", "0.1.3");
ok(crossed.map((r) => r.version).join(",") === "0.1.2,0.1.3", "🔴 the window EXCLUDES the installed version and INCLUDES the target, oldest first");
ok(notesBetween(window3, "0.1.3", "0.1.3").length === 0, "an upgrade to the installed version crosses nothing");
ok(notesBetween(window3, "0.1.1", "0.1.9").length === 3, "a target past the last entry takes every entry above the installed one");
ok(noteFor(window3, "0.1.2")?.version === "0.1.2", "noteFor finds an entry");
ok(noteFor(window3, "9.9.9") === undefined, "noteFor reports a version the record does not hold");

const withCodemods = notesOf(
  record(
    release({ version: "0.3.0", configMigrations: [{ description: "b", codemod: "second" }] }),
    release({ version: "0.2.0", configMigrations: [{ description: "a", codemod: "first" }, { description: "a again", codemod: "first" }] }),
  ),
);
ok(codemodIdsIn([...withCodemods.releases].reverse()).join(",") === "first,second", "codemodIdsIn dedupes and keeps the order the notes give");
ok(unknownCodemods([...withCodemods.releases]).length === 2, "🔴 an id the registry does not hold is REPORTED, never skipped");
ok(unknownCodemods([...notesOf(record(release())).releases]).length === 0, "…and notes that name no codemod report nothing (the negative control)");
ok(CODEMODS.every((c) => codemodById(c.id) === c), "every registered codemod is reachable by its own id");
ok(new Set(CODEMODS.map((c) => c.id)).size === CODEMODS.length, "no two registered codemods share an id");

const rendered = renderUpgradingMarkdown(
  notesOf(
    record(
      release({
        version: "0.3.0",
        breaking: ["the seat tool was renamed"],
        configMigrations: [{ description: "add an override" }, { description: "pin undici", codemod: "pin-undici" }],
        env: { added: ["OE_NEW_NAME"], removed: ["OE_OLD_NAME"] },
        manualSteps: ["re-paste the Slack manifest"],
      }),
      release({ version: "0.2.0" }),
    ),
  ),
);
ok(rendered.startsWith("# Upgrading Open Everywhere\n"), "the page opens with its own title");
ok(rendered.includes("## 0.3.0 — 2026-10-03"), "every release gets a heading with its date");
ok(rendered.includes("the seat tool was renamed"), "a breaking change reaches the page");
ok(rendered.includes("add an override (apply by hand)"), "🔴 a migration with no codemod says so — the reader is the one who applies it");
ok(rendered.includes("pin undici (codemod `pin-undici`)"), "a migration with a codemod names it");
ok(rendered.includes("add `OE_NEW_NAME`") && rendered.includes("remove `OE_OLD_NAME`"), "both env directions reach the page");
ok(rendered.includes("re-paste the Slack manifest"), "a manual step reaches the page");
ok(rendered.includes("No breaking change, no config migration, no env change and no manual step."), "a release that needs nothing says so, rather than rendering an empty section");
ok(rendered.endsWith("\n") && !rendered.endsWith("\n\n"), "the page ends with exactly one newline");
ok(
  rendered.includes("## An app below 0.1.4\n") && rendered.includes(`\`\`\`sh\n${bootstrapCommands("0.3.0").join("\n")}\n\`\`\`\n`),
  "🔴 the page carries the bootstrap for an app below 0.1.4 as one command block, naming the NEWEST release",
);
ok(!rendered.includes("@open-everywhere/core@0.2.0"), "…and never an older release in the record (the negative control)");
ok(
  bootstrapCommands("0.3.0")[0] === "npm install --prefix .open-everywhere/bootstrap @open-everywhere/core@0.3.0 tsx@4",
  "🔴 the bootstrap installs tsx BESIDE the target core: the oe bin needs it, and core declares it only as a dev dependency",
);

const notesPath = join(CORE, NOTES_FILE);
ok(existsSync(notesPath), `packages/core/${NOTES_FILE} exists`);
const parsedRepo = parseUpgradingNotes(JSON.parse(readFileSync(notesPath, "utf8")));
ok(parsedRepo.notes !== undefined, `packages/core/${NOTES_FILE} parses clean — problems: ${parsedRepo.problems.join("; ")}`);
const repoNotes = parsedRepo.notes!;

const corePkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as {
  version: string;
  files?: string[];
  peerDependencies?: Record<string, string>;
};
const currentEntry = noteFor(repoNotes, corePkg.version);
ok(currentEntry !== undefined, `🔴 @open-everywhere/core is at ${corePkg.version} and the record holds an entry for it`);
ok(currentEntry?.evePeer === corePkg.peerDependencies?.eve, `the ${corePkg.version} entry's eve peer matches the one core declares`);
for (const file of [NOTES_FILE, PAGE_FILE]) {
  ok((corePkg.files ?? []).includes(file), `packages/core/package.json \`files\` lists ${file}, so npm packs it`);
}
ok(unknownCodemods(repoNotes.releases).length === 0, "every codemod this tree's record names is in the registry");

const page = existsSync(join(CORE, PAGE_FILE)) ? readFileSync(join(CORE, PAGE_FILE), "utf8") : undefined;
ok(page === renderUpgradingMarkdown(repoNotes), `🔴 packages/core/${PAGE_FILE} IS the rendering of ${NOTES_FILE} — a hand edit or a stale page goes red here`);

const newest: ReleaseNote | undefined = repoNotes.releases[0];
ok(newest !== undefined && compareVersions(newest.version, corePkg.version) >= 0, "the record's newest entry is not older than the package version");

console.log(`✓ upgrading notes: ${passed} assertions (${repoNotes.releases.length} release record(s), current ${corePkg.version}).`);
