import type { AuditWireEntry } from "./audit-read.js";
import { failedRead, type SlackRawCall } from "./memory-canvas.js";

export const LIST_FIXTURE_TITLE = "OE e2e List fixture";
export const LIST_NOTE_COLUMN = "Note";
export const LIST_WRITE_ACTION = "list.write";
const FILE_PAGES_MAX = 20;
const ROW_PAGES_MAX = 10;

type FailedRead = ReturnType<typeof failedRead>;

export const LIST_FIXTURE_SETUP =
  `Create a Slack List titled "${LIST_FIXTURE_TITLE}" with its title column and one text column named "${LIST_NOTE_COLUMN}", ` +
  "share it in the e2e channel (E2E_SLACK_CHANNEL) so that the app and the driver user can open it, and rerun. " +
  "The driver token needs `lists:read`, and `lists:write` for the clean-up (without it each run leaves its row in the List).";

export type FixtureListFind =
  | { readonly kind: "found"; readonly id: string; readonly link: string }
  | { readonly kind: "absent"; readonly scanned: number }
  | FailedRead;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function findFixtureList(call: SlackRawCall, channelId: string): Promise<FixtureListFind> {
  const want = LIST_FIXTURE_TITLE.toLowerCase();
  let scanned = 0;
  for (const types of ["lists", "all"]) {
    for (let page = 1; page <= FILE_PAGES_MAX; page++) {
      const res = await call("files.list", { channel: channelId, types, count: "100", page: String(page) });
      if (res.ok !== true) return failedRead("files.list", res);
      const files = Array.isArray(res.files) ? (res.files as Record<string, unknown>[]) : [];
      scanned += files.length;
      for (const f of files) {
        const id = str(f.id);
        const title = str(f.title) ?? str(f.name);
        if (id && title?.trim().toLowerCase() === want) return { kind: "found", id, link: str(f.permalink) ?? id };
      }
      const pages = (res.paging as { pages?: unknown } | undefined)?.pages;
      if (files.length === 0 || typeof pages !== "number" || page >= pages) break;
    }
  }
  return { kind: "absent", scanned };
}

export type FixtureColumns =
  | { readonly kind: "columns"; readonly titleId: string; readonly titleName: string; readonly noteId: string }
  | { readonly kind: "unfit"; readonly why: string }
  | FailedRead;

export async function fixtureColumns(call: SlackRawCall, listId: string): Promise<FixtureColumns> {
  const res = await call("files.info", { file: listId });
  if (res.ok !== true) return failedRead("files.info", res);
  const schema = ((res.file as { list_metadata?: { schema?: unknown } } | undefined)?.list_metadata)?.schema;
  if (!Array.isArray(schema)) return { kind: "unfit", why: `the file ${listId} titled "${LIST_FIXTURE_TITLE}" is not a Slack List (files.info shows no list schema), or the driver token cannot read its schema` };
  const columns = schema as Record<string, unknown>[];
  const title = columns.find((c) => c.is_primary_column === true && str(c.id));
  if (!title) return { kind: "unfit", why: "the fixture List shows no primary (title) column" };
  const note = columns.find((c) => (str(c.name) ?? str(c.key) ?? "").trim().toLowerCase() === LIST_NOTE_COLUMN.toLowerCase() && str(c.id));
  if (!note) return { kind: "unfit", why: `the fixture List has no "${LIST_NOTE_COLUMN}" column` };
  const noteType = str(note.type) ?? "text";
  if (noteType !== "text" && noteType !== "rich_text") return { kind: "unfit", why: `the fixture List's "${LIST_NOTE_COLUMN}" column holds ${noteType} values, not text` };
  return { kind: "columns", titleId: str(title.id)!, titleName: str(title.name) ?? str(title.key) ?? "Name", noteId: str(note.id)! };
}

export type ListRowsRead = { readonly kind: "rows"; readonly items: readonly Record<string, unknown>[] } | FailedRead;

export async function readListRows(call: SlackRawCall, listId: string): Promise<ListRowsRead> {
  const items: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < ROW_PAGES_MAX; page++) {
    const res = await call("slackLists.items.list", { list_id: listId, limit: "100", ...(cursor ? { cursor } : {}) });
    if (res.ok !== true) return failedRead("slackLists.items.list", res);
    if (Array.isArray(res.items)) items.push(...(res.items as Record<string, unknown>[]));
    cursor = str((res.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor);
    if (!cursor) break;
  }
  return { kind: "rows", items };
}

function richTextWords(v: unknown, out: string[]): void {
  if (Array.isArray(v)) {
    for (const e of v) richTextWords(e, out);
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") out.push(o.text);
    for (const [k, e] of Object.entries(o)) if (k !== "text") richTextWords(e, out);
  }
}

export function rowFieldText(item: Record<string, unknown>, columnId: string): string | undefined {
  const fields = Array.isArray(item.fields) ? (item.fields as Record<string, unknown>[]) : [];
  const f = fields.find((x) => x.column_id === columnId);
  if (!f) return undefined;
  if (typeof f.text === "string") return f.text;
  if (typeof f.value === "string") return f.value;
  const words: string[] = [];
  richTextWords(f.rich_text, words);
  return words.length > 0 ? words.join("") : undefined;
}

export function rowsTitled(items: readonly Record<string, unknown>[], titleId: string, title: string): Record<string, unknown>[] {
  const want = title.trim().toLowerCase();
  return items.filter((i) => rowFieldText(i, titleId)?.trim().toLowerCase() === want);
}

export function listWriteRow(rows: readonly AuditWireEntry[], listId: string, channelId: string, op: "added" | "changed"): AuditWireEntry | undefined {
  return rows
    .filter((r) => r.action === LIST_WRITE_ACTION && r.detail?.["listId"] === listId && r.detail?.["channel"] === channelId)
    .filter((r) => {
      const n = r.detail?.[op];
      return typeof n === "number" && n >= 1;
    })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
}
