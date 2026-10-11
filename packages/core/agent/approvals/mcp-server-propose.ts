import { requesterWords } from "../channels/friendly-ids.js";
import { getConfig, type AccessRequestsConfig } from "../access/config.js";
import { defineMcpServers, type McpServerDeclaration } from "../connections/mcp-servers.js";
import { insertMcpServerEntry } from "../connections/mcp-servers-codemod.js";
import { CONTRIBUTIONS } from "../contributions.js";
import { GitHubContents, type CommitId } from "../scm/contents.js";
import { createBranch, getBranchSha } from "../scm/refs.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";
import { getGitHubApp } from "../scm/provider.js";
import { resolveConfigRepoWriteToken } from "../scm/config-repo-token.js";
import { isSafeBranchName } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { postSurfaceText } from "../channels/surface-message-ops.js";
import { platformOfScopeKey } from "../access/scope-key.js";
import { OE_OAUTH_CALLBACK_PATH } from "../connections/oe-oauth-callback.js";
import { inlineForReview } from "./review-surface.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { plainValue } from "./plain-text.js";

export interface McpServerProposeArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly requestId: string;
  readonly declaration: McpServerDeclaration;
  readonly docUrls: readonly string[];
  readonly vendorSteps: readonly string[];
  readonly requestedBy: string;
  readonly reason?: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly configRepo: string;
}

export interface McpServerProposeExecuteDeps {
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

export type EnabledMcpServerProposeConfig = AccessRequestsConfig & { readonly adminChannel: string; readonly configRepo: string };

export function requireMcpServerProposeConfig(override?: AccessRequestsConfig): EnabledMcpServerProposeConfig {
  const cfg = override ?? getConfig().loadAccessRequests?.();
  if (!cfg?.adminChannel || !cfg.configRepo) {
    throw new Error(
      "proposing an MCP server from chat isn't enabled on this deployment — an operator must configure the admin channel and the config repo " +
        "(agent/access/access-requests.ts). Until then, an admin adds the entry to agent/access/mcp-servers.ts by hand in a pull request.",
    );
  }
  if (!cfg.baseMcpServers) {
    throw new Error(
      "this deployment doesn't expose its declared MCP servers (AccessRequestsConfig.baseMcpServers), so a candidate entry can't be validated against them. " +
        "Refusing rather than opening a PR nobody validated; an admin can add the entry to agent/access/mcp-servers.ts by hand.",
    );
  }
  return cfg as EnabledMcpServerProposeConfig;
}

export function validateMcpServerProposal(declaration: McpServerDeclaration, declared: readonly McpServerDeclaration[]): void {
  const mounted: readonly string[] = CONTRIBUTIONS.contributions.filter((c) => c.kind === "connection").map((c) => c.name);
  if (mounted.includes(declaration.name)) {
    throw new Error(
      `a connection named "${declaration.name}" is already mounted by @open-everywhere/core, so \`oe build\` would refuse this entry. Pick another name (for example "${declaration.name}-mcp").`,
    );
  }
  defineMcpServers([...declared, declaration]);
}

export function mcpServerReachLine(d: McpServerDeclaration): string {
  return d.people === undefined
    ? "⚠ Reach: EVERY person who can DM the agent, an external account included (a Slack Connect user, a guest), each as themselves through their own sign-in. Add `people: { groups: [...] }` to the entry to narrow it."
    : `Reach: only the person-group(s) ${d.people.groups.map((g) => `\`${inlineForReview(g)}\``).join(", ")}, each person as themselves, in their own DM.`;
}

export function mcpServerSetupSteps(args: Pick<McpServerProposeArgs, "declaration" | "vendorSteps">): string[] {
  const steps = args.vendorSteps.map((s) => inlineForReview(s));
  const signIn = args.declaration.signIn;
  if (signIn?.mode === "static-confidential") {
    steps.push(`Register the redirect URI \`https://<this deployment's host>${OE_OAUTH_CALLBACK_PATH}\` on the vendor's OAuth client.`);
    steps.push(`After the merge, store the client secret with \`npx oe secret set ${inlineForReview(signIn.clientSecretRef)}\` in your own terminal. It never goes in this PR or in chat.`);
  }
  return steps;
}

export function mcpServerSentence(d: McpServerDeclaration): string {
  return `Declare MCP server "${inlineForReview(d.name)}" (${inlineForReview(new URL(d.url).hostname)})`;
}

function prBody(args: McpServerProposeArgs, decidedBy: string): string {
  const steps = mcpServerSetupSteps(args);
  return [
    `${mcpServerSentence(args.declaration)}: one entry in \`agent/access/mcp-servers.ts\`.`,
    "",
    "```json",
    JSON.stringify(args.declaration, null, 2),
    "```",
    "",
    "**Vendor documentation the agent used** — check the URL above against these:",
    ...args.docUrls.map((u) => `- ${inlineForReview(u)}`),
    "",
    `**${mcpServerReachLine(args.declaration)}**`,
    "",
    "**Steps a person does by hand:**",
    ...(steps.length > 0 ? steps.map((s) => `- ${s}`) : ["- None named: the server uses dynamic client registration, so there is no client to create."]),
    "",
    `Requested by \`${args.requestedBy}\` · sent by \`${decidedBy}\` · scope \`${args.scopeKey}\``,
    ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
    "",
    "---",
    "The agent researched this entry; the diff is the deterministic MCP-server codemod applied to the entry frozen on the request card.",
    "Merging declares the server; `oe build` then writes its connection. Closing this PR unmerged declines the request.",
    "See docs/extending/connectors.md#declare-an-mcp-server-in-your-app.",
  ].join("\n");
}

