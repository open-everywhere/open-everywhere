import type { SkillPackageDefinition } from "eve/skills";
import { GENERATED_SKILL_CONTENT } from "./generated/index.js";

export const SKILL_CONTENT: Record<string, SkillPackageDefinition> = {
  ...GENERATED_SKILL_CONTENT,
};
