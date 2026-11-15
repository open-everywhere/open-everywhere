import { createBranch, deleteRef, getBranchSha, updateRef } from "../scm/refs.js";
import { RateLimitExhaustedError } from "../channels/rate-limit-retry.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";
import { PENDING_REF_PREFIX } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { resolvePrWriteToken } from "../scm/write-token.js";
import { githubAuthMode } from "../scm/credential.js";
import { DEFAULT_PERMISSIONS, expandMintPermissions } from "../scm/mint.js";
import { REPO_CAPABILITIES, isRepoCapability, type RepoCapability } from "../access/repo-capabilities.js";
import { QUOTE_MAX, linkSafeLine, plainQuote, plainValue } from "./plain-text.js";

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
  /** @deprecated Since OPE-2717 nothing writes or reads it. A card frozen before the deploy can still carry it; it is ignored. OPE-2721 removes it. */
  readonly tainted?: boolean;
  readonly capabilities?: readonly RepoCapability[];
  readonly sessionId?: string;
}

const CARD_BODY_MAX = 1200;

function extraMintGrades(capabilities: readonly RepoCapability[] | undefined): string[] {
  if (!Array.isArray(capabilities)) return [];
  const known = capabilities.filter((cap) => isRepoCapability(cap));
  if (known.length === 0) return [];
  const base = DEFAULT_PERMISSIONS as Readonly<Record<string, string | undefined>>;
  return Object.entries(expandMintPermissions(DEFAULT_PERMISSIONS, known))
    .filter(([family, grade]) => grade !== undefined && base[family] !== grade)
    .map(([family, grade]) => `${family}: ${grade}`)
    .sort();
}

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
    githubAuthMode() === "token"
      ? ["Token the approve click uses — this deployment's personal access token, which carries its owner's rights, not a narrowed grade."]
      : declared.length === 0 && !malformed
        ? [`Token the approve click mints — ${grades}. This repo declares no capability, so the mint carries the default write set.`]
        : [`Token the approve click mints — ${grades}.`, ...known.map((cap) => `↳ this repo declares \`${cap}\` — ${REPO_CAPABILITIES[cap].summary}`)];
  if (unknown.length) lines.push(`⚠ this proposal froze capability names this build does not implement (${unknown.join(", ")}) — the publish fails instead of minting them`);
  if (malformed) lines.push("⚠ this proposal's frozen capability list is not a list — the publish fails instead of minting anything from it");
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
  consequence(args) {
    const extra = extraMintGrades(args.capabilities);
    const grants = extra.length > 0 ? ` · the click also grants ${extra.join(", ")} (or the token owner's rights where no GitHub App covers the repo)` : "";
    const prefix = `${linkSafeLine(args.head, 40)} → ${linkSafeLine(args.base, 40)} at ${plainValue(args.headSha.slice(0, 12), 12)}${grants}`;
    return args.body.trim().length > 0 ? `${prefix} · ${plainQuote(args.body, QUOTE_MAX - prefix.length - 3)}` : prefix;
  },
  consequenceQuotes: true,
  summarize(args) {
    const body = args.body.length > CARD_BODY_MAX ? `${args.body.slice(0, CARD_BODY_MAX)}\n… (${args.body.length - CARD_BODY_MAX} more bytes)` : args.body;
    return [
      `Open pull request — \`${args.repo}\`: \`${args.head}\` → \`${args.base}\` (commit \`${args.headSha.slice(0, 12)}\`)`,
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
