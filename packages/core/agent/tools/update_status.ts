import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { SURFACE } from "../memory/store.js";
import { getProvider } from "../memory/provider.js";
import { writeTierFile } from "../memory/sandbox-sync.js";
import { withMemoryRootWritable } from "../memory/root-fence.js";
import { statusItemLine, upsertStatusItem, statusSeed, type WorkState } from "../status/status.js";

export default defineTool({
  description:
    "Record your current work status so the team can see it at a glance (it's mirrored to a pinned status message in the channel, shared across all threads). Call when you start a substantial task, when you finish, or when you're blocked / need input. One status per thread.",
  inputSchema: z.object({
    state: z
      .enum(["working", "done", "needs_input", "blocked"])
      .describe("working = in progress; done = finished; needs_input = waiting on a human; blocked = stuck."),
    summary: z.string().min(1).describe("One short line: what you're doing / did / are blocked on."),
  }),
  outputSchema: z.object({ updated: z.boolean(), state: z.string() }),
  approval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const sessionId = ctx.session.id;
    const when = new Date().toISOString().slice(0, 16).replace("T", " ") + "Z";
    const line = statusItemLine(sessionId, input.state as WorkState, input.summary, when);

    const durable = await getProvider().readTier(p, SURFACE);
    const current = durable["STATUS.md"] ?? statusSeed(p.surfaceKey);
    const updated = upsertStatusItem(current, sessionId, line);

    const sandbox = await ctx.getSandbox();
    await withMemoryRootWritable(sandbox, () => writeTierFile(sandbox, SURFACE, "STATUS.md", updated));
    await getProvider().writeTier(p, SURFACE, { "STATUS.md": updated }, `status [${input.state}] ${sessionId}`);

    return { updated: true, state: input.state };
  },
});
