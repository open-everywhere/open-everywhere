import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import { getSettings } from "../settings/settings.js";
import type { ActionKind } from "./types.js";

export const CHECKPOINT_KIND = "session.checkpoint";
export const CHECKPOINT_GRANT_MEMO = "session.checkpoint.grant";
export const CHECKPOINT_ASK_MEMO = "session.checkpoint.asked";

export function checkpointTtlHours(): number {
  return getSettings().approvals.checkpointTtlHours;
}

export interface SessionCheckpointArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly sessionId: string;
}

const sessionCheckpoint: ActionKind<SessionCheckpointArgs> = {
  kind: CHECKPOINT_KIND,
  policy: "member",
  summarize(args) {
    return [
      "Continue this session past its cost checkpoint?",
      `Scope: \`${args.scopeKey}\``,
      "Approving lets the agent resume consequential actions (PRs, memory writes, …) for the rest of this session. Declining keeps them paused; reads and replies are unaffected.",
    ];
  },
  async execute(args, decidedBy) {
    const store = getOperationalStore();
    const now = new Date();
    await store.setSessionApproval({
      org: args.org,
      sessionId: args.sessionId,
      kind: CHECKPOINT_GRANT_MEMO,
      grantedBy: decidedBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + checkpointTtlHours() * 3_600_000).toISOString(),
    });
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "checkpoint.continue",
      detail: { scopeKey: args.scopeKey },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "spend_checkpoint", "oe.outcome": "continued" });
    return "cost checkpoint cleared — the agent may resume consequential actions for the rest of this session";
  },
};

registerActionKind(sessionCheckpoint);
