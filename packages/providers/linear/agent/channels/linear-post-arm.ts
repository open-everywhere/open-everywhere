import { createLinearAgentActivity, callLinearGraphQL, LinearApiError } from "eve/channels/linear";
import { linearAppActorCredentials } from "./linear-credentials.js";
import type { PostArm, TargetResolveBag, ReplyTarget, UnifiedWakeOrigin, UnifiedReplyDeps } from "@open-everywhere/core/agent/adapter-api.js";

type LinearTarget = Extract<ReplyTarget, { platform: "linear" }>;
type LinearOrigin = Extract<UnifiedWakeOrigin, { platform: "linear" }>;

async function dispatchLinearReply(target: LinearTarget, text: string): Promise<string> {
  const res = await createLinearAgentActivity({
    credentials: linearAppActorCredentials,
    activity: { agentSessionId: target.agentSessionId, content: { body: text, type: "response" } },
  });
  return res.id;
}

function describeLinearError(err: unknown): string {
  if (err instanceof LinearApiError) {
    const body = err.body as { errors?: Array<{ message?: unknown }> } | undefined;
    const msgs = Array.isArray(body?.errors)
      ? body.errors.map((e) => (typeof e?.message === "string" ? e.message : "")).filter(Boolean).join("; ")
      : "";
    return `HTTP ${err.status}${msgs ? `: ${msgs}` : ""}`.slice(0, 240);
  }
  return "network/transport error";
}

async function liveLinearPost(origin: LinearOrigin, text: string): Promise<string> {
  if (origin.ambient) {
    let data: { commentCreate?: { success?: boolean } };
    try {
      data = await callLinearGraphQL<{ commentCreate?: { success?: boolean } }>({
        credentials: linearAppActorCredentials,
        query: "mutation OeUnifiedAmbientReply($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
        queryName: "OeUnifiedAmbientReply",
        variables: { input: { issueId: origin.issueId, ...(origin.parentId ? { parentId: origin.parentId } : {}), body: text } },
      });
    } catch (err) {
      throw new Error(`unified reply couldn't post to Linear — ambient commentCreate failed on issue ${origin.issueId} (${describeLinearError(err)})`);
    }
    if (data.commentCreate?.success !== true) {
      throw new Error(`unified reply couldn't post to Linear — ambient commentCreate returned no success on issue ${origin.issueId}`);
    }
    return "comment";
  }
  if (!origin.agentSessionId) throw new Error(`unified reply: linear origin for issue ${origin.issueId} has neither an agent session nor the ambient flag (invariant broken)`);
  let res: { id: string; success: boolean };
  try {
    res = await createLinearAgentActivity({
      credentials: linearAppActorCredentials,
      activity: { agentSessionId: origin.agentSessionId, content: { type: "response", body: text } },
    });
  } catch (err) {
    throw new Error(
      `unified reply couldn't post to Linear — createLinearAgentActivity(response) failed on issue ${origin.issueId} (session ${origin.agentSessionId}) (${describeLinearError(err)})`,
    );
  }
  if (res.success !== true) {
    throw new Error(`unified reply couldn't post to Linear — the response activity returned no success on issue ${origin.issueId} (session ${origin.agentSessionId})`);
  }
  return res.id || "unknown";
}

const LINEAR_SILENT_CLOSE_STATUS = "(no reply — nothing to add here)";

async function liveLinearSilentClose(origin: LinearOrigin): Promise<void> {
  if (!origin.agentSessionId) return;
  try {
    await createLinearAgentActivity({
      credentials: linearAppActorCredentials,
      activity: {
        agentSessionId: origin.agentSessionId,
        content: { type: "thought", body: LINEAR_SILENT_CLOSE_STATUS },
        ephemeral: true,
        signal: "stop",
      },
    });
  } catch (err) {
    throw new Error(`unified silent-close couldn't stop the Linear session ${origin.agentSessionId} (${describeLinearError(err)})`);
  }
}

export const linearPostArm: PostArm = {
  platform: "linear",
  resolveTarget: (bag: TargetResolveBag): ReplyTarget | null => {
    const agentSessionId = bag.str("agentSessionId");
    return agentSessionId ? { platform: "linear", agentSessionId } : null;
  },
  dispatchReply: (target, text) => dispatchLinearReply(target as LinearTarget, text),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps) => (deps.postLinear ?? liveLinearPost)(origin as LinearOrigin, text),
  closeUnifiedSilently: (origin, deps: UnifiedReplyDeps) => (deps.closeLinear ?? liveLinearSilentClose)(origin as LinearOrigin),
  describeRedriveTarget: (origin) => {
    const o = origin as LinearOrigin;
    return o.ambient ? `linear issue ${o.issueId}` : `linear session on issue ${o.issueId}`;
  },
  redriveContainerId: (origin) => (origin as LinearOrigin).issueId,
};
