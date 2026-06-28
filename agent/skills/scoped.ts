import { defineDynamic, defineSkill } from "eve/skills";
import { loadBindings, loadBundles } from "../access/bundles.js";
import { resolveAccess } from "../access/resolver.js";
import { buildResolveRequest } from "../access/request.js";
import { SKILL_CONTENT } from "../plugins/skill-content.js";

function granted(ctx: Parameters<typeof buildResolveRequest>[0]) {
  const access = resolveAccess(buildResolveRequest(ctx), loadBundles(), loadBindings());
  const out: Record<string, ReturnType<typeof defineSkill>> = {};
  for (const name of access.skills) {
    const content = SKILL_CONTENT[name];
    if (content) out[name] = defineSkill(content);
  }
  return out;
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => granted(ctx),
    "turn.started": (_event, ctx) => granted(ctx),
  },
});
