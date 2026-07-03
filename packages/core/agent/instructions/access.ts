import { defineDynamic, defineInstructions } from "eve/instructions";
import { resolveAccessFor } from "../access/request.js";
import { assembleAccessInstructions } from "../access/instructions.js";
import { resolvePartition } from "../memory/partition.js";
import { bindFrom } from "../identity/binding.js";
import { planFor } from "../memory/resolve.js";
import { renderMemoryIndex } from "../memory/listing.js";
import { readableChannelList } from "../channels/slack-read.js";
import { botDisplayName } from "../channels/slack-events.js";
import { channelPlatform, type BindableContext } from "../identity/binding.js";

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

async function surfaceAgentName(ctx: BindableContext): Promise<string | undefined> {
  return channelPlatform(ctx) === "slack" ? botDisplayName() : undefined;
}

function renderIdentity(name: string | undefined): string {
  return name
    ? `Your name in this workspace is **${name}** — identify as that, not as any framework or model name.`
    : `Identify as this team's agent — never as a framework or model name.`;
}

async function resolve(ctx: BindableContext) {
  const access = resolveAccessFor(ctx);
  for (const w of access.warnings) console.log(`[open-everywhere:access] warning: ${w}`);
  const plan = planFor(bindFrom(ctx), resolvePartition(ctx));
  const memoryMd = plan.reads.length > 0 ? renderMemoryIndex(plan.reads) : "";
  const name = await surfaceAgentName(ctx);
  const markdown = [renderIdentity(name), assembleAccessInstructions(access) ?? "", memoryMd, renderChannelScope(ctx)]
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
