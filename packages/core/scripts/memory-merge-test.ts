import assert from "node:assert/strict";
import { mergePreservingConflicts, hashFiles, conflictName } from "../agent/hooks/memory.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const start = { "A.md": "a" };
  const baseline = hashFiles(start);
  const hostCurrent = { "A.md": "a", "B.md": "b-from-other" };
  const sandbox = { "A.md": "a" };
  const { files, conflicts } = mergePreservingConflicts(hostCurrent, sandbox, baseline, "sess1");
  ok(files["A.md"] === "a" && files["B.md"] === "b-from-other", "the other session's new file is preserved (not wiped)");
  ok(conflicts.length === 0, "no conflict when we didn't change the file the other session added");
}

{
  const start = { "MEMORY.md": "v1" };
  const baseline = hashFiles(start);
  const hostCurrent = { "MEMORY.md": "v1" };
  const sandbox = { "MEMORY.md": "v1\n- our new bullet" };
  const { files, conflicts } = mergePreservingConflicts(hostCurrent, sandbox, baseline, "sess1");
  ok(files["MEMORY.md"] === "v1\n- our new bullet", "our edit persists when nobody else touched the file");
  ok(conflicts.length === 0, "no conflict when the host copy is unchanged since session start");
  ok(Object.keys(files).length === 1, "no spurious conflict sibling created");
}

{
  const start = { "MEMORY.md": "v1" };
  const baseline = hashFiles(start);
  const hostCurrent = { "MEMORY.md": "v1\n- other session bullet" };
  const sandbox = { "MEMORY.md": "v1\n- our bullet" };
  const { files, conflicts } = mergePreservingConflicts(hostCurrent, sandbox, baseline, "sessABC12345");
  ok(files["MEMORY.md"] === "v1\n- our bullet", "our version becomes the live file");
  ok(conflicts.length === 1 && conflicts[0] === "MEMORY.md", "the same-file collision is reported");
  const cname = conflictName("MEMORY.md", "sessABC12345");
  ok(files[cname] === "v1\n- other session bullet", "the concurrent version is preserved as a conflict sibling (NOT silently lost)");
  ok(cname === "MEMORY.conflict-sessABC1.md", "conflict sibling is named next to the file, sid truncated to 8 chars");
}

{
  const baseline = hashFiles({});
  const { files, conflicts } = mergePreservingConflicts({}, { "NEW.md": "x" }, baseline, "s");
  ok(files["NEW.md"] === "x" && conflicts.length === 0, "a brand-new file is added without a spurious conflict");
}

{
  const baseline = hashFiles({ "MEMORY.conflict-old.md": "keep" });
  const hostCurrent = { "MEMORY.conflict-old.md": "changed-by-other" };
  const sandbox = { "MEMORY.conflict-old.md": "changed-by-us" };
  const { conflicts } = mergePreservingConflicts(hostCurrent, sandbox, baseline, "s");
  ok(conflicts.length === 0, "a `.conflict-` file is never itself conflicted (no infinite nesting)");
}

console.log(`\n✓ memory-merge: ${n} assertions passed (cross-file preserve, same-file conflict sibling, no silent loss)\n`);
