import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-delegated-provenance-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { registerConfig } = await import("../agent/access/config.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { postReply, replyAuditFor } = await import("../agent/channels/reply-post.js");
type ReplyTarget = import("../agent/channels/reply-post.js").ReplyTarget;
const { PROVENANCE_FOOTER_PREFIX, REPLY_PROVENANCE_ACTION } = await import("../agent/channels/reply-provenance.js");
const { delegatedProvenanceKey, delegatingParentLink, delegatedSecondAddress, heldTurnWakeProvable, settleDelegatedReads } = await import("../agent/channels/delegated-provenance.js");
const { noteBorrowedRecordRead, noteAuthoredRecordRead, BORROWED_RECORD_KIND, BORROWED_READ_OP } = await import("../agent/channels/read-reach.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { taskWakeKey } = await import("../agent/channels/task-wake.js");
const { registerUnifiedWakeTarget } = await import("../agent/channels/unified-window.js");
const { registerSlackFixtureCodec } = await import("./_slack-test-stubs.js");
registerSlackFixtureCodec();
const { noteTurnBoundary } = await import("../agent/access/task-wake-signal.js");
const { applyTaskSettlement, noteTaskStarted, DELEGATED_PROVENANCE_ACTION } = await import("../agent/hooks/delegation-settlement.js");
const connectorAudit = await import("../agent/hooks/connector-audit.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;

const ORG = "acme";
const ANSWER = "The rollout is on track for Thursday.";
const SEAT_SESSION = "delegated-provenance-seat";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

interface SurfaceRow {
  readonly id: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly mode: "channel" | "dm";
  readonly target: ReplyTarget;
}

const SURFACES: readonly SurfaceRow[] = [
  { id: "slack", platform: "slack", workspace: "T1", surface: "C1", mode: "channel", target: { platform: "slack", channelId: "C1" } },
  { id: "discord", platform: "discord", workspace: "G1", surface: "D1", mode: "channel", target: { platform: "discord", channelId: "D1" } },
  {
    id: "teams",
    platform: "teams",
    workspace: "TEN1",
    surface: "TCONV1",
    mode: "channel",
    target: { platform: "teams", serviceUrl: "https://teams.example/v3", conversationId: "TCONV1" },
  },
  { id: "notion", platform: "notion", workspace: "NW1", surface: "NPAGE1", mode: "channel", target: { platform: "notion", discussionId: "NDISC1" } },
  { id: "linear", platform: "linear", workspace: "LORG", surface: "LTEAM", mode: "channel", target: { platform: "linear", issueId: "ISS-1" } },
  { id: "github", platform: "github", workspace: "acme", surface: "repo1", mode: "channel", target: { platform: "github", owner: "acme", repo: "repo1", issueNumber: 7 } },
  { id: "dm-seat", platform: "slack", workspace: "T1", surface: "DM1", mode: "dm", target: { platform: "slack", channelId: "DM1" } },
];

const posted: { platform: string; text: string; id: string }[] = [];

for (const platform of new Set(SURFACES.map((s) => s.platform))) {
  registerIdentityMapper(platform, (ctx) => {
    const attrs = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } } } }).session?.auth?.current?.attributes ?? {};
    const str = (k: string): string | undefined => (typeof attrs[k] === "string" ? (attrs[k] as string) : undefined);
    return {
      workspace: str("oe_ws"),
      surface: str("oe_sf"),
      mode: str("oe_mode") === "dm" ? "dm" : "channel",
      visibility: "private",
      trust: "internal",
      principalId: "U1",
      target: undefined,
    };
  });
  registerPostArm({
    platform,
    dispatchReply: async (_target, text) => {
      posted.push({ platform, text, id: `msg-${posted.length + 1}` });
      return `msg-${posted.length}`;
    },
  });
}

const lastPosted = (): string => posted[posted.length - 1]?.text ?? "";

async function lastShown(): Promise<string> {
  const last = posted[posted.length - 1];
  if (last === undefined) return "";
  ok(!last.text.includes(PROVENANCE_FOOTER_PREFIX), `🔴 OPE-2487: the room's bytes carry NO sources footer (saw: ${JSON.stringify(last.text.slice(0, 200))})`);
  const rows = await readAudit({ org: ORG, action: REPLY_PROVENANCE_ACTION });
  const row = [...rows].reverse().find((r) => (r.detail as { id?: string } | undefined)?.id === last.id);
  const sources = (row?.detail as { sources?: string } | undefined)?.sources;
  return sources === undefined ? last.text : `${last.text}\n\n${PROVENANCE_FOOTER_PREFIX} ${sources}`;
}

