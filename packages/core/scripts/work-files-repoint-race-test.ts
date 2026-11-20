// Two continuations of one task can run at the same time. Each forward writes its own job's files
// row as a copy of the files it read (the opening job's row plus its own wake's files). Then each
// merges its own files into the opening job's row. `task.started` re-points the task to the
// continuation that started last. When both forwards read the opening row before either merged, the
// copy of the job the task now names lacks the other continuation's file. A fresh follow-up after a
// rotation reads the files of the job the task names, so without the task's own files row it loses
// that file. This test drives that order through the real `forwardWork`, then re-points the task to
// each continuation in turn, and checks that the fresh follow-up's brief carries both files.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

delete process.env.DATABASE_URL;
process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-work-files-repoint-")), "ops.sqlite3");

const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
_setDeploymentIdentityForTest({ workspace: "dev" });
const slackStubs = await import("./_slack-test-stubs.js");
slackStubs.registerSlackFixtureCodec();

const workTool = await import("../agent/tools/work.js");
const work = await import("../agent/channels/work.js");
const { registerUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { noteWakeAttachments } = await import("../agent/access/worker-continuation.js");
const { clearGenerationDelegation } = await import("../agent/channels/generation-retirement.js");
const { workSessionLedgerId } = await import("../agent/channels/work-generation.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveDist = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveDist, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};
const inSession = <T>(fn: () => T): T => contextStorage.run(new ContextContainer(), fn);

const ORG = "default";
const store = getOperationalStore();
const SEAT_TOKEN = "oe-dom:e2e-unified:oe-sup:g7";
const ORIGIN = { platform: "slack", channelId: "C_ROOM", threadTs: "100.1" } as const;
const WAKE = "11111111-2222-4333-8444-555555555555";
const binding = {
  org: ORG,
  platform: "slack",
  workspace: "TW",
  surface: "C_ROOM",
  mode: "channel",
  visibility: "private",
  trust: "internal",
  principalId: "U_ALICE",
  target: { channelId: "C_ROOM" },
  threadTs: "100.1",
} as const;
await registerUnifiedWakeTarget(store, ORG, WAKE, ORIGIN, new Date().toISOString(), SEAT_TOKEN, true, "direct-mention", "slack/TW/C_ROOM", binding, {
  binding,
  requester: { kind: "requester", principalId: "U_ALICE" },
  nonMemberWake: false,
});

const seatCtx = (callId: string) => ({
  channel: { kind: "unified", continuationToken: `unified:${SEAT_TOKEN}` },
  session: { id: "sess-seat", turn: { id: `turn-${callId}` }, auth: { current: { attributes: { oe_wake_id: WAKE } } } },
  callId,
});

type Deps = NonNullable<Parameters<typeof workTool.forwardWork>[2]>;
type Delivered = Deps extends { dispatch: (i: infer I) => unknown } ? I : never;
type Store = ReturnType<Deps["store"]>;
const delivered: Delivered[] = [];
const GENERATIONS = ["oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g4-2810aa", "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g5-2810bb", "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g6-2810cc", "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g7-2810dd"] as const;
let current: string = GENERATIONS[0];
const deps = (over: Partial<Deps> = {}): Deps => ({
  forwards: () => true,
  org: () => ORG,
  store: () => store,
  dispatch: async (input: Delivered) => {
    delivered.push(input);
  },
  audit: async () => undefined,
  resolveWork: async () => ({ token: current, generation: GENERATIONS.indexOf(current as (typeof GENERATIONS)[number]) + 4 }),
  ...over,
});

const fileWake = (files: string) => [{ role: "user", content: `<wake reason="mention" wake-id="${WAKE}">\n<channel id="C_ROOM"/>\n<message author="Rowan" trigger="true">\nplease\n${files}</message>\n</wake>` }];
const file = (id: string) => `<attachment kind="file" id="${id}" name="${id.toLowerCase()}.csv" mimetype="text/csv"/>\n`;
const forwarded: string[] = [];
const forward = async (callId: string, files: string, input: { readonly message: string; readonly taskId?: string }, over: Partial<Deps> = {}) =>
  await inSession(async () => {
    forwarded.push(work.workRequestIdFor(callId));
    noteWakeAttachments(fileWake(files));
    const receipt = await workTool.forwardWork(input, seatCtx(callId), deps(over));
    const sent = delivered.find((d) => d.requestId === receipt.requestId);
    return { receipt, block: work.parseWorkRequests(sent?.message ?? "")[0] ?? { requestId: "", brief: "" } };
  });

/**
 * The store each racing continuation sees. The first `parties` reads of `key` each wait until all of
 * them have read, so every continuation reads the opening job's files row before any of them merges
 * into it. The order happens on every run, not by chance.
 */
function racingStore(key: string, parties: number): Store {
  let waiting = parties;
  let release!: () => void;
  const allRead = new Promise<void>((resolve) => (release = resolve));
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "getTaskResult") {
        return async (org: string, k: string) => {
          const raw = await target.getTaskResult(org, k);
          if (k === key && waiting > 0) {
            waiting--;
            if (waiting === 0) release();
            await allRead;
          }
          return raw;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Store;
}

const rowIds = async (requestId: string): Promise<string[]> => {
  const raw = await store.getTaskResult(ORG, `oe-work-files:${requestId}`);
  const row = raw === null ? undefined : (JSON.parse(raw) as { attachments?: { id: string }[] });
  return (row?.attachments ?? []).map((f) => f.id);
};

/**
 * One task: an opening job, then two continuations that race, then a re-point of the task to the
 * continuation `repointTo` names, then a rotation and a fresh follow-up.
 */
async function raceThenRepoint(tag: string, repointTo: "x" | "b") {
  const TASK = `agent-${tag}2810`;
  const OPEN = `F0OPEN${tag.toUpperCase()}`;
  const CONT_X = `F0CONTX${tag.toUpperCase()}`;
  const CONT_B = `F0CONTB${tag.toUpperCase()}`;
  current = GENERATIONS[0];
  const opening = await forward(`call-2810-${tag}-open`, file(OPEN), { message: "total the ledger" });
  await work.rememberWorkTask(store, ORG, TASK, opening.receipt.requestId, new Date().toISOString());
  ok(opening.block.brief.includes(`id="${OPEN}"`), `${tag}: fixture: the opening job's brief carries its file`);

  const race = racingStore(`oe-work-files:${opening.receipt.requestId}`, 2);
  const [x, b] = await Promise.all([
    forward(`call-2810-${tag}-x`, file(CONT_X), { message: "add this sheet", taskId: TASK }, { store: () => race }),
    forward(`call-2810-${tag}-b`, file(CONT_B), { message: "and this sheet", taskId: TASK }, { store: () => race }),
  ]);
  eq([x.block.taskId, b.block.taskId], [TASK, TASK], `${tag}: fixture: both follow-ups are continuations of the task`);
  ok(x.block.brief.includes(`id="${CONT_X}"`) && b.block.brief.includes(`id="${CONT_B}"`), `${tag}: fixture: each continuation's brief carries its own file`);
  const xRow = await rowIds(x.receipt.requestId);
  const bRow = await rowIds(b.receipt.requestId);
  ok(!xRow.includes(CONT_B) && !bRow.includes(CONT_X), `${tag}: RACE FIXTURE: both forwards read the opening row before either merged, so each job's own copy lacks the other continuation's file`);
  const openingFiles = (await work.readWorkAttachments(store, ORG, opening.receipt.requestId)).map((f) => f.id);
  ok([OPEN, CONT_X, CONT_B].every((id) => openingFiles.includes(id)), `${tag}: the opening job's row holds both continuations' files (the compare-and-set merge)`);

  const named = repointTo === "x" ? x : b;
  const other = repointTo === "x" ? CONT_B : CONT_X;
  // `task.started` re-points the task to the continuation that started last.
  await work.rememberWorkTask(store, ORG, TASK, named.receipt.requestId, new Date().toISOString());

  for (const id of new Set(forwarded)) await clearGenerationDelegation(ORG, workSessionLedgerId(id), store);
  current = GENERATIONS[1];
  const fresh = await forward(`call-2810-${tag}-fresh`, "", { message: "continue with that ledger", taskId: TASK });
  ok(fresh.block.taskId === undefined && fresh.block.brief.includes("NEW job"), `${tag}: fixture: after the rotation the follow-up starts as a NEW job`);
  for (const id of [OPEN, CONT_X, CONT_B]) ok(fresh.block.brief.includes(`id="${id}"`), `🔴 ${tag}: re-point to ${repointTo.toUpperCase()}: the fresh follow-up's brief carries ${id}`);
  const viaNamed = (await work.readWorkAttachmentsKnown(store, ORG, named.receipt.requestId))?.map((f) => f.id) ?? [];
  ok(viaNamed.includes(other), `🔴 ${tag}: a read of the job the task names still has the other continuation's file`);
  return { TASK, opening, x, b, fresh };
}

console.log("§1 two concurrent continuations, then a re-point to the one that read first:");
const first = await raceThenRepoint("p", "b");
console.log("§2 the same race, then a re-point to the other continuation:");
await raceThenRepoint("q", "x");

console.log("§3 the task's files row:");
const taskFiles = (await work.readWorkTaskAttachmentsKnown(store, ORG, first.TASK))?.map((f) => f.id).sort();
eq(taskFiles, ["F0CONTBP", "F0CONTXP"], "the task's files row holds the files of every dispatched continuation, and only those");
eq(await work.readWorkTaskAttachmentsKnown(store, ORG, "agent-none2810"), [], "a task with no continuation file reads as no files");
await store.putTaskResult(ORG, "oe-work-task-files:agent-bad2810", JSON.stringify({ attachments: "not a list" }), new Date().toISOString(), 60_000);
eq(await work.readWorkTaskAttachmentsKnown(store, ORG, "agent-bad2810"), undefined, "a task's files row without an attachments list reads as unknown, not as no files");
await store.putTaskResult(ORG, "oe-work-files:req-2810-badtask", JSON.stringify({ attachments: [], task: "agent-bad2810" }), new Date().toISOString(), 60_000);
eq(await work.readWorkAttachmentsKnown(store, ORG, "req-2810-badtask"), undefined, "🔴 a job row whose task's files row reads as unknown reads as unknown, never as a short list");

console.log("§4 a file a continuation adds AFTER the fresh follow-up read still reads through the fresh job:");
const freshRaw = JSON.parse((await store.getTaskResult(ORG, `oe-work-files:${first.fresh.receipt.requestId}`)) ?? "{}") as { task?: string };
eq(freshRaw.task, first.TASK, "the fresh job's row names the task it followed up");
eq(await work.mergeWorkTaskAttachments(store, ORG, first.TASK, "req-2810-late", [{ id: "F0LATECONT", kind: "file", name: "late.csv" }], new Date().toISOString()), "marked", "fixture: a late continuation merges into the task's files row");
ok(((await work.readWorkAttachmentsKnown(store, ORG, first.fresh.receipt.requestId)) ?? []).some((f) => f.id === "F0LATECONT"), "🔴 a read of the fresh job adds the task's files row, so the late file is not lost");
await work.rememberWorkTask(store, ORG, "agent-f2810", first.fresh.receipt.requestId, new Date().toISOString());
for (const id of new Set(forwarded)) await clearGenerationDelegation(ORG, workSessionLedgerId(id), store);
current = GENERATIONS[2];
const chained = await forward("call-2810-chain", "", { message: "one more rotation later", taskId: "agent-f2810" });
ok(chained.block.taskId === undefined, "fixture: a second rotation starts another NEW job");
for (const id of ["F0OPENP", "F0CONTXP", "F0CONTBP", "F0LATECONT"]) ok(chained.block.brief.includes(`id="${id}"`), `🔴 a second rotation still carries ${id}`);
ok(!chained.block.brief.includes("F0CONTXQ") && !chained.block.brief.includes("F0OPENQ"), "🔴 NEGATIVE CONTROL: no file of ANOTHER task is carried");

console.log("§5 a merge into a job row keeps its task link:");
ok(await work.mergeWorkAttachments(store, ORG, first.b.receipt.requestId, [{ id: "F0MERGED01", kind: "file", name: "m.csv" }], new Date().toISOString()), "fixture: a merge into a continuation's row writes");
const mergedRaw = JSON.parse((await store.getTaskResult(ORG, `oe-work-files:${first.b.receipt.requestId}`)) ?? "{}") as { task?: string; from?: string };
eq(mergedRaw.task, first.TASK, "🔴 the merged row still names the task");
eq(await work.mergeWorkTaskAttachments(store, ORG, first.TASK, "req-2810-after", [{ id: "F0AFTERMRG", kind: "file", name: "a.csv" }], new Date().toISOString()), "marked", "fixture: a later merge into the task's files row writes");
ok(((await work.readWorkAttachmentsKnown(store, ORG, first.b.receipt.requestId)) ?? []).some((f) => f.id === "F0AFTERMRG"), "🔴 …so a later task file still reads through the merged row");

console.log("§6 the merge into the task's files row is atomic:");
{
  const RACE_TASK = "agent-cas2810";
  let waiting = 2;
  let release!: () => void;
  const allRead = new Promise<void>((resolve) => (release = resolve));
  const racing: Store = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "getTaskResult") {
        return async (org: string, k: string) => {
          const raw = await target.getTaskResult(org, k);
          if (k === `oe-work-task-files:${RACE_TASK}` && waiting > 0) {
            waiting--;
            if (waiting === 0) release();
            await allRead;
          }
          return raw;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Store;
  const at = new Date().toISOString();
  eq(
    await Promise.all([work.mergeWorkTaskAttachments(racing, ORG, RACE_TASK, "req-2810-casa", [{ id: "F0CASA", kind: "file", name: "a.csv" }], at), work.mergeWorkTaskAttachments(racing, ORG, RACE_TASK, "req-2810-casb", [{ id: "F0CASB", kind: "file", name: "b.csv" }], at)]),
    ["marked", "marked"],
    "fixture: both concurrent merges into the task's files row report their marks written",
  );
  eq((await work.readWorkTaskAttachmentsKnown(store, ORG, RACE_TASK))?.map((f) => f.id).sort(), ["F0CASA", "F0CASB"], "🔴 two concurrent merges into one task's files row both keep their files");
}

console.log("§7 a fresh follow-up that reads BEFORE a slow continuation finishes its forward still carries its file:");
{
  const TASK = "agent-s2810";
  current = GENERATIONS[0];
  const opening = await forward("call-2810-s-open", file("F0OPENS"), { message: "total the ledger" });
  await work.rememberWorkTask(store, ORG, TASK, opening.receipt.requestId, new Date().toISOString());
  // A's dispatch is delivered, but A's seat step does not return until the gate opens. So A's step has
  // not reached any write that comes after its dispatch.
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => (openGate = resolve));
  let dispatched!: () => void;
  const aDispatched = new Promise<void>((resolve) => (dispatched = resolve));
  const slowA = forward("call-2810-s-a", file("F0SLOWA"), { message: "add this sheet", taskId: TASK }, {
    dispatch: async (input: Delivered) => {
      delivered.push(input);
      dispatched();
      await gate;
    },
  });
  await aDispatched;
  const b = await forward("call-2810-s-b", file("F0QUICKB"), { message: "and this sheet", taskId: TASK });
  await work.rememberWorkTask(store, ORG, TASK, b.receipt.requestId, new Date().toISOString());
  for (const id of new Set(forwarded)) await clearGenerationDelegation(ORG, workSessionLedgerId(id), store);
  current = GENERATIONS[1];
  const fresh = await forward("call-2810-s-fresh", "", { message: "continue with that ledger", taskId: TASK });
  openGate();
  const a = await slowA;
  ok(a.block.brief.includes('id="F0SLOWA"'), "fixture: A's job went out with its file");
  ok(fresh.block.taskId === undefined && fresh.block.brief.includes("NEW job"), "fixture: the follow-up starts as a NEW job while A's step is still running");
  for (const id of ["F0OPENS", "F0QUICKB", "F0SLOWA"]) ok(fresh.block.brief.includes(`id="${id}"`), `🔴 the fresh follow-up's brief carries ${id}, although A's step had not returned`);
}

console.log("§8 a dispatch refused before delivery takes its files back out of the task's files row:");
{
  const TASK = "agent-r2810";
  current = GENERATIONS[0];
  const opening = await forward("call-2810-r-open", file("F0OPENR"), { message: "total the ledger" });
  await work.rememberWorkTask(store, ORG, TASK, opening.receipt.requestId, new Date().toISOString());
  await forward("call-2810-r-kept", file("F0SHARED"), { message: "add the shared sheet", taskId: TASK });
  const { DispatchNotDeliveredError } = await import("../agent/channels/self-dispatch.js");
  const refused = () => async () => {
    throw new DispatchNotDeliveredError("refused before delivery");
  };
  await assert.rejects(() => forward("call-2810-r-refused", file("F0NEVERSENT") + file("F0SHARED"), { message: "and these", taskId: TASK }, { dispatch: refused() }), (err: Error) => err.message === workTool.FORWARD_FAILED_NOTE, "fixture: the dispatch is refused before delivery");
  n++;
  const ids = (await work.readWorkTaskAttachmentsKnown(store, ORG, TASK))?.map((f) => f.id).sort();
  eq(ids, ["F0SHARED"], "🔴 the refused job's own file leaves the task's files row; a file another job of the task added stays");
  await assert.rejects(() => forward("call-2810-r-unknown", file("F0MAYBE"), { message: "and this", taskId: TASK }, { dispatch: async () => { throw new Error("dispatch returned 500"); } }), (err: Error) => err.message === workTool.FORWARD_UNKNOWN_NOTE, "fixture: a dispatch with an unknown outcome");
  n++;
  ok(((await work.readWorkTaskAttachmentsKnown(store, ORG, TASK)) ?? []).some((f) => f.id === "F0MAYBE"), "🔴 a dispatch whose outcome is unknown keeps its file in the task's files row");
  ok(await work.dropWorkTaskAttachments(store, ORG, TASK, "req-2810-nothing", new Date().toISOString()), "a drop for a job that marked nothing reports success");
  eq((await work.readWorkTaskAttachmentsKnown(store, ORG, TASK))?.map((f) => f.id).sort(), ["F0MAYBE", "F0SHARED"], "…and writes nothing");
}

console.log("§9 a task's files row that cannot be written refuses the dispatch:");
{
  const TASK = "agent-u2810";
  current = GENERATIONS[0];
  const opening = await forward("call-2810-u-open", file("F0OPENU"), { message: "total the ledger" });
  await work.rememberWorkTask(store, ORG, TASK, opening.receipt.requestId, new Date().toISOString());
  await store.putTaskResult(ORG, `oe-work-task-files:${TASK}`, JSON.stringify({ attachments: "not a list" }), new Date().toISOString(), 60_000);
  const before = delivered.length;
  await assert.rejects(() => forward("call-2810-u-cont", file("F0UNWRITTEN"), { message: "add this", taskId: TASK }), (err: Error) => err.message === workTool.FORWARD_FAILED_NOTE, "🔴 the forward is refused as not delivered");
  n++;
  eq(delivered.length, before, "🔴 …and no worker got the job, so no worker holds a file the task's files row lacks");
}

console.log("§10 a read keeps the order of a job's files, so the cap drops the OLDEST file:");
{
  const TASK = "agent-c2810";
  current = GENERATIONS[0];
  const opening = await forward("call-2810-c-open", "", { message: "total the ledgers" });
  await work.rememberWorkTask(store, ORG, TASK, opening.receipt.requestId, new Date().toISOString());
  const at = new Date().toISOString();
  const cont = ["F0CAPC1", "F0CAPC2", "F0CAPC3", "F0CAPC4", "F0CAPC5", "F0CAPC6"];
  eq(await work.mergeWorkTaskAttachments(store, ORG, TASK, "req-2810-cap", cont.map((id) => ({ id, kind: "file" as const, name: `${id}.csv` })), at), "marked", "fixture: six continuation files in the task's files row");
  for (const id of new Set(forwarded)) await clearGenerationDelegation(ORG, workSessionLedgerId(id), store);
  current = GENERATIONS[1];
  const f = await forward("call-2810-c-fresh", file("F0CAPF1") + file("F0CAPF2"), { message: "and these two", taskId: TASK });
  ok(f.block.taskId === undefined, "fixture: the follow-up starts as a NEW job");
  eq((await work.readWorkAttachmentsKnown(store, ORG, f.receipt.requestId))?.map((x) => x.id), [...cont, "F0CAPF1", "F0CAPF2"], "🔴 a read of the fresh job keeps its order: the task's older files stay before the job's own newer files");
  await work.rememberWorkTask(store, ORG, "agent-c2810b", f.receipt.requestId, new Date().toISOString());
  for (const id of new Set(forwarded)) await clearGenerationDelegation(ORG, workSessionLedgerId(id), store);
  current = GENERATIONS[3];
  const h = await forward("call-2810-c-h", file("F0CAPH1"), { message: "and one more", taskId: "agent-c2810b" });
  ok(h.block.taskId === undefined, "fixture: a second rotation starts another NEW job");
  for (const id of ["F0CAPF1", "F0CAPF2", "F0CAPH1"]) ok(h.block.brief.includes(`id="${id}"`), `🔴 past the cap, the brief keeps the newer file ${id}`);
  ok(!h.block.brief.includes('id="F0CAPC1"'), "…and the cap drops the oldest file");
}

console.log("§11 a refused dispatch keeps a mark that an earlier execution of the same forward wrote:");
{
  const TASK = "agent-e2810";
  current = GENERATIONS[0];
  const opening = await forward("call-2810-e-open", file("F0OPENE"), { message: "total the ledger" });
  await work.rememberWorkTask(store, ORG, TASK, opening.receipt.requestId, new Date().toISOString());
  // An earlier execution of this forward merged its file and delivered the job, then died before its step returned.
  eq(await work.mergeWorkTaskAttachments(store, ORG, TASK, work.workTaskFilesMark(work.workRequestIdFor("call-2810-e-cont"), "earlier-execution"), [{ id: "F0EARLIERX", kind: "file", name: "f0earlierx.csv" }], new Date().toISOString()), "marked", "fixture: the earlier execution's mark");
  // A row written before the marks named an execution holds the plain request id as the mark.
  eq(await work.mergeWorkTaskAttachments(store, ORG, TASK, work.workRequestIdFor("call-2810-e-cont"), [{ id: "F0LEGACYX", kind: "file", name: "f0legacyx.csv" }], new Date().toISOString()), "marked", "fixture: a legacy plain request-id mark");
  const { DispatchNotDeliveredError } = await import("../agent/channels/self-dispatch.js");
  await assert.rejects(
    () => forward("call-2810-e-cont", file("F0EARLIERX") + file("F0LEGACYX"), { message: "add this", taskId: TASK }, { dispatch: async () => { throw new DispatchNotDeliveredError("refused before delivery"); } }),
    (err: Error) => err.message === workTool.FORWARD_FAILED_NOTE,
    "fixture: the re-run's dispatch is refused before delivery",
  );
  n++;
  ok(((await work.readWorkTaskAttachmentsKnown(store, ORG, TASK)) ?? []).some((x) => x.id === "F0EARLIERX"), "🔴 the refusal does not take out a file whose mark an earlier execution wrote");
  ok(((await work.readWorkTaskAttachmentsKnown(store, ORG, TASK)) ?? []).some((x) => x.id === "F0LEGACYX"), "🔴 the refusal does not take out a file whose mark is a legacy plain request id");
}

console.log("§12 a refused execution drops its marks before it releases the forward's key:");
{
  const TASK = "agent-k2810";
  current = GENERATIONS[0];
  const opening = await forward("call-2810-k-open", file("F0OPENK"), { message: "total the ledger" });
  await work.rememberWorkTask(store, ORG, TASK, opening.receipt.requestId, new Date().toISOString());
  const { DispatchNotDeliveredError } = await import("../agent/channels/self-dispatch.js");
  // As soon as the refused execution releases the forward's key, a second execution of the same
  // forward runs and is delivered. Its worker holds the file.
  let second: Promise<unknown> | undefined;
  const forgetEventSeen = async (org: string, key: string) => {
    await store.forgetEventSeen(org, key);
    second ??= forward("call-2810-k-cont", file("F0RETRIED"), { message: "add this", taskId: TASK });
    await second;
  };
  await assert.rejects(
    () => forward("call-2810-k-cont", file("F0RETRIED"), { message: "add this", taskId: TASK }, { dispatch: async () => { throw new DispatchNotDeliveredError("refused before delivery"); }, forgetEventSeen }),
    (err: Error) => err.message === workTool.FORWARD_FAILED_NOTE,
    "fixture: the first execution's dispatch is refused before delivery",
  );
  n++;
  ok(second !== undefined && delivered.some((d) => d.requestId === work.workRequestIdFor("call-2810-k-cont")), "fixture: the second execution ran after the release and was delivered");
  ok(((await work.readWorkTaskAttachmentsKnown(store, ORG, TASK)) ?? []).some((x) => x.id === "F0RETRIED"), "🔴 the task's files row keeps the file the delivered execution's worker holds");
}

console.log("§13 a refused execution keeps the marks of an overlapping delivered execution of the same forward:");
{
  const { DispatchNotDeliveredError } = await import("../agent/channels/self-dispatch.js");
  // No dedupe key holds between the two executions: the dedupe store fails open, or the key expired
  // while a slow step ran. So both executions of one forward merge, and both dispatch.
  const noKey = { markEventSeen: async () => true, forgetEventSeen: async () => undefined };
  for (const order of ["delivered-first", "refused-first"] as const) {
    const TASK = `agent-o2810-${order}`;
    const CALL = `call-2810-o-${order}`;
    current = GENERATIONS[0];
    const opening = await forward(`call-2810-o-open-${order}`, file("F0OPENO"), { message: "total the ledger" });
    await work.rememberWorkTask(store, ORG, TASK, opening.receipt.requestId, new Date().toISOString());
    let aDispatched!: () => void;
    const aAtDispatch = new Promise<void>((resolve) => (aDispatched = resolve));
    let bDispatched!: () => void;
    const bAtDispatch = new Promise<void>((resolve) => (bDispatched = resolve));
    let aSettled!: () => void;
    const aDone = new Promise<void>((resolve) => (aSettled = resolve));
    let bWasDelivered!: () => void;
    const bDelivered = new Promise<void>((resolve) => (bWasDelivered = resolve));
    // A merges first. B merges while A waits at its dispatch. Then one is delivered and the other refused.
    const a = forward(CALL, file("F0OVERLAP"), { message: "add this sheet", taskId: TASK }, {
      ...noKey,
      dispatch: async () => {
        aDispatched();
        await bAtDispatch;
        if (order === "delivered-first") await bDelivered;
        throw new DispatchNotDeliveredError("refused before delivery");
      },
    });
    await aAtDispatch;
    const b = forward(CALL, file("F0OVERLAP"), { message: "add this sheet", taskId: TASK }, {
      ...noKey,
      dispatch: async (input: Delivered) => {
        bDispatched();
        if (order === "refused-first") await aDone;
        delivered.push(input);
        bWasDelivered();
      },
    });
    await assert.rejects(() => a.finally(aSettled), (err: Error) => err.message === workTool.FORWARD_FAILED_NOTE, `fixture (${order}): execution A is refused before delivery`);
    n++;
    const bOut = await b;
    ok(bOut.block.brief.includes('id="F0OVERLAP"'), `fixture (${order}): execution B delivered the job with its file`);
    ok(((await work.readWorkTaskAttachmentsKnown(store, ORG, TASK)) ?? []).some((x) => x.id === "F0OVERLAP"), `🔴 (${order}) the task's files row keeps the file that the delivered execution's worker holds`);
  }
}

for (const id of new Set(forwarded)) await clearGenerationDelegation(ORG, work.workLedgerId(id), store);
console.log(`✓ work-files-repoint-race: ${n} assertions passed`);
