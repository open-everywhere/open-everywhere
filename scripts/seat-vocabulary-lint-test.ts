import assert from "node:assert/strict";
import {
  bannedTermHits,
  CANONICAL_FILE,
  CANONICAL_HEADING,
  canonicalHref,
  githubSlug,
  headingSlugs,
  requiredLinkProblems,
  type RequiredLink,
} from "./seat-vocabulary-lint.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const hits = (md: string): string[] => bannedTermHits("docs/x.md", md).map((h) => h.text.toLowerCase());

ok(hits("the channels share one brain").join() === "brain", "the word brain in prose is refused");
ok(hits("Brains differ.").join() === "brains", "the plural, capitalised, is refused");
ok(hits("a standing per-doc supervisor session").join() === "supervisor session", "supervisor session is refused");
ok(hits("the supervisor-session rotation").join() === "supervisor-session", "the hyphenated form is refused");
ok(hits("a standing supervisor\nsession reads").join() === "supervisor\nsession", "a phrase wrapped across two lines is refused once");
ok(hits("a standing supervisor\n\nsession").length === 0, "a blank line ends the paragraph, so the phrase does not join across it");
ok(hits("a container-supervisor session kind").length === 0, "container-supervisor (a session kind) is allowed");
ok(hits("silo `org-brain` and `supervisor session`").length === 0, "a code span is not prose");
ok(hits("```ts\nmemory: \"org-brain\" // brain\n```\nok").length === 0, "a fenced block is not prose");
ok(hits("brainstorm and brainy").length === 0, "a longer word is not the banned word");
ok(bannedTermHits("docs/x.md", "one\n\nthree brain")[0]?.line === 3, "a hit carries its 1-based line");

ok(githubSlug(CANONICAL_HEADING) === "wake-seat-memory-three-independent-axes", "the canonical anchor is GitHub's slug");
ok(githubSlug("Ambient mode — the team's standing seat (on by default)") === "ambient-mode--the-teams-standing-seat-on-by-default", "an em dash leaves two hyphens, an apostrophe goes");
ok(headingSlugs("# A\n```\n# not a heading\n```\n#### Wake, seat, memory: three independent axes").has("wake-seat-memory-three-independent-axes"), "a heading is read");
ok(!headingSlugs("```\n# Fenced\n```").has("fenced"), "a fenced line is not a heading");
ok(canonicalHref("docs/deploy/surfaces/github.md") === "../configuration-reference.md#wake-seat-memory-three-independent-axes", "a surface page links up one level");
ok(canonicalHref(CANONICAL_FILE) === "#wake-seat-memory-three-independent-axes", "the canonical file links its own anchor");
ok(canonicalHref("docs/glossary.md") === "deploy/configuration-reference.md#wake-seat-memory-three-independent-axes", "the glossary links down");

const canonical = `# Ref\n\n#### ${CANONICAL_HEADING}\n\n| \`ambientSupervisor\` | x | see [it](#wake-seat-memory-three-independent-axes) |\n| \`mode\` | y | none |\n`;
const req: RequiredLink[] = [
  { file: CANONICAL_FILE, what: "the ambientSupervisor row", start: /^\| `ambientSupervisor` \|/, end: /^(?!\| `ambientSupervisor` \|)/ },
];
const files = (extra: Record<string, string>) => (f: string) => ({ [CANONICAL_FILE]: canonical, ...extra })[f];
ok(requiredLinkProblems(files({}), req).length === 0, "a place that links the heading passes");
const modeReq: RequiredLink[] = [{ file: CANONICAL_FILE, what: "the mode row", start: /^\| `mode` \|/, end: /^(?!\| `mode` \|)/ }];
ok(requiredLinkProblems(files({}), modeReq).some((p) => p.includes("does not link")), "a place without the link is refused");
const page: RequiredLink[] = [{ file: "docs/deploy/surfaces/p.md", what: "the section", start: /^## Ambient/, end: /^## / }];
const linked = "## Ambient\nsee [x](../configuration-reference.md#wake-seat-memory-three-independent-axes)\n## Next\n";
ok(requiredLinkProblems(files({ "docs/deploy/surfaces/p.md": linked }), page).length === 0, "a surface section with the relative link passes");
const linkAfterEnd = "## Ambient\nnothing\n## Next\nsee [x](../configuration-reference.md#wake-seat-memory-three-independent-axes)\n";
ok(requiredLinkProblems(files({ "docs/deploy/surfaces/p.md": linkAfterEnd }), page).some((p) => p.includes("does not link")), "a link outside the place does not count");
ok(requiredLinkProblems(files({ "docs/deploy/surfaces/p.md": "## Other\n" }), page).some((p) => p.includes("cannot find")), "a place that moved is refused, not skipped");
ok(requiredLinkProblems(files({}), page).some((p) => p.includes("file is gone")), "a missing file is refused");
const renamed = canonical.replace(CANONICAL_HEADING, "Three axes");
ok(requiredLinkProblems((f) => (f === CANONICAL_FILE ? renamed : undefined), []).some((p) => p.includes("canonical heading")), "a renamed canonical heading is refused");

console.log(`seat-vocabulary-lint-test: ${n} checks passed`);
