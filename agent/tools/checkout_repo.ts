import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolveAccess } from "../access/resolver.js";
import { buildResolveRequest } from "../access/request.js";
import { loadBundles, loadBindings } from "../access/bundles.js";
import { getGitHubApp, repoAllowed } from "../scm/provider.js";
import { checkoutCommand, isSafeCheckoutDir, redactSecret, CHECKOUT_OK } from "../scm/git.js";

export default defineTool({
  description:
    "Clone one of the allowed repositories (see list_repos) into your workspace so you can read and change its code. Only granted repos can be cloned. After it returns, work in the given directory with bash — branch, edit, commit, push — then call open_pull_request.",
  inputSchema: z.object({
    repo: z.string().describe("owner/repo, exactly as shown by list_repos."),
    dir: z.string().optional().describe("workspace-relative checkout directory (default: the repo name)."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    dir: z.string(),
    message: z.string(),
  }),
  needsApproval: never(),
  async execute(input, ctx) {
    const access = resolveAccess(buildResolveRequest(ctx), loadBundles(), loadBindings());
    if (!repoAllowed(input.repo, access.repos)) {
      throw new Error(
        `repo "${input.repo}" is not granted to this channel. Allowed: ${access.repos.length ? access.repos.join(", ") : "(none)"}. ` +
          `Grant it via a bundle's repos (see agent/access/bundles.ts).`,
      );
    }

    const app = getGitHubApp();
    if (!app) {
      throw new Error("source control isn't configured (no GitHub App). Set OE_GITHUB_APP_* — see .env.example / docs/source-control-plane.md.");
    }

    const dir = input.dir ?? input.repo.split("/")[1];
    if (!isSafeCheckoutDir(dir)) {
      throw new Error(`invalid checkout dir "${dir}" — use a simple workspace-relative path.`);
    }

    const { tokens, ungranted } = await app.tokensForRepos([input.repo]);
    if (ungranted.length) {
      throw new Error(
        `repo "${input.repo}": its owner has no linked GitHub App installation. ` +
          `Install the Open Everywhere GitHub App on that org (see docs/source-control-plane.md).`,
      );
    }
    const owner = input.repo.slice(0, input.repo.indexOf("/"));
    const token = tokens.get(owner)!.token;

    const sandbox = await ctx.getSandbox();
    const result = await sandbox.run({ command: checkoutCommand(input.repo, token, dir, app.committer()) });
    if (!result.stdout.includes(CHECKOUT_OK)) {
      throw new Error(`clone failed for "${input.repo}": ${redactSecret(result.stderr || result.stdout || "unknown error", token).slice(0, 500)}`);
    }

    return {
      ok: true,
      dir,
      message: `Cloned ${input.repo} into ${dir}/ (authored commits will be ${app.committer().name}). Branch, commit, push there, then open_pull_request.`,
    };
  },
});
