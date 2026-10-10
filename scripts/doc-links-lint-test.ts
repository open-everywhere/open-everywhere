import assert from "node:assert/strict";
import { deadLinks, linkTargets, resolveTarget, SKIP, trackedLookup } from "./doc-links-lint.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const targets = (md: string): string[] => linkTargets(md).map((t) => t.target);

ok(targets("See [a](./a.md).")[0] === "./a.md", "an inline link is read");
ok(targets('See [a](../b/c.ts "title").')[0] === "../b/c.ts", "an inline link with a title is read without the title");
ok(targets("See [a](<dir/with space.md>).")[0] === "dir/with space.md", "an angle-bracket target is read");
ok(targets("[a](../b/c.ts 'title')")[0] === "../b/c.ts", "an inline link with a single-quoted title is read");
ok(targets("[a](../b/c.ts (title))")[0] === "../b/c.ts", "an inline link with a parenthesised title is read");
ok(targets("[a](x_(y).md)")[0] === "x_(y).md", "a target with balanced parens is read whole");
ok(targets("[ref]: docs/x.md")[0] === "docs/x.md", "a reference definition is read");
ok(targets('<a href="gone.md">x</a> <img src=\'img/p.png\'>').join() === "gone.md,img/p.png", "a raw HTML href and src are read");
ok(targets("[a](x.md) and [b](y.md)").length === 2, "two links on one line are both read");
ok(linkTargets("one\n\nthree [a](z.md)")[0]?.line === 3, "a link carries its 1-based line");

ok(targets("[a](https://example.com/x.md)").length === 0, "an https URL is not a path");
ok(targets("[a](mailto:someone@example.com)").length === 0, "a mailto URL is not a path");
ok(targets("[a](#section)").length === 0, "a bare anchor is not a path");
ok(targets("Code: `[a](missing.md)`").length === 0, "a link inside an inline code span is not read");
ok(targets("```md\n[a](missing.md)\n```\n").length === 0, "a link inside a fenced block is not read");
ok(targets("~~~\n[a](missing.md)\n~~~\n[b](real.md)")[0] === "real.md", "a tilde fence closes, and a link after it is read");
ok(targets("````\n```\n[a](missing.md)\n````\n").length === 0, "a shorter fence inside a longer one does not close it");
ok(targets("1. step\n\n     ```bash\n     [a](missing.md)\n     ```\n[b](real.md)").join() === "real.md", "a fence indented inside a list item is skipped, and it closes");
ok(targets("```\n```js\n[a](missing.md)\n```\n").length === 0, "a fence line with an info string does not close an open fence");
ok(targets("```x``` is code\n[b](real.md)").join() === "real.md", "a line that starts with an inline code span does not open a fence");
ok(targets("[^1]: some text here").length === 0, "a footnote definition is not a reference link");
ok(targets('[a](https://x.example "t") <a href="#top">').length === 0, "an HTML anchor-only href is not a path");

ok(resolveTarget("docs/dev/tidy.md", "../../scripts/x.ts") === "scripts/x.ts", "a relative target resolves against the file's directory");
ok(resolveTarget("docs/a.md", "b.md#part") === "docs/b.md", "the anchor is not part of the path");
ok(resolveTarget("docs/a.md", "/README.md") === "README.md", "a leading slash is the repo root");
ok(resolveTarget("docs/a.md", "my%20file.md") === "docs/my file.md", "a percent-escape is decoded");

const tree = new Set(["docs/a.md", "docs/b.md", "scripts"]);
const exists = (p: string): boolean => tree.has(p);
const dead = deadLinks(
  [
    { file: "docs/a.md", text: "[ok](b.md) [dir](../scripts) [gone](spikes/old.ts#L3)\n[out](../../elsewhere.md)" },
  ],
  exists,
);
ok(dead.length === 1, "🔴 exactly the one dead link is refused");
ok(dead[0]?.target === "spikes/old.ts#L3" && dead[0]?.line === 1, "…and the refusal names the file's target and line");
ok(deadLinks([{ file: "a.md", text: "[x](.)" }], exists).length === 0, "a link to the current directory is not refused");
ok(SKIP.every((s) => s.why.length > 20), "every SKIP entry states its reason");

const tracked = trackedLookup(["docs/a.md", "packages/core/scripts/x.ts"]);
ok(tracked("docs/a.md") && tracked("packages/core/scripts/x.ts"), "a tracked file is found");
ok(tracked("packages/core") && tracked("packages") && tracked("packages/core/scripts/"), "a directory that holds a tracked file is found, with or without a trailing slash");
ok(!tracked("docs/A.md"), "🔴 the match is case-sensitive, as GitHub's is");
ok(!tracked("scripts/tidy/RUBRIC.md"), "🔴 an untracked or gitignored file is not found, even when a local disk holds it");

console.log(`doc-links-lint-test: ${n} checks passed`);
