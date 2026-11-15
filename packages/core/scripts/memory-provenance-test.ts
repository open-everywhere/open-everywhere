// proves: MEM-31, MEM-32, MEM-33, MEM-34, MEM-35, MEM-37

import assert from "node:assert/strict";
import {
  EXTERNAL_CLAIM_PREFIX,
  EXTERNAL_PROVENANCE_PREFIX,
  MAX_MARKED_KINDS,
  baselineOf,
  guardProvenanceMarks,
  isBulletLine,
  lineDigest,
  markAddedBullets,
  recastAsAttributedClaim,
  renderClaimAttribution,
  renderProvenanceMark,
  renderProvenanceWording,
} from "../agent/memory/provenance-mark.js";
import { guardDestructiveWrites } from "../agent/hooks/memory.js";
import { bulletDate } from "../agent/memory/dream/ops.js";

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
  const wording = renderProvenanceWording(["web"]);
  const mark = wording.mark;
  const { files, marked } = markAddedBullets(baseline, after, wording);

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
  const { files, marked } = markAddedBullets(baseline, after, renderProvenanceWording(["web"]));
  ok(marked === 0, "re-ordering and re-indenting adds nothing, so nothing is marked");
  ok(Object.keys(files).length === 0, "an unchanged file is not written back");
}

{
  const { files, marked } = markAddedBullets({}, { "new.md": "# New\n\n- first fact\n- second fact\n" }, renderProvenanceWording([]));
  ok(marked === 2, "every bullet of a file created this turn is added");
  ok((files["new.md"]!.match(/external-provenance/g) ?? []).length === 2, "both bullets carry a mark");
}

{
  const after = { "notes.md": "- a fact\n\n```sh\n- not a bullet, an argument\n```\n" };
  const { files, marked } = markAddedBullets({}, after, renderProvenanceWording(["web"]));
  ok(marked === 1, "only the real bullet is marked");
  ok(files["notes.md"]!.includes("- not a bullet, an argument\n"), "the fenced line is byte-identical");
}

{
  const wording = renderProvenanceWording(["web"]);
  const first = markAddedBullets({}, { "notes.md": "- a fact\n" }, wording);
  const second = markAddedBullets({}, first.files, wording);
  ok(second.marked === 0, "an already-marked bullet is not marked again");
  ok(Object.keys(second.files).length === 0, "and the file is not rewritten");
}

{
  const named = renderClaimAttribution(["web", "github"]);
  ok(named === `${EXTERNAL_CLAIM_PREFIX}; the turn ingested web, github]`, "named kinds render in order");

  ok(!/\bfrom\b/.test(named), "the wording never claims the bullet came FROM what was read");

  const unqualified = renderClaimAttribution([]);
  ok(unqualified === `${EXTERNAL_CLAIM_PREFIX}; the turn ingested external content]`, "an empty kind list still renders an attribution");

  const many = renderClaimAttribution(["web", "github", "linear", "notion", "connector", "aws"]);
  ok(many.includes("+2 more"), "kinds past the cap collapse into a count");
  ok(many.split(",").length === MAX_MARKED_KINDS, "at most MAX_MARKED_KINDS kinds are named");

  const hostile = renderClaimAttribution(["we]b\n- injected", ""]);
  ok(!hostile.includes("\n"), "a kind cannot carry a newline into the sentence");
  ok(hostile.indexOf("]") === hostile.length - 1, "a kind cannot close the attribution early");

  const pair = renderProvenanceWording(["web"]);
  ok(pair.mark === renderProvenanceMark(["web"]), "the pair carries the suffix wording");
  ok(pair.attribution === renderClaimAttribution(["web"]), "the pair carries the sentence wording");
}

