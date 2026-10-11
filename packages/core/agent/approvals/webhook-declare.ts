import { getConfig, type AccessRequestsConfig } from "../access/config.js";
import { describeReadableBy } from "../access/read-grant.js";
import { assertWebhooksValid, configHookPosture } from "../webhooks/config.js";
import { webhookReach } from "../webhooks/achievability.js";
import type { Domain } from "../memory/domain.js";
import { applyHookDeclaration, emitHooksModule, emptyHooksFile, parseHooksModule, type HookDeclaration } from "../webhooks/hooks-codemod.js";
import { GitHubContents, type CommitId } from "../scm/contents.js";
import { createBranch, getBranchSha } from "../scm/refs.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";
import { getGitHubApp } from "../scm/provider.js";
import { resolveConfigRepoWriteToken } from "../scm/config-repo-token.js";
import { isSafeBranchName } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { postSurfaceText } from "../channels/surface-message-ops.js";
import { platformOfScopeKey } from "../access/scope-key.js";
import { inlineForReview } from "./review-surface.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { plainValue } from "./plain-text.js";

export interface WebhookDeclareArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly requestId: string;
  readonly declaration: HookDeclaration;
  readonly requestedBy: string;
  readonly reason?: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly configRepo: string;
}

export interface WebhookDeclareExecuteDeps {
  readonly config?: AccessRequestsConfig;
  readonly contents?: Pick<GitHubContents, "getFile" | "putFile">;
  readonly getBranchSha?: typeof getBranchSha;
  readonly createBranch?: typeof createBranch;
  readonly createPr?: typeof createOrUpdatePullRequest;
  readonly post?: (method: string, body: string) => Promise<Record<string, unknown> | undefined>;
  readonly postThreadNote?: (platform: string, target: { channelId: string; text: string; threadTs?: string | null }) => Promise<string | undefined>;
  readonly resolveToken?: (repo: string) => Promise<string>;
  readonly committer?: CommitId;
}

export type EnabledWebhookDeclareConfig = AccessRequestsConfig & { readonly adminChannel: string; readonly configRepo: string };

export function requireWebhookDeclareConfig(override?: AccessRequestsConfig): EnabledWebhookDeclareConfig {
  const cfg = override ?? getConfig().loadAccessRequests?.();
  if (!cfg?.adminChannel || !cfg.configRepo) {
    throw new Error(
      "config-as-code webhook declarations aren't enabled on this deployment — an operator must configure the admin channel + config repo " +
        "(AppConfig.loadAccessRequests; env OE_ACCESS_ADMIN_CHANNEL / OE_ACCESS_CONFIG_REPO). Until then, a hook is declared by hand-editing agent/webhooks/hooks.ts in a PR.",
    );
  }
  if (!cfg.baseWebhooks) {
    throw new Error(
      "this deployment doesn't expose its code-declared webhook baseline (AccessRequestsConfig.baseWebhooks), so a candidate declaration can't be validated against the hooks it would merge alongside. Refusing rather than opening a PR nobody validated.",
    );
  }
  return cfg as EnabledWebhookDeclareConfig;
}

export { inlineForReview };

export function declarationSentence(d: HookDeclaration): string {
  const consequence = d.target === undefined ? "emitting to `event` routines only" : `firing into ${inlineForReview(d.target)}`;
  return `Declare webhook "${inlineForReview(d.id)}" (${inlineForReview(d.source)}) ${consequence}, readable by ${describeReadableBy(d.readableBy)}`;
}

export function posturePayloadLine(d: HookDeclaration): string {
  switch (configHookPosture(d)) {
    case "trigger-only":
      return d.target === undefined
        ? "📦 Payload: DISCARDED (trigger-only) — subscribed routines run on the fact that it fired. Nothing the sender writes ever reaches the model."
        : "📦 Payload: DISCARDED (trigger-only) — the instruction runs on the fact that it fired. Nothing the sender writes ever reaches the model.";
    case "projection":
      return `📦 Payload: ONLY these fields (projection) — ${inlineForReview((d.project ?? []).join(", "))}. Everything else the sender writes is dropped before the prompt.`;
    case "content-bearing":
      return "⚠ Payload: THE WHOLE BODY (content-bearing) — everything the sender writes enters the prompt as untrusted data, on every delivery, forever. Narrow it to `projection` if the instruction only needs a few fields.";
  }
}

