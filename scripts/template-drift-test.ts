import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runUpgradeCommand, type UpgradeIo, type UpgradeRegistry } from "../packages/core/scripts/oe-upgrade.js";
import {
  TEMPLATE_IGNORE_FILE,
  TEMPLATE_RENAMED_ON_COPY,
  driftCounts,
  isTemplateIgnored,
  lineDiffSummary,
  parseTemplateIgnore,
  scaffoldedPathOf,
  templateDrift,
  templateFileKind,
} from "../packages/core/scripts/template-drift.js";
import { parseUpgradingNotes, removedFilesUpTo } from "../packages/core/scripts/upgrade-notes.js";
import { RENAMED_ON_COPY, scaffoldApp, scaffoldPathFor, listFiles } from "../packages/create/src/scaffold.js";
import { parseTemplatePaths, readTemplatePathInputs, renderTemplatePaths, templatePathProblems } from "./template-paths.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(REPO, "packages/create/template");
const FROM = "0.1.2";
const TARGET = "0.1.4";
const CORE = "@open-everywhere/core";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}

ok(JSON.stringify(TEMPLATE_RENAMED_ON_COPY) === JSON.stringify(RENAMED_ON_COPY), "🔴 core's copy of the scaffold rename map equals @open-everywhere/create's RENAMED_ON_COPY");
for (const rel of listFiles(TEMPLATE)) {
  ok(scaffoldedPathOf(rel) === scaffoldPathFor(rel), `core maps template path ${rel} to the scaffold's own path`);
}

ok(templateFileKind("agent/lib/register-adapters.ts") === "owned", "register-adapters.ts is template-owned");
ok(templateFileKind("scripts/ops-mcp.ts") === "owned", "ops-mcp.ts is template-owned");
ok(templateFileKind("scripts/env-pipe.mjs") === "owned", "env-pipe.mjs is template-owned");
ok(templateFileKind("docker-compose.yml") === "config", "docker-compose.yml is the app's own config (OPE-2405): an operator edits it for a managed Postgres");
ok(templateFileKind("Dockerfile") === "owned" && templateFileKind("deploy/egress-proxy/squid.conf") === "owned", "the Dockerfile and the egress proxy are template-owned");
ok(templateFileKind("AGENTS.md") === "owned" && templateFileKind("README.md") === "owned" && templateFileKind(".env.example") === "owned", "AGENTS.md, README.md and .env.example are template-owned");
ok(templateFileKind(".claude/skills/quickstart-open-everywhere/SKILL.md") === "owned", "the skills are template-owned");
ok(templateFileKind("roster.config.ts") === "config" && templateFileKind("agent/access/bundles.ts") === "config" && templateFileKind("agent/instructions.md") === "config", "the app's config-as-code is config");
ok(templateFileKind("package.json") === "managed" && templateFileKind("roster.lock.json") === "managed" && templateFileKind("agent/access/grants.generated.ts") === "managed", "tool-written files are managed");
ok(templateFileKind("scripts/goldens/roster-plan.txt") === "managed", "the roster golden is managed: `oe build` writes it, so an app's own roster never reads as drift (OPE-2399)");
ok(lineDiffSummary("a\nb\n", "a\nb\nc\n") === "the template adds 1 and drops 0 line(s), first at line 3", "an appended line counts as one added, at the line it lands on");
ok(lineDiffSummary("a\nold\nc\n", "a\nnew\nnew2\nc\n") === "the template adds 2 and drops 1 line(s), first at line 2", "a changed line counts as one removed and its replacements as added");
ok(lineDiffSummary("a\r\nb\r\n", "a\nb\n").startsWith("the template adds 0 and drops 0"), "a CRLF checkout does not read as a rewrite");

const WIRING_012 = [
  "// Adapter selection — the app's choice of vendor implementations, wired at startup.",
  'import { registerNeon } from "@open-everywhere/adapters/agent/postgres/neon.js";',
  "",
  "// Neon (hosted Postgres) is LIVE-ONLY — only wire it when a Postgres provider is",
  "// actually selected AND a DATABASE_URL exists.",
  "if (",
  '  (process.env.OE_MEMORY_PROVIDER === "postgres" || process.env.OE_OPERATIONAL_PROVIDER === "postgres") &&',
  "  process.env.DATABASE_URL",
  ") {",
  "  await registerNeon();",
  "}",
  "",
].join("\n");

