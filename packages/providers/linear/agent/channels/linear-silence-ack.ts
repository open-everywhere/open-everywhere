import { createLinearActivity } from "./linear-graphql.js";
import { linearCredentialsForOrg } from "./linear-credentials.js";

export const LINEAR_SILENCE_ACK_BODY = "Noted — no response needed.";

export const LINEAR_ANSWERED_ACK_BODY = "Answered in the comments.";

export const LINEAR_STOOD_DOWN_ACK_BODY = "Standing down on this issue — @mention me in a new comment to bring me back.";

export async function postLinearSilenceAck(agentSessionId: string, organizationId?: string): Promise<void> {
  await postLinearHostAck(agentSessionId, LINEAR_SILENCE_ACK_BODY, organizationId);
}

export async function postLinearAnsweredAck(agentSessionId: string, organizationId?: string): Promise<void> {
  await postLinearHostAck(agentSessionId, LINEAR_ANSWERED_ACK_BODY, organizationId);
}

export async function postLinearHostAck(agentSessionId: string, body: string, organizationId?: string): Promise<void> {
  const res = await createLinearActivity({
    credentials: linearCredentialsForOrg(organizationId),
    activity: { agentSessionId, content: { type: "response", body } },
  });
  if (res.success !== true) {
    throw new Error(`linear silence ack: the response activity returned no success on session ${agentSessionId}`);
  }
}
