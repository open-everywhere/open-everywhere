import { placeWords } from "../channels/friendly-ids.js";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import { getSettings } from "../settings/settings.js";
import { ROUTINE_PERMISSION_NO_EXPIRY } from "../routines/declared-permissions.js";
import type { ActionKind } from "./types.js";
import { plainValue } from "./plain-text.js";

export const CHECKPOINT_KIND = "session.checkpoint";
export const CHECKPOINT_GRANT_MEMO = "session.checkpoint.grant";
export const CHECKPOINT_ASK_MEMO = "session.checkpoint.asked";

export const DURABLE_GRANT_DISCLOSURE =
  "This job keeps one running total, so approving sets a mark rather than a timer: it asks again once it has spent that much again, and the approval does not lapse on its own.";

export function liveGrantDisclosure(): string {
  return `Approving lets it continue in this session for up to ${checkpointTtlHours()} h.`;
}

export function checkpointTtlHours(): number {
  return getSettings().approvals.checkpointTtlHours;
}

interface SessionCheckpointArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly durableSession?: true;
  readonly scopeLabel?: string;
}

const sessionCheckpoint: ActionKind<SessionCheckpointArgs> = {
  kind: CHECKPOINT_KIND,
  policy: "member",
  plainSummary(args) {
    return `Let the agent carry on in ${args.scopeLabel !== undefined ? plainValue(args.scopeLabel) : placeWords({ key: args.scopeKey })} past its cost checkpoint`;
  },
  consequence: (args) => (args.durableSession ? "It asks again once it has spent as much again; the approval has no timer." : `It lasts up to ${checkpointTtlHours()} h in this session.`),
  summarize(args) {
    return [
      "Keep this session going past its cost checkpoint?",
      `In ${args.scopeLabel ?? placeWords({ key: args.scopeKey })}.`,
      "Approve to let the agent do consequential work again — pull requests, memory writes and the like. Decline to keep that paused. Reading and replying carry on either way.",
      ...(args.durableSession ? [DURABLE_GRANT_DISCLOSURE] : [liveGrantDisclosure()]),
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
      expiresAt: args.durableSession ? ROUTINE_PERMISSION_NO_EXPIRY : new Date(now.getTime() + checkpointTtlHours() * 3_600_000).toISOString(),
    });
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "checkpoint.continue",
      detail: { scopeKey: args.scopeKey },
    });
    emitTelemetry("oe.feature.used", { "oe.feature": "spend_checkpoint", "oe.outcome": "continued" });
    return args.durableSession
      ? "the agent carries on, and asks again once it has spent as much a second time"
      : `the agent carries on in this session for up to ${checkpointTtlHours()} h`;
  },
};

registerActionKind(sessionCheckpoint);
