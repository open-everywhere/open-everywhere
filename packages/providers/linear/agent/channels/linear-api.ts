import { callLinearGraphQL, type LinearApiOptions, type LinearChannelCredentials } from "eve/channels/linear";
import { linearCredentialsForOrg } from "./linear-credentials.js";

export interface LinearReadOpts {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly organizationId?: string;
  readonly maxComments?: number;
}

export interface LinearCommentSummary {
  readonly id?: string;
  readonly parentId?: string;
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
  readonly createdAt?: string;
  readonly creatorId?: string;
  readonly creatorName?: string;
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
  createdAt?: string;
  creator?: { id?: string; name?: string; displayName?: string };
  state?: { name?: string; type?: string };
  comments?: {
    nodes?: Array<{
      id?: string;
      body?: string;
      createdAt?: string;
      parent?: { id?: string } | null;
      user?: { id?: string; name?: string; displayName?: string };
    }>;
    pageInfo?: { hasNextPage?: boolean };
  };
}

export async function readLinearIssue(issueRef: string, opts: LinearReadOpts = {}): Promise<LinearIssueRead> {
  const maxComments = opts.maxComments ?? DEFAULT_MAX_COMMENTS;
  const data = await callLinearGraphQL<{ issue?: RawIssue | null }>({
    api: opts.api,
    credentials: opts.credentials ?? linearCredentialsForOrg(opts.organizationId),
    query:
      "query OeReadIssue($id: String!, $first: Int!) { issue(id: $id) { id identifier title description createdAt " +
      "creator { id name displayName } state { name type } comments(first: $first) " +
      "{ nodes { id body createdAt parent { id } user { id name displayName } } pageInfo { hasNextPage } } } }",
    queryName: "OeReadIssue",
    variables: { id: issueRef, first: maxComments },
  });
  const issue = data.issue;
  if (!issue || typeof issue !== "object") {
    throw new Error(`Linear issue ${issueRef} not found or not visible to the workspace token.`);
  }
  const nodes = Array.isArray(issue.comments?.nodes) ? issue.comments!.nodes! : [];
  const comments: LinearCommentSummary[] = nodes.map((c) => ({
    id: str(c.id),
    parentId: str(c.parent?.id),
    authorId: str(c.user?.id),
    authorName: str(c.user?.displayName) ?? str(c.user?.name),
    createdAt: str(c.createdAt),
    text: str(c.body) ?? "",
  }));
  comments.reverse();
  return {
    id: str(issue.id),
    identifier: str(issue.identifier),
    title: str(issue.title),
    stateName: str(issue.state?.name),
    stateType: str(issue.state?.type),
    description: str(issue.description) ?? "",
    createdAt: str(issue.createdAt),
    creatorId: str(issue.creator?.id),
    creatorName: str(issue.creator?.displayName) ?? str(issue.creator?.name),
    comments,
    truncated: issue.comments?.pageInfo?.hasNextPage === true,
  };
}
