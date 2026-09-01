import { LinearApiError } from "eve/channels/linear";
import { callLinear, createLinearActivity } from "./linear-graphql.js";
import { linearCredentialsForOrg } from "./linear-credentials.js";
import { describeLinearError } from "./linear-errors.js";
import { postLinearSilenceAck, postLinearAnsweredAck } from "./linear-silence-ack.js";
import { markNotApplied, carryFailureSignals } from "@open-everywhere/core/agent/adapter-api.js";
import type { PostArm, PostIntent, TargetResolveBag, ReplyTarget, ReactTarget, UnifiedWakeOrigin, UnifiedReplyDeps, EditLocus } from "@open-everywhere/core/agent/adapter-api.js";

function activityTypeFor(intent: PostIntent | undefined): "response" | "thought" {
  return intent?.terminal === false ? "thought" : "response";
}

function isDecidedLinearRefusal(err: unknown): boolean {
  if (!(err instanceof LinearApiError)) return false;
  const body = err.body as { errors?: Array<Record<string, unknown>> } | undefined;
  if (!Array.isArray(body?.errors)) return false;
  return body.errors.some((e) => {
    const ext = (e as { extensions?: Record<string, unknown> } | undefined)?.extensions;
    if (!ext || typeof ext !== "object") return false;
    if ((ext as { userError?: unknown }).userError === true) return true;
    const nested = (ext as { http?: { status?: unknown } }).http;
    for (const raw of [(ext as { statusCode?: unknown }).statusCode, nested?.status]) {
      if (typeof raw === "number" && raw >= 400 && raw < 500 && raw !== 408 && raw !== 429) return true;
    }
    return false;
  });
}

function carryLinearFailure<E extends Error>(from: unknown, to: E): E {
  const wrapped = carryFailureSignals(from, to);
  return isDecidedLinearRefusal(from) ? markNotApplied(wrapped) : wrapped;
}

type LinearTarget = Extract<ReplyTarget, { platform: "linear"; agentSessionId: string }>;
type LinearAmbientTarget = Extract<ReplyTarget, { platform: "linear"; issueId: string }>;
type LinearOrigin = Extract<UnifiedWakeOrigin, { platform: "linear" }>;
type LinearReactTarget = Extract<ReactTarget, { platform: "linear" }>;

async function dispatchLinearReply(target: LinearTarget, text: string): Promise<string> {
  let res: { id: string; success: boolean };
  try {
    res = await createLinearActivity({
      credentials: linearCredentialsForOrg(target.organizationId),
      activity: { agentSessionId: target.agentSessionId, content: { body: text, type: "response" } },
    });
  } catch (err) {
    if (isDecidedLinearRefusal(err) && err instanceof Error) markNotApplied(err);
    throw err;
  }
  if (res.success !== true) {
    throw markNotApplied(new Error(`reply couldn't post to Linear — the response activity returned no success on session ${target.agentSessionId}`));
  }
  return res.id;
}

async function liveLinearPost(origin: LinearOrigin, text: string, intent?: PostIntent): Promise<string> {
  if (origin.ambient) {
    let data: { commentCreate?: { success?: boolean; comment?: { id?: string } } };
    try {
      data = await callLinear<{ commentCreate?: { success?: boolean; comment?: { id?: string } } }>({
        credentials: linearCredentialsForOrg(origin.organizationId),
        query: "mutation OeUnifiedAmbientReply($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
        queryName: "OeUnifiedAmbientReply",
        variables: { input: { issueId: origin.issueId, ...(origin.parentId ? { parentId: origin.parentId } : {}), body: text } },
      });
    } catch (err) {
      throw carryLinearFailure(err, new Error(`unified reply couldn't post to Linear — ambient commentCreate failed on issue ${origin.issueId} (${describeLinearError(err)})`));
    }
    if (data.commentCreate?.success !== true) {
      throw markNotApplied(new Error(`unified reply couldn't post to Linear — ambient commentCreate returned no success on issue ${origin.issueId}`));
    }
    return data.commentCreate.comment?.id || LINEAR_AMBIENT_COMMENT_ID;
  }
  if (!origin.agentSessionId) throw new Error(`unified reply: linear origin for issue ${origin.issueId} has neither an agent session nor the ambient flag (invariant broken)`);
  const type = activityTypeFor(intent);
  let res: { id: string; success: boolean };
  try {
    res = await createLinearActivity({
      credentials: linearCredentialsForOrg(origin.organizationId),
      activity: { agentSessionId: origin.agentSessionId, content: { type, body: text } },
    });
  } catch (err) {
    throw carryLinearFailure(
      err,
      new Error(
        `unified reply couldn't post to Linear — createLinearActivity(${type}) failed on issue ${origin.issueId} (session ${origin.agentSessionId}) (${describeLinearError(err)})`,
      ),
    );
  }
  if (res.success !== true) {
    throw markNotApplied(new Error(`unified reply couldn't post to Linear — the ${type} activity returned no success on issue ${origin.issueId} (session ${origin.agentSessionId})`));
  }
  return res.id || "unknown";
}

