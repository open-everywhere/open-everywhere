import assert from "node:assert/strict";
import { ALLOWLIST, brandLiterals, isGenerated, judge, literalSegments, SCOPE } from "./brand-literal-lint.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const hitsIn = (source: string): string[] => brandLiterals("x.ts", source).map((h) => h.text);

ok(hitsIn('const a = "Open Everywhere";').length === 1, "a double-quoted literal is seen");
ok(hitsIn("const a = 'OpenEverywhere';").length === 1, "a single-quoted literal is seen, with no space in the brand");
ok(hitsIn("const a = `hi from open everywhere`;").length === 1, "a template literal is seen, in any case");
ok(hitsIn("const a = `${x} — Open Everywhere — ${y}`;").length === 1, "the text BETWEEN two template substitutions is seen");
ok(hitsIn("const a = `${`Open Everywhere`}`;").length === 1, "a template nested inside a substitution is seen");
ok(hitsIn("const a = `${{ k: 1 }.k} Open Everywhere`;").length === 1, "an object literal inside a substitution does not end the template early");

ok(hitsIn("// Open Everywhere in a line comment\nconst a = 1;").length === 0, "a line comment is skipped");
ok(hitsIn("/* Open Everywhere\n in a block comment */ const a = 1;").length === 0, "a block comment is skipped");
ok(hitsIn('const a = "[open-everywhere:spend] log prefix";').length === 0, "the hyphenated package/log scope is not the brand phrase");
ok(hitsIn('import x from "@open-everywhere/core/agent/adapter-api.js";').length === 0, "the package import specifier is not the brand phrase");
ok(hitsIn("interface OpenEverywhereSlackAuth { a: string }").length === 0, "an identifier is not a literal");
ok(hitsIn('const r = /"/; // Open Everywhere\nconst b = 1;').length === 0, "a quote inside a regex does not open a string that swallows the comment");
ok(hitsIn("const r = a / b; const s = 'Open Everywhere';").length === 1, "a division is not a regex — the literal after it is still seen");
ok(hitsIn("return /x'y/.test(s) ? 'Open Everywhere' : '';").length === 1, "a regex after `return` is a regex — the quote in it does not desync the scan");

ok(brandLiterals("x.ts", 'const a = 1;\n\nconst b = "Open Everywhere";')[0]?.line === 3, "a hit carries the line its literal starts on");
ok(literalSegments("`a\nb ${c} d`").length === 2, "a template with one substitution yields two text segments");

ok(SCOPE.test("packages/providers/slack/agent/app-manifest.ts"), "scope: a provider bundle's agent code is in scope");
ok(SCOPE.test("packages/core/agent/commands/core.ts") && SCOPE.test("agent/settings/settings.ts"), "scope: core and the app tier are in scope");
ok(!SCOPE.test("packages/create/src/cli.ts") && !SCOPE.test("scripts/ops-mcp.ts"), "scope: the product CLI and operator scripts are out of scope");
ok(isGenerated("packages/providers/teams/agent/docs-generated.ts") && isGenerated("packages/core/agent/docs/generated/deploy.ts"), "generated docs embeds are skipped");
ok(isGenerated("agent/access/grants.generated.ts") && !isGenerated("packages/core/agent/status/status.ts"), "…and `*.generated.ts`, but not ordinary source");

const allow = [{ file: "a.ts", literal: "Open Everywhere", why: "test" }];
const verdict = judge([{ file: "a.ts", line: 1, text: "Open Everywhere" }, { file: "b.ts", line: 2, text: "Ask Open Everywhere" }], allow);
ok(verdict.refused.length === 1 && verdict.refused[0]!.file === "b.ts", "🔴 an unallowed hit is REFUSED; the allowlisted file's hit is not");
ok(verdict.stale.length === 0, "a used allowlist entry is not stale");
ok(judge([], allow).stale.length === 1, "🔴 an allowlist entry nothing matches is STALE — a standing permission is refused");
ok(ALLOWLIST.every((e) => e.why.length > 20), "every shipped allowlist entry states its reason");

const exact = judge(
  [
    { file: "packages/providers/slack/agent/app-manifest.ts", line: 1, text: "Open Everywhere" },
    { file: "packages/providers/slack/agent/app-manifest.ts", line: 2, text: "Send to Open Everywhere" },
  ],
  ALLOWLIST,
);
ok(exact.refused.length === 1 && exact.refused[0]!.text === "Send to Open Everywhere", "🔴 a SECOND brand literal in an allowlisted file is refused");
const sub = judge([{ file: "x.ts", line: 1, text: "a long summary that says It REPLACES the brand there, once" }], [
  { file: "x.ts", literal: "It REPLACES the brand there", match: "substring", why: "a substring entry for a long literal" },
]);
ok(sub.refused.length === 0, "a `substring` entry passes the long literal that holds its phrase");

ok(hitsIn("if (x) /'/.test(y); const s = 'Open Everywhere';").length === 1, "🔴 a regex after `if (…)` holding a quote does not hide a later literal");
ok(hitsIn("const r = f(x) / 2; const s = 'Open Everywhere';").length === 1, "…and a division after a call's `)` is still a division");

console.log(`✓ brand-literal-lint: ${n} assertions passed (literal forms, comments skipped, scope, judge)`);
