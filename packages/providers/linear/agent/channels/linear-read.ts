import {
  bindFrom,
  getConfig,
  currentTurnOrganization,
  type AdapterReadFetch,
  type BindableContext,
  type Domain,
  type RenderedLine,
  type WakeReadAddress,
} from "@open-everywhere/core/agent/adapter-api.js";
import { readLinearIssue, type LinearCommentSummary, type LinearIssueRead, type LinearReadOpts } from "./linear-api.js";
import { enrichIssueTeam } from "./linear.js";
import { assertLinearIssueAllowed } from "./linear-scope.js";
import { linearWorkOrg } from "./linear-work.js";

const LINEAR_FETCH_COMMENTS = 100;
const LINEAR_CHANNEL_DEFAULT_LIMIT = 50;
const LINEAR_THREAD_DEFAULT_LIMIT = 100;

function partialFetch(lines: readonly RenderedLine[], possiblyIncomplete: boolean, vendorTruncated: boolean): AdapterReadFetch {
  return {
    lines,
    possiblyIncomplete,
    ...(vendorTruncated ? { partialReason: `vendor page limit: only the newest ${LINEAR_FETCH_COMMENTS} comments were fetched` } : {}),
  };
}

export interface LinearReadDeps {
  readonly api?: LinearReadOpts["api"];
  readonly credentials?: LinearReadOpts["credentials"];
  readonly resolveIssueTeam?: (issueRef: string, organizationId?: string) => Promise<string | undefined>;
}

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

function authorFields(id: string | undefined, name: string | undefined): Pick<RenderedLine, "author" | "authorId"> {
  if (!id && !name) return { author: "(unknown)" };
  return { author: name ?? id ?? "(unknown)", ...(id ? { authorId: id } : {}) };
}

export function linearTopicLine(issue: LinearIssueRead): RenderedLine {
  const title = (issue.title ?? "").trim();
  const description = issue.description.trim();
  const state = issue.stateName?.trim();
  const headline = [title, state ? `[${state}]` : undefined].filter((part): part is string => !!part && part.length > 0).join(" ");
  return {
    ...authorFields(issue.creatorId, issue.creatorName),
    ts: issue.createdAt ?? "",
    text: [headline, description].filter((part) => part.length > 0).join("\n\n"),
  };
}

function commentLine(c: LinearCommentSummary): RenderedLine {
  return { ...authorFields(c.authorId, c.authorName), ts: c.createdAt ?? "", text: c.text };
}

export function linearRootComments(comments: readonly LinearCommentSummary[]): readonly LinearCommentSummary[] {
  return comments.filter((c) => c.parentId === undefined);
}

export function linearThreadLines(comments: readonly LinearCommentSummary[], rootId: string): RenderedLine[] {
  const inThread = new Set<string>([rootId]);
  const kept: LinearCommentSummary[] = [];
  for (const c of comments) {
    const isRoot = c.id !== undefined && c.id === rootId;
    const isDescendant = c.parentId !== undefined && inThread.has(c.parentId);
    if (!isRoot && !isDescendant) continue;
    if (c.id) inThread.add(c.id);
    kept.push(c);
  }
  return kept.map((c) => commentLine(c));
}

async function admitAndRead(ctx: BindableContext, issueRef: string, deps?: LinearReadDeps): Promise<LinearIssueRead> {
  const domains = safeDomains();
  const workOrg = linearWorkOrg(ctx, domains);
  const organizationId = currentTurnOrganization(ctx) ?? workOrg;
  const resolveTeam = deps?.resolveIssueTeam ?? (async (ref: string, org?: string) => (await enrichIssueTeam(ref, { organizationId: org }))?.teamId);
  await assertLinearIssueAllowed(ctx, issueRef, domains, (ref) => resolveTeam(ref, organizationId), { workOrg });
  return await readLinearIssue(issueRef, {
    maxComments: LINEAR_FETCH_COMMENTS,
    ...(organizationId ? { organizationId } : {}),
    ...(deps?.api ? { api: deps.api } : {}),
    ...(deps?.credentials ? { credentials: deps.credentials } : {}),
  });
}

export const linearReadAdapter = {
  platform: "linear" as const,
  wakeAddress(ctx: BindableContext): WakeReadAddress | undefined {
    const binding = bindFrom(ctx);
    const container = binding.anchorChannelId;
    if (!container) return undefined;
    const threadRoot = binding.anchorMessageId;
    return { container, ...(threadRoot ? { threadRoot } : {}) };
  },
  async readChannel(ctx: BindableContext, channel: string, limit?: number, deps?: LinearReadDeps): Promise<AdapterReadFetch> {
    const issue = await admitAndRead(ctx, channel, deps);
    const readAt = new Date().toISOString();
    const effective = Math.max(1, limit ?? LINEAR_CHANNEL_DEFAULT_LIMIT);
    const rootsAll = linearRootComments(issue.comments);
    const roots = rootsAll.slice(-Math.max(1, effective - 1));
    const callerTrimmed = roots.length < rootsAll.length;
    return partialFetch(
      [{ ...linearTopicLine(issue), readAt, live: true }, ...roots.map((c) => ({ ...commentLine(c), readAt }))],
      issue.truncated || callerTrimmed,
      issue.truncated,
    );
  },
  async readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number, deps?: LinearReadDeps): Promise<AdapterReadFetch> {
    const issue = await admitAndRead(ctx, channel, deps);
    const readAt = new Date().toISOString();
    const threadAll = linearThreadLines(issue.comments, threadTs).map((line) => ({ ...line, readAt }));
    const lines = threadAll.slice(-(limit ?? LINEAR_THREAD_DEFAULT_LIMIT));
    const callerTrimmed = lines.length < threadAll.length;
    return partialFetch(lines, issue.truncated || callerTrimmed, issue.truncated);
  },
};
