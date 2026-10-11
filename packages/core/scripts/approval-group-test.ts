import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-approval-group-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ADMIN"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { requestApproval, handleApprovalPayload, OE_APPROVAL_PREFIX } = await import("../agent/approvals/flow.js");
const { registerActionKind } = await import("../agent/approvals/actions.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { resetTurnClock } = await import("../agent/observability/turn-clock.js");
const { GROUPED_CARD_MAX_ITEMS, pendingCardBlocks, groupedCardBlocks, decidedCardBlocks } = await import("../agent/approvals/card.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerActionKind({
  kind: "test.group",
  policy: "member",
  summarize: (args: { what: string }) => [`do ${args.what}`],
  plainSummary: (args: { what: string }) => `Do ${args.what} for the team`,
  async execute(args: { what: string }) {
    return `did ${args.what}`;
  },
});

interface Call {
  readonly method: string;
  readonly body: URLSearchParams;
  readonly raw: string;
}
let calls: Call[] = [];
let nextTs = 100;
let updateOk = true;
const post = async (method: string, body: string): Promise<Record<string, unknown> | undefined> => {
  calls.push({ method, body: new URLSearchParams(body), raw: body });
  if (method === "chat.postMessage") return { ok: true, ts: `${nextTs++}.0` };
  if (method === "chat.update") return { ok: updateOk };
  return { ok: true };
};

async function propose(session: string, what: string, threadTs: string | null = "500.0"): Promise<string> {
  return contextStorage.run(new ContextContainer(), async () => {
    resetTurnClock("turn_0", Date.now(), session);
    const res = await requestApproval(
      {
        org: "default",
        kind: "test.group",
        args: { what },
        scopeKey: "slack/T1/C1",
        requestedBy: "U_REQ",
        channelId: "C1",
        threadTs,
        postedTo: "slack/T1/C1",
        chain: { unattended: false },
      },
      { post },
    );
    return res.id;
  });
}

const store = getOperationalStore();
const actionIdsIn = (c: Call): string[] =>
  (JSON.parse(c.body.get("blocks") ?? "[]") as { type: string; elements?: { action_id?: string }[] }[])
    .filter((b) => b.type === "actions")
    .flatMap((b) => (b.elements ?? []).map((e) => e.action_id ?? ""));

const idA = await propose("sess-job-1", "alpha");
ok(calls.filter((c) => c.method === "chat.postMessage").length === 1, "the first ask posts one card");
const tsA = (await store.getPendingAction("default", idA))?.messageTs;
ok(tsA === "100.0", "the first card's ts is stored");
ok((await store.getPendingAction("default", idA))?.groupKey === "sess-job-1", "the row freezes the proposing session as its group key");

calls = [];
const idB = await propose("sess-job-1", "beta");
ok(!calls.some((c) => c.method === "chat.postMessage"), "🔴 the second ask from the same job posts NO new card");
const join1 = calls.filter((c) => c.method === "chat.update" && c.body.get("ts") === tsA);
ok(join1.length >= 1, "it rewrites the job's open card instead");
const ids1 = actionIdsIn(join1[join1.length - 1]);
ok(ids1.includes(`${OE_APPROVAL_PREFIX}approve:${idA}`) && ids1.includes(`${OE_APPROVAL_PREFIX}approve:${idB}`), "the grouped card carries BOTH asks' own buttons");
ok((await store.getPendingAction("default", idB))?.messageTs === tsA, "the second row points at the shared card");
ok((join1[join1.length - 1].body.get("text") ?? "").startsWith("One job asks for 2 approvals"), "the grouped card opens with a plain count");

calls = [];
const idC = await propose("sess-job-2", "gamma");
ok(calls.filter((c) => c.method === "chat.postMessage").length === 1, "an ask from ANOTHER session posts its own card");
ok((await store.getPendingAction("default", idC))?.messageTs !== tsA, "…and does not point at the first job's card");
calls = [];
const idD = await propose("sess-job-1", "delta", "600.0");
ok(calls.filter((c) => c.method === "chat.postMessage").length === 1, "the same session in ANOTHER thread posts its own card");
ok((await store.getPendingAction("default", idD))?.messageTs !== tsA, "…and does not join the other thread's card");

