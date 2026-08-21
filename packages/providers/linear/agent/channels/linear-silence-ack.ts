import { createLinearAgentActivity } from "eve/channels/linear";
import { linearCredentialsForOrg } from "./linear-credentials.js";

export const LINEAR_SILENCE_ACK_BODY = "Noted — no response needed.";

export const LINEAR_ANSWERED_ACK_BODY = "Answered in the comments.";

export async function postLinearSilenceAck(agentSessionId: string, organizationId?: string): Promise<void> {
  await postLinearHostAck(agentSessionId, LINEAR_SILENCE_ACK_BODY, organizationId);
}

export async function postLinearAnsweredAck(agentSessionId: string, organizationId?: string): Promise<void> {
  await postLinearHostAck(agentSessionId, LINEAR_ANSWERED_ACK_BODY, organizationId);
}

export async function postLinearHostAck(agentSessionId: string, body: string, organizationId?: string): Promise<void> {
  const res = await createLinearAgentActivity({
    credentials: linearCredentialsForOrg(organizationId),
    activity: { agentSessionId, content: { type: "response", body } },
  });
  if (res.success !== true) {
    throw new Error(`linear silence ack: the response activity returned no success on session ${agentSessionId}`);
  }
}
