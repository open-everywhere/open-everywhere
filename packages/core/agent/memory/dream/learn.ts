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
import { supersedeUnderSection, upsertUnderSection } from "../markdown.js";

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
  readonly skipped: "memory-instruction" | null;
}

function proposedSkillSketch(signature: string, request: string, count: number): string {
  const name = signature.split(" ").slice(0, 4).join("-") || "recurring-workflow";
  return [
    `---`,
    `name: ${name}`,
    `description: Suggested after this task came up ${count} times. Review before enabling.`,
    `---`,
    ``,
    `# ${name}`,
    ``,
    `This task came up ${count} times, so I suggest saving it as a reusable skill.`,
    ``,
    `## Trigger`,
    `Requests like: "${defangProposalField(request, 200)}"`,
    ``,
    `## Steps`,
    `1. (fill in the repeated steps — I spotted the pattern, and a person writes the procedure)`,
    ``,
    `> Suggested automatically. Not active until a person reviews and merges it.`,
  ].join("\n");
}

const MEMORY_OBJECT = String.raw`(?:memor(?:y|ies)|stored\s+facts?|silos?|brains?|(?:your|our|my)\s+notes?)`;
const ERASE_VERB = String.raw`(?:erase|delete|remove|purge|wipe|scrub|expunge)`;
const ERASE_PARTICIPLE = String.raw`(?:erased?|deleted?|removed?|purged?|wiped?|scrubbed?|expunged?|forgotten)`;

const MEMORY_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${ERASE_VERB}\b[^.!?\n]{0,80}?\b${MEMORY_OBJECT}\b`, "i"),
  new RegExp(String.raw`\b${MEMORY_OBJECT}\b[^.!?\n]{0,80}?\b${ERASE_PARTICIPLE}\b`, "i"),
  /(?<!\b(?:don'?t|do\s+not|never|won'?t|can'?t|cannot)(?:\s+\w+){0,2}\s+)\bforget\s+(?:this|that|these|those|it|them|everything|all|about|any|what|the|my|our|your)\b/i,
  /\b(?:don'?t|do\s+not|never|stop|no\s+longer)\s+(?:remember|remembering|store|storing|save|saving|retain|retaining|persist|persisting|keep|keeping)\s+(?:this|that|these|those|it|them|anything|what\s+(?:i|we)\b)/i,
];

const NON_PERSISTENCE = /\b(?:must|should|shall|may|can|do)(?:\s+not|n['’]?t)\s+(?:be\s+)?(?:persist(?:ed)?|stored?|remembered|retained|kept)\b/i;
const NO_PERSISTENCE_SUBJECT = /\b(?:nothing|none\s+of\s+(?:this|that|it|them)|no\s+(?:facts?|notes?|records?|bullets?))\b[^.!?\n]{0,60}?\b(?:persists?|persisted|stored?|remembered|retained|kept)\b/i;
const MEMORY_ANCHOR = /\b(?:memor(?:y|ies)|stored\s+facts?|recall|silos?|brains?)\b/i;

export function isMemoryInstruction(text: string | undefined): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const flat = text.replace(/\s+/g, " ");
  if (MEMORY_INSTRUCTION_PATTERNS.some((re) => re.test(flat))) return true;
  return (NON_PERSISTENCE.test(flat) || NO_PERSISTENCE_SUBJECT.test(flat)) && MEMORY_ANCHOR.test(flat);
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
  const empty: LearnResult = { signature: null, count: 0, enrich: false, skillProposal: null, skipped: null };
  if (!request) return empty;

  if (isMemoryInstruction(request)) return { ...empty, skipped: "memory-instruction" };

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

  return { signature, count, enrich: count === enrichThreshold, skillProposal, skipped: null };
}

export async function safeDistill(judge: DreamJudge | null, input: DistillInput): Promise<readonly DistilledFact[] | null> {
  if (!judge) return null;
  if (isMemoryInstruction(input.request)) return null;
  const messages = input.messages?.filter((m) => !isMemoryInstruction(m));
  try {
    return await judge.distill(messages === undefined ? input : { ...input, messages });
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

const ENRICHMENT_SIGNATURE = /recurring workflow — (.+?) \(seen \d+/;

export function enrichmentSignatureOf(bullet: string): string | null {
  return bullet.match(ENRICHMENT_SIGNATURE)?.[1] ?? null;
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
  let superseded = 0;
  for (const b of bullets) {
    const key = enrichmentSignatureOf(b);
    if (key === null) {
      recurring = upsertUnderSection(recurring, "Recurring", b);
      continue;
    }
    const step = supersedeUnderSection(recurring, "Recurring", b, (existing) => enrichmentSignatureOf(existing) === key);
    recurring = step.content;
    if (step.superseded !== null) superseded++;
  }
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
    extra: { bullets: bullets.length, superseded },
  });
  return version;
}
