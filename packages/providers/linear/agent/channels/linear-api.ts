import { callLinearGraphQL, type LinearApiOptions, type LinearChannelCredentials } from "eve/channels/linear";
import { linearCredentialsForOrg } from "./linear-credentials.js";

export interface LinearReadOpts {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly organizationId?: string;
  readonly maxComments?: number;
}

export interface LinearCommentSummary {
  readonly authorId?: string;
  readonly authorName?: string;
  readonly createdAt?: string;
  readonly text: string;
}

export interface LinearIssueRead {
  readonly id?: string;
  readonly identifier?: string;
  readonly title?: string;
  readonly stateName?: string;
  readonly stateType?: string;
  readonly description: string;
  readonly comments: LinearCommentSummary[];
  readonly truncated: boolean;
}

const DEFAULT_MAX_COMMENTS = 50;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

interface RawIssue {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  state?: { name?: string; type?: string };
  comments?: {
    nodes?: Array<{ id?: string; body?: string; createdAt?: string; user?: { id?: string; name?: string; displayName?: string } }>;
    pageInfo?: { hasNextPage?: boolean };
  };
}

export async function readLinearIssue(issueRef: string, opts: LinearReadOpts = {}): Promise<LinearIssueRead> {
  const maxComments = opts.maxComments ?? DEFAULT_MAX_COMMENTS;
  const data = await callLinearGraphQL<{ issue?: RawIssue | null }>({
    api: opts.api,
    credentials: opts.credentials ?? linearCredentialsForOrg(opts.organizationId),
    query:
      "query OeReadIssue($id: String!, $first: Int!) { issue(id: $id) { id identifier title description " +
      "state { name type } comments(first: $first) { nodes { id body createdAt user { id name displayName } } pageInfo { hasNextPage } } } }",
    queryName: "OeReadIssue",
    variables: { id: issueRef, first: maxComments },
  });
  const issue = data.issue;
  if (!issue || typeof issue !== "object") {
    throw new Error(`Linear issue ${issueRef} not found or not visible to the workspace token.`);
  }
  const nodes = Array.isArray(issue.comments?.nodes) ? issue.comments!.nodes! : [];
  const comments: LinearCommentSummary[] = nodes.map((c) => ({
    authorId: str(c.user?.id),
    authorName: str(c.user?.displayName) ?? str(c.user?.name),
    createdAt: str(c.createdAt),
    text: str(c.body) ?? "",
  }));
  return {
    id: str(issue.id),
    identifier: str(issue.identifier),
    title: str(issue.title),
    stateName: str(issue.state?.name),
    stateType: str(issue.state?.type),
    description: str(issue.description) ?? "",
    comments,
    truncated: issue.comments?.pageInfo?.hasNextPage === true,
  };
}
