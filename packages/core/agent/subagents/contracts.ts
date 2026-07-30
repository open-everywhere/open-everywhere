import { z } from "zod";

export const REVIEW_SEVERITY = ["critical", "high", "medium", "low", "nit"] as const;

export const REVIEW_CATEGORY = [
  "security",
  "access-control",
  "correctness",
  "data-loss",
  "performance",
  "maintainability",
  "tests",
  "docs",
] as const;

export const FRESH_EYES_REVIEW_OUTPUT = z.object({
  recommendation: z.enum(["approve", "block"]).describe("block if any finding is critical/high, or if evidenceSeen is false"),
  summary: z.string().describe("One or two sentences: what the change does and the headline verdict."),
  evidenceSeen: z.boolean().describe("Did the caller actually include the change (diff/patch/file contents)? False forces block."),
  findings: z
    .array(
      z.object({
        severity: z.enum(REVIEW_SEVERITY),
        category: z.enum(REVIEW_CATEGORY),
        title: z.string().describe("One line, imperative or declarative — not a question."),
        detail: z.string().describe("Why it matters and what to do about it."),
        location: z.string().optional().describe("file:line or symbol, when the change text gives one."),
      }),
    )
    .describe("Empty when the change is clean. Do not pad."),
  meaning: z
    .array(
      z.object({
        subject: z.string().describe("What this reading is about — a scope/domain/hook/file, named exactly as the facts name it."),
        says: z.string().describe("One plain sentence: what the change means for that subject."),
      }),
    )
    .optional()
    .describe("Per-subject plain-language readings. Fill it when the caller asked for a walkthrough; omit it otherwise."),
});

export type FreshEyesReviewOutput = z.infer<typeof FRESH_EYES_REVIEW_OUTPUT>;

export const RECALL_VERIFICATION_OUTPUT = z.object({
  verdict: z.enum(["verified", "unverified"]).describe("verified only if every part of the claim is entailed by the quoted evidence"),
  claim: z.string().describe("The claim as checked, restated in one sentence."),
  supportingEvidencePaths: z.array(z.string()).describe("Silo paths the caller quoted that DO support the claim."),
  contradictingEvidencePaths: z.array(z.string()).describe("Quoted paths that contradict it, if any."),
  unsupportedParts: z.array(z.string()).describe("Parts of the claim nothing quoted supports. Non-empty ⇒ unverified."),
  note: z.string().describe("One or two sentences of reasoning, including 'no evidence was supplied' when that is the answer."),
});

export type RecallVerificationOutput = z.infer<typeof RECALL_VERIFICATION_OUTPUT>;
