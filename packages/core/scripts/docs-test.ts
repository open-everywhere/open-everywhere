import {
  clearDocs,
  docIndex,
  normalizeDocPath,
  readDoc,
  registerDocs,
  registerProviderDocs,
  visibleDocs,
} from "../agent/docs/registry.js";
import { clearProviderSelection, declareProviderSelection } from "../agent/access/provider-selection.js";
import {
  checkDocsSourceMap,
  docSummaryOf,
  docTitleOf,
  providerForDocPath,
  sectionForDocPath,
  MAX_SUMMARY_CHARS,
} from "../agent/docs/source-map.js";
import { chdir, cwd } from "node:process";
import { tmpdir } from "node:os";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const doc = (path: string, title = "T", summary = "S", markdown = `# ${title}\n\nbody of ${path}\n`) => ({
  path,
  title,
  summary,
  markdown,
});

const UNIVERSAL = doc("docs/capabilities/memory.md", "Memory");
const X_DOC = doc("docs/deploy/surfaces/provider-x.md", "Provider X");
const Y_DOC = doc("docs/deploy/surfaces/provider-y.md", "Provider Y");

function deploy(ids: readonly string[]): void {
  clearDocs();
  clearProviderSelection();
  declareProviderSelection(ids);
  registerDocs([UNIVERSAL]);
  registerProviderDocs("provider-x", [X_DOC]);
  registerProviderDocs("provider-y", [Y_DOC]);
}

deploy(["provider-x"]);
const xPaths = visibleDocs().map((d) => d.path);
ok(xPaths.includes(X_DOC.path), "a selected provider's runbook is served");
ok(!xPaths.includes(Y_DOC.path), "an UNSELECTED provider's runbook is NOT served");
ok(!docIndex().some((d) => d.path === Y_DOC.path), "an unselected provider's doc is absent from the index too");
ok(!readDoc(Y_DOC.path).ok, "reading an unselected provider's doc by exact path is refused");
ok(readDoc(X_DOC.path).ok, "reading the selected provider's doc succeeds");

deploy(["provider-x"]);
clearProviderSelection();
ok(!visibleDocs().some((d) => d.path === Y_DOC.path), "...and Y is STILL absent — it never registered a row");

clearDocs();
clearProviderSelection();
registerDocs([UNIVERSAL]);
registerProviderDocs("provider-y", [Y_DOC]);
ok(visibleDocs().some((d) => d.path === Y_DOC.path), "library mode (undeclared) registers and serves a provider's docs");
declareProviderSelection(["provider-x"]);
ok(!visibleDocs().some((d) => d.path === Y_DOC.path), "a row that landed BEFORE the declaration is still filtered out at read time");
ok(!readDoc(Y_DOC.path).ok, "and reading it by exact path is refused");

deploy(["provider-x", "provider-y"]);
ok(visibleDocs().filter((d) => d.path.startsWith("docs/deploy/surfaces/")).length === 2, "both selected providers' runbooks are served");

for (const ids of [[], ["provider-x"], ["provider-x", "provider-y"]]) {
  deploy(ids);
  ok(readDoc(UNIVERSAL.path).ok, `universal doc served with selection [${ids.join(",")}]`);
}
deploy([]);
ok(visibleDocs().length === 1, "a deployment selecting NO provider still ships the universal manual");

deploy(["provider-x"]);
const unknown = readDoc("docs/nope/not-a-doc.md");
ok(!unknown.ok, "an unknown doc is refused");
const unknownMsg = unknown.ok ? "" : unknown.message;
ok(/no "docs\/nope\/not-a-doc\.md"/u.test(unknownMsg), "the refusal names what was asked for");
ok(/read_docs with no path/u.test(unknownMsg), "the refusal points at the index instead of inviting a guess");
const withheld = readDoc(Y_DOC.path);
const withheldMsg = withheld.ok ? "" : withheld.message;
ok(!/provider-y/u.test(withheldMsg.replace(Y_DOC.path, "")), "the refusal does not reveal that an unselected provider's manual exists");
ok(
  withheldMsg.replace(Y_DOC.path, "<p>") === unknownMsg.replace("docs/nope/not-a-doc.md", "<p>"),
  "an unselected doc and an unknown doc get the SAME refusal (no existence oracle)",
);
ok(!readDoc("").ok, "an empty path is refused");
ok(!readDoc("   ").ok, "a whitespace path is refused");
ok(!readDoc("../../etc/passwd").ok, "a traversal path is refused (it re-anchors under docs/ and simply isn't in the registry)");
ok(normalizeDocPath("../../etc/passwd") === "docs/etc/passwd", "a leading climb re-anchors under docs/ rather than escaping");
ok(normalizeDocPath("docs/../../etc/passwd") === null, "normalizeDocPath rejects a NON-leading .. segment");
ok(normalizeDocPath("docs/a/../b.md") === null, "a mid-path .. is refused rather than silently reinterpreted");
ok(!readDoc("docs/capabilities").ok, "a directory-ish path is refused (no partial matching)");
ok(!readDoc("y.md").ok, "a partial FILENAME suffix does not match (segment boundary required)");

