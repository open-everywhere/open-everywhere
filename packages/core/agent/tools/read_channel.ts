import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { type BindableContext } from "../identity/binding.js";
import { resolveWindowSources } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { genericReadVerbsEnabled } from "../access/source-scoped-mount.js";
import { resolveReadAdapter, renderChannelBody, channelReadSource, SUPPORTED_READ_PLATFORMS } from "../channels/channel-read.js";
import type { Domain } from "../memory/domain.js";

const MAX_LIMIT = 100;

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!genericReadVerbsEnabled()) return null;
      if (resolveWindowSources(ctx as BindableContext, safeDomains()).length === 0) return null;
      return defineTool({
  description:
    "Read recent messages from a channel this window's memory domain grants — on any of the window's " +
    `source surfaces (${SUPPORTED_READ_PLATFORMS.join(", ")}). Set target.platform (defaults to the ` +
    "surface this turn came from) and target.channel. You can only read channels your domain grants; others are refused.",
  inputSchema: z.object({
    target: z.object({
      platform: z
        .string()
        .min(1)
        .optional()
        .describe(`Which surface to read (${SUPPORTED_READ_PLATFORMS.join(", ")}). Defaults to the surface this turn came from.`),
      channel: z
        .string()
        .min(1)
        .describe("The channel/conversation id to read (e.g. a Slack C0123ABCD or a Discord channel id). Must be in your domain's channel set."),
    }),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`How many recent messages to fetch (default 50, max ${MAX_LIMIT}).`),
  }),
  outputSchema: z.object({
    platform: z.string(),
    channel: z.string(),
    count: z.number(),
    messages: z.array(z.object({ author: z.string(), ts: z.string(), text: z.string() })),
  }),
  async execute(input, ctx) {
    const bctx = ctx as unknown as BindableContext;
    const { platform, adapter } = resolveReadAdapter(bctx, input.target.platform, safeDomains());
    const messages = await adapter.readChannel(bctx, input.target.channel, input.limit);
    return { platform, channel: input.target.channel, count: messages.length, messages: messages.map((m) => ({ author: m.author, ts: m.ts, text: m.text })) };
  },
  toModelOutput(output) {
    return ingestUntrustedModelOutput(renderChannelBody(output), { source: channelReadSource(output) });
  },
      });
    },
  },
});
