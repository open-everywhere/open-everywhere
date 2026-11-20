import type { NamedSkillDefinition } from "eve/skills";
import { loadEveInternalFunctions } from "./load.js";

/**
 * Deep read of `eve/dist/src/shared/skill-package.js`.
 *
 * No public entry exports eve's skill normalizer. eve calls `normalizeSkillPackage` on every entry
 * that a `defineDynamic` skill resolver returns, and on every compiled `defineSkill`. A package that
 * does not match eve's shape throws there, and the turn fails. The skill package test drives each
 * skill producer's output through this exact function, so a producer that drifts from eve's shape
 * fails that test before it fails a turn.
 */
export const EVE_SKILL_PACKAGE_FILE = "shared/skill-package.js";

const OWNER = "scripts/eve-deep-reads/skill-package.ts";

/** One file of a normalized package. `SKILL.md` is always one of them. */
export interface EveNormalizedSkillFile {
  readonly content: Buffer;
  readonly relativePath: string;
}

/** The subset of eve's normalized package that this repository reads. */
export interface EveNormalizedSkillPackage {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly files: readonly EveNormalizedSkillFile[];
}

export type NormalizeSkillPackage = (input: NamedSkillDefinition) => EveNormalizedSkillPackage;

/** Loads `normalizeSkillPackage`, the function eve runs on every skill package before a turn uses it. */
export async function loadNormalizeSkillPackage(root: string): Promise<NormalizeSkillPackage> {
  const { normalizeSkillPackage } = await loadEveInternalFunctions({
    root,
    file: EVE_SKILL_PACKAGE_FILE,
    names: ["normalizeSkillPackage"],
    owner: OWNER,
  });
  return normalizeSkillPackage as unknown as NormalizeSkillPackage;
}
