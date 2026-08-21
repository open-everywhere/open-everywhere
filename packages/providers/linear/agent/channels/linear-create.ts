import { callLinearGraphQL, type LinearApiOptions, type LinearChannelCredentials } from "eve/channels/linear";
import { linearCredentialsForOrg } from "./linear-credentials.js";
import { assertLinearTeamWriteAllowed } from "./linear-scope.js";
import { linearWorkOrg } from "./linear-work.js";
import {
  currentTurnIssue,
  type BindableContext,
  type CreatedTicket,
  type Domain,
  type TicketCreateAdapter,
  type TicketDraft,
} from "@open-everywhere/core/agent/adapter-api.js";

export interface LinearCreateOpts {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly organizationId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

interface TeamNode {
  id?: string;
  key?: string;
  name?: string;
}

export async function resolveLinearTeamId(target: string, opts: LinearCreateOpts = {}): Promise<string> {
  if (UUID_RE.test(target)) return target;
  const data = await callLinearGraphQL<{ teams?: { nodes?: TeamNode[] } }>({
    api: opts.api,
    credentials: opts.credentials ?? linearCredentialsForOrg(opts.organizationId),
    query: "query OeFindTeam { teams(first: 250) { nodes { id key name } } }",
    queryName: "OeFindTeam",
  });
  const needle = target.trim().toLowerCase();
  const teams = data.teams?.nodes ?? [];
  const match = teams.find((t) => str(t.key)?.toLowerCase() === needle || str(t.name)?.toLowerCase() === needle);
  const id = str(match?.id);
  if (!id) {
    const keys = teams.map((t) => str(t.key)).filter((k): k is string => Boolean(k));
    throw new Error(`Linear: no team matching "${target}" (checked key/name) — available: ${keys.length ? keys.join(", ") : "(none visible to the workspace token)"}.`);
  }
  return id;
}

export async function createLinearIssue(target: string, draft: TicketDraft, opts: LinearCreateOpts = {}): Promise<CreatedTicket> {
  const teamId = await resolveLinearTeamId(target, opts);
  const data = await callLinearGraphQL<{ issueCreate?: { success?: boolean; issue?: { id?: string; identifier?: string; url?: string } } }>({
    api: opts.api,
    credentials: opts.credentials ?? linearCredentialsForOrg(opts.organizationId),
    query:
      "mutation OeCreateIssue($teamId: String!, $title: String!, $description: String) { issueCreate(input: { teamId: $teamId, title: $title, description: $description }) { success issue { id identifier url } } }",
    queryName: "OeCreateIssue",
    variables: { teamId, title: draft.title, description: draft.body },
  });
  const issue = data.issueCreate?.issue;
  const identifier = str(issue?.identifier) ?? str(issue?.id);
  if (!identifier) {
    throw new Error(`Linear: issue creation on team "${target}" returned no issue — unexpected API response.`);
  }
  const url = str(issue?.url);
  return {
    ref: { platform: "linear", id: identifier },
    ...(url ? { url } : {}),
    summary: `Filed Linear issue ${identifier}: "${draft.title}".`,
  };
}

function defaultLinearTeam(ctx: BindableContext): string | undefined {
  const issue = currentTurnIssue(ctx);
  const m = issue ? ISSUE_IDENTIFIER_RE.exec(issue) : null;
  return m ? m[1] : undefined;
}

export const linearTicketCreateAdapter: TicketCreateAdapter = {
  platform: "linear",
  checkAccess: (ctx: BindableContext, target: string, domains: readonly Domain[]) =>
    assertLinearTeamWriteAllowed(
      ctx,
      target,
      domains,
      async (t, organizationId) => {
        try {
          return await resolveLinearTeamId(t, { organizationId });
        } catch {
          return undefined;
        }
      },
      { workOrg: linearWorkOrg(ctx, domains) },
    ),
  defaultTarget: defaultLinearTeam,
  workspaceFor: linearWorkOrg,
  create: (target, draft, organizationId) => createLinearIssue(target, draft, { organizationId }),
};
