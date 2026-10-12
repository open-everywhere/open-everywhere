import {
  STATUS_REACTION,
  ALL_STATUS_REACTIONS,
  PINNED_HEADER,
  isPinnedStatusMessage,
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

ok(STATUS_REACTION.working === "eyes" && STATUS_REACTION.blocked === "octagonal_sign", "bot vocabulary: 👀 working + 🛑 blocked only (✅ is the humans' mark; no ❓ — parked ≠ question)");
ok(ALL_STATUS_REACTIONS.length === 2 && new Set(ALL_STATUS_REACTIONS).size === 2, "exactly two bot-set reactions — done is signalled by REMOVAL, not an emoji");

const line = statusItemLine("sess-1", "working", "Investigating  the   flaky test", "2026-06-24 09:30Z");
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
ok(renderPinned(md).includes("Task B") && !renderPinned(md).includes("sess-2"), "pinned message lists active items, and never their session id (OPE-2486)");
ok(renderPinned(upsertStatusItem(statusSeed("x"), "wrun_X1", statusItemLine("wrun_X1", "working", "Task C", "2026-06-24 09:30Z"))).endsWith("Task C · 24 June, 09:30 UTC"), "pinned message puts the time in words");
ok(renderPinned(statusSeed("x")).includes("_Nothing in progress._"), "no items -> idle marker");
ok(
  renderPinned(upsertStatusItem(statusSeed("x"), "s-9", statusItemLine("s-9", "working", "Fix the `npm test` · `build` thing", "2026-06-24 09:30Z"))).includes("Fix the `npm test` · `build` thing · 24 June"),
  "the pin keeps the person's own text whole, even when it holds a backtick span — only the trailing key is dropped",
);
ok(
  renderPinned(upsertStatusItem(statusSeed("x"), "s-10", statusItemLine("s-10", "working", "Deploy · `main`", "2026-06-24 09:30Z"))).includes("Deploy · `main` · 24 June"),
  "…and a summary that ENDS in a backtick span keeps it too",
);
ok(renderPinned(undefined).startsWith(PINNED_HEADER), "render is defensive on empty body");

ok(!/open ?everywhere/iu.test(PINNED_HEADER), "the pinned header names no brand — a deployment is locally namable");
ok(!/open ?everywhere/iu.test(statusSeed("x")), "…and neither does the STATUS.md seed");
ok(isPinnedStatusMessage("*Open Everywhere — current work*\n- ⏳ a thing"), "🔴 a pin under the old branded header is still recognised as ours");
ok(isPinnedStatusMessage("*OpenEverywhere — current work*\n_(idle)_"), "…and so is the older no-space header");
ok(isPinnedStatusMessage(renderPinned(undefined)), "…and so is a pin under the current header");
ok(!isPinnedStatusMessage("*Our team — current work*"), "NEGATIVE: a human pin with a similar shape is not ours");

console.log(`✓ status: ${passed} assertions passed`);