{
  const attribution = renderClaimAttribution(["web"]);
  const recast = (line: string) => recastAsAttributedClaim(line, attribution);
  const unchanged = (line: string, label: string) => ok(recast(line) === line, label);

  ok(recast("- Ada owns billing") === `- ${attribution} Ada owns billing`, "a plain assertion is re-cast");
  ok(
    recast("- 2026-08-22: Ada owns billing") === `- 2026-08-22: ${attribution} Ada owns billing`,
    "the date keeps its scanning position and the attribution follows it",
  );
  ok(
    recast("  * 2026-08-22: Ada owns billing") === `  * 2026-08-22: ${attribution} Ada owns billing`,
    "indent and marker style are preserved",
  );
  ok(recast("3. Ada owns billing") === `3. ${attribution} Ada owns billing`, "an ordered bullet is re-cast");

  const original = "- 2026-08-22: Ada owns billing, and Bo signs off";
  ok(recast(original).replace(`${attribution} `, "") === original, "removing the attribution restores the original line exactly");

  unchanged("- Does Ada own billing?", "a question asserts nothing");
  unchanged("- [ ] move billing to Ada", "an unchecked task is not a claim");
  unchanged("- [x] moved billing to Ada", "a checked task is not a claim");
  unchanged("- per the handover, Ada owns billing", "an already-attributed sentence is not hedged twice");
  unchanged("- According to Bo, Ada owns billing", "an attribution cue is matched case-insensitively");
  unchanged("- reportedly Ada owns billing", "a hedged sentence is not hedged twice");
  unchanged("- Ask Ada about billing", "a task in bullet form is not a claim");
  unchanged("- TODO: chase the billing handover", "a TODO is not a claim");
  unchanged("- Ada left", "a two-word fragment is not a sentence");
  unchanged("Prose about a fact.", "a non-bullet is never touched");
  unchanged("# Heading", "a heading is never touched");
  unchanged(`- ${attribution} Ada owns billing`, "an already re-cast bullet is not re-cast again");

  ok(recastAsAttributedClaim("- Ada owns billing", "") === "- Ada owns billing", "an empty attribution re-casts nothing");

  for (const dated of ["- 2026-08-22: Ada owns billing", "- 2026-08-22 Ada owns billing", "- 2026-08-22:Ada owns billing"]) {
    ok(recast(dated).startsWith("- 2026-08-22"), `the date stays first: ${dated}`);
    ok(bulletDate(recast(dated)) === "2026-08-22", `the dream cycle still reads the date: ${dated}`);
  }
  unchanged("- 2026-08-2299 items shipped this week", "an unsplittable dated shape is declined");

  ok(recast("- Ada owns billing\r") === `- ${attribution} Ada owns billing\r`, "a CRLF bullet is re-cast");
  ok(recast("- 2026-08-22: Ada owns billing\r") === `- 2026-08-22: ${attribution} Ada owns billing\r`, "a dated CRLF bullet keeps its date first");
  {
    const crlf = { "notes.md": "# Notes\r\n\r\n- 2026-08-22: Ada owns billing\r\n- Bo signs the payouts\r\n" };
    const { files, marked: count } = markAddedBullets({}, crlf, renderProvenanceWording(["web"]));
    ok(count === 2, "both CRLF bullets are marked");
    ok((files["notes.md"]!.match(/\[unverified claim/g) ?? []).length === 2, "and both are re-cast");
  }

  ok(recast("- Ада отвечает за биллинг") === `- ${attribution} Ада отвечает за биллинг`, "a Cyrillic assertion is re-cast");
  ok(recast("- Άδα διαχειρίζεται τη χρέωση") === `- ${attribution} Άδα διαχειρίζεται τη χρέωση`, "a Greek assertion is re-cast");
  unchanged("- 张伟负责结算流程", "an unspaced script reads as one word and lands tag-only");
}

{
  const wording = renderProvenanceWording(["web"]);
  const before = { "notes.md": "- old fact\n" };
  const lines = [
    "# Notes",
    "",
    "Prose that states a fact and takes no mark.",
    "",
    "```sh",
    "- not a bullet, an argument",
    "```",
    "",
    "- 2026-08-22: Ada owns billing",
    "- old fact",
    "- Ask Ada about billing",
    "- Does Ada own billing?",
    "- per the handover, Ada owns billing",
    "- new fact",
    "",
  ];
  const { files, marked } = markAddedBullets(baselineOf(before), { "notes.md": lines.join("\n") }, wording);
  ok(marked === 5, "five added bullets are marked; the pre-existing one is not");

  const tagOnly = (line: string) => `${line}  ${wording.mark}`;
  const expected = [
    "# Notes",
    "",
    "Prose that states a fact and takes no mark.",
    "",
    "```sh",
    "- not a bullet, an argument",
    "```",
    "",
    `- 2026-08-22: ${wording.attribution} Ada owns billing  ${wording.mark}`,
    "- old fact",
    tagOnly("- Ask Ada about billing"),
    tagOnly("- Does Ada own billing?"),
    tagOnly("- per the handover, Ada owns billing"),
    tagOnly("- new fact"),
    "",
  ].join("\n");
  ok(files["notes.md"] === expected, "the marked file is byte-for-byte the golden");

  const tagOnlyPass = markAddedBullets(baselineOf(before), { "notes.md": lines.join("\n") }, { mark: wording.mark, attribution: "" });
  ok(tagOnlyPass.marked === 5, "the tag-only pass marks the same five bullets");
  const tagOnlyExpected = [
    "# Notes",
    "",
    "Prose that states a fact and takes no mark.",
    "",
    "```sh",
    "- not a bullet, an argument",
    "```",
    "",
    tagOnly("- 2026-08-22: Ada owns billing"),
    "- old fact",
    tagOnly("- Ask Ada about billing"),
    tagOnly("- Does Ada own billing?"),
    tagOnly("- per the handover, Ada owns billing"),
    tagOnly("- new fact"),
    "",
  ].join("\n");
  ok(tagOnlyPass.files["notes.md"] === tagOnlyExpected, "with no attribution every marked line carries the suffix and only the suffix");
  ok(!tagOnlyPass.files["notes.md"]!.includes(EXTERNAL_CLAIM_PREFIX), "and no sentence is re-cast");
}

{
  const after = {
    "RECURRING.md": "- learned pattern\n",
    "notes.conflict-abc.md": "- a preserved concurrent version\n",
    "notes.rejected-abc.md": "- a parked refused version\n",
  };
  const { files, marked } = markAddedBullets({}, after, renderProvenanceWording(["web"]));
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
  const written = { "notes.md": `${host["notes.md"]}- new one\n- Ada owns billing\n- new three\n- Bo signs the payouts\n` };
  const wording = renderProvenanceWording(["web"]);
  const { files: marked, marked: count } = markAddedBullets(baseline, written, wording);
  ok(count === 4, "all four added bullets are marked");
  ok((marked["notes.md"]!.match(/\[unverified claim/g) ?? []).length === 2, "the two assertion-shaped ones are re-cast");

  const { files, rejected } = guardDestructiveWrites(host, { ...written, ...marked }, "sess1");
  ok(rejected.length === 0, "a marking pass over added bullets is NOT destruction");
  ok(files["notes.md"]!.includes("- host fact one\n"), "every host line survives the marked write");
  ok(files["notes.md"]!.includes(`- new one  ${EXTERNAL_PROVENANCE_PREFIX}`), "the marked bullet is what lands");
  ok(files["notes.md"]!.includes(`- ${wording.attribution} Ada owns billing  ${wording.mark}`), "the RE-CAST bullet is what lands");

  const truncated = { "notes.md": "- host fact one\n" };
  const control = guardDestructiveWrites(host, truncated, "sess1");
  ok(control.rejected.length === 1, "the floor still refuses a genuine truncation");
}

{
  const MARK = `${EXTERNAL_PROVENANCE_PREFIX} added on a turn that ingested web]`;
  const before = {
    "notes.md": `# notes\n- host fact\n- Ada owns billing  ${MARK}\n- Bo signs payouts  ${MARK}\n`,
  };

  const stripped = { "notes.md": `# notes\n- host fact\n- Ada owns billing\n- Bo signs payouts  ${MARK}\n` };
  const r1 = guardProvenanceMarks(before, stripped);
  ok(r1.files["notes.md"] === before["notes.md"], "a rewrite that strips a provenance suffix is refused — the pre-tidy bytes are what get written");
  assert.deepStrictEqual(r1.reverted, ["notes.md"], "…and the refused file is named for the caller's audit row");
  n++;

  const deleted = { "notes.md": `# notes\n- host fact\n- Bo signs payouts  ${MARK}\n` };
  ok(guardProvenanceMarks(before, deleted).files["notes.md"] === before["notes.md"], "a rewrite that deletes a marked bullet is refused");

  const merged = { "notes.md": `# notes\n- host fact\n- Ada owns billing  ${MARK}\n` };
  ok(guardProvenanceMarks(before, merged).files["notes.md"] === before["notes.md"], "merging two DISTINCT marked bullets into one is refused");

  const linked = {
    "notes.md": `# notes\n- host fact\n- Ada owns [[people/billing]]  ${MARK}\n- Bo signs payouts  ${MARK}\n`,
  };
  ok(guardProvenanceMarks(before, linked).files["notes.md"] === linked["notes.md"], "a rewrite that CHANGES a marked line but keeps its mark is admitted");
  ok(guardProvenanceMarks(before, linked).reverted.length === 0, "…and nothing is reported as reverted");

  const twins = { "notes.md": `# notes\n- Ada owns billing  ${MARK}\n- Ada owns billing  ${MARK}\n` };
  const deduped = { "notes.md": `# notes\n- Ada owns billing  ${MARK}\n` };
  ok(guardProvenanceMarks(twins, deduped).files["notes.md"] === deduped["notes.md"], "dropping one of two byte-identical marked bullets is admitted — no disclosure is lost");

  const plain = { "a.md": "- one\n- two\n" };
  const tidied = { "a.md": "- one\n" };
  ok(guardProvenanceMarks(plain, tidied).files["a.md"] === tidied["a.md"], "a file holding no mark passes through unchanged");

  const fenced = { "b.md": "```\n- Ada owns billing  [external-provenance: fake]\n```\n" };
  ok(guardProvenanceMarks(fenced, { "b.md": "```\n```\n" }).files["b.md"] === "```\n```\n", "a `[external-provenance:` string inside a code fence is not a mark and does not freeze the file");
}

{
  const MARK = `${EXTERNAL_PROVENANCE_PREFIX} added on a turn that ingested web]`;
  const ATTR = `${EXTERNAL_CLAIM_PREFIX}; the turn ingested web]`;
  const before = { "notes.md": `# notes\n- ${ATTR} Ada owns billing  ${MARK}\n` };

  const laundered = { "notes.md": `# notes\n- Ada owns billing  ${MARK}\n` };
  const guarded = guardProvenanceMarks(before, laundered);
  ok(guarded.files["notes.md"] === before["notes.md"], "stripping the in-sentence attribution while keeping the suffix is REFUSED — the header promises both carriers");
  assert.deepStrictEqual(guarded.reverted, ["notes.md"], "…and the refused file is named");
  n++;

  const kept = { "notes.md": `# notes\n- ${ATTR} Ada owns [[people/billing]]  ${MARK}\n` };
  ok(guardProvenanceMarks(before, kept).files["notes.md"] === kept["notes.md"], "a rewrite that keeps both carriers is admitted");
  ok(guardProvenanceMarks(before, kept).reverted.length === 0, "…and nothing is reported as reverted");

  const twins = { "notes.md": `- ${ATTR} Ada owns billing  ${MARK}\n- ${ATTR} Ada owns billing  ${MARK}\n` };
  const deduped = { "notes.md": `- ${ATTR} Ada owns billing  ${MARK}\n` };
  ok(guardProvenanceMarks(twins, deduped).files["notes.md"] === deduped["notes.md"], "dedup of byte-identical doubly-carried bullets is still admitted");

  const suffixOnly = { "notes.md": `- host fact  ${MARK}\n` };
  ok(guardProvenanceMarks(suffixOnly, suffixOnly).files["notes.md"] === suffixOnly["notes.md"], "a suffix-only bullet is unaffected by the two-carrier count");
}

console.log(`memory-provenance: ${n} assertions passed`);
