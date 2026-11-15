import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { type BindableContext, TurnOriginFenceError } from "../identity/binding.js";
import { resolveWindowSources } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { readChannelResult, renderChannelBody, channelReadSource, keyedReadResult, WindowSourcesRefusalError, READ_FILES_SCHEMA } from "../channels/channel-read.js";
import { resolveWakeChannel } from "../channels/wake-container.js";
import { auditSourcesGateRefusal, auditOriginFenceRefusal } from "../channels/read-scope-audit.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { assertSeatReadBudget } from "../access/seat-read-budget.js";
import { capReadForInline } from "../channels/read-spool.js";
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
    "Read recent messages from THIS conversation's channel — the room this turn arrived in. It takes " +
    "no target: it always reads where you are. Use it when somebody refers to a message you cannot " +
    "see in your wake.",
  inputSchema: z.object({
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
    messages: z.array(
      z.object({
        author: z.string(),
        ts: z.string(),
        text: z.string(),
        readAt: z.string().optional(),
        live: z.boolean().optional(),
        files: READ_FILES_SCHEMA,
      }),
    ),
    possiblyIncomplete: z.boolean().optional(),
    partialReason: z.string().optional(),
    spool: z.object({ path: z.string().optional(), shown: z.number(), total: z.number() }).optional(),
  }),
  async execute(input, ctx) {
    const bctx = ctx as unknown as BindableContext;
    assertSeatReadBudget("read_channel");
    let resolved: ReturnType<typeof resolveWakeChannel>;
    try {
      resolved = resolveWakeChannel(bctx, safeDomains());
    } catch (err) {
      if (err instanceof WindowSourcesRefusalError) await auditSourcesGateRefusal(bctx, err.platform);
      else if (err instanceof TurnOriginFenceError) await auditOriginFenceRefusal(bctx, err.surface);
      throw err;
    }
    const { platform, adapter, container } = resolved;
    const out = await readChannelResult(bctx, platform, adapter, container, input.limit);
    const keyed = keyedReadResult(out);
    return await capReadForInline(bctx, out, "channel", keyed.channel, () => renderChannelBody(keyed));
  },
  toModelOutput(output) {
    const keyed = keyedReadResult(output);
    return ingestUntrustedModelOutput(renderChannelBody(keyed), {
      source: channelReadSource(keyed),
      toolName: `read_channel:${output.platform}`,
    });
  },
});
preRegisterDynamicEntry("read_channel", "_single", readChannelEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (resolveWindowSources(ctx as BindableContext, safeDomains()).length === 0) return null;
      return readChannelEntry;
    },
  },
});
