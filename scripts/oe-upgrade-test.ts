import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockfileEntriesToDrop, runUpgradeCommand, type UpgradeIo, type UpgradeRegistry } from "../packages/core/scripts/oe-upgrade.js";
import { finishedRun, type ChildResult } from "./npm-command.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "packages/core/scripts/oe-cli.ts");
const TSX_CLI = join(REPO, "node_modules/tsx/dist/cli.mjs");

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}

const INSTALLED = "0.1.3";
const LATEST = "0.1.4";
const CORE = "@open-everywhere/core";

const note = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: LATEST,
  date: "2026-10-03",
  summary: "a release.",
  evePeer: "0.55.0",
  breaking: [],
  configMigrations: [],
  env: { added: [], removed: [] },
  manualSteps: [],
  ...over,
});
const recordOf = (...releases: Record<string, unknown>[]): string => JSON.stringify({ schemaVersion: 1, releases }, null, 2);

function fixtureApp(options: { readonly corePin?: string; readonly notes?: string; readonly scopedScaffolder?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "oe-upgrade-"));
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write("roster.config.ts", "export default {};\n");
  write(
    "package.json",
    `${JSON.stringify(
      {
        name: "fixture-app",
        private: true,
        dependencies: {
          "@open-everywhere/adapters": INSTALLED,
          "@open-everywhere/core": options.corePin ?? INSTALLED,
          "@open-everywhere/provider-slack": INSTALLED,
          eve: "0.54.3",
          "just-bash": "^3.1.0",
        },
        devDependencies: options.scopedScaffolder === true
          ? { "@open-everywhere/create": INSTALLED, tsx: "^4.23.9" }
          : { "create-open-everywhere": INSTALLED, tsx: "^4.23.9" },
      },
      null,
      2,
    )}\n`,
  );
  write("node_modules/@open-everywhere/core/package.json", `${JSON.stringify({ name: CORE, version: INSTALLED, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`);
  write("node_modules/@open-everywhere/core/bin/oe.js", "// fixture bin\n");
  if (options.notes !== undefined) write("node_modules/@open-everywhere/core/upgrading.json", options.notes);
  return root;
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

interface Harness {
  readonly io: UpgradeIo;
  readonly calls: Call[];
  readonly out: string[];
  readonly err: string[];
  text(): string;
}

function harness(options: { readonly registry?: Partial<UpgradeRegistry>; readonly onRun?: (call: Call) => number } = {}): Harness {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const registry: UpgradeRegistry = {
    latestVersion: async () => LATEST,
    evePeer: async () => "0.55.0",
    ...options.registry,
  };
  return {
    calls,
    out,
    err,
    text: () => [...out, ...err].join("\n"),
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      run: (command, args, cwd) => {
        const call = { command, args: args[0]?.endsWith("npm-cli.js") ? args.slice(1) : args, cwd };
        calls.push(call);
        return options.onRun?.(call) ?? 0;
      },
      registry,
    },
  };
}

const marker = (root: string): string => join(root, ".open-everywhere", "upgrade-resume.json");

const manifestOf = (root: string): { dependencies: Record<string, string>; devDependencies: Record<string, string> } =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

{
  const root = fixtureApp({ notes: recordOf(note({ breaking: ["a seat tool was renamed"] })) });
  const before = readFileSync(join(root, "package.json"), "utf8");
  const h = harness();
  const code = await runUpgradeCommand(["--plan"], h.io, root);
  ok(code === 0, "--plan exits 0");
  ok(readFileSync(join(root, "package.json"), "utf8") === before, "🔴 --plan leaves package.json byte-for-byte unchanged");
  ok(h.calls.length === 0, "🔴 --plan spawns nothing — no install, no build");
  ok(h.text().includes(`${INSTALLED} → ${LATEST}`), "--plan names the window it would take");
  ok(h.text().includes("eve 0.55.0"), "--plan names the eve pin it would take from the target's declared peer");
  ok(h.text().includes("a seat tool was renamed"), "--plan prints the release notes it can see");
  ok(h.text().includes("nothing was written"), "--plan says plainly that it wrote nothing");
}

{
  const ownRecord = JSON.parse(readFileSync(join(REPO, "packages/core/upgrading.json"), "utf8")) as {
    releases: { version: string; manualSteps: string[] }[];
  };
  const ownStep = ownRecord.releases.find((r) => r.version === LATEST)?.manualSteps[0];
  assert.ok(ownStep !== undefined, `this repository's record holds a ${LATEST} entry with a manual step`);
  const short = harness();
  ok((await runUpgradeCommand(["--plan"], short.io, fixtureApp({ notes: recordOf(note({ version: INSTALLED })) }))) === 0, "own record: --plan exits 0");
  ok(short.text().includes(`MANUAL    ${ownStep}`), `🔴 own record: --plan prints the target's MANUAL steps from the running core's record\n${short.text()}`);
  ok(short.text().includes(`read from this oe's own upgrading.json, because the installed copy has no entry for ${LATEST}`), "own record: --plan says which record it read");
  const full = harness();
  await runUpgradeCommand(["--plan"], full.io, fixtureApp({ notes: recordOf(note({ manualSteps: ["the installed step"] })) }));
  ok(full.text().includes("MANUAL    the installed step"), "own record: an installed record that holds the target is read as before");
  ok(!full.text().includes("read from this oe's own"), "own record: and the own-record line does not print then");
}

