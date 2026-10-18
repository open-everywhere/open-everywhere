import { appendAudit } from "../audit/audit.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { QUOTE_MAX, finishPlainLine, plainQuote, plainValue } from "./plain-text.js";
import { channelWords } from "../channels/friendly-ids.js";
import {
  initialField,
  liveSlackDocCall,
  resolveRoomFile,
  rowWords,
  updateCell,
  type ListCell,
} from "../channels/slack-canvas-list.js";

export interface CanvasWriteArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly channelId: string;
  readonly op: "create" | "replace" | "append";
  readonly canvasId?: string;
  readonly title: string;
  readonly markdown: string;
  readonly requestedBy: string;
  readonly tainted?: boolean;
}

export interface ListRowWrite {
  readonly rowId?: string;
  readonly title?: string;
  readonly cells: readonly ListCell[];
}

export interface ListWriteArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly channelId: string;
  readonly listId: string;
  readonly listTitle: string;
  readonly rows: readonly ListRowWrite[];
  readonly requestedBy: string;
  readonly tainted?: boolean;
}


const CANVAS_VERB: Readonly<Record<CanvasWriteArgs["op"], string>> = { create: "Create", replace: "Rewrite", append: "Add to" };
const CANVAS_DONE: Readonly<Record<CanvasWriteArgs["op"], string>> = { create: "created", replace: "rewritten", append: "added to" };

export const FREE_TEAM_TAB_TAKEN = "free_team_canvas_tab_already_exists";

export function freeTeamTabTakenWords(channelId: string): string {
  return `This Slack workspace is on the free plan, which allows one canvas tab per channel, and ${channelWords("slack", channelId)} already has one (${FREE_TEAM_TAB_TAKEN}).`;
}

const TAINT_LINE = "⚠ proposed in a turn that read external content — review before approving";
export function canvasPlainSummary(args: CanvasWriteArgs): string {
  return `${CANVAS_VERB[args.op]} the canvas "${plainValue(args.title)}" in ${channelWords("slack", args.channelId)}`;
}

