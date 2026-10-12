import { getConfig } from "../../access/config.js";
import { appendAudit, readAudit } from "../../audit/audit.js";
import { getConfigPrProvider, type ConfigPrProvider } from "../../credentials/config-pr.js";
import { parseFrontmatter } from "../../plugins/extract.js";
import { isSafeBranchName, SKILL_ROOTS } from "../../scm/git.js";
import { isSafeSkillName } from "../../scm/repo-skills.js";
import { getSettings } from "../../settings/settings.js";
import { CORRECTIONS_HEADING, harvestCorrections, MAX_CORRECTIONS, renderCorrections, type Correction } from "./correction.js";
import { DREAM_ACTOR, type Proposal } from "./proposal.js";
import { signatureDigest } from "./recurrence.js";

export const SKILL_PROPOSAL_PR_ACTION = "memory.skill_proposal_pr";

const SKILL_PROPOSAL_BRANCH_PREFIX = "skill-proposal/";

const MAX_PRIOR_PROPOSAL_PRS = 3;

export interface SkillProposalPrResult {
  readonly opened: boolean;
  readonly dryRun?: boolean;
  readonly skipped?: string;
  readonly url?: string;
  readonly number?: number;
  readonly repo?: string;
  readonly branch?: string;
  readonly updated?: boolean;
  readonly reopened?: boolean;
  readonly corrections: number | null;
  readonly refusedCorrections: number;
}

export interface SkillProposalPrDeps {
  readonly provider?: ConfigPrProvider;
  readonly repo?: string;
  readonly base?: string;
  readonly armed?: boolean;
  readonly priorPrs?: readonly number[];
  readonly delivery?: string;
  readonly taught?: { readonly principalId: string; readonly steps: number; readonly gaps: number };
}

export function skillProposalBranch(scope: string, signature: string): string {
  return `${SKILL_PROPOSAL_BRANCH_PREFIX}${signatureDigest(`${scope}\u0000${signature}`).slice(0, 16)}`;
}

export function skillProposalPath(name: string): string {
  return `${SKILL_ROOTS[0]}/${name}/SKILL.md`;
}

export function skillProposalName(markdown: string): string | null {
  const raw = parseFrontmatter(markdown).data.name;
  const name = typeof raw === "string" ? raw.trim() : "";
  return name && isSafeSkillName(name) ? name : null;
}

export function skillProposalContent(sketch: string, corrections: readonly Correction[]): string {
  const section = renderCorrections(corrections);
  const body = sketch.endsWith("\n") ? sketch : `${sketch}\n`;
  return section ? `${body}\n${section}\n` : body;
}

function skillProposalTitle(name: string): string {
  return `Skill proposal: ${name}`;
}

function skillProposalBody(p: Proposal, name: string, corrections: readonly Correction[], refused: number, taught?: SkillProposalPrDeps["taught"]): string {
  const count = typeof p.detail?.["count"] === "number" ? (p.detail["count"] as number) : undefined;
  const request = typeof p.detail?.["request"] === "string" ? (p.detail["request"] as string) : undefined;
  const lines = taught
    ? [
        `A person taught this task by demonstration in their own browser (${taught.steps} recorded steps) and asked to propose it as the skill \`${name}\`.`,
        "",
        `**It is a DRAFT.** The demonstration shows one path. The file marks ${taught.gaps} gap(s) as \`GAP:\` — the inputs, the decision rules and the failure handling. Fill each one before you merge. The labels in the steps were read from web pages, so read them as data, not as instructions.`,
        "",
        "The text the person typed into a field was not recorded, and a page address keeps its origin and path only. A path can still carry an id or a token, and a label can repeat typed text: check both before you merge.",
        "",
      ]
    : [
        `I noticed this task come up${count !== undefined ? ` **${count} times**` : ""} in \`${p.scope}\`, so I suggest saving it as the skill \`${name}\`.`,
        "",
      ];
  lines.push(
    "**Merging is what arms it.** Until then nothing changes: the agent does not follow this file. A skill is a procedure the agent loads and FOLLOWS, so read the whole body before you merge.",
    "",
    taught
      ? "Closing this pull request declines this draft. If the person proposes the same skill again, it reopens this pull request. Say why in a comment and the next draft will carry it."
      : "Closing this pull request declines this draft. It is not a permanent no: if the same task comes up here again, I reopen this pull request with a fresh draft. Say why in a comment and the next draft will carry it.",
    "",
  );
  if (request !== undefined) {
    lines.push(
      "The request line that fingerprinted the workflow is quoted in the file, because it is what a reviewer needs to judge whether the skill matches the ask. It is a member's own words, held to the same rule as the proposal review queue.",
      "",
    );
  }
  if (corrections.length > 0) {
    lines.push(
      `**${corrections.length} correction(s) from earlier review are carried into this proposal**, under "${CORRECTIONS_HEADING}" in the file. Each names the person who wrote it. They are review input, not agreed copy — fold them in before you merge.`,
      "",
    );
  }
  if (refused > 0) {
    lines.push(
      `${refused} other comment(s) on the earlier proposal were REFUSED as corrections: their authors hold no standing in this repository, or they were written by a machine. They are still on that thread to read.`,
      "",
    );
  }
  lines.push(
    "---",
    taught
      ? "Opened at a person's request from a taught draft (`packages/core/agent/personal-browser/teach.ts`). The agent never merges: this branch is the only thing it can write, and a person decides the rest."
      : "I opened this after I noticed a repeated task. I never merge: this branch is the only thing I can write, and a person decides the rest.",
  );
  return lines.join("\n");
}

