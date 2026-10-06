import { defineHook, type HookContext } from "eve/hooks";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { recordSpend } from "../spend/store.js";
import { appendUsageEvent, GENERATION_ID_DETAIL_KEY } from "../spend/usage-events.js";
import { noteCompletedModelStep } from "../model/call-capture.js";
import { periodOf, UNKNOWN_MODEL, type Usage } from "../spend/spend.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { routineMarker } from "../routines/routine.js";
import { noteHostStepModel, readHostStepModel, readModelStamp } from "../model/model-stamp.js";
import { readModelArm, MODEL_ARM_DETAIL_KEY, MODEL_AB_BUCKET_DETAIL_KEY, type ModelArmStamp } from "../model/ab-test.js";
import { getOperationalStore } from "../operational/provider.js";
import type { SurfaceMode } from "../operational/store.js";
import { isSupervisorToken, standingSeatRegistryKey, unifiedWindowFromToken } from "../channels/unified-supervisor.js";
import { parseDmSeatToken, dmSeatRegistryKey, bareTokenFromEveContext, parseSubagentToken } from "../channels/window-key.js";
import { delegationDepthOf, stampSubagentRun } from "../spend/subagent-runs.js";

export function routineIdOf(ctx: BindableContext): string | undefined {
  try {
    const auth = ctx.session?.auth;
    return routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes)?.id;
  } catch {
    return undefined;
  }
}

export type DelegatableContext = BindableContext;

export function subagentParentOf(
  ctx: DelegatableContext,
  continuationToken?: unknown,
): { parentSessionId: string; callId: string; rootSessionId?: string } | undefined {
  try {
    const p = ctx.session?.parent;
    if (typeof p?.sessionId === "string" && p.sessionId.length > 0 && typeof p.callId === "string" && p.callId.length > 0) {
      return {
        parentSessionId: p.sessionId,
        callId: p.callId,
        ...(typeof p.rootSessionId === "string" && p.rootSessionId.length > 0 ? { rootSessionId: p.rootSessionId } : {}),
      };
    }
    const parsed = parseSubagentToken(continuationToken);
    return parsed ? { parentSessionId: parsed.parentSessionId, callId: parsed.callId } : undefined;
  } catch {
    return undefined;
  }
}

export function turnSurfaceMode(ctx: BindableContext): SurfaceMode | undefined {
  try {
    const binding = bindFrom(ctx);
    if (!binding.modeResolved) return undefined;
    const mode = binding.mode;
    return mode === "dm" || mode === "mpim" || mode === "channel" ? mode : undefined;
  } catch {
    return undefined;
  }
}

export function turnKind(ctx: DelegatableContext, continuationToken?: unknown): string {
  try {
    const auth = ctx.session?.auth;
    const attrs = auth?.current?.attributes ?? auth?.initiator?.attributes;
    if (routineMarker(attrs)) return "routine";
    if (isSupervisorToken(continuationToken)) return "supervisor";
    if (subagentParentOf(ctx, continuationToken)) return "subagent";
    const binding = bindFrom(ctx);
    if (!binding.modeResolved) return "unclassified";
    return binding.mode === "dm" ? "dm" : "channel";
  } catch {
    return "unclassified";
  }
}

function turnWindowToken(ctx: BindableContext): string | undefined {
  return bareTokenFromEveContext(ctx.channel?.continuationToken) ?? ctx.channel?.continuationToken;
}

function seatCounterDelta(usage: Usage): number {
  return usage.inputTokens ?? 0;
}

export type SpendAttributionContext = DelegatableContext & { readonly session?: { readonly id?: string } };

export interface AttributedModelCall {
  readonly usage: Usage;
  readonly model?: string;
  readonly generationId?: string;
  readonly what?: string;
  readonly arm?: ModelArmStamp;
}