{
  const RULES = join("agent", "access", "pre-approval-rules.ts");
  const templateWithRules = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "oe-upgrade-template-"));
    mkdirSync(join(dir, "agent", "access"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, RULES), "export const PRE_APPROVAL_RULES = [];\n");
    return dir;
  };

  const tpl = templateWithRules();
  const root = fixtureApp();
  const h = harness({ registry: { templateDir: async () => tpl } });
  ok((await runUpgradeCommand(["--plan"], h.io, root)) === 0, "offer: --plan still exits 0");
  ok(h.out.some((l) => l.startsWith("  OFFER     agent/access/pre-approval-rules.ts")), "🔴 offer: --plan OFFERS the starter rules to an app that has none (OPE-2400)");
  ok(h.text().includes(join(tpl, RULES)), "offer: …and names the target template's own copy to read");
  ok(h.text().includes("approval-policy"), "offer: …and names the binding the file needs, because the file alone binds nothing");
  ok(!existsSync(join(root, RULES)), "🔴 offer: --plan writes no rules file — an OFFER, never a copy");

  const blind = fixtureApp();
  const hb = harness();
  await runUpgradeCommand(["--plan"], hb.io, blind);
  ok(hb.text().includes(`@open-everywhere/create@${LATEST} package's template/`), "offer: with no readable template it names the file by its package path");

  const applied = fixtureApp();
  const ha = harness({ registry: { templateDir: async () => tpl } });
  ok((await runUpgradeCommand([], ha.io, applied)) === 0, "offer: the apply path still exits 0");
  ok(ha.out.some((l) => l.startsWith("  OFFER     agent/access/pre-approval-rules.ts")), "offer: the apply path OFFERS it too");
  ok(!existsSync(join(applied, RULES)), "🔴 offer: the apply path writes no rules file either");

  const owned = fixtureApp();
  mkdirSync(join(owned, "agent", "access"), { recursive: true });
  writeFileSync(join(owned, RULES), "// the operator's own rules\n");
  const ho = harness({ registry: { templateDir: async () => tpl } });
  await runUpgradeCommand(["--plan"], ho.io, owned);
  ok(!ho.text().includes("OFFER"), "🔴 offer NEGATIVE CONTROL: an app that has the file is offered nothing");
  ok(readFileSync(join(owned, RULES), "utf8") === "// the operator's own rules\n", "🔴 offer: …and its file is byte-for-byte unchanged — never overwritten");

  const ignoring = fixtureApp();
  writeFileSync(join(ignoring, ".oe-template-ignore"), "agent/access/pre-approval-rules.ts\n");
  const hi = harness({ registry: { templateDir: async () => tpl } });
  await runUpgradeCommand(["--plan"], hi.io, ignoring);
  ok(!hi.text().includes("OFFER"), "🔴 offer: an app that names the file in .oe-template-ignore is offered nothing");

  const bare = mkdtempSync(join(tmpdir(), "oe-upgrade-template-"));
  writeFileSync(join(bare, "package.json"), "{}\n");
  const hn = harness({ registry: { templateDir: async () => bare } });
  await runUpgradeCommand(["--plan"], hn.io, fixtureApp());
  ok(!hn.text().includes("OFFER"), "offer: a target template with no rules file offers nothing");
}

{
  const root = fixtureApp({ notes: recordOf(note({ env: { added: ["OE_NEW_NAME"], removed: ["OE_OLD_NAME"] }, manualSteps: ["re-paste the Slack manifest"] })) });
  const h = harness();
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 0, "a clean upgrade exits 0");

  const pkg = manifestOf(root);
  ok(pkg.dependencies["@open-everywhere/core"] === LATEST, "core is bumped to the target");
  ok(pkg.dependencies["@open-everywhere/adapters"] === LATEST, "🔴 every @open-everywhere/* package bumps WITH it — the eleven publish in lockstep");
  ok(pkg.dependencies["@open-everywhere/provider-slack"] === LATEST, "a provider package bumps too");
  ok(pkg.devDependencies["@open-everywhere/create"] === LATEST, "🔴 the scaffolder bumps too, from devDependencies");
  ok(
    !("create-open-everywhere" in pkg.devDependencies),
    "🔴 the RETIRED unscoped scaffolder key is GONE, not left beside the scoped one (OPE-2234) — it is deprecated on npm and publishes no further version",
  );
  ok(pkg.dependencies.eve === "0.55.0", "🔴 eve is pinned to the version the TARGET core declares, not left behind");
  ok(pkg.dependencies["just-bash"] === "^3.1.0", "a dependency outside the set is left alone");
  ok(pkg.devDependencies.tsx === "^4.23.9", "a dev dependency outside the set is left alone");

  const labels = h.calls.map((c) => c.args.join(" "));
  ok(labels.length === 4, `the procedure spawns four steps, got ${labels.length}: ${labels.join(" | ")}`);
  ok(labels[0] === "install", "step 1 is npm install");
  ok(labels[1]!.endsWith("build --accept"), "step 2 is oe build --accept");
  ok(labels[2] === "run typecheck", "step 3 is npm run typecheck");
  ok(labels[3] === "run build", "step 4 is npm run build");
  ok(h.calls.every((c) => c.cwd === root), "every step runs in the app root");

  const build = h.calls[1]!;
  ok(build.command === process.execPath, "🔴 oe build runs the NEWLY INSTALLED bin with this Node, never the node_modules/.bin shim");
  ok(build.args[0] === join(root, "node_modules", "@open-everywhere", "core", "bin", "oe.js"), "…and that bin is the one the install just put in place");

  ok(h.text().includes("READ the roster.lock.json diff"), "the run ends by telling the operator to read the lock diff");
  ok(h.text().includes("ENV: add OE_NEW_NAME"), "🔴 an env name the release adds is repeated at the end, where an operator will act on it");
  ok(h.text().includes("ENV: OE_OLD_NAME is no longer read"), "an env name the release removes is repeated too");
  ok(h.text().includes("MANUAL (0.1.4): re-paste the Slack manifest"), "a manual step is repeated at the end");
}

{
  const root = fixtureApp({ notes: recordOf(note()) });
  const h = harness();
  ok((await runUpgradeCommand([], h.io, root)) === 0, "an app on the retired scaffolder name upgrades cleanly");
  ok(
    h.text().includes("devDependencies.create-open-everywhere → devDependencies.@open-everywhere/create"),
    "🔴 the rename is PRINTED, not silent — an operator reading the run sees the dependency key change",
  );
}

{
  const root = fixtureApp({ notes: recordOf(note()), scopedScaffolder: true });
  const h = harness();
  ok((await runUpgradeCommand([], h.io, root)) === 0, "an app already on @open-everywhere/create upgrades cleanly");
  const pkg = manifestOf(root);
  ok(pkg.devDependencies["@open-everywhere/create"] === LATEST, "the scoped scaffolder key bumps to the target");
  ok(!("create-open-everywhere" in pkg.devDependencies), "no retired key is reintroduced");
  ok(!h.text().includes("→ devDependencies.@open-everywhere/create"), "and no rename line is printed when there is nothing to rename");
}

