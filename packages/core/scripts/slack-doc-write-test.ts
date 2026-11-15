import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-slack-doc-write-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.DATABASE_URL;

const lib = await import("../agent/channels/slack-canvas-list.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { auditErrorDetail } = await import("../agent/audit/tool-action.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { registerSlackBridge, _resetSlackBridgeForTest } = await import("../agent/channels/slack-bridge.js");
const { rawIdLeaks } = await import("../agent/channels/friendly-ids.js");
const { TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
const { WINDOW_UNGATED_TOOLS } = await import("../agent/access/window-gate-manifest.js");
const { LEAN_SEAT_TOOLS } = await import("../agent/access/lean-seat.js");
const { buildCanvasWrite } = await import("../agent/tools/write_canvas.js");
const { buildListWrite } = await import("../agent/tools/update_list.js");
await import("../agent/approvals/flow.js");
type CanvasWriteArgs = import("../agent/approvals/slack-doc-write.js").CanvasWriteArgs;
type ListWriteArgs = import("../agent/approvals/slack-doc-write.js").ListWriteArgs;
type SlackDocCall = import("../agent/channels/slack-canvas-list.js").SlackDocCall;

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
async function refuses(fn: () => Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error && pattern.test(err.message), `${label} (got: ${err instanceof Error ? err.message : String(err)})`);
}

const ROOM = "C0ROOM01";
const OTHER = "C0OTHER1";
const CANVAS = "F0CANVAS1";
const OWN_CANVAS = "F0CHANCV1";
const FREE_ROOM = "C0FREEROOM";
const ELSEWHERE = "F0ELSEWH1";
const BOT = "U0BOTUSR1";
const MEM_ROOM = "C0MEMROOM";
const MEM_CANVAS = "F0MEMCNV1";
const BOT_MADE = "F0BOTMAD1";
const TAB_ROOM = "C0TABROOM";
const TAB_PERSON = "F0TABPER1";
const TAB_MEM = "F0TABMEM1";
const ROW_ROOM = "C0ROWROOM";
const ROW_MEM = "F0ROWMEM1";
const ROW_WC = "F0ROWWCV1";
const MARKED = new Set([TAB_MEM, ROW_MEM]);
const LIST = "F0LIST001";
const COLUMNS = [
  { id: "Col0Title", name: "Title", type: "text", is_primary_column: true },
  { id: "Col0Owner", name: "Owner", type: "user" },
  { id: "Col0State", name: "Status", type: "select", options: { choices: [{ value: "Opt0Todo", label: "To do" }, { value: "Opt0Prog", label: "In progress" }, { value: "Opt0Done", label: "Done" }] } },
  { id: "Col0Due", name: "Due", type: "date" },
  { id: "Col0Done", name: "Shipped", type: "checkbox" },
  { id: "Col0File", name: "Files", type: "attachment" },
];
const ITEMS = [
  { id: "Rec0Login", fields: [{ column_id: "Col0Title", text: "Fix login" }] },
  { id: "Rec0Dup1", fields: [{ column_id: "Col0Title", text: "Write docs" }] },
  { id: "Rec0Dup2", fields: [{ column_id: "Col0Title", rich_text: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Write docs" }] }] }] }] },
];

const files: Record<string, Record<string, unknown>> = {
  [CANVAS]: { id: CANVAS, title: "Launch plan", filetype: "quip", pretty_type: "Canvas", channels: [ROOM] },
  [OWN_CANVAS]: { id: OWN_CANVAS, title: "Channel canvas", filetype: "quip", pretty_type: "Canvas", user: "U0PERSON1" },
  [MEM_CANVAS]: { id: MEM_CANVAS, title: "What the agent knows", filetype: "quip", pretty_type: "Canvas", user: BOT },
  [TAB_PERSON]: { id: TAB_PERSON, title: "Team notes", filetype: "quip", pretty_type: "Canvas", user: "U0PERSON1" },
  [TAB_MEM]: { id: TAB_MEM, title: "What the agent knows", filetype: "quip", pretty_type: "Canvas", user: BOT },
  [ROW_MEM]: { id: ROW_MEM, title: "What the agent knows", filetype: "quip", pretty_type: "Canvas", user: BOT },
  [ROW_WC]: { id: ROW_WC, title: "How the memory canvas works", filetype: "quip", pretty_type: "Canvas", user: BOT, channels: [ROW_ROOM] },
  [BOT_MADE]: { id: BOT_MADE, title: "Retro", filetype: "quip", pretty_type: "Canvas", user: BOT, channels: [MEM_ROOM] },
  [ELSEWHERE]: { id: ELSEWHERE, title: "Secret plan", filetype: "quip", pretty_type: "Canvas", channels: [OTHER] },
  [LIST]: { id: LIST, title: "Bugs", filetype: "list", pretty_type: "List", shares: { private: { [ROOM]: [] } }, list_metadata: { schema: COLUMNS } },
};

const calls: { method: string; params: Record<string, string | number | boolean> }[] = [];
const fakeCall: SlackDocCall = async (method, params) => {
  calls.push({ method, params });
  if (method === "files.info") {
    const f = files[String(params.file)];
    if (!f) throw new Error("Slack files.info failed: file_not_found");
    return { ok: true, file: f };
  }
  if (method === "conversations.info") {
    const tabOf = (id: string) => ({ type: "canvas", data: { file_id: id } });
    if (params.channel === TAB_ROOM) return { ok: true, channel: { id: params.channel, properties: { tabs: [{ type: "files" }, tabOf(TAB_PERSON), tabOf(TAB_MEM)] } } };
    if (params.channel === ROW_ROOM) return { ok: true, channel: { id: params.channel, properties: { tabs: [tabOf(ROW_WC), tabOf(ROW_MEM)] } } };
    if (params.channel === MEM_ROOM) return { ok: true, channel: { id: params.channel, properties: { canvas: { file_id: MEM_CANVAS }, tabs: [tabOf(MEM_CANVAS), tabOf(BOT_MADE)] } } };
    const own = params.channel === ROOM ? OWN_CANVAS : undefined;
    return { ok: true, channel: { id: params.channel, properties: own ? { canvas: { file_id: own } } : {} } };
  }
  if (method === "auth.test") return { ok: true, user_id: BOT };
  if (method === "canvases.sections.lookup") return { ok: true, sections: MARKED.has(String(params.canvas_id)) ? [{ id: "temp:C:1" }] : [] };
  if (method === "slackLists.items.list") return { ok: true, items: ITEMS };
  if (method === "canvases.create") {
    if (params.channel_id === FREE_ROOM) throw new Error("Slack canvases.create failed: free_team_canvas_tab_already_exists");
    return { ok: true, canvas_id: "F0NEWCANV" };
  }
  if (method === "slackLists.items.create") return { ok: true, item: { id: "Rec0New" } };
  return { ok: true };
};

const P = { org: "default", scopeKey: `slack/T0TEAM01/${ROOM}`, channelId: ROOM, requestedBy: "U0ASKER01", tainted: false };

{
  ok(lib.slackFileIdOf("F0CANVAS1") === "F0CANVAS1", "a bare file id reads as itself");
  ok(lib.slackFileIdOf("https://acme.slack.com/docs/T0TEAM01/F0CANVAS1") === "F0CANVAS1", "a canvas link yields its file id");
  ok(lib.slackFileIdOf("https://acme.slack.com/lists/T0TEAM01/F0LIST001?record_id=Rec1") === "F0LIST001", "a List link yields its file id");
  ok(lib.slackFileIdOf("our launch plan") === undefined, "words that name no file yield nothing");
  ok(lib.defuseDocText("hi <!channel> and <@U1> ![](@U2)") === "hi ‹!channel> and ‹@U1> !\\[](@U2)", "a broadcast, a mention and an image mention are all defused");
  const cols = lib.listColumnsOf(files[LIST]!);
  ok(cols.length === 6 && cols[0]!.primary && cols[2]!.choices.length === 3, "the List schema reads into columns, with the primary column and the select choices");
  const by = (name: string) => lib.columnByName(cols, name)!;
  ok(JSON.stringify(lib.encodeListCell(by("owner"), "<@U0ANN001>").value) === JSON.stringify({ user: ["U0ANN001"] }), "a person column takes a mention");
  ok(lib.encodeListCell(by("Owner"), "<@U0ANN001>").shown === "<@U0ANN001>", "the pure encoder gives a person as a mention; the propose step swaps in the display name for the card");
  ok(JSON.stringify(lib.encodeListCell(by("Status"), "in progress").value) === JSON.stringify({ select: ["Opt0Prog"] }), "a select column matches a choice by its label, ignoring case");
  ok(lib.encodeListCell(by("Status"), "in progress").shown === "In progress", "a select shows its label, never the option id");
  ok(JSON.stringify(lib.encodeListCell(by("Due"), "2026-10-20").value) === JSON.stringify({ date: ["2026-10-20"] }), "a date column takes YYYY-MM-DD");
  ok(JSON.stringify(lib.encodeListCell(by("Shipped"), "Done").value) === JSON.stringify({ checkbox: true }), "a checkbox takes done as yes");
  const text = lib.encodeListCell(by("Title"), "Fix <!here> login").value as { rich_text: unknown[] };
  ok(JSON.stringify(text).includes("Fix ‹!here> login"), "a text cell is rich text, and a broadcast in it is defused");
  await refuses(async () => lib.encodeListCell(by("Owner"), "Ann"), /takes a person as a Slack mention/, "a person by name refuses and says to look them up");
  await refuses(async () => lib.encodeListCell(by("Due"), "next Friday"), /YYYY-MM-DD/, "a date in words refuses");
  await refuses(async () => lib.encodeListCell(by("Status"), "Blocked"), /"To do", "In progress", "Done"/, "a status that is no choice refuses and lists the choices");
  await refuses(async () => lib.encodeListCell(by("Files"), "x"), /cannot write the "Files" column/, "a column type the agent cannot write refuses by name");
  await refuses(async () => lib.encodeListRow(cols, { Priority: "high" }), /no "Priority" column.*"Title", "Owner"/, "an unknown column refuses and names the List's columns");
}

{
  const f = await lib.resolveRoomFile(fakeCall, `https://acme.slack.com/docs/T0TEAM01/${CANVAS}`, ROOM, "canvas");
  ok(f.id === CANVAS && f.title === "Launch plan" && f.kind === "canvas", "a canvas shared in the room resolves, with its title");
  const own = await lib.resolveRoomFile(fakeCall, OWN_CANVAS, ROOM, "canvas");
  ok(own.id === OWN_CANVAS, "the room's own channel canvas resolves, though files.info lists no share");
  const list = await lib.resolveRoomFile(fakeCall, LIST, ROOM, "list");
  ok(list.kind === "list" && list.columns.length === 6, "a List shared privately in the room resolves, with its columns");
  await refuses(() => lib.resolveRoomFile(fakeCall, ELSEWHERE, ROOM, "canvas"), /not shared in this conversation/, "🔴 a canvas shared only in ANOTHER room refuses");
  await refuses(() => lib.resolveRoomFile(fakeCall, LIST, ROOM, "canvas"), /not a Slack canvas/, "a List named as a canvas refuses");
  await refuses(() => lib.resolveRoomFile(fakeCall, "F0MISSING", ROOM, "canvas"), /could not open that canvas/, "a file Slack will not read refuses in words");
  await refuses(() => lib.resolveRoomFile(fakeCall, "the plan", ROOM, "list"), /does not read as a Slack List link/, "a name that is no link refuses");
}

{
  const create = await buildCanvasWrite({ title: "Retro", markdown: "# Notes\n- <!channel> ship it" }, P, fakeCall);
  ok(create.op === "create" && create.title === "Retro" && create.channelId === ROOM, "no canvas named: a NEW canvas in the asking room");
  ok(create.markdown.includes("‹!channel>"), "the frozen markdown is defused");
  await refuses(() => buildCanvasWrite({ markdown: "x" }, P, fakeCall), /needs a title/, "a new canvas without a title refuses");
  const append = await buildCanvasWrite({ canvas: CANVAS, markdown: "more" }, P, fakeCall);
  ok(append.op === "append" && append.canvasId === CANVAS && append.title === "Launch plan", "a named canvas defaults to append, and takes the canvas's own title");
  const replace = await buildCanvasWrite({ canvas: CANVAS, mode: "replace", markdown: "all new" }, P, fakeCall);
  ok(replace.op === "replace", "mode replace freezes a rewrite");
  await refuses(() => buildCanvasWrite({ canvas: ELSEWHERE, markdown: "x" }, P, fakeCall), /write_canvas: .*not shared in this conversation/, "🔴 the builder refuses a canvas from another room before any card");
  await refuses(() => buildCanvasWrite({ title: "Big", markdown: "x".repeat(lib.CANVAS_MARKDOWN_MAX + 1) }, P, fakeCall), /at most 90000/, "an over-long canvas refuses before any card");

  const M = { ...P, scopeKey: `slack/T0TEAM01/${MEM_ROOM}`, channelId: MEM_ROOM };
  const memLine = new RegExp(`^write_canvas: ${lib.MEMORY_CANVAS_WRITE_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  await refuses(() => buildCanvasWrite({ canvas: MEM_CANVAS, markdown: "my notes" }, M, fakeCall), memLine, "🔴 an append to the memory canvas refuses in one honest line before any card");
  await refuses(() => buildCanvasWrite({ canvas: MEM_CANVAS, mode: "replace", markdown: "all new" }, M, fakeCall), memLine, "🔴 a rewrite of the memory canvas refuses the same way");
  ok(/remember or forget/.test(lib.MEMORY_CANVAS_WRITE_REFUSAL) && !lib.MEMORY_CANVAS_WRITE_REFUSAL.includes("\n"), "the refusal is one line and points to the memory verbs");
  ok((await buildCanvasWrite({ canvas: OWN_CANVAS, markdown: "more" }, P, fakeCall)).canvasId === OWN_CANVAS, "a PERSON's channel canvas still takes an append: the observer never touches it");
  ok((await buildCanvasWrite({ canvas: BOT_MADE, markdown: "more" }, M, fakeCall)).canvasId === BOT_MADE, "a canvas the app made that is NOT the channel canvas still takes an append");
  const noAuth: SlackDocCall = async (method, params) => {
    if (method === "auth.test") throw new Error("Slack auth.test failed: invalid_auth");
    return fakeCall(method, params);
  };
  await refuses(() => buildCanvasWrite({ canvas: MEM_CANVAS, markdown: "x" }, M, noAuth), /could not confirm that this canvas is not this channel's memory canvas/, "🔴 an unreadable bot identity refuses: the write could be lost");
  const noInfo: SlackDocCall = async (method, params) => {
    if (method === "conversations.info") throw new Error("Slack conversations.info failed: ratelimited");
    return fakeCall(method, params);
  };
  await refuses(() => buildCanvasWrite({ canvas: BOT_MADE, markdown: "x" }, M, noInfo), /could not confirm that this canvas is not this channel's memory canvas/, "🔴 an unreadable channel refuses: the canvas could be the memory canvas");
  let fileReads = 0;
  const secondFileFails: SlackDocCall = async (method, params) => {
    if (method === "files.info" && ++fileReads === 2) throw new Error("Slack files.info failed: ratelimited");
    return fakeCall(method, params);
  };
  await refuses(() => buildCanvasWrite({ canvas: MEM_CANVAS, markdown: "x" }, M, secondFileFails), /could not confirm that this canvas is not this channel's memory canvas/, "🔴 an unreadable creator refuses: the canvas could be the app's");
  ok(lib.channelCanvasIdOf({ ok: true, channel: { properties: { canvas: { file_id: "F1" } } } }) === "F1" && lib.channelCanvasIdOf(undefined) === undefined && lib.channelCanvasIdOf({ channel: { properties: { canvas: { file_id: "" } } } }) === undefined, "the shared channel canvas reader names the canvas, and nothing for no answer or an empty id");
  const T = { ...P, scopeKey: `slack/T0TEAM01/${TAB_ROOM}`, channelId: TAB_ROOM };
  await refuses(() => buildCanvasWrite({ canvas: TAB_MEM, markdown: "my notes" }, T, fakeCall), memLine, "🔴 [OPE-2587] a memory canvas held only as a TAB (made before the row existed) refuses by its marker");
  ok((await buildCanvasWrite({ canvas: TAB_PERSON, markdown: "more" }, T, fakeCall)).canvasId === TAB_PERSON, "🔴 [OPE-2587] a person's canvas TAB is this room's canvas, so it takes an append");
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  await getOperationalStore().setMemoryCanvas("default", lib.memoryCanvasSurfaceKey("T0TEAM01", ROW_ROOM), ROW_MEM, "2026-10-18T00:00:00Z");
  const R = { ...P, scopeKey: `slack/T0TEAM01/${ROW_ROOM}`, channelId: ROW_ROOM };
  await refuses(() => buildCanvasWrite({ canvas: ROW_MEM, markdown: "x" }, R, fakeCall), memLine, "🔴 [OPE-2587] the canvas the memory_canvas row names refuses");
  ok((await buildCanvasWrite({ canvas: ROW_WC, markdown: "more" }, R, fakeCall)).canvasId === ROW_WC, "🔴 [OPE-2587] a write_canvas canvas beside it takes an append");
  const markerLine = new RegExp(`^write_canvas: ${lib.MEMORY_CANVAS_MARKER_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  await refuses(() => buildCanvasWrite({ title: "How it works", markdown: `Notes.\n\n${lib.MEMORY_CANVAS_MARKER}` }, R, fakeCall), markerLine, "🔴 [OPE-2587] a create whose text quotes the memory canvas marker refuses");
  await refuses(() => buildCanvasWrite({ canvas: ROW_WC, markdown: "EDITS  made directly to this canvas get replaced" }, R, fakeCall), markerLine, "🔴 …and so does an append with a near copy (case, spacing, no full stop)");
  await refuses(() => buildCanvasWrite({ canvas: ROW_WC, markdown: "Edits made **directly** to _this_ canvas get `replaced`." }, R, fakeCall), markerLine, "🔴 …and a copy with formatting inside it, which Slack shows as the plain line");
  await refuses(() => buildCanvasWrite({ canvas: ROW_WC, markdown: "[Edits made](https://example.com) directly to this canvas get replaced" }, R, fakeCall), markerLine, "🔴 …and a copy split by a link");
  await refuses(() => buildCanvasWrite({ canvas: ROW_WC, markdown: "Edits made dir\u200Bectly to this\u00A0canvas get replaced" }, R, fakeCall), markerLine, "🔴 …and a copy with a zero-width or non-breaking space");
  await refuses(() => buildCanvasWrite({ title: "Edits made directly to this canvas get replaced.", markdown: "notes" }, R, fakeCall), markerLine, "🔴 …and a create whose TITLE quotes the marker");
  ok((await buildCanvasWrite({ title: "How it works", markdown: "Edits made here are kept." }, R, fakeCall)).op === "create", "NEGATIVE CONTROL: text that does not quote the marker takes the write");
  const noLookup: SlackDocCall = async (method, params) => {
    if (method === "canvases.sections.lookup") throw new Error("Slack canvases.sections.lookup failed: missing_scope");
    return fakeCall(method, params);
  };
  await refuses(() => buildCanvasWrite({ canvas: TAB_MEM, markdown: "x" }, T, noLookup), /could not confirm that this canvas is not this channel's memory canvas/, "🔴 [OPE-2587] with no canvases:read, a bot-made tab could be the memory canvas: it refuses");
  ok((await buildCanvasWrite({ canvas: ROW_WC, markdown: "x" }, R, noLookup)).canvasId === ROW_WC, "…but a room whose row names a canvas on screen needs no section read");
  await getOperationalStore().setMemoryCanvas("default", lib.memoryCanvasSurfaceKey("T0TEAM01", TAB_ROOM), "F0GONECV1", "2026-10-18T00:00:00Z");
  await refuses(() => buildCanvasWrite({ canvas: TAB_MEM, markdown: "x" }, T, fakeCall), memLine, "🔴 [OPE-2587] with a stale row, the marked memory canvas tab still refuses");
  ok((await buildCanvasWrite({ canvas: TAB_PERSON, markdown: "more" }, T, fakeCall)).canvasId === TAB_PERSON, "…and a person's canvas tab still takes the write");
  const both = { ok: true, channel: { properties: { canvas: { file_id: "F1" }, tabs: [{ type: "canvas", data: { file_id: "F2" } }, { type: "canvas", data: { file_id: "F1" } }] } } };
  ok(JSON.stringify(lib.channelCanvasIdsOf(both)) === JSON.stringify(["F1", "F2"]) && lib.channelCanvasIdOf(both) === "F1", "every canvas id is read, the canvas field first, with no id twice");
  ok(
    lib.channelCanvasIdsOf({ ok: true, channel: { properties: { tabs: [{ type: "files", data: { file_id: "F9" } }, { type: "canvas", data: {} }, null, "junk"] } } }).length === 0 && lib.channelCanvasIdsOf(undefined).length === 0,
    "a non-canvas tab, a tab with no id, a malformed tab and no answer name no canvas",
  );

  const lw = await buildListWrite(
    { list: LIST, add: [{ cells: { Title: "New bug", Owner: "<@U0ANN001>", Status: "To do", Due: "2026-10-20" } }], update: [{ row: "fix LOGIN", cells: { Status: "Done" } }] },
    P,
    fakeCall,
    async (id) => (id === "U0ANN001" ? "Ann Lee" : undefined),
  );
  ok(lw.listId === LIST && lw.listTitle === "Bugs" && lw.rows.length === 2, "the List write freezes the List and both rows");
  ok(lw.rows[0]!.rowId === undefined && lw.rows[0]!.cells.length === 4, "the added row carries its four cells");
  ok(lw.rows[1]!.rowId === "Rec0Login" && lw.rows[1]!.title === "Fix login", "the changed row is matched by its title, ignoring case");
  ok(lw.rows[0]!.cells[1]!.shown === "Ann Lee", "🔴 a person reads on the card by their display name, never the id");
  await refuses(
    () => buildListWrite({ list: LIST, add: [{ cells: { Owner: "<@U0BOB0001>" } }] }, P, fakeCall, async () => undefined),
    /could not read the name of the person for the "Owner" column/,
    "🔴 a failed name lookup refuses: the card must show who the model assigned",
  );
  const dashy = [
    { cells: { Title: `a”b${"x—".repeat(130)}` } },
    ...Array.from({ length: 4 }, () => ({ cells: { Title: "y—".repeat(130) } })),
    { cells: { Title: "FINAL-ROW" } },
  ];
  const { listCardLine } = await import("../agent/approvals/slack-doc-write.js");
  const tight = await buildListWrite({ list: LIST, add: dashy }, P, fakeCall, async () => undefined);
  const tightLine = listCardLine(tight.rows);
  ok(tightLine.whole && tightLine.line.includes("FINAL-ROW"), `🔴 the FINISHED card line holds the last row, uncut (${tightLine.line.length} chars, ends ${JSON.stringify(tightLine.line.slice(-30))})`);
  const longRows = Array.from({ length: 6 }, (_, i) => ({ cells: [{ columnId: "c", column: "Title", value: {}, shown: `${"z".repeat(290)}${i}` }] }));
  ok(listCardLine(longRows as never).whole === false, "rows past the cap make a card line that is NOT whole (the refusal's trigger)");
  const quoteRows = [{ cells: [{ columnId: "c", column: "Title", value: {}, shown: `a”b${"x—".repeat(5)}` }] }];
  ok(!listCardLine(quoteRows as never).line.includes("a”b"), "a curly quote in a cell is neutralised in the card line");
  await refuses(
    () => buildListWrite({ list: LIST, add: [{ cells: { Title: "x".repeat(lib.LIST_CELL_TEXT_MAX + 1) } }] }, P, fakeCall, async () => undefined),
    /one cell takes at most 300/,
    "a text cell past the cap refuses: no silent cut",
  );
  const wide = Array.from({ length: 6 }, (_, i) => ({ cells: { Title: `${"y".repeat(280)}${i}` } }));
  await refuses(() => buildListWrite({ list: LIST, add: wide }, P, fakeCall, async () => undefined), /too long for one approval card/, "🔴 rows too long for one card refuse before the card, so the card never cuts a row");
  const paged: SlackDocCall = async (method, params) =>
    method === "slackLists.items.list" ? { ok: true, items: [{ id: "Rec0P" + String(params.cursor ?? "0"), fields: [{ column_id: "Col0Title", text: "Fix login" }] }].slice(0, params.cursor ? 0 : 1), response_metadata: { next_cursor: `c${Number(String(params.cursor ?? "c0").slice(1)) + 1}` } } : fakeCall(method, params);
  await refuses(() => buildListWrite({ list: LIST, update: [{ row: "Fix login", cells: { Status: "Done" } }] }, P, paged, async () => undefined), /more than 500 rows/, "🔴 a List longer than the walk refuses a match by name: a second match may sit past it");
  await refuses(() => buildListWrite({ list: LIST, update: [{ row: "Write docs", cells: { Status: "Done" } }] }, P, fakeCall), /2 rows .* "Write docs"/, "🔴 a row name that matches two rows refuses — no guessed row");
  await refuses(() => buildListWrite({ list: LIST, update: [{ row: "Nope", cells: { Status: "Done" } }] }, P, fakeCall), /No row in this List has "Nope"/, "a row name that matches none refuses");
  await refuses(() => buildListWrite({ list: LIST }, P, fakeCall), /at least one row/, "a call with no rows refuses");
  const many = Array.from({ length: lib.LIST_ROWS_MAX + 1 }, (_, i) => ({ cells: { Title: `r${i}` } }));
  await refuses(() => buildListWrite({ list: LIST, add: many }, P, fakeCall), /at most 20 rows/, "more than 20 rows refuses");
  await refuses(() => buildListWrite({ list: LIST, add: [{ cells: { Owner: "Ann" } }] }, P, fakeCall), /update_list: The "Owner" column takes a person/, "a bad cell refuses before any card, with the tool's name");
}

{
  const wc = TOOL_CONSEQUENCE.write_canvas!;
  const ul = TOOL_CONSEQUENCE.update_list!;
  ok(wc.tier === "gate:member" && wc.via.kind === "action-kind" && wc.via.action === "canvas.write", "write_canvas is gate:member via canvas.write");
  ok(ul.tier === "gate:member" && ul.via.kind === "action-kind" && ul.via.action === "list.write", "update_list is gate:member via list.write");
  ok(actionKind("canvas.write")?.policy === "member" && actionKind("list.write")?.policy === "member", "both kinds register with member policy");
  ok(WINDOW_UNGATED_TOOLS.has("write_canvas") && WINDOW_UNGATED_TOOLS.has("update_list"), "both tools mount on every grain (the room fence and the card are the control)");
  ok(!LEAN_SEAT_TOOLS.has("write_canvas") && !LEAN_SEAT_TOOLS.has("update_list"), "a delegating seat sheds both: a worker writes documents");
}

const canvasArgs = (over: Partial<CanvasWriteArgs> = {}): CanvasWriteArgs => ({
  org: "default",
  scopeKey: P.scopeKey,
  channelId: ROOM,
  op: "append",
  canvasId: CANVAS,
  title: "Launch plan",
  markdown: "## Decisions\n- Ship on Friday",
  requestedBy: "U0ASKER01",
  ...over,
});
const listArgs = (): ListWriteArgs => ({
  org: "default",
  scopeKey: P.scopeKey,
  channelId: ROOM,
  listId: LIST,
  listTitle: "Bugs",
  rows: [
    { cells: [{ columnId: "Col0Title", column: "Title", value: { rich_text: [] }, shown: "New bug" }, { columnId: "Col0Owner", column: "Owner", value: { user: ["U0ANN001"] }, shown: "Ann Lee" }] },
    { rowId: "Rec0Login", title: "Fix login", cells: [{ columnId: "Col0State", column: "Status", value: { select: ["Opt0Done"] }, shown: "Done" }] },
  ],
  requestedBy: "U0ASKER01",
});
{
  const ck = actionKind("canvas.write")!;
  const head = ck.plainSummary(canvasArgs() as never);
  ok(head === `Add to the canvas "Launch plan" in <#${ROOM}>`, `the canvas headline names the canvas and the room (${head})`);
  ok(ck.plainSummary(canvasArgs({ op: "create", canvasId: undefined, title: "Retro" }) as never).startsWith('Create the canvas "Retro"'), "a create reads as Create");
  ok(ck.plainSummary(canvasArgs({ op: "replace" }) as never).startsWith('Rewrite the canvas'), "a replace reads as Rewrite");
  ok(rawIdLeaks(head.replace(`<#${ROOM}>`, "")).length === 0, "the headline carries no raw id beside the room mention");
  const quote = ck.consequence!(canvasArgs() as never)!;
  ok(quote.includes("Ship on Friday"), "🔴 the card quotes the text that will land: the card is the preview");
  ok(ck.consequenceQuotes === true, "the canvas quote takes the long quote cap");

  const lk = actionKind("list.write")!;
  const lhead = lk.plainSummary(listArgs() as never);
  ok(lhead === `Add 1 row and change 1 row in the List "Bugs" in <#${ROOM}>`, `the List headline counts the rows (${lhead})`);
  const lq = lk.consequence!(listArgs() as never)!;
  ok(lq === "“Title New bug, Owner Ann Lee; Fix login: Status Done”", `🔴 the List card quotes EVERY row, in words (${lq})`);
  ok(lk.consequenceQuotes === true, "the List quote takes the long quote cap");
  ok(!lq.includes("Col0") && !lq.includes("Opt0"), "no column or option id reaches the card");
  const hostile = listArgs();
  const dirty = { ...hostile, rows: [{ cells: [{ columnId: "Col0Title", column: "Title", value: { rich_text: [] }, shown: "see <https://evil.example|our docs> <!channel>" }] }] };
  const dq = lk.consequence!(dirty as never)!;
  ok(!dq.includes("<!channel>") && !dq.includes("|our docs>"), `🔴 a model-written cell cannot carry a disguised link or a broadcast onto the card (${dq})`);
  ok(lk.summarize(listArgs() as never).some((l) => l.includes("Fix login: Status Done")), "the detail holds every row");
}

registerSlackBridge({ readCall: async (m: string, p: Record<string, string | number | boolean>) => (await fakeCall(m, p)) as { ok: boolean } } as never);
{
  calls.length = 0;
  const ck = actionKind("canvas.write")!;
  const outcome = await ck.execute(canvasArgs({ op: "create", canvasId: undefined, title: "Retro", markdown: "# Retro" }) as never, "U0APPROV1");
  const create = calls.find((c) => c.method === "canvases.create");
  ok(create !== undefined && create.params.channel_id === ROOM && create.params.title === "Retro", "a create sends canvases.create, tabbed in the asking room");
  ok(JSON.parse(String(create!.params.document_content)).markdown === "# Retro", "the canvas text is the frozen markdown, byte for byte");
  ok(outcome === `canvas "Retro" created in <#${ROOM}>`, `the decided card says what happened (${outcome})`);

  calls.length = 0;
  const free = canvasArgs({ op: "create", canvasId: undefined, title: "Free retro", markdown: "# Retro", channelId: FREE_ROOM });
  let freeErr = "";
  await ck.execute(free as never, "U0APPROV1").catch((e: unknown) => (freeErr = e instanceof Error ? e.message : String(e)));
  ok(
    freeErr === `canvas.write: the canvas "Free retro" was not written. This Slack workspace is on the free plan, which allows one canvas tab per channel, and <#${FREE_ROOM}> already has one (free_team_canvas_tab_already_exists).`,
    `🔴 a create on a free workspace whose room has a canvas tab refuses with the honest one-line reason (${freeErr})`,
  );
  ok(!freeErr.includes("\n") && !freeErr.includes("Slack canvases.create failed"), "the reason is one line, in words, not Slack's raw failure");
  let longErr = "";
  await ck.execute(canvasArgs({ ...free, title: "T".repeat(150) }) as never, "U0APPROV1").catch((e: unknown) => (longErr = e instanceof Error ? e.message : String(e)));
  const shown = auditErrorDetail(new Error(longErr)).error;
  ok(shown.endsWith("(free_team_canvas_tab_already_exists).") && shown.includes(`<#${FREE_ROOM}>`), `🔴 a 150-character title does not cut the free-plan reason off the card (${shown.length} chars)`);
  calls.length = 0;
  await ck.execute(free as never, "U0APPROV1").catch(() => undefined);
  ok(calls.filter((c) => c.method === "canvases.create").length === 1 && !calls.some((c) => c.method === "canvases.edit"), "🔴 the refusal sends no second create and edits no other canvas");

  calls.length = 0;
  let markerErr = "";
  await ck.execute(canvasArgs({ op: "create", canvasId: undefined, title: "Old card", markdown: lib.MEMORY_CANVAS_MARKER }) as never, "U0APPROV1").catch((e: unknown) => (markerErr = e instanceof Error ? e.message : String(e)));
  ok(markerErr.includes(lib.MEMORY_CANVAS_MARKER_REFUSAL) && calls.length === 0, "🔴 [OPE-2587] an approved card whose text quotes the marker writes nothing");
  calls.length = 0;
  let titleErr = "";
  await ck.execute(canvasArgs({ op: "create", canvasId: undefined, title: lib.MEMORY_CANVAS_MARKER, markdown: "notes" }) as never, "U0APPROV1").catch((e: unknown) => (titleErr = e instanceof Error ? e.message : String(e)));
  ok(titleErr.includes(lib.MEMORY_CANVAS_MARKER_REFUSAL) && calls.length === 0, "🔴 [OPE-2587] …and so does one whose title quotes it");

  calls.length = 0;
  await ck.execute(canvasArgs({ op: "replace" }) as never, "U0APPROV1");
  ok(calls[0]?.method === "files.info", "🔴 an edit re-runs the room fence at approval, before it writes");
  const edit = calls.find((c) => c.method === "canvases.edit");
  const change = JSON.parse(String(edit?.params.changes))[0];
  ok(edit?.params.canvas_id === CANVAS && change.operation === "replace", "a rewrite sends canvases.edit with a replace");
  calls.length = 0;
  await ck.execute(canvasArgs() as never, "U0APPROV1");
  ok(JSON.parse(String(calls.find((c) => c.method === "canvases.edit")?.params.changes))[0].operation === "insert_at_end", "an append sends insert_at_end");

  calls.length = 0;
  await refuses(
    () => ck.execute(canvasArgs({ channelId: MEM_ROOM, scopeKey: `slack/T0TEAM01/${MEM_ROOM}`, canvasId: MEM_CANVAS }) as never, "U0APPROV1"),
    /was not written\. That canvas is this channel's memory canvas/,
    "🔴 an approved append to the memory canvas refuses at approval",
  );
  ok(!calls.some((c) => c.method === "canvases.edit"), "🔴 and no edit reaches the memory canvas");

  calls.length = 0;
  await refuses(() => ck.execute(canvasArgs({ canvasId: ELSEWHERE }) as never, "U0APPROV1"), /was not written.*not shared in this conversation/, "🔴 a canvas that left the room refuses at approval");
  ok(!calls.some((c) => c.method === "canvases.edit"), "🔴 and no edit is sent");

  calls.length = 0;
  const lk = actionKind("list.write")!;
  const lout = await lk.execute(listArgs() as never, "U0APPROV1");
  const add = calls.find((c) => c.method === "slackLists.items.create");
  ok(add?.params.list_id === LIST, "an added row sends slackLists.items.create on the frozen List");
  const fields = JSON.parse(String(add!.params.initial_fields));
  ok(fields[1].column_id === "Col0Owner" && fields[1].user[0] === "U0ANN001", "the new row's cells are the frozen typed cells");
  const upd = calls.find((c) => c.method === "slackLists.items.update");
  const cells = JSON.parse(String(upd!.params.cells));
  ok(cells.length === 1 && cells[0].row_id === "Rec0Login" && cells[0].column_id === "Col0State" && cells[0].select[0] === "Opt0Done", "a changed row sends slackLists.items.update on the matched row");
  ok(lout === '1 row added and 1 row changed in the List "Bugs"', `the List outcome reads in words (${lout})`);
  ok(calls[0]?.method === "files.info" && calls[0]?.params.file === LIST, "🔴 a List write re-runs the room fence at approval, before it writes");

  files[LIST] = { ...files[LIST]!, shares: { private: { [OTHER]: [] } } };
  calls.length = 0;
  await refuses(() => lk.execute(listArgs() as never, "U0APPROV1"), /not fully updated.*not shared in this conversation/, "🔴 a List that left the room refuses at approval");
  ok(!calls.some((c) => c.method === "slackLists.items.create" || c.method === "slackLists.items.update"), "🔴 and no row is sent");

  const audit = await readAudit({ org: "default", limit: 20 });
  const cw = audit.find((a) => a.action === "canvas.write");
  const lw = audit.find((a) => a.action === "list.write");
  ok(cw !== undefined && cw.principalId === "U0APPROV1", "an approved canvas write writes a canvas.write row naming the approver");
  ok(!JSON.stringify(cw!.detail).includes("Decisions") && !JSON.stringify(cw!.detail).includes("Retro"), "the canvas.write row holds no text");
  ok((lw!.detail as Record<string, unknown>).added === 1 && (lw!.detail as Record<string, unknown>).changed === 1, "the list.write row counts the rows");
  ok(!audit.some((a) => a.action === "canvas.write" && (a.detail as Record<string, unknown>).canvasId === ELSEWHERE), "a refused approval writes no audit row");
  ok(!audit.some((a) => a.action === "canvas.write" && (a.detail as Record<string, unknown>).canvasId === MEM_CANVAS), "a refused memory-canvas write writes no canvas.write row");
  ok(!audit.some((a) => a.action === "canvas.write" && (a.detail as Record<string, unknown>).channel === FREE_ROOM), "a free-plan refusal writes no canvas.write row");
}
_resetSlackBridgeForTest();

console.log(`slack-doc-write: ${n} assertions passed`);

// proves: TOOL-write_canvas, TOOL-update_list
