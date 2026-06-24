import { linearChannel } from "eve/channels/linear";
import { buildLinearAuth } from "./linear-identity.js";

export default linearChannel({
  onAgentSession: (_ctx, event) => {
    const s = event.agentSession;
    const agentSessionId = s.id;
    if (!agentSessionId) return null;

    const auth = buildLinearAuth({
      agentSessionId,
      organizationId: event.organizationId ?? s.organizationId ?? undefined,
      issueId: s.issueId ?? s.issue?.id ?? undefined,
      issueIdentifier: s.issue?.identifier ?? undefined,
      principalId: s.creator?.id ?? s.creatorId ?? event.appUserId ?? undefined,
    });
    return { auth };
  },
});