{
  const root = fixtureApp({ notes: recordOf(note()) });
  const h = harness({ onRun: (c) => (c.args[0] === "install" ? 1 : 0) });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 1, "a failing npm install exits 1");
  ok(h.calls.length === 1, "🔴 nothing after the failing step ran — a half-installed tree is never built");
  ok(h.text().includes("Nothing after this step ran"), "the refusal says so");
  ok(h.text().includes("If npm reported ERESOLVE") && h.text().includes("`rm package-lock.json && npm install`"), "🔴 a failed install names the lockfile recovery (OPE-2395)");
  ok(manifestOf(root).dependencies["@open-everywhere/core"] === LATEST, "the pins were written before the install, so the manifest already names the target");

  const retry = harness();
  const again = await runUpgradeCommand([], retry.io, root);
  ok(again === 0, "the retry after a failed step exits 0");
  ok(retry.calls.length === 4, `🔴 …by RUNNING all four steps, not by reporting nothing to do — got ${retry.calls.length}`);
  ok(retry.text().includes("began taking"), "…and it says it is resuming");
  ok(!retry.text().includes("Nothing to do"), "…and never claims there was nothing to do");
}

{
  const root = fixtureApp({ notes: recordOf(note()) });
  const installed = (): void => {
    writeFileSync(
      join(root, "node_modules", "@open-everywhere", "core", "package.json"),
      `${JSON.stringify({ name: CORE, version: LATEST, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`,
    );
  };
  const first = harness({
    onRun: (c) => {
      if (c.args[0] === "install") installed();
      return c.args.join(" ") === "run typecheck" ? 1 : 0;
    },
  });
  ok((await runUpgradeCommand([], first.io, root)) === 1, "a typecheck that fails after the install exits 1");
  ok(first.calls.length === 3, "…and the build never ran");
  ok(existsSync(marker(root)), "…and the resume marker is left behind");

  const second = harness();
  ok((await runUpgradeCommand([], second.io, root)) === 0, "the retry exits 0");
  ok(second.calls.length === 4, `🔴 …by running the four steps again, not by reporting nothing to do — got ${second.calls.length}`);
  ok(second.text().includes("stopped before the tree was proven"), "…and it says why it is resuming");
  ok(!existsSync(marker(root)), "🔴 a completed run clears the marker, so the NEXT run really can report nothing to do");

  const third = harness();
  ok((await runUpgradeCommand([], third.io, root)) === 0 && third.calls.length === 0, "…and it does: the run after a completed upgrade spawns nothing");
}

{
  const root = fixtureApp({ notes: recordOf(note()) });
  const first = harness({
    onRun: (c) => {
      if (c.args[0] !== "install") return 0;
      writeFileSync(
        join(root, "node_modules", "@open-everywhere", "core", "package.json"),
        `${JSON.stringify({ name: CORE, version: LATEST, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`,
      );
      return 1;
    },
  });
  ok((await runUpgradeCommand([], first.io, root)) === 1, "an install that reifies the tree and then fails exits 1");
  ok(existsSync(marker(root)), "🔴 …and the marker is already on disk, because it is written BEFORE the install");

  const second = harness();
  ok((await runUpgradeCommand([], second.io, root)) === 0, "the retry exits 0");
  ok(second.calls.length === 4, `🔴 …by running the four steps — the pin and node_modules both read the target, so only the marker can tell — got ${second.calls.length}`);
  ok(!second.text().includes("Nothing to do"), "…and never claims there was nothing to do");
}

{
  const NEWER = "0.1.5";
  const root = fixtureApp();
  writeFileSync(join(root, "package.json"), readFileSync(join(root, "package.json"), "utf8").replace(new RegExp(INSTALLED, "gu"), NEWER));
  writeFileSync(
    join(root, "node_modules", "@open-everywhere", "core", "package.json"),
    `${JSON.stringify({ name: CORE, version: NEWER, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`,
  );
  mkdirSync(join(root, ".open-everywhere"), { recursive: true });
  writeFileSync(marker(root), `${JSON.stringify({ from: INSTALLED, target: NEWER })}\n`);
  const before = readFileSync(join(root, "package.json"), "utf8");
  const h = harness();
  ok((await runUpgradeCommand(["--to", LATEST], h.io, root)) === 1, "🔴 a downgrade is refused even with an older baseline in the marker");
  ok(h.text().includes(`older than the installed ${NEWER}`), "…and the refusal names what is REALLY installed, not the marker's baseline");
  ok(h.calls.length === 0 && readFileSync(join(root, "package.json"), "utf8") === before, "…and it writes nothing and spawns nothing");
}

{
  const root = fixtureApp({ notes: recordOf(note({ version: INSTALLED })) });
  const onInstall = (c: Call): number => {
    if (c.args[0] === "install") {
      writeFileSync(
        join(root, "node_modules", "@open-everywhere", "core", "package.json"),
        `${JSON.stringify({ name: CORE, version: LATEST, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`,
      );
      writeFileSync(
        join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"),
        recordOf(note({ configMigrations: [{ description: "late migration", codemod: "arrives-with-the-target" }] }), note({ version: INSTALLED })),
      );
    }
    return 0;
  };
  const refuse = (c: Call): number => (c.args.includes("upgrade-codemods") ? 1 : onInstall(c));
  const first = harness({ onRun: refuse });
  ok((await runUpgradeCommand([], first.io, root)) === 1, "the first run refuses on the codemod the target's registry does not hold");
  ok(existsSync(marker(root)), "…and leaves the marker");
  ok(JSON.parse(readFileSync(marker(root), "utf8")).from === INSTALLED, `🔴 …which records the version the run started FROM, got ${readFileSync(marker(root), "utf8").trim()}`);

  const second = harness({ onRun: refuse });
  ok((await runUpgradeCommand([], second.io, root)) === 1, "🔴 the retry refuses AGAIN — it does not forget the migration the operator still owes");
  ok(second.text().includes("arrives-with-the-target"), "…and names it again");
  ok(existsSync(marker(root)), "…and the marker stays, because the run still did not finish");
}

