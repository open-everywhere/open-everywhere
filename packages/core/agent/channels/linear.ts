import { linearChannel } from "eve/channels/linear";
import { buildLinearAuth } from "./linear-identity.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function pick(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}
function teamIdFromRaw(raw: unknown): string | undefined {
  for (const base of [pick(raw, "agentSession"), pick(raw, "data"), raw]) {
    const id = str(pick(pick(pick(base, "issue"), "team"), "id"));
    if (id) return id;
  }
  return undefined;
}

export default linearChannel({
  onAgentSession: (_ctx, event) => {
    const s = event.agentSession;
    const agentSessionId = s.id;
    if (!agentSessionId) return null;

    const auth = buildLinearAuth({
      agentSessionId,
      organizationId: event.organizationId ?? s.organizationId ?? undefined,
      teamId: teamIdFromRaw(event.raw),
      issueId: s.issueId ?? s.issue?.id ?? undefined,
      issueIdentifier: s.issue?.identifier ?? undefined,
      principalId: s.creator?.id ?? s.creatorId ?? event.appUserId ?? undefined,
    });
    return { auth };
  },
});
