export interface RepoCapabilitySpec {
  readonly summary: string;
}

const CAPABILITY_TABLE = {
  "pr-admin": {
    summary: "act on PULL REQUESTS as well as issues — close/reopen, assign and label a PR, and set PR metadata",
  },
  workflows: {
    summary: "push branches that add or change GitHub Actions workflow files under .github/workflows",
  },
} as const satisfies Readonly<Record<string, RepoCapabilitySpec>>;

export type RepoCapability = keyof typeof CAPABILITY_TABLE;

export const REPO_CAPABILITIES: Readonly<Record<RepoCapability, RepoCapabilitySpec>> = CAPABILITY_TABLE;

export const REPO_CAPABILITY_NAMES: readonly RepoCapability[] = (Object.keys(CAPABILITY_TABLE) as RepoCapability[]).sort();

export function isRepoCapability(value: string): value is RepoCapability {
  return Object.hasOwn(CAPABILITY_TABLE, value);
}

export function repoCapabilityProblems(where: string, capabilities: readonly string[] | undefined): string[] {
  if (capabilities === undefined) return [];
  if (!Array.isArray(capabilities)) {
    return [`  ${where} has a \`capabilities\` that is not an array — got ${JSON.stringify(capabilities)}`];
  }
  const known = REPO_CAPABILITY_NAMES.map((n) => JSON.stringify(n)).join(", ");
  if (capabilities.length === 0) {
    return [
      `  ${where} declares \`capabilities: []\` — an empty list expands nothing; write the repo as a bare string ("owner/repo") for the default job sets, or name a capability (${known})`,
    ];
  }
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const cap of capabilities) {
    if (typeof cap !== "string" || cap.trim() === "") {
      bad.push(`  ${where} declares an empty capability name — name one of ${known}`);
      continue;
    }
    if (!isRepoCapability(cap)) {
      bad.push(
        `  ${where} declares unknown capability ${JSON.stringify(cap)} — the implemented sets are ${known}. ` +
          `Capabilities are NAMES this deployment implements, never raw GitHub permission strings (e.g. "pull_requests: write" is not writable here).`,
      );
      continue;
    }
    if (seen.has(cap)) bad.push(`  ${where} declares capability ${JSON.stringify(cap)} more than once — remove the duplicate`);
    seen.add(cap);
  }
  return bad;
}

export function unionRepoCapabilities(a: readonly RepoCapability[], b: readonly RepoCapability[]): readonly RepoCapability[] {
  return [...new Set([...a, ...b])].sort();
}