{
  const root = fixtureApp({ notes: recordOf(note()) });
  writeFileSync(join(root, "package.json"), readFileSync(join(root, "package.json"), "utf8").replace(new RegExp(INSTALLED, "gu"), LATEST));
  writeFileSync(
    join(root, "node_modules", "@open-everywhere", "core", "package.json"),
    `${JSON.stringify({ name: CORE, version: LATEST, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`,
  );
  mkdirSync(join(root, ".open-everywhere"), { recursive: true });
  writeFileSync(marker(root), '{"targ');
  const h = harness();
  ok((await runUpgradeCommand(["--to", LATEST], h.io, root)) === 0, "a truncated marker still completes");
  ok(h.calls.length === 4, `🔴 …by RUNNING the steps, not by reporting nothing to do — got ${h.calls.length}`);
  ok(h.text().includes("unreadable"), "…and it says the baseline is lost");
  ok(!h.text().includes("Nothing to do"), "…and never claims there was nothing to do");
}

{
  const NEXT = "0.1.5";
  const root = fixtureApp();
  writeFileSync(join(root, "package.json"), readFileSync(join(root, "package.json"), "utf8").replace(new RegExp(INSTALLED, "gu"), LATEST));
  writeFileSync(
    join(root, "node_modules", "@open-everywhere", "core", "package.json"),
    `${JSON.stringify({ name: CORE, version: LATEST, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`,
  );
  mkdirSync(join(root, ".open-everywhere"), { recursive: true });
  writeFileSync(marker(root), `${JSON.stringify({ from: INSTALLED, target: LATEST })}\n`);
  writeFileSync(
    join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"),
    recordOf(note({ version: NEXT, breaking: ["the 0.1.5 change"] }), note({ version: LATEST, breaking: ["the 0.1.4 change nobody saw"] })),
  );
  const h = harness({ registry: { latestVersion: async () => NEXT, evePeer: async () => "0.55.0" } });
  ok((await runUpgradeCommand([], h.io, root)) === 0, "a stale marker does not block the next upgrade");
  ok(h.text().includes("the 0.1.4 change nobody saw"), "🔴 …and the window still starts at the version the STOPPED run started from");
  ok(h.text().includes("the 0.1.5 change"), "…and reaches the new target too");
}

{
  const root = fixtureApp({ notes: recordOf(note()) });
  const reinstall = (): void => {
    mkdirSync(join(root, "node_modules", "@open-everywhere", "core", "bin"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "@open-everywhere", "core", "package.json"),
      `${JSON.stringify({ name: CORE, version: LATEST, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`,
    );
    writeFileSync(join(root, "node_modules", "@open-everywhere", "core", "bin", "oe.js"), "// fixture bin\n");
    writeFileSync(join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"), recordOf(note()));
  };
  const first = harness({
    onRun: (c) => {
      if (c.args[0] === "install") reinstall();
      return c.args.join(" ") === "run build" ? 1 : 0;
    },
  });
  ok((await runUpgradeCommand([], first.io, root)) === 1, "the first run dies at the build");
  rmSync(join(root, "node_modules"), { recursive: true, force: true });
  reinstall();
  ok(existsSync(marker(root)), "🔴 the marker outlives a wiped and restored node_modules");
  const second = harness({ onRun: () => 0 });
  ok((await runUpgradeCommand([], second.io, root)) === 0, "the retry after a clean reinstall exits 0");
  ok(second.calls.length === 4, `🔴 …by running the steps, not by reading the restored install as proof — got ${second.calls.length}`);
}

{
  const root = fixtureApp();
  writeFileSync(join(root, "package.json"), readFileSync(join(root, "package.json"), "utf8").replace(new RegExp(INSTALLED, "gu"), LATEST));
  rmSync(join(root, "node_modules"), { recursive: true, force: true });
  const h = harness({
    onRun: (c) => {
      if (c.args[0] === "install") {
        mkdirSync(join(root, "node_modules", "@open-everywhere", "core", "bin"), { recursive: true });
        writeFileSync(
          join(root, "node_modules", "@open-everywhere", "core", "package.json"),
          `${JSON.stringify({ name: CORE, version: LATEST, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`,
        );
        writeFileSync(join(root, "node_modules", "@open-everywhere", "core", "bin", "oe.js"), "// fixture bin\n");
      }
      return 0;
    },
  });
  ok((await runUpgradeCommand(["--to", LATEST], h.io, root)) === 0, "a tree pinned at the target with nothing installed still upgrades");
  ok(h.calls.length === 4, `🔴 …by running all four steps, not by reading the pin as proof — got ${h.calls.length}`);
}

{
  const root = fixtureApp({ scopedScaffolder: true });
  const h = harness();
  const code = await runUpgradeCommand(["--to", INSTALLED], h.io, root);
  ok(code === 0 && h.calls.length === 0 && h.text().includes("already on"), "a tree already installed at the target reports nothing to do, and spawns nothing");
}

{
  const root = fixtureApp();
  const h = harness();
  const code = await runUpgradeCommand(["--to", INSTALLED], h.io, root);
  ok(code === 0, "a tree at the target that still names the retired scaffolder exits 0");
  ok(!h.text().includes("Nothing to do"), "🔴 …and never claims there was nothing to do");
  ok(h.text().includes("still names create-open-everywhere"), "…it says which dependency name is the reason");
  ok(h.calls.length === 4, `🔴 …and runs all four steps, because a renamed dependency has to be installed — got ${h.calls.length}`);
  const pkg = manifestOf(root);
  ok(pkg.devDependencies["@open-everywhere/create"] === INSTALLED, "the scoped key is written at the version the app is on");
  ok(!("create-open-everywhere" in pkg.devDependencies), "and the retired key is gone");
}

{
  const root = fixtureApp({ notes: recordOf(note()) });
  const h = harness({ onRun: (c) => (c.args.join(" ") === "run typecheck" ? 2 : 0) });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 1, "a failing typecheck exits 1");
  ok(h.calls.length === 3, "🔴 the build never runs after a red typecheck");
}

const LOCK = {
  name: "fixture-app",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "fixture-app", dependencies: { "@open-everywhere/core": INSTALLED, eve: "0.54.3" } },
    "node_modules/@open-everywhere/adapters": { version: INSTALLED, peerDependencies: { eve: "0.54.3" } },
    "node_modules/@open-everywhere/core": { version: INSTALLED, peerDependencies: { eve: "0.54.3" } },
    "node_modules/@agent-browser/eve": { version: "0.30.0", peerDependencies: { eve: ">=0.25.1" } },
    "node_modules/eve": { version: "0.54.3" },
    "node_modules/eve/node_modules/undici": { version: "8.0.0" },
    "node_modules/foo/node_modules/eve": { version: "0.50.0" },
    "node_modules/just-bash": { version: "3.1.0", resolved: "https://registry.npmjs.org/just-bash/-/just-bash-3.1.0.tgz", integrity: "sha512-x" },
    "node_modules/eve-adjacent": { version: "1.0.0" },
    "packages/local": { version: "1.0.0", peerDependencies: { eve: "*" } },
    "node_modules/@open-everywhere/linked": { resolved: "packages/local", link: true },
  },
};