export function achievabilityNote(d: HookDeclaration): string | undefined {
  let domains: readonly Domain[] | undefined;
  try {
    domains = getConfig().loadDomains();
  } catch {
    return undefined;
  }
  const reach = webhookReach(d, domains);
  const findings = [...reach.impossible, ...reach.unreachable];
  return findings.length > 0 ? `⚠ Heads up: ${inlineForReview(findings.join(" "))}` : undefined;
}

export function secretSetupLine(d: HookDeclaration): string {
  const ref = typeof d.secretRef === "string" ? d.secretRef : d.secretRef[0]!;
  return d.broker === "env"
    ? `After merging, an operator sets the shared secret as the environment variable \`${ref}\` and redeploys. Generate it with \`openssl rand -hex 32\` and paste the SAME value into the sender — it must never appear in this PR, in chat, or in any log.`
    : d.broker === "db"
      ? `After merging, NOTHING NEEDS REDEPLOYING: ask the agent to rotate the "${d.id}" webhook and a freshly generated secret is stored here at ref \`${ref}\` and shown ONCE, on a private one-time link, to paste into the sender. It must never appear in this PR, in chat, or in any log.`
      : `After merging, an operator stores the shared secret under the \`${d.broker}\` broker at ref \`${ref}\`. It must never appear in this PR, in chat, or in any log.`;
}

function prBody(args: WebhookDeclareArgs, decidedBy: string): string {
  const d = args.declaration;
  return [
    declarationSentence(d) + ".",
    "",
    "```json",
    JSON.stringify(d, null, 2),
    "```",
    "",
    `**Who may read its events:** ${describeReadableBy(d.readableBy)}. This is the whole confidentiality boundary for this ingress — a routine in any other domain is refused. Anything finer-grained than this is a separate webhook, not a narrower grant.`,
    "",
    `**${posturePayloadLine(d)}**`,
    "",
    ...(achievabilityNote(d) ? [achievabilityNote(d)!, ""] : []),
    `**The secret is not in this diff, and never will be.** ${secretSetupLine(d)}`,
    "",
    `Requested by \`${args.requestedBy}\` · sent by \`${decidedBy}\` · scope \`${args.scopeKey}\``,
    ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
    "",
    "---",
    "This diff was produced by the deterministic hooks codemod from a frozen, validated declaration — no model authored any",
    "part of it after the request card was posted. Merging this PR declares the ingress; it does NOT make it live, because the",
    "signing secret is set separately by an operator. Closing it unmerged declines the request.",
    "See docs/extending/webhook-ingress.md.",
  ].join("\n");
}

