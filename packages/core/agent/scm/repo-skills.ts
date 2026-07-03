import { defineState } from "eve/context";
import type { SkillPackageDefinition } from "eve/skills";
import { parseFrontmatter, slugify } from "../plugins/extract.js";

export const REPO_SKILL_SEP = "--";

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isSafeSkillName(name: string): boolean {
  return SAFE_SKILL_NAME.test(name) && !name.includes("..");
}

export interface RepoSkillsEntry {
  repo: string;
  skills: Record<string, string>;
}

export const repoSkillsState = defineState<Record<string, RepoSkillsEntry>>(
  "open-everywhere.repo-skills",
  () => ({}),
);

export function repoSlug(repo: string, state: Record<string, RepoSkillsEntry>): string {
  const slash = repo.indexOf("/");
  const owner = slash >= 0 ? repo.slice(0, slash) : "";
  const short = slugify(slash >= 0 ? repo.slice(slash + 1) : repo);
  const holder = state[short];
  if (!holder || holder.repo === repo) return short;
  return `${slugify(owner)}${REPO_SKILL_SEP}${short}`;
}

export function recordRepoSkills(repo: string, skills: Record<string, string>): string | null {
  const state = repoSkillsState.get();
  const next: Record<string, RepoSkillsEntry> = {};
  for (const [slug, entry] of Object.entries(state)) if (entry.repo !== repo) next[slug] = entry;
  let slug: string | null = null;
  if (Object.keys(skills).length > 0) {
    slug = repoSlug(repo, next);
    next[slug] = { repo, skills };
  }
  repoSkillsState.update(() => next);
  return slug;
}

export function mergeRepoSkills(
  state: Record<string, RepoSkillsEntry>,
  grantedNames: ReadonlySet<string>,
  warn: (msg: string) => void = (msg) => console.warn(`[open-everywhere:repo-skills] ${msg}`),
): Record<string, SkillPackageDefinition> {
  const out: Record<string, SkillPackageDefinition> = {};
  for (const [slug, entry] of Object.entries(state)) {
    for (const [name, markdown] of Object.entries(entry.skills)) {
      const full = `${slug}${REPO_SKILL_SEP}${name}`;
      if (!slug || !isSafeSkillName(name) || !isSafeSkillName(full)) {
        warn(`repo skill "${full}" from ${entry.repo} has an unsafe name — dropped`);
        continue;
      }
      if (grantedNames.has(full)) {
        warn(`repo skill "${full}" from ${entry.repo} collides with a granted skill — granted wins, repo skill dropped`);
        continue;
      }
      const desc = parseFrontmatter(markdown).data.description;
      out[full] = {
        description:
          typeof desc === "string" && desc ? desc : `Skill "${name}" shipped in the ${entry.repo} repo.`,
        markdown,
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
