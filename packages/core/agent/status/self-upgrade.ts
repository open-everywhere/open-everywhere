const CORE_PACKAGE = "@open-everywhere/core";

export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/@open-everywhere%2Fcore/latest";

const STATUS_ROUTE = "/eve/v1/oe/status";

const UPGRADE_SKILL = "upgrade-open-everywhere";

export function parseReleaseVersion(raw: string): readonly [number, number, number] | undefined {
  const m = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareReleaseVersions(a: string, b: string): number | undefined {
  const x = parseReleaseVersion(a);
  const y = parseReleaseVersion(b);
  if (x === undefined || y === undefined) return undefined;
  return x[0] !== y[0] ? x[0] - y[0] : x[1] !== y[1] ? x[1] - y[1] : x[2] - y[2];
}

export type LatestVersionReader = () => Promise<string | undefined>;

export async function readLatestPublishedVersion(fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<string | undefined> {
  try {
    const res = await fetchImpl(REGISTRY_LATEST_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown } | null;
    const version = typeof body?.version === "string" ? body.version.trim() : "";
    return parseReleaseVersion(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

export function selfUpgradeBranch(target: string): string {
  return `oe-upgrade/${target}`;
}

export interface SelfUpgradePlan {
  readonly from: string;
  readonly to: string;
  readonly repo: string;
  readonly base: string;
}

export function selfUpgradeSteps(plan: SelfUpgradePlan): string[] {
  const branch = selfUpgradeBranch(plan.to);
  return [
    `Call checkout_repo with repo "${plan.repo}". Work in the directory it returns. If it refuses because this room is not granted the repository, stop and tell the admin: an admin asks from a room whose bundle grants it.`,
    `Run \`git checkout -b ${branch}\`, then \`npm ci\`. The install needs registry.npmjs.org; if the sandbox cannot reach it, stop and tell the admin to grant the package registry hosts (PACKAGE_REGISTRY_HOSTS) on the bundle that grants "${plan.repo}".`,
    `Read the checkout's \`.claude/skills/${UPGRADE_SKILL}/SKILL.md\` and follow it (a repo skill becomes invocable only from your next turn, so read the file). If the repo has none, read node_modules/${CORE_PACKAGE}/UPGRADING.md and follow the same steps. Run \`npx oe upgrade --to ${plan.to} --plan\` first, then \`npx oe upgrade --to ${plan.to}\`. The admin's ask is the yes for that run: it writes only in this sandbox, and nothing ships before someone merges the pull request.`,
    `Every BREAKING, ENV, MANUAL and DEFAULT line the window prints is a decision for the admin. Do not decide it. Put each one in the pull request body and in your reply.`,
    `Read the \`roster.lock.json\` diff line by line and say every new tool, channel, schedule or connection in your own words. Never hand-edit that file.`,
    `Commit on ${branch}, then call open_pull_request with repo "${plan.repo}", head "${branch}" and base "${plan.base}". Never run \`git push\`: the checkout credential is read-only, and open_pull_request pushes on the approve click. The body carries what the skill's step 5 lists, starting with "${plan.from} → ${plan.to}".`,
    `Never merge the pull request. Tell the admin that the merge deploys, and that after the deploy you confirm it from the status route (${STATUS_ROUTE}): its version.core field must read ${plan.to}.`,
  ];
}

export function upgradeOfferText(input: { readonly installed: string; readonly latest: string; readonly repo?: string }): string {
  const where = input.repo ? ` on \`${input.repo}\`` : "";
  return [
    `A new release of \`${CORE_PACKAGE}\` is out: ${input.latest}. This deployment runs ${input.installed}.`,
    `An org admin can tell me "upgrade yourself", and I open the upgrade pull request${where}. Nothing changes until someone merges it.`,
    `I say this once for each release, unless I could not record that I said it.`,
  ].join("\n");
}
