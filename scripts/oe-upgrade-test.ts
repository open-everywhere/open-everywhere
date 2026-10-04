import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runUpgradeCommand, type UpgradeIo, type UpgradeRegistry } from "../packages/core/scripts/oe-upgrade.js";

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
  const root = fixtureApp({ notes: recordOf(note({ env: { added: ["OE_NEW_NAME"], removed: ["OE_OLD_NAME"] }, manualSteps: ["re-paste the Slack manifest"] })) });
  const h = harness();
  const code = await runUpgradeCommand([], h.io, root);
  ok(code === 0, "a clean upgrade exits 0");

  const pkg = manifestOf(root);
  ok(pkg.dependencies["@open-everywhere/core"] === LATEST, "core is bumped to the target");
  ok(pkg.dependencies["@open-everywhere/adapters"] === LATEST, "🔴 every @open-everywhere/* package bumps WITH it — the nine publish in lockstep");
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

{
  const root = fixtureApp();
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [TSX_CLI, CLI, "upgrade", "--to", "0.0.1"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1;
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
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const unknown = runCli(["upgrade-codemods", "nobody-wrote-this"]);
  ok(unknown.status === 1, `🔴 \`oe upgrade-codemods\` is REACHABLE and refuses an unknown id — got exit ${unknown.status}`);
  ok(unknown.output.includes("nobody-wrote-this") && unknown.output.includes("no codemod ran"), "…and names it, and says no codemod ran");
  const bare = runCli(["upgrade-codemods"]);
  ok(bare.status === 2, `…and with no id it is a usage error — got exit ${bare.status}`);
}

console.log(`✓ oe upgrade: ${passed} assertions.`);