calls = [];
await handleApprovalPayload(
  {
    actions: [{ action_id: `${OE_APPROVAL_PREFIX}approve:${idA}`, value: "default" }],
    user: { id: "U_REQ" },
    team: { id: "T1" },
    channel: { id: "C1" },
    message: { ts: tsA },
  },
  { post },
);
ok((await store.getPendingAction("default", idA))?.status === "approved", "the click decided the clicked item");
ok((await store.getPendingAction("default", idB))?.status === "pending", "the other item is untouched");
const redraw = calls.find((c) => c.method === "chat.update" && c.body.get("ts") === tsA);
ok(redraw !== undefined, "the click redraws the shared card");
const ids2 = redraw ? actionIdsIn(redraw) : [];
ok(ids2.includes(`${OE_APPROVAL_PREFIX}approve:${idB}`), "🔴 the redraw KEEPS the open item's buttons — a single-card redraw would have wiped them");
ok(!ids2.some((id) => id.endsWith(`:${idA}`)), "the decided item has no buttons left");
ok((redraw?.body.get("blocks") ?? "").includes("✅ Approved by <@U_REQ>"), "the decided item shows who decided it");

updateOk = false;
calls = [];
const idE = await propose("sess-job-1", "epsilon");
updateOk = true;
ok(calls.some((c) => c.method === "chat.update"), "the join was attempted");
ok(calls.filter((c) => c.method === "chat.postMessage").length === 1, "🔴 a failed rewrite falls back to posting the ask's own card — a failed join never hides an ask");
const tsE = (await store.getPendingAction("default", idE))?.messageTs;
ok(typeof tsE === "string" && tsE !== tsA, "the ask's row points at its own card");

const job3: string[] = [];
for (let i = 0; i < GROUPED_CARD_MAX_ITEMS; i++) job3.push(await propose("sess-job-3", `item-${i}`, "700.0"));
const ts3 = (await store.getPendingAction("default", job3[0]))?.messageTs;
const members3 = ts3 ? await store.listPendingActionsForMessage("default", "C1", ts3) : [];
ok(members3.length === GROUPED_CARD_MAX_ITEMS, `the job's card holds ${GROUPED_CARD_MAX_ITEMS} items (got ${members3.length})`);
calls = [];
const overflow = await propose("sess-job-3", "item-overflow", "700.0");
ok(calls.filter((c) => c.method === "chat.postMessage").length === 1, "the next ask from a FULL card's job posts a card of its own");
ok((await store.getPendingAction("default", overflow))?.messageTs !== ts3, "…and does not point at the full card");

calls = [];
const loose1 = await requestApproval({ org: "default", kind: "test.group", args: { what: "loose-1" }, scopeKey: "slack/T1/C1", requestedBy: "U_REQ", channelId: "C1", threadTs: "800.0", postedTo: "slack/T1/C1", chain: { unattended: false } }, { post });
const loose2 = await requestApproval({ org: "default", kind: "test.group", args: { what: "loose-2" }, scopeKey: "slack/T1/C1", requestedBy: "U_REQ", channelId: "C1", threadTs: "800.0", postedTo: "slack/T1/C1", chain: { unattended: false } }, { post });
ok(calls.filter((c) => c.method === "chat.postMessage").length === 2, "two proposals outside any turn post two cards");
ok((await store.getPendingAction("default", loose1.id))?.groupKey === undefined && (await store.getPendingAction("default", loose2.id))?.groupKey === undefined, "a row proposed outside a turn carries no group key");

const idF = await propose("sess-job-4", "zeta", "900.0");
const tsF = (await store.getPendingAction("default", idF))?.messageTs;
const realForMessage = store.listPendingActionsForMessage.bind(store);
(store as { listPendingActionsForMessage: typeof realForMessage }).listPendingActionsForMessage = async () => {
  throw new Error("transient store error");
};
calls = [];
let threw = false;
let idG = "";
try {
  idG = await propose("sess-job-4", "eta", "900.0");
} catch {
  threw = true;
} finally {
  (store as { listPendingActionsForMessage: typeof realForMessage }).listPendingActionsForMessage = realForMessage;
}
ok(!threw, "🔴 a store throw inside the join does not fail the ask");
ok(calls.filter((c) => c.method === "chat.postMessage").length === 1, "🔴 …the ask posts its own card instead");
const tsG = idG ? (await store.getPendingAction("default", idG))?.messageTs : undefined;
ok(typeof tsG === "string" && tsG.length > 0 && tsG !== tsF, "…and its row points at that card, never at nothing");

