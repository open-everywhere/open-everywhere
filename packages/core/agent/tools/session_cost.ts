import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { usageForSession } from "../spend/usage-events.js";
import { estimateCostUsd } from "../spend/pricing.js";
import { resolveAssumedModel } from "../spend/reporting.js";
import { estimateSandboxCostUsd } from "../spend/sandbox-pricing.js";

export default defineTool({
  description:
    "What did THIS conversation cost so far — tokens (input/output/cache), an estimated $ (if a model can be assumed), and sandbox runtime seconds + an estimated $ for any sandbox time this session used. Your own conversation only; no role required. $ figures are estimates, always labelled with the assumption behind them.",
  inputSchema: z.object({
    assumedModelId: z
      .string()
      .optional()
      .describe(
        "Price token usage as if it were this model id (hook-written usage rows carry no model field, so this can't be read back automatically). Omit to let the deploy's sole configured model price it, if there is exactly one.",
      ),
  }),
  outputSchema: z.object({
    sessionId: z.string(),
    events: z.number().int().nonnegative().describe("Row count of non-sandbox usage events (~model calls, not user-visible turns)."),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    pricedModel: z.string().optional(),
    sandboxSeconds: z.number().nonnegative(),
    sandboxCostUsd: z.number().nonnegative().optional(),
    note: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const sessionId = ctx.session.id;
    const rows = await usageForSession(p.org, sessionId);

    let events = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let sandboxSeconds = 0;

    for (const r of rows) {
      if (r.kind === "sandbox") {
        const s = r.detail?.sandboxSeconds;
        sandboxSeconds += typeof s === "number" ? s : 0;
        continue;
      }
      events++;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      cacheReadTokens += r.cacheReadTokens;
      cacheWriteTokens += r.cacheWriteTokens;
    }

    const assumed = resolveAssumedModel(input.assumedModelId);
    const costUsd = assumed.pricing ? estimateCostUsd({ inputTokens, outputTokens, cacheReadTokens }, assumed.pricing) : undefined;
    const sandboxCostUsd = sandboxSeconds > 0 ? estimateSandboxCostUsd(sandboxSeconds) : undefined;

    const notes = [assumed.note];
    if (sandboxSeconds > 0) {
      notes.push(
        "sandbox $ estimated from Vercel Sandbox's published Provisioned Memory rate at the platform-default sandbox size (verified against real billing — see the sandbox cost-model notes); an actual bill can differ if this deploy pins a non-default sandbox memory size.",
      );
    }

    return {
      sessionId,
      events,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(costUsd !== undefined ? { costUsd, pricedModel: assumed.model } : {}),
      sandboxSeconds: Math.round(sandboxSeconds),
      ...(sandboxCostUsd !== undefined ? { sandboxCostUsd } : {}),
      note: notes.join(" "),
    };
  },
});
