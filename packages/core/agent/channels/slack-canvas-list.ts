import { bridgeSlackReadCall } from "./slack-bridge.js";

export type SlackDocCall = (method: string, params: Record<string, string | number | boolean>) => Promise<Record<string, unknown>>;

export const liveSlackDocCall: SlackDocCall = async (method, params) => (await bridgeSlackReadCall(method, params)) as Record<string, unknown>;

export const CANVAS_MARKDOWN_MAX = 90_000;
export const LIST_ROWS_MAX = 20;
const LIST_PAGES_MAX = 5;
export const LIST_CELL_TEXT_MAX = 300;

export function slackFileIdOf(ref: string): string | undefined {
  const t = ref.trim();
  if (/^F[A-Z0-9]{6,}$/.test(t)) return t;
  const m = /\/(?:docs|lists|files)\/[A-Z0-9]+\/(F[A-Z0-9]{6,})(?:[/?#]|$)/.exec(t);
  return m?.[1];
}

export function defuseDocText(markdown: string): string {
  return markdown.replace(/!\[/g, "!\\[").replace(/<([@!#])/g, "‹$1");
}

export interface ListColumn {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly primary: boolean;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
}

export interface RoomFile {
  readonly id: string;
  readonly title: string;
  readonly kind: "canvas" | "list";
  readonly columns: readonly ListColumn[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function fileRooms(file: Record<string, unknown>): Set<string> {
  const rooms = new Set<string>();
  for (const k of ["channels", "groups", "ims"]) {
    const list = file[k];
    if (Array.isArray(list)) for (const c of list) if (typeof c === "string") rooms.add(c);
  }
  const shares = file.shares as { public?: unknown; private?: unknown } | undefined;
  for (const side of [shares?.public, shares?.private]) {
    if (side && typeof side === "object") for (const c of Object.keys(side as Record<string, unknown>)) rooms.add(c);
  }
  return rooms;
}

export function fileKind(file: Record<string, unknown>): "canvas" | "list" | undefined {
  const type = `${str(file.filetype) ?? ""} ${str(file.pretty_type) ?? ""}`.toLowerCase();
  if (file.list_metadata !== undefined || /\blist\b/.test(type)) return "list";
  if (/\b(quip|canvas)\b/.test(type)) return "canvas";
  return undefined;
}

export function listColumnsOf(file: Record<string, unknown>): ListColumn[] {
  const schema = (file.list_metadata as { schema?: unknown } | undefined)?.schema;
  if (!Array.isArray(schema)) return [];
  const out: ListColumn[] = [];
  for (const raw of schema) {
    const c = raw as Record<string, unknown>;
    const id = str(c.id);
    if (!id) continue;
    const choicesRaw = (c.options as { choices?: unknown } | undefined)?.choices;
    const choices = Array.isArray(choicesRaw)
      ? choicesRaw.flatMap((ch) => {
          const value = str((ch as Record<string, unknown>).value);
          if (!value) return [];
          return [{ value, label: str((ch as Record<string, unknown>).label) ?? value }];
        })
      : [];
    out.push({ id, name: str(c.name) ?? str(c.key) ?? id, type: str(c.type) ?? "text", primary: c.is_primary_column === true, choices });
  }
  return out;
}

export async function resolveRoomFile(call: SlackDocCall, ref: string, channelId: string, want: "canvas" | "list"): Promise<RoomFile> {
  const noun = want === "canvas" ? "canvas" : "List";
  const id = slackFileIdOf(ref);
  if (!id) throw new Error(`That does not read as a Slack ${noun} link. Paste the ${noun}'s link from Slack.`);
  let file: Record<string, unknown>;
  try {
    const res = await call("files.info", { file: id });
    file = (res.file as Record<string, unknown> | undefined) ?? {};
  } catch {
    throw new Error(`I could not open that ${noun}. It may be deleted, or I may not have access to it.`);
  }
  const kind = fileKind(file);
  if (kind !== want) throw new Error(`That link is not a Slack ${noun}.`);
  let inRoom = fileRooms(file).has(channelId);
  if (!inRoom && want === "canvas") {
    const info = await call("conversations.info", { channel: channelId }).catch(() => undefined);
    const own = (info?.channel as { properties?: { canvas?: { file_id?: unknown } } } | undefined)?.properties?.canvas?.file_id;
    inRoom = own === id;
  }
  if (!inRoom) throw new Error(`That ${noun} is not shared in this conversation. I only change a ${noun} that this conversation shows.`);
  const title = str(file.title) ?? str(file.name) ?? `untitled ${noun}`;
  return { id, title, kind, columns: kind === "list" ? listColumnsOf(file) : [] };
}

export interface ListCell {
  readonly columnId: string;
  readonly column: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly shown: string;
}

function richTextOf(text: string): unknown[] {
  return [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }] }];
}

const TRUE_WORDS = new Set(["yes", "true", "done", "checked", "complete", "completed", "y", "1", "x"]);
const FALSE_WORDS = new Set(["no", "false", "not done", "unchecked", "open", "n", "0", ""]);

export function encodeListCell(column: ListColumn, raw: string): ListCell {
  const v = raw.trim();
  const base = { columnId: column.id, column: column.name };
  switch (column.type) {
    case "user":
    case "todo_assignee": {
      const m = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(v) ?? /^([UW][A-Z0-9]{6,})$/.exec(v);
      if (!m) throw new Error(`The "${column.name}" column takes a person as a Slack mention. Look the person up first, then pass their mention.`);
      return { ...base, value: { user: [m[1]] }, shown: `<@${m[1]}>` };
    }
    case "date":
    case "todo_due_date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        throw new Error(`The "${column.name}" column takes a date as YYYY-MM-DD.`);
      }
      return { ...base, value: { date: [v] }, shown: v };
    }
    case "select": {
      const want = v.toLowerCase();
      const choice = column.choices.find((c) => c.label.toLowerCase() === want || c.value.toLowerCase() === want);
      if (!choice) {
        const names = column.choices.map((c) => `"${c.label}"`).join(", ");
        throw new Error(`The "${column.name}" column takes one of: ${names || "(no choices)"}.`);
      }
      return { ...base, value: { select: [choice.value] }, shown: choice.label };
    }
    case "checkbox":
    case "todo_completed": {
      const want = v.toLowerCase();
      if (TRUE_WORDS.has(want)) return { ...base, value: { checkbox: true }, shown: "yes" };
      if (FALSE_WORDS.has(want)) return { ...base, value: { checkbox: false }, shown: "no" };
      throw new Error(`The "${column.name}" column takes yes or no.`);
    }
    case "number":
    case "rating": {
      const n = Number(v);
      if (v.length === 0 || !Number.isFinite(n)) throw new Error(`The "${column.name}" column takes a number.`);
      return { ...base, value: { number: [n] }, shown: String(n) };
    }
    case "text":
    case "rich_text":
    case "message":
    case "email":
    case "phone":
    case "link":
      if (v.length > LIST_CELL_TEXT_MAX) throw new Error(`The "${column.name}" value is ${v.length} characters, and one cell takes at most ${LIST_CELL_TEXT_MAX}.`);
      return { ...base, value: { rich_text: richTextOf(defuseDocText(v)) }, shown: v };
    default:
      throw new Error(`I cannot write the "${column.name}" column yet (it holds ${column.type} values). Leave it out.`);
  }
}

export function columnByName(columns: readonly ListColumn[], name: string): ListColumn | undefined {
  const want = name.trim().toLowerCase();
  return columns.find((c) => c.name.toLowerCase() === want);
}

export function encodeListRow(columns: readonly ListColumn[], cells: Readonly<Record<string, string>>): ListCell[] {
  const out: ListCell[] = [];
  for (const [name, raw] of Object.entries(cells)) {
    const column = columnByName(columns, name);
    if (!column) throw new Error(`This List has no "${name}" column. Its columns are: ${columns.map((c) => `"${c.name}"`).join(", ")}.`);
    out.push(encodeListCell(column, raw));
  }
  if (out.length === 0) throw new Error("A row needs at least one column value.");
  return out;
}

export function primaryColumn(columns: readonly ListColumn[]): ListColumn | undefined {
  return columns.find((c) => c.primary) ?? columns.find((c) => c.type === "text" || c.type === "rich_text");
}

export function itemFieldText(item: Record<string, unknown>, columnId: string): string | undefined {
  const fields = item.fields;
  if (!Array.isArray(fields)) return undefined;
  for (const f of fields as Record<string, unknown>[]) {
    if (f.column_id !== columnId) continue;
    if (typeof f.text === "string") return f.text;
    if (typeof f.value === "string") return f.value;
    const flat = JSON.stringify(f.rich_text ?? "").match(/"text":"((?:[^"\\]|\\.)*)"/g);
    return flat ? flat.map((s) => JSON.parse(s.slice(7)) as string).join("") : undefined;
  }
  return undefined;
}

export async function findListRow(call: SlackDocCall, listId: string, columns: readonly ListColumn[], name: string): Promise<{ readonly rowId: string; readonly title: string }> {
  const key = primaryColumn(columns);
  if (!key) throw new Error("I could not tell which column names the rows of this List.");
  const want = name.trim().toLowerCase();
  const hits: { rowId: string; title: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES_MAX; page++) {
    const res = await call("slackLists.items.list", { list_id: listId, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const item of Array.isArray(res.items) ? (res.items as Record<string, unknown>[]) : []) {
      const title = itemFieldText(item, key.id);
      const rowId = str(item.id);
      if (rowId && title !== undefined && title.trim().toLowerCase() === want) hits.push({ rowId, title: title.trim() });
    }
    cursor = str((res.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor);
    if (!cursor) break;
  }
  if (cursor) throw new Error(`This List has more than ${LIST_PAGES_MAX * 100} rows, so I cannot match a row by its name safely.`);
  if (hits.length === 0) throw new Error(`No row in this List has "${name}" in its "${key.name}" column.`);
  if (hits.length > 1) throw new Error(`${hits.length} rows in this List have "${name}" in their "${key.name}" column. Name the row more exactly.`);
  return hits[0]!;
}

export function initialField(cell: ListCell): Record<string, unknown> {
  return { column_id: cell.columnId, ...cell.value };
}

export function updateCell(rowId: string, cell: ListCell): Record<string, unknown> {
  return { row_id: rowId, column_id: cell.columnId, ...cell.value };
}

export function rowWords(title: string | undefined, cells: readonly ListCell[]): string {
  const parts = cells.map((c) => `${c.column} ${c.shown}`).join(", ");
  return title ? `${title}: ${parts}` : parts;
}
