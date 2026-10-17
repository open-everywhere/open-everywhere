import { defineState } from "eve/context";
import type { SkillPackageDefinition } from "eve/skills";
import { parseFrontmatter, slugify } from "../plugins/extract.js";

export const REPO_SKILL_SEP = "--";

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isSafeSkillName(name: string): boolean {
  return SAFE_SKILL_NAME.test(name) && !name.includes("..");
}

export interface RepoAgentDef {
  name: string;
  description: string;
  body: string;
  model?: string;
  tools?: string[];
}

export interface RepoSkillsEntry {
  repo: string;
  skills: Record<string, string>;
  agents?: Record<string, RepoAgentDef>;
}

const repoSkillsState = defineState<Record<string, RepoSkillsEntry>>(
  "open-everywhere.repo-skills",
  () => ({}),
);

export function parseRepoAgent(basename: string, content: string): RepoAgentDef {
  const { data, body } = parseFrontmatter(content);
  const rawName = typeof data.name === "string" && data.name ? data.name : basename;
  const name = isSafeSkillName(rawName) ? rawName : slugify(rawName) || basename;
  const tools = Array.isArray(data.tools) ? data.tools : typeof data.tools === "string" && data.tools ? data.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  return {
    name,
    description: typeof data.description === "string" ? data.description : "",
    body: body.trim(),
    model: typeof data.model === "string" && data.model ? data.model : undefined,
    tools,
  };
}

export function repoSlug(repo: string, state: Record<string, RepoSkillsEntry>): string {
  const slash = repo.indexOf("/");
  const owner = slash >= 0 ? repo.slice(0, slash) : "";
  const short = slugify(slash >= 0 ? repo.slice(slash + 1) : repo);
  const holder = state[short];
  if (!holder || holder.repo === repo) return short;
  return `${slugify(owner)}${REPO_SKILL_SEP}${short}`;
}

export function recordRepoSkills(
  repo: string,
  skills: Record<string, string>,
  agents: Record<string, RepoAgentDef> = {},
): string | null {
  const state = repoSkillsState.get();
  const next: Record<string, RepoSkillsEntry> = {};
  for (const [slug, entry] of Object.entries(state)) if (entry.repo !== repo) next[slug] = entry;
  let slug: string | null = null;
  if (Object.keys(skills).length > 0 || Object.keys(agents).length > 0) {
    slug = repoSlug(repo, next);
    next[slug] = { repo, skills, agents };
  }
  repoSkillsState.update(() => next);
  return slug;
}

export function delegationHeader(repo: string): string {
  return (
    `This is a delegation persona shipped by the ${repo} repository. To consult it, ` +
    "call the `agent` tool: the message must START with the persona below (verbatim), " +
    "then a blank line, then the concrete task + all context the child needs (it sees " +
    "none of this conversation). The child is a copy of you — treat the persona's tool " +
    "restrictions (e.g. read-only) as binding instructions to pass along, though they " +
    "are enforced by instruction, not by the harness."
  );
}

export function mergeRepoSkills(
  state: Record<string, RepoSkillsEntry>,
  grantedNames: ReadonlySet<string>,
  warn: (msg: string) => void = (msg) => console.warn(`[open-everywhere:repo-skills] ${msg}`),
): Record<string, SkillPackageDefinition> {
  const out: Record<string, SkillPackageDefinition> = {};
  const claim = (slug: string, name: string, repo: string, kind: string): string | null => {
    const full = `${slug}${REPO_SKILL_SEP}${name}`;
    if (!slug || !isSafeSkillName(name) || !isSafeSkillName(full)) {
      warn(`repo ${kind} "${full}" from ${repo} has an unsafe name — dropped`);
      return null;
    }
    if (grantedNames.has(full)) {
      warn(`repo ${kind} "${full}" from ${repo} collides with a granted skill — granted wins, repo ${kind} dropped`);
      return null;
    }
    if (full in out) {
      warn(`repo ${kind} "${full}" from ${repo} collides with a repo skill of the same name — the skill wins, ${kind} dropped`);
      return null;
    }
    return full;
  };
  for (const [slug, entry] of Object.entries(state)) {
    for (const [name, markdown] of Object.entries(entry.skills)) {
      const full = claim(slug, name, entry.repo, "skill");
      if (!full) continue;
      const desc = parseFrontmatter(markdown).data.description;
      out[full] = {
        description:
          typeof desc === "string" && desc ? desc : `Skill "${name}" shipped in the ${entry.repo} repo.`,
        markdown,
      };
    }
    for (const agent of Object.values(entry.agents ?? {})) {
      const full = claim(slug, agent.name, entry.repo, "agent");
      if (!full) continue;
      out[full] = {
        description: agent.description || `Delegation persona "${agent.name}" shipped in the ${entry.repo} repo.`,
        markdown: `${delegationHeader(entry.repo)}\n\n${agent.body}\n`,
      };
    }
  }
  return out;
}

export function repoSkillPackages(grantedNames: ReadonlySet<string>): Record<string, SkillPackageDefinition> {
  try {
    return mergeRepoSkills(repoSkillsState.get(), grantedNames);
  } catch {
    return {};
  }
}
