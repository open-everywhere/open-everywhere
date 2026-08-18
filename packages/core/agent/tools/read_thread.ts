import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { type BindableContext, TurnOriginFenceError } from "../identity/binding.js";
import { resolveWindowSources } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { genericReadVerbsEnabled } from "../access/source-scoped-mount.js";
import { resolveReadTarget, readThreadResult, chatReadIngestion, renderThreadBody, threadReadSource, keyedReadResult, WindowSourcesRefusalError } from "../channels/channel-read.js";
import { auditSourcesGateRefusal, auditOriginFenceRefusal } from "../channels/read-scope-audit.js";
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
    "Read all replies in a thread this window's memory domain grants. Pass the channel key you were " +
    "given — the `id` on the `<channel>` element of your wake — plus thread_ts, the thread root.",
  inputSchema: z.object({
    channel: z
      .string()
      .min(1)
      .describe("The channel key holding the thread (the `id` from your wake's `<channel>` element)."),
    thread_ts: z
      .string()
      .min(1)
      .describe("The thread root, as shown on your wake's `<thread ts>` (Slack: the root message ts; Discord: the thread's own channel id)."),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max replies to fetch (default 100, max ${MAX_LIMIT}).`),
  }),
  outputSchema: z.object({
    platform: z.string(),
    channel: z.string(),
    thread_ts: z.string(),
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
    return await readThreadResult(bctx, platform, adapter, container, input.thread_ts, input.limit);
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
