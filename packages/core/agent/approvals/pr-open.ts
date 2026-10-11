import { createBranch, deleteRef, getBranchSha, updateRef } from "../scm/refs.js";
import { RateLimitExhaustedError } from "../channels/rate-limit-retry.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";
import { PENDING_REF_PREFIX } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { resolvePrWriteToken } from "../scm/write-token.js";
import { DEFAULT_PERMISSIONS, expandMintPermissions } from "../scm/mint.js";
import { REPO_CAPABILITIES, isRepoCapability, type RepoCapability } from "../access/repo-capabilities.js";
import { plainValue } from "./plain-text.js";

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
  readonly capabilities?: readonly RepoCapability[];
  readonly sessionId?: string;
}

const CARD_BODY_MAX = 1200;

function mintGradeLines(capabilities: readonly RepoCapability[]): string[] {
  const malformed = !Array.isArray(capabilities);
  const declared = malformed ? [] : [...capabilities].sort();
  const known = declared.filter((cap) => isRepoCapability(cap));
  const unknown = declared.filter((cap) => !isRepoCapability(cap));
  const grades = Object.entries(expandMintPermissions(DEFAULT_PERMISSIONS, known))
    .filter(([, grade]) => grade !== undefined)
    .map(([family, grade]) => `${family}: ${grade}`)
    .sort()
    .join(", ");
  const lines =
    declared.length === 0 && !malformed
      ? [`Token the approve click mints — ${grades}. This repo declares no capability, so the mint carries the default write set.`]
      : [`Token the approve click mints — ${grades}.`, ...known.map((cap) => `↳ this repo declares \`${cap}\` — ${REPO_CAPABILITIES[cap].summary}`)];
  if (unknown.length) lines.push(`⚠ this proposal froze capability names this build does not implement (${unknown.join(", ")}) — the App publish fails instead of minting them`);
  if (malformed) lines.push("⚠ this proposal's frozen capability list is not a list — the App publish fails instead of minting anything from it");
  lines.push("These grades are the GitHub App mint. Where no App installation covers this repo, the publish falls back to the `GITHUB_TOKEN` PAT, which carries its own owner's rights instead.");
  return lines;
}

export interface PrOpenExecuteDeps {
  readonly getBranchSha?: typeof getBranchSha;
  readonly createBranch?: typeof createBranch;
  readonly updateRef?: typeof updateRef;
  readonly deleteRef?: typeof deleteRef;
  readonly createPr?: typeof createOrUpdatePullRequest;
  readonly resolveToken?: (repo: string, capabilities?: readonly RepoCapability[]) => Promise<string>;
}

export async function executePrOpen(args: PrOpenArgs, decidedBy: string, deps: PrOpenExecuteDeps = {}, opts: { sessionApproved?: boolean } = {}): Promise<string> {
  const token = await (deps.resolveToken ?? resolvePrWriteToken)(args.repo, args.capabilities ?? []);

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

  await (deps.deleteRef ?? deleteRef)({ repo: args.repo, ref: `${PENDING_REF_PREFIX}/${args.head}`, token }).catch((err: unknown) => {
    if (err instanceof RateLimitExhaustedError) {
      console.warn(`[open-everywhere:github] rate limited: git.refs.delete gave up after ${err.attempts} attempts (waited ${err.waitedMs} ms) — the pending ref is leftover clutter, not a failed PR`);
    }
  });

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
  plainSummary(args) {
    return `Open a pull request on ${plainValue(args.repo)}: ${plainValue(args.title, 70)}`;
  },
  summarize(args) {
    const body = args.body.length > CARD_BODY_MAX ? `${args.body.slice(0, CARD_BODY_MAX)}\n… (${args.body.length - CARD_BODY_MAX} more bytes)` : args.body;
    return [
      `Open pull request — \`${args.repo}\`: \`${args.head}\` → \`${args.base}\` (commit \`${args.headSha.slice(0, 12)}\`)`,
      ...(args.tainted ? ["⚠ proposed in a turn that read external content — review the diff before approving"] : []),
      ...mintGradeLines(args.capabilities ?? []),
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
