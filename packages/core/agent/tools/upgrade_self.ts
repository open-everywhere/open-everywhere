import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { PersonFacingError } from "../channels/person-text.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { requireOrgAdmin, resolveRole } from "../access/roles.js";
import { getConfig } from "../access/config.js";
import { resolvePartition } from "../memory/partition.js";
import { appendAudit } from "../audit/audit.js";
import { corePackageVersion } from "../ops/package-info.js";
import { compareReleaseVersions, parseReleaseVersion, readLatestPublishedVersion, selfUpgradeBranch, selfUpgradeSteps, type LatestVersionReader } from "../status/self-upgrade.js";

export const UPGRADE_SELF_STARTED = "upgrade.self.started";
export const UPGRADE_SELF_REFUSED = "upgrade.self.refused";

export const NOT_AN_ADMIN_TEXT = 'Only an org admin can upgrade me, and you are not one. Ask an org admin to tell me "upgrade yourself".';

export interface UpgradeSelfDeps {
  readonly latest?: LatestVersionReader;
  readonly installed?: () => string;
}

export interface UpgradeSelfResult {
  readonly status: "ready" | "current";
  readonly from: string;
  readonly to: string;
  readonly repo: string;
  readonly base: string;
  readonly branch?: string;
  readonly steps: string[];
  readonly message: string;
}

export async function runUpgradeSelf(input: { readonly to?: string }, ctx: BindableContext, deps: UpgradeSelfDeps = {}): Promise<UpgradeSelfResult> {
  const binding = bindFrom(ctx);
  const p = resolvePartition(ctx);
  const where = { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface };
  let principalId: string | undefined;
  try {
    principalId = requireOrgAdmin(ctx).principalId;
  } catch {
    const role = resolveRole(ctx);
    const unverified = role.unverified;
    const asker = role.principalId;
    await appendAudit({
      ...where,
      ...(asker ? { principalId: asker } : {}),
      action: UPGRADE_SELF_REFUSED,
      detail: { reason: unverified === undefined ? "not-org-admin" : "unverified-asker", ...(binding.principalId && binding.principalId !== asker ? { boundPrincipal: binding.principalId } : {}) },
    });
    throw new PersonFacingError(unverified ?? NOT_AN_ADMIN_TEXT);
  }

  const cfg = getConfig().loadAccessRequests?.() ?? undefined;
  const repo = cfg?.configRepo;
  if (!repo) {
    await appendAudit({ ...where, ...(principalId ? { principalId } : {}), action: UPGRADE_SELF_REFUSED, detail: { reason: "no-config-repo" } });
    throw new PersonFacingError(
      "I cannot upgrade myself here: this deployment names no repository of its own. An operator sets `accessRequests.configRepo` in agent/settings/settings.ts to the deployment's repo.",
    );
  }
  const base = cfg.configBase ?? "main";

  const refuse = async (reason: string, message: string, versions?: { readonly from: string; readonly to: string }): Promise<never> => {
    await appendAudit({
      ...where,
      ...(principalId ? { principalId } : {}),
      action: UPGRADE_SELF_REFUSED,
      detail: { reason, ...(versions ? { from: versions.from, to: versions.to } : {}) },
    });
    throw new PersonFacingError(message);
  };

  const from = (deps.installed ?? corePackageVersion)();
  let to: string;
  if (input.to !== undefined) {
    const asked = input.to.trim().replace(/^v/u, "");
    if (parseReleaseVersion(asked) === undefined) await refuse("bad-target", `"${input.to}" is not a release version. Give it as X.Y.Z, for example 0.9.2.`);
    to = asked;
  } else {
    const latest = await (deps.latest ?? (() => readLatestPublishedVersion()))();
    if (latest === undefined) {
      return await refuse("registry-unreadable", "I could not read the newest release from the npm registry. Try again later, or name the version: \"upgrade yourself to 0.9.2\".");
    }
    to = latest;
  }

  const order = compareReleaseVersions(to, from);
  if (order === undefined) {
    await refuse("installed-unknown", `I run ${from}, which is not a release version, so I cannot tell whether ${to} is newer. An operator upgrades this build by hand.`, { from, to });
  }
  if (order! < 0) {
    await refuse("older-target", `I run ${from}, and ${to} is older. An upgrade only moves forward. A rollback is a revert of the upgrade pull request.`, { from, to });
  }
  if (order === 0) {
    return { status: "current", from, to, repo, base, steps: [], message: `I already run ${from}, the release you asked for. There is nothing to upgrade.` };
  }

  const branch = selfUpgradeBranch(to);
  await appendAudit({ ...where, ...(principalId ? { principalId } : {}), action: UPGRADE_SELF_STARTED, detail: { from, to, repo, base, branch } });
  return {
    status: "ready",
    from,
    to,
    repo,
    base,
    branch,
    steps: selfUpgradeSteps({ from, to, repo, base }),
    message: `Upgrade ${from} → ${to}: follow the steps in order. The result is a pull request on ${repo}. The merge deploys it, and I never merge.`,
  };
}

export default defineTool({
  description:
    'Upgrade this deployment to a newer release, for an ORG ADMIN only: use it when an admin says "upgrade yourself", "update yourself" or "take the new release". It checks the asker\'s org-admin standing (anyone else is refused), picks the target (the newest published release, or the version the admin named), records the start in the audit log, and returns the steps: clone the deployment\'s own repository, run its `upgrade-open-everywhere` skill (`npx oe upgrade`) in your sandbox, and open the upgrade pull request with open_pull_request. Follow the steps in order. It changes nothing itself, and you never merge: the merge deploys.',
  inputSchema: z.object({
    to: z.string().optional().describe("The release to upgrade to, as X.Y.Z. Omit it for the newest published release."),
  }),
  outputSchema: z.object({
    status: z.enum(["ready", "current"]).describe('"ready": follow the steps. "current": this deployment already runs the target; say so and stop.'),
    from: z.string().describe("The release this deployment runs now."),
    to: z.string().describe("The target release."),
    repo: z.string().describe("The deployment's own repository, owner/name."),
    base: z.string().describe("The branch the pull request merges into."),
    branch: z.string().optional().describe("The branch to commit the upgrade on. Present when status is ready."),
    steps: z.array(z.string()).describe("The steps, in order. Empty when status is current."),
    message: z.string().describe("One sentence to tell the admin."),
  }),
  approval: never(),
  async execute(input, ctx) {
    const result = await runUpgradeSelf(input, ctx as BindableContext);
    return { ...result, steps: [...result.steps] };
  },
});
