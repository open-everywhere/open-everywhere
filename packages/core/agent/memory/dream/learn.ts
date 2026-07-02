import type { RecurrenceLedger } from "./recurrence.js";
import { workflowSignature } from "./recurrence.js";
import type { Proposal } from "./proposal.js";

export interface LearnSignals {
  readonly request?: string;
}

export interface LearnOptions {
  readonly enrichThreshold?: number;
  readonly skillThreshold?: number;
}

export interface LearnResult {
  readonly signature: string | null;
  readonly count: number;
  readonly enrich: boolean;
  readonly skillProposal: Proposal | null;
}

export function proposedSkillSketch(signature: string, request: string, count: number): string {
  const name = signature.split(" ").slice(0, 4).join("-") || "recurring-workflow";
  return [
    `---`,
    `name: ${name}`,
    `description: Auto-proposed from a workflow seen ${count}× (recurrence-gated). Review before enabling.`,
    `---`,
    ``,
    `# ${name}`,
    ``,
    `This workflow recurred ${count} times, so the dream cycle proposes capturing it as a reusable skill.`,
    ``,
    `## Trigger`,
    `Requests like: "${request.slice(0, 200)}"`,
    ``,
    `## Steps`,
    `1. (fill in the repeated steps — the cycle detected the pattern, a human authors the procedure)`,
    ``,
    `> Proposed by the Mode-1 dream cycle. Not active until a human reviews and merges it.`,
  ].join("\n");
}

export async function learnFromSession(
  scope: string,
  signals: LearnSignals,
  ledger: RecurrenceLedger,
  opts: LearnOptions = {},
): Promise<LearnResult> {
  const enrichThreshold = opts.enrichThreshold ?? 3;
  const skillThreshold = opts.skillThreshold ?? 3;
  const request = signals.request?.trim();
  const empty: LearnResult = { signature: null, count: 0, enrich: false, skillProposal: null };
  if (!request) return empty;

  const signature = workflowSignature(request);
  if (!signature) return empty;

  const key = `${scope}::${signature}`;
  const count = await ledger.observe(key);

  const skillProposal: Proposal | null =
    count === skillThreshold
      ? {
          kind: "skill",
          scope,
          summary: `repeated workflow (${count}×) → proposed SKILL.md: "${signature}"`,
          after: proposedSkillSketch(signature, request, count),
          detail: { signature, count, request: request.slice(0, 200) },
        }
      : null;

  return { signature, count, enrich: count === enrichThreshold, skillProposal };
}
