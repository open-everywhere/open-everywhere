import {
  resolveApproverChain,
  type ApprovalChainRequest,
  type ChainResolution,
  type OperatorApprover,
} from "./approver-chain.js";

export interface ApprovalScenario {
  readonly name: string;
  readonly request: ApprovalChainRequest;
  readonly approvers?: readonly OperatorApprover[];
  readonly expect: {
    readonly verdict: "allow" | "deny" | "ask";
    readonly resolvedBy?: string;
    readonly transforms?: readonly string[];
    readonly registryVerdict?: "allow" | "ask";
  };
}

export async function runApprovalScenarios(scenarios: readonly ApprovalScenario[]): Promise<string[]> {
  const failures: string[] = [];
  for (const s of scenarios) {
    const res: ChainResolution = await resolveApproverChain(s.request, s.approvers !== undefined ? { approvers: s.approvers } : {});
    if (res.verdict !== s.expect.verdict) {
      failures.push(`scenario "${s.name}": expected verdict ${s.expect.verdict}, got ${res.verdict} (resolvedBy ${res.resolvedBy})`);
      continue;
    }
    if (s.expect.resolvedBy !== undefined && res.resolvedBy !== s.expect.resolvedBy) {
      failures.push(`scenario "${s.name}": expected resolvedBy ${s.expect.resolvedBy}, got ${res.resolvedBy}`);
    }
    if (s.expect.transforms !== undefined) {
      const applied = res.transforms.map((t) => t.name);
      if (JSON.stringify(applied) !== JSON.stringify(s.expect.transforms)) {
        failures.push(`scenario "${s.name}": expected transforms [${s.expect.transforms.join(", ")}], got [${applied.join(", ")}]`);
      }
    }
    if (s.expect.registryVerdict !== undefined && res.registryVerdict !== s.expect.registryVerdict) {
      failures.push(`scenario "${s.name}": expected registryVerdict ${s.expect.registryVerdict}, got ${res.registryVerdict}`);
    }
  }
  return failures;
}
