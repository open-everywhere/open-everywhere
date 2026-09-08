import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PRIMITIVE_DISABLED,
  PRIMITIVE_MOUNTED,
  classifyPrimitiveSource,
  classifyRosterTransition,
  coreToolSpecifier,
  diffToolRoster,
  isConventionFile,
  reexportSpecifierOf,
  rosterDriftIsClean,
  rosterToolNameOf,
} from "@open-everywhere/core/agent/scaffold/tool-roster.js";
import {
  readCoreToolExports,
  readToolRoster,
  resolveCoreToolsDir,
} from "@open-everywhere/core/agent/scaffold/tool-roster-read.js";
import { diffConfigSnapshots, renderConfigDiff, toolRosterFindings, type ConfigSnapshot } from "./config-snapshot-diff.js";
import { readEveFrameworkTools } from "../packages/core/scripts/eve-framework-tools.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

{
  ok(
    classifyPrimitiveSource('export { default } from "@open-everywhere/core/agent/tools/reply.js";\n') === PRIMITIVE_MOUNTED,
    "a re-export classifies as mounted",
  );
  ok(
    classifyPrimitiveSource('import { disableTool } from "eve/tools";\n\nexport default disableTool();\n') === PRIMITIVE_DISABLED,
    "a disableTool() sentinel classifies as declined",
  );
  ok(classifyPrimitiveSource("export  default   disableTool ( ) ;") === PRIMITIVE_DISABLED, "sentinel detection is whitespace-insensitive");
  ok(
    classifyPrimitiveSource('// we do not disableTool() this one\nexport { default } from "x.js";\n') === PRIMITIVE_MOUNTED,
    "a comment mentioning disableTool() does not make a file a sentinel",
  );

  ok(reexportSpecifierOf('export { default } from "@pkg/x.js";') === "@pkg/x.js", "the re-exported specifier is read off the statement");
  ok(reexportSpecifierOf("export default disableTool();") === undefined, "a sentinel re-exports nothing");

  ok(isConventionFile("reply.ts"), "a .ts file is a convention file");
  ok(!isConventionFile("_helpers.ts"), "an underscore-prefixed file is not mounted by eve, so not a roster member");
  ok(!isConventionFile("README.md"), "a non-.ts file is not a roster member");
}