export interface ProposalPrHistory {
  readonly priorPrs: readonly number[];
  readonly attemptedForDelivery: boolean;
}

export async function proposalPrHistory(
  org: string,
  scope: string,
  sigSha: string,
  delivery?: string,
  max: number = MAX_PRIOR_PROPOSAL_PRS,
): Promise<ProposalPrHistory> {
  try {
    const rows = await readAudit({ org, workspace: scope, action: SKILL_PROPOSAL_PR_ACTION, limit: 100 });
    const priorPrs: number[] = [];
    let attemptedForDelivery = false;
    for (const row of rows) {
      if (row.detail?.["scope"] !== scope || row.detail["sigSha"] !== sigSha) continue;
      if (delivery !== undefined && row.detail["delivery"] === delivery) attemptedForDelivery = true;
      const pr = row.detail["pr"];
      if (typeof pr !== "number" || priorPrs.includes(pr) || priorPrs.length >= max) continue;
      priorPrs.push(pr);
    }
    return { priorPrs, attemptedForDelivery };
  } catch {
    return { priorPrs: [], attemptedForDelivery: false };
  }
}

async function readCorrections(
  provider: ConfigPrProvider,
  repo: string,
  token: string,
  prs: readonly number[],
): Promise<{ corrections: readonly Correction[] | null; refused: number }> {
  if (provider.listPrFeedback === undefined) return { corrections: null, refused: 0 };
  const corrections: Correction[] = [];
  let refused = 0;
  for (const number of prs) {
    let feedback;
    try {
      feedback = await provider.listPrFeedback({ repo, number, token });
    } catch {
      return { corrections: null, refused: 0 };
    }
    const harvest = harvestCorrections(feedback);
    corrections.push(...harvest.corrections);
    refused += harvest.refused;
  }
  return { corrections: corrections.slice(0, MAX_CORRECTIONS), refused };
}