function app012(): string {
  const parent = mkdtempSync(join(tmpdir(), "oe-drift-"));
  const { dir } = scaffoldApp({ targetDir: join(parent, "upgraded-app"), version: FROM, eol: "\n" });
  const adapters = join(dir, "agent/lib/register-adapters.ts");
  assert.ok(readFileSync(adapters, "utf8").includes("registerDefaultAdapters("), "fixture: the template's wiring is the one-call file this suite replaces");
  writeFileSync(adapters, WIRING_012);
  rmSync(join(dir, "agent/lib/register-docs.ts"));
  writeFileSync(join(dir, "agent/instructions.md"), `${readFileSync(join(dir, "agent/instructions.md"), "utf8")}\nOur team's own rule.\n`);
  const core = join(dir, "node_modules/@open-everywhere/core");
  mkdirSync(join(core, "bin"), { recursive: true });
  writeFileSync(join(core, "package.json"), JSON.stringify({ name: CORE, version: FROM, bin: { oe: "./bin/oe.js" } }));
  writeFileSync(join(core, "bin/oe.js"), "// fixture bin\n");
  return dir;
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of listFiles(dir)) {
    if (rel.startsWith("node_modules/") || rel.startsWith(".open-everywhere/") || rel === "package.json") continue;
    out.set(rel, readFileSync(join(dir, rel), "utf8"));
  }
  return out;
}

function harness(registry: Partial<UpgradeRegistry>, onRun: (args: readonly string[]) => void = () => {}): { io: UpgradeIo; out: string[]; calls: string[] } {
  const out: string[] = [];
  const calls: string[] = [];
  return {
    out,
    calls,
    io: {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      run: (_command, args) => {
        const argv = args[0]?.endsWith("npm-cli.js") ? args.slice(1) : args;
        calls.push(argv.join(" "));
        onRun(argv);
        return 0;
      },
      dockerDaemonDown: () => undefined,
      registry: { latestVersion: async () => TARGET, evePeer: async () => "0.54.3", ...registry },
    },
  };
}

function assertReport(text: string, where: string): void {
  ok(text.includes("Template drift (against 0.1.4's @open-everywhere/create template"), `${where}: the drift report names the TARGET's template`);
  ok(/SYNC {6}agent\/lib\/register-adapters\.ts — the template adds \d+ and drops \d+ line\(s\), first at line \d+/u.test(text), `🔴 ${where}: the stale register-adapters.ts is listed to SYNC, with a one-line diff summary`);
  ok(text.includes("SYNC      agent/lib/register-docs.ts — the template has it, the app does not"), `${where}: a template-owned file the app lacks is listed`);
  ok(/config {4}agent\/instructions\.md — the template adds 0 and drops 2 line\(s\)/u.test(text), `${where}: an edited config file is listed apart, as config`);
  ok(!/SYNC {6}agent\/instructions\.md/u.test(text), `${where}: an edited config file is never listed to SYNC`);
  ok(!/(SYNC|config) {4,6}(package\.json|roster\.lock\.json|\S+\.generated\.ts)/u.test(text), `${where}: managed files are never reported`);
  ok(!/SYNC {6}(scripts\/ops-mcp\.ts|AGENTS\.md|\.env\.example)/u.test(text), `🔴 NEGATIVE CONTROL ${where}: a template-owned file that matches the target is NOT listed`);
  ok(text.includes("2 template-owned file(s) differ from 0.1.4's template"), `${where}: the report counts the template-owned files that differ`);
  ok(text.includes("oe upgrade never overwrites an app file"), `${where}: the report says it overwrites nothing`);
}

{
  const dir = app012();
  const before = snapshot(dir);
  const pkgBefore = readFileSync(join(dir, "package.json"), "utf8");
  const asked: string[] = [];
  const h = harness({ templateDir: async (v) => (asked.push(v), TEMPLATE) });
  ok((await runUpgradeCommand(["--plan"], h.io, dir)) === 0, "--plan exits 0 over a drifted app");
  ok(asked.length === 1 && asked[0] === TARGET, "--plan asks the registry for the TARGET's template, because the installed scaffolder is older");
  assertReport(h.out.join("\n"), "--plan");
  ok(h.calls.length === 0, "--plan spawns nothing");
  ok(readFileSync(join(dir, "package.json"), "utf8") === pkgBefore, "--plan leaves package.json unchanged");
  ok(JSON.stringify([...snapshot(dir)]) === JSON.stringify([...before]), "🔴 --plan writes no app file");

  const blind = harness({});
  ok((await runUpgradeCommand(["--plan"], blind.io, dir)) === 0, "--plan with no template source still exits 0");
  ok(blind.out.join("\n").includes("the template drift check did not run"), "🔴 a template it cannot read is SAID, never reported as no drift");
}