{
  const dropped = lockfileEntriesToDrop(LOCK);
  ok(
    JSON.stringify([...dropped].sort()) ===
      JSON.stringify(["node_modules/@agent-browser/eve", "node_modules/@open-everywhere/adapters", "node_modules/@open-everywhere/core", "node_modules/eve", "node_modules/eve/node_modules/undici", "node_modules/foo/node_modules/eve"]),
    `🔴 the prune drops eve at any depth, every @open-everywhere/* entry, every package that peers on eve and every entry nested under one of them — got ${JSON.stringify(dropped)}`,
  );
  ok(!dropped.includes("") && !dropped.includes("node_modules/just-bash") && !dropped.includes("node_modules/eve-adjacent"), "NEGATIVE CONTROL: the root entry and every unrelated package stay locked");
  ok(!dropped.includes("node_modules/@open-everywhere/linked") && !dropped.includes("packages/local"), "…and a workspace link and a workspace path stay, even one that peers on eve");
  ok(lockfileEntriesToDrop({ lockfileVersion: 1, dependencies: {} }).length === 0 && lockfileEntriesToDrop("{").length === 0, "a lockfile with no packages map drops nothing from it");
}

{
  const root = fixtureApp({ notes: recordOf(note()) });
  const lockText = `${JSON.stringify(LOCK, null, 2)}\n`;
  writeFileSync(join(root, "package-lock.json"), lockText);
  const plan = harness();
  ok((await runUpgradeCommand(["--plan"], plan.io, root)) === 0, "--plan with a lockfile exits 0");
  ok(plan.text().includes("edit package-lock.json: drop the 6 locked entries"), `--plan names the lockfile edit\n${plan.text()}`);
  ok(readFileSync(join(root, "package-lock.json"), "utf8") === lockText, "🔴 --plan leaves the lockfile unchanged");

  let atInstall: Record<string, unknown> | undefined;
  const h = harness({
    onRun: (c) => {
      if (c.args[0] === "install") atInstall = (JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, unknown> }).packages;
      return 0;
    },
  });
  ok((await runUpgradeCommand([], h.io, root)) === 0, "the upgrade with a lockfile exits 0");
  ok(atInstall !== undefined && atInstall["node_modules/eve"] === undefined && atInstall["node_modules/@open-everywhere/core"] === undefined, "🔴 npm install runs over a lockfile without the old eve and @open-everywhere/* entries");
  ok(
    JSON.stringify(atInstall?.["node_modules/just-bash"]) === JSON.stringify(LOCK.packages["node_modules/just-bash"]) && atInstall?.[""] !== undefined,
    "…and with every other entry exactly as it was",
  );
  ok(h.text().includes("dropped 6 locked entries from package-lock.json"), "…and the run says what it dropped");

  const legacy = fixtureApp({ notes: recordOf(note()) });
  writeFileSync(
    join(legacy, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 2, packages: { "": {}, "node_modules/eve": { version: "0.54.3" } }, dependencies: { eve: { version: "0.54.3" }, "just-bash": { version: "3.1.0", dependencies: { "@open-everywhere/core": { version: INSTALLED } } } } }),
  );
  ok((await runUpgradeCommand([], harness().io, legacy)) === 0, "the upgrade with a v2 lockfile exits 0");
  const after = JSON.parse(readFileSync(join(legacy, "package-lock.json"), "utf8")) as { dependencies: Record<string, { dependencies?: Record<string, unknown> }> };
  ok(after.dependencies.eve === undefined && after.dependencies["just-bash"]?.dependencies?.["@open-everywhere/core"] === undefined && after.dependencies["just-bash"] !== undefined, "…and the legacy tree loses eve and @open-everywhere/* at every depth, and keeps the rest");

  const none = fixtureApp({ notes: recordOf(note()) });
  const n = harness();
  ok((await runUpgradeCommand([], n.io, none)) === 0 && !existsSync(join(none, "package-lock.json")) && !n.text().includes("package-lock.json:"), "an app with no lockfile gets none written");
}

{
  const root = fixtureApp({ notes: recordOf(note()) });
  const before = readFileSync(join(root, "package.json"), "utf8");
  const h = harness();
  const code = await runUpgradeCommand(["--to", "0.1.2"], h.io, root);
  ok(code === 1, "a target older than the installed version exits 1");
  ok(h.text().includes("does not downgrade"), "…and says this command does not downgrade");
  ok(readFileSync(join(root, "package.json"), "utf8") === before && h.calls.length === 0, "a refused downgrade writes nothing and spawns nothing");
}

{
  const root = fixtureApp({ notes: recordOf(note()), scopedScaffolder: true });
  const h = harness();
  const code = await runUpgradeCommand(["--to", INSTALLED], h.io, root);
  ok(code === 0, "a target equal to the installed version exits 0");
  ok(h.text().includes(`already on ${INSTALLED}`), "…and says there is nothing to do");
  ok(h.calls.length === 0, "…and spawns nothing");
}

{
  const root = fixtureApp({ corePin: "^0.1.3" });
  const before = readFileSync(join(root, "package.json"), "utf8");
  const h = harness();
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 1, "🔴 a RANGE pin is refused — a range makes the installed version unknowable from the manifest");
  ok(h.text().includes("lockstep"), "…and the refusal says why the pins are exact");
  ok(readFileSync(join(root, "package.json"), "utf8") === before, "a refused range writes nothing");
}

{
  const root = mkdtempSync(join(tmpdir(), "oe-upgrade-bare-"));
  const h = harness();
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 1, "a directory with no roster.config.ts is refused");
  ok(h.text().includes("roster.config.ts"), "…and the refusal names the file an app is identified by");
}

{
  const root = fixtureApp();
  const h = harness({ registry: { latestVersion: async () => undefined } });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 1, "🔴 a registry that cannot name the latest version is a refusal, never a guess");
  ok(h.text().includes("--to"), "…and the refusal offers the flag that answers it");
}

