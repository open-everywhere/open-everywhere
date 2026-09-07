import {
  codeOnly,
  helperFamilies,
  scanViews,
  signalsOf,
  spawnsChild,
  splitParams,
  withoutComments,
  type HelperFamily,
} from "./test-runner-inventory.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq(actual: unknown, expected: unknown, label: string): void {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

{
  const text = '// 🔴 a note with an emoji\nconst a = "🔴 value";\nconst b = 2;\n';
  const { spec, code } = scanViews(text);
  eq(spec.length, text.length, "🔴 spec view keeps the byte length, with emoji present");
  eq(code.length, text.length, "🔴 code view keeps the byte length, with emoji present");
  ok(spec.includes('const a = "🔴 value";'), "a line comment stops at its newline — the NEXT line is untouched");
  ok(code.includes("const b = 2;"), "a string does not blank the line after it");
}
{
  const text = "/* one\n   two */\nconst t = `a\nb`;\nconst tail = 1;\n";
  const { spec, code } = scanViews(text);
  eq(spec.split("\n").length, text.split("\n").length, "a multi-line block comment keeps its newlines");
  eq(code.split("\n").length, text.split("\n").length, "a multi-line template keeps its newlines");
  eq(spec.length, text.length, "blanking a multi-line span preserves length");
  ok(code.includes("const tail = 1;"), "the line after a multi-line template survives");
}

{
  const text = 'import { execFileSync } from "node:child_process"; // spawns\n';
  const { spec, code } = scanViews(text);
  ok(spec.includes('"node:child_process"'), "spec view keeps an import specifier");
  ok(!spec.includes("spawns"), "spec view drops the trailing line comment");
  ok(!code.includes("node:child_process"), "code view blanks the specifier");
  ok(code.includes("import { execFileSync } from"), "code view keeps the code around the specifier");
}

{
  const text = 'const u = "https://example.com/x"; const after = 1;\n';
  const spec = withoutComments(text);
  ok(spec.includes('"https://example.com/x"'), "🔴 a `//` INSIDE a string is not a comment");
  ok(spec.includes("const after = 1;"), "🔴 …so the code after that string, on the same line, survives");
}
{
  const text = '// see `@workflow/*` for why\nimport y from "node:child_process";\nconst z = 1;\n';
  const spec = withoutComments(text);
  ok(spec.includes('"node:child_process"'), "🔴 a `/*` inside a `//` comment does not swallow later code");
  ok(spec.includes("const z = 1;"), "…and does not swallow the line after that either");
  ok(!spec.includes("@workflow"), "the line comment itself is still blanked");
}

{
  const text = "function f(m: string) { return /couldn't open a DM/.test(m) && ok(m); }\n";
  const code = codeOnly(text);
  ok(code.includes(".test(m)"), "🔴 a regex after `return` is a regex — the call after it survives");
  ok(!code.includes("couldn"), "…and its body is blanked");
  ok(code.includes("&& ok(m); }"), "🔴 an apostrophe inside that regex does not open a string to end of line");
}
{
  const text = 'function f(s: string) { return /`/.test(s); }\nimport y from "node:child_process";\n';
  ok(codeOnly(text).includes("import y from"), "🔴 a backtick inside a keyword-led regex does not open a template");
}
{
  const text = "const r = total / count / 2;\nconst s = 4;\n";
  eq(codeOnly(text), text, "🔴 division after an identifier is left alone, both slashes");
}
{
  const text = "const r = /notclosed;\nconst y = 3;\n";
  const code = codeOnly(text);
  ok(code.includes("notclosed"), "🔴 an unterminated regex candidate blanks nothing on its own line");
  ok(code.includes("const y = 3;"), "…and does not eat the next line");
}

{
  const text = "const t = `export async function execute() {}`;\nconst u = 1;\n";
  const code = codeOnly(text);
  ok(!code.includes("export async function"), "🔴 a fixture source inside a template is not top-level code");
  ok(code.includes("const u = 1;"), "the template does not swallow the next line");
}
{
  const text = "const t = `a${ok(x)}b`;\n";
  const code = codeOnly(text);
  ok(code.includes("ok(x)"), "a `${…}` substitution stays CODE");
  ok(!code.includes("`a"), "the literal text around it does not");
}
{
  const text = "const t = `x${ inner(`y${ deep(z) }`) }w`;\nconst after = 1;\n";
  const code = codeOnly(text);
  ok(code.includes("inner("), "a nested template's outer substitution stays code");
  ok(code.includes("deep(z)"), "…and so does the inner one");
  ok(code.includes("const after = 1;"), "a nested template closes at the right backtick");
}
{
  const text = "const t = `a${ x }export function boom() {}`;\n";
  const code = codeOnly(text);
  ok(code.includes("x"), "the substitution itself stays code");
  ok(!code.includes("export function boom"), "🔴 template text AFTER a `${…}` is blanked, not code");
}
{
  const text = "const t = `x${ JSON.stringify({ a: 1 }) + label(y) }export function boom() {}`;\nconst after = 1;\n";
  const code = codeOnly(text);
  ok(code.includes("JSON.stringify"), "a substitution holding an object literal stays code");
  ok(code.includes("label(y)"), "🔴 …and so does the code AFTER that literal, still inside the substitution");
  ok(!code.includes("export function boom"), "🔴 …while the template text after the substitution is blanked");
  ok(code.includes("const after = 1;"), "…and the template still closes at its own backtick");
}
{
  const text = "const t = `a\\`b`;\nconst after = 1;\n";
  ok(codeOnly(text).includes("const after = 1;"), "an escaped backtick does not close a template early");
}
{
  const text = "const t = `line // not a comment\nstill template`;\nconst after = 1;\n";
  const spec = withoutComments(text);
  ok(spec.includes("// not a comment"), "🔴 a `//` inside a multi-line template is not a comment");
  ok(codeOnly(text).includes("const after = 1;"), "the template does not swallow the line after it");
}

