import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-delegated-provenance-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { registerConfig } = await import("../agent/access/config.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { postReply, replyAuditFor } = await import("../agent/channels/reply-post.js");
type ReplyTarget = import("../agent/channels/reply-post.js").ReplyTarget;
const { PROVENANCE_FOOTER_PREFIX, REPLY_PROVENANCE_ACTION } = await import("../agent/channels/reply-provenance.js");
const { delegatedProvenanceKey, delegatingParentLink } = await import("../agent/channels/delegated-provenance.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { taskWakeKey } = await import("../agent/channels/task-wake.js");
const { noteTurnBoundary } = await import("../agent/access/task-wake-signal.js");
const { applyTaskSettlement, noteTaskReceipt, DELEGATED_PROVENANCE_ACTION } = await import("../agent/hooks/spawn-taint.js");
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

const posted: { platform: string; text: string }[] = [];

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
      posted.push({ platform, text });
      return `msg-${posted.length}`;
    },
  });
}

const lastPosted = (): string => posted[posted.length - 1]?.text ?? "";

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
  await noteTaskReceipt({ taskId: input.taskId, callId: input.callId, agentId: null, tool: "agent" }, SEAT_SESSION);
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
      await runDelegation({ row, taskId: `task_${n}`, callId: `call_${n}`, seatTurnId: turnId, tools: ["notion__get_page"] });
      messageId = await postReply(row.target, ANSWER, replyAuditFor(seatCtx(row, turnId), "tool", `wake-${n}`));
    });
    ok(
      lastPosted() === `${ANSWER}\n\n${PROVENANCE_FOOTER_PREFIX} notion`,
      `🔴 §1/${row.id}: the room receives the model's text plus the footer for the WORKER's read. This is the whole ticket — a seat that delegated the read used to post the answer with no footer at all ` +
        `(saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
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
      (r) => (r.detail as { task?: unknown } | undefined)?.task === `task_${n}`,
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
    lastPosted() === `${ANSWER} (seat)\n\n${PROVENANCE_FOOTER_PREFIX} notion`,
    `🔴 §2: a seat-turn read names the connection ONCE — not twice, and not "notion, notion" (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
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
    await runDelegation({ row, taskId: "task_empty", callId: "call_empty", seatTurnId: turnId, tools: [] });
    messageId = await postReply(row.target, `${ANSWER} (empty)`, replyAuditFor(seatCtx(row, turnId), "tool", "wake-empty"));
  });
  ok(
    lastPosted() === `${ANSWER} (empty)`,
    `🔴 §3: a delegation whose worker read no connector delivers the model's text BYTE-IDENTICAL — no footer, not even a trailing newline (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
  );
  ok((await provenanceRowsFor(messageId)).length === 0, "🔴 §3: …and writes NO provenance row. An empty record is still a claim, and there is nothing to claim");
  const carried = (await readAudit({ org: ORG, action: DELEGATED_PROVENANCE_ACTION })).filter((r) => (r.detail as { task?: unknown } | undefined)?.task === "task_empty");
  ok(carried.length === 0, "§3: the settle writes no carriage row either — its absence is what says the worker read nothing");
}

{
  const row = SURFACES[0]!;
  const inSeat = newSession(SEAT_SESSION);
  await inSeat(async () => {
    await noteTaskReceipt({ taskId: "task_shape", callId: "call_shape", agentId: null, tool: "agent" }, SEAT_SESSION);
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
      `🔴 §4: a row carries the CONNECTION and the OP and NOTHING ELSE (saw keys ${Object.keys(read).sort().join(",")})`,
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
    await runDelegation({ row, taskId: "task_a", callId: "call_a", seatTurnId: turnId, tools: ["notion__get_page"] });
    await runDelegation({ row, taskId: "task_b", callId: "call_b", seatTurnId: turnId, tools: ["linear__list_issues"] });
    messageId = await postReply(row.target, `${ANSWER} (two)`, replyAuditFor(seatCtx(row, turnId), "tool", "wake-two"));
  });
  ok(
    lastPosted() === `${ANSWER} (two)\n\n${PROVENANCE_FOOTER_PREFIX} notion, linear`,
    `🔴 §5: BOTH workers' sources reach the one reply, in settle order. A carriage that replaced the ledger instead of appending would name only the second (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
  );
  const rows = await provenanceRowsFor(messageId);
  ok(rows.length === 1 && ((rows[0]!.detail as { connections?: unknown[] }).connections ?? []).length === 2, "§5: one row for the one reply, naming both connections");
}

