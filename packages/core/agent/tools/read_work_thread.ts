import { defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { type BindableContext, TurnOriginFenceError } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { readThreadResult, renderThreadBody, threadReadSource, keyedReadResult, WindowSourcesRefusalError, READ_FILES_SCHEMA } from "../channels/channel-read.js";
import { resolveWakeChannel, requireWakeThreadRoot } from "../channels/wake-container.js";
import { auditSourcesGateRefusal, auditOriginFenceRefusal } from "../channels/read-scope-audit.js";
import { sessionMountedTool } from "../access/window-gated.js";
import { capReadForInline } from "../channels/read-spool.js";
import { assertSurfaceWorkGrant, surfaceWorkReadMount } from "../access/surface-work-grant.js";
import type { Domain } from "../memory/domain.js";

const MAX_LIMIT = 200;

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

const readWorkThreadEntry = defineTool({
  description:
    "Read every reply in the thread this task was delegated from — the work-surface read. It takes " +
    "no target: it always reads the thread you were delegated in. A reply that carries files lists " +
    "each one by name, media type and attachment id; pass that id to `describe_image` as " +
    "{ kind: \"attachment\", ref }. An id resolves only for a recent upload; an older one can be " +
    "refused. When you tell a person about a file, use its name. If the task " +
    "was delegated from the top level of a channel, use `read_work_channel` instead.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max replies to fetch (default 100, max ${MAX_LIMIT}).`),
  }),
  outputSchema: z.object({
    platform: z.string(),
    channel: z.string(),
    thread_ts: z.string(),
    count: z.number(),
    messages: z.array(z.object({ author: z.string(), ts: z.string(), text: z.string(), files: READ_FILES_SCHEMA })),
    possiblyIncomplete: z.boolean().optional(),
    partialReason: z.string().optional(),
    spool: z.object({ path: z.string().optional(), shown: z.number(), total: z.number() }).optional(),
  }),
  async execute(input, ctx) {
    const bctx = ctx as unknown as BindableContext;
    const domains = safeDomains();
    let resolved: ReturnType<typeof resolveWakeChannel>;
    try {
      resolved = resolveWakeChannel(bctx, domains);
    } catch (err) {
      if (err instanceof WindowSourcesRefusalError) await auditSourcesGateRefusal(bctx, err.platform);
      else if (err instanceof TurnOriginFenceError) await auditOriginFenceRefusal(bctx, err.surface);
      throw err;
    }
    const { platform, adapter, container } = resolved;
    assertSurfaceWorkGrant(bctx, domains, platform);
    const threadRoot = requireWakeThreadRoot(resolved);
    const out = await readThreadResult(bctx, platform, adapter, container, threadRoot, input.limit);
    const keyed = keyedReadResult(out);
    return await capReadForInline(bctx, out, "thread", keyed.channel, () => renderThreadBody(keyed));
  },
  toModelOutput(output) {
    const keyed = keyedReadResult(output);
    return ingestUntrustedModelOutput(renderThreadBody(keyed), {
      source: threadReadSource(keyed),
      toolName: `read_work_thread:${output.platform}`,
    });
  },
});

export default sessionMountedTool("read_work_thread", readWorkThreadEntry, (ctx) => {
  if (!surfaceWorkReadMount(ctx, safeDomains)) return false;
  return true;
});
