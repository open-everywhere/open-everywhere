import {
  resolveApproverChain,
  renderChainResolution,
  type ApprovalChainRequest,
  type ApprovalModeName,
} from "../agent/access/approver-chain.js";

const args = process.argv.slice(2);
const tool = args.find((a) => !a.startsWith("--"));
if (tool === undefined) {
  console.error("usage: explain-permission.ts <tool> [--domain <name>] [--unattended] [--mode <MODE>] [--allowlist a,b,c]");
  process.exit(2);
}
function flagValue(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const modeName = flagValue("mode");
if (modeName !== undefined && !["DANGEROUSLY_BYPASS", "APPROVE_ALL", "DENY_ALL"].includes(modeName)) {
  console.error(`unknown --mode "${modeName}" — must be DANGEROUSLY_BYPASS, APPROVE_ALL or DENY_ALL`);
  process.exit(2);
}
const allowlist = flagValue("allowlist")?.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

const request: ApprovalChainRequest = {
  tool,
  ...(flagValue("domain") !== undefined ? { domain: flagValue("domain") } : {}),
  unattended: args.includes("--unattended"),
  ...(modeName !== undefined ? { mode: { mode: modeName as ApprovalModeName, ...(allowlist !== undefined ? { allowlist } : {}) } } : {}),
};

const resolution = await resolveApproverChain(request);
console.log(renderChainResolution(request, resolution).join("\n"));
process.exit(0);
