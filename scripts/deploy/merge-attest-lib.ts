import {
  buildStatusInvocation,
  CLOUD_PROOF_CONTEXT,
  type GhInvocation,
  truncateDescription,
} from "./cloud-proof-post-lib.js";
import {
  classifyCloudProofStatus,
  fetchCombinedStatusForSha,
  fetchGithubApi,
  type GithubApiFetchLike,
  realGithubApiFetch,
  resolveGithubOwnerRepoFromEnv,
  resolveGithubOwnerRepoFromGit,
  resolveGithubRestToken,
} from "./ci-gate-lib.js";
import { type Env, type Exec, realExec } from "./lib.js";
import { type MergeFenceDecision, parsePullRequestSubject } from "./merge-fence-lib.js";

export const UPGRADE_FENCE_CONTEXT = "oe/upgrade-fence";

export type AttestPlan =
  | { kind: "refuse"; reason: string }
  | { kind: "post"; invocation: GhInvocation; context: string; state: "success" | "failure"; description: string; sha: string; note: string };

export function refusalGuidance(leg: { kind: "fence" } | { kind: "transfer"; mergeSha?: string }): string {
  if (leg.kind === "fence") return "Nothing was posted. DO NOT MERGE.";
  const which = leg.mergeSha ? leg.mergeSha.slice(0, 12) : "named by --merge-sha";
  return (
    `Nothing was posted, and the merge has ALREADY happened — this is not a merge decision. The merge commit ${which} ` +
    `is on the default branch carrying no transferred \`${CLOUD_PROOF_CONTEXT}\`. ` +
    "DO NOT DEPLOY it until the refusal above is cleared, or a proof run judges that commit directly."
  );
}

export function planFenceAttestation(input: { decision: MergeFenceDecision; targetUrl?: string }): AttestPlan {
  const { decision, targetUrl } = input;
  const subject = decision.subject;

  if (!subject) {
    return {
      kind: "refuse",
      reason:
        `refusing to attest: the fence never read the pull request (${decision.message}) — there is no judged sha to post on. ` +
        "Fix the fault and re-run; an unattested head is a blocked merge, which is the correct outcome here.",
    };
  }

  if (subject.merged) {
    return {
      kind: "refuse",
      reason:
        `refusing to attest: pull request #${subject.number} is ALREADY MERGED. This rung judges a proposal, and attesting a merged ` +
        "head changes nothing about what shipped. A merge that reached this state with no `oe/upgrade-fence` status on its head is the " +
        "unjudged merge OPE-1182 exists to make visible — say so rather than paint a status over it.",
    };
  }

  const head = subject.headSha;
  const base = subject.baseSha.slice(0, 12);

  if (decision.verdict === "clear") {
    const description = truncateDescription(`upgrade-fence ${decision.fence}: PR #${subject.number} judged with the fence at base ${base}`);
    return {
      kind: "post",
      invocation: buildStatusInvocation({ sha: head, state: "success", context: UPGRADE_FENCE_CONTEXT, description, ...(targetUrl ? { targetUrl } : {}) }),
      context: UPGRADE_FENCE_CONTEXT,
      state: "success",
      description,
      sha: head,
      note:
        decision.fence === "warn"
          ? "the fence WARNS: this diff changes a protected path and reads as person-authored. Review those files as a guardrail change."
          : "the fence passes.",
    };
  }

  const refusedBy =
    decision.dco === "refuse"
      ? "DCO sign-off REFUSED"
      : decision.dco === "unreadable"
        ? "DCO sign-off could not run"
        : decision.fence === "refuse"
          ? "upgrade-fence REFUSED"
          : "upgrade-fence could not run";
  const description = truncateDescription(`${refusedBy}: PR #${subject.number} — do not merge`);
  return {
    kind: "post",
    invocation: buildStatusInvocation({ sha: head, state: "failure", context: UPGRADE_FENCE_CONTEXT, description, ...(targetUrl ? { targetUrl } : {}) }),
    context: UPGRADE_FENCE_CONTEXT,
    state: "failure",
    description,
    sha: head,
    note: decision.message,
  };
}

