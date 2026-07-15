export interface SourceToolFile {
  readonly name: string;
  readonly source: string;
}

export const SOURCE_SCOPED_TOOLS: Readonly<Record<string, string>> = {
  read_slack_channel: "slack",
  read_slack_thread: "slack",
  read_notion_page: "notion",
};

const PLATFORM_SLUGS = ["slack", "notion", "github", "linear", "discord", "teams", "telegram"];

function armsOnUnifiedPerSurface(source: string): boolean {
  if (!source.includes("isUnifiedWindowContext")) return false;
  const compound = new RegExp(
    `!\\s*isUnifiedWindowContext\\([^)]*\\)\\s*&&\\s*channelPlatform\\([^)]*\\)\\s*!==\\s*"(?:${PLATFORM_SLUGS.join("|")})"`,
    "u",
  );
  return compound.test(source) && /return null/u.test(source);
}

function gatesOnSources(source: string, platform: string): boolean {
  return new RegExp(`sourceScopedMount\\([^;]*"${platform}"`, "u").test(source);
}

export function checkSourceGate(tools: readonly SourceToolFile[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const declaredPlatform = SOURCE_SCOPED_TOOLS[tool.name];
    if (declaredPlatform !== undefined) {
      seen.add(tool.name);
      if (!gatesOnSources(tool.source, declaredPlatform)) {
        problems.push(
          `per-surface tool "${tool.name}" must gate its mount via sourceScopedMount(ctx, "${declaredPlatform}", () => getConfig().loadDomains()) — the uniform X ∈ sources rule (§A5); no such call found`,
        );
      }
      if (armsOnUnifiedPerSurface(tool.source)) {
        problems.push(
          `per-surface tool "${tool.name}" still carries the ad-hoc "arm on any unified window" guard (!isUnifiedWindowContext && channelPlatform !== "…") — replace it with sourceScopedMount, don't keep both`,
        );
      }
      continue;
    }
    if (armsOnUnifiedPerSurface(tool.source)) {
      problems.push(
        `tool "${tool.name}" carries the per-surface "arm on any unified window" mount signature but is NOT declared in SOURCE_SCOPED_TOOLS — classify it there and gate its mount via sourceScopedMount (a per-surface tool may not blanket-mount on a unified window; §A5)`,
      );
    }
  }

  for (const name of Object.keys(SOURCE_SCOPED_TOOLS)) {
    if (!seen.has(name)) {
      problems.push(`SOURCE_SCOPED_TOOLS names "${name}" but no such tool file was scanned (stale row — remove it or restore the tool)`);
    }
  }

  return problems;
}
