import { defineDynamic, defineInstructions } from "eve/instructions";
import { resolveAccessFor } from "../access/request.js";
import { assembleAccessInstructions } from "../access/instructions.js";
import type { BindableContext } from "../identity/binding.js";

function resolve(ctx: BindableContext) {
  const access = resolveAccessFor(ctx);
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
