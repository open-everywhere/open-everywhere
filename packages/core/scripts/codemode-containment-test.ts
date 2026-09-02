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
const agentDir = join(here, "..", "agent");

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

{
  const files = walkTs(agentDir);
  ok(files.length > 50, `scanned the agent source tree (${files.length} .ts files)`);

  const workflowToolFile = files.find((f) => f.replace(/\\/g, "/").endsWith("/tools/workflow.ts"));
  ok(
    workflowToolFile === undefined,
    "no agent/tools/workflow.ts exists (eve would register the code_mode/Workflow tool from it)",
  );

  const activators = files.filter((f) => /experimental_workflow\s*\(/.test(readFileSync(f, "utf8")));
  ok(
    activators.length === 0,
    `no source calls experimental_workflow(...) (found: ${activators.map((f) => f.split("/agent/")[1]).join(", ") || "none"})`,
  );

  const rtaFiles = files.filter((f) =>
    /\bruntimeAction\b|behavior\s*:\s*\{[^}]*handling|handling\s*:\s*\{\s*kind\s*:\s*["'`]dispatch/.test(readFileSync(f, "utf8")),
  );
  ok(
    rtaFiles.length === 0,
    `no agent source declares a runtime-action / dispatch tool (found: ${rtaFiles.map((f) => f.split("/agent/")[1]).join(", ") || "none"})`,
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
  const dispatchTool = (name: string, target: Record<string, unknown>): Record<string, unknown> => ({
    name,
    description: "delegation",
    inputSchema: {},
    execute: rtaExecute,
    behavior: { availability: [], handling: { kind: "dispatch", target } },
  });
  const delegation = dispatchTool("spawn", { kind: "subagent-call", nodeId: "node", subagentName: "spawn" });

  const mixed = new Map<string, unknown>([
    ["read_notion_page", gatedConnectorOp],
    ["spawn", delegation],
  ]);
  const host = wf.buildWorkflowHostTools({ tools: mixed });

  ok(!("read_notion_page" in host), "sandbox host tools EXCLUDE the gated connector op (unreachable from code-mode)");
  ok("spawn" in host, "sandbox host tools include the delegation tool (the only exposed class)");
  ok(
    host.spawn?.execute !== rtaExecute,
    "even the exposed delegation tool's execute is WRAPPED (interrupts back to the host gate — the original execute never runs inline in the sandbox)",
  );

  for (const [label, target] of [
    ["task-cancel", { kind: "task-cancel" }],
    ["task-update", { kind: "task-update" }],
    ["workflow-tool-call", { kind: "workflow-tool-call", workflowId: "w1" }],
  ] as const) {
    const only = new Map<string, unknown>([["ctl", dispatchTool("ctl", target as unknown as Record<string, unknown>)]]);
    ok(
      Object.keys(wf.buildWorkflowHostTools({ tools: only })).length === 0,
      `a \`${label}\` dispatch tool is NOT exposed to the sandbox (only agent-call targets are)`,
    );
  }
  for (const [label, target] of [
    ["subagent-call", { kind: "subagent-call", nodeId: "n", subagentName: "s" }],
    ["self-agent-call", { kind: "self-agent-call", nodeId: "n", subagentName: "s" }],
    ["remote-agent-call", { kind: "remote-agent-call", nodeId: "n", remoteAgentName: "r" }],
  ] as const) {
    const only = new Map<string, unknown>([["d", dispatchTool("d", target as unknown as Record<string, unknown>)]]);
    ok(
      Object.keys(wf.buildWorkflowHostTools({ tools: only })).length === 1,
      `NEGATIVE CONTROL: a \`${label}\` dispatch tool IS exposed — the exclusions above are the filter, not an empty fixture`,
    );
  }

  const bg = new Map<string, unknown>([
    ["bg", { ...dispatchTool("bg", { kind: "subagent-call", nodeId: "n", subagentName: "bg" }), execution: "background" }],
  ]);
  ok(
    "bg" in wf.buildWorkflowHostTools({ tools: bg }),
    "a BACKGROUND delegation tool is still exposed to the sandbox (the host filter ignores `execution`)",
  );

  const nonRtaOnly = new Map<string, unknown>([
    ["read_notion_page", gatedConnectorOp],
    ["reply", { name: "reply", description: "reply", inputSchema: {}, execute: gatedExecute }],
  ]);
  const emptyHost = wf.buildWorkflowHostTools({ tools: nonRtaOnly });
  ok(
    Object.keys(emptyHost).length === 0,
    "a tool-set with no delegation tools yields an EMPTY sandbox host set (⇒ Workflow tool never registered)",
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
    `(OE posture: no workflow.ts / no experimental_workflow / zero delegation tools · eve pin: sandbox exposes only wrapped agent-call delegation tools · ` +
    `live: benign runs, fetch fail-closed, connector op unreachable)\n`,
);
