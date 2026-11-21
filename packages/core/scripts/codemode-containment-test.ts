import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { filesMatching } from "./eve-dist-search.js";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(here, "..", "..");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function agentRoots(): string[] {
  const roots: string[] = [];
  const scan = (parent: string): void => {
    for (const name of readdirSync(parent)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const dir = join(parent, name);
      if (!statSync(dir).isDirectory()) continue;
      if (name === "agent") {
        roots.push(dir);
        continue;
      }
      scan(dir);
    }
  };
  scan(packagesDir);
  return roots.sort();
}

function declaresDispatchTool(source: string): boolean {
  return /\bruntimeAction\b|behavior\s*:\s*\{[^}]*handling|handling\s*:\s*\{\s*kind\s*:\s*["'`]dispatch|\bworkflowId\s*:/.test(source);
}

function importsEveWorkflowTool(source: string): boolean {
  return /(?:\bfrom\s*|\bimport\s*\(\s*)["'`]eve\/tools\/workflow["'`]/.test(source);
}

function namesEveProgramSymbol(source: string): boolean {
  return /["'`]eve\.workflowSandbox\.module["'`]|["'`]eve\.workflow-program-options["'`]|workflow-sandbox-runtime|installWorkflowSandbox|shared\/workflow-sandbox|compiled\/run(?![\w.-])|(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`]run["'`]/.test(source);
}

{
  const roots = agentRoots();
  const files = roots.flatMap(walkTs);
  const rel = (f: string): string => relative(join(packagesDir, ".."), f).replace(/\\/g, "/");
  ok(files.length > 50, `scanned the agent source tree (${files.length} .ts files across ${roots.length} agent roots)`);

  ok(
    roots.some((r) => r.replace(/\\/g, "/").endsWith("/packages/core/agent")),
    `the scan covers packages/core/agent (roots: ${roots.map(rel).join(", ")})`,
  );
  const providerFiles = files.filter((f) => /\/packages\/providers\/[^/]+\/agent\//.test(f.replace(/\\/g, "/")));
  ok(
    providerFiles.length > 0,
    `the scan reaches PROVIDER agent source too (${providerFiles.length} .ts files under packages/providers/*/agent)`,
  );

  // The repository-root agent/ tree is the app eve compiles. The import, activator and symbol scans
  // cover it as well as the package agent roots.
  const appAgentDir = join(packagesDir, "..", "agent");
  const appFiles = walkTs(appAgentDir);
  ok(appFiles.length > 0, `the import, activator and symbol scans also cover the app's own agent/ tree (${appFiles.length} .ts files)`);
  const scanFiles = [...files, ...appFiles];

  const workflowToolFile = scanFiles.find((f) => f.replace(/\\/g, "/").endsWith("/agent/tools/workflow.ts"));
  ok(
    workflowToolFile === undefined,
    "neither a package nor the app's generated tool slot holds agent/tools/workflow.ts",
  );

  const activators = scanFiles.filter((f) => /experimental_workflow\s*\(/.test(readFileSync(f, "utf8")));
  ok(
    activators.length === 0,
    `no package source calls experimental_workflow(...) (found: ${activators.map(rel).join(", ") || "none"})`,
  );

  const workflowImporters = scanFiles.filter((f) => importsEveWorkflowTool(readFileSync(f, "utf8")));
  ok(
    workflowImporters.length === 0,
    `no package source imports eve/tools/workflow — the eve 0.71 code-mode activator (found: ${workflowImporters.map(rel).join(", ") || "none"})`,
  );
  ok(
    importsEveWorkflowTool(`import { workflow } from "eve/tools/workflow";`) &&
      importsEveWorkflowTool(`const m = await import('eve/tools/workflow');`) &&
      !importsEveWorkflowTool(`// see eve/tools/workflow for the code-mode tool`) &&
      !importsEveWorkflowTool(`import { workflow } from "eve/tools/workflow-modules";`),
    "POSITIVE/NEGATIVE CONTROL: the activator matcher sees a static and a dynamic import, and not a comment or a sibling module",
  );

  // eve 1.x keys both the generated-program flag and the program runtime on GLOBAL symbols
  // (Symbol.for). Any module can name one, so an import scan alone does not close the gate.
  const forgers = scanFiles.filter((f) => namesEveProgramSymbol(readFileSync(f, "utf8")));
  ok(
    forgers.length === 0,
    `no agent source names eve's program symbol keys, its slot or runtime installer, or its run bundle (found: ${forgers.map(rel).join(", ") || "none"})`,
  );
  ok(
    namesEveProgramSymbol(`globalThis[Symbol.for("eve.workflowSandbox.module")] = mod;`) &&
      namesEveProgramSymbol("Object.defineProperty(t, Symbol.for('eve.workflow-program-options'), { value: {} });") &&
      namesEveProgramSymbol(`import "eve/dist/src/internal/nitro/host/workflow-sandbox-runtime.js";`) &&
      namesEveProgramSymbol(`import { installWorkflowSandboxModule } from "../../node_modules/eve/dist/src/shared/workflow-sandbox.js";`) &&
      namesEveProgramSymbol(`import * as run from "../../node_modules/eve/dist/src/compiled/run/index.js";`) &&
      namesEveProgramSymbol(`const run = require("../../node_modules/eve/dist/src/compiled/run");`) &&
      namesEveProgramSymbol(`import { createRunner } from "run";`) &&
      namesEveProgramSymbol(`const m = await import('run');`) &&
      !namesEveProgramSymbol(`import { x } from "../../node_modules/eve/dist/src/compiled/runner/index.js";`) &&
      !namesEveProgramSymbol(`import { y } from "runtime";`) &&
      !namesEveProgramSymbol(`import { runWorkflow } from "eve/workflow";`) &&
      !namesEveProgramSymbol(`const key = Symbol.for("eve.workflow-program");`),
    "POSITIVE/NEGATIVE CONTROL: the symbol matcher sees both symbol keys, the runtime installer, the slot installer and the run bundle (eve's copy or the bare `run` package), and not a sibling key, a sibling module or eve/workflow",
  );

  const manualDir = join(packagesDir, "core", "agent", "docs", "generated");
  const isManualPage = (f: string): boolean => dirname(f) === manualDir && !f.endsWith("index.ts");
  const manualPages = files.filter(isManualPage);
  ok(
    manualPages.some((f) => declaresDispatchTool(readFileSync(f, "utf8"))),
    "precondition: a universal manual page quotes the dispatch shape (without it the exclusion below is dead and must go)",
  );
  ok(files.includes(join(manualDir, "index.ts")), "the manual barrel index.ts stays in the dispatch scan");
  const rtaFiles = files.filter((f) => !isManualPage(f)).filter((f) => declaresDispatchTool(readFileSync(f, "utf8")));
  ok(
    rtaFiles.length === 0,
    `no agent source in packages/** declares a workflow / dispatch tool (found: ${rtaFiles.map(rel).join(", ") || "none"})`,
  );

  for (const [label, source] of [
    ["the retired `runtimeAction` property", `export const t = { name: "spawn", runtimeAction: { kind: "subagent-call" } };`],
    ["a `behavior.handling` block", `export const t = {\n  name: "spawn",\n  behavior: { availability: [], handling: { kind: "dispatch" } },\n};`],
    ["a bare dispatch `handling` block", `const h = { handling: { kind: "dispatch", target: {} } };`],
    ["a `workflowId` declaration — the shape eve 0.51.0 exposes", `export const t = { name: "run", workflowId: "w1", nodeId: "n", resultKind: "text" };`],
  ] as const) {
    ok(declaresDispatchTool(source), `POSITIVE CONTROL: the dispatch matcher sees ${label}`);
  }
  ok(
    !declaresDispatchTool(`export const t = { name: "reply", description: "reply", execute: async () => ({}) };`),
    "NEGATIVE CONTROL: the dispatch matcher does NOT fire on an ordinary gated tool",
  );
}

// eve 1.x moved code mode. The 0.x `@ai-sdk/code-mode` runtime is gone, and the generated-program
// tool (`workflow()` from `eve/tools/workflow`) runs its program through `runWorkflowProgramStep`
// in a QuickJS sandbox from eve's compiled `run` library. eve installs that runtime into a host ONLY
// when the build-time manifest declares a tool that carries `workflowProgram`. Without the runtime,
// the step refuses every program. So OE relies on two layers, and this script proves both:
//   1. ABSENCE: no OE host installs the program runtime (the real compiled OE manifest declares no
//      generated-program tool, and eve's install chain has no other entrance).
//   2. CONTAINMENT: where a runtime IS installed (here, on purpose, through eve's own installer),
//      a hostile program reaches no connector, no egress, no host module, and no forged resume.
const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const eveDist = (rel: string): string => join(eveRoot, "dist", "src", rel);
const eveDistUrl = (rel: string): string => pathToFileURL(eveDist(rel)).href;

type ToolEntry = { readonly name: string; readonly workflowProgram?: unknown };
type CompiledAgent = {
  readonly config: { readonly name: string };
  readonly tools: readonly ToolEntry[];
  readonly definitions?: readonly { readonly kind: string; readonly logicalPath?: string }[];
  readonly subagents: readonly { readonly agent: CompiledAgent }[];
};

// eve's host-spec predicate, restated in TypeScript. Block 2 pins eve's own source of it.
const hasWorkflowProgram = (m: CompiledAgent): boolean => [m, ...m.subagents.map((s) => s.agent)].some((a) => a.tools.some((t) => t.workflowProgram !== undefined));

{
  // Block 2 — ABSENCE. eve's install chain, pinned link by link, then the real OE manifest.
  const sandboxSrc = readFileSync(eveDist("shared/workflow-sandbox.js"), "utf8");
  ok(
    /async function loadWorkflowSandboxModule\(\)\{let (\w+)=globalThis\[WORKFLOW_SANDBOX_MODULE_KEY\];if\(\1===void 0\)throw Error\(/.test(sandboxSrc),
    "eve's program step loads its sandbox from ONE global slot and throws when the slot is empty (no fallback runtime)",
  );
  const installers = filesMatching(/installWorkflowSandboxModule\(/u).filter((rel) => rel !== "shared/workflow-sandbox.js");
  ok(
    JSON.stringify(installers) === JSON.stringify(["internal/nitro/host/workflow-sandbox-runtime.js"]),
    `ONE eve module fills the sandbox slot, the host runtime installer (got ${JSON.stringify(installers)})`,
  );
  const slotKeyNamers = filesMatching(/eve\.workflowSandbox\.module/u);
  ok(
    JSON.stringify(slotKeyNamers) === JSON.stringify(["shared/workflow-sandbox.js"]),
    `ONE eve module names the sandbox slot's symbol key — no module writes the slot around the installer (got ${JSON.stringify(slotKeyNamers)})`,
  );
  const optionKeyNamers = filesMatching(/eve\.workflow-program-options/u);
  ok(
    JSON.stringify(optionKeyNamers) === JSON.stringify(["tools/workflow-program-input.js"]),
    `ONE eve module names the program-options symbol key (got ${JSON.stringify(optionKeyNamers)})`,
  );
  const runImporters = filesMatching(/compiled\/run\/index\.js/u);
  ok(
    JSON.stringify(runImporters) === JSON.stringify(["internal/nitro/host/workflow-sandbox-runtime.js"]),
    `ONE eve module imports the compiled \`run\` program sandbox (got ${JSON.stringify(runImporters)}) — a second importer is a second program runtime: re-run this proof against it`,
  );
  const loaders = filesMatching(/loadWorkflowSandboxModule\(/u).filter((rel) => rel !== "shared/workflow-sandbox.js");
  ok(
    JSON.stringify(loaders) === JSON.stringify(["execution/dynamic-workflow/program-step.js"]),
    `ONE eve module runs programs from the slot, the program step (got ${JSON.stringify(loaders)})`,
  );
  ok(
    filesMatching(/experimental_runCodeMode|@ai-sdk\/code-mode/u).length === 0,
    "the 0.x code-mode runtime (experimental_runCodeMode, @ai-sdk/code-mode) is gone from eve's dist — it is no second program runtime",
  );
  const runtimeCallers = filesMatching(/installWorkflowSandboxRuntime/u).filter((rel) => rel !== "internal/nitro/host/workflow-sandbox-runtime.js");
  ok(
    JSON.stringify(runtimeCallers) === JSON.stringify(["internal/nitro/host/runtime-plugin.js"]),
    `ONE eve module calls the runtime installer, the generated host runtime plugin (got ${JSON.stringify(runtimeCallers)})`,
  );

  const plugin = (await import(eveDistUrl("internal/nitro/host/runtime-plugin.js"))) as {
    createRuntimePluginSource: (runtime: { localTracing: boolean; workflowSandbox: boolean }, paths: { bootstrapPath: string; workflowWorldPluginPath: string }) => string;
  };
  const pluginPaths = { bootstrapPath: "/synthetic/bootstrap.mjs", workflowWorldPluginPath: "/synthetic/world.mjs" };
  const off = plugin.createRuntimePluginSource({ localTracing: false, workflowSandbox: false }, pluginPaths);
  const on = plugin.createRuntimePluginSource({ localTracing: false, workflowSandbox: true }, pluginPaths);
  ok(!/installWorkflowSandboxRuntime/.test(off), "eve's real plugin generator emits NO runtime install for a host whose spec says workflowSandbox:false");
  ok(/installWorkflowSandboxRuntime\(\)/.test(on), "POSITIVE CONTROL: the same generator DOES emit the install for workflowSandbox:true (the check above can see an install)");

  const hostNitroSrc = readFileSync(eveDist("internal/nitro/host/create-host-nitro.js"), "utf8");
  ok(/\[EVE_RUNTIME_PLUGIN_ID\]:createRuntimePluginSource\((\w+)\.runtime,/.test(hostNitroSrc), "the host build feeds the host spec's `runtime` into the plugin generator");
  const hostSpecSrc = readFileSync(eveDist("internal/nitro/host/host-spec.js"), "utf8");
  ok(/runtime:\{localTracing:[^,]+,workflowSandbox:hasWorkflowProgram\((\w+)\)\}/.test(hostSpecSrc), "the host spec sets workflowSandbox from hasWorkflowProgram(manifest) and nothing else");
  ok(
    hostSpecSrc.includes("function hasWorkflowProgram(e){return[e,...e.subagents.map(e=>e.agent)].some(e=>e.tools.some(e=>e.workflowProgram!==void 0))}"),
    "hasWorkflowProgram is: the agent or any subagent has a manifest tool with `workflowProgram` (the predicate this script evaluates below)",
  );

  const schemaBackedSrc = readFileSync(eveDist("internal/authored-definition/schema-backed.js"), "utf8");
  ok(
    /let (\w+)=readWorkflowProgramOptions\(\w+\)/.test(schemaBackedSrc) && /\(\w+\.workflowProgram=\w+\)/.test(schemaBackedSrc),
    "a tool gets `workflowProgram` only from the options eve attaches to it (readWorkflowProgramOptions)",
  );
  const attachers = filesMatching(/attachWorkflowProgramOptions\(/u).filter((rel) => rel !== "tools/workflow-program-input.js");
  ok(
    JSON.stringify(attachers) === JSON.stringify(["tools/provided/workflow.js"]),
    `ONE eve module attaches program options, the provided workflow() tool (got ${JSON.stringify(attachers)})`,
  );
  const providedImporters = filesMatching(/provided\/workflow\.js/u);
  ok(
    JSON.stringify(providedImporters) === JSON.stringify(["public/tools/workflow.js"]),
    `ONE eve module re-exports workflow(), the public \`eve/tools/workflow\` entry (got ${JSON.stringify(providedImporters)})`,
  );
  const pkg = JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as { exports: Record<string, unknown> };
  const exportsToWorkflow = Object.entries(pkg.exports)
    .filter(([, target]) => JSON.stringify(target).includes("public/tools/workflow.js"))
    .map(([key]) => key);
  ok(
    JSON.stringify(exportsToWorkflow) === JSON.stringify(["./tools/workflow"]),
    `ONE package export reaches workflow(), \`eve/tools/workflow\` — the import block 1 forbids (got ${JSON.stringify(exportsToWorkflow)})`,
  );

  // The real OE app, compiled by eve's own compiler into a throwaway workspace. The compile imports
  // agent/agent.ts, and that boot registers a process-wide operational store. The batched runner can
  // share this process with later legs, so the compile runs in a CHILD process: the boot, its store
  // and any lock it takes live and die there. Its data dirs are private for the same reason.
  const compilerUrl = eveDistUrl("compiler/compile-agent.js");
  const bootDataRoot = mkdtempSync(join(tmpdir(), "oe-codemode-boot-"));
  const COMPILE_MARK = "CODEMODE_COMPILED_MANIFEST ";
  const compile = (startPath: string): CompiledAgent => {
    const workspace = mkdtempSync(join(tmpdir(), "oe-codemode-compile-"));
    try {
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { compileAgentInWorkspace } = await import(${JSON.stringify(compilerUrl)});
const w = ${JSON.stringify(workspace)};
const { manifest: m } = await compileAgentInWorkspace({ artifactLocations: { publishedRoot: w, writeRoot: w }, startPath: ${JSON.stringify(startPath)} });
const agent = (a) => ({ config: { name: a.config.name }, tools: a.tools.map((t) => ({ name: t.name, logicalPath: t.logicalPath, workflowProgram: t.workflowProgram })), definitions: a.definitions, subagents: (a.subagents ?? []).map((s) => ({ agent: agent(s.agent) })) });
process.stdout.write("\\n" + ${JSON.stringify(COMPILE_MARK)} + JSON.stringify(agent(m)) + "\\n", () => process.exit(0));`,
        ],
        {
          cwd: startPath,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, OE_PGLITE_DIR: join(bootDataRoot, "pglite"), OE_MEMORY_DIR: join(bootDataRoot, "memory") },
        },
      );
      const line = child.stdout.split("\n").find((l) => l.startsWith(COMPILE_MARK));
      if (child.status !== 0 || line === undefined) {
        throw new Error(`eve's compile of ${startPath} failed (exit ${String(child.status)}${child.error ? `, ${child.error.message}` : ""}):\n${child.stderr.slice(-4000)}\n${child.stdout.slice(-2000)}`);
      }
      return JSON.parse(line.slice(COMPILE_MARK.length)) as CompiledAgent;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  };
  try {
    const appRoot = join(packagesDir, "..");
    const appToolFiles = readdirSync(join(appRoot, "agent", "tools")).filter((f) => f.endsWith(".ts"));
    {
      const manifest = compile(appRoot);
      const agents = [manifest, ...manifest.subagents.map((s) => s.agent)];
      const toolDefinitions = (manifest.definitions ?? []).filter((d) => d.kind === "tool");
      const compiledPaths = new Set([...toolDefinitions.map((d) => d.logicalPath), ...manifest.tools.map((t) => (t as { logicalPath?: string }).logicalPath)]);
      const isSentinel = (f: string): boolean => /^export default disableTool\(\);$/m.test(readFileSync(join(appRoot, "agent", "tools", f), "utf8"));
      const unaccounted = appToolFiles.filter((f) => !compiledPaths.has(`tools/${f}`) && !isSentinel(f));
      ok(
        manifest.config.name === "open-everywhere" && appToolFiles.length > 50 && toolDefinitions.length > 50 && unaccounted.length === 0,
        `eve compiled the real OE app with its whole tool roster: every one of ${appToolFiles.length} agent/tools/*.ts files is a compiled tool or a disableTool() sentinel ` +
          `(${toolDefinitions.length} tool definitions; unaccounted: ${unaccounted.join(", ") || "none"}; ` +
          `${agents.map((a) => `${a.config.name}: ${a.tools.length} manifest tools`).join("; ")}). Most OE tools are dynamic definitions, which never reach the install predicate ` +
          "(a dynamic generated-program tool meets the empty slot and is refused); every manifest tool is checked for workflowProgram below",
      );
      const programTools = agents.flatMap((a) => a.tools.filter((t) => t.workflowProgram !== undefined).map((t) => `${a.config.name}/${t.name}`));
      ok(
        programTools.length === 0 && !hasWorkflowProgram(manifest),
        `the real OE manifest declares NO generated-program tool, so eve installs NO program runtime in the OE host (found: ${programTools.join(", ") || "none"})`,
      );
    }
    // POSITIVE CONTROL through the real compiler: a fixture app with one workflow() tool.
    // The fixture lives outside the repository, so a killed run leaves nothing for the scans above
    // to find. A node_modules link lets the fixture resolve eve from this repository.
    const fixture = mkdtempSync(join(tmpdir(), "oe-codemode-fixture-"));
    try {
      mkdirSync(join(fixture, "agent", "tools"), { recursive: true });
      symlinkSync(join(appRoot, "node_modules"), join(fixture, "node_modules"), "dir");
      writeFileSync(join(fixture, "package.json"), `{"name":"codemode-fixture","private":true,"type":"module"}\n`);
      writeFileSync(join(fixture, "agent", "instructions.md"), "Synthetic fixture.\n");
      writeFileSync(join(fixture, "agent", "agent.ts"), `import { defineAgent } from "eve";\nexport default defineAgent({ model: "anthropic/claude-sonnet-4.5" });\n`);
      writeFileSync(join(fixture, "agent", "tools", "run_program.ts"), `import { workflow } from "eve/tools/workflow";\nexport default workflow();\n`);
      const fx = compile(fixture);
      ok(
        hasWorkflowProgram(fx) && fx.tools.some((t) => t.name === "run_program" && t.workflowProgram !== undefined),
        `POSITIVE CONTROL: eve's compiler carries workflowProgram for a workflow() tool, so the absence check above can see one (got ${JSON.stringify(fx.tools.map((t) => [t.name, t.workflowProgram ?? null]))})`,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  } finally {
    rmSync(bootDataRoot, { recursive: true, force: true });
  }
  const synthetic: CompiledAgent = { config: { name: "synthetic" }, tools: [], subagents: [{ agent: { config: { name: "child" }, tools: [{ name: "workflow", workflowProgram: { maxSubagents: 3 } }], subagents: [] } }] };
  ok(hasWorkflowProgram(synthetic), "POSITIVE CONTROL: the predicate sees a generated-program tool on a SUBAGENT");
}

// eve 1.0.2's host-function literal in the program step. The sandbox sees the namespace as
// ONE dispatcher function, so no live check can list its members: this exact text is the check.
const HOST_FUNCTIONS_LITERAL =
  "hostFunctions:{[WORKFLOW_PROGRAM_HOST_NAMESPACE]:{agent:async e=>{let t;try{t=readWorkflowProgramAgentCall(parseWorkflowProgramJson(e,`ctx.agent() input`))}catch(e){throw guestError(toErrorMessage(e))}let{interrupt:n,resume:r}=i();if(r===void 0)return n(t);let a=r.resolution;if(a.status===`failed`)throw guestError(a.error);return a.output}}},limits:";

// The full own-property list of the program sandbox's global object on eve 1.0.2. A new
// name here is a new reach from inside the sandbox: review it before it joins this list.
const SANDBOX_GLOBALS = [
  "AggregateError", "Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date", "Error", "EvalError",
  "FinalizationRegistry", "Float16Array", "Float32Array", "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array", "Int8Array",
  "InternalError", "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError", "ReferenceError", "Reflect",
  "RegExp", "Set", "String", "Symbol", "SyntaxError", "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray",
  "WeakMap", "WeakRef", "WeakSet", "__eveWorkflowProgram", "__runAssertNoDetachedBridgeCalls", "__runCreateBridgePromise",
  "__runSerializeJsonPayload", "console", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "eval", "globalThis",
  "isFinite", "isNaN", "parseFloat", "parseInt", "undefined", "unescape",
];

{
  // Block 3 — CONTAINMENT, on eve's real program step.
  const programStep = (await import(eveDistUrl("execution/dynamic-workflow/program-step.js"))) as {
    runWorkflowProgramStep: (input: {
      callId: string;
      program: { js: string; continuationSecurity: { signingKey: string; maxAgeMs?: number } };
      resume?: { continuation: string; resolutions: readonly { interruptionId: string; value: { status: "completed"; output: unknown } }[] };
    }) => Promise<unknown>;
  };
  ok(typeof programStep.runWorkflowProgramStep === "function", "eve still exports runWorkflowProgramStep (the step the workflow() tool runs)");

  type Pending = { readonly id: string; readonly call: { readonly target: string; readonly input: unknown } };
  type Outcome = { readonly result?: { readonly status?: string; readonly output?: unknown; readonly continuation?: string; readonly pending?: readonly Pending[] }; readonly error?: string };
  const security = { signingKey: "codemode-containment-test-key-0000000000", maxAgeMs: 60_000 };
  const step = (input: Parameters<typeof programStep.runWorkflowProgramStep>[0]): Promise<Outcome> =>
    programStep.runWorkflowProgramStep(input).then(
      (r) => ({ result: r as Outcome["result"] }),
      (e: unknown) => ({ error: (e as Error).message }),
    );
  const run = (js: string): Promise<Outcome> => step({ callId: "call_codemode", program: { js, continuationSecurity: security } });

  const absent = await run("return 1 + 2;");
  ok(
    absent.error !== undefined && /workflow program runtime is not installed/.test(absent.error),
    `WITHOUT an installed runtime the real step refuses even a benign program — the OE host posture (got ${JSON.stringify(absent)})`,
  );

  // Install the runtime ON PURPOSE, with eve's own installer, the call the generated plugin makes.
  const { installWorkflowSandboxRuntime } = (await import(eveDistUrl("internal/nitro/host/workflow-sandbox-runtime.js"))) as { installWorkflowSandboxRuntime: () => void };
  installWorkflowSandboxRuntime();

  const benign = await run("return 1 + 2;");
  ok(benign.result?.status === "completed" && benign.result.output === 3, `the real program step completes a benign program (got ${JSON.stringify(benign)})`);

  const connector = await run("return await tools.read_notion_page({});");
  ok(
    connector.error !== undefined && /tools is not defined/.test(connector.error),
    `a connector op is UNREACHABLE from the program sandbox — there is no tool map to call (got ${JSON.stringify(connector)})`,
  );
  const hostCall = await run("return await __eveWorkflowProgram.read_notion_page('{}');");
  ok(
    hostCall.error !== undefined && /Unknown host function: __eveWorkflowProgram\.read_notion_page/.test(hostCall.error),
    `a direct call to the host bridge reaches ONLY its declared functions — a connector name is unknown to it (got ${JSON.stringify(hostCall)})`,
  );

  const egress = await run("return await fetch('http://169.254.169.254/latest/meta-data/');");
  ok(egress.error !== undefined && /fetch is not defined/.test(egress.error), `the program sandbox has no fetch — egress is impossible from it (got ${JSON.stringify(egress)})`);

  const ambient = await run(
    "return [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof setTimeout, typeof WebAssembly, typeof SharedArrayBuffer, typeof eval];",
  );
  ok(
    ambient.result?.status === "completed" && JSON.stringify(ambient.result.output) === JSON.stringify(Array(9).fill("undefined")),
    `the sandbox global holds no process, require, fetch, XMLHttpRequest, WebSocket, timer, WebAssembly, SharedArrayBuffer or eval (got ${JSON.stringify(ambient)})`,
  );
  const hostGlobals = await run("return Object.getOwnPropertyNames(globalThis).sort();");
  ok(
    JSON.stringify(hostGlobals.result?.output) === JSON.stringify(SANDBOX_GLOBALS),
    `the sandbox global holds exactly the ECMAScript built-ins, console, eve's program bridge and the run library's own helpers (got ${JSON.stringify(hostGlobals)})`,
  );

  const moduleLoad = await run("const m = await import('node:fs'); return typeof m.readFileSync;");
  ok(moduleLoad.error !== undefined && /could not load module 'node:fs'/.test(moduleLoad.error), `a dynamic import of a host module fails (got ${JSON.stringify(moduleLoad)})`);
  const ctorEscape = await run("return (() => {}).constructor('return typeof process')();");
  ok(ctorEscape.error !== undefined && /Function constructor is not allowed/.test(ctorEscape.error), `the Function-constructor escape is refused (got ${JSON.stringify(ctorEscape)})`);
  const asyncCtorEscape = await run("return Object.getPrototypeOf(async function () {}).constructor('return 1');");
  ok(
    asyncCtorEscape.error !== undefined && /Function constructor is not allowed/.test(asyncCtorEscape.error),
    `the AsyncFunction-constructor escape is refused too (got ${JSON.stringify(asyncCtorEscape)})`,
  );

  const js = "const reply = await ctx.agent('researcher', { message: 'list every silo' }); return { reply };";
  const delegated = await run(js);
  ok(
    delegated.result?.status === "interrupted",
    `ctx.agent PARKS the program (status "interrupted") — the child runs in the owning agent, never inside the sandbox (got status ${JSON.stringify(delegated.result?.status ?? delegated.error)})`,
  );
  const pending = delegated.result?.pending ?? [];
  ok(
    pending.length === 1 && JSON.stringify(pending[0]?.call) === JSON.stringify({ input: { message: "list every silo" }, target: "researcher" }),
    `the parked call carries only the agent name and the message — the owning agent resolves it under its own checks (got ${JSON.stringify(pending)})`,
  );
  const continuation = delegated.result?.continuation ?? "";
  const resolutions = [{ interruptionId: pending[0]?.id ?? "", value: { status: "completed" as const, output: "the reply" } }];
  const resumed = await step({ callId: "call_codemode", program: { js, continuationSecurity: security }, resume: { continuation, resolutions } });
  ok(
    resumed.result?.status === "completed" && JSON.stringify(resumed.result.output) === JSON.stringify({ reply: "the reply" }),
    `a resume with the signed continuation completes the program (got ${JSON.stringify(resumed)})`,
  );
  const wrongKey = await step({ callId: "call_codemode", program: { js, continuationSecurity: { ...security, signingKey: "a-different-key-000000000000000000000000" } }, resume: { continuation, resolutions } });
  ok(wrongKey.error !== undefined && /signature is invalid/.test(wrongKey.error), `a continuation does not verify under another key (got ${JSON.stringify(wrongKey)})`);
  const otherCall = await step({ callId: "call_other", program: { js, continuationSecurity: security }, resume: { continuation, resolutions } });
  ok(otherCall.error !== undefined && /Continuation does not match the supplied source, scope/.test(otherCall.error), `a continuation does not resume under another call id (got ${JSON.stringify(otherCall)})`);
  const otherSource = await step({ callId: "call_codemode", program: { js: `${js} // edited`, continuationSecurity: security }, resume: { continuation, resolutions } });
  ok(otherSource.error !== undefined && /Continuation does not match the supplied source, scope/.test(otherSource.error), `a continuation does not resume a different program (got ${JSON.stringify(otherSource)})`);
  const [body, signature] = continuation.split(".");
  const forgedBody = Buffer.from(Buffer.from(body ?? "", "base64url").toString("utf8").replace(/"expiresAtMs":\d+/, '"expiresAtMs":9999999999999'), "utf8").toString("base64url");
  ok(forgedBody !== body, "the forged continuation differs from the signed one (the forgery below is real)");
  const forged = await step({ callId: "call_codemode", program: { js, continuationSecurity: security }, resume: { continuation: `${forgedBody}.${signature}`, resolutions } });
  ok(forged.error !== undefined && /signature is invalid/.test(forged.error), `an edited continuation fails its signature (got ${JSON.stringify(forged)})`);

  const stepSrc = readFileSync(eveDist("execution/dynamic-workflow/program-step.js"), "utf8");
  ok(
    stepSrc.includes(HOST_FUNCTIONS_LITERAL) && (stepSrc.match(/hostFunctions:/g) ?? []).length === 1,
    "the step hands the sandbox ONE host namespace with ONE function, `agent` (the whole literal, pinned exactly)",
  );
  const twoFunctions = HOST_FUNCTIONS_LITERAL.replace("return a.output}}},limits:", "return a.output},spawn:async e=>{return e}}},limits:");
  ok(
    twoFunctions !== HOST_FUNCTIONS_LITERAL && !twoFunctions.includes(HOST_FUNCTIONS_LITERAL),
    "NEGATIVE CONTROL: a literal with a second host function after `agent` does not satisfy the pin",
  );
  ok(
    /cpuTimeoutMs:3e4,/.test(stepSrc) && /memoryLimitBytes:67108864,/.test(stepSrc) && /timeoutMs:3e5\}/.test(stepSrc),
    "the step bounds every program: 30 s of CPU, 64 MiB of memory, 300 s of wall time",
  );
}

console.log(
  `\n✓ codemode-containment: ${n} assertions passed ` +
    `(OE posture: no eve/tools/workflow import / no workflow.ts / no experimental_workflow / no program symbol keys / zero workflow tools · ` +
    `absence: the real OE manifest declares no generated-program tool, so eve installs no program runtime · ` +
    `containment on an installed runtime: no tools, no fetch, no host modules, no Function constructor, ctx.agent parks, signed resumes only)\n`,
);
