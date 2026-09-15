import { makeSelector, normalizeSelection, type MemorySelection } from "../agent/memory/selection.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const sub = (...segs: string[]) => segs;

{
  const all = makeSelector(normalizeSelection({ recursive: true }));
  ok(all.includes(sub()) && all.descends(sub()), "recursive:true → root included + descends");
  ok(all.includes(sub("B")) && all.includes(sub("B", "D")), "recursive:true → whole subtree included");

  const rootOnly = makeSelector(normalizeSelection({ recursive: false }));
  ok(rootOnly.includes(sub()) && !rootOnly.descends(sub()), "recursive:false → root included, no descend");
  ok(!rootOnly.includes(sub("B")), "recursive:false → child NOT included");

  const def = makeSelector(normalizeSelection({}));
  ok(def.includes(sub("B", "D")), "no toggle → defaults to recurse");
}

{
  const sel: MemorySelection = { default: "include", rules: [{ path: "B", mode: "recurse" }, { path: "C", mode: "exclude" }] };
  const s = makeSelector(sel);
  ok(s.includes(sub()), "A+B+D: root (A) included");
  ok(s.descends(sub()), "A+B+D: descends root (a deeper rule forces the walk)");
  ok(s.includes(sub("B")) && s.descends(sub("B")), "A+B+D: B included + recursed");
  ok(s.includes(sub("B", "D")), "A+B+D: D included (via B recurse)");
  ok(!s.includes(sub("C")) && !s.descends(sub("C")), "A+B+D: C excluded, not descended");

  const s2 = makeSelector({ default: "include", rules: [{ path: "B", mode: "recurse" }] });
  ok(!s2.includes(sub("C")), "default include → unticked C excluded without an explicit rule");
  ok(s2.includes(sub("B", "D")), "default include → B recurse still pulls D");
}

{
  const s = makeSelector({ default: "recurse", rules: [{ path: "C", mode: "exclude" }] });
  ok(s.includes(sub("B")) && s.includes(sub("B", "D")), "recurse-prune: B subtree kept");
  ok(!s.includes(sub("C")) && !s.descends(sub("C")), "recurse-prune: C dropped");
}

{
  const s = makeSelector({ default: "include", rules: [{ path: "B", mode: "include" }] });
  ok(s.includes(sub("B")), "include-mode: B itself taken");
  ok(!s.descends(sub("B")) && !s.includes(sub("B", "D")), "include-mode: B's child D NOT taken");
}

{
  const s = makeSelector({ default: "recurse", rules: [{ path: "B", mode: "exclude" }, { path: "B/D", mode: "include" }] });
  ok(!s.includes(sub("B")), "deep override: B excluded");
  ok(s.descends(sub("B")), "deep override: still descends B to reach B/D");
  ok(s.includes(sub("B", "D")), "deep override: B/D ticked back on");
}

{
  const s = makeSelector({ default: "include" });
  ok(s.includesLeaf(sub(), "notes.md"), "leaf: root-level file taken under default include");
  ok(!s.includesLeaf(sub("subdir"), "x.md"), "leaf: file in unticked sub-dir not taken");

  const s2 = makeSelector({ default: "recurse", rules: [{ path: "secret.md", mode: "exclude" }] });
  ok(!s2.includesLeaf(sub(), "secret.md"), "leaf: file-specific exclude drops one file");
  ok(s2.includesLeaf(sub(), "other.md"), "leaf: sibling file still taken");
}

{
  const s = makeSelector({ default: "include", rules: [{ path: "Deep Dive", mode: "recurse" }] });
  ok(s.includes(sub("deep-dive")), "normalise: 'Deep Dive' rule matches 'deep-dive' node");
  ok(s.includes(sub("DEEP-DIVE")), "normalise: case-insensitive node match");

  const sid = makeSelector({ default: "include", rules: [{ path: "abc123", mode: "recurse" }] });
  ok(sid.includes(sub("whatever-title"), "abc123"), "id match: rule path matches the page id");
  ok(!sid.includes(sub("whatever-title"), "other-id"), "id match: non-matching id is not selected");
}

console.log(`✓ selection: ${passed} assertions passed`);