{
  const row = SURFACES[0]!;
  const inSeat = newSession(SEAT_SESSION);
  let messageId = "";
  await inSeat(async () => {
    await runDelegation({ row, taskId: "task_spent_1", callId: "call_spent", seatTurnId: "seat_turn_spent_1", tools: ["notion__get_page"] });
    await postReply(row.target, `${ANSWER} (first)`, replyAuditFor(seatCtx(row, "seat_turn_spent_1"), "tool", "wake-spent-1"));
  });
  ok(lastPosted().includes(`${PROVENANCE_FOOTER_PREFIX} notion`), "§6 precondition: the first answer carries the footer");
  const inSeat2 = newSession(SEAT_SESSION);
  await inSeat2(async () => {
    await noteTaskReceipt({ taskId: "task_spent_2", callId: "call_spent", agentId: null, tool: "agent" }, SEAT_SESSION);
    await applyTaskSettlement(
      [{ taskId: "task_spent_2", status: "completed", agentId: null }],
      SEAT_SESSION,
      seatCtx(row, "seat_turn_spent_2") as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    messageId = await postReply(row.target, `${ANSWER} (second)`, replyAuditFor(seatCtx(row, "seat_turn_spent_2"), "tool", "wake-spent-2"));
  });
  ok(
    lastPosted() === `${ANSWER} (second)`,
    `🔴 §6: the second answer is BYTE-IDENTICAL — the first carry SPENT the row, so nothing is footed onto a reply that drew on nothing (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
  );
  ok((await provenanceRowsFor(messageId)).length === 0, "🔴 §6: …and it writes no provenance row either");
}

{
  const store = getOperationalStore();
  const WAKE_A = "wake-unified-a";
  const WAKE_B = "wake-unified-b";
  const at = new Date().toISOString();
  await store.putTaskResult(ORG, taskWakeKey("task_uni_a"), JSON.stringify({ wakeId: WAKE_A }), at, 60_000);
  await store.putTaskResult(ORG, taskWakeKey("task_uni_b"), JSON.stringify({ wakeId: WAKE_B }), at, 60_000);

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
    await noteTaskReceipt({ taskId: "task_uni_a", callId: "call_uni_a", agentId: null, tool: "agent" }, SEAT_SESSION);
    await noteTaskReceipt({ taskId: "task_uni_b", callId: "call_uni_b", agentId: null, tool: "agent" }, SEAT_SESSION);
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
        { taskId: "task_uni_a", status: "completed", agentId: null },
        { taskId: "task_uni_b", status: "completed", agentId: null },
      ],
      SEAT_SESSION,
      uniCtx("uni_turn_1") as unknown as Parameters<typeof applyTaskSettlement>[2],
    );
    messageId = await postReply({ platform: "slack", channelId: "C1" }, `${ANSWER} (unified)`, replyAuditFor(uniCtx("uni_turn_1"), "tool", WAKE_A));
  });
  ok(
    lastPosted() === `${ANSWER} (unified)\n\n${PROVENANCE_FOOTER_PREFIX} notion`,
    `🔴 §7: the reply answering wake A names ONLY the source read for A. Naming "linear" here would tell conversation A that conversation B consulted Linear — the OPE-1713 disclosure, reopened on the ` +
      `delegated road (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
  );
  const rows = await provenanceRowsFor(messageId);
  ok(
    rows.length === 1 && ((rows[0]!.detail as { connections?: unknown[] }).connections ?? []).length === 1,
    `🔴 §7: and the durable row carries the one connection too — a withheld source is not in the ledger at all, so not even a "1 in another domain" count discloses it (saw ${JSON.stringify(rows[0]?.detail)})`,
  );
  const carriedRows = await readAudit({ org: ORG, action: DELEGATED_PROVENANCE_ACTION });
  const rowB = carriedRows.find((r) => (r.detail as { task?: unknown } | undefined)?.task === "task_uni_b")?.detail as Record<string, unknown> | undefined;
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
    await runDelegation({ row, taskId: "task_dead", callId: "call_dead", seatTurnId: "seat_turn_dead", tools: ["notion__get_page"], status: "failed" });
    messageId = await postReply(row.target, "The research worker failed before it answered.", replyAuditFor(seatCtx(row, "seat_turn_dead"), "tool", "wake-dead"));
  });
  ok(
    lastPosted() === "The research worker failed before it answered.",
    `🔴 §8: a FAILED delegation's reads never reach the reply — the answer has no sources, so it carries no receipt (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
  );
  ok((await provenanceRowsFor(messageId)).length === 0, "🔴 §8: …and it writes no provenance row either");
  const deadRow = (await readAudit({ org: ORG, action: DELEGATED_PROVENANCE_ACTION })).find((r) => (r.detail as { task?: unknown } | undefined)?.task === "task_dead")?.detail as
    | Record<string, unknown>
    | undefined;
  ok(deadRow?.outcome === "not-completed" && deadRow.found === 1 && deadRow.reads === 0, `§8: the withholding is countable and says why (saw ${JSON.stringify(deadRow)})`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`delegated-provenance: ${passed} assertions passed`);