{
  const root = fixtureApp();
  const h = harness({ registry: { evePeer: async () => undefined } });
  const code = await runUpgradeCommand(["--to", LATEST], h.io, root);
  ok(code === 1, "🔴 an unreadable eve peer is a refusal — installing without it would strand eve on a version core does not support");
  ok(h.calls.length === 0, "…before anything is installed");
}

{
  const root = fixtureApp({ notes: recordOf(note({ configMigrations: [{ description: "rewrite the overrides", codemod: "nobody-wrote-this" }] })) });
  const install = installTargetNaming(root, "nobody-wrote-this");
  const h = harness({ onRun: (c) => (install(c), 0) });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 0, `🔴 an id this CLI does not hold no longer refuses before the install — got ${code}: ${h.err.join(" | ")}`);
  ok(h.text().includes("this CLI does not hold: nobody-wrote-this"), "…but the warning names it");
  ok(h.text().includes(`${LATEST}'s registry resolves it`), "…and the plan says which registry resolves it");
  ok(h.calls[1]?.args.includes("nobody-wrote-this") === true, "🔴 …and the TARGET's registry gets the id, so it can refuse it there");
}

{
  const NEXT = "0.1.5";
  const root = fixtureApp();
  writeFileSync(join(root, "package.json"), readFileSync(join(root, "package.json"), "utf8").replace(new RegExp(INSTALLED, "gu"), LATEST));
  writeFileSync(
    join(root, "node_modules", "@open-everywhere", "core", "package.json"),
    `${JSON.stringify({ name: CORE, version: LATEST, bin: { oe: "./bin/oe.js" } }, null, 2)}\n`,
  );
  const lateNote = note({ configMigrations: [{ description: "late migration", codemod: "late" }] });
  writeFileSync(join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"), recordOf(lateNote, note({ version: INSTALLED })));
  mkdirSync(join(root, ".open-everywhere"), { recursive: true });
  writeFileSync(marker(root), `${JSON.stringify({ from: INSTALLED, target: LATEST })}\n`);
  const h = harness({
    onRun: (c) => {
      if (c.args[0] === "install") {
        writeFileSync(
          join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"),
          recordOf(note({ version: NEXT }), lateNote, note({ version: INSTALLED })),
        );
      }
      return 0;
    },
  });
  const code = await runUpgradeCommand(["--to", NEXT], h.io, root);
  ok(code === 0, `🔴 \`oe upgrade --to ${NEXT}\` gets past the refused release — got ${code}: ${h.err.join(" | ")}`);
  ok(h.calls[0]?.args[0] === "install", "…by installing the later release");
  ok(h.calls[1]?.args.includes("late") === true, "🔴 …and handing the refused release's codemod to the later release's registry");
}

function installTargetNaming(root: string, codemod: string): (c: Call) => void {
  return (c: Call): void => {
    if (c.args[0] !== "install") return;
    writeFileSync(
      join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"),
      recordOf(
        note({
          configMigrations: [
            { description: "late migration", codemod },
            { description: "edit the overrides by hand" },
          ],
        }),
        note({ version: INSTALLED }),
      ),
    );
  };
}

{
  const root = fixtureApp({ notes: recordOf(note({ version: INSTALLED })) });
  const install = installTargetNaming(root, "arrives-with-the-target");
  const h = harness({ onRun: (c) => (install(c), 0) });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 0, `🔴 a codemod that only the TARGET's notes name no longer refuses — got exit ${code}: ${h.err.join(" | ")}`);
  const codemodCall = h.calls[1];
  const bin = join(root, "node_modules", "@open-everywhere", "core", "bin", "oe.js");
  ok(
    codemodCall !== undefined &&
      codemodCall.command === process.execPath &&
      JSON.stringify(codemodCall.args) === JSON.stringify([bin, "upgrade-codemods", "arrives-with-the-target"]) &&
      codemodCall.cwd === root,
    `🔴 …because step 4 spawns the NEWLY INSTALLED bin's \`upgrade-codemods\` with the target's ids — got ${JSON.stringify(codemodCall)}`,
  );
  ok(h.calls[2]?.args.join(" ").endsWith("build --accept") === true, "…and `oe build --accept` runs only AFTER the codemods");
  ok(h.calls.length === 5, `…and the procedure is install, codemods, build --accept, typecheck, build — got ${h.calls.length}`);
  ok(h.text().includes("CONFIG (apply by hand): edit the overrides by hand"), "…and a migration with no codemod is still printed for the operator");
}

{
  const root = fixtureApp({ notes: recordOf(note({ version: INSTALLED })) });
  const install = installTargetNaming(root, "nobody-shipped-this");
  const h = harness({ onRun: (c) => (install(c), c.args.includes("upgrade-codemods") ? 1 : 0) });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 1, "🔴 a codemod step that exits non-zero stops the upgrade");
  ok(h.text().includes("nobody-shipped-this"), "…and the failed step names the ids");
  ok(h.calls.length === 2, "…and `oe build --accept` never ran, so no unreviewed roster lands");
  ok(existsSync(marker(root)), "…and the marker stays, so the retry re-runs the codemods");
}

{
  const root = fixtureApp({ notes: recordOf(note({ version: INSTALLED })) });
  const h = harness();
  ok((await runUpgradeCommand([], h.io, root)) === 0, "a window with no codemod completes");
  ok(!h.calls.some((c) => c.args.includes("upgrade-codemods")), "…and spawns no codemod step");
}

{
  const root = fixtureApp({ notes: recordOf(note({ version: INSTALLED })) });
  const h = harness({
    onRun: (c) => {
      if (c.args[0] === "install") {
        writeFileSync(
          join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"),
          recordOf(note({ breaking: ["only the target's copy knows this"] }), note({ version: INSTALLED })),
        );
      }
      return 0;
    },
  });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 0, "the negative control: a clean target record completes the upgrade");
  ok(h.text().includes("only the target's copy knows this"), "🔴 …and the notes that arrived WITH the install are printed");
}

{
  const root = fixtureApp();
  const h = harness();
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 0, "a target that ships no upgrading.json still upgrades — the record postdates some releases");
  ok(h.text().includes("predates the release record"), "…and the run says so rather than staying silent");
}