const scratch = mkdtempSync(join(tmpdir(), "oe-tool-roster-test-"));
try {
  const coreDir = join(scratch, "core-tools");
  const appDir = join(scratch, "app-tools");
  mkdirSync(coreDir);
  mkdirSync(appDir);
  for (const name of ["alpha", "beta", "gamma"]) writeFileSync(join(coreDir, `${name}.ts`), "export default {};\n");

  const core = readCoreToolExports(coreDir);
  ok(core.length === 3, "readCoreToolExports enumerates core's tool files");
  ok(core[0].specifier === coreToolSpecifier("alpha"), "each core export carries the specifier a shim must name");

  const shim = (name: string) => `export { default } from "${coreToolSpecifier(name)}";\n`;
  const sentinel = (name: string, reason: string) =>
    `// ${name} — DECLINED as a static tool: ${reason}\nimport { disableTool } from "eve/tools";\n\nexport default disableTool();\n`;

  writeFileSync(join(appDir, "alpha.ts"), shim("alpha"));
  writeFileSync(join(appDir, "beta.ts"), shim("beta"));
  writeFileSync(join(appDir, "gamma.ts"), sentinel("gamma", "not wanted in this deployment"));
  {
    const drift = diffToolRoster(core, readToolRoster(appDir));
    ok(rosterDriftIsClean(drift), "a roster that mounts two core tools and declines one by sentinel is CLEAN");
    ok(drift.mountedFromCore.map((e) => e.name).join(",") === "alpha,beta", "the two re-exports are counted as mounted from core");
    ok(drift.declined.map((e) => e.name).join(",") === "gamma", "the sentinel is counted as DECLINED, not as a mounted tool");
    ok(drift.missing.length === 0 && drift.extra.length === 0, "nothing is missing and nothing is extra");
  }

  rmSync(join(appDir, "beta.ts"));
  {
    const drift = diffToolRoster(core, readToolRoster(appDir));
    ok(!rosterDriftIsClean(drift), "MISSING: a core tool with no file in the roster makes the drift check RED");
    ok(drift.missing.map((m) => m.name).join(",") === "beta", "the red names the tool that is neither mounted nor declined");
    writeFileSync(join(appDir, "beta.ts"), sentinel("beta", "declined on purpose"));
    const declined = diffToolRoster(core, readToolRoster(appDir));
    ok(rosterDriftIsClean(declined), "the red clears when the tool is DECLINED by sentinel, not only when it is mounted");
    ok(declined.declined.length === 2, "the sentinel is recorded as a declined capability");
  }

  writeFileSync(join(appDir, "beta.ts"), shim("alpha"));
  {
    const drift = diffToolRoster(core, readToolRoster(appDir));
    ok(!rosterDriftIsClean(drift), "MISDIRECTED: a shim whose filename and specifier name different tools is RED");
    ok(drift.misdirected[0]?.name === "beta" && drift.misdirected[0]?.actual === coreToolSpecifier("alpha"), "the red names both sides");
    ok(drift.missing.length === 0, "a misdirected shim is not ALSO reported as missing — one file, one verdict");
  }
  writeFileSync(join(appDir, "beta.ts"), shim("beta"));

  writeFileSync(join(appDir, "delta.ts"), shim("delta"));
  {
    const drift = diffToolRoster(core, readToolRoster(appDir));
    ok(!rosterDriftIsClean(drift), "DANGLING: a shim re-exporting a core tool core no longer has is RED");
    ok(drift.dangling[0]?.name === "delta", "the red names the stale shim");
  }
  rmSync(join(appDir, "delta.ts"));

  writeFileSync(join(appDir, "my_own_tool.ts"), 'export { default } from "@my-org/extras/agent/tools/my_own_tool.js";\n');
  writeFileSync(join(appDir, "bash.ts"), sentinel("bash", "framework tool, re-provided per session grain"));
  {
    const drift = diffToolRoster(core, readToolRoster(appDir));
    ok(rosterDriftIsClean(drift), "a locally-written tool and a framework sentinel are NOT drift");
    ok(drift.extra.map((e) => e.name).sort().join(",") === "bash,my_own_tool", "both are reported as roster members with no core counterpart");
    ok(drift.declined.some((d) => d.name === "bash"), "a sentinel for a framework tool is still counted as declined");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

{
  ok(classifyRosterTransition(PRIMITIVE_DISABLED, PRIMITIVE_MOUNTED) === "gain", "sentinel → real tool is a capability GAIN");
  ok(classifyRosterTransition(undefined, PRIMITIVE_MOUNTED) === "gain", "a new mounted file is a capability GAIN");
  ok(classifyRosterTransition(PRIMITIVE_MOUNTED, PRIMITIVE_DISABLED) === "loss", "real tool → sentinel is a capability loss");
  ok(classifyRosterTransition(PRIMITIVE_MOUNTED, undefined) === "loss", "a deleted mounted file is a capability loss");
  ok(classifyRosterTransition(PRIMITIVE_DISABLED, undefined) === "neutral", "a deleted sentinel takes no capability away");
  ok(classifyRosterTransition("unreadable", "unreadable") === "neutral", "an unchanged unreadable row is neither");

  ok(rosterToolNameOf("tools/reply.ts") === "reply", "a roster row key yields the tool name");
  ok(rosterToolNameOf("tools/") === undefined, "the directory-count row is not a tool");
  ok(rosterToolNameOf("subagents/fresh_eyes_review/tools/bash.ts") === undefined, "a subagent's inner file is not an app roster row");
  ok(rosterToolNameOf("skills/x.ts") === undefined, "a skill is not a tool row");

  const snap = (rows: readonly { key: string; value: string }[]): ConfigSnapshot => ({
    formatVersion: 1,
    sections: ["mounted"],
    rows: rows.map((r) => ({ section: "mounted", ...r })),
  });

  {
    const before = snap([{ key: "tools/bash.ts", value: PRIMITIVE_DISABLED }]);
    const after = snap([{ key: "tools/bash.ts", value: PRIMITIVE_MOUNTED }]);
    const diffed = diffConfigSnapshots(before, after);
    const findings = toolRosterFindings(diffed);
    ok(findings.length === 1, "a sentinel→tool flip raises exactly one finding");
    ok(findings[0].id === "tool-roster-capability-gain", "and it is a capability GAIN, not a neutral row change");
    ok(findings[0].detail.includes("bash"), "the finding names the tool that became mounted");

    const md = renderConfigDiff({ ...diffed, findings }, { baseRef: "base", headRef: "HEAD", changedFiles: ["agent/tools/bash.ts"] });
    ok(md.includes("tool-roster-capability-gain"), "the gain is rendered in the Findings section of the report");
    ok(md.includes("### Findings"), "the report has a Findings section to carry it");
  }

  {
    const loss = toolRosterFindings(
      diffConfigSnapshots(snap([{ key: "tools/react.ts", value: PRIMITIVE_MOUNTED }]), snap([{ key: "tools/react.ts", value: PRIMITIVE_DISABLED }])),
    );
    ok(loss.length === 1 && loss[0].id === "tool-roster-capability-loss", "real tool → sentinel is reported as a loss");

    const neutral = toolRosterFindings(
      diffConfigSnapshots(
        snap([{ key: "tools/", value: "77 entr(y|ies)" }, { key: "tools/react.ts", value: PRIMITIVE_MOUNTED }]),
        snap([{ key: "tools/", value: "78 entr(y|ies)" }, { key: "tools/react.ts", value: PRIMITIVE_MOUNTED }]),
      ),
    );
    ok(neutral.length === 0, "a directory entry-count change alone raises no capability finding");

    const blind = toolRosterFindings({
      sections: [{ kind: "not-computable", section: "mounted", reason: "base unavailable" }],
      findings: [],
    });
    ok(blind.length === 0, "a not-computable mounted section yields no finding — an unknown is never rendered as a gain");
  }
}

{
  const appToolsDir = join(repoRoot, "agent", "tools");
  if (!existsSync(appToolsDir)) {
    console.error(
      `✗ tool-roster-test: ${appToolsDir} does not exist. Since OPE-375 the slot tree is BUILD OUTPUT — run \`npm run oe:build\` first (the \`pretest\` hook does it for \`npm test\`).`,
    );
    process.exit(1);
  }
  const coreToolsDir = resolveCoreToolsDir(repoRoot);
  ok(coreToolsDir !== undefined, "core's agent/tools/ is locatable from the repo root");
  const core = readCoreToolExports(coreToolsDir!);
  ok(core.length > 0, "core exports at least one tool — an empty list would make every roster vacuously clean");

  const roster = readToolRoster(appToolsDir);
  const drift = diffToolRoster(core, roster);
  ok(rosterDriftIsClean(drift), "THE REAL TREE: agent/tools/ is a decision about every tool core exports");
  ok(drift.mountedFromCore.length === core.length, "every core tool this app mounts is mounted under its own name");

  const declined = drift.declined.map((d) => d.name).sort((a, b) => a.localeCompare(b));
  for (const name of ["bash", "read_file", "web_fetch", "write_file"]) {
    ok(declined.includes(name), `the real roster DECLINES the framework tool "${name}" by sentinel`);
  }
  ok(!declined.includes("agent"), "the real roster does NOT decline `agent` — eve's built-in IS the delegation route");
  for (const name of ["glob", "grep"]) {
    ok(!declined.includes(name), `"${name}" is no longer declined by sentinel — eve never default-mounts it, so nothing needs disabling`);
    ok(!drift.mountedFromCore.some((e) => e.name === name), `"${name}" is not a core tool export`);
  }
  ok(
    drift.mountedFromCore.every((e) => !declined.includes(e.name)),
    "no tool is counted as both mounted and declined",
  );

  const subagentRoster = readToolRoster(join(repoRoot, "agent", "subagents", "fresh_eyes_review", "tools"));
  ok(subagentRoster.length > 0, "the fresh_eyes_review subagent carries its own tools/ roster");
  const required = [...(await readEveFrameworkTools()).required].sort();
  const mounted = subagentRoster.filter((e) => e.classification !== PRIMITIVE_DISABLED).map((e) => e.name).sort();
  ok(
    JSON.stringify(mounted) === JSON.stringify(required),
    `every file in a declared subagent's tools/ is a sentinel EXCEPT the slots eve refuses to let an app disable — a subagent that holds no tool cannot widen access (mounted ${JSON.stringify(mounted)} vs eve-required ${JSON.stringify(required)})`,
  );
  ok(
    subagentRoster.filter((e) => e.classification === PRIMITIVE_DISABLED).length === subagentRoster.length - required.length,
    "…and every other file is classified declined, not merely absent from the mounted list",
  );
}

console.log(`✓ ${passed} tool-roster assertions passed`);
