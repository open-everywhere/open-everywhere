import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-supervisor-complete-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { completeSupervisorTurn } = await import("../agent/channels/supervisor-complete.js");
const { readAudit } = await import("../agent/audit/audit.js");
type FinalMessageAction = import("../agent/channels/turn-delivery.js").FinalMessageAction;

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const FAIL_SAFE_MARK = "no per-turn target";
const DROP_MARK = "message-tool-only: DROPPED terminal prose";

const PLATFORM = "oe708-ticketing";
const NO_REPLY_ACTION = "oe708.no_reply";
const REPLIED_ACTION = "oe708.replied";
const DROPPED_ACTION = "turn.supervisor_prose_dropped";

interface Outcome {
  readonly logs: readonly string[];
  readonly posted: readonly string[];
  readonly actions: readonly string[];
  readonly rows: ReadonlyArray<{ readonly action: string; readonly detail?: Record<string, unknown> }>;
}

async function runTurn(input: {
  readonly label: string;
  readonly action: FinalMessageAction;
  readonly hasTarget: boolean;
  readonly midTurnPost: boolean;
  readonly proseLeak?: { readonly repliedThisTurn: boolean };
  readonly postedChars?: number;
  readonly postThrows?: boolean;
}): Promise<Outcome> {
  const org = `oe708-${input.label}`;
  const logs: string[] = [];
  const posted: string[] = [];
  const row = { org, platform: PLATFORM, workspace: "ws-1", surface: "surface-1" };
  await completeSupervisorTurn({
    action: input.action,
    sessionId: `sess-${input.label}`,
    hasTarget: input.hasTarget,
    midTurnPost: input.midTurnPost,
    ...(input.proseLeak ? { proseLeak: input.proseLeak } : {}),
    noReplyAction: NO_REPLY_ACTION,
    repliedAction: REPLIED_ACTION,
    contextRow: row,
    repliedRow: row,
    silentAnchor: { ticket: 1 },
    droppedAnchor: { ticket: 1 },
    repliedAnchor: { ticket: 1 },
    post: async (text: string) => {
      posted.push(text);
      if (input.postThrows) throw new Error("the poster failed");
      return input.postedChars;
    },
    log: (m: string) => logs.push(m),
  });
  const rows = (await readAudit({ org, limit: 50 })) as ReadonlyArray<{ action: string; detail?: Record<string, unknown> }>;
  return { logs, posted, actions: rows.map((r) => r.action), rows };
}

const has = (o: Outcome, mark: string) => o.logs.some((l) => l.includes(mark));

{
  const o = await runTurn({ label: "order-unified-notarget", action: { kind: "post", text: "stray prose" }, hasTarget: false, midTurnPost: true, proseLeak: { repliedThisTurn: false } });
  ok(has(o, DROP_MARK), "§1a a unified turn with no target takes the message-tool-only gate");
  ok(!has(o, FAIL_SAFE_MARK), "🔴 §1b THE ORDER: the gate PRECEDES the no-target fail safe — a unified turn never logs the fail-safe line");
  ok(o.posted.length === 0, "§1c nothing posts on either branch");
  ok(o.actions.includes(DROPPED_ACTION), "§1d the drop is audited (a live-gate drop is audited even on a cleared target)");
  ok(!o.actions.includes(REPLIED_ACTION), "§1e no replied row on a dropped turn");
}

{
  const o = await runTurn({ label: "gateopen-notarget", action: { kind: "post", text: "an answer nobody can receive" }, hasTarget: false, midTurnPost: false });
  ok(has(o, FAIL_SAFE_MARK), "🔴 §2a the fail-safe line IS emitted when the gate fails open and no target resolved");
  ok(!has(o, DROP_MARK), "§2b the gate dropped nothing — it failed open");
  ok(o.posted.length === 0, "§2c FAIL SAFE: nothing posts into a guessed conversation");
  ok(o.rows.length === 0, "§2d the fail-safe branch writes NO audit row — the dispatched row stays open (the gap OPE-720 closes)");
  ok(!o.actions.includes(DROPPED_ACTION), "§2e no dropped row either — the gate never ran");
}