const idH = await propose("sess-job-5", "theta", "950.0");
const tsH = (await store.getPendingAction("default", idH))?.messageTs;
let forMessageCalls = 0;
(store as { listPendingActionsForMessage: typeof realForMessage }).listPendingActionsForMessage = async (...a: Parameters<typeof realForMessage>) => {
  forMessageCalls++;
  if (forMessageCalls === 3) throw new Error("transient store error");
  return realForMessage(...a);
};
calls = [];
let idI = "";
try {
  idI = await propose("sess-job-5", "iota", "950.0");
} finally {
  (store as { listPendingActionsForMessage: typeof realForMessage }).listPendingActionsForMessage = realForMessage;
}
ok(forMessageCalls >= 3, `the stub reached the re-check (calls: ${forMessageCalls})`);
ok(calls.some((c) => c.method === "chat.update" && c.body.get("ts") === tsH), "the grouped card was rewritten with the new row");
ok(!calls.some((c) => c.method === "chat.postMessage"), "🔴 a throw after the rewrite landed posts NO card of its own");
ok((await store.getPendingAction("default", idI))?.messageTs === tsH, "🔴 …and the row stays on the grouped card that shows it");

calls = [];
await handleApprovalPayload(
  {
    actions: [{ action_id: `${OE_APPROVAL_PREFIX}approve:${idA}`, value: "default" }],
    user: { id: "U_REQ" },
    team: { id: "T1" },
    channel: { id: "C1" },
    message: { ts: tsA },
  },
  { post },
);
ok((await store.getPendingAction("default", idA))?.status === "approved", "the second click changed nothing: the item stays approved");
const fix = calls.find((c) => c.method === "chat.update" && c.body.get("ts") === tsA);
ok(fix !== undefined, "🔴 a click on a decided item of a GROUPED card redraws the card");
const ids3 = fix ? actionIdsIn(fix) : [];
ok(!ids3.some((id) => id.endsWith(`:${idA}`)) && ids3.includes(`${OE_APPROVAL_PREFIX}approve:${idB}`), "the redraw shows no buttons on the decided item and keeps the open item's buttons");
calls = [];
await handleApprovalPayload(
  {
    actions: [{ action_id: `${OE_APPROVAL_PREFIX}approve:${idC}`, value: "default" }],
    user: { id: "U_REQ" },
    team: { id: "T1" },
    channel: { id: "C1" },
    message: { ts: (await store.getPendingAction("default", idC))?.messageTs },
  },
  { post },
);
calls = [];
await handleApprovalPayload(
  {
    actions: [{ action_id: `${OE_APPROVAL_PREFIX}approve:${idC}`, value: "default" }],
    user: { id: "U_REQ" },
    team: { id: "T1" },
    channel: { id: "C1" },
    message: { ts: (await store.getPendingAction("default", idC))?.messageTs },
  },
  { post },
);
ok(calls.length === 0, "a repeat click on a SINGLE decided card stays silent, as before");

