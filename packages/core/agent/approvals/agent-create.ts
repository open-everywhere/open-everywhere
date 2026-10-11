import { getConfig, type AccessRequestsConfig } from "../access/config.js";
import { assertBindingsValid, assertBundlesValid } from "../access/bundle.js";
import { assertChannelExclusivity, assertDomainsValid } from "../memory/domain.js";
import { assertSilosValid } from "../memory/silo.js";
import {
  agentBundleName,
  agentSiloName,
  applyAgentSpec,
  assertExposedAgentsCurated,
  emitAgentsModule,
  emptyAgentsFile,
  parseAgentsModule,
  type AgentSpec,
} from "../memory/agents-codemod.js";
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

export interface AgentCreateArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly requestId: string;
  readonly spec: AgentSpec;
  readonly requestedBy: string;
  readonly reason?: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly configRepo: string;
  readonly agentsPath: string;
}

export interface AgentCreateExecuteDeps {
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

export type EnabledAgentCreateConfig = AccessRequestsConfig & { readonly adminChannel: string; readonly configRepo: string };

export function requireAgentCreateConfig(override?: AccessRequestsConfig): EnabledAgentCreateConfig {
  const cfg = override ?? getConfig().loadAccessRequests?.();
  if (!cfg?.adminChannel || !cfg.configRepo) {
    throw new Error(
      "creating agents from chat isn't enabled on this deployment — an operator must configure the admin channel + config repo " +
        "(AppConfig.loadAccessRequests; env OE_ACCESS_ADMIN_CHANNEL / OE_ACCESS_CONFIG_REPO). Until then, an admin can add an agent by hand-editing config in a PR.",
    );
  }
  if (!cfg.baseAgents) {
    throw new Error(
      "this deployment doesn't expose its code-declared agents baseline (AccessRequestsConfig.baseAgents), so a candidate agents overlay can't be validated against the config it would merge alongside. Refusing rather than opening a PR nobody validated.",
    );
  }
  return cfg as EnabledAgentCreateConfig;
}

function agentMemoryClause(spec: AgentSpec): string {
  return spec.memory.kind === "new-readonly"
    ? `a new READ-ONLY \`${inlineForReview(spec.memory.provider)}\` silo (\`${inlineForReview(agentSiloName(spec))}\`)`
    : `the existing silo \`${inlineForReview(spec.memory.silo)}\``;
}

function agentSentence(spec: AgentSpec): string {
  const titled = spec.title ? ` (“${inlineForReview(spec.title)}”)` : "";
  const exposed = spec.exposed ? ", EXPOSED to a wider audience" : "";
  return `Create agent "${inlineForReview(spec.name)}"${titled} — reading ${agentMemoryClause(spec)}, bound to this channel${exposed}`;
}

function prBody(args: AgentCreateArgs, decidedBy: string): string {
  const s = args.spec;
  return [
    agentSentence(s) + ".",
    "",
    "This provisions, as ONE reviewable diff to the agents overlay:",
    `- a memory DOMAIN \`${inlineForReview(s.name)}\` whose roster is this channel;`,
    `- ${agentMemoryClause(s)};`,
    `- an access BUNDLE \`${inlineForReview(agentBundleName(s))}\`${s.connectors && s.connectors.length ? ` granting connector(s) ${s.connectors.map((c) => `\`${inlineForReview(c.name)}\` (as \`${inlineForReview(c.credential)}\`)`).join(", ")}` : " (no connectors)"}, bound to that domain.`,
    "",
    "```json",
    JSON.stringify(s, null, 2),
    "```",
    "",
    `Requested by \`${args.requestedBy}\` · sent by \`${decidedBy}\` · scope \`${args.scopeKey}\``,
    ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
    "",
    "---",
    "This diff was produced by the deterministic agents codemod from a frozen, validated AgentSpec — no model authored any",
    "part of it after the request card was posted. Merging this PR provisions the agent on the next deploy of the merged",
    "config. Closing it unmerged declines the request. See docs/capabilities/memory.md.",
  ].join("\n");
}

export async function executeAgentCreate(args: AgentCreateArgs, decidedBy: string, deps: AgentCreateExecuteDeps = {}): Promise<string> {
  const cfg = requireAgentCreateConfig(deps.config);
  const repo = cfg.configRepo;
  const base = cfg.configBase ?? "main";
  const agentsPath = cfg.agentsPath ?? "agent/memory/config/agents.generated.ts";
  const branch = `agent-create/${args.requestId}`;
  if (!isSafeBranchName(branch)) {
    throw new Error(`unsafe agent-create branch name "${branch}"`);
  }
  const sentence = agentSentence(args.spec);
  const baseAgents = cfg.baseAgents!();
  const baseDomains = cfg.baseDomains?.() ?? [];
  const baseSilos = cfg.baseSilos?.() ?? [];

  const validateMerged = (overlayText: string): ReturnType<typeof applyAgentSpec> => {
    const overlay = overlayText ? parseAgentsModule(overlayText) : emptyAgentsFile();
    const result = applyAgentSpec(overlay, args.spec);
    const mergedDomains = [...baseDomains, ...baseAgents.domains, ...result.file.domains];
    const mergedSilos = [...baseSilos, ...baseAgents.silos, ...result.file.silos];
    const mergedSpecs = [...baseAgents.specs, ...result.file.specs];
    assertChannelExclusivity(mergedDomains);
    assertDomainsValid(mergedDomains);
    assertSilosValid(mergedSilos);
    assertExposedAgentsCurated(mergedDomains, mergedSilos, mergedSpecs);
    const mergedBundles = [...cfg.baseBundles(), ...baseAgents.bundles, ...result.file.bundles];
    assertBundlesValid(mergedBundles);
    assertBindingsValid([...cfg.baseBindings(), ...baseAgents.bindings, ...result.file.bindings], mergedBundles, cfg.groupRegistry?.());
    return result;
  };

  if (cfg.dryRun) {
    validateMerged("");
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "agent.create.pr_opened",
      detail: { requestId: args.requestId, dryRun: true, agent: args.spec.name, sentence, repo, branch },
    });
    return `dry-run — would commit agent "${args.spec.name}" to ${repo}#${branch} and open a PR against ${base}; validation passed`;
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

