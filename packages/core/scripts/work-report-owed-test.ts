import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-work-report-owed-")), "ops.sqlite3");

const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
_setDeploymentIdentityForTest({ workspace: "dev" });
const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureCodec();

const work = await import("../agent/channels/work.js");
const { workResultAttributes } = await import("../agent/channels/unified.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { auditReplyPost } = await import("../agent/channels/reply-post.js");
const { notePromisedReport, SETTLEMENT_REPORT_SKIPPED_ACTION } = await import("../agent/access/pending-delegation-signal.js");
const spawnTaint = (await import("../agent/hooks/spawn-taint.js")).default as unknown as { events: Record<string, (e: unknown, c: unknown) => unknown> };
const noReply = (await import("../agent/tools/no_reply.js")).default as unknown as {
  readonly execute: (i: Record<string, unknown>, c: unknown) => Promise<{ acknowledged?: boolean }>;
};

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
const ROTATED_SEAT_TOKEN = "oe-dom:e2e-unified:oe-sup:g8";
const RESULT_WAKE = "23602360-1111-4222-8333-444444444444";
const DISPATCH_WAKE = "23602360-5555-4666-8777-888888888888";
const REQUESTER = { kind: "requester" as const, principalId: "U_ALICE" };

const resultCtx = (sessionId: string, turnId: string, attributes: Record<string, unknown>) => ({
  channel: { kind: "unified", continuationToken: `unified:${ROTATED_SEAT_TOKEN}` },
  session: {
    id: sessionId,
    turn: { id: turnId, sequence: 1 },
    auth: { current: { attributes: { oe_platform: "github", oe_wake_id: RESULT_WAKE, oe_window_token: ROTATED_SEAT_TOKEN, ...attributes } } },
  },
  agent: { name: "oe", nodeId: "__root__" },
});

const skippedRows = async (): Promise<Record<string, unknown>[]> =>
  (await readAudit({ org: ORG, action: SETTLEMENT_REPORT_SKIPPED_ACTION })).map((r) => (r.detail ?? {}) as Record<string, unknown>);

const turnStarted = spawnTaint.events["turn.started"]!;
ok(typeof turnStarted === "function", "the seat's turn edge that arms the result wake's duty exists");

async function resultTurn(sessionId: string, turnId: string, attributes: Record<string, unknown>, before?: () => void) {
  return inSession(async () => {
    before?.();
    const ctx = resultCtx(sessionId, turnId, attributes);
    await turnStarted({}, ctx);
    const first = await noReply.execute({ reason: "not_relevant" }, ctx).then(
      (r) => ({ acknowledged: r.acknowledged === true, error: undefined as string | undefined }),
      (e: unknown) => ({ acknowledged: false, error: String(e) }),
    );
    const second = await noReply.execute({ reason: "not_relevant" }, ctx).then(
      (r) => ({ acknowledged: r.acknowledged === true, error: undefined as string | undefined }),
      (e: unknown) => ({ acknowledged: false, error: String(e) }),
    );
    return { first, second };
  });
}

console.log("§1 a rotated seat session that holds no promise still owes the report:");
{
  const REQ = "req-2360-rotated";
  const attributes = workResultAttributes({ requestId: REQ, requester: REQUESTER, nonMemberWake: false, tainted: false, reportOwed: true });
  const before = (await skippedRows()).length;
  const turn = await resultTurn("sess-rotated-2360", "turn-2360-a", attributes);
  ok(
    typeof turn.first.error === "string" && turn.first.error.includes("the worker's report has now arrived"),
    `🔴 §1: the first \`no_reply\` on the rotated session's result turn is REFUSED (got ${JSON.stringify(turn.first)})`,
  );
  ok(turn.first.acknowledged === false, "§1: …and that call recorded no silence");
  const skipped = await skippedRows();
  eq(skipped.length, before + 1, "🔴 §1/AUDIT: exactly one `delegation.settlement_report_skipped` row");
  eq(skipped[skipped.length - 1]?.task, work.workLedgerId(REQ), "§1/AUDIT: …naming the forwarded job's ledger id");
  eq(skipped[skipped.length - 1]?.reason, "not_relevant", "§1/AUDIT: …and the reason the model gave");
  ok(turn.second.acknowledged === true && turn.second.error === undefined, `§1: the SECOND \`no_reply\` goes through — a valve, never a wall (got ${JSON.stringify(turn.second)})`);
  eq((await skippedRows()).length, before + 1, "§1: …and writes no second skipped row");
}

console.log("§2 a result wake with no promise owes nothing:");
{
  const attributes = workResultAttributes({ requestId: "req-2360-unpromised", requester: REQUESTER, nonMemberWake: false, tainted: false });
  eq(attributes[work.OE_WORK_RESULT_OWED_ATTR], undefined, "§2: a result wake built without a promise carries no promise stamp");
  const before = (await skippedRows()).length;
  const turn = await resultTurn("sess-unpromised-2360", "turn-2360-b", attributes);
  ok(turn.first.acknowledged === true && turn.first.error === undefined, `🔴 §2 NEGATIVE CONTROL: \`no_reply\` is accepted when nobody was promised the result (got ${JSON.stringify(turn.first)})`);
  eq((await skippedRows()).length, before, "§2: …and no skipped row is written");
  const forged = workResultAttributes({ requestId: "req-2360-forged", requester: REQUESTER, nonMemberWake: false, tainted: false, reportOwed: false });
  eq(forged[work.OE_WORK_RESULT_OWED_ATTR], undefined, "§2: `reportOwed: false` stamps nothing");
}

console.log("§3 a session promise without the stamp still arms the duty:");
{
  const REQ = "req-2360-same-session";
  const attributes = workResultAttributes({ requestId: REQ, requester: REQUESTER, nonMemberWake: false, tainted: false });
  const before = (await skippedRows()).length;
  const turn = await resultTurn("sess-same-2360", "turn-2360-c", attributes, () => notePromisedReport(work.workLedgerId(REQ)));
  ok(typeof turn.first.error === "string", `§3: the session promise alone refuses the first \`no_reply\` (got ${JSON.stringify(turn.first)})`);
  eq((await skippedRows()).length, before + 1, "§3: …with one skipped row");
}

console.log("§4 the store holds the promise once, until its result wake spends it:");
{
  const REQ = "req-2360-store";
  const at = new Date().toISOString();
  eq(await work.workReportPromised(store, ORG, REQ), false, "§4: no promise before the hand-off note");
  await work.rememberWorkReportPromised(store, ORG, REQ, at);
  eq(await work.workReportPromised(store, ORG, REQ), true, "🔴 §4: the hand-off note's promise is readable from the store, from any session");
  await work.rememberWorkReportPromised(store, ORG, REQ, at);
  eq(await work.workReportPromised(store, ORG, REQ), true, "§4: a repeat note keeps one unspent promise");
  await work.spendWorkReportPromise(store, ORG, REQ, at);
  eq(await work.workReportPromised(store, ORG, REQ), false, "🔴 §4: a spent promise arms nothing again");
  await work.rememberWorkReportPromised(store, ORG, REQ, at);
  eq(await work.workReportPromised(store, ORG, REQ), false, "§4: a replayed note cannot un-spend it");
  eq(work.workRequestIdOfLedger(work.workLedgerId(REQ)), REQ, "§4: a work ledger id names its request");
  eq(work.workRequestIdOfLedger("agent-k7m2q9"), undefined, "§4: an eve task id names no request");
  eq(work.workRequestIdOfLedger("work:"), undefined, "§4: an empty request id names nothing");

  const BREQ = "req-2360-brief";
  eq(await work.readWorkBrief(store, ORG, BREQ), undefined, "§4: no brief before the forward");
  await work.rememberWorkBrief(store, ORG, BREQ, "Open a PR for the README.", at);
  eq(await work.readWorkBrief(store, ORG, BREQ), "Open a PR for the README.", "🔴 §4: the forward's brief is readable from the store, from any session");
  await work.rememberWorkBrief(store, ORG, "req-2360-long", "x".repeat(work.WORK_BRIEF_MAX_CHARS + 50), at);
  eq((await work.readWorkBrief(store, ORG, "req-2360-long"))?.length, work.WORK_BRIEF_MAX_CHARS, "§4: a long brief is cut at the cap");
  await work.rememberWorkBrief(store, ORG, "req-2360-blank", "   ", at);
  eq(await work.readWorkBrief(store, ORG, "req-2360-blank"), undefined, "§4: a blank brief writes no row");
}

console.log("§5 a result wake into a rotated seat carries the forwarded request, fenced:");
{
  const ORIGIN = { platform: "slack", channelId: "C_ROOM", threadTs: "100.1" } as const;
  const BRIEF = "Summarise issue gh-28431 in one line and include the token gh-28431.";
  const base = {
    wakeId: RESULT_WAKE,
    origin: ORIGIN,
    requestId: "req-2360-render",
    taskId: "agent-2360r",
    status: "completed" as const,
    text: "gh-28431: the build fails on Windows paths.",
    nowIso: "2026-03-22T13:17:00.000Z",
    dispatchWakeId: DISPATCH_WAKE,
  };
  const rotated = work.renderWorkResultWake({ ...base, rotated: { brief: BRIEF, forwardedAtIso: "2026-03-22T13:10:00.000Z" } });
  const note = /<system-note>([\s\S]*?)<\/system-note>/.exec(rotated)?.[1] ?? "";
  ok(note.includes("This seat session did not forward this job"), "🔴 §5: the trusted note says the seat rotated");
  ok(note.includes("The first message below is the request"), "§5: …and points at the forwarded request");
  ok(note.includes("the last message below"), "§5: …and names the result as the LAST message");
  eq(/^[ \t]*for wake (\S+)[ \t]*$/m.exec(note)?.[1], DISPATCH_WAKE, "§5: the address line still stands on its own line");
  ok(!note.includes(BRIEF), "🔴 §5: the brief is model text, so it never rides the trusted note");
  ok(rotated.includes("Summarise issue gh-28431"), "🔴 §5: the forwarded request reaches the rotated session");
  ok(rotated.indexOf("Summarise issue gh-28431") < rotated.indexOf("the build fails on Windows paths"), "§5: …before the result");
  ok(rotated.includes(`work-result-${base.taskId}`), "§5: the result keeps its own message id");

  const noBrief = work.renderWorkResultWake({ ...base, rotated: { forwardedAtIso: "2026-03-22T13:10:00.000Z" } });
  ok(noBrief.includes("is not on record"), "§5: a row with no brief says the request is not on record");
  ok(!noBrief.includes("The first message below"), "§5: …and points at no message that is not there");

  const plain = work.renderWorkResultWake(base);
  ok(!plain.includes("did not forward this job"), "🔴 §5 NEGATIVE CONTROL: a seat that did not rotate reads the ordinary note");
  ok(plain.includes("Its result is the message below"), "§5: …which names the one message");
}

console.log("§6 the reply.post row carries the post's done intent:");
{
  const audit = { org: ORG, platform: "github", workspace: "acme", route: "tool" as const };
  await auditReplyPost(audit, "c-2361-handoff", "github", 40, false);
  await auditReplyPost(audit, "c-2361-answer", "github", 80, true);
  await auditReplyPost(audit, "c-2361-unknown", "github", 10);
  const rows = (await readAudit({ org: ORG, action: "reply.post" })).map((r) => (r.detail ?? {}) as Record<string, unknown>);
  const byId = (id: string) => rows.find((d) => d.id === id);
  eq(byId("c-2361-handoff")?.done, false, "🔴 §6: a hand-off note's row says done:false");
  eq(byId("c-2361-answer")?.done, true, "🔴 §6: an answer's row says done:true");
  ok(byId("c-2361-unknown") !== undefined && !("done" in (byId("c-2361-unknown") ?? {})), "§6: a post with no intent writes no `done` key — unknown, never a guess");
}

console.log(`\n✓ work-report-owed: ${n} assertions`);