{
  const dir = app012();
  const before = snapshot(dir);
  const install = (args: readonly string[]): void => {
    if (args[0] !== "install") return;
    const core = join(dir, "node_modules/@open-everywhere/core");
    writeFileSync(join(core, "package.json"), JSON.stringify({ name: CORE, version: TARGET, bin: { oe: "./bin/oe.js" } }));
    const create = join(dir, "node_modules/@open-everywhere/create");
    mkdirSync(create, { recursive: true });
    writeFileSync(join(create, "package.json"), JSON.stringify({ name: "@open-everywhere/create", version: TARGET }));
    cpSync(TEMPLATE, join(create, "template"), { recursive: true });
  };
  const h = harness({ templateDir: async () => assert.fail("the apply path reads the installed template, never the registry") }, install);
  ok((await runUpgradeCommand([], h.io, dir)) === 0, "the upgrade of the 0.1.2-shape app exits 0");
  const text = h.out.join("\n");
  assertReport(text, "apply");
  ok(text.includes(join(dir, "node_modules/@open-everywhere/create/template")), "the apply path points the operator at the installed template to diff against");
  ok(text.includes("SYNC: 2 template-owned file(s) differ from 0.1.4's template"), "the final lines repeat the count, where the operator acts");
  ok(text.indexOf("Template drift") < text.indexOf("✓ oe upgrade: 0.1.2 → 0.1.4."), "the report prints before the run's last line");
  ok(JSON.stringify([...snapshot(dir)]) === JSON.stringify([...before]), "🔴 the upgrade writes no scaffolded app file — register-adapters.ts keeps its stale bytes");
}

{
  const dir = app012();
  const pkgPath = join(dir, "package.json");
  writeFileSync(pkgPath, readFileSync(pkgPath, "utf8").split(`"${FROM}"`).join(`"${TARGET}"`));
  writeFileSync(join(dir, "node_modules/@open-everywhere/core/package.json"), JSON.stringify({ name: CORE, version: TARGET, bin: { oe: "./bin/oe.js" } }));
  const h = harness({ templateDir: async () => TEMPLATE });
  ok((await runUpgradeCommand(["--plan"], h.io, dir)) === 0, "--plan on an app already on the target exits 0");
  const text = h.out.join("\n");
  ok(text.includes("Nothing to do."), "the fixture is the up-to-date case");
  ok(text.includes("SYNC      agent/lib/register-adapters.ts"), "🔴 --plan on an up-to-date app still lists the stale register-adapters.ts");
  ok(h.calls.length === 0, "and still spawns nothing");

  rmSync(join(dir, "agent/instructions.md"));
  mkdirSync(join(dir, "agent/instructions.md"));
  const broken = harness({ templateDir: async () => TEMPLATE });
  ok((await runUpgradeCommand(["--plan"], broken.io, dir)) === 0, "a drift check that cannot read a file never fails the run");
  ok(broken.out.join("\n").includes("! the template drift check did not run: agent/instructions.md:"), "🔴 …and it says the check did not run, naming the file, never that nothing drifted");

  const unfetchable = harness({ templateDir: async () => { throw new Error("tmpdir is read-only"); } });
  writeFileSync(join(dir, "node_modules/@open-everywhere/core/package.json"), JSON.stringify({ name: CORE, version: FROM, bin: { oe: "./bin/oe.js" } }));
  ok((await runUpgradeCommand(["--plan"], unfetchable.io, dir)) === 0, "a template fetch that throws never fails the run");
  ok(unfetchable.out.join("\n").includes("! the template drift check did not run: tmpdir is read-only"), "🔴 …and it says the check did not run");
}

