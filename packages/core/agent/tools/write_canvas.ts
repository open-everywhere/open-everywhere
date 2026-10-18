import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getConfig } from "../access/config.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import type { Domain } from "../memory/domain.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}
import type { CanvasWriteArgs } from "../approvals/slack-doc-write.js";
import {
  CANVAS_MARKDOWN_MAX,
  defuseDocText,
  liveSlackDocCall,
  MEMORY_CANVAS_MARKER_REFUSAL,
  quotesMemoryCanvasMarker,
  refuseMemoryCanvasWrite,
  resolveRoomFile,
  type SlackDocCall,
} from "../channels/slack-canvas-list.js";
import { slackBridge } from "../channels/slack-bridge.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";

const TOOL = "write_canvas";

const inputSchema = z.object({
  canvas: z
    .string()
    .min(1)
    .optional()
    .describe("The canvas to change, as its Slack link. Leave it out to create a NEW canvas in this conversation."),
  mode: z
    .enum(["append", "replace"])
    .optional()
    .describe('For an existing canvas: "append" adds the text at the end (the default); "replace" rewrites the whole canvas.'),
  title: z.string().min(1).max(150).optional().describe("The new canvas's title. Required to create a canvas."),
  markdown: z.string().min(1).describe("The canvas text, in markdown (headings, lists, checklists, tables, links). A person reads it on the approval card before it lands."),
});

export async function buildCanvasWrite(
  input: z.infer<typeof inputSchema>,
  p: { readonly org: string; readonly scopeKey: string; readonly channelId: string; readonly requestedBy: string; readonly tainted: boolean },
  call: SlackDocCall,
): Promise<CanvasWriteArgs> {
  if (input.markdown.length > CANVAS_MARKDOWN_MAX) {
    throw new Error(`${TOOL}: that text is ${input.markdown.length} characters, and a canvas takes at most ${CANVAS_MARKDOWN_MAX}. Shorten it or split it.`);
  }
  if (quotesMemoryCanvasMarker(`${input.title ?? ""}\n${input.markdown}`)) throw new Error(`${TOOL}: ${MEMORY_CANVAS_MARKER_REFUSAL}`);
  const markdown = defuseDocText(input.markdown);
  const base = { org: p.org, scopeKey: p.scopeKey, channelId: p.channelId, markdown, requestedBy: p.requestedBy, ...(p.tainted ? { tainted: true } : {}) };
  if (input.canvas === undefined) {
    if (!input.title) throw new Error(`${TOOL}: a new canvas needs a title.`);
    return { ...base, op: "create", title: input.title };
  }
  const file = await resolveRoomFile(call, input.canvas, p.channelId, "canvas")
    .then(async (f) => {
      await refuseMemoryCanvasWrite(call, f.id, p);
      return f;
    })
    .catch((err: unknown) => {
      throw new Error(`${TOOL}: ${err instanceof Error ? err.message : String(err)}`);
    });
  return { ...base, op: input.mode ?? "append", canvasId: file.id, title: file.title };
}

const writeCanvasEntry = defineTool({
  description:
    "PROPOSE creating or changing a Slack CANVAS in this conversation — a meeting notes page, a plan, a " +
    "runbook, a summary people keep coming back to. Leave `canvas` out to create a new canvas here; give " +
    "a canvas's link to add to it (`mode: \"append\"`, the default) or rewrite it (`mode: \"replace\"`). " +
    "Only a canvas this conversation shows can be changed, and never the channel's memory canvas (the next " +
    "memory write rewrites it): to change a line there, remember or forget it instead. Consequential: it posts an approval card that " +
    "previews the change, and nothing changes until a human confirms. The posted card IS the reply — do " +
    "not repeat its text.",
  inputSchema,
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
    message: z.string(),
  }),
  async execute(input, ctx) {
    const bctx = ctx as BindableContext;
    await requireSessionContinuation(bctx, TOOL);
    const binding = bindFrom(bctx);
    if (binding.platform !== "slack") {
      throw new Error(`${TOOL}: canvases and Lists are Slack features, and this conversation is on ${binding.platform}.`);
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error(`${TOOL}: I could not tell which Slack conversation this is. Ask again from the channel or DM.`);
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error(`${TOOL}: no verified person asked for this, so there is nobody to show on the approval card.`);
    }
    const p = resolvePartition(ctx);
    const scopeKey = await proposalScopeKey(ctx, p);
    const domains = safeDomains();
    const venueResult = await checkApprovalVenue(binding, p, () => domains);
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "make that change"));
    }
    const venue = venueResult.venue;
    const args = await buildCanvasWrite(input, { org: p.org, scopeKey, channelId, requestedBy, tainted: untrustedIngestedThisTurn() }, liveSlackDocCall);
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "canvas.write",
        args,
        scopeKey,
        domain: null,
        requestedBy,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );
    const subject = `${args.op === "create" ? "create the canvas" : args.op === "replace" ? "rewrite the canvas" : "add to the canvas"} "${args.title}"`;
    if (posted.autoApproved) {
      return { pending: false, autoApproved: true, pendingId: posted.id, message: autoApprovedNote(subject, posted.autoApproved) };
    }
    return {
      pending: true,
      pendingId: posted.id,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${cardPostedTail(venue, "confirm the canvas change", posted)}`,
    };
  },
});
preRegisterDynamicEntry(TOOL, "_single", writeCanvasEntry);

export default defineDynamic({
  events: {
    "session.started": () => (slackBridge() ? writeCanvasEntry : null),
  },
});