{
  const root = fixtureApp({ notes: recordOf(note({ configMigrations: [{ description: "rewrite the overrides", codemod: "nobody-wrote-this" }] })) });
  const h = harness({
    onRun: (c) => {
      if (c.args[0] === "install") rmSync(join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"));
      return 0;
    },
  });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 1, "🔴 a target that ships NO record after an installed core that did refuses");
  ok(h.calls.length === 1, "…and `oe build --accept` never ran");
  ok(existsSync(marker(root)), "…and the marker stays for the retry");
  ok(h.text().includes("cannot be read"), "…and the refusal says why");
  const retry = harness();
  ok((await runUpgradeCommand([], retry.io, root)) === 1, "🔴 the RETRY refuses too — the pre-install read is the broken target now");
  ok(retry.calls.length === 1 && existsSync(marker(root)), "…and it runs no build and keeps the marker");
  ok(retry.text().includes("left a resume marker") && !retry.text().includes("the installed core did"), "…and its message names the marker, not a record the installed core does not ship");
}

{
  const root = fixtureApp({ notes: recordOf(note({ version: INSTALLED })) });
  const h = harness({
    onRun: (c) => {
      if (c.args[0] === "install") writeFileSync(join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"), "{ not json");
      return 0;
    },
  });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 1, "🔴 a target whose record is present but UNPARSEABLE refuses — reading it as \"no notes\" would skip every codemod and report success");
  ok(h.calls.length === 1, "…and `oe build --accept` never ran");
  ok(h.text().includes("by hand"), "…and the refusal says what state the tree is in");
}

{
  const root = fixtureApp();
  writeFileSync(join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"), "{ not json");
  const h = harness({
    onRun: (c) => {
      if (c.args[0] === "install") writeFileSync(join(root, "node_modules", "@open-everywhere", "core", "upgrading.json"), recordOf(note()));
      return 0;
    },
  });
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 0, "the negative control: a broken record on the INSTALLED side is a warning, because the install replaces it");
  ok(h.text().includes("does not parse"), "…and the warning is printed");
}

{
  const root = fixtureApp();
  const h = harness();
  ok((await runUpgradeCommand(["--help"], h.io, root)) === 0, "--help exits 0");
  ok(h.text().includes("oe upgrade --plan"), "…and prints the usage");
  const bad = harness();
  ok((await runUpgradeCommand(["--to", "latest"], bad.io, root)) === 2, "a --to that is not x.y.z is a usage error");
  const worse = harness();
  ok((await runUpgradeCommand(["--force"], worse.io, root)) === 2, "🔴 an unknown flag is a usage error — there is no --force");
  ok(worse.calls.length === 0, "…and it spawns nothing");
  const stray = harness();
  const before = readFileSync(join(root, "package.json"), "utf8");
  ok((await runUpgradeCommand(["0.1.4"], stray.io, root)) === 2, "🔴 a BARE version is a usage error — ignoring it installed LATEST instead of the version named");
  ok(stray.text().includes("the version goes after --to"), "…and the message says where the version goes");
  ok(stray.calls.length === 0 && readFileSync(join(root, "package.json"), "utf8") === before, "…and it writes nothing and spawns nothing");
  const withTo = harness();
  ok((await runUpgradeCommand(["--to", LATEST, "--plan"], withTo.io, root)) === 0, "…the negative control: --to's own value is not mistaken for a stray argument");
}

function releaseDir(packages: readonly { readonly name: string; readonly version: string; readonly peerDependencies?: Record<string, string> }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "oe-upgrade-release-"));
  for (const pkg of packages) {
    const work = mkdtempSync(join(tmpdir(), "oe-upgrade-pkg-"));
    mkdirSync(join(work, "package"));
    writeFileSync(join(work, "package", "package.json"), JSON.stringify(pkg));
    const file = `${pkg.name.slice(1).replace("/", "-")}-${pkg.version}.tgz`;
    execFileSync("tar", ["-czf", file, "package"], { cwd: work });
    writeFileSync(join(dir, file), readFileSync(join(work, file)));
  }
  return dir;
}

const noRegistry: Partial<UpgradeRegistry> = {
  latestVersion: async () => assert.fail("--from read the registry's latest version"),
  evePeer: async () => assert.fail("--from read the registry's eve peer"),
};
const FULL_SET = ["core", "adapters", "provider-slack", "create"].map((n) => ({
  name: `@open-everywhere/${n}`,
  version: LATEST,
  ...(n === "core" ? { peerDependencies: { eve: "0.60.0" } } : {}),
}));

{
  const root = fixtureApp();
  const dir = releaseDir(FULL_SET);
  const h = harness({ registry: noRegistry });
  const code = await runUpgradeCommand(["--from", dir], h.io, root);
  ok(code === 0, `🔴 \`oe upgrade --from <dir>\` takes the target from the tarballs and never asks the registry — got ${code}\n${h.text()}`);
  ok(h.text().includes(`oe upgrade: ${INSTALLED} → ${LATEST} (eve 0.60.0)`), "…and the target and the eve peer are the core tarball's own");
  const pins = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const tgz = (n: string): string => `file:${join(dir, `open-everywhere-${n}-${LATEST}.tgz`)}`;
  ok(
    pins.dependencies["@open-everywhere/core"] === tgz("core") && pins.dependencies["@open-everywhere/adapters"] === tgz("adapters") && pins.dependencies.eve === "0.60.0",
    `🔴 …and every @open-everywhere/* pin names its tarball — got ${JSON.stringify(pins.dependencies)}`,
  );
  ok(pins.devDependencies["@open-everywhere/create"] === tgz("create") && pins.devDependencies["create-open-everywhere"] === undefined, "…and the retired scaffolder is renamed onto the create tarball");
  ok(h.text().includes("REHEARSAL: package.json pins"), "…and the last lines say the file: pins are not for a commit");
  const inline = harness({ registry: noRegistry });
  ok((await runUpgradeCommand([`--from=${dir}`, "--plan"], inline.io, fixtureApp())) === 0, "…and --from=<dir> is the same flag");
}

