import { callLinear } from "./linear-graphql.js";
import {
  registerWorkSearchAdapter,
  domainRoster,
  type WorkSearchAdapter,
  type WorkSearchHit,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { linearCredentialsForOrg } from "./linear-credentials.js";
import { describeLinearError } from "./linear-errors.js";
import { linearWorkOrg } from "./linear-work.js";

interface IssueSearchNode {
  readonly id?: string;
  readonly identifier?: string;
  readonly title?: string;
  readonly url?: string;
  readonly team?: { readonly id?: string } | null;
}

export function domainOwnTeamIds(domain: Domain, org: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const key of domainRoster(domain)) {
    const parts = key.split("/");
    if (parts.length === 3 && parts[0] === "linear" && parts[1] === org && parts[2].length > 0) ids.add(parts[2]);
  }
  return ids;
}

export const linearWorkSearchAdapter: WorkSearchAdapter = {
  connector: "linear",
  async search(ctx: BindableContext, domain: Domain | undefined, query: string, opts: { limit: number; insideDomain: boolean }): Promise<readonly WorkSearchHit[]> {
    if (!domain) throw new Error("this domain holds no Linear work grant.");
    const org = linearWorkOrg(ctx, [domain]);
    if (!org) throw new Error("this domain holds no Linear work grant.");
    const first = Math.min(Math.max(opts.limit, 1), 50);
    let data: { issueSearch?: { nodes?: IssueSearchNode[] } };
    try {
      data = await callLinear<{ issueSearch?: { nodes?: IssueSearchNode[] } }>({
        credentials: linearCredentialsForOrg(org),
        query:
          "query OeIssueSearch($term: String!, $first: Int!) { issueSearch(query: $term, first: $first) " +
          "{ nodes { id identifier title url team { id } } } }",
        queryName: "OeIssueSearch",
        variables: { term: query, first },
      });
    } catch (err) {
      throw new Error(`Linear search failed (${describeLinearError(err)}).`);
    }
    const nodes = data.issueSearch?.nodes ?? [];
    const scope = opts.insideDomain ? domainOwnTeamIds(domain, org) : undefined;
    const hits: WorkSearchHit[] = [];
    for (const n of nodes) {
      if (typeof n.identifier !== "string" || n.identifier.length === 0) continue;
      if (scope && !(n.team?.id && scope.has(n.team.id))) continue;
      hits.push({
        connector: "linear",
        id: n.identifier,
        title: n.title && n.title.length > 0 ? n.title : "(untitled)",
        ...(n.url ? { url: n.url } : {}),
        readWith: { tool: "read_linear_issue", args: { issue: n.identifier } },
      });
    }
    return hits.slice(0, opts.limit);
  },
};

export function registerLinearWorkSearch(): void {
  registerWorkSearchAdapter(linearWorkSearchAdapter);
}
