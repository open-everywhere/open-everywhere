import {
  estimateStackCostUsd,
  stackModelRateBand,
  stackPricedModelIds,
  type StackRoleMap,
} from "../agent/spend/stack-pricing.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

const SHIPPED_STACK_IDS = ["openai/gpt-6-luna", "alibaba/qwen3-vl-instruct", "deepseek/deepseek-v4.1-flash", "google/gemini-3.8-flash", "mistral/mistral-small"];
const RETIRED_EVIDENCE_IDS = ["deepseek/deepseek-v4-flash-0731"];
for (const id of SHIPPED_STACK_IDS) {
  ok(stackModelRateBand(id) !== undefined, `coverage: "${id}" (named by a shipped stack) has a measured rate band`);
}
ok(
  [...stackPricedModelIds()].sort().join(",") === [...SHIPPED_STACK_IDS, ...RETIRED_EVIDENCE_IDS].sort().join(","),
  "coverage: the priced table has exactly the shipped ids and the retired evidence id, no stragglers",
);

const luna = stackModelRateBand("openai/gpt-6-luna");
ok(luna !== undefined && luna.in.minPerMtok === luna.in.maxPerMtok && luna.in.minPerMtok === 0.125, "point band: luna's IN rate is a degenerate band at the measured $0.125/Mtok");
ok(luna !== undefined && luna.out.minPerMtok === luna.out.maxPerMtok && luna.out.minPerMtok === 0.5, "point band: luna's OUT rate is a degenerate band at the measured $0.50/Mtok");
const qwen = stackModelRateBand("alibaba/qwen3-vl-instruct");
ok(qwen !== undefined && qwen.in.minPerMtok === qwen.in.maxPerMtok && qwen.in.minPerMtok === 0.2, "point band: qwen3-vl-instruct's IN rate is a degenerate band at $0.20/Mtok");
const gemini = stackModelRateBand("google/gemini-3.8-flash");
ok(gemini !== undefined && gemini.in.minPerMtok === gemini.in.maxPerMtok && gemini.in.minPerMtok === 0.75, "point band: gemini-3.8-flash's IN rate is a degenerate band at the measured $0.75/Mtok (re-probe after 2027-01-01 — announced doubling)");
ok(gemini !== undefined && gemini.out.minPerMtok === gemini.out.maxPerMtok && gemini.out.minPerMtok === 3.75, "point band: gemini-3.8-flash's OUT rate is a degenerate band at the measured $3.75/Mtok");

const deepseek = stackModelRateBand("deepseek/deepseek-v4-flash-0731");
ok(deepseek !== undefined && deepseek.in.minPerMtok === 0.09 && deepseek.in.maxPerMtok === 0.14, "real band: deepseek IN spans the measured $0.09-$0.14/Mtok, not a single point");
ok(deepseek !== undefined && deepseek.out.minPerMtok === 0.18 && deepseek.out.maxPerMtok === 0.28, "real band: deepseek OUT spans the measured $0.18-$0.28/Mtok");
ok(deepseek !== undefined && deepseek.in.minPerMtok < deepseek.in.maxPerMtok, "real band: min < max (a genuine band, not a degenerate one wearing two fields)");

ok(stackModelRateBand("some/unknown-model") === undefined, "unknown id: no band, never a guess");

ok(luna?.longContext?.thresholdInputTokens === 272_001, "long-context band: luna's tier boundary is the catalog's 272,001 input tokens");
ok(luna?.longContext?.in.minPerMtok === 0.25 && luna?.longContext?.in.maxPerMtok === 0.25, "long-context band: luna's tier IN rate is a degenerate band at $0.25/Mtok (2x the base rate)");
ok(luna?.longContext?.out.minPerMtok === 0.75 && luna?.longContext?.out.maxPerMtok === 0.75, "long-context band: luna's tier OUT rate is a degenerate band at $0.75/Mtok (1.5x the base rate)");
ok(deepseek?.longContext === undefined && qwen?.longContext === undefined, "long-context band: an id the gateway does not tier carries no tier — the field is absent, not a copy of the base rate");

