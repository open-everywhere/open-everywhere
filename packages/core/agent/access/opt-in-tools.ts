export const OPT_IN_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  search_slack_public:
    "searches every public Slack channel of the workspace, including channels outside the caller's domain and channels the bot is not in. That crosses the domain read fence read_channel holds, so an admin decides where it is on (OPE-2678).",
});

const OPT_IN_TOOL_NAMES: readonly string[] = Object.keys(OPT_IN_TOOLS).sort();

export function optInToolProblems(bundleName: string, tools: readonly string[] | undefined): string[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) return [`  bundle "${bundleName}" has an \`optInTools\` that is not an array — got ${JSON.stringify(tools)}`];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const name of tools) {
    if (typeof name !== "string" || !Object.hasOwn(OPT_IN_TOOLS, name)) {
      problems.push(
        `  bundle "${bundleName}" optInTools names unknown tool ${JSON.stringify(name)} — the opt-in tools are ${OPT_IN_TOOL_NAMES.map((n) => JSON.stringify(n)).join(", ")}`,
      );
      continue;
    }
    if (seen.has(name)) problems.push(`  bundle "${bundleName}" optInTools lists "${name}" more than once — remove the duplicate`);
    seen.add(name);
  }
  return problems;
}