export function planFenceLeg(input: {
  decision: MergeFenceDecision;
  defaultBranch: string | undefined;
  protection: ProtectionState | undefined;
  requireProtection: boolean;
  targetUrl?: string;
}): AttestPlan {
  const { decision, defaultBranch, protection, requireProtection, targetUrl } = input;
  const subject = decision.subject;

  if (subject) {
    if (!defaultBranch) {
      return {
        kind: "refuse",
        reason:
          "refusing to attest: this run could not read the repository's default branch, so it cannot tell whether the pull request's base " +
          "is a branch it may execute a fence from. The fence runs the BASE ref's code in this process — an unverified base is a refusal.",
      };
    }
    if (subject.baseRef !== defaultBranch) {
      return {
        kind: "refuse",
        reason:
          `refusing to attest: pull request #${subject.number} targets \`${subject.baseRef || "(no base ref)"}\`, not the default branch \`${defaultBranch}\`. ` +
          "This rung executes the BASE ref's copy of the fence in the attesting session, so a base that a proposal controls would have the " +
          "attester run the proposal's own code. Retarget the pull request, or judge it in the sandbox with `deploy:merge-fence`.",
      };
    }
  }

  if (requireProtection && protection?.kind !== "required") {
    const said = protection === undefined ? "was never read" : protection.kind === "unknown" ? `could not be confirmed (${protection.reason})` : "does not name this context";
    return {
      kind: "refuse",
      reason:
        `refusing under --require-protection: the branch protection rule ${said}, so \`${UPGRADE_FENCE_CONTEXT}\` is not confirmed required. ` +
        "Posting a status that gates nothing reads as enforcement and is not — add the branch protection rule first.",
    };
  }

  return planFenceAttestation({ decision, ...(targetUrl ? { targetUrl } : {}) });
}

export type TreeResolution = { ok: true; tree: string } | { ok: false; reason: string };

export async function resolveTree(input: { sha: string; exec?: Exec }): Promise<TreeResolution> {
  const exec = input.exec ?? realExec;
  const short = input.sha.slice(0, 12);

  if (!/^[0-9a-f]{40}$/.test(input.sha)) {
    return { ok: false, reason: `\`${input.sha.slice(0, 24)}\` is not a full 40-character commit sha — refusing to hand it to \`git\`.` };
  }

  const read = async (): Promise<string | undefined> => {
    const res = await exec("git", ["rev-parse", `${input.sha}^{tree}`]);
    const tree = res.stdout.trim();
    return !res.spawnError && res.code === 0 && /^[0-9a-f]{40}$/.test(tree) ? tree : undefined;
  };

  const first = await read();
  if (first) return { ok: true, tree: first };

  const fetched = await exec("git", ["fetch", "--depth=1", "origin", input.sha]);
  if (fetched.spawnError) return { ok: false, reason: `could not run \`git\` (${fetched.spawnError}) — the transfer cannot compare trees without it` };

  const second = await read();
  if (second) return { ok: true, tree: second };
  return {
    ok: false,
    reason: `could not read the tree of ${short}, and \`git fetch --depth=1 origin ${input.sha}\` did not bring it in — refusing rather than transfer a proof between commits whose bytes were never compared.`,
  };
}

