import { defineDynamic, defineInstructions } from "eve/instructions";
import { resolveAccessFor } from "../access/request.js";
import { assembleAccessInstructions } from "../access/instructions.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom } from "../identity/binding.js";
import { planFor } from "../memory/resolve.js";
import { renderMemoryIndex } from "../memory/listing.js";
import type { BindableContext } from "../identity/binding.js";

function resolve(ctx: BindableContext) {
  const access = resolveAccessFor(ctx);
  for (const w of access.warnings) console.log(`[open-everywhere:access] warning: ${w}`);
  const plan = planFor(bindFrom(ctx), resolvePartition(ctx));
  const memoryMd = plan.reads.length > 0 ? renderMemoryIndex(plan.reads) : "";
  const markdown = [assembleAccessInstructions(access) ?? "", memoryMd]
    .filter((s) => s.length > 0)
    .join("\n\n");
  return defineInstructions({ markdown });
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => resolve(ctx),
    "turn.started": (_event, ctx) => resolve(ctx),
  },
});
