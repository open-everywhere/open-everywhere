// proves: REPLY-11

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const dir = join(tmpdir(), `open-everywhere-stand-down-verbs-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: "org", match: "org", admins: ["slack/T_VERBS/U_VERBS"] }] as never,
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadConnectorCredentials: () => [{ connector: "acme", allows: ["service-oauth"], credentials: [{ id: "o", type: "service-oauth" }] }] as never,
});

const { registerSlackTestBridge, registerSlackFixtureManifest, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");

type Call = { readonly method: string; readonly channel: string; readonly thread: string };
const calls: Call[] = [];
const record = (method: string, args: Record<string, unknown>): void => {
  calls.push({ method, channel: String(args["channel"] ?? args["channel_id"] ?? ""), thread: String(args["thread_ts"] ?? args["ts"] ?? args["timestamp"] ?? "") });
};
registerSlackTestBridge({
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    record(method, Object.fromEntries(p.entries()));
    return { ok: true, ts: `9000.${String(calls.length).padStart(6, "0")}` } as never;
  },
  readCall: async (method: string, args: Record<string, unknown>) => {
    record(method, args);
    if (method === "files.getUploadURLExternal") return { ok: true, upload_url: "https://files.invalid/upload", file_id: `F${calls.length}` } as never;
    return { ok: true } as never;
  },
} as never);
registerSlackFixtureManifest();
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown) => {
  if (String(url).startsWith("https://files.invalid/")) return new Response("", { status: 200 });
  return realFetch(url as never);
}) as typeof fetch;

const { markThreadEngaged, isThreadStopped } = await import("../agent/channels/engagement.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { resolveReplyTarget, replyEditLocus } = await import("../agent/channels/reply-post.js");
const { recordOwnPost } = await import("../agent/channels/own-post-ledger.js");
const { turnCloseoutTripped, _resetTurnCloseoutForTest } = await import("../agent/model/turn-closeout.js");
const { STAND_DOWN_VERB_REFUSED_ACTION } = await import("../agent/channels/stand-down-gate.js");
const { REPLY_STOPPED_REFUSAL_REASON } = await import("../agent/channels/reply-signal.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { _dynamicResolverForTest, resolveWindowGated } = await import("../agent/access/window-gated.js");
const { bindFrom } = await import("../agent/identity/binding.js");
const { adoptDelegatedAuthority } = await import("../agent/identity/delegated-binding.js");

interface Exec {
  readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}
const standDown = (await import("../agent/tools/stand_down.js")).default as unknown as Exec;
const replyTool = (await import("../agent/tools/reply.js")).default;
const editTool = (await import("../agent/tools/edit_reply.js")).default;
const reactTool = (await import("../agent/tools/react.js")).default;
const postFileTool = (await import("../agent/tools/post_file.js")).default;
const askRoom = (await import("../agent/tools/ask_room.js")).default as unknown as Exec;
const connectorTool = (await import("../agent/tools/connector.js")).default;

const armed = (tool: unknown, ctx: unknown): Exec => {
  const a = _dynamicResolverForTest(tool)({}, ctx) as Exec | null;
  assert.ok(a !== null, "fixture: the tool arms on this context");
  return a;
};
const gated = async (tool: unknown, ctx: unknown): Promise<Exec> => {
  const a = (await resolveWindowGated(tool as never, ctx as never)) as unknown as Exec | null;
  assert.ok(a !== null, "fixture: the window-gated tool arms on this context");
  return a;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const newSession = (): (<T>(fn: () => Promise<T>) => Promise<T>) => {
  const c = new ContextContainer();
  return (fn) => contextStorage.run(c, fn);
};

async function workerSession(threadTs: string, turnId: string): Promise<<T>(fn: () => Promise<T>) => Promise<T>> {
  const inTurn = newSession();
  const parentBinding = bindFrom(threadCtx(threadTs, "verbs-parent", "turn_p1") as never);
  const adopted = await inTurn(async () => adoptDelegatedAuthority({ binding: parentBinding, requester: {} as never, nonMemberWake: false }, turnId));
  assert.ok(adopted, "fixture: the worker adopts its parent's binding, as a delegated job does");
  return inTurn;
}

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const CHAN = "C_VERBS";
const WORK_TOKEN = "oe-dom:verbs-dom:win:w/job-1:oe-sup:g1";

function threadCtx(threadTs: string, sessionId: string, turnId: string, opts: { worker?: boolean } = {}) {
  return {
    channel: opts.worker === true ? { kind: "slack", continuationToken: WORK_TOKEN } : { kind: "slack" },
    getSandbox: async () => ({ resolvePath: (p: string) => `/workspace/${p}`, readBinaryFile: async () => new Uint8Array([1, 2, 3]) }),
    session: {
      id: sessionId,
      turn: { id: turnId },
      ...(opts.worker === true ? { parent: { sessionId: `${sessionId}-parent` } } : {}),
      auth: {
        current: {
          attributes: { team_id: "T_VERBS", channel_id: CHAN, thread_ts: threadTs, channel_type: "channel", user_id: "U_VERBS", oe_grain: "task" },
          principalId: "U_VERBS",
          principalType: "slack-user",
        },
      },
    },
  };
}

type Outcome = { readonly ok: boolean; readonly error?: string };
async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function ownPostIn(ctx: unknown, id: string): Promise<void> {
  const target = resolveReplyTarget(ctx as never);
  assert.ok(target, "fixture: the thread resolves a reply target");
  const locus = replyEditLocus(target);
  assert.ok(locus, "fixture: the thread has an edit locus");
  await recordOwnPost("default", locus, id);
}

interface VerbRun {
  readonly file: Outcome;
  readonly edit: Outcome;
  readonly react: Outcome;
}

async function threeVerbs(inTurn: <T>(fn: () => Promise<T>) => Promise<T>, ctx: unknown, ownId: string): Promise<VerbRun> {
  const file = await inTurn(() => attempt(async () => (await gated(postFileTool, ctx)).execute({ files: [{ source: { path: "out.png" }, filename: "out.png" }], comment: "the chart" }, ctx)));
  const edit = await inTurn(() => attempt(() => armed(editTool, ctx).execute({ message_id: ownId, text: "corrected" }, ctx)));
  const react = await inTurn(() => attempt(() => armed(reactTool, ctx).execute({ emoji: "eyes" }, ctx)));
  return { file, edit, react };
}

const OWN_IN: Readonly<Record<string, string>> = { "1757000000.000100": "1757000000.000150", "1757000000.000200": "1757000000.000250" };
const visible = (thread: string): number =>
  calls.filter((c) => (c.thread === thread || c.thread === OWN_IN[thread]) && (c.method === "files.completeUploadExternal" || c.method === "chat.update" || c.method === "reactions.add" || c.method === "chat.postMessage")).length;

const STOPPED = "1757000000.000100";
const OPEN = "1757000000.000200";

try {
  const standerCtx = threadCtx(STOPPED, "verbs-stander", "turn_s1");
  const partition = resolvePartition(standerCtx as never);
  await markThreadEngaged(partition, STOPPED, new Date().toISOString(), { participating: true });
  await markThreadEngaged(partition, OPEN, new Date().toISOString(), { participating: true });
  await ownPostIn(standerCtx, "1757000000.000150");
  await ownPostIn(threadCtx(OPEN, "verbs-control", "turn_c1"), "1757000000.000250");

  const stander = newSession();
  const stop = (await stander(() => standDown.execute({ reason: "asked me to stop" }, standerCtx))) as { standingDown: boolean };
  ok(stop.standingDown === true, "WIRING: the real `stand_down` stopped the thread");
  ok((await isThreadStopped(partition, STOPPED)) === true && (await isThreadStopped(partition, OPEN)) === false, "WIRING: only STOPPED carries the stop; OPEN is the control conversation");

  const laterCtx = threadCtx(STOPPED, "verbs-later", "turn_l1");
  const later = newSession();
  const before = visible(STOPPED);
  const l = await threeVerbs(later, laterCtx, "1757000000.000150");
  ok(!l.file.ok && /stand down/i.test(l.file.error ?? ""), `🔴 §1: a later session's post_file into the stopped thread is REFUSED with the stand-down steer (${l.file.error ?? "posted"})`);
  ok(!l.edit.ok && /stand down/i.test(l.edit.error ?? ""), `🔴 §1: …its edit_reply is REFUSED (${l.edit.error ?? "edited"})`);
  ok(!l.react.ok && /stand down/i.test(l.react.error ?? ""), `🔴 §1: …its react is REFUSED (${l.react.error ?? "reacted"})`);
  ok(visible(STOPPED) === before, "🔴 §1/ROOM: no upload, no edit and no reaction reached the stopped thread");
  ok(calls.filter((c) => c.method === "files.getUploadURLExternal").length === 0, "§1/ROOM: the refused post_file did not even start an upload");

  const rows = (await readAudit({ org: "default", action: STAND_DOWN_VERB_REFUSED_ACTION })) as { detail?: Record<string, unknown> }[];
  const verbs = rows.map((r) => r.detail?.["verb"]).sort();
  ok(verbs.includes("post_file") && verbs.includes("react"), `§1/AUDIT: the refused post_file and react each leave a \`${STAND_DOWN_VERB_REFUSED_ACTION}\` row (${JSON.stringify(verbs)})`);
  ok(rows.every((r) => r.detail?.["reason"] === REPLY_STOPPED_REFUSAL_REASON), "§1/AUDIT: …under reason `stopped`");
  const editRows = (await readAudit({ org: "default", action: "reply.edit.refused" })) as { detail?: Record<string, unknown> }[];
  ok(editRows.some((r) => r.detail?.["reason"] === REPLY_STOPPED_REFUSAL_REASON), "§1/AUDIT: the refused edit leaves its `reply.edit.refused` row under reason `stopped`");
  ok(turnCloseoutTripped("verbs-later", "turn_l1") === true, "§1: a turn with no acknowledgement left arms the closeout, the same as a refused `reply`");

  const laterConnector = await later(() => attempt(() => armed(connectorTool, laterCtx).execute({ connector: "acme" }, laterCtx)));
  ok(!laterConnector.ok && /stand down/i.test(laterConnector.error ?? ""), `🔴 §1: …and its connector card is REFUSED (${laterConnector.error ?? "posted"})`);
  ok(visible(STOPPED) === before, "§1/ROOM: …and no connect card reached the stopped thread");

  const workerCtx = threadCtx(STOPPED, "verbs-worker", "turn_w1", { worker: true });
  const worker = await workerSession(STOPPED, "turn_w1");
  const asked = await worker(() => attempt(() => askRoom.execute({ question: "Which region should the report cover?" }, workerCtx)));
  ok(!asked.ok && /belongs to the turn that stood down/.test(asked.error ?? "") && !/never the stand-down acknowledgement/.test(asked.error ?? ""), `🔴 §2: a worker's ask_room into the stopped thread is REFUSED with the stand-down steer, never the ack-only steer (${asked.error ?? "posted"})`);
  ok(visible(STOPPED) === before, "🔴 §2/ROOM: the question did not reach the stopped thread");
  const w = await threeVerbs(worker, workerCtx, "1757000000.000150");
  const workerSteer = (o: Outcome): boolean => !o.ok && /belongs to the turn that stood down/.test(o.error ?? "") && !/never the stand-down acknowledgement/.test(o.error ?? "");
  ok(workerSteer(w.file), `🔴 §2: the same worker's post_file is REFUSED with the stand-down steer (${w.file.error ?? "posted"})`);
  ok(workerSteer(w.edit), `🔴 §2: …its edit_reply is REFUSED with the stand-down steer (${w.edit.error ?? "edited"})`);
  ok(workerSteer(w.react), `🔴 §2: …its react is REFUSED with the stand-down steer (${w.react.error ?? "reacted"})`);
  ok(turnCloseoutTripped("verbs-worker", "turn_w1") === true, "§2: the worker's refusals arm its closeout");
  ok(visible(STOPPED) === before, "§2/ROOM: …and nothing reached the stopped thread");

  _resetTurnCloseoutForTest();
  const s = await threeVerbs(stander, standerCtx, "1757000000.000150");
  ok(!s.file.ok && /never the stand-down acknowledgement/.test(s.file.error ?? ""), `🔴 §3: the turn that stood down cannot spend its acknowledgement on a file (${s.file.error ?? "posted"})`);
  ok(!s.edit.ok && /never the stand-down acknowledgement/.test(s.edit.error ?? ""), "🔴 §3: …nor on an edit");
  ok(!s.react.ok && /never the stand-down acknowledgement/.test(s.react.error ?? ""), "🔴 §3: …nor on a reaction");
  ok(visible(STOPPED) === before, "§3/ROOM: nothing reached the stopped thread");
  ok(turnCloseoutTripped("verbs-stander", "turn_s1") === false, "🔴 §3: those refusals do NOT arm the closeout — the turn still owes its one acknowledgement");
  const ack = await stander(() => attempt(() => armed(replyTool, standerCtx).execute({ text: "Standing down here." }, standerCtx)));
  ok(ack.ok, `§3: …so the acknowledgement still posts with \`reply\` (${ack.error ?? "posted"})`);
  ok(visible(STOPPED) === before + 1, "§3/ROOM: exactly ONE message reached the stopped thread — the acknowledgement");
  const after = await threeVerbs(stander, standerCtx, "1757000000.000150");
  ok(!after.file.ok && !after.edit.ok && !after.react.ok, "§3: after the acknowledgement every verb is refused");
  ok(after.react.error !== undefined && /already posted here once/.test(after.react.error), "§3: …with the spent-acknowledgement steer");
  ok(visible(STOPPED) === before + 1, "§3/ROOM: the stopped thread still holds exactly ONE message");

  const UNREADABLE = "1757000000.000300";
  await markThreadEngaged(partition, UNREADABLE, new Date().toISOString(), { participating: true });
  const { getOperationalStore } = await import("../agent/operational/provider.js");
  const { markThreadStopped } = await import("../agent/channels/engagement.js");
  ok((await markThreadStopped(partition, UNREADABLE)) === true, "§4/WIRING: a third thread is stopped");
  await getOperationalStore().putTaskResult(partition.org, `stand-down-ack:${partition.surfaceKey}\n${UNREADABLE}`, "not json", new Date().toISOString(), 60_000);
  _resetTurnCloseoutForTest();
  const unreadableWorker = await workerSession(UNREADABLE, "turn_w4");
  const u = await unreadableWorker(() => attempt(() => armed(reactTool, threadCtx(UNREADABLE, "verbs-worker-4", "turn_w4", { worker: true })).execute({ emoji: "eyes" }, threadCtx(UNREADABLE, "verbs-worker-4", "turn_w4", { worker: true }))));
  ok(!u.ok && /belongs to the turn that stood down/.test(u.error ?? "") && !/still yours to post/.test(u.error ?? ""), `🔴 §4: with the hold row UNREADABLE, a worker is never told the acknowledgement is its own (${u.error ?? "reacted"})`);
  ok(turnCloseoutTripped("verbs-worker-4", "turn_w4") === true, "🔴 §4: …and its refusal arms the closeout");

  const controlCtx = threadCtx(OPEN, "verbs-control", "turn_c1");
  const control = newSession();
  const openBefore = visible(OPEN);
  const c = await threeVerbs(control, controlCtx, "1757000000.000250");
  ok(c.file.ok, `NEGATIVE CONTROL: post_file into a thread that did NOT stand down still lands (${c.file.error ?? "posted"})`);
  ok(c.edit.ok, `NEGATIVE CONTROL: …edit_reply still lands (${c.edit.error ?? "edited"})`);
  ok(c.react.ok, `NEGATIVE CONTROL: …react still lands (${c.react.error ?? "reacted"})`);
  ok(visible(OPEN) === openBefore + 3, `NEGATIVE CONTROL: …and the upload, the edit and the reaction reached that thread (${visible(OPEN) - openBefore})`);
  const cardBefore = visible(OPEN);
  const controlConnector = await control(() => attempt(() => armed(connectorTool, controlCtx).execute({ connector: "acme" }, controlCtx)));
  ok(controlConnector.ok, `NEGATIVE CONTROL: a connector card into a thread that did NOT stand down still posts (${controlConnector.error ?? "posted"})`);
  ok(visible(OPEN) === cardBefore + 1, "NEGATIVE CONTROL: …and it reached that thread");

  const crossBefore = visible(STOPPED);
  const crossReact = await control(() => attempt(() => armed(reactTool, controlCtx).execute({ emoji: "eyes", ts: STOPPED }, controlCtx)));
  ok(!crossReact.ok && /stand down/i.test(crossReact.error ?? ""), `🔴 §5: a turn bound to an OPEN thread cannot react, by an explicit \`ts\`, on the root of a STOPPED thread (${crossReact.error ?? "reacted"})`);
  ok(visible(STOPPED) === crossBefore, "§5/ROOM: …and no reaction reached the stopped thread");
  ok(/Your own conversation is not affected/.test(crossReact.error ?? "") && !/NO_REPLY/.test(crossReact.error ?? ""), "🔴 §5: …the refusal names the TARGET thread and does not tell the open conversation's turn to end");
  ok(turnCloseoutTripped("verbs-control", "turn_c1") === false, "🔴 §5: …and it does not arm the closeout of the turn in the open conversation");
  const openTs = "1757000000.000260";
  const reactOther = await control(() => attempt(() => armed(reactTool, controlCtx).execute({ emoji: "eyes", ts: openTs }, controlCtx)));
  ok(reactOther.ok, `§5/NEGATIVE CONTROL: an explicit \`ts\` on a message that is not a stopped thread still lands (${reactOther.error ?? "reacted"})`);
  ok(calls.some((c) => c.method === "reactions.add" && c.thread === openTs), "§5/NEGATIVE CONTROL: …and that reaction reached the platform");

  const { holdStandDownAck, spendStandDownAck, readStandDownAck } = await import("../agent/channels/engagement.js");
  const SPEND = "1757000000.000400";
  ok((await holdStandDownAck(partition, SPEND, "holder-6")) === "claimed", "§6/WIRING: a hold is claimed");
  const opsStore = getOperationalStore();
  const realGet = opsStore.getTaskResult.bind(opsStore);
  const holdKey = `stand-down-ack:${partition.surfaceKey}\n${SPEND}`;
  let failedReads = 0;
  (opsStore as unknown as Record<string, unknown>)["getTaskResult"] = async (org: string, key: string) => {
    if (key === holdKey) {
      failedReads += 1;
      throw new Error("staged hold read failure");
    }
    return realGet(org, key);
  };
  try {
    await spendStandDownAck(partition, SPEND, "holder-6");
  } finally {
    (opsStore as unknown as Record<string, unknown>)["getTaskResult"] = realGet;
  }
  ok(failedReads === 2, `§6/WIRING: the spend read the hold twice, and both reads failed (${failedReads})`);
  const afterFailedRead = await readStandDownAck(partition, SPEND);
  ok(afterFailedRead.kind === "held" && afterFailedRead.spent, `🔴 §6: a spend whose hold read failed still reads as SPENT — the fallback key is one the reader checks (read ${JSON.stringify(afterFailedRead)})`);
  const SPEND_OK = "1757000000.000410";
  await holdStandDownAck(partition, SPEND_OK, "holder-6b");
  ok((await readStandDownAck(partition, SPEND_OK)).kind === "held" && !(await readStandDownAck(partition, SPEND_OK) as { spent?: boolean }).spent, "§6/NEGATIVE CONTROL: an unspent hold with the same shape reads UNSPENT");
  await spendStandDownAck(partition, SPEND_OK, "holder-6b");
  ok((await readStandDownAck(partition, SPEND_OK) as { spent?: boolean }).spent === true, "§6/NEGATIVE CONTROL: …and a normal spend reads SPENT");

  const controlWorker = threadCtx(OPEN, "verbs-control-worker", "turn_cw1", { worker: true });
  const askBefore = visible(OPEN);
  const controlAsk = await (await workerSession(OPEN, "turn_cw1"))(() => attempt(() => askRoom.execute({ question: "Which region should the report cover?" }, controlWorker)));
  ok(controlAsk.ok, `NEGATIVE CONTROL: a worker's ask_room into a thread that did NOT stand down still posts (${controlAsk.error ?? "posted"})`);
  ok(visible(OPEN) === askBefore + 1, "NEGATIVE CONTROL: …and the question reached that thread");
} finally {
  globalThis.fetch = realFetch;
}
console.log(`\n✓ stand-down-verbs: ${n} assertions passed (post_file, edit_reply, react, ask_room and connector read the stand-down gate)`);
