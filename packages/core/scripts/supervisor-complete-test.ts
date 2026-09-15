import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-supervisor-complete-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { completeSupervisorTurn, SUPERVISOR_REPLIED_ROUTE } = await import("../agent/channels/supervisor-complete.js");
const { readAudit } = await import("../agent/audit/audit.js");
type FinalMessageAction = import("../agent/channels/turn-delivery.js").FinalMessageAction;

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const DROP_MARK = "message-tool-only: DROPPED terminal prose";
const NO_ROUTE_MARK = "declares no mid-turn post route";

const PLATFORM = "oe811-ticketing";
const NO_REPLY_ACTION = "oe811.no_reply";
const REPLIED_ACTION = "oe811.replied";
const DROPPED_ACTION = "turn.supervisor_prose_dropped";

interface Outcome {
  readonly logs: readonly string[];
  readonly actions: readonly string[];
  readonly rows: ReadonlyArray<{ readonly action: string; readonly detail?: Record<string, unknown> }>;
}

async function runTurn(input: {
  readonly label: string;
  readonly action: FinalMessageAction;
  readonly repliedViaTool: boolean;
  readonly midTurnPost?: boolean;
}): Promise<Outcome> {
  const org = `oe811-${input.label}`;
  const logs: string[] = [];
  const row = { org, platform: PLATFORM, workspace: "ws-1", surface: "surface-1" };
  await completeSupervisorTurn({
    action: input.action,
    sessionId: `sess-${input.label}`,
    repliedViaTool: input.repliedViaTool,
    midTurnPost: input.midTurnPost ?? true,
    noReplyAction: NO_REPLY_ACTION,
    repliedAction: REPLIED_ACTION,
    contextRow: row,
    repliedRow: row,
    silentAnchor: { ticket: 1 },
    droppedAnchor: { ticket: 1 },
    repliedAnchor: { ticket: 1 },
    log: (m: string) => logs.push(m),
  });
  const rows = (await readAudit({ org, limit: 50 })) as ReadonlyArray<{ action: string; detail?: Record<string, unknown> }>;
  return { logs, actions: rows.map((r) => r.action), rows };
}

const has = (o: Outcome, mark: string) => o.logs.some((l) => l.includes(mark));

{
  const o = await runTurn({ label: "tool-then-noreply", action: { kind: "silent", reason: "no_reply tool: nothing further" }, repliedViaTool: true });
  ok(o.actions.includes(REPLIED_ACTION), "🔴 §1a a turn that replied through the tool and finished with no_reply writes the REPLIED row");
  ok(!o.actions.includes(NO_REPLY_ACTION), "🔴 §1b and NOT the no_reply row — the silence count must not swallow every disciplined reply");
  ok(o.rows.length === 1, "§1c exactly ONE terminal row closes the dispatch");
  const replied = o.rows.find((r) => r.action === REPLIED_ACTION);
  ok(replied?.detail?.route === SUPERVISOR_REPLIED_ROUTE, "§1d the row states the reply came from the tool route");
  ok(replied?.detail?.ticket === 1, "§1e the row carries the caller's repliedAnchor detail");
  ok(replied?.detail?.sessionId === "sess-tool-then-noreply", "§1f the row carries the sessionId → the audit→transcript join holds");
  ok(replied?.detail?.chars === undefined, "§1g and NO chars — the canonical reply.post row owns the byte count, so the two never double-count");
}

{
  const o = await runTurn({ label: "tool-then-prose", action: { kind: "post", text: "some trailing narration" }, repliedViaTool: true });
  ok(o.actions.includes(REPLIED_ACTION), "§2a a turn that replied through the tool AND wrote closing prose still writes the replied row");
  ok(!o.actions.includes(DROPPED_ACTION), "🔴 §2b trailing narration after a real reply is NOT audited as a dropped-prose leak");
  ok(!has(o, DROP_MARK), "§2c and it is not logged as one either");
  ok(o.rows.length === 1, "§2d still exactly one terminal row");
}

{
  const silent = await runTurn({ label: "silent-no-tool", action: { kind: "silent", reason: "judged not warranted" }, repliedViaTool: false });
  ok(silent.actions.includes(NO_REPLY_ACTION), "🔴 §3a NEGATIVE CONTROL: a genuinely silent turn writes the no_reply row");
  ok(!silent.actions.includes(REPLIED_ACTION), "🔴 §3b and NOT the replied row — `repliedViaTool` is what moves the verdict");
  ok(silent.rows.find((r) => r.action === NO_REPLY_ACTION)?.detail?.reason === "judged not warranted", "§3c the row carries the judged reason");
  ok(silent.rows.length === 1, "§3d exactly one terminal row");

  const leak = await runTurn({ label: "prose-no-tool", action: { kind: "post", text: "an answer nobody will ever read" }, repliedViaTool: false });
  ok(has(leak, DROP_MARK), "🔴 §3e NEGATIVE CONTROL: closing prose with NO tool reply is DROPPED and logged");
  ok(leak.actions.includes(DROPPED_ACTION), "§3f and audited — the row is the only witness that an answer was owed");
  ok(!leak.actions.includes(REPLIED_ACTION) && !leak.actions.includes(NO_REPLY_ACTION), "§3g and it is neither a reply nor a judged silence");
  const dropped = leak.rows.find((r) => r.action === DROPPED_ACTION);
  ok(dropped?.detail?.chars === "an answer nobody will ever read".length, "§3h the drop row counts the lost completion — a COUNT, never the text");
  ok(dropped?.detail?.sessionId === "sess-prose-no-tool", "§3i the drop row carries the sessionId");
  ok(!Object.values(dropped?.detail ?? {}).some((v) => typeof v === "string" && v.includes("nobody will ever read")), "§3j taint-clean: no message text in the detail");
}

{
  for (const replied of [true, false]) {
    const o = await runTurn({ label: `buffer-${replied}`, action: { kind: "buffer-tool-status" }, repliedViaTool: replied });
    ok(o.logs.length === 0 && o.actions.length === 0, `§4 a mid-turn tool call writes no line and no row (repliedViaTool=${replied})`);
  }
}

{
  const o = await runTurn({ label: "no-post-arm", action: { kind: "post", text: "an answer with nowhere to go" }, repliedViaTool: false, midTurnPost: false });
  ok(has(o, NO_ROUTE_MARK), "🔴 §5a a surface with NO mid-turn post arm logs LOUDLY that the answer cannot be delivered");
  ok(!has(o, DROP_MARK), "§5b it does not claim a message-tool-only drop it never made");
  ok(o.rows.length === 0, "§5c and writes no terminal row — the dispatched row stays open, which is the honest signal");

  const wired = await runTurn({ label: "no-post-arm-control", action: { kind: "post", text: "an answer with nowhere to go" }, repliedViaTool: false, midTurnPost: true });
  ok(has(wired, DROP_MARK) && !has(wired, NO_ROUTE_MARK), "§5d NEGATIVE CONTROL: with a post arm declared, the identical completion takes the drop branch");
}

rmSync(dir, { recursive: true, force: true });
console.log(`supervisor-complete: ${n} assertions passed`);
