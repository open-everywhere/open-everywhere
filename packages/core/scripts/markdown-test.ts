// proves: MEM-19

import {
  upsertUnderSection,
  sectionBullets,
  appendToTopicFile,
  trimSectionToRecent,
  ensureFullHistoryPointer,
  removeBulletLine,
} from "../agent/memory/markdown.js";

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
}

{
  const seed = "# Memory\n\n## People / ownership\n(none yet)\n\n## Notes\n(none yet)\n";
  const withFirst = upsertUnderSection(seed, "People / ownership", "- 2026-07-01: Ada owns billing");
  ok(withFirst.includes("- 2026-07-01: Ada owns billing"), "upsert: bullet lands under the section");
  ok(!withFirst.includes("(none yet)") || withFirst.includes("## Notes\n(none yet)"), "upsert: placeholder dropped from the touched section only");
  ok(withFirst.includes("## Notes\n(none yet)"), "upsert: an untouched section is left alone");

  const withSecond = upsertUnderSection(withFirst, "People / ownership", "2026-07-02: Bo owns payouts");
  ok(withSecond.includes("- 2026-07-01: Ada owns billing") && withSecond.includes("- 2026-07-02: Bo owns payouts"), "upsert: a second bullet appends after the first");

  const noHeading = upsertUnderSection("# Memory\n", "Decisions", "- 2026-07-01: shipped v2");
  ok(noHeading.includes("## Decisions\n- 2026-07-01: shipped v2"), "upsert: an absent section is created");

  const bare = upsertUnderSection("", "Notes", "note one");
  ok(bare.includes("## Notes\n- note one"), "upsert: works from a totally empty file");
}

{
  ok(sectionBullets("", "People").length === 0, "sectionBullets: empty content -> []");
  ok(sectionBullets("# Memory\n\n## Notes\n(none yet)\n", "Notes").length === 0, "sectionBullets: missing section -> []");
  ok(sectionBullets("# Memory\n\n## Missing\n- a\n", "Notes").length === 0, "sectionBullets: absent heading -> []");

  const content = "# Memory\n\n## People\n- a: one\n- b: two\n- c: three\n\n## Notes\n- z: other-section\n";
  const bullets = sectionBullets(content, "People");
  ok(bullets.length === 3 && bullets[0] === "- a: one" && bullets[2] === "- c: three", "sectionBullets: returns bullets in file order (oldest first)");
  ok(!bullets.some((b) => b.includes("other-section")), "sectionBullets: never crosses into a sibling section");
}

{
  const created = appendToTopicFile(undefined, "People / ownership", "- 2026-07-01: Ada owns billing");
  ok(created.startsWith("# People / ownership\n"), "appendToTopicFile: creates a one-line header on first write");
  ok(created.trim().endsWith("- 2026-07-01: Ada owns billing"), "appendToTopicFile: the first bullet lands after the header");

  const appended = appendToTopicFile(created, "People / ownership", "2026-07-02: Bo owns payouts");
  const lines = appended.trim().split("\n");
  ok(lines.length === 3, "appendToTopicFile: header + 2 bullets, one per line");
  ok(lines[1] === "- 2026-07-01: Ada owns billing" && lines[2] === "- 2026-07-02: Bo owns payouts", "appendToTopicFile: preserves append order, normalises a bare bullet to '- …'");

  const fromBlank = appendToTopicFile("   \n", "Notes", "- x: y");
  ok(fromBlank.startsWith("# Notes\n"), "appendToTopicFile: whitespace-only content is treated as absent");
}

{
  const under = "# Memory\n\n## Notes\n- a\n- b\n\n## Other\n- z\n";
  const { content: c1, overflow: o1 } = trimSectionToRecent(under, "Notes", 5);
  ok(c1 === under && o1.length === 0, "trim: a section at/under the cap is byte-identical, no overflow");

  const exactly = "# Memory\n\n## Notes\n- a\n- b\n- c\n";
  const { content: c2, overflow: o2 } = trimSectionToRecent(exactly, "Notes", 3);
  ok(c2 === exactly && o2.length === 0, "trim: exactly-N is unchanged, no overflow");

  const over = "# Memory\n\n## Notes\n- a\n- b\n- c\n- d\n- e\n\n## Other\n- z\n";
  const { content: c3, overflow: o3 } = trimSectionToRecent(over, "Notes", 3);
  ok(JSON.stringify(o3) === JSON.stringify(["- a", "- b"]), "trim: over-N overflow is the OLDEST bullets, oldest-first");
  ok(c3.includes("- c\n- d\n- e") && !c3.includes("- a") && !c3.includes("- b"), "trim: kept content is the most recent N, in order");
  ok(c3.includes("## Other\n- z"), "trim: never touches a sibling section");

  const missing = trimSectionToRecent("# Memory\n\n## Notes\n- a\n", "Decisions", 1);
  ok(missing.content === "# Memory\n\n## Notes\n- a\n" && missing.overflow.length === 0, "trim: an absent section is a no-op");

  const placeholder = "# Memory\n\n## Notes\n(none yet)\n";
  const { content: c4, overflow: o4 } = trimSectionToRecent(placeholder, "Notes", 0);
  ok(c4 === placeholder && o4.length === 0, "trim: a placeholder-only section has no bullets to overflow");
}

