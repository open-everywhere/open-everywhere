import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { subagentParentOf } from "../hooks/spend.js";
import { subagentRunOf } from "../spend/subagent-runs.js";
import { usageForSession } from "../spend/usage-events.js";
import { resolveAssumedModel, rowCostUsd, pricingMix, pricingNote, tokenAttributionNote } from "../spend/reporting.js";
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
    reasoningTokens: z.number().nonnegative().describe("Reasoning tokens across the calls that REPORTED the dimension — read it with reasoningReportedCalls, never alone."),
    cacheReportedCalls: z.number().int().nonnegative().describe("How many of `events` reported a cache split at all. The remainder's cache zeros assert nothing — see the note."),
    reasoningReportedCalls: z.number().int().nonnegative().describe("How many of `events` reported a reasoning-token count at all."),
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
    const delegatedFrom = subagentParentOf(ctx);
    const all = await usageForSession(p.org, delegatedFrom?.parentSessionId ?? sessionId);
    const rows = delegatedFrom ? all.filter((r) => subagentRunOf(r)?.sessionId === sessionId) : all;
    const delegatedRows = delegatedFrom ? 0 : rows.filter((r) => subagentRunOf(r) !== undefined).length;
    const assumed = resolveAssumedModel(input.assumedModelId);

    let events = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let reasoningTokens = 0;
    let cacheReportedCalls = 0;
    let reasoningReportedCalls = 0;
    let sandboxSeconds = 0;
    let costUsd: number | undefined;

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
      if (r.cacheTokensReported === true) cacheReportedCalls++;
      if (r.reasoningTokens !== undefined) {
        reasoningTokens += r.reasoningTokens;
        reasoningReportedCalls++;
      }
      const rowCost = rowCostUsd(r, assumed);
      if (rowCost !== undefined) costUsd = (costUsd ?? 0) + rowCost;
    }
    if (costUsd === undefined && assumed.pricing) costUsd = 0;

    const mix = pricingMix(
      rows.filter((r) => r.kind !== "sandbox"),
      assumed,
    );
    const sandboxCostUsd = sandboxSeconds > 0 ? estimateSandboxCostUsd(sandboxSeconds) : undefined;

    const notes = [
      pricingNote(mix, assumed),
      tokenAttributionNote({ calls: events, cacheReadTokens, cacheWriteTokens, reasoningTokens, cacheReportedCalls, reasoningReportedCalls }),
    ];
    if (delegatedRows > 0) {
      notes.push(`Includes ${delegatedRows} model call(s) made by subagent(s) this conversation delegated to — delegated work is part of what the conversation cost.`);
    }
    if (delegatedFrom !== undefined) {
      notes.push("This is a delegated subagent session, so these are its own rows only — its parent conversation's turns are not counted here.");
    }
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
      reasoningTokens,
      cacheReportedCalls,
      reasoningReportedCalls,
      ...(costUsd !== undefined ? { costUsd, pricedModel: assumed.model } : {}),
      sandboxSeconds: Math.round(sandboxSeconds),
      ...(sandboxCostUsd !== undefined ? { sandboxCostUsd } : {}),
      note: notes.join(" "),
    };
  },
});