export async function executeMcpServerPropose(args: McpServerProposeArgs, decidedBy: string, deps: McpServerProposeExecuteDeps = {}): Promise<string> {
  const cfg = requireMcpServerProposeConfig(deps.config);
  const repo = cfg.configRepo;
  const base = cfg.configBase ?? "main";
  const path = cfg.mcpServersPath ?? "agent/access/mcp-servers.ts";
  const branch = `mcp-server/${args.requestId}`;
  if (!isSafeBranchName(branch)) throw new Error(`unsafe mcp-server branch name "${branch}"`);
  const sentence = mcpServerSentence(args.declaration);

  validateMcpServerProposal(args.declaration, cfg.baseMcpServers!());

  if (cfg.dryRun) {
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "mcp-server.propose.pr_opened",
      detail: { requestId: args.requestId, dryRun: true, server: args.declaration.name, sentence, repo, branch },
    });
    return `dry-run — would add the "${args.declaration.name}" entry to ${repo}:${path} on ${branch} and open a PR against ${base}; validation passed`;
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

  const existing = await contents.getFile(repo, path, branch, token);
  if (existing === null) throw new Error(`config repo ${repo} has no ${path} on ${branch} — this deployment's app declares no MCP server list to add to.`);
  const result = insertMcpServerEntry(existing.content, args.declaration);
  if (result.changed) {
    const committer = deps.committer ?? getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
    await contents.putFile(repo, path, result.text, `declare MCP server: ${args.declaration.name}`, branch, token, committer, existing.sha);
  }

  const pr = await openPr({ repo, head: branch, base, title: sentence, body: prBody(args, decidedBy), token });

  await appendAudit({
    ...whereFromScope(args.org, args.scopeKey),
    principalId: decidedBy,
    action: "mcp-server.propose.pr_opened",
    detail: { requestId: args.requestId, server: args.declaration.name, host: new URL(args.declaration.url).hostname, sentence, repo, branch, pr: pr.number, url: pr.url, updated: pr.updated, requestedBy: args.requestedBy },
  });

  const adminBody = new URLSearchParams();
  adminBody.set("channel", cfg.adminChannel);
  adminBody.set("text", `:electric_plug: MCP server request — ${sentence}.\nRequested by <@${args.requestedBy}> · sent by <@${decidedBy}>\nReview and merge to declare it: ${pr.url}`);
  const adminOk = (await post("chat.postMessage", adminBody.toString()))?.ok === true;

  const askingPlatform = platformOfScopeKey(args.scopeKey);
  if (askingPlatform) {
    await (deps.postThreadNote ?? postSurfaceText)(askingPlatform, {
      channelId: args.channelId,
      threadTs: args.threadTs,
      text: `MCP server request sent — PR ${pr.url} is with the admins. Nothing is set up until they merge it.`,
    });
  }

  return (
    `${pr.updated ? `updated PR #${pr.number}` : `opened PR #${pr.number}`} — ${pr.url}; an admin merges it in GitHub to declare the server` +
    (adminOk ? "" : " (admin-channel notification failed — flag it to an admin directly)")
  );
}

const mcpServerPropose: ActionKind<McpServerProposeArgs> = {
  kind: "mcp-server.propose",
  policy: "member",
  summarize(args) {
    const d = args.declaration;
    const s = d.signIn;
    const scopes = s?.scopes ?? [];
    return [
      `Open a PR adding MCP server "${inlineForReview(d.name)}" to agent/access/mcp-servers.ts`,
      `URL: ${inlineForReview(d.url)}`,
      `Description (future turns read it to decide when to call the server): "${inlineForReview(d.description)}"`,
      ...(s?.mode === "static-confidential"
        ? [
            "Sign-in: a static OAuth client the vendor issues",
            `Authorize endpoint: ${inlineForReview(s.authorizationEndpoint)}`,
            `Token endpoint (the client secret is sent here): ${inlineForReview(s.tokenEndpoint)}`,
            ...(s.revocationEndpoint !== undefined ? [`Revocation endpoint: ${inlineForReview(s.revocationEndpoint)}`] : []),
            `Client id: ${inlineForReview(s.clientId)} · secret REF: ${inlineForReview(s.clientSecretRef)} · body: ${s.bodyEncoding}`,
          ]
        : ["Sign-in: MCP OAuth discovery with dynamic client registration"]),
      `Scopes: ${scopes.length > 0 ? scopes.map((x) => inlineForReview(x)).join(", ") : "none sent"}`,
      `Sources: ${args.docUrls.map((u) => inlineForReview(u)).join(", ")}`,
      mcpServerReachLine(d),
      ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
      `Sending opens a bot-PR against \`${args.configRepo}\` for an admin to merge — nothing is set up until they do.`,
      `Requested by ${requesterWords(args.requestedBy, args.scopeKey)}`,
    ];
  },
  plainSummary(args) {
    return `Open a pull request on ${plainValue(args.configRepo)} that adds the MCP server ${plainValue(args.declaration.name)}, for an admin to merge`;
  },
  async execute(args, decidedBy) {
    return executeMcpServerPropose(args, decidedBy);
  },
};

registerActionKind(mcpServerPropose);