  const existing = await contents.getFile(repo, agentsPath, branch, token);
  const result = validateMerged(existing?.content ?? "");

  if (result.changed) {
    const committer = deps.committer ?? getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
    await contents.putFile(repo, agentsPath, emitAgentsModule(result.file), `create agent: ${args.spec.name}`, branch, token, committer, existing?.sha);
  }

  const pr = await openPr({
    repo,
    head: branch,
    base,
    title: sentence,
    body: prBody(args, decidedBy),
    token,
  });

  await appendAudit({
    ...whereFromScope(args.org, args.scopeKey),
    principalId: decidedBy,
    action: "agent.create.pr_opened",
    detail: {
      requestId: args.requestId,
      agent: args.spec.name,
      sentence,
      repo,
      branch,
      pr: pr.number,
      url: pr.url,
      updated: pr.updated,
      requestedBy: args.requestedBy,
    },
  });
  emitTelemetry("oe.feature.used", { "oe.feature": "agent_created", "oe.outcome": "ok" });

  const adminBody = new URLSearchParams();
  adminBody.set("channel", cfg.adminChannel);
  adminBody.set(
    "text",
    `:robot_face: New agent — ${sentence}.\nRequested by <@${args.requestedBy}> · sent by <@${decidedBy}>` +
      `${args.reason ? ` · reason: ${inlineForReview(args.reason)}` : ""}\nReview and merge to provision it: ${pr.url}`,
  );
  const adminRes = await post("chat.postMessage", adminBody.toString());
  const adminOk = adminRes?.ok === true;

  const askingPlatform = platformOfScopeKey(args.scopeKey);
  if (askingPlatform) {
    const threadNote = deps.postThreadNote ?? postSurfaceText;
    await threadNote(askingPlatform, {
      channelId: args.channelId,
      threadTs: args.threadTs,
      text: `Agent request sent — PR ${pr.url} is with the admins. Merging it provisions agent "${args.spec.name}" for this channel.`,
    });
  }

  return (
    `${pr.updated ? `updated PR #${pr.number}` : `opened PR #${pr.number}`} — ${pr.url}; an admin merges it in GitHub to provision the agent` +
    (adminOk ? "" : " (admin-channel notification failed — flag it to an admin directly)")
  );
}

const agentCreate: ActionKind<AgentCreateArgs> = {
  kind: "agent.create",
  policy: "member",
  plainSummary(args) {
    return `Open a pull request that creates a new agent, ${plainValue(args.spec.name)}, for an admin to review`;
  },
  summarize(args) {
    const s = args.spec;
    return [
      `Open a PR provisioning a new agent — ${agentSentence(s)}`,
      `Memory: ${agentMemoryClause(s)}.`,
      `Capabilities: bundle \`${inlineForReview(agentBundleName(s))}\`${s.connectors && s.connectors.length ? ` — connector(s) ${s.connectors.map((c) => `\`${inlineForReview(c.name)}\` (as \`${inlineForReview(c.credential)}\`)`).join(", ")}` : " — no connectors"}.`,
      ...(s.instructions ? [`Standing instructions: "${inlineForReview(s.instructions)}"`] : []),
      ...(s.exposed ? ["⚠ EXPOSED — reachable by a wider, less-trusted audience; it may only read a curated read-only silo."] : []),
      ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
      `Sending opens a bot-PR against \`${args.configRepo}\` for an admin to merge — nothing is provisioned until they do.`,
      `Requested by ${args.requestedBy}`,
    ];
  },
  async execute(args, decidedBy) {
    return executeAgentCreate(args, decidedBy);
  },
};

registerActionKind(agentCreate);
