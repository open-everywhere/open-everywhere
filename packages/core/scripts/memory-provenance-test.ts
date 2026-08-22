import assert from "node:assert/strict";
import {
  EXTERNAL_PROVENANCE_PREFIX,
  MAX_MARKED_KINDS,
  baselineOf,
  isBulletLine,
  lineDigest,
  markAddedBullets,
  renderProvenanceMark,
} from "../agent/memory/provenance-mark.js";
import { guardDestructiveWrites } from "../agent/hooks/memory.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const named = renderProvenanceMark(["web", "github"]);
  ok(named === `${EXTERNAL_PROVENANCE_PREFIX} added on a turn that ingested web, github]`, "named kinds render in order");

  const unqualified = renderProvenanceMark([]);
  ok(unqualified.startsWith(EXTERNAL_PROVENANCE_PREFIX), "an empty kind list still renders a mark");
  ok(unqualified.includes("external content"), "an empty kind list renders the unqualified wording");

  const many = renderProvenanceMark(["web", "github", "linear", "notion", "connector", "aws"]);
  ok(many.includes("+2 more"), "kinds past the cap collapse into a count");
  ok(many.split(",").length === MAX_MARKED_KINDS, "at most MAX_MARKED_KINDS kinds are named");

  const hostile = renderProvenanceMark(["we]b\n- injected", ""]);
  ok(!hostile.includes("\n"), "a kind cannot carry a newline into the file");
  ok(hostile.indexOf("]") === hostile.length - 1, "a kind cannot close the mark early");
}

{
  ok(isBulletLine("- a fact"), "dash bullet");
  ok(isBulletLine("  * a fact"), "indented star bullet");
  ok(isBulletLine("3. a fact"), "ordered bullet");
  ok(!isBulletLine("# Heading"), "a heading is not a bullet");
  ok(!isBulletLine("Prose about a fact."), "prose is not a bullet");
  ok(!isBulletLine("-"), "a bare dash with no content is not a bullet");
  ok(!isBulletLine("---"), "a horizontal rule is not a bullet");
}

{
  const before = { "notes.md": "# Notes\n\n- old fact\n" };
  const baseline = baselineOf(before);
  const after = { "notes.md": "# Notes\n\n- old fact\n- new fact\n" };
  const mark = renderProvenanceMark(["web"]);
  const { files, marked } = markAddedBullets(baseline, after, mark);

  ok(marked === 1, "exactly one bullet was added, so exactly one is marked");
  const body = files["notes.md"];
  ok(body !== undefined, "the changed file is returned");
  ok(body!.includes(`- new fact  ${mark}`), "the added bullet carries the mark");

  ok(body!.includes("- old fact\n"), "the pre-existing bullet survives");
  ok(!body!.includes(`- old fact  ${EXTERNAL_PROVENANCE_PREFIX}`), "the pre-existing bullet is NOT marked");
  ok(body!.split(EXTERNAL_PROVENANCE_PREFIX).length - 1 === 1, "the file carries exactly one mark");
  ok(body!.startsWith("# Notes\n"), "the heading is untouched");
}

{
  const baseline = baselineOf({ "notes.md": "- a fact\n- b fact\n" });
  const after = { "notes.md": "  - b fact  \n- a fact\n" };
  const { files, marked } = markAddedBullets(baseline, after, renderProvenanceMark(["web"]));
  ok(marked === 0, "re-ordering and re-indenting adds nothing, so nothing is marked");
  ok(Object.keys(files).length === 0, "an unchanged file is not written back");
}

{
  const { files, marked } = markAddedBullets({}, { "new.md": "# New\n\n- first fact\n- second fact\n" }, renderProvenanceMark([]));
  ok(marked === 2, "every bullet of a file created this turn is added");
  ok((files["new.md"]!.match(/external-provenance/g) ?? []).length === 2, "both bullets carry a mark");
}

{
  const after = { "notes.md": "- a fact\n\n```sh\n- not a bullet, an argument\n```\n" };
  const { files, marked } = markAddedBullets({}, after, renderProvenanceMark(["web"]));
  ok(marked === 1, "only the real bullet is marked");
  ok(files["notes.md"]!.includes("- not a bullet, an argument\n"), "the fenced line is byte-identical");
}

{
  const mark = renderProvenanceMark(["web"]);
  const first = markAddedBullets({}, { "notes.md": "- a fact\n" }, mark);
  const second = markAddedBullets({}, first.files, mark);
  ok(second.marked === 0, "an already-marked bullet is not marked again");
  ok(Object.keys(second.files).length === 0, "and the file is not rewritten");
}

{
  const after = {
    "RECURRING.md": "- learned pattern\n",
    "notes.conflict-abc.md": "- a preserved concurrent version\n",
    "notes.rejected-abc.md": "- a parked refused version\n",
  };
  const { files, marked } = markAddedBullets({}, after, renderProvenanceMark(["web"]));
  ok(marked === 0, "host-owned and host-minted files take no mark");
  ok(Object.keys(files).length === 0, "and none of them is rewritten");
}

{
  ok(lineDigest("- a fact") === lineDigest("  - a fact  "), "the digest ignores surrounding whitespace");
  ok(lineDigest("- a fact") !== lineDigest("- a different fact"), "different lines get different digests");
  ok(lineDigest("- a fact").length === 12, "the digest is short enough to ride session state");
}

{
  const host = { "notes.md": "- host fact one\n- host fact two\n- host fact three\n- host fact four\n" };
  const baseline = baselineOf(host);
  const written = { "notes.md": `${host["notes.md"]}- new one\n- new two\n- new three\n- new four\n` };
  const { files: marked, marked: count } = markAddedBullets(baseline, written, renderProvenanceMark(["web"]));
  ok(count === 4, "all four added bullets are marked");

  const { files, rejected } = guardDestructiveWrites(host, { ...written, ...marked }, "sess1");
  ok(rejected.length === 0, "a marking pass over added bullets is NOT destruction");
  ok(files["notes.md"]!.includes("- host fact one\n"), "every host line survives the marked write");
  ok(files["notes.md"]!.includes(`- new one  ${EXTERNAL_PROVENANCE_PREFIX}`), "the marked bullet is what lands");

  const truncated = { "notes.md": "- host fact one\n" };
  const control = guardDestructiveWrites(host, truncated, "sess1");
  ok(control.rejected.length === 1, "the floor still refuses a genuine truncation");
}

console.log(`memory-provenance: ${n} assertions passed`);
