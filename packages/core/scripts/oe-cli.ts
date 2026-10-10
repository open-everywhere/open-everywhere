#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  declaredPackages,
  goldenPlanLines,
  ownedSlotDirs,
  parseRosterConfig,
  planRoster,
  type PlanResult,
} from "../agent/scaffold/roster-plan.js";
import { SLOT_DIR } from "../agent/scaffold/roster-config.js";
import { readEveFrameworkTools } from "./eve-framework-tools.js";
import {
  CONFIG_FILE,
  applyPlan,
  diffAgainstDisk,
  findRepoRoot,
  loadMcpServerNames,
  loadRosterConfig,
  readLock,
  resolvePackages,
  unresolvableSpecifiers,
  writeLock,
} from "../agent/scaffold/roster-fs.js";

const GOLDEN = "scripts/goldens/roster-plan.txt";

const argv = process.argv.slice(2);
const subcommand = argv[0] ?? "build";

if (subcommand === "wrap-untrusted") {
  const { runWrapUntrusted } = await import("./oe-wrap-untrusted.js");
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c: Buffer) => chunks.push(c));
  process.stdin.on("end", () => process.stdout.write(runWrapUntrusted(argv.slice(1), Buffer.concat(chunks).toString("utf8"))));
} else if (subcommand === "secret") {
  const { runSecretCommand, readAllStdin } = await import("./oe-secret.js");
  const code = await runSecretCommand(argv.slice(1), {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    readStdin: readAllStdin,
  });
  process.exit(code);
} else if (subcommand === "env") {
  const { runEnvCommand, readValueFromTerminalOrStdin } = await import("./oe-env.js");
  process.exit(
    await runEnvCommand(argv.slice(1), { out: (l) => console.log(l), err: (l) => console.error(l), readValue: readValueFromTerminalOrStdin }),
  );
} else if (subcommand === "upgrade") {
  const { runUpgradeCommand, realUpgradeIo } = await import("./oe-upgrade.js");
  await exitAfterFlush(await runUpgradeCommand(argv.slice(1), realUpgradeIo(), process.cwd()));
} else if (subcommand === "upgrade-codemods") {
  const { runUpgradeCodemodsCommand } = await import("./oe-upgrade.js");
  process.exit(runUpgradeCodemodsCommand(argv.slice(1), { out: (l) => console.log(l), err: (l) => console.error(l) }, process.cwd()));
} else if (subcommand === "overlays") {
  const { runOverlaysCommand } = await import("./oe-overlays.js");
  process.exit(runOverlaysCommand(argv.slice(1), { out: (l) => console.log(l), err: (l) => console.error(l) }, process.cwd()));
} else if (subcommand === "build" || subcommand.startsWith("--")) {
  await runBuild(subcommand === "build" ? argv.slice(1) : argv);
} else {
  console.error(`oe: unknown subcommand "${subcommand}". Known: build, env, overlays, upgrade, secret, wrap-untrusted.`);
  process.exit(2);
}

async function exitAfterFlush(code: number): Promise<never> {
  process.stdout.once("error", () => process.exit(code));
  process.stderr.once("error", () => process.exit(code));
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  await new Promise<void>((done) => process.stderr.write("", () => done()));
  process.exit(code);
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 1);
}

async function frameworkToolNames(repoRoot: string): Promise<string[] | undefined> {
  try {
    const tools = await readEveFrameworkTools({ resolveFrom: pathToFileURL(join(repoRoot, "package.json")).href });
    return [...tools.all];
  } catch {
    return undefined;
  }
}

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

