import type { AuditEntry, UsageEventEntry } from "@open-everywhere/core/agent/operational/store.js";
import { rowCostUsd, type AssumedModelPricing } from "@open-everywhere/core/agent/spend/reporting.js";
import { MODEL_ARM_DETAIL_KEY, type ModelArm } from "@open-everywhere/core/agent/model/ab-test.js";

export const ARMS: readonly ModelArm[] = ["champion", "challenger"];

export interface ArmTally {
  turns: number;
  ratings: number;
  ratingSum: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  unpricedCalls: number;
}

export function emptyTally(): ArmTally {
  return { turns: 0, ratings: 0, ratingSum: 0, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, unpricedCalls: 0 };
}

export interface ModelAbRows {
  readonly armRows: readonly AuditEntry[];
  readonly ratingRows: readonly AuditEntry[];
  readonly usageBySession: ReadonlyMap<string, readonly UsageEventEntry[]>;
}

export interface ModelAbTallies {
  readonly tallies: Record<ModelArm, ArmTally>;
  readonly sessionArm: ReadonlyMap<string, ModelArm>;
}

export function armOf(detail: Readonly<Record<string, unknown>> | undefined, key: string): ModelArm | undefined {
  const raw = detail?.[key];
  return raw === "champion" || raw === "challenger" ? raw : undefined;
}

export function armedSessions(armRows: readonly AuditEntry[]): ReadonlyMap<string, ModelArm> {
  return tallyModelAb({ armRows, ratingRows: [], usageBySession: new Map() }, { note: "" }).sessionArm;
}

export function tallyModelAb(rows: ModelAbRows, assumed: AssumedModelPricing): ModelAbTallies {
  const tallies: Record<ModelArm, ArmTally> = { champion: emptyTally(), challenger: emptyTally() };
  const sessionArm = new Map<string, ModelArm>();

  const seenTurns = new Set<string>();
  for (const row of rows.armRows) {
    const arm = armOf(row.detail, "arm");
    const turnId = row.detail?.["turnId"];
    const sessionId = row.detail?.["sessionId"];
    if (arm === undefined || typeof turnId !== "string") continue;
    const key = `${typeof sessionId === "string" ? sessionId : ""}:${turnId}`;
    if (seenTurns.has(key)) continue;
    seenTurns.add(key);
    tallies[arm].turns++;
    if (typeof sessionId === "string" && sessionId.length > 0 && !sessionArm.has(sessionId)) sessionArm.set(sessionId, arm);
  }

  const seenMarks = new Set<string>();
  for (const row of rows.ratingRows) {
    const arm = armOf(row.detail, "arm");
    const score = row.detail?.["score"];
    const turnId = row.detail?.["turnId"];
    if (arm === undefined || typeof score !== "number" || !Number.isFinite(score) || typeof turnId !== "string") continue;
    const mark = `${turnId}:${row.principalId ?? ""}`;
    if (seenMarks.has(mark)) continue;
    seenMarks.add(mark);
    tallies[arm].ratings++;
    tallies[arm].ratingSum += score;
  }

  for (const calls of rows.usageBySession.values()) {
    for (const call of calls) {
      const arm = armOf(call.detail, MODEL_ARM_DETAIL_KEY);
      if (arm === undefined) continue;
      const t = tallies[arm];
      t.calls++;
      t.inputTokens += call.inputTokens;
      t.outputTokens += call.outputTokens;
      const usd = rowCostUsd(call, assumed);
      if (usd === undefined) t.unpricedCalls++;
      else t.usd += usd;
    }
  }

  return { tallies, sessionArm };
}