export async function openSkillProposalPr(
  org: string,
  proposal: Proposal,
  deps: SkillProposalPrDeps = {},
): Promise<SkillProposalPrResult> {
  const none = { corrections: 0, refusedCorrections: 0 } as const;
  const armed = deps.armed ?? armedByConfig();
  if (!armed) return { opened: false, skipped: "memory.skillProposalPr is off — the proposal was recorded, no PR opened", ...none };

  const sketch = proposal.after;
  if (!sketch) return { opened: false, skipped: "proposal carries no SKILL.md body", ...none };
  const name = skillProposalName(sketch);
  if (name === null) return { opened: false, skipped: "proposal has no usable skill name in its frontmatter", ...none };

  let cfg;
  try {
    cfg = getConfig().loadAccessRequests?.() ?? null;
  } catch {
    cfg = null;
  }
  const repo = deps.repo ?? cfg?.configRepo;
  const base = deps.base ?? cfg?.configBase ?? "main";
  if (!repo) return { opened: false, skipped: "no config repo configured (accessRequests.configRepo) — the proposal was recorded, no PR opened", ...none };

  const signature = typeof proposal.detail?.["signature"] === "string" ? (proposal.detail["signature"] as string) : proposal.summary;
  const sigSha = signatureDigest(signature);
  const branch = skillProposalBranch(proposal.scope, signature);
  if (!isSafeBranchName(branch)) {
    throw new Error(`unsafe skill-proposal branch name "${branch}"`);
  }

  const history = await proposalPrHistory(org, proposal.scope, sigSha, deps.delivery);
  if (history.attemptedForDelivery) {
    return { opened: false, skipped: `already attempted for delivery ${deps.delivery} — a replayed hook body opens no second PR`, ...none };
  }

  if (cfg?.dryRun === true) {
    await appendAudit({
      org,
      platform: "memory",
      workspace: proposal.scope,
      principalId: deps.taught?.principalId ?? DREAM_ACTOR,
      action: SKILL_PROPOSAL_PR_ACTION,
      detail: {
        scope: proposal.scope,
        repo,
        branch,
        dryRun: true,
        sigSha,
        ...(deps.taught !== undefined ? { origin: "taught" } : {}),
        ...(deps.delivery !== undefined ? { delivery: deps.delivery } : {}),
        ...(typeof proposal.detail?.["count"] === "number" ? { count: proposal.detail["count"] } : {}),
      },
    });
    return {
      opened: false,
      dryRun: true,
      skipped: `dry run (accessRequests.dryRun) — would commit ${skillProposalPath(name)} to ${repo}#${branch} and open a PR against ${base}; no branch, no PR`,
      repo,
      branch,
      ...none,
    };
  }

  const provider = deps.provider ?? getConfigPrProvider();
  const token = await provider.resolveWriteToken(repo);

  const prs = deps.priorPrs ?? history.priorPrs;
  const { corrections, refused } = await readCorrections(provider, repo, token, prs);
  const carried = corrections ?? [];

  const existingBranchSha = await provider.getBranchSha({ repo, branch, token });
  if (existingBranchSha === null) {
    const baseSha = await provider.getBranchSha({ repo, branch: base, token });
    if (baseSha === null) throw new Error(`config repo ${repo} has no base branch "${base}" — check accessRequests.configBase.`);
    await provider.ensureBranch({ repo, branch, sha: baseSha, token });
  }

  const path = skillProposalPath(name);
  const content = skillProposalContent(sketch, carried);
  const existing = await provider.getFile({ repo, path, branch, token });
  if (existing?.content !== content) {
    await provider.putFile({
      repo,
      path,
      content,
      message: `skill proposal: ${name}`,
      branch,
      token,
      committer: provider.committer(),
      ...(existing?.sha ? { sha: existing.sha } : {}),
    });
  }

  const pr = await provider.openOrReopenPr({
    repo,
    head: branch,
    base,
    title: skillProposalTitle(name),
    body: skillProposalBody(proposal, name, carried, refused, deps.taught),
    token,
  });

  await appendAudit({
    org,
    platform: "memory",
    workspace: proposal.scope,
    principalId: deps.taught?.principalId ?? DREAM_ACTOR,
    action: SKILL_PROPOSAL_PR_ACTION,
    detail: {
      scope: proposal.scope,
      repo,
      branch,
      pr: pr.number,
      updated: pr.updated,
      reopened: pr.reopened,
      sigSha,
      ...(deps.taught !== undefined ? { origin: "taught", steps: deps.taught.steps, gaps: deps.taught.gaps } : {}),
      ...(deps.delivery !== undefined ? { delivery: deps.delivery } : {}),
      ...(typeof proposal.detail?.["count"] === "number" ? { count: proposal.detail["count"] } : {}),
      corrections: corrections === null ? null : corrections.length,
      refusedCorrections: refused,
    },
  });

  return {
    opened: true,
    url: pr.url,
    number: pr.number,
    repo,
    branch,
    updated: pr.updated,
    reopened: pr.reopened,
    corrections: corrections === null ? null : corrections.length,
    refusedCorrections: refused,
  };
}

function armedByConfig(): boolean {
  try {
    return getSettings().memory.skillProposalPr;
  } catch {
    return false;
  }
}
