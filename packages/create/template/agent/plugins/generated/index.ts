// The aggregate of every extracted plugin under agent/plugins/generated/. This app ships no
// plugin extractor: the Open Everywhere repository's `plugin:extract` script writes this file and
// one module per plugin beside it. Until you add one, it is empty. Import GENERATED_SKILL_CONTENT /
// GENERATED_PLUGIN_REGISTRY into skill-content.ts / registry.ts and spread them
// alongside any hand-authored entries (see those files' headers) — empty (no
// plugin extracted yet) is a valid, safe baseline: it contributes nothing.

import type { SkillPackageDefinition } from "eve/skills";
import type { PluginRegistry } from "@open-everywhere/core/agent/plugins/types.js";

export const GENERATED_SKILL_CONTENT: Record<string, SkillPackageDefinition> = {};

export const GENERATED_PLUGIN_REGISTRY: PluginRegistry = {};