const canvasWrite: ActionKind<CanvasWriteArgs> = {
  kind: "canvas.write",
  policy: "member",
  plainSummary: canvasPlainSummary,
  consequence: (args) => plainQuote(args.markdown, QUOTE_MAX - 2),
  consequenceQuotes: true,
  doneSummary: (args) => `${CANVAS_DONE[args.op]} the canvas "${plainValue(args.title)}" in ${channelWords("slack", args.channelId)}`,
  summarize(args) {
    const lines = [`${canvasPlainSummary(args)} (${args.op}${args.canvasId ? ` ${args.canvasId}` : ""})`, args.markdown];
    if (args.tainted) lines.push(TAINT_LINE);
    return lines;
  },
  async execute(args, decidedBy) {
    const call = liveSlackDocCall;
    let canvasId = args.canvasId;
    try {
      if (args.op === "create") {
        const res = await call("canvases.create", {
          title: args.title,
          channel_id: args.channelId,
          document_content: JSON.stringify({ type: "markdown", markdown: args.markdown }),
        });
        canvasId = typeof res.canvas_id === "string" ? res.canvas_id : undefined;
      } else {
        await resolveRoomFile(call, args.canvasId ?? "", args.channelId, "canvas");
        await call("canvases.edit", {
          canvas_id: args.canvasId ?? "",
          changes: JSON.stringify([
            { operation: args.op === "replace" ? "replace" : "insert_at_end", document_content: { type: "markdown", markdown: args.markdown } },
          ]),
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (args.op === "create" && reason.includes(FREE_TEAM_TAB_TAKEN)) {
        throw new Error(`canvas.write: the canvas "${plainValue(args.title)}" was not written. ${freeTeamTabTakenWords(args.channelId)}`);
      }
      throw new Error(`canvas.write: the canvas "${args.title}" was not written. ${reason}`);
    }
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "canvas.write",
      detail: {
        channel: args.channelId,
        op: args.op,
        ...(canvasId ? { canvasId } : {}),
        chars: args.markdown.length,
        requestedBy: args.requestedBy,
        tainted: Boolean(args.tainted),
      },
    });
    return `canvas "${plainValue(args.title)}" ${CANVAS_DONE[args.op]} in ${channelWords("slack", args.channelId)}`;
  },
};

export function listChangeWords(rows: readonly ListRowWrite[]): { readonly add: string; readonly done: string } {
  const added = rows.filter((r) => r.rowId === undefined).length;
  const changed = rows.length - added;
  const n = (k: number): string => `${k} ${k === 1 ? "row" : "rows"}`;
  const add = [added > 0 ? `Add ${n(added)}` : "", changed > 0 ? `${added > 0 ? "change" : "Change"} ${n(changed)}` : ""].filter(Boolean).join(" and ");
  const done = [added > 0 ? `${n(added)} added` : "", changed > 0 ? `${n(changed)} changed` : ""].filter(Boolean).join(" and ");
  return { add, done };
}

function unquoted(text: string): string {
  return text.replace(/[“”"]/gu, "'");
}

export function listPreviewText(rows: readonly ListRowWrite[]): string {
  return rows
    .map((r) => rowWords(r.title === undefined ? undefined : unquoted(r.title), r.cells.map((c) => ({ ...c, column: unquoted(c.column), shown: unquoted(c.shown) }))))
    .join("; ");
}

export function listCardLine(rows: readonly ListRowWrite[]): { readonly line: string; readonly whole: boolean } {
  const quoted = plainQuote(listPreviewText(rows), QUOTE_MAX - 2);
  const line = finishPlainLine(quoted, QUOTE_MAX);
  return { line, whole: !/more characters not shown\)$/u.test(quoted) && !line.endsWith("…") };
}

export const LIST_PREVIEW_MAX = QUOTE_MAX - 4;

export function listPlainSummary(args: ListWriteArgs): string {
  return `${listChangeWords(args.rows).add} in the List "${plainValue(args.listTitle)}" in ${channelWords("slack", args.channelId)}`;
}

const listWrite: ActionKind<ListWriteArgs> = {
  kind: "list.write",
  policy: "member",
  plainSummary: listPlainSummary,
  consequence: (args) => plainQuote(listPreviewText(args.rows), QUOTE_MAX - 2),
  consequenceQuotes: true,
  doneSummary: (args) => `${listChangeWords(args.rows).done} in the List "${plainValue(args.listTitle)}" in ${channelWords("slack", args.channelId)}`,
  summarize(args) {
    const lines = [`${listPlainSummary(args)} (${args.listId})`, ...args.rows.map((r) => `${r.rowId ? `change ${r.rowId}` : "add"}: ${rowWords(r.title, r.cells)}`)];
    if (args.tainted) lines.push(TAINT_LINE);
    return lines;
  },
  async execute(args, decidedBy) {
    const call = liveSlackDocCall;
    const added: string[] = [];
    try {
      await resolveRoomFile(call, args.listId, args.channelId, "list");
      for (const row of args.rows.filter((r) => r.rowId === undefined)) {
        const res = await call("slackLists.items.create", { list_id: args.listId, initial_fields: JSON.stringify(row.cells.map(initialField)) });
        const item = res.item as { id?: unknown } | undefined;
        if (typeof item?.id === "string") added.push(item.id);
      }
      const changes = args.rows.filter((r) => r.rowId !== undefined).flatMap((r) => r.cells.map((c) => updateCell(r.rowId!, c)));
      if (changes.length > 0) await call("slackLists.items.update", { list_id: args.listId, cells: JSON.stringify(changes) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const partial = added.length > 0 ? ` ${added.length} of the new rows were added before it stopped.` : "";
      throw new Error(`list.write: the List "${args.listTitle}" was not fully updated.${partial} ${reason}`);
    }
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "list.write",
      detail: {
        channel: args.channelId,
        listId: args.listId,
        added: args.rows.filter((r) => r.rowId === undefined).length,
        changed: args.rows.filter((r) => r.rowId !== undefined).length,
        requestedBy: args.requestedBy,
        tainted: Boolean(args.tainted),
      },
    });
    return `${listChangeWords(args.rows).done} in the List "${plainValue(args.listTitle)}"`;
  },
};

registerActionKind(canvasWrite);
registerActionKind(listWrite);