async function liveLinearSilenceAck(origin: LinearOrigin, answered = false): Promise<void> {
  if (!origin.agentSessionId) return;
  try {
    if (answered) await postLinearAnsweredAck(origin.agentSessionId, origin.organizationId);
    else await postLinearSilenceAck(origin.agentSessionId, origin.organizationId);
  } catch (err) {
    throw new Error(`unified silence ack couldn't complete the Linear session ${origin.agentSessionId} (${describeLinearError(err)})`);
  }
}

async function dispatchLinearAmbientReply(target: LinearAmbientTarget, text: string): Promise<string> {
  let data: { commentCreate?: { success?: boolean; comment?: { id?: string } } };
  try {
    data = await callLinear<{ commentCreate?: { success?: boolean; comment?: { id?: string } } }>({
      credentials: linearCredentialsForOrg(target.organizationId),
      query: "mutation OeAmbientReply($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      queryName: "OeAmbientReply",
      variables: { input: { issueId: target.issueId, ...(target.parentId ? { parentId: target.parentId } : {}), body: text } },
    });
  } catch (err) {
    throw carryLinearFailure(err, new Error(`reply couldn't post to Linear — commentCreate failed on issue ${target.issueId} (${describeLinearError(err)})`));
  }
  if (data.commentCreate?.success !== true) {
    throw markNotApplied(new Error(`reply couldn't post to Linear — commentCreate returned no success on issue ${target.issueId}`));
  }
  return data.commentCreate.comment?.id || LINEAR_AMBIENT_COMMENT_ID;
}

const LINEAR_AMBIENT_COMMENT_ID = "comment";

async function liveLinearEditComment(locus: EditLocus, messageId: string, text: string): Promise<void> {
  let data: { commentUpdate?: { success?: boolean } };
  try {
    data = await callLinear<{ commentUpdate?: { success?: boolean } }>({
      credentials: linearCredentialsForOrg(locus.organizationId),
      query: "mutation OeEditReply($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }",
      queryName: "OeEditReply",
      variables: { id: messageId, input: { body: text } },
    });
  } catch (err) {
    throw carryLinearFailure(err, new Error(`edit_reply couldn't edit the Linear comment ${messageId} on issue ${locus.channelId} (${describeLinearError(err)})`));
  }
  if (data.commentUpdate?.success !== true) {
    throw markNotApplied(new Error(`edit_reply couldn't edit the Linear comment ${messageId} on issue ${locus.channelId} — commentUpdate returned no success`));
  }
}

async function liveLinearReact(issueId: string, emoji: string, organizationId: string | undefined): Promise<void> {
  let data: { reactionCreate?: { success?: boolean } };
  try {
    data = await callLinear<{ reactionCreate?: { success?: boolean } }>({
      credentials: linearCredentialsForOrg(organizationId),
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
    const organizationId = bag.str("organizationId");
    const agentSessionId = bag.str("agentSessionId");
    if (agentSessionId) return { platform: "linear", agentSessionId, ...(organizationId ? { organizationId } : {}) };
    const issueId = bag.str("issueId");
    if (!issueId) return null;
    const parentId = bag.str("parentId");
    return { platform: "linear", issueId, ...(parentId ? { parentId } : {}), ...(organizationId ? { organizationId } : {}) };
  },
  dispatchReply: (target, text) =>
    "agentSessionId" in target
      ? dispatchLinearReply(target as LinearTarget, text)
      : dispatchLinearAmbientReply(target as LinearAmbientTarget, text),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps, _replier, intent) =>
    (deps.postLinear ?? liveLinearPost)(origin as LinearOrigin, text, intent),
  closeUnifiedSilently: (origin, deps: UnifiedReplyDeps, answered) => (deps.closeLinear ?? liveLinearSilenceAck)(origin as LinearOrigin, answered),
  editMessage: (locus, messageId, text) => liveLinearEditComment(locus, messageId, text),
  resolveReactTarget: (bag: TargetResolveBag): ReactTarget | null => {
    const issueId = bag.str("issueId");
    if (!issueId) return null;
    const organizationId = bag.str("organizationId");
    return { platform: "linear", issueId, ...(organizationId ? { organizationId } : {}) };
  },
  react: (target, emoji) => liveLinearReact((target as LinearReactTarget).issueId, emoji, (target as LinearReactTarget).organizationId),
  describeRedriveTarget: (origin) => {
    const o = origin as LinearOrigin;
    return o.ambient ? `linear issue ${o.issueId}` : `linear session on issue ${o.issueId}`;
  },
  redriveContainerId: (origin) => (origin as LinearOrigin).issueId,
};