export async function executeWebhookDeclare(args: WebhookDeclareArgs, decidedBy: string, deps: WebhookDeclareExecuteDeps = {}): Promise<string> {
  const cfg = requireWebhookDeclareConfig(deps.config);
  const repo = cfg.configRepo;
  const base = cfg.configBase ?? "main";
  const hooksPath = cfg.hooksPath ?? "agent/webhooks/hooks.generated.ts";
  const branch = `webhook-declare/${args.requestId}`;
  if (!isSafeBranchName(branch)) throw new Error(`unsafe webhook-declare branch name "${branch}"`);
  const sentence = declarationSentence(args.declaration);
  const baseHooks = cfg.baseWebhooks!();

  const validateMerged = (overlayText: string): ReturnType<typeof applyHookDeclaration> => {
    const overlay = overlayText ? parseHooksModule(overlayText) : emptyHooksFile();
    const result = applyHookDeclaration(overlay, args.declaration, baseHooks.map((h) => h.id));
    let domains: readonly Domain[] | undefined;
    try {
      domains = getConfig().loadDomains();
    } catch {
      domains = undefined;
    }
    assertWebhooksValid([...baseHooks, ...result.hooks.hooks], { domains, warn: () => {} });
    return result;
  };

  if (cfg.dryRun) {
    validateMerged("");
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "webhook.declare.pr_opened",
      detail: { requestId: args.requestId, dryRun: true, hookId: args.declaration.id, sentence, repo, branch },
    });
    return `dry-run — would commit the declaration to ${repo}#${branch} and open a PR against ${base}; validation passed`;
  }

  const token = await (deps.resolveToken ?? resolveConfigRepoWriteToken)(repo);
  const contents = deps.contents ?? new GitHubContents();
  const refSha = deps.getBranchSha ?? getBranchSha;
  const mkBranch = deps.createBranch ?? createBranch;
  const openPr = deps.createPr ?? createOrUpdatePullRequest;
  const post = deps.post ?? bridgeSlackForm;

  let branchSha = await refSha({ repo, branch, token });
  if (branchSha === null) {
    const baseSha = await refSha({ repo, branch: base, token });
    if (baseSha === null) throw new Error(`config repo ${repo} has no base branch "${base}" — check accessRequests.configBase.`);
    await mkBranch({ repo, branch, sha: baseSha, token });
    branchSha = baseSha;
  }

  const existing = await contents.getFile(repo, hooksPath, branch, token);
  const result = validateMerged(existing?.content ?? "");
  if (result.changed) {
    const committer = deps.committer ?? getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
    await contents.putFile(repo, hooksPath, emitHooksModule(result.hooks), `declare webhook: ${args.declaration.id}`, branch, token, committer, existing?.sha);
  }

  const pr = await openPr({ repo, head: branch, base, title: sentence, body: prBody(args, decidedBy), token });

  await appendAudit({
    ...whereFromScope(args.org, args.scopeKey),
    principalId: decidedBy,
    action: "webhook.declare.pr_opened",
    detail: {
      requestId: args.requestId,
      hookId: args.declaration.id,
      source: args.declaration.source,
      ...(args.declaration.target !== undefined ? { target: args.declaration.target } : {}),
      readableBy: describeReadableBy(args.declaration.readableBy),
      sentence,
      repo,
      branch,
      pr: pr.number,
      url: pr.url,
      updated: pr.updated,
      requestedBy: args.requestedBy,
    },
  });
  emitTelemetry("oe.feature.used", { "oe.feature": "webhook_declared", "oe.outcome": "ok" });

  const adminBody = new URLSearchParams();
  adminBody.set("channel", cfg.adminChannel);
  adminBody.set(
    "text",
    `:link: Webhook declaration — ${sentence}.\nRequested by <@${args.requestedBy}> · sent by <@${decidedBy}>` +
      `${args.reason ? ` · reason: ${inlineForReview(args.reason)}` : ""}\nReview and merge to declare it: ${pr.url}\n${secretSetupLine(args.declaration)}`,
  );
  const adminRes = await post("chat.postMessage", adminBody.toString());
  const adminOk = adminRes?.ok === true;

  const askingPlatform = platformOfScopeKey(args.scopeKey);
  if (askingPlatform) {
    const threadNote = deps.postThreadNote ?? postSurfaceText;
    await threadNote(askingPlatform, {
      channelId: args.channelId,
      threadTs: args.threadTs,
      text: `Webhook declaration sent — PR ${pr.url} is with the admins. Merging it declares the ingress; an operator then sets its secret before anything can authenticate.`,
    });
  }

  return (
    `${pr.updated ? `updated PR #${pr.number}` : `opened PR #${pr.number}`} — ${pr.url}; an admin merges it in GitHub to declare the hook, then an operator sets its secret` +
    (adminOk ? "" : " (admin-channel notification failed — flag it to an admin directly)")
  );
}

const webhookDeclare: ActionKind<WebhookDeclareArgs> = {
  kind: "webhook.declare",
  policy: "member",
  plainSummary(args) {
    return `Open a pull request that adds the inbound webhook ${plainValue(args.declaration.id)} from ${plainValue(args.declaration.source)}, for an admin to review`;
  },
  summarize(args) {
    const d = args.declaration;
    return [
      `Open a PR declaring an inbound webhook — ${inlineForReview(d.id)} (${inlineForReview(d.source)})${d.target === undefined ? " — emit-only" : ` → ${inlineForReview(d.target)}`}`,
      ...(d.instruction !== undefined && d.target !== undefined
        ? [
            `It will run this standing instruction, unattended, on every accepted delivery: "${inlineForReview(d.instruction)}"`,
            `⚠ That instruction runs with ${inlineForReview(d.target)}'s full existing access, on anyone's POST, indefinitely — which is why it is reviewed as a diff rather than armed by this click.`,
          ]
        : [
            "It runs NOTHING by itself: no channel, no instruction, no prompt. Accepted deliveries are handed to the event plane, and what happens is whatever `event` routines someone creates and approves separately — each with its own filter and its own room.",
          ]),
      `Readable by: ${describeReadableBy(d.readableBy)} — the whole confidentiality boundary; anything narrower is a separate webhook.`,
      posturePayloadLine(d),
      ...(achievabilityNote(d) ? [achievabilityNote(d)!] : []),
      `🔒 No secret is created or shown by this. ${secretSetupLine(d)}`,
      ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
      `Sending opens a bot-PR against \`${args.configRepo}\` for an admin to merge — nothing is declared, and nothing can authenticate, until they do.`,
      `Requested by ${args.requestedBy}`,
    ];
  },
  async execute(args, decidedBy) {
    return executeWebhookDeclare(args, decidedBy);
  },
};

registerActionKind(webhookDeclare);