export async function recordModelCall(ctx: SpendAttributionContext, call: AttributedModelCall): Promise<void> {
  try {
    const usage = call.usage;
    if (!usage || (usage.inputTokens == null && usage.outputTokens == null && usage.costUsd == null)) return;
    const p = resolvePartition(ctx);
    const token = turnWindowToken(ctx);
    const routineId = routineIdOf(ctx);
    const delegatedFrom = subagentParentOf(ctx, token);
    const sessionId = ctx.session?.id ?? "";

    const model = call.model ?? UNKNOWN_MODEL;
    if (call.model === undefined) {
      console.warn(
        `[open-everywhere:spend] a billable model call (${call.what ?? "unknown source"}) carried NO model id — recording as model="${UNKNOWN_MODEL}" and SKIPPING rate-derived pricing ` +
          `(session=${sessionId || "?"} surface=${p.key} in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0}). ` +
          `Tokens and (where the gateway measured it) exact $ are still recorded; only the rate-derived $ is withheld, because nothing observed which model ran.`,
      );
    }

    const measuredUsd = typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : undefined;

    const delegationDepth = delegatedFrom ? delegationDepthOf(delegatedFrom.parentSessionId, delegatedFrom.rootSessionId) : 0;
    const rootSessionId = delegatedFrom?.rootSessionId ?? delegatedFrom?.parentSessionId ?? sessionId;

    try {
      await recordSpend(p, {
        period: periodOf(new Date().toISOString()),
        usage,
        principalId: bindFrom(ctx).principalId,
        routineId,
        model,
        ...((): { surfaceMode?: SurfaceMode } => {
          const mode = turnSurfaceMode(ctx);
          return mode ? { surfaceMode: mode } : {};
        })(),
        ...(measuredUsd !== undefined ? { measuredUsd } : {}),
      });
    } catch (err) {
      console.log(`[open-everywhere:spend] record skipped: ${String(err)}`);
    }

    try {
      await appendUsageEvent({
        org: p.org,
        surfaceKey: domainKeyOf(p),
        sessionId: delegatedFrom?.parentSessionId ?? sessionId,
        principalId: bindFrom(ctx).principalId,
        kind: turnKind(ctx, token),
        ...((): { surfaceMode?: SurfaceMode } => {
          const mode = turnSurfaceMode(ctx);
          return mode ? { surfaceMode: mode } : {};
        })(),
        ...((): { detail?: Readonly<Record<string, unknown>> } => {
          const arm = call.arm;
          const detail = {
            ...(delegatedFrom
              ? stampSubagentRun({
                  callId: delegatedFrom.callId,
                  sessionId,
                  ...(delegatedFrom.rootSessionId !== undefined ? { rootSessionId: delegatedFrom.rootSessionId } : {}),
                  depth: delegationDepth,
                })
              : {}),
            ...(call.generationId !== undefined ? { [GENERATION_ID_DETAIL_KEY]: call.generationId } : {}),
            ...(arm ? { [MODEL_ARM_DETAIL_KEY]: arm.arm, [MODEL_AB_BUCKET_DETAIL_KEY]: arm.bucketKey } : {}),
          };
          return Object.keys(detail).length > 0 ? { detail } : {};
        })(),
        ...(measuredUsd !== undefined ? { usdMicrosMeasured: Math.round(measuredUsd * 1_000_000), costSource: "measured" as const } : { costSource: "derived" as const }),
        delegationDepth,
        rootSessionId,
        ...(routineId !== undefined ? { routineId } : {}),
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
      });
    } catch (err) {
      console.warn(`[open-everywhere:usage] event append skipped: ${String(err)}`);
    }
  } catch (err) {
    console.warn(`[open-everywhere:spend] model-call record skipped: ${String(err)}`);
  }
}

export default defineHook({
  events: {
    "step.started": (event) => {
      try {
        noteHostStepModel(event.data.modelId);
      } catch (err) {
        console.warn(`[open-everywhere:spend] host model reference not recorded: ${String(err)}`);
      }
    },
    "step.completed": async (event, ctx: HookContext) => {
      noteCompletedModelStep(ctx.session?.id, (event.data as { turnId?: string } | undefined)?.turnId, ctx);
      const usage = event.data?.usage as Usage | undefined;
      if (!usage || (usage.inputTokens == null && usage.outputTokens == null && usage.costUsd == null)) return;
      const token = turnWindowToken(ctx);

      const generationId = ((): string | undefined => {
        const raw = (event.data as { providerMetadata?: { gateway?: { generationId?: unknown } } } | undefined)?.providerMetadata?.gateway?.generationId;
        return typeof raw === "string" && raw.length > 0 ? raw : undefined;
      })();

      const stampedModel = readModelStamp() ?? readHostStepModel() ?? undefined;
      const stampedArm = readModelArm() ?? undefined;
      await recordModelCall(ctx, {
        usage,
        ...(stampedModel !== undefined ? { model: stampedModel } : {}),
        ...(generationId !== undefined ? { generationId } : {}),
        ...(stampedArm !== undefined ? { arm: stampedArm } : {}),
        what: "a turn step",
      });

      const p = resolvePartition(ctx);

      if (isSupervisorToken(token)) {
        try {
          const delta = seatCounterDelta(usage);
          const registryKey = standingSeatRegistryKey(token, domainKeyOf(p)) ?? domainKeyOf(p);
          if (delta > 0) {
            const matched = await getOperationalStore().bumpChannelSessionUsage(p.org, registryKey, token, delta);
            if (matched === 0) {
              console.warn(`[open-everywhere:spend] supervisor counter bump matched no row (org=${p.org} key=${registryKey} token=${token})`);
            }
          }
        } catch (err) {
          console.warn(`[open-everywhere:spend] supervisor token counter bump skipped: ${String(err)}`);
        }
      }

      const dmSeat = parseDmSeatToken(token);
      if (!dmSeat && !isSupervisorToken(token) && turnKind(ctx, token) === "dm") {
        console.warn(`[open-everywhere:spend] dm turn carried a token with no rotation lever (token=${JSON.stringify(token)}) — no seat counter bumped`);
      }
      if (dmSeat) {
        try {
          const delta = seatCounterDelta(usage);
          if (delta > 0) {
            const matched = await getOperationalStore().bumpChannelSessionUsage(p.org, dmSeatRegistryKey(dmSeat.channelId), token as string, delta);
            if (matched === 0) console.warn(`[open-everywhere:spend] dm-seat counter bump matched no row (org=${p.org} key=${dmSeatRegistryKey(dmSeat.channelId)} token=${token})`);
          }
        } catch (err) {
          console.warn(`[open-everywhere:spend] dm-seat token counter bump skipped: ${String(err)}`);
        }
      }
    },
  },
});
