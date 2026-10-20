import assert from "node:assert/strict";
import { BUDGET_MEMBERS_ONLY, renderBudgetStatus } from "../../agent/commands/core.js";
import { findWorkspaceGuest, roomSharing, showsDollarFigure, UNKNOWN_SLACK_USER_ID } from "./budget-guest.js";
import type { SlackRawCall } from "./memory-canvas.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n += 1;
};

function usersList(pages: readonly Record<string, unknown>[][]): { call: SlackRawCall; seen: Record<string, string>[] } {
  const seen: Record<string, string>[] = [];
  const call: SlackRawCall = async (method, params) => {
    assert.equal(method, "users.list");
    seen.push(params);
    const i = seen.length - 1;
    const next = i + 1 < pages.length ? `page${i + 1}` : "";
    return { ok: true, members: pages[i] ?? [], response_metadata: { next_cursor: next } };
  };
  return { call, seen };
}

{
  const { call } = usersList([[{ id: "U0MEMBER" }, { id: "U0BOT", is_bot: true, is_restricted: true }, { id: "U0GONE", deleted: true, is_restricted: true }]]);
  const r = await findWorkspaceGuest(call);
  ok(r.kind === "none" && r.checked === 3, `§1: members, a guest-flagged bot and a deleted guest yield no guest (got ${JSON.stringify(r)})`);
}

{
  const { call, seen } = usersList([[{ id: "U0MEMBER" }], [{ id: "U0MCG", is_restricted: true }]]);
  const r = await findWorkspaceGuest(call);
  ok(r.kind === "guest" && r.userId === "U0MCG" && r.why === "is_restricted", `§2a: a multi-channel guest on page 2 is found (got ${JSON.stringify(r)})`);
  ok(seen.length === 2 && seen[1]!.cursor === "page1", "§2a: the second page is read with the first page's cursor");
}
{
  const { call } = usersList([[{ id: "U0SCG", is_ultra_restricted: true }]]);
  const r = await findWorkspaceGuest(call);
  ok(r.kind === "guest" && r.userId === "U0SCG" && r.why === "is_ultra_restricted", `§2b: a single-channel guest is found (got ${JSON.stringify(r)})`);
}

{
  const r = await findWorkspaceGuest(async () => ({ ok: false, error: "missing_scope", needed: "users:read" }));
  ok(r.kind === "missing-scope" && r.scope === "users:read" && r.method === "users.list", `§3: a missing scope names the scope (got ${JSON.stringify(r)})`);
}

for (const flag of ["is_ext_shared", "is_shared", "is_org_shared", "is_pending_ext_shared"]) {
  const r = await roomSharing(async () => ({ ok: true, channel: { id: "C0", [flag]: true } }), "C0");
  ok(r.kind === "shared" && r.flag === flag, `§4: ${flag} marks the room shared (got ${JSON.stringify(r)})`);
}
{
  const r = await roomSharing(async () => ({ ok: true, channel: { id: "C0", is_ext_shared: false } }), "C0");
  ok(r.kind === "internal", `§4: a room with no sharing flag is internal (got ${JSON.stringify(r)})`);
  const failed = await roomSharing(async () => ({ ok: false, error: "channel_not_found" }), "C0");
  ok(failed.kind === "error" && failed.method === "conversations.info", `§4: a failed read is named (got ${JSON.stringify(failed)})`);
}

{
  const caps = { surfaceMonthlyUsd: 25, surfaceMonthlyTokens: 1_000_000, workspaceMonthlyUsd: 100, workspaceMonthlyTokens: 5_000_000 };
  const figures = renderBudgetStatus({ surfaceKey: "slack/T0/C0", workspaceKey: "slack/T0", surfaceTokens: 10, workspaceTokens: 20, surfaceUsd: 0, workspaceUsd: 0, caps });
  ok(showsDollarFigure(figures), "§5: the member's budget answer shows a dollar figure, even at $0.00");
  ok(!showsDollarFigure(BUDGET_MEMBERS_ONLY), "§5: the guest refusal shows no dollar figure");
  ok(figures !== BUDGET_MEMBERS_ONLY, "§5: the member's answer is not the refusal");
}

ok(/^U[A-Z0-9]+$/u.test(UNKNOWN_SLACK_USER_ID), "§6: the unknown id is uppercase letters and digits after U");

console.log(`budget-guest: ${n} checks passed`);