export async function runProofTransfer(input: {
  prNumber: number;
  mergeSha: string;
  exec?: Exec;
  fetchImpl?: GithubApiFetchLike;
  env?: Env;
  targetUrl?: string;
}): Promise<AttestPlan> {
  const exec = input.exec ?? realExec;
  const fetchImpl = input.fetchImpl ?? realGithubApiFetch;
  const env = input.env ?? process.env;

  const gate = requireCredential(env);
  if (gate) return gate;

  const raw = await fetchGithubApi({
    ghArgs: ["api", `repos/{owner}/{repo}/pulls/${input.prNumber}`, "--method", "GET"],
    restPathSuffix: `pulls/${input.prNumber}`,
    exec,
    fetchImpl,
    env,
  });
  if (!raw.ok) return { kind: "refuse", reason: `could not read pull request #${input.prNumber} (${raw.reason}) — refusing rather than transfer a proof it cannot trace.` };

  const parsed = parsePullRequestSubject(raw.body);
  if (!parsed.ok) return { kind: "refuse", reason: `${parsed.reason} — refusing rather than transfer a proof it cannot trace.` };
  const subject = parsed.subject;

  if (!subject.merged) {
    return { kind: "refuse", reason: `pull request #${subject.number} is not merged — there is no merge commit to transfer a proof onto.` };
  }
  if (!subject.mergeCommitSha) {
    return { kind: "refuse", reason: `pull request #${subject.number} reports merged but carries no \`merge_commit_sha\` — refusing rather than guess which commit the merge produced.` };
  }
  if (subject.mergeCommitSha !== input.mergeSha) {
    return {
      kind: "refuse",
      reason:
        `pull request #${subject.number} was merged as ${subject.mergeCommitSha.slice(0, 12)}, but this run was asked to transfer onto ${input.mergeSha.slice(0, 12)} — ` +
        "these must match exactly. Two sources of truth about which commit the merge produced is the ambiguity this rung fails closed on.",
    };
  }

  const headTree = await resolveTree({ sha: subject.headSha, exec });
  if (!headTree.ok) return { kind: "refuse", reason: headTree.reason };
  const mergeTree = await resolveTree({ sha: input.mergeSha, exec });
  if (!mergeTree.ok) return { kind: "refuse", reason: mergeTree.reason };

  if (headTree.tree !== mergeTree.tree) {
    return {
      kind: "refuse",
      reason:
        `the merge commit ${input.mergeSha.slice(0, 12)} does not have the same tree as the proven head ${subject.headSha.slice(0, 12)} ` +
        `(${mergeTree.tree.slice(0, 12)} vs ${headTree.tree.slice(0, 12)}) — the squash absorbed work the proof never ran against. ` +
        "That tip needs its own proof run; a transfer here would assert something no suite established.",
    };
  }

  const headStatus = await fetchCombinedStatusForSha({ sha: subject.headSha, exec, fetchImpl, env });
  if (!headStatus.ok) return { kind: "refuse", reason: `could not read the combined status of head ${subject.headSha.slice(0, 12)} (${headStatus.reason}).` };
  const headProof = classifyCloudProofStatus(headStatus.statuses);
  if (headProof.kind !== "success") {
    const said = headProof.kind === "red" ? `is \`${headProof.state}\`` : headProof.kind === "pending" ? "is pending" : "is absent";
    return {
      kind: "refuse",
      reason: `the head ${subject.headSha.slice(0, 12)} has no green \`${CLOUD_PROOF_CONTEXT}\` to transfer — it ${said}. There is nothing proven here to move.`,
    };
  }

  const mergeStatus = await fetchCombinedStatusForSha({ sha: input.mergeSha, exec, fetchImpl, env });
  if (!mergeStatus.ok) return { kind: "refuse", reason: `could not read the combined status of the merge commit ${input.mergeSha.slice(0, 12)} (${mergeStatus.reason}).` };
  const mergeProof = classifyCloudProofStatus(mergeStatus.statuses);
  if (mergeProof.kind === "red" || mergeProof.kind === "pending") {
    const said = mergeProof.kind === "red" ? `\`${mergeProof.state}\`` : "pending";
    return {
      kind: "refuse",
      reason:
        `the merge commit ${input.mergeSha.slice(0, 12)} already carries a ${said} \`${CLOUD_PROOF_CONTEXT}\` — refusing to overwrite it with a transferred pass. ` +
        "A proof run that judged this exact commit outranks one transferred onto it.",
    };
  }

  const description = truncateDescription(`cloud-proof transferred from ${subject.headSha.slice(0, 12)} (same tree) — PR #${subject.number}`);
  return {
    kind: "post",
    invocation: buildStatusInvocation({ sha: input.mergeSha, state: "success", context: CLOUD_PROOF_CONTEXT, description, ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}) }),
    context: CLOUD_PROOF_CONTEXT,
    state: "success",
    description,
    sha: input.mergeSha,
    note: `tree ${headTree.tree.slice(0, 12)} is identical on both commits, so the head's proof holds for the merge.`,
  };
}