const longProfile = estimateStackCostUsd({ primary: { id: "openai/gpt-6-luna" } }, { primary: { inputTokens: 10_000_000, outputTokens: 0 } });
ok(close(longProfile.roles[0].maxUsd, 10 * 0.125), "estimate: a 10M-token PERIOD profile prices at the base rate — a period total is not a prompt size, so the tier never fires here");
ok(!close(longProfile.roles[0].maxUsd, 10 * 0.25), "estimate: and it is NOT the tier rate — the negative control for the assertion above");

const onePointStack: StackRoleMap = { primary: { id: "openai/gpt-6-luna" } };
const est1 = estimateStackCostUsd(onePointStack, { primary: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });
ok(est1.roles.length === 1 && est1.roles[0].role === "primary", "estimate: one role in, one role out");
ok(close(est1.roles[0].minUsd, 0.125 + 0.5) && close(est1.roles[0].maxUsd, 0.125 + 0.5), "estimate: point-rate role has minUsd === maxUsd (degenerate band all the way through)");
ok(close(est1.totalMinUsd, 0.125 + 0.5) && close(est1.totalMaxUsd, 0.125 + 0.5) && !est1.partial, "estimate: total matches the single role, and a fully-priced stack is never partial");

const bandStack: StackRoleMap = { primary: { id: "deepseek/deepseek-v4-flash-0731" } };
const est2 = estimateStackCostUsd(bandStack, { primary: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });
ok(close(est2.roles[0].minUsd, 0.09 + 0.18), "estimate: band role's minUsd uses the band's MIN rate");
ok(close(est2.roles[0].maxUsd, 0.14 + 0.28), "estimate: band role's maxUsd uses the band's MAX rate");
ok(est2.roles[0].minUsd < est2.roles[0].maxUsd, "estimate: a real band produces a real (non-degenerate) cost band, not a coincidental point");

const multiStack: StackRoleMap = {
  primary: { id: "openai/gpt-6-luna" },
  vision: { id: "alibaba/qwen3-vl-instruct" },
};
const est3 = estimateStackCostUsd(multiStack, {
  primary: { inputTokens: 2_000_000, outputTokens: 500_000 },
  vision: { inputTokens: 100_000, outputTokens: 10_000 },
});
const expectedPrimary = 2 * 0.125 + 0.5 * 0.5;
const expectedVision = 0.1 * 0.2 + 0.01 * 0.88;
ok(close(est3.totalMinUsd, expectedPrimary + expectedVision), "estimate: multi-role total is the sum of each role's own cost");
ok(!est3.partial, "estimate: a fully-priced multi-role stack is not partial");

const est4 = estimateStackCostUsd(onePointStack, {});
ok(est4.roles.length === 1 && est4.roles[0].minUsd === 0 && est4.roles[0].maxUsd === 0 && !est4.roles[0].unpriced, "estimate: a role missing from the profile is zero-usage (a REAL $0), still listed, never dropped or marked unpriced");

const gapStack: StackRoleMap = { primary: { id: "openai/gpt-6-luna" }, judge: { id: "acme/no-rate-model" } };
const est5 = estimateStackCostUsd(gapStack, {
  primary: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  judge: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
});
const judgeRole = est5.roles.find((r) => r.role === "judge");
ok(judgeRole !== undefined && judgeRole.unpriced === true && judgeRole.minUsd === 0 && judgeRole.maxUsd === 0, "estimate: an unpriced role's model gets unpriced:true, 0/0 — never a fabricated rate");
ok(est5.partial === true, "estimate: any unpriced role marks the WHOLE estimate partial");
ok(close(est5.totalMinUsd, 0.125 + 0.5) && close(est5.totalMaxUsd, 0.125 + 0.5), "estimate: the partial total still sums the roles that DO have a rate (excludes only the unpriced one)");

const est6 = estimateStackCostUsd({}, {});
ok(est6.roles.length === 0 && est6.totalMinUsd === 0 && est6.totalMaxUsd === 0 && !est6.partial, "estimate: an empty stack is a real, non-partial zero — not an error");

console.log(`✓ stack-pricing: ${passed} assertions passed`);
