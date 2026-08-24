import assert from "node:assert";
import { LEAN_SEAT_TOOLS } from "../agent/access/lean-seat.js";
import editReplyDynamic from "../agent/tools/edit_reply.js";
import {
  registerSyntheticConfig,
  unifiedCtx,
  buildLeanSeatToolset,
  resolveDynamicEntry,
  type ToolCall,
} from "./eval/_offline-seat.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

registerSyntheticConfig({ unified: true });

console.log("1. mount/skip parity for the five OPE-1052 names:");
{
  for (const name of ["edit_reply", "stop_task", "spawn_task", "complete_thread", "set_dm_delivery"]) {
    ok(LEAN_SEAT_TOOLS.has(name), `sanity: ${name} is on the shipped lean roster`);
  }

  const calls: ToolCall[] = [];
  const skipped: string[] = [];
  const toolset = await buildLeanSeatToolset({ ctx: unifiedCtx, calls, resultFor: () => ({ ok: true }), onSkip: (name) => skipped.push(name) });

  const mountedEditReply = toolset.edit_reply as unknown as { description: string } | undefined;
  ok(mountedEditReply !== undefined, "🔴 OPE-1052: edit_reply mounts on the offline lean seat");
  const realEditReplyEntry = (await resolveDynamicEntry(editReplyDynamic, unifiedCtx)) as { description: string } | null;
  ok(realEditReplyEntry !== null, "sanity: the shipped edit_reply dynamic resolves on this ctx");
  eq(mountedEditReply!.description, realEditReplyEntry!.description, "edit_reply's mounted description is the SHIPPED definition's, not a re-typed approximation");

  for (const name of ["stop_task", "spawn_task", "complete_thread", "set_dm_delivery"]) {
    ok(!(name in toolset), `${name} is not mounted on the unified standing seat (real mount-predicate fact)`);
    ok(skipped.includes(name), `🔴 negative control: ${name}'s absence is EXPLICIT (reported via onSkip), not a silent omission`);
  }
}

console.log("2. the drift guard fires on a roster name this builder does not know:");
{
  const mutable = LEAN_SEAT_TOOLS as unknown as Set<string>;
  const bogusName = "ope_1052_bogus_tool_never_wired";
  ok(!mutable.has(bogusName), "sanity: the probe name is not already on the roster");
  mutable.add(bogusName);
  try {
    let threw: unknown;
    try {
      await buildLeanSeatToolset({ ctx: unifiedCtx, calls: [], resultFor: () => ({ ok: true }) });
    } catch (e) {
      threw = e;
    }
    ok(threw instanceof Error, "🔴 OPE-1052: a LEAN_SEAT_TOOLS name with no mount/skip arm makes buildLeanSeatToolset throw, not silently under-mount");
    ok(String((threw as Error)?.message).includes(bogusName), "the thrown error names the un-resolved tool, so the fix site is obvious");
  } finally {
    mutable.delete(bogusName);
  }
  ok(!mutable.has(bogusName), "cleanup: the roster is restored to its shipped membership");
}

console.log(`\n✓ offline-seat-roster-parity (OPE-1052): ${n} assertions passed (edit_reply/stop_task/spawn_task/complete_thread/set_dm_delivery are all resolved from the shipped roster, and a future un-wired name fails loud instead of silently under-mounting)`);