export async function readDefaultBranch(input: { exec?: Exec; fetchImpl?: GithubApiFetchLike; env?: Env }): Promise<string | undefined> {
  const raw = await fetchGithubApi({
    ghArgs: ["api", "repos/{owner}/{repo}", "--method", "GET"],
    restPathSuffix: "",
    exec: input.exec ?? realExec,
    fetchImpl: input.fetchImpl ?? realGithubApiFetch,
    env: input.env ?? process.env,
  });
  if (!raw.ok || !raw.body || typeof raw.body !== "object") return undefined;
  const branch = (raw.body as Record<string, unknown>).default_branch;
  return typeof branch === "string" && branch.length > 0 ? branch : undefined;
}

export type ProtectionState =
  | { kind: "required" }
  | { kind: "not-required"; contexts: string[] }
  | { kind: "unknown"; reason: string };

export function classifyRequiredContexts(body: unknown, context: string): ProtectionState {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "unknown", reason: "the required-status-checks response is not a JSON object" };
  }
  const rec = body as Record<string, unknown>;
  const found: string[] = [];
  if (Array.isArray(rec.contexts)) for (const entry of rec.contexts) if (typeof entry === "string") found.push(entry);
  if (Array.isArray(rec.checks)) {
    for (const entry of rec.checks) {
      if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).context === "string") found.push((entry as Record<string, unknown>).context as string);
    }
  }
  if (!Array.isArray(rec.contexts) && !Array.isArray(rec.checks)) {
    return { kind: "unknown", reason: "the required-status-checks response carries neither a `contexts` nor a `checks` array" };
  }
  const unique = [...new Set(found)];
  return unique.includes(context) ? { kind: "required" } : { kind: "not-required", contexts: unique };
}

export async function readRequiredContexts(input: {
  branch: string;
  context: string;
  exec?: Exec;
  fetchImpl?: GithubApiFetchLike;
  env?: Env;
}): Promise<ProtectionState> {
  const path = `branches/${encodeURIComponent(input.branch)}/protection/required_status_checks`;
  const raw = await fetchGithubApi({
    ghArgs: ["api", `repos/{owner}/{repo}/${path}`, "--method", "GET"],
    restPathSuffix: path,
    exec: input.exec ?? realExec,
    fetchImpl: input.fetchImpl ?? realGithubApiFetch,
    env: input.env ?? process.env,
  });
  if (!raw.ok) {
    return {
      kind: "unknown",
      reason:
        `could not read the required status checks on \`${input.branch}\` (${raw.reason}). ` +
        "This reads as either 'the branch has no protection rule' or 'this credential may not see one' — the rung cannot tell them apart, so it confirms nothing.",
    };
  }
  return classifyRequiredContexts(raw.body, input.context);
}

function requireCredential(env: Env): { kind: "refuse"; reason: string } | undefined {
  if (!resolveGithubRestToken(env)) {
    return {
      kind: "refuse",
      reason: "no GitHub credential — set GH_TOKEN (or GITHUB_TOKEN) so this rung can read the pull request. A rung with no credential posts nothing.",
    };
  }
  return undefined;
}

export async function resolveRepoLabel(input: { exec?: Exec; env?: Env }): Promise<string | undefined> {
  const env = input.env ?? process.env;
  const ownerRepo = resolveGithubOwnerRepoFromEnv(env) ?? (await resolveGithubOwnerRepoFromGit(input.exec ?? realExec));
  return ownerRepo ? `${ownerRepo.owner}/${ownerRepo.repo}` : undefined;
}
