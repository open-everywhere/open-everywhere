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
import { LIST_PREVIEW_MAX, listCardLine, listPreviewText, type ListRowWrite, type ListWriteArgs } from "../approvals/slack-doc-write.js";
import { LIST_ROWS_MAX, encodeListRow, findListRow, liveSlackDocCall, resolveRoomFile, type ListCell, type SlackDocCall } from "../channels/slack-canvas-list.js";
import { bridgeFetchUserDisplayName, slackBridge } from "../channels/slack-bridge.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";

const TOOL = "update_list";

const cellsSchema = z
  .record(z.string(), z.string())
  .describe('Column name → value, e.g. { "Title": "Fix login", "Owner": "<@U123>", "Status": "In progress", "Due": "2026-10-21" }. A person is a Slack mention (look them up first); a date is YYYY-MM-DD; a checkbox is yes or no.');

const inputSchema = z.object({
  list: z.string().min(1).describe("The List, as its Slack link. It must be shared in this conversation."),
  add: z.array(z.object({ cells: cellsSchema })).optional().describe("New rows to add."),
  update: z
    .array(z.object({ row: z.string().min(1).describe("The row's name — the text in its first (title) column."), cells: cellsSchema }))
    .optional()
    .describe("Existing rows to change, each named by its title. Give only the columns that change."),
});

export type PersonName = (userId: string) => Promise<string | undefined>;

async function namedCells(cells: readonly ListCell[], nameOf: PersonName): Promise<ListCell[]> {
  const out: ListCell[] = [];
  for (const c of cells) {
    const user = (c.value as { user?: unknown }).user;
    const id = Array.isArray(user) && typeof user[0] === "string" ? user[0] : undefined;
    if (id === undefined) {
      out.push(c);
      continue;
    }
    const name = await nameOf(id).catch(() => undefined);
    if (!name) throw new Error(`I could not read the name of the person for the "${c.column}" column, so I cannot show them on the approval card. Try again.`);
    out.push({ ...c, shown: name });
  }
  return out;
}

export async function buildListWrite(
  input: z.infer<typeof inputSchema>,
  p: { readonly org: string; readonly scopeKey: string; readonly channelId: string; readonly requestedBy: string; readonly tainted: boolean },
  call: SlackDocCall,
  nameOf: PersonName = bridgeFetchUserDisplayName,
): Promise<ListWriteArgs> {
  const adds = input.add ?? [];
  const updates = input.update ?? [];
  if (adds.length + updates.length === 0) throw new Error(`${TOOL}: give at least one row to add or change.`);
  if (adds.length + updates.length > LIST_ROWS_MAX) throw new Error(`${TOOL}: one change takes at most ${LIST_ROWS_MAX} rows. Split it.`);
  const fail = (err: unknown): never => {
    throw new Error(`${TOOL}: ${err instanceof Error ? err.message : String(err)}`);
  };
  const file = await resolveRoomFile(call, input.list, p.channelId, "list").catch(fail);
  if (file.columns.length === 0) fail(new Error("I could not read that List's columns."));
  const rows: ListRowWrite[] = [];
  try {
    for (const a of adds) rows.push({ cells: await namedCells(encodeListRow(file.columns, a.cells), nameOf) });
    for (const u of updates) {
      const cells = await namedCells(encodeListRow(file.columns, u.cells), nameOf);
      const hit = await findListRow(call, file.id, file.columns, u.row);
      rows.push({ rowId: hit.rowId, title: hit.title, cells });
    }
  } catch (err) {
    fail(err);
  }
  const preview = listPreviewText(rows).length;
  if (preview > LIST_PREVIEW_MAX || !listCardLine(rows).whole) {
    fail(new Error(`these rows are too long for one approval card (${preview} characters; one card shows at most about ${LIST_PREVIEW_MAX}). Split the change into smaller ones.`));
  }
  return {
    org: p.org,
    scopeKey: p.scopeKey,
    channelId: p.channelId,
    listId: file.id,
    listTitle: file.title,
    rows,
    requestedBy: p.requestedBy,
    ...(p.tainted ? { tainted: true } : {}),
  };
}

const updateListEntry = defineTool({
  description:
    "PROPOSE adding rows to, or changing rows in, a Slack LIST shared in this conversation — Slack's " +
    "built-in tracker, with columns such as owner, status and due date. Give the List's link, then `add` " +
    "new rows and/or `update` existing rows by their title, each as column name → value. A wrong column " +
    "or value refuses and names what the List takes. Consequential: it posts an approval card that " +
    "quotes every row, and nothing changes until a human confirms. A change too long for one card refuses: " +
    "split it. The posted card IS the reply — do not repeat its rows.",
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
    const args = await buildListWrite(input, { org: p.org, scopeKey, channelId, requestedBy, tainted: untrustedIngestedThisTurn() }, liveSlackDocCall);
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "list.write",
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
    const subject = `change the List "${args.listTitle}"`;
    if (posted.autoApproved) {
      return { pending: false, autoApproved: true, pendingId: posted.id, message: autoApprovedNote(subject, posted.autoApproved) };
    }
    return {
      pending: true,
      pendingId: posted.id,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${cardPostedTail(venue, "confirm the List change", posted)}`,
    };
  },
});
preRegisterDynamicEntry(TOOL, "_single", updateListEntry);

export default defineDynamic({
  events: {
    "session.started": () => (slackBridge() ? updateListEntry : null),
  },
});
