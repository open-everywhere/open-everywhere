import assert from "node:assert/strict";
import type { AuditWireEntry } from "./audit-read.js";
import type { SlackRawCall } from "./memory-canvas.js";
import { LIST_FIXTURE_TITLE, LIST_WRITE_ACTION, findFixtureList, fixtureColumns, listWriteRow, readListRows, rowFieldText, rowsTitled } from "./list-fixture.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n += 1;
};

type Answer = (params: Record<string, string>) => Record<string, unknown>;
const fake = (routes: Record<string, Answer>): { call: SlackRawCall; calls: { method: string; params: Record<string, string> }[] } => {
  const calls: { method: string; params: Record<string, string> }[] = [];
  const call: SlackRawCall = async (method, params) => {
    calls.push({ method, params });
    const r = routes[method];
    return r ? r(params) : { ok: false, error: "unknown_method" };
  };
  return { call, calls };
};

const text = (t: string) => [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: t }] }] }];

await (async () => {
  const { call, calls } = fake({
    "files.list": (p) => {
      if (p.types === "lists") return { ok: true, files: [], paging: { pages: 0 } };
      if (p.page === "1") return { ok: true, files: [{ id: "F1", title: "OE canvas check x" }], paging: { pages: 2 } };
      return { ok: true, files: [{ id: "FLIST", title: ` ${LIST_FIXTURE_TITLE.toUpperCase()} `, permalink: "https://t.slack.com/lists/T0/FLIST" }], paging: { pages: 2 } };
    },
  });
  const r = await findFixtureList(call, "C1");
  ok(r.kind === "found" && r.id === "FLIST" && r.link === "https://t.slack.com/lists/T0/FLIST", "finds the fixture by its title on a later page, ignoring case and spaces, and keeps its permalink");
  ok(calls.every((c) => c.params.channel === "C1"), "every files.list call names the e2e channel");
  ok(calls.some((c) => c.params.types === "lists") && calls.some((c) => c.params.types === "all"), "tries the lists filter, then every file");
})();
await (async () => {
  const { call } = fake({ "files.list": () => ({ ok: true, files: [{ id: "F2", title: `${LIST_FIXTURE_TITLE} (old)` }, { id: "F3", title: "notes" }], paging: { pages: 1 } }) });
  const r = await findFixtureList(call, "C1");
  ok(r.kind === "absent" && r.scanned === 4, "no exact title ⇒ absent, with the count of files read (both passes)");
})();
await (async () => {
  const { call } = fake({ "files.list": () => ({ ok: false, error: "missing_scope", needed: "files:read" }) });
  const r = await findFixtureList(call, "C1");
  ok(r.kind === "missing-scope" && r.scope === "files:read" && r.method === "files.list", "a missing driver scope is named, never read as absent");
})();
await (async () => {
  const { call } = fake({ "files.list": () => ({ ok: true, files: [{ id: "FLIST", title: LIST_FIXTURE_TITLE }], paging: { pages: 1 } }) });
  const r = await findFixtureList(call, "C1");
  ok(r.kind === "found" && r.link === "FLIST", "no permalink ⇒ the bare file id is the link");
})();

await (async () => {
  const { call } = fake({ "files.list": () => ({ ok: false, error: "channel_not_found" }) });
  const r = await findFixtureList(call, "C1");
  ok(r.kind === "error" && r.error === "channel_not_found" && r.method === "files.list", "a non-scope Slack error is an error, never absent");
})();

const schemaFile = (schema: unknown) => () => ({ ok: true, file: { id: "FLIST", list_metadata: { schema } } });
await (async () => {
  const { call } = fake({
    "files.info": schemaFile([
      { id: "Col0", name: "Name", type: "text", is_primary_column: true },
      { id: "Col1", name: "Status", type: "select" },
      { id: "Col2", name: " note ", type: "rich_text" },
    ]),
  });
  const r = await fixtureColumns(call, "FLIST");
  ok(r.kind === "columns" && r.titleId === "Col0" && r.titleName === "Name" && r.noteId === "Col2", "reads the primary column and the Note column by name, ignoring case and spaces");
})();
await (async () => {
  const { call } = fake({ "files.info": () => ({ ok: true, file: { id: "FLIST", filetype: "quip" } }) });
  const r = await fixtureColumns(call, "FLIST");
  ok(r.kind === "unfit" && /not a Slack List/.test(r.why), "a file with no list schema (a canvas with the fixture title) is unfit");
})();
await (async () => {
  const { call } = fake({ "files.info": schemaFile([{ id: "Col0", name: "Name", type: "text", is_primary_column: true }]) });
  const r = await fixtureColumns(call, "FLIST");
  ok(r.kind === "unfit" && /no "Note" column/.test(r.why), "no Note column ⇒ unfit, and the reason names it");
})();
await (async () => {
  const { call } = fake({ "files.info": schemaFile([{ id: "Col0", name: "Name", type: "text", is_primary_column: true }, { id: "Col1", name: "Note", type: "date" }]) });
  const r = await fixtureColumns(call, "FLIST");
  ok(r.kind === "unfit" && /date values/.test(r.why), "a Note column that is not text ⇒ unfit");
})();
await (async () => {
  const { call } = fake({ "files.info": schemaFile([{ id: "Col1", name: "Note", type: "text" }]) });
  const r = await fixtureColumns(call, "FLIST");
  ok(r.kind === "unfit" && /primary/.test(r.why), "no primary column ⇒ unfit");
})();

