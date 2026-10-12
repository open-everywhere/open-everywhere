import { getConfig, type AccessRequestsConfig } from "../access/config.js";
import { GitHubContents, type CommitId } from "../scm/contents.js";
import { createBranch, getBranchSha } from "../scm/refs.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";
import { getGitHubApp } from "../scm/provider.js";
import { resolveConfigRepoWriteToken } from "../scm/config-repo-token.js";
import { isSafeBranchName } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { requesterWords } from "../channels/friendly-ids.js";
import { postSurfaceText } from "../channels/surface-message-ops.js";
import { platformOfScopeKey } from "../access/scope-key.js";
import { emailPolicy, emailPolicyProblems, type EmailPolicy, type EmailSenderEntry } from "../email/policy.js";
import { normalizeEmailAddress, normalizeSenderRule } from "../email/address.js";
import { inlineForReview } from "./review-surface.js";
import { plainValue } from "./plain-text.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";

export const EMAIL_SENDERS_DEFAULT_PATH = "agent/email/senders.ts";

export interface EmailSenderArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly requestId: string;
  readonly inbox: string;
  readonly sender: string;
  readonly why: string;
  readonly requestedBy: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly configRepo: string;
}

export interface EmailSenderExecuteDeps {
  readonly config?: AccessRequestsConfig;
  readonly policy?: EmailPolicy;
  readonly contents?: Pick<GitHubContents, "getFile" | "putFile">;
  readonly getBranchSha?: typeof getBranchSha;
  readonly createBranch?: typeof createBranch;
  readonly createPr?: typeof createOrUpdatePullRequest;
  readonly postThreadNote?: (platform: string, target: { channelId: string; text: string; threadTs?: string | null }) => Promise<string | undefined>;
  readonly resolveToken?: (repo: string) => Promise<string>;
  readonly committer?: CommitId;
}

export function requireEmailSenderConfig(override?: AccessRequestsConfig): AccessRequestsConfig & { readonly configRepo: string } {
  const cfg = override ?? getConfig().loadAccessRequests?.();
  if (!cfg?.configRepo) {
    throw new Error(
      "adding an email sender opens a pull request on this deployment's config repository, and no config repository is configured " +
        "(AppConfig.loadAccessRequests → configRepo). Until an operator configures one, add the sender by hand to agent/email/senders.ts in a pull request.",
    );
  }
  return cfg as AccessRequestsConfig & { readonly configRepo: string };
}

const OPEN_CALL = "defineEmailSenders([";
const CLOSE_LINE = /^\]\);[ \t]*$/u;

function renderSenderLine(entry: EmailSenderEntry): string {
  return `  ${JSON.stringify(entry)},`;
}

export function readEmailSenderLines(fileText: string): { readonly lines: string[]; readonly close: number; readonly entries: readonly EmailSenderEntry[] } {
  const lines = fileText.split("\n");
  const opens = lines.flatMap((l, i) => (l.includes(OPEN_CALL) ? [i] : []));
  if (opens.length !== 1) {
    throw new Error(`${EMAIL_SENDERS_DEFAULT_PATH} does not hold exactly one \`${OPEN_CALL}\` call, so the sender has no certain place. Add it by hand in a pull request.`);
  }
  const open = opens[0]!;
  const close = lines.findIndex((l, i) => i > open && CLOSE_LINE.test(l));
  if (close === -1) throw new Error(`${EMAIL_SENDERS_DEFAULT_PATH} has no \`]);\` line after \`${OPEN_CALL}\`. Add the sender by hand in a pull request.`);
  const entries: EmailSenderEntry[] = [];
  for (let i = open + 1; i < close; i++) {
    const t = lines[i]!.trim();
    if (t === "" || t.startsWith("//")) continue;
    if (!t.endsWith(",")) throw new Error(`${EMAIL_SENDERS_DEFAULT_PATH} line ${i + 1} is not one JSON entry with a trailing comma. Add the sender by hand in a pull request.`);
    try {
      entries.push(JSON.parse(t.slice(0, -1)) as EmailSenderEntry);
    } catch {
      throw new Error(`${EMAIL_SENDERS_DEFAULT_PATH} line ${i + 1} is not one JSON entry. Add the sender by hand in a pull request.`);
    }
  }
  return { lines, close, entries };
}