{
  const text = "const a = 1; /* gone */ const b = 2;\n";
  const spec = withoutComments(text);
  ok(spec.includes("const a = 1;") && spec.includes("const b = 2;"), "a block comment blanks only itself");
  ok(!spec.includes("gone"), "…and it does blank itself");
}
{
  const text = 'const p = "a\\"b"; const after = 1;\n';
  ok(codeOnly(text).includes("const after = 1;"), "🔴 an escaped quote does not close the string early");
}
{
  const text = 'const p = "a\\\\"; const after = 2;\n';
  ok(codeOnly(text).includes("const after = 2;"), "an escaped backslash at a string's end closes the string");
}

{
  const family = (src: string): HelperFamily[] => helperFamilies(codeOnly(src));
  eq(family("function ok(cond: boolean, label: string): void {}"), ["boolean"], "ok(cond, label) is the boolean family");
  eq(family("const ok = (label: string, cond: boolean) => {};"), ["reversed"], "🔴 ok(label, cond) is the REVERSED family");
  eq(family("function eq(actual: unknown, expected: unknown, what: string): void {}"), ["compare"], "eq(a, b, label) is the compare family");
  eq(family("const fail = (msg: string) => {};"), [], "a one-parameter accumulator is not an assertion helper");
  eq(family("function helper(a: boolean, b: string): void {}"), [], "a function whose NAME is not a house helper does not count");
  eq(
    family("function ok(cond: boolean, label: string): void {}\nfunction eq(a: unknown, b: unknown, l: string): void {}"),
    ["boolean", "compare"],
    "a file defining both families reports both",
  );
  eq(
    splitParams("actual: Record<string, number>, expected: Map<string, string>, l: string"),
    ["actual: Record<string, number>", "expected: Map<string, string>", "l: string"],
    "🔴 a generic's comma does not split the parameter list",
  );
  eq(splitParams("cond: boolean, label: string"), ["cond: boolean", "label: string"], "a plain list splits on its commas");
  eq(splitParams(""), [], "an empty parameter list has no parameters");
  eq(family("ok(a === b, 'label');"), [], "a call site does not register a helper");
}

{
  const real = 'import { execFileSync } from "node:child_process";\n';
  const views = scanViews(real);
  ok(spawnsChild(views.spec, views.code), "a real import of node:child_process is a child-process file");

  const quoted = "const fixture = `\nimport y from \"node:child_process\";\n`;\n";
  const qv = scanViews(quoted);
  ok(!spawnsChild(qv.spec, qv.code), "🔴 a QUOTED node:child_process import inside a fixture is not one");

  const mentioned = '// this file does not import "node:child_process" at all\nconst a = 1;\n';
  const mv = scanViews(mentioned);
  ok(!spawnsChild(mv.spec, mv.code), "a comment naming the specifier is not an import");

  const wrapped = 'import {\n  execFileSync,\n  spawnSync,\n} from "node:child_process";\n';
  const wv = scanViews(wrapped);
  ok(spawnsChild(wv.spec, wv.code), "🔴 a WRAPPED import of node:child_process is still an import");

  const afterImports = 'import { readFileSync } from "node:fs";\nconst BANNED = "node:child_process";\n';
  const av = scanViews(afterImports);
  ok(!spawnsChild(av.spec, av.code), "🔴 a constant under an import block is not an import of it");

  const unrelated = 'const a = 1;\nconst b = 2;\nconst s = "node:child_process";\n';
  const uv = scanViews(unrelated);
  ok(!spawnsChild(uv.spec, uv.code), "a plain string constant naming the specifier is not an import");
}

{
  const fixture = [
    'import assert from "node:assert";',
    'const label = "assert(inAString);";',
    "// assert(inALineComment);",
    "/* assert(inABlockComment); */",
    "const quoted = `",
    "assert(inATemplateLiteral);",
    "`;",
    "assert(a === b);",
    "  assert.equal(a, b);",
    "await assert.rejects(p);",
    "assertMarked(a);",
    "ok(assert(nested));",
    "",
  ].join("\n");

  eq(
    signalsOf(fixture).directAssertSites,
    3,
    "🔴 `directAssertSites` counts the three statement-position `assert` calls and none of the five controls — a comment, a string, a template body, an `assert`-prefixed helper name, and a nested call",
  );

  const controlsOnly = fixture
    .split("\n")
    .filter((l) => !/^[ \t]*(?:await[ \t]+)?assert(?:\.\w+)?[ \t]*\(/u.test(l))
    .join("\n");
  eq(signalsOf(controlsOnly).directAssertSites, 0, "🔴 the controls alone count ZERO — the three above are what the fixture measures");
}

console.log(`\n✓ tidy runner inventory: ${passed} assertions passed (scanner views, emoji offsets, regex-after-keyword, nested templates, helper families, direct-assert sites)\n`);
