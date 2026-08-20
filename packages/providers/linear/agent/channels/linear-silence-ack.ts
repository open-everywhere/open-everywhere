import { createLinearAgentActivity } from "eve/channels/linear";
import { linearCredentialsForOrg } from "./linear-credentials.js";

export const LINEAR_SILENCE_ACK_BODY = "Noted — no response needed.";

export async function postLinearSilenceAck(agentSessionId: string, organizationId?: string): Promise<void> {
  const res = await createLinearAgentActivity({
    credentials: linearCredentialsForOrg(organizationId),
    activity: { agentSessionId, content: { type: "response", body: LINEAR_SILENCE_ACK_BODY } },
  });
  if (res.success !== true) {
    throw new Error(`linear silence ack: the response activity returned no success on session ${agentSessionId}`);
  }
}