export function upsertEmailSenderEntry(fileText: string, entry: EmailSenderEntry): { readonly text: string; readonly changed: boolean; readonly entries: readonly EmailSenderEntry[] } {
  const { lines, close, entries } = readEmailSenderLines(fileText);
  if (entries.some((e) => normalizeEmailAddress(String(e.inbox)) === entry.inbox && normalizeSenderRule(String(e.sender)) === entry.sender)) {
    return { text: fileText, changed: false, entries };
  }
  const next = [...lines.slice(0, close), renderSenderLine(entry), ...lines.slice(close)];
  return { text: next.join("\n"), changed: true, entries: [...entries, entry] };
}

export function emailSenderSentence(args: Pick<EmailSenderArgs, "inbox" | "sender">): string {
  const who = args.sender.startsWith("*@") ? `anyone at ${inlineForReview(args.sender.slice(2))}` : inlineForReview(args.sender);
  return `Allow ${who} to email ${inlineForReview(args.inbox)}`;
}

export function emailSenderSummary(args: EmailSenderArgs): string[] {
  return [
    `${emailSenderSentence(args)} — the agent will read their mail to this inbox and may reply to them.`,
    args.sender.startsWith("*@")
      ? `⚠ This admits EVERY address at ${inlineForReview(args.sender.slice(2))} (that exact domain, not its subdomains). Only mail that passes sender authentication counts.`
      : "Only mail from this exact address that passes sender authentication counts.",
    `Why: ${inlineForReview(args.why)}`,
    `Approving opens a pull request against \`${inlineForReview(args.configRepo)}\` that adds one line to ${EMAIL_SENDERS_DEFAULT_PATH}. Nothing is allowed until an admin merges it.`,
    `Requested by ${requesterWords(args.requestedBy, args.scopeKey)}`,
  ];
}

function prBody(args: EmailSenderArgs, decidedBy: string): string {
  return [
    `${emailSenderSentence(args)}.`,
    "",
    `Merging adds one line to \`${EMAIL_SENDERS_DEFAULT_PATH}\`. Mail from ${args.sender.startsWith("*@") ? `any address at \`${inlineForReview(args.sender.slice(2))}\`` : `\`${inlineForReview(args.sender)}\``} that passes sender authentication (DMARC) then reaches the seat that owns \`${inlineForReview(args.inbox)}\`, and replies to it are allowed. Everyone else stays refused.`,
    "",
    `> ${inlineForReview(args.why)}`,
    "",
    `Requested by \`${args.requestedBy}\` · approved by \`${decidedBy}\` · scope \`${args.scopeKey}\` · card request \`${args.requestId}\``,
    "",
    "---",
    "The line was written by the deterministic email-sender codemod from the frozen card arguments — no model authored any part of",
    "this diff after the card was posted. Closing this pull request unmerged declines the request. See the Email page of the manual.",
  ].join("\n");
}

