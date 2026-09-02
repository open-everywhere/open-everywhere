import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EAGER_SETTINGS_READ_ALLOWLIST,
  auditEagerReads,
  eagerReadKey,
  siteFromStack,
  type EagerSettingsRead,
} from "./settings-read-probe.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(root, "scripts", "settings-boot-order-lint.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const EAGER_FIXTURE = "scripts/fixtures/settings-boot-order/eager-read.ts";
const LAZY_FIXTURE = "scripts/fixtures/settings-boot-order/lazy-read.ts";

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

function lint(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, LINT, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function stack(...frames: string[]): string {
  return ["Error: eager settings read", ...frames.map((f) => `    at ${f}`)].join("\n");
}

const PROBE_FILE = "scripts/settings-read-probe.ts";
const read = (file: string, accessor: string, line = 1): EagerSettingsRead => ({ file, line, accessor });

function main(): void {
  {
    const r = lint("--fixture", EAGER_FIXTURE);
    ok(r.code !== 0, `an eager module-level settings read fails the gate (exit ${r.code})`);
    ok(r.out.includes(EAGER_FIXTURE), "…naming the module that performed the read");
    ok(r.out.includes("oneshotAgentEnabled"), "…and the accessor it reached settings through");
    ok(r.out.includes("MODULE LEVEL"), "…saying what is wrong with it, not just that something is");
    ok(r.out.includes("Move the read to the point of use"), "…and printing the remedy once, under the list");
  }

  {
    const r = lint("--fixture", LAZY_FIXTURE);
    ok(r.code === 0, `a module-level read that supplies its own overrides is silent (exit ${r.code}: ${r.out})`);
  }

  const fullGate = lint("--list");
  {
    const r = fullGate;
    ok(r.code === 0, `the tree has no eager settings read on any entry (exit ${r.code}: ${r.out})`);
    ok(/\d+ module URL\(s\) resolved/.test(r.out), "…and the run reports its own coverage");
    ok(/\d+ settings read\(s\) before registerSettings\(\)/.test(r.out), "…with the read count it measured");
    ok(r.out.includes("module URL(s) resolved (reach)"), "…the green line names the reach count as reach");
    ok(/\d+ script\(s\) evaluated \(arm ⑤\)/.test(r.out), "…and the evaluation count beside it");
    const evaluatedTotal = Number(/(\d+) script\(s\) evaluated \(arm ⑤\)/.exec(r.out)?.[1] ?? "0");
    ok(evaluatedTotal > 0, `…and the evaluation count is a real measurement, not a zero (saw ${evaluatedTotal})`);
  }

  {
    const r = fullGate;
    ok(r.out.includes("agent/agent.js:"), "the default entry list boots the agent definition");
    ok(r.out.includes("agent/sandbox/sandbox.js:"), "…and the sandbox definition, whose pre-register imports nothing else reaches");
    ok(
      r.out.includes("agent/instrumentation.js:"),
      "…and the instrumentation entry, which never registers at all, so its whole graph is pre-registration",
    );
    for (const slot of ["agent/tools:", "agent/hooks:", "agent/channels:"]) {
      ok(r.out.includes(slot), `the entry list boots the ${slot.slice(0, -1)} slot root`);
    }
    ok(/agent\/tools: (\d+) module\(s\) imported/.test(r.out), "…and a slot-root child reports how many modules it imported");
    const imported = Number(/agent\/tools: (\d+) module\(s\) imported/.exec(r.out)?.[1] ?? "0");
    ok(imported > 1, `…which is the directory, not a single module (saw ${imported})`);
  }

  {
    const r = lint("--entry", LAZY_FIXTURE, "--floor", "100000");
    ok(r.code !== 0, `an entry that never registers settings fails the gate (exit ${r.code})`);
    ok(r.out.includes("never reached registerSettings()"), "…arm ③ says the registration point is missing");
    ok(r.out.includes("under its declared floor"), "…and arm ⑤ says the graph it walked is under its floor");
    ok(r.out.includes(LAZY_FIXTURE), "…both naming the entry, since the floor is now per entry");
    ok(r.out.includes("This arm counts REACH"), "…and arm ⑤'s reach red says which count it is");

    const bad = lint("--entry", LAZY_FIXTURE, "--floor", "lots");
    ok(bad.code !== 0, "--floor takes a whole number");
  }

  {
    const r = lint("--entry", LAZY_FIXTURE, "--eval-floor", "100000");
    ok(r.code !== 0, `an entry under its evaluation floor fails the gate (exit ${r.code})`);
    ok(r.out.includes("under its declared evaluation floor"), "…arm ⑤ says which floor it missed");
    ok(!r.out.includes("under its declared floor of"), "…and the REACH half stays green, so the two halves are separable");

    const child = lint("--child", LAZY_FIXTURE);
    const line = child.out.split("\n").find((l) => l.startsWith("OE_BOOT_ORDER_RESULT "));
    const report = JSON.parse(line!.slice("OE_BOOT_ORDER_RESULT ".length)) as Record<string, unknown>;
    ok(typeof report.evaluated === "number", "the child reports a whole-graph evaluation count");
    ok((report.evaluated as number) > 0, `…and it is a real count for a fixture that does evaluate (saw ${report.evaluated})`);

    const bad = lint("--entry", LAZY_FIXTURE, "--eval-floor", "lots");
    ok(bad.code !== 0, "--eval-floor takes a whole number");
  }

  {
    const r = lint("--entry", "agent/lib/register-config.js", "--registers", "false");
    ok(r.code !== 0, `an entry declared registers:false that DOES register fails the gate (exit ${r.code})`);
    ok(r.out.includes("DID reach registerSettings()"), "…naming the stale declaration, not a missing one");

    const bad = lint("--entry", "agent/agent.js", "--registers", "maybe");
    ok(bad.code !== 0, "--registers takes only true or false");
  }

  {
    const r = lint("--entry", "agent/no-such-module.js");
    ok(r.code !== 0, `an entry whose boot dies fails the gate (exit ${r.code})`);
    ok(r.out.includes("produced no result"), "…saying the boot produced no result, not that the tree is clean");
    ok(r.out.includes("agent/no-such-module.js"), "…and naming the entry that could not boot");
    ok(
      !r.out.includes("0 settings read(s) before registerSettings()"),
      "…and never printing the clean-tree verdict over an entry it failed to walk",
    );
  }

  {
    const listed = fullGate;
    ok(listed.code === 0, `--list runs the gate (exit ${listed.code})`);
    ok(
      /module\(s\) imported, \d+ module URL\(s\) resolved, \d+ script\(s\) evaluated, \d+ trap\(s\)/.test(listed.out),
      "…and prints what each entry walked",
    );
    const evaluated = [...listed.out.matchAll(/(\d+) script\(s\) evaluated, \d+ trap\(s\)/g)].map((m) => Number(m[1]));
    ok(evaluated.length === 6, `every booted entry reports its evaluation count (saw ${evaluated.length})`);
    ok(
      evaluated.every((n) => n > 0),
      `…and each is a real count, not a zero standing in for one (saw ${JSON.stringify(evaluated)})`,
    );
    ok(listed.out.includes("windowGated()"), "…and a slot-root boot's excused reads are listed, not hidden");

    const missing = lint("--fixture", "scripts/fixtures/settings-boot-order/not-a-file.ts");
    ok(missing.code !== 0, "a --fixture path that does not exist is refused");
    ok(missing.out.includes("does not exist"), "…saying which one, rather than silently booting anyway");

    const bare = lint("--fixture");
    ok(bare.code !== 0, "a bare --fixture with no path is refused");
  }

  {
    const child = lint("--child", LAZY_FIXTURE);
    ok(child.code === 0, `the child boots a lone fixture entry (exit ${child.code}: ${child.out})`);
    const line = child.out.split("\n").find((l) => l.startsWith("OE_BOOT_ORDER_RESULT "));
    ok(line !== undefined, "…and reports on its marker line");
    const report = JSON.parse(line!.slice("OE_BOOT_ORDER_RESULT ".length)) as Record<string, unknown>;
    ok(typeof report.resolutions === "number", "the resolve-hook count is reported as `resolutions`");
    ok(typeof report.evaluated === "number", "…and the whole-graph evaluation count as `evaluated`");
    ok(!("modules" in report), "…and neither is reported under the old `modules` name");
    ok(!("evaluatedCjs" in report), "…nor the CommonJS-only count the whole-graph one replaced");
    ok((report.resolutions as number) > 0, "a fixture entry still resolves its own graph");
  }

  {
    const r = lint("--entry", "packages/core/agent/tools/checkout_repo.js", "--registers", "false");
    ok(r.code !== 0, `the excused read still reds when it is NOT the slot-root entry (exit ${r.code})`);
    ok(r.out.includes("checkout_repo.ts"), "…naming the module that performed it");
    ok(r.out.includes("windowGated"), "…and the accessor, which is exactly the key the slot-root entry excuses");
  }

  {
    const r = lint("--entry", "agent/no-such-slot-root", "--slot-root");
    ok(r.code !== 0, `an absent slot root fails the gate (exit ${r.code})`);
    ok(r.out.includes("does not exist"), "…saying the directory is not there");
    ok(r.out.includes("npm run oe:build"), "…and naming the command that materialises it");
    ok(
      !r.out.includes("settings read(s) before registerSettings()"),
      "…and never printing the clean-tree verdict over a slot root it never walked",
    );

    const asModule = lint("--entry", "agent/no-such-slot-root");
    ok(asModule.out.includes("produced no result"), "an undeclared entry that cannot boot is still the dead-boot red");
  }

  {
    const s = stack(
      `Object.get (${root}/${PROBE_FILE}:170:20)`,
      `getSettings (${root}/packages/core/agent/settings/settings.ts:1194:82)`,
      `oneshotAgentEnabled (${root}/packages/core/agent/access/delegation-flag.ts:71:10)`,
      `<anonymous> (${root}/agent/lib/register-config.ts:15:28)`,
      "ModuleJob.run (node:internal/modules/esm/module_job:561:25)",
      `async <anonymous> (${root}/scripts/settings-boot-order-lint.ts:14:1)`,
    );
    const site = siteFromStack(s, root, PROBE_FILE);
    ok(site !== null, "a real trapped stack resolves to a site");
    ok(site?.file === "agent/lib/register-config.ts", `the site is the reading module, repo-relative (got ${site?.file})`);
    ok(site?.line === 15, `…with the line that read it (got ${site?.line})`);
    ok(site?.accessor === "oneshotAgentEnabled", `…and the accessor above it (got ${site?.accessor})`);
  }

  {
    const s = stack(
      `Object.get (${root}/${PROBE_FILE}:170:20)`,
      `getSettings (${root}/packages/core/agent/settings/settings.ts:1194:82)`,
      `<anonymous> (${root}/packages/core/agent/access/window-gate-manifest.ts:75:30)`,
      "ModuleJob.run (node:internal/modules/esm/module_job:561:25)",
      `async <anonymous> (${root}/scripts/settings-boot-order-lint.ts:14:1)`,
    );
    const site = siteFromStack(s, root, PROBE_FILE);
    ok(
      site?.file === "packages/core/agent/access/window-gate-manifest.ts",
      `the loader frame ends the user chain (got ${site?.file})`,
    );
    ok(site?.accessor === "getSettings", `…and a direct read names the resolver itself (got ${site?.accessor})`);
  }

  {
    ok(siteFromStack(stack("ModuleJob.run (node:internal/modules/esm/module_job:561:25)"), root, PROBE_FILE) === null,
      "a stack whose first frame is the loader resolves to no site");
    ok(siteFromStack(stack(`Object.get (${root}/${PROBE_FILE}:170:20)`), root, PROBE_FILE) === null,
      "…and a stack that is nothing but this module's own frames resolves to no site either");
    ok(siteFromStack("", root, PROBE_FILE) === null, "…and an absent stack does not throw");
  }

  {
    const site = siteFromStack(
      stack(
        `Object.get (${root}/${PROBE_FILE}:170:20)`,
        `getSettings (${root}/packages/core/agent/settings/settings.ts:1194:82)`,
        `file://${root}/agent/lib/register-config.ts:15:28`,
        "ModuleJob.run (node:internal/modules/esm/module_job:561:25)",
      ),
      root,
      PROBE_FILE,
    );
    ok(site?.file === "agent/lib/register-config.ts", `a bare-location frame is still a site (got ${site?.file})`);
    ok(site?.accessor === "getSettings", "…and the accessor still comes from the frame above it");
  }

  {
    ok(
      eagerReadKey(read("a/b.ts", "fullKit", 10)) === eagerReadKey(read("a/b.ts", "fullKit", 99)),
      "the same read keeps its key when it moves down the file",
    );
    ok(
      eagerReadKey(read("a/b.ts", "fullKit")) !== eagerReadKey(read("a/b.ts", "oneshotAgentEnabled")),
      "…but a different accessor in the same file is a different key",
    );
    ok(
      eagerReadKey(read("a/b.ts", "fullKit")) !== eagerReadKey(read("a/c.ts", "fullKit")),
      "…and so is the same accessor in a different file",
    );
  }

  {
    const observed = [read("packages/core/agent/access/window-gate-manifest.ts", "fullKit", 75)];
    const none = auditEagerReads(observed, new Map());
    ok(none.length === 1, `an unexcused eager read is one problem (got ${none.length})`);
    ok(none[0].includes("window-gate-manifest.ts:75"), "…naming the file and line");
    ok(none[0].includes("fullKit"), "…and the accessor");

    const excused = auditEagerReads(observed, new Map([[eagerReadKey(observed[0]), "a stated reason"]]));
    ok(excused.length === 0, `an allowlisted read is silent (got ${JSON.stringify(excused)})`);
  }

  {
    const stale = auditEagerReads([], new Map([["packages/core/agent/gone.ts::fullKit", "fixed last month"]]));
    ok(stale.length === 1, `a dead allowlist entry is a problem (got ${stale.length})`);
    ok(stale[0].includes("packages/core/agent/gone.ts::fullKit"), "…naming the entry to delete");
    ok(auditEagerReads([], new Map()).length === 0, "…while an empty list over an empty tree is silent");
  }

  {
    ok(
      EAGER_SETTINGS_READ_ALLOWLIST.size === 0,
      `the survivor allowlist holds ${EAGER_SETTINGS_READ_ALLOWLIST.size} entr(ies), pinned at 0`,
    );
    for (const [key, reason] of EAGER_SETTINGS_READ_ALLOWLIST) {
      ok(reason.trim().length > 20, `allowlist entry ${key} carries a real reason, not a placeholder`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  (${passed} assertion(s) passed before the failure)`);
  process.exit(1);
}

console.log(
  `\n✓ settings boot-order gate: ${passed} assertions passed ` +
    `(${EAGER_SETTINGS_READ_ALLOWLIST.size} allowlisted survivor(s))\n`,
);