async function runBuild(args: readonly string[]): Promise<void> {
  const check = args.includes("--check");
  const show = args.includes("--show");
  const json = args.includes("--json");
  const accept = args.includes("--accept");
  const showPath = show ? flagValue(args, "--show") : undefined;
  const againstSummary = flagValue(args, "--against-summary");

  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) {
    fail([`✗ oe build: no ${CONFIG_FILE} found in ${process.cwd()} or any parent directory.`]);
  }

  const loaded = await loadRosterConfig(repoRoot);
  if (loaded.error !== undefined) fail([`✗ oe build: ${loaded.error}`]);
  const parsed = parseRosterConfig(loaded.raw);
  if (parsed.config === undefined) fail(["✗ oe build: roster.config.ts is not valid.", ...parsed.reds.map((r) => `  - ${r}`)]);

  const agentDir = parsed.config.output?.agentDir ?? "agent";
  const lockRead = readLock(repoRoot);
  if (lockRead.error !== undefined) fail([`✗ oe build: ${lockRead.error}`]);

  const mcpServers = await loadMcpServerNames(repoRoot, agentDir);
  if (mcpServers.error !== undefined) fail([`✗ oe build: ${mcpServers.error}`]);

  const packages = await resolvePackages(repoRoot, declaredPackages(parsed.config));
  const plan = planRoster({
    config: parsed.config,
    lock: lockRead.lock,
    acceptLock: accept,
    packages,
    frameworkToolNames: await frameworkToolNames(repoRoot),
    agentDir,
    mcpServers: mcpServers.names,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(buildReport(plan, packages), null, 2)}\n`);
    await exitAfterFlush(plan.verdict === "invalid" ? 1 : 0);
  }

  if (show) {
    for (const file of plan.files) {
      if (showPath !== undefined && file.path !== showPath) continue;
      console.log(`── ${file.path} ${"─".repeat(Math.max(0, 96 - file.path.length))}`);
      process.stdout.write(file.content);
    }
    if (plan.reds.length > 0) {
      for (const line of ["", "✗ oe build --show: the plan above is not buildable:", ...plan.reds.map((r) => `  - ${r}`)]) console.error(line);
      await exitAfterFlush(1);
    }
    await exitAfterFlush(0);
  }

  if (plan.verdict === "invalid" || plan.verdict === "vanished" || plan.verdict === "unreviewed") {
    fail([`✗ oe build: ${plan.reds.length} problem(s) — NOTHING was written.`, ...plan.reds.map((r) => `  - ${r}`)]);
  }

  const bad = unresolvableSpecifiers(
    repoRoot,
    plan.resolved.filter((r) => r.decision === "mounted").map((r) => `${r.package}/${r.module}`),
  );
  if (bad.length > 0) {
    fail([
      `✗ oe build: ${bad.length} planned import(s) do not resolve — NOTHING was written.`,
      ...bad.map(([s, why]) => `  - ${s}: ${why}`),
      "",
      "  A manifest offers a module its package does not ship. Fix the package's agent/contributions.ts.",
    ]);
  }

  const owned = ownedSlotDirs(agentDir);
  const goldenLines = goldenPlanLines(plan, agentDir);

  if (check) {
    const diff = diffAgainstDisk(repoRoot, plan.files, owned);
    const problems: string[] = [];
    const absent = diff.written.filter((p) => !existsSync(join(repoRoot, p)));
    const drifted = diff.written.filter((p) => existsSync(join(repoRoot, p)));
    if (absent.length > 0 && drifted.length === 0 && diff.unchanged.length === 0) {
      problems.push(`NOT BUILT · the slot tree is not built yet (${absent.length} file(s)). Run \`npm run build\`, or \`npx oe build\` to write only the tree.`);
    } else {
      for (const p of absent) problems.push(`NOT BUILT · ${p} is not built yet. Run \`npm run build\`, or \`npx oe build\`.`);
    }
    for (const p of drifted) problems.push(`DRIFTED · ${p} differs from the plan (hand-edited, or the build is stale).`);
    for (const p of diff.deleted) problems.push(`STRAY · ${p} is in an owned slot directory but not in the plan.`);
    const goldenPath = join(repoRoot, GOLDEN);
    if (existsSync(goldenPath) && readFileSync(goldenPath, "utf8") !== `${goldenLines.join("\n")}\n`) {
      problems.push(`GOLDEN · ${GOLDEN} does not match the plan. Fix: \`npm run oe:build -- --accept\` and READ the diff — it is the roster review surface.`);
    }
    const { overlayCheckLines } = await import("./oe-overlays.js");
    const overlays = overlayCheckLines(repoRoot);
    const treeProblems = problems.length;
    problems.push(...overlays.problems);
    if (problems.length > 0) {
      const fixes = [""];
      if (treeProblems > 0) fixes.push("  Fix: `npm run oe:build`.");
      if (!overlays.ok) fixes.push("  Overlays: edit only the data, then `npx oe overlays normalize`.");
      fail([`✗ oe build --check: ${problems.length} problem(s).`, ...problems.map((p) => `  - ${p}`), ...fixes]);
    }
    for (const n of overlays.notes) console.log(n);
    printRollCall(plan, "check");
    if (againstSummary !== undefined) assertAgainstSummary(repoRoot, againstSummary, plan);
    process.exit(0);
  }

  if (accept) {
    writeLock(repoRoot, plan.lock);
    console.log(`✓ wrote roster.lock.json — READ THE DIFF: every line is a capability decision.`);
  }

  const applied = applyPlan(repoRoot, plan.files, owned);
  const goldenPath = join(repoRoot, GOLDEN);
  const golden = `${goldenLines.join("\n")}\n`;
  if ((existsSync(dirname(goldenPath)) || accept) && !(existsSync(goldenPath) && readFileSync(goldenPath, "utf8") === golden)) {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, golden);
  }
  for (const p of applied.skipped) console.log(`  · left alone (a directory, not a slot file): ${p}`);
  console.log(
    `✓ oe build: ${plan.files.length} file(s) — ${applied.written.length} written, ` +
      `${applied.unchanged.length} unchanged, ${applied.deleted.length} deleted.`,
  );
  printRollCall(plan, "build");
  if (againstSummary !== undefined) assertAgainstSummary(repoRoot, againstSummary, plan);
}

