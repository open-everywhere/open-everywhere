import type { SkillPackageDefinition } from "eve/skills";
import { GENERATED_SKILL_CONTENT } from "./generated/index.js";
import { NOTION_REST_SKILL, NOTION_SCRIPT_SOURCE as NOTION_SCRIPT } from "./notion-rest.js";

export const SKILL_CONTENT: Record<string, SkillPackageDefinition> = {
  ...GENERATED_SKILL_CONTENT,

  "notion-rest": NOTION_REST_SKILL,
};

export const NOTION_SCRIPT_SOURCE = NOTION_SCRIPT;