{
  const base = "# Memory\n\n## People\n- a\n- b\n\n## Notes\n- z\n";
  const withPointer = ensureFullHistoryPointer(base, "People", "people");
  ok(withPointer.includes("_Full history: [[people]]_"), "pointer: inserted into the section");
  const peopleSectionEnd = withPointer.indexOf("## Notes");
  const pointerIdx = withPointer.indexOf("_Full history");
  ok(pointerIdx !== -1 && pointerIdx < peopleSectionEnd, "pointer: lands inside the section it points from");
  ok(withPointer.indexOf("- b") < pointerIdx, "pointer: appears AFTER every bullet in the section");

  const idempotent = ensureFullHistoryPointer(withPointer, "People", "people");
  ok(idempotent === withPointer, "pointer: idempotent — a second call is a no-op");

  const untouched = ensureFullHistoryPointer(base, "Missing", "missing");
  ok(untouched === base, "pointer: an absent section is a no-op");
}

{
  const content = "# Memory\n\n## People\n- 2026-07-01: Ada owns billing\n- 2026-07-02: Bo owns payouts\n\n## Notes\n- z: other-section\n";
  const { content: next, removed } = removeBulletLine(content, "- 2026-07-01: Ada owns billing");
  ok(removed === true, "removeBulletLine: present bullet reports removed:true");
  ok(!next.includes("Ada owns billing"), "removeBulletLine: the matched line is gone");
  ok(next.includes("- 2026-07-02: Bo owns payouts"), "removeBulletLine: a sibling bullet in the SAME section survives");
  ok(next.includes("- z: other-section"), "removeBulletLine: a bullet in a DIFFERENT section is untouched");

  const { content: sameContent, removed: notRemoved } = removeBulletLine(content, "- 2026-07-09: nothing like this exists");
  ok(notRemoved === false, "removeBulletLine: absent bullet reports removed:false");
  ok(sameContent === content, "removeBulletLine: content is byte-identical when nothing matched");

  const trailing = "# Memory\n\n## Notes\n- 2026-07-01: has trailing spaces   \n- 2026-07-02: keep me\n";
  const { content: trimmedOut, removed: trimmedRemoved } = removeBulletLine(trailing, "- 2026-07-01: has trailing spaces");
  ok(trimmedRemoved === true, "removeBulletLine: matches even when the file's line has trailing whitespace");
  ok(!trimmedOut.includes("has trailing spaces") && trimmedOut.includes("keep me"), "removeBulletLine: only the matched (trailing-whitespace) line is removed");

  const multi = "# Memory\n\n## Standing instructions\n- a: one\n- b: two\n- c: three\n\n## Notes\n- x\n- y\n";
  const { content: multiNext } = removeBulletLine(multi, "- b: two");
  ok(multiNext.includes("- a: one") && multiNext.includes("- c: three") && !multiNext.includes("- b: two"), "removeBulletLine: removes only the targeted middle bullet");
  ok(multiNext.includes("## Notes\n- x\n- y"), "removeBulletLine: a later, unrelated section is byte-identical");

  const flanked = "# Memory\n\n## Notes\n- keep-before\n\n- 2026-07-01: remove me\n\n- keep-after\n";
  const { content: collapsed } = removeBulletLine(flanked, "- 2026-07-01: remove me");
  ok(!collapsed.includes("remove me"), "removeBulletLine: the flanked bullet is gone");
  ok(!collapsed.includes("\n\n\n"), "removeBulletLine: removing a blank-flanked line never leaves a doubled (triple-newline) gap");
  ok(collapsed.includes("- keep-before\n\n- keep-after"), "removeBulletLine: exactly one blank line remains between the surviving neighbours");

  const untouchedGap = "# Memory\n\n## Notes\n- solo\n\n\n## Other\n- z\n";
  const { content: afterUnrelatedRemoval } = removeBulletLine(untouchedGap, "- solo");
  ok(afterUnrelatedRemoval.includes("\n\n\n"), "removeBulletLine: a pre-existing double-blank UNRELATED to the removed line is left alone");
}

console.log(`\n✓ markdown surgery (memory index + topic files): ${n} assertions passed\n`);
