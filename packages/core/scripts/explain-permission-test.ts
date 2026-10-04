import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-explain-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const { registerConfig } = await import("../agent/access/config.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const tool = (await import("../agent/tools/explain_permission.js")).default as {
  execute(
    input: { tool: string; unattended?: boolean; tainted?: boolean; domain?: string },
    ctx: unknown,
  ): Promise<{ verdict: string; resolvedBy: string; registryVerdict: string; transforms: string[]; trace: string }>;
};

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

registerConfig({
  loadBundles: () => [
    {
      name: "policy",
      approvers: [
        {
          name: "no-tickets-here",
          approve: (req: { readonly tool?: string }) => (req.tool === "create_ticket" ? "deny" : undefined),
        },
      ],
    },
  ],
  loadBindings: () => [{ bundle: "policy", scope: { level: "domain", domain: "ops" } }],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: "bypassed", reach: ["slack/T1/C2"], approvalMode: { mode: "DANGEROUSLY_BYPASS" } }],
  loadSilos: () => [],
  domainsForSurface: () => ["ops"],
});

const ctx = {
  channel: { kind: "local" },
  session: { id: "sess_explain", auth: { current: { attributes: {}, principalId: "U_ASKER" } } },
};

{
  const res = await tool.execute({ tool: "open_pull_request" }, ctx);
  ok(res.verdict === "ask" && res.resolvedBy === "registry" && res.registryVerdict === "ask", "simulate: a gated verb reads ask by the registry");
  ok(res.trace.includes("registry baseline") && res.trace.includes("[registry]"), "simulate: the trace is the shared formatter's (baseline + elements)");
}

{
  const res = await tool.execute({ tool: "create_ticket" }, ctx);
  ok(res.verdict === "deny" && res.resolvedBy === "custom:no-tickets-here", "simulate: an L1 config deny resolves AND names its element");
  ok(res.trace.includes("DENY IS ABSOLUTE"), "simulate: the trace states the absolute-deny property");
}

{
  const res = await tool.execute({ tool: "open_pull_request", unattended: true }, ctx);
  ok(res.verdict === "deny" && res.transforms.some((t) => t.includes("ask-unattended")), "simulate: unattended:true previews the fire's ask → deny");
}

{
  const res = await tool.execute({ tool: "open_pull_request", domain: "bypassed" }, ctx);
  ok(res.verdict === "allow" && res.transforms.some((t) => t.startsWith("mode:DANGEROUSLY_BYPASS")), "simulate: domain override previews that domain's BYPASS transform");
}

{
  const res = await tool.execute({ tool: "open_pull_request", tainted: true }, ctx);
  ok(res.trace.includes("tainted: true — supplied by the caller"), "simulate: a SUPPLIED tainted names itself supplied in the trace");
  ok(res.trace.includes("this turn: false"), "simulate: …and the trace discloses this turn's own signal beside it");
}
{
  const res = await tool.execute({ tool: "open_pull_request" }, ctx);
  ok(res.trace.includes("tainted: false") && !res.trace.includes("supplied by the caller"), "simulate: an UNSUPPLIED tainted is a live read and is NOT marked supplied (=== absent)");
}

{
  const res = await tool.execute({ tool: "reply" }, ctx);
  ok(res.verdict === "allow" && res.transforms.length === 0, "simulate: an open verb reads allow, untransformed");
}

{
  const orgs = await getOperationalStore().listAuditOrgs();
  ok(orgs.length === 0, `simulate: a simulation writes NO audit rows in ANY org — the approval.chain row records decisions, not curiosity (found: ${orgs.join(", ") || "none"})`);
}

console.log(`✓ explain-permission: ${passed} assertions — the simulator resolves the real chain (config deny named, unattended/domain previews, shared trace formatter) and records nothing`);
await removeTempDir(tmp);
