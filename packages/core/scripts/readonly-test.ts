
import { readOnlyBanner, hasReadOnlyBanner, isProjectedCache, isAppendOnlyBacking, lockCommand } from "../agent/memory/readonly.js";
import type { MemorySilo } from "../agent/memory/silo.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const notion: MemorySilo = { name: "handbook", provider: "notion", container: "root", readOnly: true };
const baseline: MemorySilo = { name: "org-baseline", provider: "sqlite", readOnly: true };

ok(isProjectedCache(notion), "notion provider → projected cache");
ok(!isProjectedCache(baseline), "sqlite baseline → not a projected cache");

const notionWritable: MemorySilo = { name: "brain", provider: "notion", container: "root" };
ok(isAppendOnlyBacking(notionWritable), "writable notion silo → append-only backing");
ok(!isAppendOnlyBacking(notion), "read-only notion silo → NOT append-only (it never writes at all)");
ok(!isAppendOnlyBacking({ name: "repo-brain", provider: "github", container: "acme/brain" }), "writable github silo → NOT append-only (the files ARE the source)");
ok(!isAppendOnlyBacking(baseline), "sqlite baseline → NOT append-only");

const nb = readOnlyBanner(notion);
ok(nb.includes("READ-ONLY") && nb.includes("Notion tools"), "notion banner → redirects to the Notion tools");
ok(nb.includes("NOT save") && nb.includes("BLOCKED"), "notion banner → states edits are blocked + not saved");
ok(!nb.includes("remember"), "notion banner → does NOT point at a `remember` verb (there is none, and it would be the wrong route for a Notion cache anyway)");

const bb = readOnlyBanner(baseline);
ok(bb.includes("READ-ONLY") && bb.includes("writable silo"), "baseline banner → redirects to this channel's own writable silo");
ok(!bb.includes("remember"), "🔴 baseline banner → names NO `remember` tool — OPE-389 deleted the verb, and a redirect to a tool that does not exist redirects nowhere");
ok(!bb.includes("Notion tools"), "baseline banner → does NOT mention Notion tools");

ok(hasReadOnlyBanner(nb) && hasReadOnlyBanner(bb), "hasReadOnlyBanner detects both variants");
ok(!hasReadOnlyBanner("# Handbook\n\nplain content"), "hasReadOnlyBanner false for un-bannered content");
ok(hasReadOnlyBanner(nb + "# Handbook"), "hasReadOnlyBanner true once a banner is present");

ok(lockCommand("memory/handbook") === "chmod -R a-w 'memory/handbook'", "lock: recursive chmod a-w, single-quoted");
ok(lockCommand("memory/MEMORY.md").startsWith("chmod -R a-w "), "lock: works on a single file path too");

console.log(`✓ readonly: ${passed} assertions passed`);
