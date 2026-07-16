import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { type BindableContext } from "../identity/binding.js";
import { resolveWindowSources } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { genericReadVerbsEnabled } from "../access/source-scoped-mount.js";
import { resolveReadAdapter, renderThreadBody, threadReadSource, SUPPORTED_READ_PLATFORMS } from "../channels/channel-read.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { Domain } from "../memory/domain.js";

const MAX_LIMIT = 200;

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

const readThreadEntry = defineTool({
  description:
    "Read all replies in a thread this window's memory domain grants — on any of the window's source " +
    `surfaces (${SUPPORTED_READ_PLATFORMS.join(", ")}). Set target.platform (defaults to the surface this ` +
    "turn came from), target.channel, and thread_ts (the thread root; for Discord, the thread's own channel id).",
  inputSchema: z.object({
    target: z.object({
      platform: z
        .string()
        .min(1)
        .optional()
        .describe(`Which surface to read (${SUPPORTED_READ_PLATFORMS.join(", ")}). Defaults to the surface this turn came from.`),
      channel: z.string().min(1).describe("The channel/conversation id containing the thread (must be in your domain)."),
    }),
    thread_ts: z
      .string()
      .min(1)
      .describe("The thread root (Slack: the root message ts; Discord: the thread's own channel id)."),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max replies to fetch (default 100, max ${MAX_LIMIT}).`),
  }),
  outputSchema: z.object({
    platform: z.string(),
    channel: z.string(),
    thread_ts: z.string(),
    count: z.number(),
    messages: z.array(z.object({ author: z.string(), ts: z.string(), text: z.string() })),
  }),
  async execute(input, ctx) {
    const bctx = ctx as unknown as BindableContext;
    const { platform, adapter } = resolveReadAdapter(bctx, input.target.platform, safeDomains());
    const messages = await adapter.readThread(bctx, input.target.channel, input.thread_ts, input.limit);
    return {
      platform,
      channel: input.target.channel,
      thread_ts: input.thread_ts,
      count: messages.length,
      messages: messages.map((m) => ({ author: m.author, ts: m.ts, text: m.text })),
    };
  },
  toModelOutput(output) {
    return ingestUntrustedModelOutput(renderThreadBody(output), { source: threadReadSource(output) });
  },
});
preRegisterDynamicEntry("read_thread", "_single", readThreadEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!genericReadVerbsEnabled()) return null;
      if (resolveWindowSources(ctx as BindableContext, safeDomains()).length === 0) return null;
      return readThreadEntry;
    },
  },
});
