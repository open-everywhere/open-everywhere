import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { type BindableContext, TurnOriginFenceError } from "../identity/binding.js";
import { resolveWindowSources } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { genericReadVerbsEnabled } from "../access/source-scoped-mount.js";
import { readThreadResult, chatReadIngestion, renderThreadBody, threadReadSource, keyedReadResult, WindowSourcesRefusalError } from "../channels/channel-read.js";
import { resolveWakeChannel, requireWakeThreadRoot } from "../channels/wake-container.js";
import { auditSourcesGateRefusal, auditOriginFenceRefusal } from "../channels/read-scope-audit.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { assertSeatReadBudget } from "../access/seat-read-budget.js";
import { capReadForInline } from "../channels/read-spool.js";
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
    "Read all replies in THIS thread — the thread this turn arrived in. It takes no target: it " +
    "always reads where you are. If this turn is not in a thread, use `read_channel` instead.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max replies to fetch (default 100, max ${MAX_LIMIT}).`),
  }),
  outputSchema: z.object({
    platform: z.string(),
    channel: z.string(),
    thread_ts: z.string(),
    count: z.number(),
    messages: z.array(
      z.object({
        author: z.string(),
        ts: z.string(),
        text: z.string(),
        readAt: z.string().optional(),
        live: z.boolean().optional(),
      }),
    ),
    authoredByNonMember: z.boolean().optional(),
    possiblyIncomplete: z.boolean().optional(),
    partialReason: z.string().optional(),
    spool: z.object({ path: z.string().optional(), shown: z.number(), total: z.number() }).optional(),
  }),
  async execute(input, ctx) {
    const bctx = ctx as unknown as BindableContext;
    assertSeatReadBudget("read_thread");
    let resolved: ReturnType<typeof resolveWakeChannel>;
    try {
      resolved = resolveWakeChannel(bctx, safeDomains());
    } catch (err) {
      if (err instanceof WindowSourcesRefusalError) await auditSourcesGateRefusal(bctx, err.platform);
      else if (err instanceof TurnOriginFenceError) await auditOriginFenceRefusal(bctx, err.surface);
      throw err;
    }
    const { platform, adapter, container } = resolved;
    const threadRoot = requireWakeThreadRoot(resolved);
    const out = await readThreadResult(bctx, platform, adapter, container, threadRoot, input.limit);
    const keyed = keyedReadResult(out);
    return await capReadForInline(bctx, out, "thread", keyed.channel, () => renderThreadBody(keyed));
  },
  toModelOutput(output) {
    const keyed = keyedReadResult(output);
    return ingestUntrustedModelOutput(renderThreadBody(keyed), {
      source: threadReadSource(keyed),
      ingestion: chatReadIngestion(`read_thread:${output.platform}`, output),
    });
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