{
  const wireText = (c: Call | undefined): string => c?.body.get("text") ?? "";
  const carriesLineFeeds = (c: Call | undefined): boolean => (c?.raw ?? "").includes("%0A");

  calls = [];
  const idW1 = await propose("sess-wire", "kappa", "990.0");
  const postW = calls.find((c) => c.method === "chat.postMessage");
  const rowW1 = (await store.getPendingAction("default", idW1))!;
  const singleText = pendingCardBlocks(rowW1, ["do kappa"]).text;
  ok(wireText(postW) === singleText, `🔴 SINGLE: chat.postMessage carries the rendered text byte for byte (got ${JSON.stringify(wireText(postW))})`);
  const singleLines = wireText(postW).split("\n");
  ok(singleLines.length === 4 && singleLines[0] === "Do kappa for the team." && singleLines[1] === "Approval requested: test.group", `SINGLE: the sentence, then the label, each on its own line (got ${JSON.stringify(singleLines)})`);
  ok(carriesLineFeeds(postW), "SINGLE: the form body carries encoded line feeds");

  calls = [];
  const idW2 = await propose("sess-wire", "lambda", "990.0");
  const tsW = rowW1.messageTs;
  const joinW = calls.find((c) => c.method === "chat.update" && c.body.get("ts") === tsW);
  const membersW = await store.listPendingActionsForMessage("default", "C1", tsW!);
  ok(membersW.some((m) => m.id === idW2), "GROUPED: the second ask joined the first card");
  const groupedText = groupedCardBlocks(membersW.map((m) => ({ row: m, summaryLines: [`do ${(JSON.parse(m.argsJson) as { what: string }).what}`] }))).text;
  ok(wireText(joinW) === groupedText, `🔴 GROUPED: the join's chat.update carries the rendered text byte for byte (got ${JSON.stringify(wireText(joinW))})`);
  const groupedLines = wireText(joinW).split("\n");
  ok(groupedLines.length === 4 && groupedLines[1] === "Approval requested: grouped" && groupedLines[2].startsWith("1. ") && groupedLines[3].startsWith("2. "), `GROUPED: the count, the label and one line per item (got ${JSON.stringify(groupedLines)})`);
  ok(carriesLineFeeds(joinW), "GROUPED: the form body carries encoded line feeds");

  calls = [];
  await handleApprovalPayload({ actions: [{ action_id: `${OE_APPROVAL_PREFIX}approve:${idW1}`, value: "default" }], user: { id: "U_REQ" }, team: { id: "T1" }, channel: { id: "C1" }, message: { ts: tsW } }, { post });
  const redrawW = calls.find((c) => c.method === "chat.update" && c.body.get("ts") === tsW);
  const membersW2 = await store.listPendingActionsForMessage("default", "C1", tsW!);
  const redrawText = groupedCardBlocks(membersW2.map((m) => ({ row: m, summaryLines: [`do ${(JSON.parse(m.argsJson) as { what: string }).what}`] }))).text;
  ok(wireText(redrawW) === redrawText, `🔴 GROUPED DECIDED: the redraw's chat.update carries the rendered text byte for byte (got ${JSON.stringify(wireText(redrawW))})`);
  ok(wireText(redrawW).split("\n").length === 4, "GROUPED DECIDED: the redraw keeps one line per item");
  ok(carriesLineFeeds(redrawW), "GROUPED DECIDED: the form body carries encoded line feeds");

  calls = [];
  const idW3 = await propose("sess-wire-solo", "mu", "991.0");
  const tsW3 = (await store.getPendingAction("default", idW3))!.messageTs;
  calls = [];
  await handleApprovalPayload({ actions: [{ action_id: `${OE_APPROVAL_PREFIX}approve:${idW3}`, value: "default" }], user: { id: "U_REQ" }, team: { id: "T1" }, channel: { id: "C1" }, message: { ts: tsW3 } }, { post });
  const decidedW = calls.find((c) => c.method === "chat.update" && c.body.get("ts") === tsW3);
  const rowW3 = (await store.getPendingAction("default", idW3))!;
  ok(rowW3.status === "approved", "SINGLE DECIDED: the click decided the row");
  const decidedText = decidedCardBlocks(rowW3, ["do mu"], "did mu").text;
  ok(wireText(decidedW) === decidedText, `🔴 SINGLE DECIDED: the rewrite's chat.update carries the rendered text byte for byte (got ${JSON.stringify(wireText(decidedW))})`);
  const decidedLines = wireText(decidedW).split("\n");
  ok(decidedLines.length === 4 && decidedLines[1] === "Approval requested: test.group" && decidedLines[3].startsWith("✅ Approved by <@U_REQ>"), `SINGLE DECIDED: the sentence, the label, the detail and the decided line (got ${JSON.stringify(decidedLines)})`);
  ok(carriesLineFeeds(decidedW), "SINGLE DECIDED: the form body carries encoded line feeds");
}

console.log(`approval-group-test: ${n} assertions passed`);
