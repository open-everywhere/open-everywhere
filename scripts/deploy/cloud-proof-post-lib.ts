import type { ProofVerdict } from "./cloud-proof-verify-lib.js";
import { type Exec, realExec } from "./lib.js";

export const CLOUD_PROOF_CONTEXT = "oe/cloud-proof";

export const DESCRIPTION_MAX_LENGTH = 140;

export type GhInvocation = { command: "gh"; args: string[] };

export type PostDecision =
  | { kind: "refuse"; reason: string }
  | { kind: "post"; invocation: GhInvocation; state: "success" | "failure"; description: string; sha: string };

export function truncateDescription(text: string): string {
  return text.length <= DESCRIPTION_MAX_LENGTH ? text : `${text.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`;
}

export function buildStatusInvocation(input: { sha: string; state: "success" | "failure"; context: string; description: string; targetUrl?: string }): GhInvocation {
  const args = [
    "api",
    `repos/{owner}/{repo}/statuses/${input.sha}`,
    "--method",
    "POST",
    "-f",
    `state=${input.state}`,
    "-f",
    `context=${input.context}`,
    "-f",
    `description=${input.description}`,
  ];
  if (input.targetUrl) args.push("-f", `target_url=${input.targetUrl}`);
  return { command: "gh", args };
}

export function buildPostDecision(input: { verdict: ProofVerdict; expectedSha: string; sessionId: string; targetUrl?: string }): PostDecision {
  const { verdict, expectedSha, sessionId, targetUrl } = input;

  if (verdict.verdict === "unparseable") {
    return {
      kind: "refuse",
      reason: `refusing to post: the verdict is unparseable (${verdict.reason ?? "no reason given"}) — an ambiguous verdict must never become a commit status.`,
    };
  }
  if (!verdict.sha) {
    return { kind: "refuse", reason: "refusing to post: the verdict carries no sha." };
  }
  if (verdict.sha !== expectedSha) {
    return {
      kind: "refuse",
      reason: `refusing to post: the evidence proves sha ${verdict.sha}, but this run was asked to post for ${expectedSha} — these must match exactly.`,
    };
  }
  if (!sessionId.trim()) {
    return { kind: "refuse", reason: "refusing to post: no session id given — the commit status must pin which cloud run produced this evidence." };
  }

  const state: "success" | "failure" = verdict.verdict === "pass" ? "success" : "failure";
  const suiteSummary = verdict.suites.map((s) => `${s.name}=${s.exit}`).join(", ") || "no suites";
  const description = truncateDescription(`cloud-proof session ${sessionId}: ${state} — ${suiteSummary}`);

  const invocation = buildStatusInvocation({ sha: verdict.sha, state, context: CLOUD_PROOF_CONTEXT, description, ...(targetUrl ? { targetUrl } : {}) });

  return { kind: "post", invocation, state, description, sha: verdict.sha };
}

export function formatInvocation(invocation: GhInvocation): string {
  const quote = (s: string): string => (/[\s"]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s);
  return [invocation.command, ...invocation.args.map(quote)].join(" ");
}

export type PostResult = { ok: true; detail: string } | { ok: false; reason: string };

export async function postCommitStatus(invocation: GhInvocation, exec: Exec = realExec): Promise<PostResult> {
  const res = await exec(invocation.command, invocation.args);
  if (res.spawnError) {
    return { ok: false, reason: `could not run \`gh\` (${res.spawnError}) — is the GitHub CLI installed, on PATH, and authenticated?` };
  }
  if (res.code !== 0) {
    return { ok: false, reason: `\`gh api\` exited ${res.code}: ${(res.stderr || res.stdout || "no output").trim().slice(0, 500)}` };
  }
  return { ok: true, detail: res.stdout.trim() || "(no output)" };
}