{
  const o = await runTurn({ label: "gateopen-target", action: { kind: "post", text: "the real reply" }, hasTarget: true, midTurnPost: false });
  ok(o.posted.length === 1 && o.posted[0] === "the real reply", "§3a the reply posts through the injected poster");
  ok(!has(o, FAIL_SAFE_MARK), "§3b no fail-safe line when a target resolved");
  ok(o.actions.includes(REPLIED_ACTION), "§3c the replied row closes the dispatched row");
  ok(o.rows.find((r) => r.action === REPLIED_ACTION)?.detail?.chars === "the real reply".length, "§3d the replied row's chars fall back to the raw text length when post returns nothing");
}

{
  const texts = ["ok", "a much longer terminal completion than the first one", "NO_REPLY-looking but not the sentinel"];
  for (const [i, text] of texts.entries()) {
    const o = await runTurn({ label: `textindep-${i}`, action: { kind: "post", text }, hasTarget: false, midTurnPost: false });
    ok(has(o, FAIL_SAFE_MARK) && o.posted.length === 0, `§4a[${i}] the no-target verdict is identical for completion ${JSON.stringify(text)}`);
  }
  for (const [i, text] of texts.entries()) {
    const o = await runTurn({ label: `textindep-target-${i}`, action: { kind: "post", text }, hasTarget: true, midTurnPost: false });
    ok(!has(o, FAIL_SAFE_MARK) && o.posted.length === 1, `§4b[${i}] and the with-target verdict is identical for the same completion`);
  }
}

{
  const silent = await runTurn({ label: "silent-notarget", action: { kind: "silent", reason: "judged not warranted" }, hasTarget: false, midTurnPost: false });
  ok(!has(silent, FAIL_SAFE_MARK), "§5a a SILENT turn with no target logs no fail-safe line — the silence row is the record");
  ok(silent.actions.includes(NO_REPLY_ACTION), "§5b the silence writes its no_reply lifecycle row");
  ok(silent.rows.find((r) => r.action === NO_REPLY_ACTION)?.detail?.reason === "judged not warranted", "§5c the row carries the judged reason");

  const buffered = await runTurn({ label: "buffer-notarget", action: { kind: "buffer-tool-status" }, hasTarget: false, midTurnPost: false });
  ok(buffered.logs.length === 0 && buffered.actions.length === 0, "§5d a mid-turn tool call is not terminal — no line, no row");
}

{
  const leak = await runTurn({ label: "leak-yes", action: { kind: "post", text: "stray" }, hasTarget: true, midTurnPost: true, proseLeak: { repliedThisTurn: false } });
  ok(leak.actions.includes(DROPPED_ACTION), "§6a prose with NO tool reply this turn is a leak — audited");

  const trailing = await runTurn({ label: "leak-no", action: { kind: "post", text: "stray" }, hasTarget: true, midTurnPost: true, proseLeak: { repliedThisTurn: true } });
  ok(!has(trailing, DROP_MARK), "§6b trailing narration AFTER a real tool reply is dropped silently — not a leak");
  ok(!trailing.actions.includes(DROPPED_ACTION), "§6c and writes no row");
  ok(trailing.posted.length === 0, "§6d it still never posts");
}

{
  const o = await runTurn({ label: "post-throws", action: { kind: "post", text: "will not land" }, hasTarget: true, midTurnPost: false, postThrows: true });
  ok(o.posted.length === 1, "§7a the poster was called");
  ok(o.logs.some((l) => l.includes("reply delivery failed")), "§7b the failure is logged, never rethrown");
  ok(!o.actions.includes(REPLIED_ACTION), "§7c a failed post writes NO replied row — the row means the bytes landed");
}

{
  const o = await runTurn({ label: "posted-chars", action: { kind: "post", text: "raw" }, hasTarget: true, midTurnPost: false, postedChars: 42 });
  ok(o.rows.find((r) => r.action === REPLIED_ACTION)?.detail?.chars === 42, "§8 the replied row records the ACTUAL posted length the poster returned");
}

rmSync(dir, { recursive: true, force: true });
console.log(`supervisor-complete: ${n} assertions passed`);
