import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "@ai-sdk/gateway";
import { generateText } from "ai";
import { clearApprovalJudgeVerdictCache, registerApprovalJudgeCompletion, runApprovalJudge, type ApprovalJudgeCompletion } from "../../agent/access/approval-judge.js";
import { approvalJudgeCases, drawApprovalJudgeCases, loadStarterRules, reportApprovalJudgeCases } from "./approval-judge-cases.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const REPEATS = Math.max(1, Number.parseInt(flag("--repeats") ?? "10", 10));
const JUDGE_MODEL = flag("--judge-model") ?? "openai/gpt-6-luna";
const SCRUTINY_MAX_OUTPUT_TOKENS = 512;

const key = process.env.AI_GATEWAY_API_KEY;
if (!key) throw new Error("AI_GATEWAY_API_KEY is unset — source .env.e2e, which sets AI_GATEWAY_API_KEY to the gateway key for your deployment");
const gateway = createGateway({ apiKey: key });
const completion: ApprovalJudgeCompletion = async (prompt, pass) => {
  const { text } = await generateText({
    model: gateway(JUDGE_MODEL),
    prompt,
    ...(pass === "scrutiny" ? { maxOutputTokens: SCRUTINY_MAX_OUTPUT_TOKENS } : {}),
  });
  return text;
};

const cases = approvalJudgeCases(await loadStarterRules());
const draws = await drawApprovalJudgeCases(cases, completion, REPEATS, { runApprovalJudge, registerApprovalJudgeCompletion, clearApprovalJudgeVerdictCache });
const report = reportApprovalJudgeCases(cases, draws);
console.log(`approval judge ${JUDGE_MODEL} · ${String(cases.length)} cases × ${String(REPEATS)} draws`);
for (const line of report.lines) console.log(line);

const here = dirname(fileURLToPath(import.meta.url));
const out = flag("--out") ?? join(here, "results", `approval-judge-consistency-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ model: JUDGE_MODEL, repeats: REPEATS, summary: report.summary, draws }, null, 2)}\n`);
console.log(`wrote ${out}`);
process.exit(report.passed ? 0 : 1);
