import { appendAudit, readAudit } from "../audit/audit.js";
import { defaultScopeKey } from "../tools/set_spend_limit.js";
import type { SurfaceBinding } from "../identity/binding.js";
import { MODEL_AB_ARM_ACTION, MODEL_AB_RATING_ACTION, MODEL_AB_RATING_MAX, MODEL_AB_RATING_MIN, type ModelArm } from "../model/ab-test.js";

export interface RateCommand {
  readonly kind: "rate";
  readonly score: number;
}

export const RATE_HELP_LINE = `• \`/oe rate <${MODEL_AB_RATING_MIN}-${MODEL_AB_RATING_MAX}>\` — mark the model A/B test: rate the last answer in this channel.`;

export function parseRateTokens(rest: readonly string[]): RateCommand | { readonly kind: "error"; readonly message: string } {
  const raw = rest[0];
  const score = Number(raw);
  if (!raw || !Number.isInteger(score) || score < MODEL_AB_RATING_MIN || score > MODEL_AB_RATING_MAX) {
    return {
      kind: "error",
      message:
        `"/oe rate" needs a whole number from ${MODEL_AB_RATING_MIN} to ${MODEL_AB_RATING_MAX}, ` +
        `e.g. "/oe rate 4" (got ${JSON.stringify(raw ?? "")}).`,
    };
  }
  return { kind: "rate", score };
}

export interface RatedTurn {
  readonly arm: ModelArm;
  readonly bucketKey: string;
  readonly modelId: string;
  readonly turnId: string;
  readonly sessionId?: string;
  readonly ts: string;
}

export interface RateDeps {
  readonly readAudit?: typeof readAudit;
  readonly appendAudit?: typeof appendAudit;
}

export async function lastArmedTurn(org: string, surfaceKey: string, deps: RateDeps = {}): Promise<RatedTurn | undefined> {
  const read = deps.readAudit ?? readAudit;
  let rows: Awaited<ReturnType<typeof readAudit>>;
  try {
    rows = await read({ org, surface: surfaceKey, action: MODEL_AB_ARM_ACTION, limit: 1 });
  } catch {
    return undefined;
  }
  const row = rows[0];
  const d = row?.detail;
  if (!row || !d) return undefined;
  const arm = d["arm"];
  const bucketKey = d["bucketKey"];
  const modelId = d["modelId"];
  const turnId = d["turnId"];
  const sessionId = d["sessionId"];
  if ((arm !== "champion" && arm !== "challenger") || typeof bucketKey !== "string" || typeof modelId !== "string" || typeof turnId !== "string") {
    return undefined;
  }
  return {
    arm,
    bucketKey,
    modelId,
    turnId,
    ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}),
    ts: row.ts,
  };
}

export async function runRate(binding: SurfaceBinding, score: number, deps: RateDeps = {}): Promise<string> {
  const surfaceKey = defaultScopeKey(binding, "surface");
  const turn = await lastArmedTurn(binding.org, surfaceKey, deps);
  if (!turn) {
    return (
      "Nothing to rate here yet — `/oe rate` marks a model A/B test, and this channel has no recorded " +
      "A/B turn. That is the normal answer when the test is off, when this room's model is pinned, or " +
      "when the room's last turn ran on a worker or supervisor seat."
    );
  }
  try {
    await (deps.appendAudit ?? appendAudit)({
      org: binding.org,
      platform: binding.platform,
      workspace: binding.workspace,
      surface: surfaceKey,
      ...(binding.principalId ? { principalId: binding.principalId } : {}),
      action: MODEL_AB_RATING_ACTION,
      detail: {
        score,
        arm: turn.arm,
        bucketKey: turn.bucketKey,
        modelId: turn.modelId,
        turnId: turn.turnId,
        ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
        ratedAt: turn.ts,
      },
    });
  } catch (err) {
    return `Couldn't record that rating: ${String(err)}`;
  }
  return `Thanks — recorded ${score}/${MODEL_AB_RATING_MAX} for this channel's last answer.`;
}
