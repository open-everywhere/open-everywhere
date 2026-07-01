import { defineDynamic, defineInstructions } from "eve/instructions";
import { resolveAccessFor } from "../access/request.js";
import { assembleAccessInstructions } from "../access/instructions.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom } from "../identity/binding.js";
import { planFor } from "../memory/resolve.js";
import { renderMemoryIndex } from "../memory/listing.js";
import { readableChannelList } from "../channels/slack-read.js";
import type { BindableContext } from "../identity/binding.js";

function renderChannelScope(ctx: BindableContext): string {
  const channels = readableChannelList(ctx);
  if (channels.length < 2) return "";
  return (
    "## Slack channels you can read\n" +
    "Your memory domain spans these channels — you may read any of them with " +
    "`read_slack_channel` / `read_slack_thread`, and no others:\n" +
    channels.map((c) => `- ${c}`).join("\n")
  );
}

function renderIdentity(): string {
  const name = process.env.OE_AGENT_NAME?.trim() || "Open Everywhere";
  return `Your name in this workspace is **${name}** — identify as that, not as any framework or model name.`;
}

function resolve(ctx: BindableContext) {
  const access = resolveAccessFor(ctx);
  for (const w of access.warnings) console.log(`[open-everywhere:access] warning: ${w}`);
  const plan = planFor(bindFrom(ctx), resolvePartition(ctx));
  const memoryMd = plan.reads.length > 0 ? renderMemoryIndex(plan.reads) : "";
  const markdown = [renderIdentity(), assembleAccessInstructions(access) ?? "", memoryMd, renderChannelScope(ctx)]
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
