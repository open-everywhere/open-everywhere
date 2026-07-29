import { callLinearGraphQL, type LinearApiOptions, type LinearChannelCredentials } from "eve/channels/linear";
import { linearAppActorCredentials } from "./linear-credentials.js";
import { assertLinearIssueWriteAllowed } from "./linear-scope.js";
import { enrichIssueTeam } from "./linear.js";
import type { BindableContext, Domain, EntityActionAdapter } from "@open-everywhere/core/agent/adapter-api.js";

export interface LinearActionOpts {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkflowStateNode {
  id?: string;
  name?: string;
}

async function fetchIssueTeamStates(issueRef: string, opts: LinearActionOpts): Promise<WorkflowStateNode[]> {
  const data = await callLinearGraphQL<{ issue?: { team?: { states?: { nodes?: WorkflowStateNode[] } } } | null }>({
    api: opts.api,
    credentials: opts.credentials ?? linearAppActorCredentials,
    query: "query OeIssueTeamStates($id: String!) { issue(id: $id) { team { states(first: 100) { nodes { id name } } } } }",
    queryName: "OeIssueTeamStates",
    variables: { id: issueRef },
  });
  if (!data.issue) throw new Error(`Linear issue ${issueRef} not found or not visible to the workspace token.`);
  return data.issue.team?.states?.nodes ?? [];
}

interface LabelNode {
  id?: string;
  name?: string;
}

async function fetchIssueTeamLabels(issueRef: string, opts: LinearActionOpts): Promise<LabelNode[]> {
  const data = await callLinearGraphQL<{ issue?: { team?: { labels?: { nodes?: LabelNode[] } } } | null }>({
    api: opts.api,
    credentials: opts.credentials ?? linearAppActorCredentials,
    query: "query OeIssueTeamLabels($id: String!) { issue(id: $id) { team { labels(first: 250) { nodes { id name } } } } }",
    queryName: "OeIssueTeamLabels",
    variables: { id: issueRef },
  });
  if (!data.issue) throw new Error(`Linear issue ${issueRef} not found or not visible to the workspace token.`);
  return data.issue.team?.labels?.nodes ?? [];
}

interface UserNode {
  id?: string;
  email?: string;
  name?: string;
  displayName?: string;
}

async function resolveLinearUserId(assignee: string, opts: LinearActionOpts): Promise<string> {
  if (UUID_RE.test(assignee)) return assignee;
  const data = await callLinearGraphQL<{ users?: { nodes?: UserNode[] } }>({
    api: opts.api,
    credentials: opts.credentials ?? linearAppActorCredentials,
    query: "query OeFindUser { users(first: 250) { nodes { id email name displayName } } }",
    queryName: "OeFindUser",
  });
  const needle = assignee.trim().toLowerCase();
  const matches = (data.users?.nodes ?? []).filter(
    (u) => str(u.email)?.toLowerCase() === needle || str(u.name)?.toLowerCase() === needle || str(u.displayName)?.toLowerCase() === needle,
  );
  if (matches.length === 0) {
    throw new Error(`Linear: no workspace user matches "${assignee}" (checked email/name/displayName) — pass a Linear user id instead.`);
  }
  if (matches.length > 1) {
    throw new Error(`Linear: "${assignee}" matches ${matches.length} workspace users — ambiguous. Pass a Linear user id instead.`);
  }
  const id = str(matches[0].id);
  if (!id) throw new Error(`Linear: matched user for "${assignee}" but its id is missing — unexpected API response.`);
  return id;
}

function findByName<T extends { name?: string }>(nodes: readonly T[], name: string): T | undefined {
  const needle = name.trim().toLowerCase();
  return nodes.find((n) => str(n.name)?.toLowerCase() === needle);
}

export async function setLinearIssueState(issueRef: string, stateName: string, opts: LinearActionOpts = {}): Promise<string> {
  const states = await fetchIssueTeamStates(issueRef, opts);
  const match = findByName(states, stateName);
  if (!match?.id) {
    const names = states.map((s) => str(s.name)).filter((n): n is string => Boolean(n));
    throw new Error(`Linear: no state named "${stateName}" on this issue's team — available: ${names.length ? names.join(", ") : "(none found)"}.`);
  }
  await callLinearGraphQL<{ issueUpdate?: { success?: boolean } }>({
    api: opts.api,
    credentials: opts.credentials ?? linearAppActorCredentials,
    query: "mutation OeSetIssueState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
    queryName: "OeSetIssueState",
    variables: { id: issueRef, stateId: match.id },
  });
  return `Linear issue ${issueRef} state set to "${match.name}".`;
}

export async function assignLinearIssue(issueRef: string, assignee: string, opts: LinearActionOpts = {}): Promise<string> {
  const assigneeId = await resolveLinearUserId(assignee, opts);
  await callLinearGraphQL<{ issueUpdate?: { success?: boolean } }>({
    api: opts.api,
    credentials: opts.credentials ?? linearAppActorCredentials,
    query: "mutation OeAssignIssue($id: String!, $assigneeId: String!) { issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success } }",
    queryName: "OeAssignIssue",
    variables: { id: issueRef, assigneeId },
  });
  return `Linear issue ${issueRef} assigned to ${assignee}.`;
}

export async function addLinearIssueLabel(issueRef: string, label: string, opts: LinearActionOpts = {}): Promise<string> {
  const labels = await fetchIssueTeamLabels(issueRef, opts);
  const match = findByName(labels, label);
  if (!match?.id) {
    const names = labels.map((l) => str(l.name)).filter((n): n is string => Boolean(n));
    throw new Error(`Linear: no label named "${label}" on this issue's team — available: ${names.length ? names.join(", ") : "(none found)"}.`);
  }
  await callLinearGraphQL<{ issueAddLabel?: { success?: boolean } }>({
    api: opts.api,
    credentials: opts.credentials ?? linearAppActorCredentials,
    query: "mutation OeAddIssueLabel($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }",
    queryName: "OeAddIssueLabel",
    variables: { id: issueRef, labelId: match.id },
  });
  return `Label "${match.name}" added to Linear issue ${issueRef}.`;
}

export const linearEntityAdapter: EntityActionAdapter = {
  platform: "linear",
  checkAccess: (ctx: BindableContext, entityId: string, domains: readonly Domain[]) =>
    assertLinearIssueWriteAllowed(ctx, entityId, domains, async (ref) => (await enrichIssueTeam(ref))?.teamId),
  setState: (id, value) => setLinearIssueState(id, value),
  assign: (id, value) => assignLinearIssue(id, value),
  addLabel: (id, value) => addLinearIssueLabel(id, value),
};
