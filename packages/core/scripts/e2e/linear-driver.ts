import { createHmac } from "node:crypto";
import type { LinearDriverConfig } from "./env.js";
import { pollUntil } from "./poll.js";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

export interface LinearComment {
  readonly id: string;
  readonly body: string;
  readonly userId: string;
  readonly userDisplayName: string;
  readonly createdAt: string;
}

export interface LinearReplyWithActivity extends LinearComment {
  readonly activityId?: string;
}

export function signLinearBody(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export const FORGE_SESSION_ID = "deadbeef-e2e0-4000-8000-000000000e2e";
export const FORGE_ORGANIZATION_ID = "deadbeef-e2e0-4000-8000-0000000000a1";
export const FORGE_ISSUE_ID = "deadbeef-e2e0-4000-8000-0000000000b2";
export const FORGE_CREATOR_ID = "deadbeef-e2e0-4000-8000-0000000000c3";

export interface AgentSessionForgeInput {
  readonly action: "created" | "prompted";
  readonly organizationId: string;
  readonly sessionId: string;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly teamId: string;
  readonly creatorId: string;
  readonly nowMs?: number;
}

export function buildAgentSessionEvent(input: AgentSessionForgeInput): Record<string, unknown> {
  return {
    type: "AgentSessionEvent",
    action: input.action,
    webhookTimestamp: input.nowMs ?? Date.now(),
    organizationId: input.organizationId,
    agentSession: {
      id: input.sessionId,
      issue: { id: input.issueId, identifier: input.issueIdentifier, team: { id: input.teamId } },
      creator: { id: input.creatorId },
    },
  };
}

export class LinearDriver {
  constructor(private readonly cfg: LinearDriverConfig) {}

  get teamId(): string {
    return this.cfg.teamId;
  }
  get appUserId(): string {
    return this.cfg.appUserId;
  }

  mention(ask: string): string {
    return `@${this.cfg.agentHandle} ${ask}`;
  }

  bodyMentionsAgent(body: string): boolean {
    return body.includes(`@${this.cfg.agentHandle}`);
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(LINEAR_GRAPHQL, {
      method: "POST",
      headers: { authorization: this.cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message?: string }[] };
    if (!res.ok || json.errors) {
      const detail = json.errors?.map((e) => e.message).join("; ") ?? `http ${res.status}`;
      throw new Error(`linear graphql failed: ${detail}`);
    }
    return json.data as T;
  }

  async createIssue(title: string): Promise<{ id: string; identifier: string }> {
    const data = await this.graphql<{ issueCreate?: { issue?: { id?: string; identifier?: string } } }>(
      `mutation($teamId:String!,$title:String!){issueCreate(input:{teamId:$teamId,title:$title}){issue{id identifier}}}`,
      { teamId: this.cfg.teamId, title },
    );
    const issue = data.issueCreate?.issue;
    if (!issue?.id) throw new Error("linear issueCreate returned no issue id");
    return { id: issue.id, identifier: issue.identifier ?? "" };
  }

  async comment(issueId: string, body: string): Promise<string> {
    const data = await this.graphql<{ commentCreate?: { comment?: { id?: string } } }>(
      `mutation($issueId:String!,$body:String!){commentCreate(input:{issueId:$issueId,body:$body}){comment{id}}}`,
      { issueId, body },
    );
    const id = data.commentCreate?.comment?.id;
    if (!id) throw new Error("linear commentCreate returned no comment id");
    return id;
  }

  async assign(issueId: string, assigneeId: string): Promise<boolean> {
    const data = await this.graphql<{ issueUpdate?: { success?: boolean } }>(
      `mutation($id:String!,$assigneeId:String!){issueUpdate(id:$id,input:{assigneeId:$assigneeId}){success}}`,
      { id: issueId, assigneeId },
    );
    return data.issueUpdate?.success === true;
  }

  async archive(issueId: string): Promise<void> {
    await this.graphql(`mutation($id:String!){issueArchive(id:$id){success}}`, { id: issueId }).catch(() => undefined);
  }

  async comments(issueId: string): Promise<readonly LinearComment[]> {
    const data = await this.graphql<{ issue?: { comments?: { nodes?: { id?: string; body?: string; user?: { id?: string; displayName?: string }; createdAt?: string }[] } } }>(
      `query($issueId:String!){issue(id:$issueId){comments{nodes{id body user{id displayName} createdAt}}}}`,
      { issueId },
    );
    const nodes = data.issue?.comments?.nodes ?? [];
    return nodes.map((n) => ({ id: n.id ?? "", body: n.body ?? "", userId: n.user?.id ?? "", userDisplayName: n.user?.displayName ?? "", createdAt: n.createdAt ?? "" }));
  }

  isAppComment(c: LinearComment): boolean {
    return c.userId === this.cfg.appUserId;
  }

  async resolveActivityId(issueId: string, commentId: string): Promise<string | undefined> {
    const data = await this.graphql<{
      issue?: { agentSessions?: { nodes?: { activities?: { nodes?: { id?: string; sourceComment?: { id?: string } | null }[] } }[] } };
    }>(`query($issueId:String!){issue(id:$issueId){agentSessions{nodes{activities{nodes{id sourceComment{id}}}}}}}`, { issueId });
    const sessions = data.issue?.agentSessions?.nodes ?? [];
    for (const session of sessions) {
      for (const activity of session.activities?.nodes ?? []) {
        if (activity.sourceComment?.id === commentId && activity.id !== undefined) return activity.id;
      }
    }
    return undefined;
  }

  async awaitAppReply(
    issueId: string,
    beforeIds: ReadonlySet<string>,
    opts: { timeoutMs: number; skip?: (c: LinearComment) => boolean },
  ): Promise<LinearReplyWithActivity> {
    const c = await pollUntil(
      async () => (await this.comments(issueId)).find((comment) => this.isAppComment(comment) && !beforeIds.has(comment.id) && !(opts.skip?.(comment) ?? false)),
      { timeoutMs: opts.timeoutMs, what: `an app-authored (user.id=${this.cfg.appUserId}) reply comment on issue ${issueId}${opts.skip !== undefined ? " that is not skipped as an interim ack" : ""}` },
    );
    const activityId = await this.resolveActivityId(issueId, c.id).catch(() => undefined);
    return { ...c, ...(activityId !== undefined ? { activityId } : {}) };
  }

  async awaitAgentSession(issueId: string, opts: { timeoutMs: number }): Promise<LinearComment> {
    const handle = this.cfg.agentHandle.toLowerCase();
    return pollUntil(
      async () =>
        (await this.comments(issueId)).find((c) => {
          const b = c.body.toLowerCase();
          return this.isAppComment(c) || (b.includes("agent session") && b.includes(handle));
        }),
      { timeoutMs: opts.timeoutMs, what: `an agent-session-open signal (system marker or app reply) on issue ${issueId}` },
    );
  }

  get canForge(): boolean {
    return typeof this.cfg.webhookSecret === "string";
  }

  async forgeAgentSession(targetUrl: string, input: Omit<AgentSessionForgeInput, "teamId">, opts: { signed?: boolean } = {}): Promise<{ status: number }> {
    if (!this.cfg.webhookSecret) throw new Error("forge leg needs E2E_LINEAR_WEBHOOK_SECRET");
    const rawBody = JSON.stringify(buildAgentSessionEvent({ ...input, teamId: this.cfg.teamId }));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.signed !== false) headers["linear-signature"] = signLinearBody(this.cfg.webhookSecret, rawBody);
    const res = await fetch(`${targetUrl.replace(/\/+$/, "")}/eve/v1/linear`, { method: "POST", headers, body: rawBody });
    return { status: res.status };
  }
}
