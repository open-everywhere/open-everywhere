import { defangProposalField } from "./correction.js";
import type { RecurrenceLedger } from "./recurrence.js";
import { workflowSignature } from "./recurrence.js";
import { DREAM_ACTOR, type Proposal } from "./proposal.js";
import { writeMemoryTier } from "../write-road.js";
import type { DreamJudge, DistillInput, DistilledFact } from "./judge.js";
import type { Partition } from "../partition.js";
import type { Tier } from "../store.js";
import type { MemorySilo } from "../silo.js";
import { providerById, type MemoryAccess } from "../provider.js";
import { upsertUnderSection } from "../markdown.js";

export interface LearnSignals {
  readonly request?: string;
  readonly messages?: readonly string[];
  readonly dedupeKey?: string;
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

function proposedSkillSketch(signature: string, request: string, count: number): string {
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
    `Requests like: "${defangProposalField(request, 200)}"`,
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

  const count = await ledger.observe({ scope, signature }, signals.dedupeKey);

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

export async function safeDistill(judge: DreamJudge | null, input: DistillInput): Promise<readonly DistilledFact[] | null> {
  if (!judge) return null;
  try {
    return await judge.distill(input);
  } catch {
    return null;
  }
}

export function enrichmentBullets(
  result: Pick<LearnResult, "signature" | "count">,
  facts: readonly DistilledFact[] | null,
  today: string,
): string[] {
  if (facts && facts.length > 0) {
    return facts.slice(0, 3).map((f) => {
      const links = f.links
        .filter((l) => !f.text.includes(`[[${l}]]`))
        .map((l) => ` [[${l}]]`)
        .join("");
      return `- ${today}: ${f.text}${links}`;
    });
  }
  return [`- ${today}: recurring workflow — ${result.signature} (seen ${result.count}×) [[MEMORY]]`];
}

export async function writeEnrichment(
  p: Partition,
  target: { readonly tier: Tier; readonly silo: MemorySilo; readonly access?: MemoryAccess },
  bullets: readonly string[],
): Promise<string | null> {
  const provider = providerById(target.silo.provider);
  const files = await provider.readTier(p, target.tier, target.silo, target.access);
  const seed = `# Recurring workflows (auto-learned)\n\n## Recurring\n(none yet)\n`;
  let recurring = files["RECURRING.md"] ?? seed;
  for (const b of bullets) recurring = upsertUnderSection(recurring, "Recurring", b);
  files["RECURRING.md"] = recurring;
  const { version } = await writeMemoryTier({
    provider,
    partition: p,
    tier: target.tier,
    files,
    message: `dream:learn recurrence enrich [${target.silo.name}]`,
    silo: target.silo,
    access: target.access,
    road: "dream-learn",
    platform: "memory",
    workspace: target.silo.name,
    principalId: DREAM_ACTOR,
    extra: { bullets: bullets.length },
  });
  return version;
}