{
  const ignore = parseTemplateIgnore("# the app's own files\r\n.mcp.json\n\n  ./README.md  \n.claude/skills/quickstart-open-everywhere/\n");
  ok(JSON.stringify(ignore) === JSON.stringify([".mcp.json", "README.md", ".claude/skills/quickstart-open-everywhere/"]), `the ignore list skips comments and blank lines, trims, and drops a leading ./ — got ${JSON.stringify(ignore)}`);
  ok(isTemplateIgnored(ignore, ".mcp.json") && isTemplateIgnored(ignore, ".claude/skills/quickstart-open-everywhere/SKILL.md"), "an exact path and a directory entry both match");
  ok(!isTemplateIgnored(ignore, ".mcp.json.bak") && !isTemplateIgnored(ignore, "agent/README.md"), "NEGATIVE CONTROL: an entry matches no other path that shares its prefix or its base name");

  const notes = parseUpgradingNotes({
    schemaVersion: 1,
    releases: [
      { version: "0.1.5", date: "2026-10-04", summary: "later.", evePeer: "0.54.3", breaking: [], configMigrations: [], env: { added: [], removed: [] }, manualSteps: [], removedFiles: ["agent/later-removed.ts"] },
      { version: TARGET, date: "2026-10-03", summary: "x.", evePeer: "0.54.3", breaking: [], configMigrations: [], env: { added: [], removed: [] }, manualSteps: [], removedFiles: ["agent/instrumentation.ts", "scripts/ops-mcp.ts"] },
      { version: "0.1.3", date: "2026-10-02", summary: "older.", evePeer: "0.54.3", breaking: [], configMigrations: [], env: { added: [], removed: [] }, manualSteps: [] },
    ],
  }).notes!;
  const removed = removedFilesUpTo(notes, TARGET);
  ok(JSON.stringify(removed) === JSON.stringify(["agent/instrumentation.ts", "scripts/ops-mcp.ts"]), `the removed files are every release's up to the target, never a later one's — got ${JSON.stringify(removed)}`);
  ok(parseUpgradingNotes({ schemaVersion: 1, releases: [{ ...notes.releases[1], removedFiles: ["../escape.ts"] }] }).notes === undefined, "🔴 a removed path that climbs out of the app is refused by the parser");

  const upToDate = (): string => {
    const dir = app012();
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, readFileSync(pkgPath, "utf8").split(`"${FROM}"`).join(`"${TARGET}"`));
    const core = join(dir, "node_modules/@open-everywhere/core");
    writeFileSync(join(core, "package.json"), JSON.stringify({ name: CORE, version: TARGET, bin: { oe: "./bin/oe.js" } }));
    writeFileSync(join(core, "upgrading.json"), JSON.stringify({ schemaVersion: 1, releases: notes.releases.slice(1) }));
    writeFileSync(join(dir, "agent/instrumentation.ts"), "export default {};\n");
    rmSync(join(dir, ".mcp.json"));
    writeFileSync(join(dir, "README.md"), "# Our app\n");
    return dir;
  };

  const plain = upToDate();
  const p = harness({ templateDir: async () => TEMPLATE });
  ok((await runUpgradeCommand(["--plan"], p.io, plain)) === 0, "--plan exits 0 over an app that holds a removed file");
  const plainText = p.out.join("\n");
  ok(plainText.includes("DELETE    agent/instrumentation.ts — a release removed it from the template, and the app still has it"), `🔴 --plan prints DELETE for the removed file the app still has\n${plainText}`);
  ok(!/DELETE {4}scripts\/ops-mcp\.ts/u.test(plainText), "🔴 NEGATIVE CONTROL: a removed path that the target's template holds again is never a DELETE line");
  ok(plainText.includes("SYNC      .mcp.json — the template has it, the app does not") && /SYNC {6}README\.md/u.test(plainText), "the control: with no ignore list, the deliberate deletion and rewrite are SYNC lines");
  ok(plainText.includes("4 template-owned file(s) differ") && plainText.includes(`name it in ${TEMPLATE_IGNORE_FILE}`), "the control: they count as SYNC, and the report names the ignore list");
  ok(existsSync(join(plain, "agent/instrumentation.ts")), "🔴 the report deletes nothing");

  const owned = upToDate();
  writeFileSync(join(owned, TEMPLATE_IGNORE_FILE), "# deleted on purpose\n.mcp.json\nREADME.md\n");
  const o = harness({ templateDir: async () => TEMPLATE });
  ok((await runUpgradeCommand(["--plan"], o.io, owned)) === 0, "--plan exits 0 with an ignore list");
  const ownedText = o.out.join("\n");
  ok(!ownedText.includes(".mcp.json"), `🔴 an ignored file that the app deleted prints no line at all\n${ownedText}`);
  ok(/app-owned README\.md — the template adds \d+ and drops \d+ line\(s\)/u.test(ownedText) && !/SYNC {6}README\.md/u.test(ownedText), "🔴 an ignored file that differs prints one app-owned line, never SYNC");
  ok(ownedText.includes("2 template-owned file(s) differ"), `🔴 the SYNC count excludes the ignored paths\n${ownedText}`);
  ok(ownedText.includes("DELETE    agent/instrumentation.ts"), "the ignore list leaves the DELETE line of a file it does not name");

  const across = app012();
  writeFileSync(join(across, "agent/instrumentation.ts"), "export default {};\n");
  const x = harness({ templateDir: async () => TEMPLATE });
  ok((await runUpgradeCommand(["--plan", "--to", "0.2.1"], x.io, across)) === 0, "--plan --to 0.2.1 exits 0 over a 0.1.2 app whose installed core ships no record");
  ok(x.out.join("\n").includes("Template drift (against 0.2.1's @open-everywhere/create template"), "…and the 0.2.1 run printed its drift report");
  ok(x.out.join("\n").includes("DELETE    agent/instrumentation.ts"), `🔴 --plan prints DELETE from the RUNNING core's own record when the installed record names nothing\n${x.out.join("\n")}`);
  const y = harness({ templateDir: async () => TEMPLATE });
  ok((await runUpgradeCommand(["--plan", "--to", "0.1.5"], y.io, across)) === 0, "--plan --to 0.1.5 exits 0");
  ok(y.out.join("\n").includes("Template drift (against 0.1.5's @open-everywhere/create template"), "…and the 0.1.5 run printed its drift report, so the absence below has a witness");
  ok(!y.out.join("\n").includes("DELETE    agent/instrumentation.ts"), "🔴 NEGATIVE CONTROL: a file the record removes only ABOVE the target is never a DELETE line");

  writeFileSync(join(owned, TEMPLATE_IGNORE_FILE), "agent/instrumentation.ts\n");
  const report = templateDrift({ appRoot: owned, templateDir: TEMPLATE, version: TARGET, appName: "upgraded-app", removedFiles: removed, ignore: parseTemplateIgnore(readFileSync(join(owned, TEMPLATE_IGNORE_FILE), "utf8")) });
  ok(report.entries.some((e) => e.path === "agent/instrumentation.ts" && e.state === "app-owned") && driftCounts(report).delete === 0, "an ignored removed file is app-owned and never counts as a DELETE");
  rmSync(join(owned, "agent/instrumentation.ts"));
  const gone = templateDrift({ appRoot: owned, templateDir: TEMPLATE, version: TARGET, appName: "upgraded-app", removedFiles: removed });
  ok(!gone.entries.some((e) => e.path === "agent/instrumentation.ts"), "a removed file that the app no longer has prints nothing");
}