function printRollCall(plan: PlanResult, mode: string): void {
  const byPackage = new Map<string, { mounted: number; excluded: string[] }>();
  for (const r of plan.resolved) {
    const row = byPackage.get(r.package) ?? { mounted: 0, excluded: [] };
    if (r.decision === "mounted") row.mounted++;
    else row.excluded.push(`${r.kind}/${r.name}`);
    byPackage.set(r.package, row);
  }
  for (const [pkg, row] of [...byPackage].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${pkg}: ${row.mounted} mounted${row.excluded.length > 0 ? `, ${row.excluded.length} excluded` : ""}`);
    if (row.excluded.length > 0) console.log(`    excluded: ${row.excluded.sort().join(", ")}`);
  }
  const disabled = Object.keys(plan.frameworkDisabled).sort();
  console.log(`  eve built-ins declined by sentinel: ${disabled.length > 0 ? disabled.join(", ") : "(none)"}`);
  console.log(`  providers selected: ${plan.selectedProviders.length > 0 ? plan.selectedProviders.join(", ") : "(none)"} [${mode}]`);
  console.log(`  MCP servers declared by the app: ${plan.mcpServers.length > 0 ? plan.mcpServers.join(", ") : "(none)"}`);
}

function buildReport(plan: PlanResult, packages: readonly { name: string; version?: string }[]): unknown {
  const names = [...new Set([...packages.map((p) => p.name), ...Object.keys(plan.lock.packages)])].sort();
  return {
    schemaVersion: 1,
    verdict: plan.verdict,
    packages: names.map((name) => ({
      name,
      installedVersion: packages.find((p) => p.name === name)?.version ?? null,
      lockedVersion: plan.lock.packages[name]?.version ?? null,
      unreviewed: plan.unreviewed.filter((u) => u.package === name),
      vanished: plan.vanished.filter((v) => v.package === name),
    })),
    suggestedConfigPatch: plan.unreviewed.map((u) => ({
      path: [u.package, "exclude", u.name],
      op: "add",
      valueHint: "<reason this deployment declines it>",
    })),
    roster: {
      mounted: plan.resolved.filter((r) => r.decision === "mounted").length,
      excluded: plan.resolved.filter((r) => r.decision === "excluded").length,
      frameworkDisabled: Object.keys(plan.frameworkDisabled).length,
    },
    reds: plan.reds,
  };
}

function assertAgainstSummary(repoRoot: string, summaryPath: string, plan: PlanResult): void {
  const abs = join(repoRoot, summaryPath);
  if (!existsSync(abs)) fail([`✗ oe build --against-summary: ${summaryPath} does not exist — run \`npm run build\` first.`]);
  let summary: Record<string, { name?: string }[] | undefined>;
  try {
    summary = JSON.parse(readFileSync(abs, "utf8")) as Record<string, { name?: string }[]>;
  } catch (err) {
    return fail([`✗ oe build --against-summary: ${summaryPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`]);
  }
  const missing: string[] = [];
  for (const [kind, section] of [
    ["channel", "channels"],
    ["schedule", "schedules"],
    ["connection", "connections"],
  ] as const) {
    const present = new Set((summary[section] ?? []).map((e) => e.name).filter((n): n is string => typeof n === "string"));
    for (const r of plan.resolved) {
      if (r.kind !== kind || r.decision !== "mounted") continue;
      if (!present.has(r.name)) missing.push(`${SLOT_DIR[kind]}/${r.name}`);
    }
    if (kind === "connection") {
      for (const name of plan.mcpServers) if (!present.has(name)) missing.push(`${SLOT_DIR[kind]}/${name}`);
    }
  }
  if (missing.length > 0) {
    fail([
      `✗ oe build --against-summary: eve resolved a tree missing ${missing.length} statically-mounted name(s):`,
      ...missing.sort().map((m) => `  - ${m}`),
      "",
      "  The built artefact does not carry what the roster plans. Run `oe build`, then `npm run build` again.",
    ]);
  }
  console.log(`✓ oe build --against-summary: every statically-mounted channel/schedule/connection is present in ${summaryPath}.`);
}