await (async () => {
  const { call, calls } = fake({
    "slackLists.items.list": (p) =>
      p.cursor === undefined
        ? { ok: true, items: [{ id: "R1", fields: [{ column_id: "Col0", rich_text: text("Row one") }] }], response_metadata: { next_cursor: "c2" } }
        : { ok: true, items: [{ id: "R2", fields: [{ column_id: "Col0", text: "OE list row listrow-1" }, { column_id: "Col2", rich_text: text("listnote-7") }] }] },
  });
  const r = await readListRows(call, "FLIST");
  ok(r.kind === "rows" && r.items.length === 2, "walks every page of rows");
  ok(calls[1]?.params.cursor === "c2" && calls.every((c) => c.params.list_id === "FLIST"), "follows the cursor on the same List");
  if (r.kind === "rows") {
    ok(rowsTitled(r.items, "Col0", " oe list ROW listrow-1 ").map((i) => i.id).join() === "R2", "finds a row by its title, ignoring case and spaces");
    ok(rowsTitled(r.items, "Col0", "OE list row listrow-2").length === 0, "negative control: another run's title finds no row");
    ok(rowsTitled(r.items, "Col2", "OE list row listrow-1").length === 0, "negative control: the title read from another column finds no row");
    ok(rowFieldText(r.items[1]!, "Col2") === "listnote-7", "reads a rich-text cell as its plain text");
    ok(rowFieldText(r.items[0]!, "Col2") === undefined, "a row with no field for the column has no text");
  }
})();
await (async () => {
  const { call } = fake({ "slackLists.items.list": () => ({ ok: false, error: "missing_scope", needed: "lists:read" }) });
  const r = await readListRows(call, "FLIST");
  ok(r.kind === "missing-scope" && r.scope === "lists:read", "the lists:read scope the driver lacks is named");
})();
await (async () => {
  const { call } = fake({ "slackLists.items.list": () => ({ ok: false, error: "list_not_found" }) });
  const r = await readListRows(call, "FLIST");
  ok(r.kind === "error" && r.error === "list_not_found", "a non-scope Slack error on the row read is an error, never an empty List");
})();
ok(rowFieldText({ fields: [{ column_id: "C", value: "plain" }] }, "C") === "plain", "a string value is the cell's text");
ok(
  rowFieldText({ fields: [{ column_id: "C", rich_text: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "a" }, { type: "user", user_id: "U1" }, { type: "text", text: "b" }] }] }] }] }, "C") === "ab",
  "only the text elements of a rich-text cell count",
);

{
  const row = (ts: string, detail: Record<string, unknown>, action = LIST_WRITE_ACTION): AuditWireEntry => ({ ts, org: "default", platform: "slack", workspace: "T0", surface: "C1", action, detail });
  const add = row("2026-10-20T00:00:01Z", { channel: "C1", listId: "FLIST", added: 1, changed: 0 });
  const edit = row("2026-10-20T00:00:09Z", { channel: "C1", listId: "FLIST", added: 0, changed: 1 });
  ok(listWriteRow([add, edit], "FLIST", "C1", "added") === add, "the add half picks the row that added a row");
  ok(listWriteRow([add, edit], "FLIST", "C1", "changed") === edit, "the edit half picks the row that changed a row");
  ok(listWriteRow([add], "FLIST", "C1", "changed") === undefined, "negative control: an add row is never the edit's row");
  ok(listWriteRow([row("2026-10-20T00:00:01Z", { channel: "C1", listId: "FOTHER", added: 1 })], "FLIST", "C1", "added") === undefined, "a row for ANOTHER List is not this List's");
  ok(listWriteRow([row("2026-10-20T00:00:01Z", { channel: "C2", listId: "FLIST", added: 1 })], "FLIST", "C1", "added") === undefined, "a row from ANOTHER channel is not this channel's");
  ok(listWriteRow([row("2026-10-20T00:00:01Z", { channel: "C1", listId: "FLIST", added: 1 }, "canvas.write")], "FLIST", "C1", "added") === undefined, "a canvas.write row is never a List row");
  const later = row("2026-10-20T00:00:05Z", { channel: "C1", listId: "FLIST", added: 2, changed: 0 });
  ok(listWriteRow([add, later], "FLIST", "C1", "added") === later, "the newest matching row wins");
}

console.log(`\n✓ list-fixture: ${n} assertions passed\n`);
