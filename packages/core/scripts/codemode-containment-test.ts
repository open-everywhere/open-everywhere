import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { filesMatching } from "./eve-dist-search.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
      if (name === "node_modules" || name === "dist" || name === ".turbo") continue;
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

{
  const roots = agentRoots();
  const files = roots.flatMap(walkTs);
  const rel = (f: string): string => f.replace(/\\/g, "/").split("/packages/")[1] ?? f;
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

  const workflowToolFile = files.find((f) => f.replace(/\\/g, "/").endsWith("/agent/tools/workflow.ts"));
  ok(
    workflowToolFile === undefined,
    "no package contributes agent/tools/workflow.ts (eve would register the code_mode/Workflow tool from the generated slot)",
  );

  const activators = files.filter((f) => /experimental_workflow\s*\(/.test(readFileSync(f, "utf8")));
  ok(
    activators.length === 0,
    `no package source calls experimental_workflow(...) (found: ${activators.map(rel).join(", ") || "none"})`,
  );

  const workflowImporters = files.filter((f) => importsEveWorkflowTool(readFileSync(f, "utf8")));
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

{
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const stepUrl = pathToFileURL(join(eveRoot, "dist/src/execution/dynamic-workflow/program-step.js")).href;
  const programStep = (await import(stepUrl)) as {
    runWorkflowProgramStep: (input: { callId: string; program: { js: string; continuationSecurity: { signingKey: string }; maxSubagents: number } }) => Promise<unknown>;
  };
  ok(typeof programStep.runWorkflowProgramStep === "function", "eve still exports runWorkflowProgramStep (the step the workflow() tool runs)");

  type Outcome = { readonly result?: { readonly status?: string; readonly output?: unknown; readonly interrupt?: { readonly continuation?: { readonly toolNames?: readonly string[] }; readonly toolName?: string } }; readonly error?: string };
  const run = (js: string): Promise<Outcome> =>
    programStep
      .runWorkflowProgramStep({ callId: "call_codemode", program: { js, continuationSecurity: { signingKey: "codemode-containment-test-key-000" }, maxSubagents: 3 } })
      .then((r) => ({ result: r as Outcome["result"] }), (e: unknown) => ({ error: (e as Error).message }));

  const benign = await run("return 1 + 2;");
  ok(benign.result?.status === "completed" && benign.result.output === 3, `the real program step completes a benign program (got ${JSON.stringify(benign)})`);

  const connector = await run("return await tools.read_notion_page({});");
  ok(
    connector.error !== undefined && /read_notion_page/.test(connector.error),
    `a connector op is UNREACHABLE from the program sandbox — the call fails, it never returns a provider result (got ${JSON.stringify(connector)})`,
  );

  const egress = await run("return await fetch('http://169.254.169.254/latest/meta-data/');");
  ok(egress.error !== undefined && /fetch/.test(egress.error), `the program sandbox has no fetch — egress is impossible from it (got ${JSON.stringify(egress)})`);

  const delegated = await run("return await ctx.agent('researcher', { message: 'list every silo' });");
  ok(
    delegated.result?.status === "interrupted",
    `ctx.agent PARKS the program (status "interrupted") — the child runs in the owning agent, never inside the sandbox (got status ${JSON.stringify(delegated.result?.status ?? delegated.error)})`,
  );
  ok(
    JSON.stringify(delegated.result?.interrupt?.continuation?.toolNames) === JSON.stringify(["agent"]),
    `the sandbox's host-tool set is exactly ["agent"] (got ${JSON.stringify(delegated.result?.interrupt?.continuation?.toolNames)})`,
  );

  const stepSrc = readFileSync(fileURLToPath(stepUrl), "utf8");
  ok(
    /function buildWorkflowProgramTools\(\)\{return\{agent:createParkingHostTool\(\{[^]*?\}\)\}\}/.test(stepSrc),
    "buildWorkflowProgramTools() takes NO argument and returns ONE tool, `agent`, built by createParkingHostTool",
  );
  const built = /let (\w+)=buildWorkflowProgramTools\(\)/.exec(stepSrc)?.[1];
  ok(built !== undefined, "runWorkflowProgram binds its host set from buildWorkflowProgramTools()");
  ok(
    new RegExp(`createWorkflowSandboxTool\\(\\{[^}]*hostTools:${built}\\}`).test(stepSrc) &&
      new RegExp(`continueWorkflowSandboxInterrupt\\(\\{[^}]*tools:${built}\\}`).test(stepSrc),
    "both the first run and every resume hand the sandbox THAT set — never another tool map",
  );
  const sandboxCallers = filesMatching(/createWorkflowSandboxTool\(/u).filter((rel) => !rel.startsWith("shared/workflow-sandbox."));
  ok(
    sandboxCallers.length === 1 && sandboxCallers[0] === "execution/dynamic-workflow/program-step.js",
    `createWorkflowSandboxTool has ONE caller in eve's dist, the program step (got ${JSON.stringify(sandboxCallers)}). A second caller could build a sandbox from another tool set — re-run OPE-74 against it`,
  );
}

{
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const cmUrl = pathToFileURL(join(eveRoot, "dist/src/compiled/@ai-sdk/code-mode/index.js")).href;
  const { experimental_runCodeMode: runCodeMode } = (await import(cmUrl)) as {
    experimental_runCodeMode: (input: { js: string; tools: Record<string, unknown>; options?: unknown }) => Promise<unknown>;
  };
  ok(typeof runCodeMode === "function", "eve still exposes the code-mode runtime (experimental_runCodeMode)");

  const benign = await runCodeMode({ js: "return 1 + 2;", tools: {} });
  ok(benign === 3, "code-mode sandbox executes a benign program (harness is live)");

  let fetchOutcome: "denied" | "returned" = "returned";
  let fetchErr = "";
  try {
    await runCodeMode({ js: "return await fetch('http://169.254.169.254/latest/meta-data/');", tools: {} });
  } catch (e) {
    fetchOutcome = "denied";
    fetchErr = (e as Error).message;
  }
  ok(fetchOutcome === "denied", "code-mode fetch is fail-closed by default (no fetchPolicy ⇒ egress impossible inside code-mode)");
  ok(/fetch/.test(fetchErr), `the denial is specifically about fetch being unavailable (got: ${fetchErr.slice(0, 80)})`);

  let opOutcome: "unreachable" | "executed" = "executed";
  try {
    await runCodeMode({ js: "return await tools.read_notion_page({});", tools: {} });
  } catch {
    opOutcome = "unreachable";
  }
  ok(
    opOutcome === "unreachable",
    "a connector op absent from the host-tool set is unreachable inside code-mode (no unwrapped/un-enveloped result can be produced there)",
  );
}

console.log(
  `\n✓ codemode-containment: ${n} assertions passed ` +
    `(OE posture: no eve/tools/workflow import / no workflow.ts / no experimental_workflow / zero workflow tools · eve pin: the program sandbox holds only the parking \`agent\` tool · ` +
    `live: benign runs, fetch fail-closed, connector op unreachable)\n`,
);
