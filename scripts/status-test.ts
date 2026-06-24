import {
  STATUS_REACTION,
  ALL_STATUS_REACTIONS,
  PINNED_HEADER,
  statusItemLine,
  upsertStatusItem,
  statusItems,
  renderPinned,
  statusSeed,
} from "../agent/status/status.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(STATUS_REACTION.working === "hourglass_flowing_sand" && STATUS_REACTION.blocked === "octagonal_sign", "reaction names map the four states");
ok(ALL_STATUS_REACTIONS.length === 4 && new Set(ALL_STATUS_REACTIONS).size === 4, "four distinct status reactions");

const line = statusItemLine("sess-1", "working", "Investigating  the   flaky test", "2026-06-24");
ok(line.startsWith("- ⏳ ") && line.includes("`sess-1`"), "item line carries icon + id key");
ok(line.includes("Investigating the flaky test"), "item line collapses whitespace");

let md = statusSeed("slack/T1/C9");
md = upsertStatusItem(md, "sess-1", statusItemLine("sess-1", "working", "Task A", "t1"));
md = upsertStatusItem(md, "sess-2", statusItemLine("sess-2", "working", "Task B", "t2"));
ok(statusItems(md).length === 2, "two items after two upserts");

md = upsertStatusItem(md, "sess-1", statusItemLine("sess-1", "done", "Task A", "t3"));
const items = statusItems(md);
ok(items.length === 2, "upserting an existing id replaces in place, doesn't duplicate");
ok(items.some((l) => l.includes("`sess-1`") && l.startsWith("- ✅")), "sess-1 now shows done (✅)");
ok(items[0].includes("`sess-1`"), "order preserved on in-place replace");

md = upsertStatusItem(md, "sess-1", null);
ok(statusItems(md).length === 1 && !md.includes("`sess-1`"), "null line removes the item");

ok(renderPinned(md).startsWith(PINNED_HEADER), "pinned message leads with the find marker");
ok(renderPinned(md).includes("`sess-2`"), "pinned message lists active items");
ok(renderPinned(statusSeed("x")).includes("_(idle)_"), "no items -> idle marker");
ok(renderPinned(undefined).startsWith(PINNED_HEADER), "render is defensive on empty body");

console.log(`✓ status: ${passed} assertions passed`);