export async function executeEmailSender(args: EmailSenderArgs, decidedBy: string, deps: EmailSenderExecuteDeps = {}): Promise<string> {
  const cfg = requireEmailSenderConfig(deps.config);
  const repo = cfg.configRepo;
  const base = cfg.configBase ?? "main";
  const path = EMAIL_SENDERS_DEFAULT_PATH;
  const branch = `email-sender/${args.requestId}`;
  if (!isSafeBranchName(branch)) throw new Error(`unsafe email-sender branch name "${branch}"`);
  const sentence = emailSenderSentence(args);
  const entry: EmailSenderEntry = { inbox: args.inbox, sender: args.sender, why: args.why, requestedBy: args.requestedBy, approvedBy: decidedBy };
  const policy = deps.policy ?? emailPolicy();

  const validateMerged = (fileText: string): ReturnType<typeof upsertEmailSenderEntry> => {
    const result = upsertEmailSenderEntry(fileText, entry);
    const problems = emailPolicyProblems(policy, result.entries);
    if (problems.length > 0) throw new Error(`the sender line would make the email policy invalid: ${problems.join("; ")}`);
    return result;
  };

  if (cfg.dryRun) {
    validateMerged(`${OPEN_CALL}\n]);\n`);
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "email.sender.pr_opened",
      detail: { requestId: args.requestId, inbox: args.inbox, sender: args.sender, repo, branch, dryRun: true },
    });
    return `dry-run — would add the sender line to ${repo}#${branch} and open a pull request against ${base}; validation passed`;
  }

  const token = await (deps.resolveToken ?? resolveConfigRepoWriteToken)(repo);
  const contents = deps.contents ?? new GitHubContents();
  const refSha = deps.getBranchSha ?? getBranchSha;
  const mkBranch = deps.createBranch ?? createBranch;
  const openPr = deps.createPr ?? createOrUpdatePullRequest;

  let branchSha = await refSha({ repo, branch, token });
  if (branchSha === null) {
    const baseSha = await refSha({ repo, branch: base, token });
    if (baseSha === null) throw new Error(`config repo ${repo} has no base branch "${base}" — check accessRequests.configBase.`);
    await mkBranch({ repo, branch, sha: baseSha, token });
    branchSha = baseSha;
  }
  const existing = await contents.getFile(repo, path, branch, token);
  if (!existing) throw new Error(`${repo} has no ${path} on ${branch}, so there is no list to add the sender to. Add the file (see the Email page of the manual) in a pull request first.`);
  const result = validateMerged(existing.content);
  if (result.changed) {
    const committer = deps.committer ?? getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
    await contents.putFile(repo, path, result.text, `email sender: ${args.sender} → ${args.inbox}`, branch, token, committer, existing.sha);
  }
  const pr = await openPr({ repo, head: branch, base, title: sentence, body: prBody(args, decidedBy), token });
  await appendAudit({
    ...whereFromScope(args.org, args.scopeKey),
    principalId: decidedBy,
    action: "email.sender.pr_opened",
    detail: { requestId: args.requestId, inbox: args.inbox, sender: args.sender, repo, branch, pr: pr.number, url: pr.url, updated: pr.updated, requestedBy: args.requestedBy },
  });

  const askingPlatform = platformOfScopeKey(args.scopeKey);
  let noted = false;
  if (askingPlatform) {
    const note = deps.postThreadNote ?? postSurfaceText;
    noted =
      (await note(askingPlatform, {
        channelId: args.channelId,
        threadTs: args.threadTs,
        text: `Email sender request sent — PR ${pr.url} is with the admins. ${args.sender} can email ${args.inbox} once it is merged.`,
      }).catch(() => undefined)) !== undefined;
  }
  return `${pr.updated ? `updated PR #${pr.number}` : `opened PR #${pr.number}`} — ${pr.url}; an admin merges it to allow the sender${noted ? "" : " (the thread note did not post — tell the requester the link)"}`;
}

const emailSender: ActionKind<EmailSenderArgs> = {
  kind: "email.sender",
  policy: "member",
  proseArgs: ["why"],
  summarize: emailSenderSummary,
  plainSummary(args) {
    const who = args.sender.startsWith("*@") ? `anyone at ${plainValue(args.sender.slice(2))}` : plainValue(args.sender);
    return `Open a pull request that lets ${who} email ${plainValue(args.inbox)}, for an admin to review`;
  },
  async execute(args, decidedBy) {
    return executeEmailSender(args, decidedBy);
  },
};

registerActionKind(emailSender);