function seatCtx(row: SurfaceRow, turnId: string): BindableContext {
  return {
    channel: { kind: `channel:${row.platform}` },
    session: {
      id: SEAT_SESSION,
      turn: { id: turnId, sequence: 1 },
      auth: { current: { attributes: { oe_ws: row.workspace, oe_sf: row.surface, oe_mode: row.mode }, principalId: "U1", principalType: `${row.platform}-user` } },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as unknown as BindableContext;
}

function workerCtx(callId: string, turnId: string): BindableContext {
  return {
    channel: { kind: "subagent", continuationToken: `subagent:${SEAT_SESSION}:${callId}` },
    session: {
      id: `worker-${callId}`,
      parent: { sessionId: SEAT_SESSION, callId },
      turn: { id: turnId, sequence: 1 },
      auth: { current: { attributes: { oe_ws: "T1", oe_sf: "C1" }, principalId: "U1", principalType: "slack-user" } },
    },
    agent: { name: "oe", nodeId: "worker" },
  } as unknown as BindableContext;
}

const hook = (connectorAudit.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> })["events"]!["action.result"]!;

const opResult = (toolName: string) => ({ data: { result: { callId: `call_${toolName}`, kind: "tool-result", toolName, output: {} }, status: "ok" } });

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function newSession(sessionId: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId, auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

async function awaitWorkerRow(childToken: string, expected: number): Promise<unknown> {
  for (let i = 0; i < 200; i++) {
    const raw = await getOperationalStore().getTaskResult(ORG, delegatedProvenanceKey(childToken));
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { reads?: unknown[] };
      if ((parsed.reads ?? []).length >= expected) return parsed;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  ok(false, `the worker's durable provenance row for ${childToken} never reached ${expected} read(s) — the WORKER end of the carriage is unwired`);
  return undefined;
}

async function runDelegation(input: {
  readonly row: SurfaceRow;
  readonly taskId: string;
  readonly callId: string;
  readonly seatTurnId: string;
  readonly tools: readonly string[];
  readonly status?: string;
}): Promise<void> {
  const childToken = `subagent:${SEAT_SESSION}:${input.callId}`;
  await noteTaskStarted({ taskId: input.taskId, callId: input.callId, turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
  const inWorker = newSession(`worker-${input.callId}`);
  await inWorker(async () => {
    for (const tool of input.tools) await hook(opResult(tool), workerCtx(input.callId, "worker_turn_1"));
  });
  if (input.tools.length > 0) await awaitWorkerRow(childToken, input.tools.length);
  await applyTaskSettlement(
    [{ taskId: input.taskId, status: input.status ?? "completed", agentId: null }],
    SEAT_SESSION,
    seatCtx(input.row, input.seatTurnId) as unknown as Parameters<typeof applyTaskSettlement>[2],
  );
}

async function provenanceRowsFor(messageId: string): Promise<readonly { detail?: Record<string, unknown> }[]> {
  const rows = await readAudit({ org: ORG, action: REPLY_PROVENANCE_ACTION });
  return rows.filter((r) => (r.detail as { id?: unknown } | undefined)?.id === messageId);
}

{
  let n = 0;
  for (const row of SURFACES) {
    n++;
    const turnId = `seat_turn_${n}`;
    const inSeat = newSession(SEAT_SESSION);
    let messageId = "";
    await inSeat(async () => {
      await runDelegation({ row, taskId: `agent-${n}`, callId: `call_${n}`, seatTurnId: turnId, tools: ["notion__get_page"] });
      messageId = await postReply(row.target, ANSWER, replyAuditFor(seatCtx(row, turnId), "tool", `wake-${n}`));
    });
    ok(
      (await lastShown()) === `${ANSWER}\n\n${PROVENANCE_FOOTER_PREFIX} notion`,
      `🔴 §1/${row.id}: the room receives the model's text plus the footer for the WORKER's read. This is the whole ticket — a seat that delegated the read used to post the answer with no footer at all ` +
        `(saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
    );
    const rows = await provenanceRowsFor(messageId);
    ok(rows.length === 1, `🔴 §1/${row.id}: the reply writes EXACTLY ONE ${REPLY_PROVENANCE_ACTION} row (saw ${rows.length})`);
    const detail = rows[0]?.detail ?? {};
    ok(
      Array.isArray(detail.connections) && (detail.connections as unknown[]).length === 1 && (detail.connections as unknown[])[0] === "notion",
      `§1/${row.id}: the row names the one connection the worker read (saw ${JSON.stringify(detail.connections)})`,
    );
    ok(
      detail.named === 1 && detail.withheld === 0,
      `🔴 §1/${row.id}: the reach rule NAMES it to this room and withholds nothing — the read was scoped to the room the seat is replying into (named=${String(detail.named)}, withheld=${String(detail.withheld)})`,
    );
    const carriedRows = (await readAudit({ org: ORG, action: DELEGATED_PROVENANCE_ACTION })).filter(
      (r) => (r.detail as { task?: unknown } | undefined)?.task === `agent-${n}`,
    );
    ok(
      carriedRows.length === 1 && (carriedRows[0]!.detail as { reads?: unknown }).reads === 1,
      `§1/${row.id}: the settle records WHAT IT CARRIED, so a missing footer in production can be told apart from a worker that read nothing (saw ${carriedRows.length} row(s))`,
    );
  }
}

{
  const row = SURFACES[0]!;
  const turnId = "seat_turn_control";
  const inSeat = newSession(SEAT_SESSION);
  let messageId = "";
  await inSeat(async () => {
    await hook(opResult("notion__get_page"), seatCtx(row, turnId));
    messageId = await postReply(row.target, `${ANSWER} (seat)`, replyAuditFor(seatCtx(row, turnId), "tool", "wake-control"));
  });
  ok(
    (await lastShown()) === `${ANSWER} (seat)\n\n${PROVENANCE_FOOTER_PREFIX} notion`,
    `🔴 §2: a seat-turn read names the connection ONCE — not twice, and not "notion, notion" (saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );
  const rows = await provenanceRowsFor(messageId);
  ok(rows.length === 1, `🔴 §2: and it writes EXACTLY ONE ${REPLY_PROVENANCE_ACTION} row (saw ${rows.length})`);
  ok(delegatingParentLink(seatCtx(row, turnId)) === null, "🔴 §2: a seat context resolves NO delegating parent, so a seat's own read can reach no delegated row");
  ok(delegatingParentLink({ channel: { continuationToken: "subagent:P:C:X" } }) === null, "🔴 §2: a token with a colon in it is DECLINED, never parsed greedily");
  const greedy = await getOperationalStore().getTaskResult(ORG, delegatedProvenanceKey("subagent:P:C:X"));
  ok(greedy === null, "🔴 §2: …and no row exists under the key a greedy parse would have produced");
}

{
  const row = SURFACES[0]!;
  const turnId = "seat_turn_empty";
  const inSeat = newSession(SEAT_SESSION);
  let messageId = "";
  await inSeat(async () => {
    await runDelegation({ row, taskId: "agent-empty", callId: "call_empty", seatTurnId: turnId, tools: [] });
    messageId = await postReply(row.target, `${ANSWER} (empty)`, replyAuditFor(seatCtx(row, turnId), "tool", "wake-empty"));
  });
  ok(
    (await lastShown()) === `${ANSWER} (empty)`,
    `🔴 §3: a delegation whose worker read no connector delivers the model's text BYTE-IDENTICAL — no footer, not even a trailing newline (saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );
  ok((await provenanceRowsFor(messageId)).length === 0, "🔴 §3: …and writes NO provenance row. An empty record is still a claim, and there is nothing to claim");
  const carried = (await readAudit({ org: ORG, action: DELEGATED_PROVENANCE_ACTION })).filter((r) => (r.detail as { task?: unknown } | undefined)?.task === "agent-empty");
  ok(carried.length === 0, "§3: the settle writes no carriage row either — its absence is what says the worker read nothing");
}

{
  const row = SURFACES[0]!;
  const inSeat = newSession(SEAT_SESSION);
  await inSeat(async () => {
    await noteTaskStarted({ taskId: "agent-shape", callId: "call_shape", turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
  });
  const inWorker = newSession("worker-call_shape");
  await inWorker(async () => {
    await hook(opResult("notion__get_page"), workerCtx("call_shape", "worker_turn_1"));
    await hook(opResult("notion__get_page"), workerCtx("call_shape", "worker_turn_1"));
    await hook(opResult("linear__list_issues"), workerCtx("call_shape", "worker_turn_1"));
    await hook(opResult("notion__create_page"), workerCtx("call_shape", "worker_turn_1"));
  });
  const parsed = (await awaitWorkerRow(`subagent:${SEAT_SESSION}:call_shape`, 2)) as { reads?: Record<string, unknown>[] };
  const reads = parsed.reads ?? [];
  ok(reads.length === 2, `🔴 §4: two DISTINCT reads are recorded and the repeat is folded; the WRITE op is not recorded at all (saw ${JSON.stringify(reads)})`);
  for (const read of reads) {
    ok(
      Object.keys(read).sort().join(",") === "connection,op",
      `🔴 §4: a CONNECTOR-door row carries the CONNECTION and the OP and NOTHING ELSE — no record, because rule (ii) is decided against the WORKER's own arrival stamp (saw keys ${Object.keys(read).sort().join(",")})`,
    );
  }
  ok(
    JSON.stringify(parsed).includes("tainted") === false && JSON.stringify(parsed).includes("kinds") === false,
    "🔴 §4: the TAINT MARK NEVER TRAVELS AS PROVENANCE. Taint says what a worker READ; provenance says which system a reply drew on. Folding the two would make a verdict readable as a source list",
  );
}

{
  const row = SURFACES[0]!;
  const turnId = "seat_turn_two";
  const inSeat = newSession(SEAT_SESSION);
  let messageId = "";
  await inSeat(async () => {
    await runDelegation({ row, taskId: "agent-a", callId: "call_a", seatTurnId: turnId, tools: ["notion__get_page"] });
    await runDelegation({ row, taskId: "agent-b", callId: "call_b", seatTurnId: turnId, tools: ["linear__list_issues"] });
    messageId = await postReply(row.target, `${ANSWER} (two)`, replyAuditFor(seatCtx(row, turnId), "tool", "wake-two"));
  });
  ok(
    (await lastShown()) === `${ANSWER} (two)\n\n${PROVENANCE_FOOTER_PREFIX} notion, linear`,
    `🔴 §5: BOTH workers' sources reach the one reply, in settle order. A carriage that replaced the ledger instead of appending would name only the second (saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );
  const rows = await provenanceRowsFor(messageId);
  ok(rows.length === 1 && ((rows[0]!.detail as { connections?: unknown[] }).connections ?? []).length === 2, "§5: one row for the one reply, naming both connections");
}

{
  const row = SURFACES[0]!;
  const inSeat = newSession(SEAT_SESSION);
  let messageId = "";
  await inSeat(async () => {
    await runDelegation({ row, taskId: "agent-spent_1", callId: "call_spent", seatTurnId: "seat_turn_spent_1", tools: ["notion__get_page"] });
    await postReply(row.target, `${ANSWER} (first)`, replyAuditFor(seatCtx(row, "seat_turn_spent_1"), "tool", "wake-spent-1"));
  });
  ok((await lastShown()).includes(`${PROVENANCE_FOOTER_PREFIX} notion`), "§6 precondition: the first answer carries the footer");
  const inSeat2 = newSession(SEAT_SESSION);
  await inSeat2(async () => {
    await noteTaskStarted({ taskId: "agent-spent_2", callId: "call_spent", turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
    await applyTaskSettlement(
      [{ taskId: "agent-spent_2", status: "completed", agentId: null }],
      SEAT_SESSION,
      seatCtx(row, "seat_turn_spent_2") as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    messageId = await postReply(row.target, `${ANSWER} (second)`, replyAuditFor(seatCtx(row, "seat_turn_spent_2"), "tool", "wake-spent-2"));
  });
  ok(
    (await lastShown()) === `${ANSWER} (second)`,
    `🔴 §6: the second answer is BYTE-IDENTICAL — the first carry SPENT the row, so nothing is footed onto a reply that drew on nothing (saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );
  ok((await provenanceRowsFor(messageId)).length === 0, "🔴 §6: …and it writes no provenance row either");
}

{
  const store = getOperationalStore();
  const WAKE_A = "wake-unified-a";
  const WAKE_B = "wake-unified-b";
  const at = new Date().toISOString();
  await store.putTaskResult(ORG, taskWakeKey("agent-uni_a"), JSON.stringify({ wakeId: WAKE_A }), at, 60_000);
  await store.putTaskResult(ORG, taskWakeKey("agent-uni_b"), JSON.stringify({ wakeId: WAKE_B }), at, 60_000);

  const uniCtx = (turnId: string): BindableContext =>
    ({
      channel: { kind: "channel:unified" },
      session: {
        id: SEAT_SESSION,
        turn: { id: turnId, sequence: 2 },
        auth: { current: { attributes: { oe_platform: "slack", oe_ws: "T1", oe_sf: "C1", oe_mode: "channel" }, principalId: "U1", principalType: "slack-user" } },
      },
      agent: { name: "oe", nodeId: "__root__" },
    }) as unknown as BindableContext;

  const inSeat = newSession(SEAT_SESSION);
  let messageId = "";
  await inSeat(async () => {
    await noteTaskStarted({ taskId: "agent-uni_a", callId: "call_uni_a", turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
    await noteTaskStarted({ taskId: "agent-uni_b", callId: "call_uni_b", turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
    for (const [call, tool] of [
      ["call_uni_a", "notion__get_page"],
      ["call_uni_b", "linear__list_issues"],
    ] as const) {
      const inWorker = newSession(`worker-${call}`);
      await inWorker(async () => {
        await hook(opResult(tool), workerCtx(call, "worker_turn_1"));
      });
      await awaitWorkerRow(`subagent:${SEAT_SESSION}:${call}`, 1);
    }
    noteTurnBoundary("uni_turn_0", "stamp-1");
    noteTurnBoundary("uni_turn_1", "stamp-1");
    await applyTaskSettlement(
      [
        { taskId: "agent-uni_a", status: "completed", agentId: null },
        { taskId: "agent-uni_b", status: "completed", agentId: null },
      ],
      SEAT_SESSION,
      uniCtx("uni_turn_1") as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    messageId = await postReply({ platform: "slack", channelId: "C1" }, `${ANSWER} (unified)`, replyAuditFor(uniCtx("uni_turn_1"), "tool", WAKE_A));
  });
  ok(
    (await lastShown()) === `${ANSWER} (unified)\n\n${PROVENANCE_FOOTER_PREFIX} notion`,
    `🔴 §7: the reply answering wake A names ONLY the source read for A. Naming "linear" here would tell conversation A that conversation B consulted Linear — the OPE-1713 disclosure, reopened on the ` +
      `delegated road (saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );
  const rows = await provenanceRowsFor(messageId);
  ok(
    rows.length === 1 && ((rows[0]!.detail as { connections?: unknown[] }).connections ?? []).length === 1,
    `🔴 §7: and the durable row carries the one connection too — a withheld source is not in the ledger at all, so not even a "1 in another domain" count discloses it (saw ${JSON.stringify(rows[0]?.detail)})`,
  );
  const carriedRows = await readAudit({ org: ORG, action: DELEGATED_PROVENANCE_ACTION });
  const rowB = carriedRows.find((r) => (r.detail as { task?: unknown } | undefined)?.task === "agent-uni_b")?.detail as Record<string, unknown> | undefined;
  ok(
    rowB?.outcome === "wake-unprovable" && rowB.found === 1 && rowB.reads === 0,
    `🔴 §7: the WITHHELD settlement is countable — the row says the worker recorded a source and this seat could not place it (saw ${JSON.stringify(rowB)})`,
  );
  const spentB = await getOperationalStore().getTaskResult(ORG, delegatedProvenanceKey(`subagent:${SEAT_SESSION}:call_uni_b`));
  ok(
    spentB !== null && (JSON.parse(spentB) as { reads?: unknown[] }).reads?.length === 0,
    "🔴 §7: a withheld settlement still SPENDS its row — leaving the reads in place would only move the wrong attribution onto this worker's next brief",
  );
}

{
  const row = SURFACES[0]!;
  const inSeat = newSession(SEAT_SESSION);
  let messageId = "";
  await inSeat(async () => {
    await runDelegation({ row, taskId: "agent-dead", callId: "call_dead", seatTurnId: "seat_turn_dead", tools: ["notion__get_page"], status: "failed" });
    messageId = await postReply(row.target, "The research worker failed before it answered.", replyAuditFor(seatCtx(row, "seat_turn_dead"), "tool", "wake-dead"));
  });
  ok(
    (await lastShown()) === "The research worker failed before it answered.",
    `🔴 §8: a FAILED delegation's reads never reach the reply — the answer has no sources, so it carries no receipt (saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );
  ok((await provenanceRowsFor(messageId)).length === 0, "🔴 §8: …and it writes no provenance row either");
  const deadRow = (await readAudit({ org: ORG, action: DELEGATED_PROVENANCE_ACTION })).find((r) => (r.detail as { task?: unknown } | undefined)?.task === "agent-dead")?.detail as
    | Record<string, unknown>
    | undefined;
  ok(deadRow?.outcome === "not-completed" && deadRow.found === 1 && deadRow.reads === 0, `§8: the withholding is countable and says why (saw ${JSON.stringify(deadRow)})`);
}

{
  const store = getOperationalStore();
  const TASK_WAKE = "wake-inherited-task";
  const DELIVERED_WAKE = "wake-inherited-delivered";
  const at = new Date().toISOString();
  const origin = { platform: "slack", channelId: "C1", threadTs: "111.1" } as const;
  await registerUnifiedWakeTarget(store, ORG, DELIVERED_WAKE, origin, at, "win-1");
  await registerUnifiedWakeTarget(store, ORG, TASK_WAKE, origin, at, "win-1");
  await store.putTaskResult(ORG, taskWakeKey("agent-inherited"), JSON.stringify({ wakeId: TASK_WAKE }), at, 60_000);

  const uniCtx = (turnId: string): BindableContext =>
    ({
      channel: { kind: "channel:unified" },
      session: {
        id: SEAT_SESSION,
        turn: { id: turnId, sequence: 3 },
        auth: {
          current: { attributes: { oe_platform: "slack", oe_ws: "T1", oe_sf: "C1", oe_mode: "channel", oe_wake_id: DELIVERED_WAKE }, principalId: "U1", principalType: "slack-user" },
        },
      },
      agent: { name: "oe", nodeId: "__root__" },
    }) as unknown as BindableContext;

  const inSeat = newSession(SEAT_SESSION);
  let messageId = "";
  await inSeat(async () => {
    await noteTaskStarted({ taskId: "agent-inherited", callId: "call_inherited", turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
    const inWorker = newSession("worker-call_inherited");
    await inWorker(async () => {
      await hook(opResult("notion__get_page"), workerCtx("call_inherited", "worker_turn_1"));
    });
    await awaitWorkerRow(`subagent:${SEAT_SESSION}:call_inherited`, 1);
    noteTurnBoundary("inh_turn_0", "stamp-inh");
    noteTurnBoundary("inh_turn_1", "stamp-inh");
    await applyTaskSettlement(
      [{ taskId: "agent-inherited", status: "completed", agentId: null }],
      SEAT_SESSION,
      uniCtx("inh_turn_1") as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    messageId = await postReply({ platform: "slack", channelId: "C1" }, `${ANSWER} (inherited)`, replyAuditFor(uniCtx("inh_turn_1"), "tool", DELIVERED_WAKE));
  });
  ok(
    (await lastShown()) === `${ANSWER} (inherited)\n\n${PROVENANCE_FOOTER_PREFIX} notion`,
    `🔴 §9: the room receives the footer for the worker's read even though the reply answers the DELIVERED wake while the carried read was stamped with the TASK wake. A live run posted this answer bare ` +
      `(saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );
  const rows = await provenanceRowsFor(messageId);
  const detail = rows[0]?.detail ?? {};
  ok(
    rows.length === 1 && detail.named === 1 && detail.withheld === 0,
    `🔴 §9: and the durable row says NAMED — \`named:0\` with a non-zero \`withheld\` beside a carried settlement is the exact a live run signature (saw ${JSON.stringify(detail)})`,
  );
}

{
  const store = getOperationalStore();
  const TASK_WAKE = "wake-sibling-task";
  const SIBLING_WAKE = "wake-sibling-delivered";
  const at = new Date().toISOString();
  await registerUnifiedWakeTarget(store, ORG, TASK_WAKE, { platform: "slack", channelId: "C1", threadTs: "222.2" }, at, "win-1");
  await registerUnifiedWakeTarget(store, ORG, SIBLING_WAKE, { platform: "slack", channelId: "C-SIBLING", threadTs: "333.3" }, at, "win-1");
  await store.putTaskResult(ORG, taskWakeKey("agent-sibling"), JSON.stringify({ wakeId: TASK_WAKE }), at, 60_000);

  const uniCtx = (turnId: string): BindableContext =>
    ({
      channel: { kind: "channel:unified" },
      session: {
        id: SEAT_SESSION,
        turn: { id: turnId, sequence: 4 },
        auth: {
          current: { attributes: { oe_platform: "slack", oe_ws: "T1", oe_sf: "C1", oe_mode: "channel", oe_wake_id: SIBLING_WAKE }, principalId: "U1", principalType: "slack-user" },
        },
      },
      agent: { name: "oe", nodeId: "__root__" },
    }) as unknown as BindableContext;

  const inSeat = newSession(SEAT_SESSION);
  let messageId = "";
  await inSeat(async () => {
    await noteTaskStarted({ taskId: "agent-sibling", callId: "call_sibling", turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
    const inWorker = newSession("worker-call_sibling");
    await inWorker(async () => {
      await hook(opResult("notion__get_page"), workerCtx("call_sibling", "worker_turn_1"));
    });
    await awaitWorkerRow(`subagent:${SEAT_SESSION}:call_sibling`, 1);
    noteTurnBoundary("sib_turn_0", "stamp-sib");
    noteTurnBoundary("sib_turn_1", "stamp-sib");
    await applyTaskSettlement(
      [{ taskId: "agent-sibling", status: "completed", agentId: null }],
      SEAT_SESSION,
      uniCtx("sib_turn_1") as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    messageId = await postReply({ platform: "slack", channelId: "C-SIBLING" }, `${ANSWER} (sibling)`, replyAuditFor(uniCtx("sib_turn_1"), "tool", SIBLING_WAKE));
  });
  ok(
    !(await lastShown()).includes("notion") && (await lastShown()).startsWith(`${ANSWER} (sibling)`),
    `🔴 §10: the reply into the SIBLING conversation never NAMES the source. The task's worker read Notion for another room, and §9's second address must not carry the name here — that is OPE-1713 ` +
      `(saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );
  const detail = (await provenanceRowsFor(messageId))[0]?.detail ?? {};
  ok(
    detail.named === 0 && detail.withheld === 1,
    `🔴 §10: …and the durable row says so — nothing named, one connection withheld from this room (saw ${JSON.stringify(detail)})`,
  );

  const SAME_ROOM_WAKE = "wake-sibling-same-room";
  await registerUnifiedWakeTarget(store, ORG, SAME_ROOM_WAKE, { platform: "slack", channelId: "C1", threadTs: "222.2" }, at, "win-1");
  ok(
    (await delegatedSecondAddress({ org: ORG, taskWakeId: TASK_WAKE, inheritedWakeId: SIBLING_WAKE, outcome: "installed" })) === undefined,
    "🔴 §10: ARM 1 — two ids whose origins name DIFFERENT rooms are refused. This is the OPE-1713 arm, asserted on the rule rather than only on the footer above",
  );
  ok(
    (await delegatedSecondAddress({ org: ORG, taskWakeId: TASK_WAKE, inheritedWakeId: SAME_ROOM_WAKE, outcome: "installed" })) === SAME_ROOM_WAKE,
    "🔴 §10: POSITIVE CONTROL — the SAME two calls differing only in the inherited id's ROOM are admitted, so arm 1 refuses on the origin comparison and not on something incidental to the fixture",
  );
  ok(
    (await delegatedSecondAddress({ org: ORG, taskWakeId: TASK_WAKE, inheritedWakeId: SAME_ROOM_WAKE, outcome: "already" })) === undefined,
    "🔴 §10: ARM 2 — a same-room stamp is STILL refused on a non-`installed` outcome. `already` means a sibling task took the turn first, so this turn never adopted THIS task's wake",
  );
  ok(
    (await delegatedSecondAddress({ org: ORG, taskWakeId: TASK_WAKE, inheritedWakeId: "wake-never-registered", outcome: "installed" })) === undefined,
    "🔴 §10: ARM 3 — a stamp with NO wake row is refused. The proof fails closed on an unreadable origin rather than admitting an id it could not place",
  );
  ok(
    (await delegatedSecondAddress({ org: ORG, taskWakeId: TASK_WAKE, inheritedWakeId: TASK_WAKE, outcome: "installed" })) === undefined,
    "🔴 §10: ARM 4 — an inherited stamp EQUAL to the minted id widens nothing, so it is refused rather than written as a duplicate address",
  );

  const SAME_CHANNEL_OTHER_THREAD = "wake-sibling-same-channel";
  await registerUnifiedWakeTarget(store, ORG, SAME_CHANNEL_OTHER_THREAD, { platform: "slack", channelId: "C1", threadTs: "999.9" }, at, "win-1");
  const held = (turnWakeId: string | undefined, outcome: "ingressed" | "installed" | "already", sameSession: boolean | undefined): Promise<boolean> =>
    heldTurnWakeProvable({ org: ORG, outcome, sameSession, taskWakeId: TASK_WAKE, turnWakeId });
  ok(await held(SAME_ROOM_WAKE, "ingressed", true), "🔴 §10b: a held turn whose delivered wake names the task's OWN conversation proves the carriage — without it every result-step reply loses its footer");
  ok(!(await held(SIBLING_WAKE, "ingressed", true)), "🔴 §10b: a held turn whose delivered wake names a conversation in ANOTHER channel is refused — OPE-1713 on the held-turn road");
  ok(
    !(await held(SAME_CHANNEL_OTHER_THREAD, "ingressed", true)),
    "🔴 §10b: a held turn whose delivered wake names ANOTHER THREAD of the same channel is refused — the proof is the conversation, not the container",
  );
  ok(!(await held(SAME_ROOM_WAKE, "ingressed", false)), "🔴 §10b: a dispatch row another session wrote is refused — task ids are not org-unique (OPE-2309)");
  ok(!(await held(SAME_ROOM_WAKE, "ingressed", undefined)), "🔴 §10b: an `ingressed` verdict with no sameSession answer is refused, fail-closed");
  ok(!(await held(SAME_ROOM_WAKE, "already", true)), "🔴 §10b: the rule is the HELD turn's only — `already` keeps the equality rule");
  ok(!(await held("wake-never-registered", "ingressed", true)), "🔴 §10b: a delivered wake with no wake row is refused, fail-closed");
  ok(!(await held(undefined, "ingressed", true)), "🔴 §10b: a turn with no wake id proves nothing");
}

{
  const row = SURFACES[0]!;
  const LABEL = "Launch checklist";
  const OTHER_LABEL = "Release runbook";

  const inWorkerSeat = newSession(SEAT_SESSION);
  await inWorkerSeat(async () => {
    await noteTaskStarted({ taskId: "agent-borrow", callId: "call_borrow", turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
  });
  const inBorrowWorker = newSession("worker-call_borrow");
  await inBorrowWorker(async () => {
    noteBorrowedRecordRead(workerCtx("call_borrow", "worker_turn_1"), { connection: "notion", grantId: "g-1", targetLabel: LABEL });
    noteBorrowedRecordRead(workerCtx("call_borrow", "worker_turn_1"), { connection: "notion", grantId: "g-1", targetLabel: LABEL });
    noteBorrowedRecordRead(workerCtx("call_borrow", "worker_turn_1"), { connection: "notion", grantId: "g-2", targetLabel: OTHER_LABEL });
  });
  const borrowed = (await awaitWorkerRow(`subagent:${SEAT_SESSION}:call_borrow`, 2)) as { reads?: Record<string, unknown>[] };
  const borrowReads = borrowed.reads ?? [];
  ok(
    borrowReads.length === 2,
    `🔴 §11: two DISTINCT grants are two reads and the repeat is folded — the dedupe key carries the RECORD, not connection+op alone (saw ${JSON.stringify(borrowReads)})`,
  );
  ok(
    Object.keys(borrowReads[0] ?? {})
      .sort()
      .join(",") === "connection,op,record",
    `🔴 §11: a BORROW-door row carries the record beside the connection and the op (saw keys ${Object.keys(borrowReads[0] ?? {}).sort().join(",")})`,
  );
  ok(
    JSON.stringify(borrowReads[0]?.record) === JSON.stringify({ kind: BORROWED_RECORD_KIND, id: "g-1", name: LABEL }) && borrowReads[0]?.op === BORROWED_READ_OP,
    `🔴 §11: the record is the GRANT ROW and its PINNED TARGET — the label the owner approved, never a fetched page's own title (saw ${JSON.stringify(borrowReads[0])})`,
  );

  const turnId = "seat_turn_borrow";
  const inSeat = newSession(SEAT_SESSION);
  await inSeat(async () => {
    await applyTaskSettlement(
      [{ taskId: "agent-borrow", status: "completed", agentId: null }],
      SEAT_SESSION,
      seatCtx(row, turnId) as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    await postReply(row.target, `${ANSWER} (borrowed)`, replyAuditFor(seatCtx(row, turnId), "tool", "wake-borrow"));
  });
  ok(
    (await lastShown()) === `${ANSWER} (borrowed)\n\n${PROVENANCE_FOOTER_PREFIX} notion (${LABEL})`,
    `🔴 §11: THE WHOLE TICKET — the delegated borrowed read foots the PINNED TARGET, exactly as a seat-turn borrowed read does. It used to foot \`notion\` alone (saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );

  const inSeat2 = newSession(SEAT_SESSION);
  await inSeat2(async () => {
    await noteTaskStarted({ taskId: "agent-unpinned", callId: "call_unpinned", turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
  });
  const inUnpinnedWorker = newSession("worker-call_unpinned");
  await inUnpinnedWorker(async () => {
    noteBorrowedRecordRead(workerCtx("call_unpinned", "worker_turn_1"), { connection: "notion", grantId: "g-3" });
  });
  const unpinned = (await awaitWorkerRow(`subagent:${SEAT_SESSION}:call_unpinned`, 1)) as { reads?: Record<string, unknown>[] };
  ok(
    unpinned.reads?.[0]?.record === undefined,
    `🔴 §11/NEGATIVE CONTROL: a borrowed read with no recoverable label carries NO record at all (saw ${JSON.stringify(unpinned.reads?.[0])})`,
  );
  const unpinnedTurn = "seat_turn_unpinned";
  const inSeat3 = newSession(SEAT_SESSION);
  await inSeat3(async () => {
    await applyTaskSettlement(
      [{ taskId: "agent-unpinned", status: "completed", agentId: null }],
      SEAT_SESSION,
      seatCtx(row, unpinnedTurn) as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    await postReply(row.target, `${ANSWER} (unpinned)`, replyAuditFor(seatCtx(row, unpinnedTurn), "tool", "wake-unpinned"));
  });
  ok(
    (await lastShown()) === `${ANSWER} (unpinned)\n\n${PROVENANCE_FOOTER_PREFIX} notion`,
    `🔴 §11/NEGATIVE CONTROL: …and its reply names the connection alone, with no parenthesised target (saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
  );
}

{
  const URL_ = "https://www.notion.so/Launch-checklist-0123456789abcdef0123456789abcdef";
  const TITLE = "Launch checklist";
  const intents: { channelId: string; sources: readonly { name: string; url: string }[]; feedback: boolean }[] = [];
  registerPostArm({
    platform: "slack",
    isDirectConversation: (locus) => locus.channelId.startsWith("D"),
    dispatchReply: async (target, text, _replier, intent) => {
      const channelId = (target as { channelId: string }).channelId;
      intents.push({ channelId, sources: intent?.sources ?? [], feedback: intent?.feedback === true });
      posted.push({ platform: "slack", text, id: `msg-${posted.length + 1}` });
      return `msg-${posted.length}`;
    },
  });

  const delegateAuthoredRead = async (callId: string, taskId: string): Promise<void> => {
    const inSeat = newSession(SEAT_SESSION);
    await inSeat(async () => {
      await noteTaskStarted({ taskId, callId, turnId: "turn_seat_1", kind: "agent", tool: "agent" }, SEAT_SESSION);
    });
    const inWorker = newSession(`worker-${callId}`);
    await inWorker(async () => {
      noteAuthoredRecordRead(workerCtx(callId, "worker_turn_1"), { kind: "notion-page", id: "0123456789abcdef0123456789abcdef", name: TITLE, url: URL_ });
    });
  };

  await delegateAuthoredRead("call_cite_dm", "agent-cite-dm");
  const carried = (await awaitWorkerRow(`subagent:${SEAT_SESSION}:call_cite_dm`, 1)) as { reads?: Record<string, unknown>[] };
  ok(
    JSON.stringify(carried.reads?.[0]?.cite) === JSON.stringify({ kind: "notion-page", id: "0123456789abcdef0123456789abcdef", name: TITLE, url: URL_ }),
    `🔴 §12: the worker's row carries the citation — kind, id, title and url (saw ${JSON.stringify(carried.reads?.[0])})`,
  );
  ok(carried.reads?.[0]?.record === undefined, "§12: …and still NO record: rule (ii) is decided against the worker's own stamps, which name no room");

  const dmRow = SURFACES.find((r) => r.id === "dm-seat")!;
  const dmTurn = "seat_turn_cite_dm";
  const inSeatDm = newSession(SEAT_SESSION);
  await inSeatDm(async () => {
    await applyTaskSettlement(
      [{ taskId: "agent-cite-dm", status: "completed", agentId: null }],
      SEAT_SESSION,
      seatCtx(dmRow, dmTurn) as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    await postReply(dmRow.target, `${ANSWER} (cited)`, replyAuditFor(seatCtx(dmRow, dmTurn), "tool", "wake-cite-dm"));
  });
  const dmIntent = intents[intents.length - 1];
  ok(
    dmIntent?.channelId === "DM1" && dmIntent.sources.length === 1 && dmIntent.sources[0]?.name === TITLE && dmIntent.sources[0]?.url === URL_,
    `🔴 §12: THE TICKET — the delegated read reaches the person's 1:1 reply as ONE numbered source link, with its title and url (saw ${JSON.stringify(dmIntent)})`,
  );
  ok(dmIntent?.feedback === true, "🔴 §12: …and the answer asks for the surface's native thumbs");
  ok(!lastPosted().includes(URL_) && !lastPosted().includes("Sources"), "§12: the link rides the intent, never the answer's text: the arm draws it natively");
  const dmRows = await readAudit({ org: ORG, action: REPLY_PROVENANCE_ACTION });
  const dmRowRec = [...dmRows].reverse().find((r) => (r.detail as { id?: string } | undefined)?.id === posted[posted.length - 1]?.id);
  ok((dmRowRec?.detail as { links?: number } | undefined)?.links === 1, `🔴 §12: the durable row records ONE link shown (saw ${JSON.stringify(dmRowRec?.detail)})`);

  await delegateAuthoredRead("call_cite_ch", "agent-cite-ch");
  await awaitWorkerRow(`subagent:${SEAT_SESSION}:call_cite_ch`, 1);
  const chRow = SURFACES[0]!;
  const chTurn = "seat_turn_cite_ch";
  const inSeatCh = newSession(SEAT_SESSION);
  await inSeatCh(async () => {
    await applyTaskSettlement(
      [{ taskId: "agent-cite-ch", status: "completed", agentId: null }],
      SEAT_SESSION,
      seatCtx(chRow, chTurn) as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    await postReply(chRow.target, `${ANSWER} (shared)`, replyAuditFor(seatCtx(chRow, chTurn), "tool", "wake-cite-ch"));
  });
  const chIntent = intents[intents.length - 1];
  ok(
    chIntent?.channelId === "C1" && chIntent.sources.length === 0,
    `🔴 §12/NEGATIVE CONTROL: a reply in a SHARED room carries no source link, though the read was carried to it (saw ${JSON.stringify(chIntent)})`,
  );
  ok(chIntent?.feedback === true, "§12/NEGATIVE CONTROL: …and the thumbs still go out: a rating discloses nothing");

  await delegateAuthoredRead("call_cite_replay", "agent-cite-replay");
  const replayToken = `subagent:${SEAT_SESSION}:call_cite_replay`;
  await awaitWorkerRow(replayToken, 1);
  const settled = await settleDelegatedReads({ org: ORG, childToken: replayToken, sessionId: SEAT_SESSION, turnId: "seat_turn_cite_replay", reach: undefined, replayKey: "replay-1" });
  ok(settled.found === 1, "§12 precondition: the replay-keyed settle found the worker's read");
  const spentRaw = await getOperationalStore().getTaskResult(ORG, delegatedProvenanceKey(replayToken));
  ok(spentRaw !== null && spentRaw.includes("read_notion_page"), "§12: the spent form still holds the read, for a replay");
  ok(!String(spentRaw).includes(URL_) && !String(spentRaw).includes(TITLE), `🔴 §12: …and neither the title nor the url (saw ${String(spentRaw).slice(0, 240)})`);
}

{
  const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
  const row = SURFACES[0]!;
  const turnId = "seat_turn_taint_off";
  registerSettings({ taint: { mode: "off" } } as never);
  try {
    const inSeat = newSession(SEAT_SESSION);
    await inSeat(async () => {
      await runDelegation({ row, taskId: "agent-taint-off", callId: "call_taint_off", seatTurnId: turnId, tools: ["notion__get_page"] });
      await postReply(row.target, ANSWER, replyAuditFor(seatCtx(row, turnId), "tool", "wake-taint-off"));
    });
    ok(
      (await lastShown()) === `${ANSWER}\n\n${PROVENANCE_FOOTER_PREFIX} notion`,
      `🔴 §TAINT-OFF: with \`taint.mode: "off"\` the room still receives the footer for the WORKER's read — the settle found the join row and its childToken (saw: ${JSON.stringify((await lastShown()).slice(0, 200))})`,
    );
    const carried = (await readAudit({ org: ORG, action: DELEGATED_PROVENANCE_ACTION })).filter((r) => (r.detail as { task?: unknown } | undefined)?.task === "agent-taint-off");
    ok(carried.length === 1 && (carried[0]!.detail as { reads?: unknown }).reads === 1, `§TAINT-OFF: …and the settle records the one read it carried (saw ${carried.length} row(s))`);
  } finally {
    resetSettingsForTest();
  }
}

await removeTempDir(dir);
console.log(`delegated-provenance: ${passed} assertions passed`);
