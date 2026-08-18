import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { type BindableContext, TurnOriginFenceError } from "../identity/binding.js";
import { resolveWindowSources } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { genericReadVerbsEnabled } from "../access/source-scoped-mount.js";
import { resolveReadTarget, readChannelResult, chatReadIngestion, renderChannelBody, channelReadSource, keyedReadResult, WindowSourcesRefusalError } from "../channels/channel-read.js";
import { auditSourcesGateRefusal, auditOriginFenceRefusal } from "../channels/read-scope-audit.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { Domain } from "../memory/domain.js";

const MAX_LIMIT = 100;

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

const readChannelEntry = defineTool({
  description:
    "Read recent messages from a channel this window's memory domain grants. Pass the channel key " +
    "you were given — the `id` on the `<channel>` element of your wake, or an entry from your " +
    "readable-channel list. You can only read channels your domain grants; others are refused.",
  inputSchema: z.object({
    channel: z
      .string()
      .min(1)
      .describe("The channel key to read (the `id` from your wake's `<channel>` element, or an entry from your readable-channel list)."),
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
    authoredByNonMember: z.boolean().optional(),
    possiblyIncomplete: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    const bctx = ctx as unknown as BindableContext;
    let resolved: ReturnType<typeof resolveReadTarget>;
    try {
      resolved = resolveReadTarget(bctx, input.channel, safeDomains());
    } catch (err) {
      if (err instanceof WindowSourcesRefusalError) await auditSourcesGateRefusal(bctx, err.platform);
      else if (err instanceof TurnOriginFenceError) await auditOriginFenceRefusal(bctx, err.surface);
      throw err;
    }
    const { platform, adapter, container } = resolved;
    return await readChannelResult(bctx, platform, adapter, container, input.limit);
  },
  toModelOutput(output) {
    const keyed = keyedReadResult(output);
    return ingestUntrustedModelOutput(renderChannelBody(keyed), {
      source: channelReadSource(keyed),
      ingestion: chatReadIngestion(`read_channel:${output.platform}`, output),
    });
  },
});
preRegisterDynamicEntry("read_channel", "_single", readChannelEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!genericReadVerbsEnabled()) return null;
      if (resolveWindowSources(ctx as BindableContext, safeDomains()).length === 0) return null;
      return readChannelEntry;
    },
  },
});
