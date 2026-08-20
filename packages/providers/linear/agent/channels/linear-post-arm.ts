import { createLinearAgentActivity, callLinearGraphQL, LinearApiError } from "eve/channels/linear";
import { linearAppActorCredentials } from "./linear-credentials.js";
import { markNotApplied, carryFailureSignals } from "@open-everywhere/core/agent/adapter-api.js";
import type { PostArm, TargetResolveBag, ReplyTarget, ReactTarget, UnifiedWakeOrigin, UnifiedReplyDeps } from "@open-everywhere/core/agent/adapter-api.js";

type LinearTarget = Extract<ReplyTarget, { platform: "linear"; agentSessionId: string }>;
type LinearAmbientTarget = Extract<ReplyTarget, { platform: "linear"; issueId: string }>;
type LinearOrigin = Extract<UnifiedWakeOrigin, { platform: "linear" }>;
type LinearReactTarget = Extract<ReactTarget, { platform: "linear" }>;

async function dispatchLinearReply(target: LinearTarget, text: string): Promise<string> {
  const res = await createLinearAgentActivity({
    credentials: linearAppActorCredentials,
    activity: { agentSessionId: target.agentSessionId, content: { body: text, type: "response" } },
  });
  if (res.success !== true) {
    throw markNotApplied(new Error(`reply couldn't post to Linear — the response activity returned no success on session ${target.agentSessionId}`));
  }
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
      throw carryFailureSignals(err, new Error(`unified reply couldn't post to Linear — ambient commentCreate failed on issue ${origin.issueId} (${describeLinearError(err)})`));
    }
    if (data.commentCreate?.success !== true) {
      throw markNotApplied(new Error(`unified reply couldn't post to Linear — ambient commentCreate returned no success on issue ${origin.issueId}`));
    }
    return LINEAR_AMBIENT_COMMENT_ID;
  }
  if (!origin.agentSessionId) throw new Error(`unified reply: linear origin for issue ${origin.issueId} has neither an agent session nor the ambient flag (invariant broken)`);
  let res: { id: string; success: boolean };
  try {
    res = await createLinearAgentActivity({
      credentials: linearAppActorCredentials,
      activity: { agentSessionId: origin.agentSessionId, content: { type: "response", body: text } },
    });
  } catch (err) {
    throw carryFailureSignals(
      err,
      new Error(
        `unified reply couldn't post to Linear — createLinearAgentActivity(response) failed on issue ${origin.issueId} (session ${origin.agentSessionId}) (${describeLinearError(err)})`,
      ),
    );
  }
  if (res.success !== true) {
    throw markNotApplied(new Error(`unified reply couldn't post to Linear — the response activity returned no success on issue ${origin.issueId} (session ${origin.agentSessionId})`));
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

async function dispatchLinearAmbientReply(target: LinearAmbientTarget, text: string): Promise<string> {
  let data: { commentCreate?: { success?: boolean } };
  try {
    data = await callLinearGraphQL<{ commentCreate?: { success?: boolean } }>({
      credentials: linearAppActorCredentials,
      query: "mutation OeAmbientReply($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
      queryName: "OeAmbientReply",
      variables: { input: { issueId: target.issueId, ...(target.parentId ? { parentId: target.parentId } : {}), body: text } },
    });
  } catch (err) {
    throw carryFailureSignals(err, new Error(`reply couldn't post to Linear — commentCreate failed on issue ${target.issueId} (${describeLinearError(err)})`));
  }
  if (data.commentCreate?.success !== true) {
    throw markNotApplied(new Error(`reply couldn't post to Linear — commentCreate returned no success on issue ${target.issueId}`));
  }
  return LINEAR_AMBIENT_COMMENT_ID;
}

const LINEAR_AMBIENT_COMMENT_ID = "comment";

async function liveLinearReact(issueId: string, emoji: string): Promise<void> {
  let data: { reactionCreate?: { success?: boolean } };
  try {
    data = await callLinearGraphQL<{ reactionCreate?: { success?: boolean } }>({
      credentials: linearAppActorCredentials,
      query: "mutation OeReact($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }",
      queryName: "OeReact",
      variables: { input: { issueId, emoji } },
    });
  } catch (err) {
    throw carryFailureSignals(err, new Error(`react couldn't post to Linear — reactionCreate failed on issue ${issueId} (${describeLinearError(err)})`));
  }
  if (data.reactionCreate?.success !== true) {
    throw markNotApplied(new Error(`react couldn't post to Linear — reactionCreate returned no success on issue ${issueId}`));
  }
}

export const linearPostArm: PostArm = {
  platform: "linear",
  resolveTarget: (bag: TargetResolveBag): ReplyTarget | null => {
    const agentSessionId = bag.str("agentSessionId");
    if (agentSessionId) return { platform: "linear", agentSessionId };
    const issueId = bag.str("issueId");
    if (!issueId) return null;
    const parentId = bag.str("parentId");
    return { platform: "linear", issueId, ...(parentId ? { parentId } : {}) };
  },
  dispatchReply: (target, text) =>
    "agentSessionId" in target
      ? dispatchLinearReply(target as LinearTarget, text)
      : dispatchLinearAmbientReply(target as LinearAmbientTarget, text),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps) => (deps.postLinear ?? liveLinearPost)(origin as LinearOrigin, text),
  closeUnifiedSilently: (origin, deps: UnifiedReplyDeps) => (deps.closeLinear ?? liveLinearSilentClose)(origin as LinearOrigin),
  resolveReactTarget: (bag: TargetResolveBag): ReactTarget | null => {
    const issueId = bag.str("issueId");
    if (!issueId) return null;
    return { platform: "linear", issueId };
  },
  react: (target, emoji) => liveLinearReact((target as LinearReactTarget).issueId, emoji),
  describeRedriveTarget: (origin) => {
    const o = origin as LinearOrigin;
    return o.ambient ? `linear issue ${o.issueId}` : `linear session on issue ${o.issueId}`;
  },
  redriveContainerId: (origin) => (origin as LinearOrigin).issueId,
};
