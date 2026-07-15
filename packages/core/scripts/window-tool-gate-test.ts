import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-window-tool-gate-")), "ops.sqlite3");
delete process.env.OE_ORG;

import { windowGrainOf, type WindowGrain, type BindableContext } from "../agent/identity/binding.js";
import { formatWindowToken, taskWindowId } from "../agent/channels/window-key.js";
import { auditWindowToolGate } from "../agent/audit/window-tool-gate.js";
import { readAudit } from "../agent/audit/audit.js";

let n = 0;
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ctxFor = (token: string | undefined, grain?: string): BindableContext => ({
  channel: token === undefined ? { kind: "unified" } : { kind: "unified", continuationToken: token },
  session: { auth: { current: { attributes: grain ? { oe_grain: grain } : {} } } },
});

const LEGACY = formatWindowToken({ domain: "payments", windowId: "payments", generation: 3 });
const EXPLICIT = formatWindowToken({ domain: "payments", windowId: "slack/T1/C_PAY", generation: 3 });
const TASK = formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720000000.001"), generation: 3 });
const PER_CONTAINER = "slack/T1/C_PAY:oe-sup:g3";
const NATIVE = "cse_abc123def";

console.log("1. windowGrainOf backstop (token classification, no stamp):");
eq(windowGrainOf(ctxFor(LEGACY)), "standing", "legacy/degenerate window token ⇒ standing");
eq(windowGrainOf(ctxFor(EXPLICIT)), "standing", "explicit solo-window token ⇒ standing");
eq(windowGrainOf(ctxFor(TASK)), "task", "task (t/…) window token ⇒ task");
eq(windowGrainOf(ctxFor(PER_CONTAINER)), "standing", "per-container ambient (`<chan>:oe-sup:g`, not a window token) ⇒ standing");
eq(windowGrainOf(ctxFor(NATIVE)), "native", "native `cse_…` mention token (no supervisor suffix) ⇒ native");
eq(windowGrainOf(ctxFor(`unified:${LEGACY}`)), "standing", "a `unified:`-prefixed window token ⇒ standing after the strip");
eq(windowGrainOf(ctxFor(`unified:${TASK}`)), "task", "a `unified:`-prefixed TASK token ⇒ task after the strip");
eq(windowGrainOf(ctxFor(undefined)), "native", "a blank/unreadable token ⇒ native (full hands, the pre-gate default)");
eq(windowGrainOf(ctxFor("garbage")), "native", "an unrecognised token ⇒ native");

console.log("2. windowGrainOf primary (oe_grain stamp) precedence:");
eq(windowGrainOf(ctxFor(LEGACY, "standing")), "standing", "stamp standing + standing token ⇒ standing");
eq(windowGrainOf(ctxFor(TASK, "task")), "task", "stamp task + task token ⇒ task");
eq(windowGrainOf(ctxFor(undefined, "standing")), "standing", "stamp standing + BLANK token ⇒ standing (primary honoured; token degradation covered)");
eq(windowGrainOf(ctxFor(undefined, "task")), "task", "stamp task + BLANK token ⇒ task (primary honoured — the stamp is why a blank token is safe)");
eq(windowGrainOf(ctxFor(NATIVE, "native")), "native", "stamp native + native token ⇒ native");

console.log("3. windowGrainOf spoof-resistance (fail-closed to narrow):");
eq(windowGrainOf(ctxFor(PER_CONTAINER, "task")), "standing", "stamp task on a STANDING (per-container) token ⇒ standing (the spoof/bug case, fail-closed)");
eq(windowGrainOf(ctxFor(LEGACY, "task")), "standing", "stamp task on a STANDING window token ⇒ standing (fail-closed)");
eq(windowGrainOf(ctxFor(LEGACY, "native")), "standing", "stamp native on a STANDING window token ⇒ standing (a full claim loses to a standing token)");
eq(windowGrainOf(ctxFor(PER_CONTAINER, "garbage")), "standing", "an unrecognised stamp value ⇒ falls through to the token backstop (standing here)");
eq(windowGrainOf(ctxFor(NATIVE, "garbage")), "native", "an unrecognised stamp value ⇒ token backstop (native here) — never task");
ok(windowGrainOf(ctxFor(PER_CONTAINER)) !== "task" && windowGrainOf(ctxFor(NATIVE)) !== "task", "a non-task token never yields task grain without a host task-stamp on a task token");

console.log("4. auditWindowToolGate (turn.tool_gated row):");
await auditWindowToolGate({ org: "default", domain: "payments", grain: "standing", withheld: [], wakeId: "w-empty", sessionId: "s-empty" });
{
  const rows = await readAudit({ action: "turn.tool_gated" });
  eq(rows.length, 0, "empty withheld ⇒ NO turn.tool_gated row (Stage B fires for nothing in prod)");
}
const WITHHELD = ["checkout_repo", "bash", "open_pull_request"] as const;
await auditWindowToolGate({ org: "default", domain: "payments", grain: "standing", withheld: [...WITHHELD], wakeId: "w-1", sessionId: "s-1" });
{
  const rows = await readAudit({ action: "turn.tool_gated" });
  eq(rows.length, 1, "populated withheld ⇒ exactly one turn.tool_gated row");
  const row = rows[0];
  eq(row.action, "turn.tool_gated", "action is turn.tool_gated");
  eq(row.platform, "unified", "platform label is unified");
  eq(row.workspace, "payments", "workspace label is the domain");
  const detail = row.detail as Record<string, unknown>;
  eq(detail.grain, "standing", "detail.grain records the seat's grain");
  eq(detail.withheld, [...WITHHELD], "detail.withheld lists the tool NAMES");
  eq(detail.withheldCount, WITHHELD.length, "detail.withheldCount is the count");
  eq(detail.wakeId, "w-1", "detail carries the wakeId");
  eq(detail.sessionId, "s-1", "detail carries the sessionId");
  const allowedKeys = ["grain", "withheld", "withheldCount", "wakeId", "sessionId"].sort();
  eq(Object.keys(detail).sort(), allowedKeys, "detail carries names+counts+ids ONLY — no message/content/input field (taint rule)");
}

await auditWindowToolGate({ org: "default", domain: "acme", grain: "task" as WindowGrain, withheld: ["bash"], wakeId: "w-2", sessionId: "s-2" });
{
  const rows = await readAudit({ action: "turn.tool_gated", workspace: "acme" });
  eq(rows.length, 1, "a second workspace's row is isolated by the workspace filter");
  eq((rows[0].detail as Record<string, unknown>).grain, "task", "the row records whatever grain it was given");
}

console.log(`\nwindow-tool-gate: ${n} assertions passed.`);
