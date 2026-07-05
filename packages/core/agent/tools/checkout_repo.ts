import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolveAccessFor } from "../access/request.js";
import { compileNetworkPolicy } from "../access/egress.js";
import { resolveHeaders } from "../access/credentials.js";
import { isEnforced } from "../access/enforcement.js";
import { getGitHubApp, repoAllowed } from "../scm/provider.js";
import { READ_PERMISSIONS } from "../scm/mint.js";
import { mintGitReadBroker, mergeGitReadBroker } from "../scm/broker.js";
import { checkoutCommand, checkoutCommandBrokered, isSafeCheckoutDir, redactSecret, CHECKOUT_OK, parseConventionProbe, parseSkillsProbe, parseAgentsProbe } from "../scm/git.js";
import { recordRepoSkills, parseRepoAgent, REPO_SKILL_SEP, type RepoAgentDef } from "../scm/repo-skills.js";

export default defineTool({
  description:
    "Clone one of the allowed repositories (see list_repos) into your workspace so you can read and change its code. Only granted repos can be cloned. After it returns, work in the given directory with bash — branch, edit, commit — then call open_pull_request, which pushes your branch and opens the PR after human approval (the checkout credential is read-only; plain `git push` will be rejected). If the result flags a convention file (AGENTS.md or CLAUDE.md), READ it before changing code — it carries the repo's own rules. If the result lists skills or delegation personas shipped in the repo, those become invocable skills from your next turn.",
  inputSchema: z.object({
    repo: z.string().describe("owner/repo, exactly as shown by list_repos."),
    dir: z.string().optional().describe("workspace-relative checkout directory (default: the repo name)."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    dir: z.string(),
    message: z.string(),
    conventions: z
      .object({ file: z.string(), lines: z.number(), bytes: z.number() })
      .optional(),
    skills: z
      .object({ count: z.number(), names: z.array(z.string()), truncated: z.boolean() })
      .optional(),
    agents: z
      .object({ count: z.number(), names: z.array(z.string()), truncated: z.boolean() })
      .optional(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const access = resolveAccessFor(ctx);
    if (!repoAllowed(input.repo, access.repos)) {
      throw new Error(
        `repo "${input.repo}" is not granted to this channel. Allowed: ${access.repos.length ? access.repos.join(", ") : "(none)"}. ` +
          `Grant it via a bundle's repos (see agent/access/bundles.ts).`,
      );
    }

    const app = getGitHubApp();
    if (!app) {
      throw new Error("source control isn't configured (no GitHub App). Set OE_GITHUB_APP_* — see .env.example / docs/capabilities/source-control.md.");
    }

    const dir = input.dir ?? input.repo.split("/")[1];
    if (!isSafeCheckoutDir(dir)) {
      throw new Error(`invalid checkout dir "${dir}" — use a simple workspace-relative path.`);
    }
    const owner = input.repo.slice(0, input.repo.indexOf("/"));
    const noInstallationError = () =>
      new Error(
        `repo "${input.repo}": its owner has no linked GitHub App installation. ` +
          `Install the Open Everywhere GitHub App on that org (see docs/capabilities/source-control.md).`,
      );

    const sandbox = await ctx.getSandbox();
    let result: Awaited<ReturnType<typeof sandbox.run>>;

    if (isEnforced()) {
      const basePolicy = await compileNetworkPolicy(access, resolveHeaders);
      const { rulesByOwner } = await mintGitReadBroker(app, access.repos);
      if (!rulesByOwner.has(owner)) throw noInstallationError();
      await sandbox.setNetworkPolicy(mergeGitReadBroker(basePolicy, rulesByOwner));
      result = await sandbox.run({ command: checkoutCommandBrokered(input.repo, dir, app.committer()) });
      if (!result.stdout.includes(CHECKOUT_OK)) {
        throw new Error(`clone failed for "${input.repo}": ${(result.stderr || result.stdout || "unknown error").slice(0, 500)}`);
      }
    } else {
      const { tokens, ungranted } = await app.tokensForRepos([input.repo], READ_PERMISSIONS);
      if (ungranted.length) throw noInstallationError();
      const token = tokens.get(owner)!.token;
      result = await sandbox.run({ command: checkoutCommand(input.repo, token, dir, app.committer()) });
      if (!result.stdout.includes(CHECKOUT_OK)) {
        throw new Error(`clone failed for "${input.repo}": ${redactSecret(result.stderr || result.stdout || "unknown error", token).slice(0, 500)}`);
      }
    }

    const conventions = parseConventionProbe(result.stdout) ?? undefined;
    const conventionNote = conventions
      ? ` This repo has a ${conventions.file} (${conventions.lines} lines) at ${dir}/${conventions.file} — read it before changing code; it holds the repo's own rules.`
      : "";

    let skills: { count: number; names: string[]; truncated: boolean } | undefined;
    let agents: { count: number; names: string[]; truncated: boolean } | undefined;
    try {
      const skillsProbe = parseSkillsProbe(result.stdout);
      const agentsProbe = parseAgentsProbe(result.stdout);
      const agentDefs: Record<string, RepoAgentDef> = {};
      for (const [basename, content] of Object.entries(agentsProbe.agents)) {
        const def = parseRepoAgent(basename, content);
        agentDefs[def.name] = def;
      }
      const slug = recordRepoSkills(input.repo, skillsProbe.skills, agentDefs);
      if (slug) {
        const skillNames = Object.keys(skillsProbe.skills).map((name) => `${slug}${REPO_SKILL_SEP}${name}`);
        if (skillNames.length) skills = { count: skillNames.length, names: skillNames, truncated: skillsProbe.truncated };
        const agentNames = Object.keys(agentDefs).map((name) => `${slug}${REPO_SKILL_SEP}${name}`);
        if (agentNames.length) agents = { count: agentNames.length, names: agentNames, truncated: agentsProbe.truncated };
      }
    } catch (err) {
      console.warn(`[open-everywhere:repo-skills] failed to record skills/agents for ${input.repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const skillNote = skills
      ? ` This repo ships ${skills.count} skill(s)${skills.truncated ? " (list truncated)" : ""} — available to you from your next turn as: ${skills.names.join(", ")}.`
      : "";
    const agentNote = agents
      ? ` It also ships ${agents.count} delegation persona(s)${agents.truncated ? " (list truncated)" : ""} — from your next turn, each is a skill that explains how to consult it via the agent tool: ${agents.names.join(", ")}.`
      : "";

    return {
      ok: true,
      dir,
      conventions,
      skills,
      agents,
      message:
        `Cloned ${input.repo} into ${dir}/ (authored commits will be ${app.committer().name}). ` +
        `Branch and commit there, then open_pull_request — it pushes your branch and opens the PR after approval (plain git push is not authorized).${conventionNote}${skillNote}${agentNote}`,
    };
  },
});