{
  const held = ["AGENTS.md", "agent/agent.ts"];
  const clean = templatePathProblems({ template: held, recorded: ["AGENTS.md", "agent/agent.ts", "agent/instrumentation.ts"], removedFiles: ["agent/instrumentation.ts"] });
  ok(clean.length === 0, `a removed path that a release names, and every held path recorded: no problem — got ${JSON.stringify(clean)}`);
  const silent = templatePathProblems({ template: held, recorded: ["AGENTS.md", "agent/agent.ts", "agent/instrumentation.ts"], removedFiles: [] });
  ok(silent.length === 1 && silent[0]!.includes("agent/instrumentation.ts") && silent[0]!.includes("removedFiles"), `🔴 a template file dropped with no removedFiles entry is refused — got ${JSON.stringify(silent)}`);
  const unrecorded = templatePathProblems({ template: [...held, "Dockerfile"], recorded: held, removedFiles: [] });
  ok(unrecorded.length === 1 && unrecorded[0]!.includes("Dockerfile") && unrecorded[0]!.includes("--write"), `a new template file the record does not list is refused, and the fix is named — got ${JSON.stringify(unrecorded)}`);
  const typo = templatePathProblems({ template: held, recorded: held, removedFiles: ["agent/instrumentaton.ts"] });
  ok(typo.length === 1 && typo[0]!.includes("agent/instrumentaton.ts"), `a removedFiles path the template never held is refused — got ${JSON.stringify(typo)}`);
  ok(templatePathProblems({ template: held, recorded: ["agent/agent.ts", "AGENTS.md"], removedFiles: [] }).some((p) => p.includes("not sorted")), "an unsorted record is refused (a union merge can leave one)");
  ok(templatePathProblems({ template: held, recorded: ["AGENTS.md", "AGENTS.md", "agent/agent.ts"], removedFiles: [] }).some((p) => p.includes("more than once")), "a record that lists a path twice is refused");
  ok(
    JSON.stringify(parseTemplatePaths(renderTemplatePaths(["b", "a", "b"]))) === JSON.stringify(["a", "b"]),
    "the rendered record parses back to the paths, sorted, without duplicates",
  );
  const real = readTemplatePathInputs(REPO);
  const realProblems = [...real.problems, ...templatePathProblems(real)];
  ok(realProblems.length === 0, `this checkout's template path record holds — got ${JSON.stringify(realProblems)}`);
  ok(real.recorded.includes("agent/instrumentation.ts") && !real.template.includes("agent/instrumentation.ts"), "the record keeps agent/instrumentation.ts, which 0.2.0 removed (the OPE-2352 case)");
}

console.log(`template-drift-test: ${passed} assertions passed`);
