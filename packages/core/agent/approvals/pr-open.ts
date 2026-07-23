import { getGitHubApp } from "../scm/provider.js";
import { createBranch, deleteRef, getBranchSha, updateRef } from "../scm/refs.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";
import { PENDING_REF_PREFIX } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";

export interface PrOpenArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly headSha: string;
  readonly requestedBy: string;
  readonly tainted?: boolean;
  readonly sessionId?: string;
}

const CARD_BODY_MAX = 1200;

export interface PrOpenExecuteDeps {
  readonly getBranchSha?: typeof getBranchSha;
  readonly createBranch?: typeof createBranch;
  readonly updateRef?: typeof updateRef;
  readonly deleteRef?: typeof deleteRef;
  readonly createPr?: typeof createOrUpdatePullRequest;
  readonly resolveToken?: (repo: string) => Promise<string>;
}

async function resolveWriteToken(repo: string): Promise<string> {
  const app = getGitHubApp();
  if (app) {
    const { tokens, ungranted } = await app.tokensForRepos([repo]);
    if (!ungranted.length) return tokens.get(repo.slice(0, repo.indexOf("/")))!.token;
  }
  const pat = process.env.GITHUB_TOKEN;
  if (!pat) {
    throw new Error("no GitHub credential: configure the GitHub App (OE_GITHUB_APP_*) or set GITHUB_TOKEN.");
  }
  return pat;
}

export async function executePrOpen(args: PrOpenArgs, decidedBy: string, deps: PrOpenExecuteDeps = {}, opts: { sessionApproved?: boolean } = {}): Promise<string> {
  const token = await (deps.resolveToken ?? resolveWriteToken)(args.repo);

  const current = await (deps.getBranchSha ?? getBranchSha)({ repo: args.repo, branch: args.head, token });
  if (current === null) {
    const created = await (deps.createBranch ?? createBranch)({ repo: args.repo, branch: args.head, sha: args.headSha, token });
    if (created === "exists") {
      await (deps.updateRef ?? updateRef)({ repo: args.repo, ref: `heads/${args.head}`, sha: args.headSha, token });
    }
  } else if (current !== args.headSha) {
    await (deps.updateRef ?? updateRef)({ repo: args.repo, ref: `heads/${args.head}`, sha: args.headSha, token });
  }

  const pr = await (deps.createPr ?? createOrUpdatePullRequest)({
    repo: args.repo,
    head: args.head,
    base: args.base,
    title: args.title,
    body: args.body,
    token,
  });

  await (deps.deleteRef ?? deleteRef)({ repo: args.repo, ref: `${PENDING_REF_PREFIX}/${args.head}`, token }).catch(() => {});

  await appendAudit({
    ...whereFromScope(args.org, args.scopeKey),
    principalId: decidedBy,
    action: pr.updated ? "pr.update" : "pr.open",
    detail: {
      repo: args.repo,
      head: args.head,
      base: args.base,
      sha: args.headSha,
      number: pr.number,
      url: pr.url,
      requestedBy: args.requestedBy,
      tainted: Boolean(args.tainted),
      ...(opts.sessionApproved ? { sessionApproved: true } : {}),
    },
  });
  emitTelemetry("oe.feature.used", { "oe.feature": "pr_opened", "oe.outcome": "ok" });
  return pr.updated
    ? `PR #${pr.number} was already open for \`${args.head}\` — the approved commits updated it: ${pr.url}`
    : `pushed \`${args.head}\` and opened PR #${pr.number}: ${pr.url}`;
}

const prOpen: ActionKind<PrOpenArgs> = {
  kind: "pr.open",
  policy: "member",
  summarize(args) {
    const body = args.body.length > CARD_BODY_MAX ? `${args.body.slice(0, CARD_BODY_MAX)}\n… (${args.body.length - CARD_BODY_MAX} more bytes)` : args.body;
    return [
      `Open pull request — \`${args.repo}\`: \`${args.head}\` → \`${args.base}\` (commit \`${args.headSha.slice(0, 12)}\`)`,
      ...(args.tainted ? ["⚠ proposed in a turn that read external content — review the diff before approving"] : []),
      `*${args.title}*`,
      "```",
      body,
      "```",
    ];
  },
  execute(args, decidedBy) {
    return executePrOpen(args, decidedBy);
  },
};

registerActionKind(prOpen);
