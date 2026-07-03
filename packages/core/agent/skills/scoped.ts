import { defineDynamic, defineSkill } from "eve/skills";
import { resolveAccessFor } from "../access/request.js";
import { getConfig } from "../access/config.js";
import { repoSkillPackages } from "../scm/repo-skills.js";
import type { BindableContext } from "../identity/binding.js";

function granted(ctx: BindableContext) {
  const access = resolveAccessFor(ctx);
  const skillContent = getConfig().skillContent;
  const out: Record<string, ReturnType<typeof defineSkill>> = {};
  for (const name of access.skills) {
    const content = skillContent[name];
    if (content) out[name] = defineSkill(content);
  }
  for (const [name, pkg] of Object.entries(repoSkillPackages(new Set(access.skills)))) {
    out[name] = defineSkill(pkg);
  }
  return out;
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => granted(ctx),
    "turn.started": (_event, ctx) => granted(ctx),
  },
});
