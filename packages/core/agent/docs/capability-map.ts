export const UNDOCUMENTED_TOOLS: Readonly<Record<string, string>> = {
  sandbox_tools:
    "resolver file, not a capability: re-provides the disabled framework sandbox tools per session grain (access/window-gated.ts windowGatedKit) and mounts nothing under this name. The six tools it re-provides are each documented under their own names.",
  delegation_tools:
    "resolver file, not a capability: re-provides the framework-named `agent` tool per session grain, mounting nothing under this name. `agent` itself is documented.",
  browser_tools:
    "resolver file, not a capability: mounts the flag-gated agent-browser family (access/browser-toolkit.ts) and nothing under this name. The injected `browser_*` tools it mounts are documented in docs/capabilities/browser-qa.md.",
  task_sleep:
    "not mounted: eve gates the `task_*` family on `experimental.tasks` (runtime/framework-tools/tasks.js, isTaskToolAvailable) and agent/agent.ts does not enable it, so no org can be granted this. Delete this row when the flag goes on (OPE-562).",
  task_update:
    "not mounted: eve gates the `task_*` family on `experimental.tasks` (runtime/framework-tools/tasks.js, isTaskToolAvailable) and agent/agent.ts does not enable it, so no org can be granted this. Delete this row when the flag goes on (OPE-562).",
};

const FENCE = /^```[\s\S]*?^```$/gmu;
const SPAN = /`([^`\n]+)`/gu;

export function docCodeSpans(markdown: string): readonly string[] {
  return [...new Set([...markdown.replace(FENCE, "").matchAll(SPAN)].map((m) => m[1].trim()))];
}

export interface CapabilityDocSource {
  readonly path: string;
  readonly spans: readonly string[];
}

export interface CapabilityDocsInput {
  readonly toolNames: readonly string[];
  readonly docs: readonly CapabilityDocSource[];
  readonly exempt?: Readonly<Record<string, string>>;
}

export interface CapabilityDocsReport {
  readonly problems: readonly string[];
  readonly coverage: ReadonlyMap<string, readonly string[]>;
  readonly documented: readonly string[];
  readonly exempted: readonly string[];
}

export function checkCapabilityDocs(input: CapabilityDocsInput): CapabilityDocsReport {
  const exempt = input.exempt ?? UNDOCUMENTED_TOOLS;
  const problems: string[] = [];
  const tools = new Set(input.toolNames);

  const coverage = new Map<string, readonly string[]>();
  for (const name of [...tools].sort()) {
    const hits = input.docs
      .filter((d) => d.spans.includes(name) || d.spans.includes(`${name}()`))
      .map((d) => d.path)
      .sort();
    if (hits.length > 0) coverage.set(name, hits);
  }

  for (const name of [...tools].sort()) {
    if (coverage.has(name)) continue;
    const why = exempt[name];
    if (why !== undefined) continue;
    problems.push(
      `tool "${name}" is mounted but NO doc names it — the manual we ship must describe every capability an org can be granted. Add \`${name}\` (as an inline code span, in prose, not inside a fenced block) to the docs/ page that covers it, then run \`npm run docs:generate\`. If it genuinely is not a capability, declare it in UNDOCUMENTED_TOOLS (packages/core/agent/docs/capability-map.ts) with the reason.`,
    );
  }

  for (const [name, why] of Object.entries(exempt).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!tools.has(name)) {
      problems.push(
        `UNDOCUMENTED_TOOLS exempts "${name}" but no such tool is mounted — a stale exemption hides a real gap the day the name comes back. Remove the row (capability-map.ts).`,
      );
      continue;
    }
    if (why.trim().length === 0) {
      problems.push(`UNDOCUMENTED_TOOLS exempts "${name}" with an empty reason — the reason IS the review; write it or drop the row.`);
    }
    if (coverage.has(name)) {
      problems.push(
        `UNDOCUMENTED_TOOLS exempts "${name}" but ${coverage.get(name)!.join(", ")} documents it — drop the exemption so the coverage is real rather than waived. (This is the guard that stops the table growing until nothing can fail.)`,
      );
    }
  }

  return {
    problems,
    coverage,
    documented: [...coverage.keys()].sort(),
    exempted: Object.keys(exempt).sort(),
  };
}