{
  const root = fixtureApp();
  const before = readFileSync(join(root, "package.json"), "utf8");
  const dir = releaseDir(FULL_SET.filter((p) => p.name !== "@open-everywhere/adapters"));
  const h = harness({ registry: noRegistry });
  ok((await runUpgradeCommand(["--from", dir], h.io, root)) === 1, "🔴 --from refuses when the app pins a package the directory holds no tarball for");
  ok(h.text().includes("@open-everywhere/adapters"), "…and names it");
  ok(h.calls.length === 0 && readFileSync(join(root, "package.json"), "utf8") === before, "…and it writes nothing and spawns nothing");
  const wrongTo = harness({ registry: noRegistry });
  ok((await runUpgradeCommand(["--from", releaseDir(FULL_SET), "--to", "0.1.9"], wrongTo.io, root)) === 1, "…and --to a version the directory does not hold refuses too");
  ok(wrongTo.text().includes("holds no 0.1.9 tarball for @open-everywhere/core"), `…and it refuses on the whole-set check, not on a later read — got ${wrongTo.text()}`);
}

{
  const first = releaseDir(FULL_SET);
  const rehearsed = async (): Promise<string> => {
    const root = fixtureApp({ scopedScaffolder: true });
    const h = harness({
      registry: noRegistry,
      onRun: (c) => {
        if (c.args[0] === "install") writeFileSync(join(root, "node_modules", "@open-everywhere", "core", "package.json"), JSON.stringify({ name: CORE, version: LATEST, bin: { oe: "./bin/oe.js" } }));
        return 0;
      },
    });
    assert.equal(await runUpgradeCommand(["--from", first], h.io, root), 0, `the fixture rehearsal failed:\n${h.text()}`);
    return root;
  };
  const viaRegistry = await rehearsed();
  ok(JSON.parse(readFileSync(join(viaRegistry, "package.json"), "utf8")).dependencies["@open-everywhere/core"].startsWith("file:"), "the fixture: the rehearsal left file: pins and core at the target");
  const reg = harness();
  ok((await runUpgradeCommand([], reg.io, viaRegistry)) === 0, `a registry run over the rehearsed app exits 0 — got\n${reg.text()}`);
  ok(!reg.text().includes("Nothing to do"), `🔴 …and it does NOT report "Nothing to do" over file: pins\n${reg.text()}`);
  ok(reg.text().includes("Re-pinning and re-installing"), "…and it says why it runs");
  const pins = JSON.parse(readFileSync(join(viaRegistry, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  ok(pins.dependencies["@open-everywhere/core"] === LATEST && pins.devDependencies["@open-everywhere/create"] === LATEST, `…and it re-pins the set to ${LATEST} — got ${JSON.stringify(pins)}`);
  ok(reg.calls.some((c) => c.args[0] === "install"), "…and it re-installs");

  const repacked = await rehearsed();
  const second = releaseDir(FULL_SET);
  const again = harness({ registry: noRegistry });
  ok((await runUpgradeCommand(["--from", second], again.io, repacked)) === 0 && !again.text().includes("Nothing to do"), `🔴 …and --from a re-packed release in another directory re-pins too — got\n${again.text()}`);
  ok(JSON.parse(readFileSync(join(repacked, "package.json"), "utf8")).dependencies["@open-everywhere/core"] === `file:${join(second, `open-everywhere-core-${LATEST}.tgz`)}`, "…onto the new directory's tarball");
  const same = harness({ registry: noRegistry });
  ok((await runUpgradeCommand(["--from", second], same.io, repacked)) === 0 && same.text().includes("Nothing to do"), `…the negative control: the same directory again has nothing to do — got\n${same.text()}`);
}

{
  const root = fixtureApp();
  const checkout = mkdtempSync(join(tmpdir(), "oe-upgrade-checkout-"));
  mkdirSync(join(checkout, "packages", "core"), { recursive: true });
  writeFileSync(join(checkout, "packages", "core", "package.json"), "{}");
  const h = harness({ registry: noRegistry });
  ok((await runUpgradeCommand(["--from", checkout], h.io, root)) === 1, "--from on a checkout with no tarballs refuses");
  ok(h.text().includes("npm pack --workspaces --pack-destination"), "…and says how to pack the checkout");
  const empty = harness();
  ok((await runUpgradeCommand(["--from"], empty.io, root)) === 2, "…and --from with no directory is a usage error");
}

{
  const root = fixtureApp();
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [TSX_CLI, CLI, "upgrade", "--to", "0.0.1"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as ChildResult & { stdout?: string; stderr?: string };
    status = finishedRun(e, "`oe upgrade --to 0.0.1`").status;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  ok(status === 1, `🔴 \`oe upgrade\` is REACHABLE through the oe bin — exit 1 on the downgrade, got ${status}`);
  ok(output.includes("does not downgrade"), "…and the dispatcher's output is the command's own refusal");
}

{
  const root = fixtureApp();
  const runCli = (args: readonly string[]): { status: number; output: string } => {
    try {
      const output = execFileSync(process.execPath, [TSX_CLI, CLI, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, output };
    } catch (err) {
      const e = err as ChildResult & { stdout?: string; stderr?: string };
      return { status: finishedRun(e, `oe ${args.join(" ")}`).status, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const unknown = runCli(["upgrade-codemods", "nobody-wrote-this"]);
  ok(unknown.status === 1, `🔴 \`oe upgrade-codemods\` is REACHABLE and refuses an unknown id — got exit ${unknown.status}`);
  ok(unknown.output.includes("nobody-wrote-this") && unknown.output.includes("no codemod ran"), "…and names it, and says no codemod ran");
  const bare = runCli(["upgrade-codemods"]);
  ok(bare.status === 2, `…and with no id it is a usage error — got exit ${bare.status}`);
}

{
  const root = fixtureApp({ notes: recordOf(note({ manualSteps: ["x".repeat(300_000)] })) });
  const dir = releaseDir(FULL_SET);
  const child = spawn(process.execPath, [TSX_CLI, CLI, "upgrade", "--plan", "--from", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<number | null>((done) => child.on("close", done));
  child.stdout.pause();
  await new Promise((done) => setTimeout(done, 1500));
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (output += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (output += d));
  child.stdout.resume();
  const status = await closed;
  ok(status === 0, `the slow-reader plan exits 0 — got ${status}\n${output.slice(-2000)}`);
  ok(output.length > 300_000, `🔴 the oe bin flushes its whole plan before it exits — got ${output.length} characters`);
  ok(output.includes("✓ oe upgrade --plan: nothing was written."), "…and the plan's last line arrives");
}

console.log(`✓ oe upgrade: ${passed} assertions.`);
