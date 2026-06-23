import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadBundles } from "../access/bundles.js";
import { resolveAccess } from "../access/resolver.js";
import { buildResolveRequest } from "../access/request.js";
import { assembleAccessInstructions } from "../access/instructions.js";

function resolve(ctx: Parameters<typeof buildResolveRequest>[0]) {
  const access = resolveAccess(buildResolveRequest(ctx), loadBundles());
  for (const w of access.warnings) console.log(`[open-everywhere:access] warning: ${w}`);
  const markdown = assembleAccessInstructions(access);
  return defineInstructions({ markdown: markdown ?? "" });
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => resolve(ctx),
    "turn.started": (_event, ctx) => resolve(ctx),
  },
});
