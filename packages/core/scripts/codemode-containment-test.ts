import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
  const wfUrl = pathToFileURL(join(eveRoot, "dist/src/harness/workflow-sandbox.js")).href;
  const wf = (await import(wfUrl)) as {
    buildWorkflowHostTools: (input: { tools: Map<string, unknown> }) => Record<string, { execute: unknown }>;
  };
  ok(typeof wf.buildWorkflowHostTools === "function", "eve still exports buildWorkflowHostTools (the sandbox host-tool builder)");

  const gatedExecute = async (): Promise<unknown> => ({ leakedSecret: "provider-token", untrustedBody: "<script>" });
  const gatedConnectorOp = { name: "read_notion_page", description: "gated connector read", inputSchema: {}, execute: gatedExecute };

  const rtaExecute = async (): Promise<unknown> => ({ ran: "inline" });
  const workflowTool = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name,
    description: "workflow tool",
    inputSchema: {},
    execute: rtaExecute,
    workflowId: "w1",
    nodeId: "node",
    resultKind: "text",
    ...extra,
  });
  const dispatchTool = (name: string, target: Record<string, unknown>): Record<string, unknown> => ({
    name,
    description: "delegation",
    inputSchema: {},
    execute: rtaExecute,
    behavior: { availability: [], handling: { kind: "dispatch", target } },
  });

  const mixed = new Map<string, unknown>([
    ["read_notion_page", gatedConnectorOp],
    ["run_workflow", workflowTool("run_workflow")],
  ]);
  const host = wf.buildWorkflowHostTools({ tools: mixed });

  ok(!("read_notion_page" in host), "sandbox host tools EXCLUDE the gated connector op (unreachable from code-mode)");
  ok("run_workflow" in host, "sandbox host tools include the workflow tool (the only exposed class)");
  ok(
    host.run_workflow?.execute !== rtaExecute,
    "even the exposed workflow tool's execute is WRAPPED (interrupts back to the host gate — the original execute never runs inline in the sandbox)",
  );

  for (const [label, target] of [
    ["subagent-call", { kind: "subagent-call", nodeId: "n", subagentName: "s" }],
    ["self-agent-call", { kind: "self-agent-call", nodeId: "n", subagentName: "s" }],
    ["remote-agent-call", { kind: "remote-agent-call", nodeId: "n", remoteAgentName: "r" }],
    ["task-cancel", { kind: "task-cancel" }],
    ["task-update", { kind: "task-update" }],
    ["workflow-tool-call", { kind: "workflow-tool-call", workflowId: "w1" }],
  ] as const) {
    const only = new Map<string, unknown>([["ctl", dispatchTool("ctl", target as unknown as Record<string, unknown>)]]);
    ok(
      Object.keys(wf.buildWorkflowHostTools({ tools: only })).length === 0,
      `a \`${label}\` dispatch tool is NOT exposed to the sandbox (the filter reads \`workflowId\`, and a dispatch tool carries none)`,
    );
  }
  ok(
    Object.keys(wf.buildWorkflowHostTools({ tools: new Map<string, unknown>([["w", workflowTool("w")]]) })).length === 1,
    "NEGATIVE CONTROL: a tool declaring a `workflowId` IS exposed — the exclusions above are the filter, not an empty fixture",
  );

  const bg = new Map<string, unknown>([["bg", workflowTool("bg", { execution: "background" })]]);
  ok(
    "bg" in wf.buildWorkflowHostTools({ tools: bg }),
    "a BACKGROUND workflow tool is still exposed to the sandbox (the host filter ignores `execution`)",
  );

  const nonRtaOnly = new Map<string, unknown>([
    ["read_notion_page", gatedConnectorOp],
    ["reply", { name: "reply", description: "reply", inputSchema: {}, execute: gatedExecute }],
  ]);
  const emptyHost = wf.buildWorkflowHostTools({ tools: nonRtaOnly });
  ok(
    Object.keys(emptyHost).length === 0,
    "a tool-set with no workflow tools yields an EMPTY sandbox host set (⇒ Workflow tool never registered)",
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
    `(OE posture: no workflow.ts / no experimental_workflow / zero workflow tools · eve pin: sandbox exposes only wrapped workflow tools · ` +
    `live: benign runs, fetch fail-closed, connector op unreachable)\n`,
);