{
  const before = cwd();
  chdir(tmpdir());
  try {
    const got = readDoc(UNIVERSAL.path);
    ok(got.ok && got.doc.markdown.includes("body of docs/capabilities/memory.md"), "a doc reads fine with cwd outside the repo — the manual is compiled in, not read off disk");
    ok(docIndex().length === visibleDocs().length, "the index is served from the same compiled registry");
  } finally {
    chdir(before);
  }
}

deploy(["provider-x"]);
registerDocs([UNIVERSAL, doc("docs/introduction/quick-start.md", "Quick start")]);
ok(readDoc("capabilities/memory.md").ok, "a docs-relative path resolves");
ok(readDoc("./capabilities/memory.md").ok, "a leading ./ resolves");
ok(readDoc("../../capabilities/memory.md").ok, "a ../.. cross-reference lifted out of another doc resolves");
ok(readDoc("memory.md").ok, "a unique bare filename resolves");
ok(readDoc("docs\\capabilities\\memory.md").ok, "backslashes normalise");
ok(readDoc("  docs/capabilities/memory.md  ").ok, "surrounding whitespace normalises");
registerDocs([UNIVERSAL, doc("docs/extending/memory.md", "Memory (extending)")]);
const ambiguous = readDoc("memory.md");
ok(!ambiguous.ok, "an ambiguous suffix is refused rather than guessed");
ok(!ambiguous.ok && /docs\/capabilities\/memory\.md/u.test(ambiguous.message) && /docs\/extending\/memory\.md/u.test(ambiguous.message), "the ambiguous refusal lists the candidates");

clearDocs();
clearProviderSelection();
registerDocs([UNIVERSAL, { ...UNIVERSAL, title: "Memory v2" }]);
ok(visibleDocs().length === 1 && visibleDocs()[0].title === "Memory v2", "re-registering a path REPLACES rather than duplicates");
registerProviderDocs("provider-x", [X_DOC]);
registerProviderDocs("provider-x", [X_DOC]);
ok(visibleDocs().filter((d) => d.path === X_DOC.path).length === 1, "a bundle re-registering is idempotent");
ok(visibleDocs()[0].path < visibleDocs()[1].path, "visibleDocs is sorted by path");
clearDocs();
ok(visibleDocs().length === 0 && docIndex().length === 0, "clearDocs empties the registry");

ok(docTitleOf("docs/x.md", "\n\n# Hello there\n\nbody") === "Hello there", "docTitleOf reads the first # heading");
ok(docTitleOf("docs/a/b.md", "no heading here") === "b.md", "docTitleOf falls back to the basename");
ok(docSummaryOf("# T\n\n> a callout\n\nThe real opening line.\n\nsecond para") === "The real opening line.", "docSummaryOf skips headings and callouts");
ok(docSummaryOf("# T\n\nSee [the manual](./x.md) for **more**.") === "See the manual for more.", "docSummaryOf flattens links and emphasis");
ok(docSummaryOf(`# T\n\n${"word ".repeat(200)}`).length <= MAX_SUMMARY_CHARS + 1, "docSummaryOf is capped");
ok(docSummaryOf(`# T\n\n${"word ".repeat(200)}`).endsWith("…"), "a capped summary is marked as elided");
ok(docSummaryOf("# T only") === "", "a doc with no paragraph yields an empty summary rather than throwing");

const BUNDLES = ["alpha", "beta"];
ok(providerForDocPath("docs/deploy/surfaces/alpha.md", BUNDLES) === "alpha", "a surface doc maps to its bundle");
ok(providerForDocPath("docs/deploy/surfaces/support-matrix.md", BUNDLES) === undefined, "the declared universal surface doc maps to no bundle");
ok(providerForDocPath("docs/capabilities/memory.md", BUNDLES) === undefined, "a non-surface doc maps to no bundle");
ok(providerForDocPath("docs/deploy/surfaces/nested/alpha.md", BUNDLES) === undefined, "a nested file under the surface dir maps to no bundle");
ok(sectionForDocPath("docs/README.md") === "root", "a top-level doc lands in the root section");
ok(sectionForDocPath("docs/deploy/platforms/aws.md") === "deploy", "a nested doc lands in its top-level section");

ok(
  checkDocsSourceMap({ docPaths: ["docs/deploy/surfaces/alpha.md", "docs/deploy/surfaces/beta.md"], bundleIds: BUNDLES }).length === 0,
  "a 1:1 bundle↔runbook map is clean",
);
const missingRunbook = checkDocsSourceMap({ docPaths: ["docs/deploy/surfaces/alpha.md"], bundleIds: BUNDLES });
ok(missingRunbook.length === 1 && /beta/u.test(missingRunbook[0]), "a bundle with no runbook fails the map");
const orphanDoc = checkDocsSourceMap({ docPaths: ["docs/deploy/surfaces/alpha.md", "docs/deploy/surfaces/gamma.md"], bundleIds: ["alpha"] });
ok(orphanDoc.length === 1 && /gamma/u.test(orphanDoc[0]), "a runbook with no bundle fails the map (it would ship universally)");
ok(
  checkDocsSourceMap({ docPaths: ["docs/deploy/surfaces/support-matrix.md"], bundleIds: [] }).length === 0,
  "the declared universal surface doc is exempt from the orphan rule",
);

console.log(`✓ docs registry + source map — ${passed} assertions`);
