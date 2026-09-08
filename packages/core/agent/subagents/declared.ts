export interface DeclaredSubagentSource {
  readonly name: string;
  readonly agentSource: string | undefined;
  readonly hasInstructions: boolean;
  readonly toolFiles: ReadonlyMap<string, string>;
  readonly hookFiles: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
}

const SUBAGENT_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const SUPPORTED_SUBAGENT_DIRS = new Set(["tools", "skills", "hooks", "connections", "sandbox", "lib", "subagents"]);

export function listDeclaredSubagents(subagents: readonly DeclaredSubagentSource[]): string[] {
  return subagents.map((s) => s.name).sort();
}

export function checkDeclaredSubagents(
  subagents: readonly DeclaredSubagentSource[],
  frameworkToolNames: readonly string[],
  toolNames: readonly string[],
  requiredFrameworkToolNames: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  const tools = new Set(toolNames);
  const required = new Set(requiredFrameworkToolNames);

  const mounted = new Set(frameworkToolNames);
  for (const name of [...required].sort()) {
    if (!mounted.has(name)) {
      problems.push(
        `"${name}" is declared a REQUIRED framework tool slot but is not in the default-mounted set — one of the two reads of the installed eve is stale, and until that is resolved this lint cannot say whether the slot takes a replacement tool or a disableTool() sentinel`,
      );
    }
  }

  for (const s of subagents) {
    const at = `agent/subagents/${s.name}`;

    if (!SUBAGENT_NAME_RE.test(s.name)) {
      problems.push(
        `subagent directory "${s.name}" is not lower snake_case — the directory name IS the model-visible tool name and shares one namespace with agent/tools/*; rename it to match (e.g. fresh_eyes_review)`,
      );
    }
    if (tools.has(s.name)) {
      problems.push(
        `subagent "${s.name}" collides with the tool of the same name — eve rejects the build rather than picking a winner (subagents.mdx); rename one`,
      );
    }

    if (s.agentSource === undefined) {
      problems.push(`${at}/agent.ts is missing — every declared subagent needs a defineAgent() config module (eve fails the build without one)`);
    } else {
      if (!/\bdescription\s*:/u.test(s.agentSource)) {
        problems.push(`${at}/agent.ts has no \`description\` — it is the tool description the parent reads to decide whether to delegate, and eve rejects the build without it`);
      }
      if (!/\boutputSchema\s*:/u.test(s.agentSource)) {
        problems.push(
          `${at}/agent.ts has no \`outputSchema\` — a declared subagent must return a TYPED result (eve applies the authored schema in task mode when the caller passes none); declare it in packages/core/agent/subagents/contracts.ts and bind it here`,
        );
      }
    }

    if (!s.hasInstructions) {
      problems.push(`${at}/instructions.md is missing — a subagent inherits NO instructions from the root (eve's isolation boundary), so without its own file it runs on the framework default prompt`);
    }

    for (const fw of frameworkToolNames) {
      const src = s.toolFiles.get(fw);
      const isRequired = required.has(fw);
      const fill = isRequired
        ? "Author a no-op replacement tool that reaches nothing — eve REQUIRES this slot and refuses `disableTool()` for it."
        : "Add `export default disableTool();`";
      if (src === undefined) {
        problems.push(
          `${at}/tools/${fw}.ts is missing — an absent slot falls back to eve's FRAMEWORK default, not to the root's narrowed version, and the root's egress/spend hooks are not inherited either, so ${fw} would mount UNFENCED here. ${fill}`,
        );
        continue;
      }
      const isSentinel = /^\s*export\s+default\s+disableTool\s*\(\s*\)\s*;?\s*$/mu.test(src);
      if (isRequired && isSentinel) {
        problems.push(
          `${at}/tools/${fw}.ts is a \`disableTool()\` sentinel, but eve declares "${fw}" a REQUIRED framework tool slot and throws at build on a sentinel for it. Export a no-op replacement tool from this file instead — one that reaches nothing, so the slot is filled and the subagent still holds no hands. Deleting the file is NOT the fix: it re-mounts eve's framework default unfenced.`,
        );
      } else if (!isRequired && !isSentinel) {
        problems.push(
          `${at}/tools/${fw}.ts is not a \`disableTool()\` sentinel — a declared subagent is a zero-hands reasoning pass; giving it a real tool is a posture change that must also move its rows in access/consequence.ts and access/window-gate-manifest.ts`,
        );
      }
    }
    for (const authored of s.toolFiles.keys()) {
      if (!frameworkToolNames.includes(authored)) {
        problems.push(
          `${at}/tools/${authored}.ts is an authored tool — declared subagents are zero-hands by convention (a subagent session carries no surface binding, so any tool there must invent or trust a scope). If this is deliberate, re-tier "${s.name}" in access/consequence.ts and give it a grain matrix in access/window-gate-manifest.ts first, then update this lint.`,
        );
      }
    }

    if (!s.hookFiles.has("spend")) {
      problems.push(
        `${at}/hooks/spend.ts is missing — hooks are NOT inherited from the root, so a delegated child's model calls would never reach OE's ledger or the monthly cap. Add \`export { default } from "@open-everywhere/core/agent/hooks/spend.js";\``,
      );
    }

    for (const dir of s.directories) {
      if (dir === "schedules") {
        problems.push(`${at}/schedules/ is not supported — schedules are root-only and eve fails the build for a subagent that declares them`);
      } else if (!SUPPORTED_SUBAGENT_DIRS.has(dir)) {
        problems.push(`${at}/${dir}/ is not a slot eve discovers inside a subagent package — it will be ignored with a diagnostic; remove it or move it under one of: ${[...SUPPORTED_SUBAGENT_DIRS].sort().join(", ")}`);
      }
    }
  }

  return problems;
}
