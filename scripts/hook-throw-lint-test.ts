import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_PLAUSIBLE_HOOK_FILES, blankCommentsAndStrings, catchesInSameFile, hookThrowFindings, readHookFiles } from "./hook-throw-lint.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

{
  const findings = hookThrowFindings([{ file: "made-up.ts", source: "function f() {\n  throw new Error('stop the turn');\n}\n" }], []);
  ok(findings.length === 1, "rule 1: an unclassified throw is one finding");
  ok(findings[0]!.rule === "unclassified", "rule 1: classified as `unclassified`");
  ok(findings[0]!.line === 2, "rule 1: the finding names the throwing LINE (2), not the file");
  ok(findings[0]!.detail.includes("refuseTurn"), "rule 1: the message names the fix");
}
{
  const source = "// hook-throw: CONTROL — refuses a turn\nthrow new Error('stop');\n";
  const findings = hookThrowFindings([{ file: "made-up.ts", source }], []);
  ok(findings.length === 1 && findings[0]!.rule === "control", "rule 2: a CONTROL marker is REFUSED, not accepted");
  ok(findings[0]!.detail.includes("swallowed"), "rule 2: the message says why a control throw cannot work");
}
{
  const source = "// hook-throw: DEFECT — a non-string here is a programmer error\nthrow new TypeError('bad');\n";
  ok(hookThrowFindings([{ file: "made-up.ts", source }], []).length === 0, "a DEFECT marker in the comment block above is accepted (negative control)");
  const sameLine = "throw new TypeError('bad'); // hook-throw: DEFECT — bug path\n";
  ok(hookThrowFindings([{ file: "made-up.ts", source: sameLine }], []).length === 0, "a DEFECT marker on the THROWING LINE is accepted too");
}
{
  const source = "// hook-throw: DEFECT — bug path\n// a second comment line\n\nthrow new Error('x');\n";
  ok(hookThrowFindings([{ file: "made-up.ts", source }], []).length === 0, "the marker scope spans the whole contiguous comment block above the throw");
  const far = "// hook-throw: DEFECT — bug path\nconst a = 1;\nthrow new Error('x');\n";
  ok(hookThrowFindings([{ file: "made-up.ts", source: far }], []).length === 1, "a marker does NOT carry across a line of code to a later throw");
}
{
  const pending = [{ file: "owned.ts", ticket: "OPE-9999", why: "another ticket converts it" }];
  const withThrow = hookThrowFindings([{ file: "owned.ts", source: "throw new Error('x');\n" }], pending);
  ok(withThrow.length === 0, "a PENDING_CONVERSION row suppresses rule 1 for its own file");
  const clean = hookThrowFindings([{ file: "owned.ts", source: "const a = 1;\n" }], pending);
  ok(clean.length === 1 && clean[0]!.rule === "stale-pending-row", "rule 4: a pending row whose file is clean REDS, so the table self-cleans");
  const other = hookThrowFindings([{ file: "elsewhere.ts", source: "throw new Error('x');\n" }], pending);
  ok(
    other.some((f) => f.rule === "unclassified" && f.file === "elsewhere.ts"),
    "a pending row suppresses NOTHING in another file",
  );
}

{
  const literalReturn = ["function catcher(): { a: number } {", "  try { risky(); } catch (e) { return { a: 1 }; }", "}"].join("\n");
  ok(!catchesInSameFile(literalReturn, "catcher"), "an object-literal return type hides the body from the catcher scan (the documented, fail-safe limit)");
  const namedReturn = ["function catcher(): Named {", "  try { risky(); } catch (e) { return { a: 1 }; }", "}"].join("\n");
  ok(catchesInSameFile(namedReturn, "catcher"), "…and a NAMED return type lets the scan find the catch");
}

{
  const proven = [
    "function catcher() {",
    "  try { risky(); } catch (e) { return e; }",
    "}",
    "// hook-throw: INTERNAL(catcher) — caught above",
    "throw new Error('x');",
  ].join("\n");
  ok(hookThrowFindings([{ file: "made-up.ts", source: proven }], []).length === 0, "rule 3: INTERNAL(fn) is accepted when `fn` exists and its body catches");

  const noSuchFn = "// hook-throw: INTERNAL(missing) — claims a catcher that is not here\nthrow new Error('x');\n";
  const f1 = hookThrowFindings([{ file: "made-up.ts", source: noSuchFn }], []);
  ok(f1.length === 1 && f1[0]!.rule === "internal-unproven", "rule 3: INTERNAL naming a function the file does not declare REDS");

  const fnWithoutCatch = ["function catcher() {", "  return 1;", "}", "// hook-throw: INTERNAL(catcher) — but it catches nothing", "throw new Error('x');"].join("\n");
  const f2 = hookThrowFindings([{ file: "made-up.ts", source: fnWithoutCatch }], []);
  ok(f2.length === 1 && f2[0]!.rule === "internal-unproven", "rule 3: INTERNAL naming a function with NO catch in its body REDS");

  const catchAfter = ["function catcher() {", "  return 1;", "}", "function other() { try { x(); } catch (e) {} }"].join("\n");
  ok(!catchesInSameFile(catchAfter, "catcher"), "the brace matcher stops at the named function's own closing brace");
  ok(catchesInSameFile(catchAfter, "other"), "...and finds a catch that really is inside the named body (negative control)");
  ok(catchesInSameFile("const catcher = async () => { try { x(); } catch (e) {} };", "catcher"), "an arrow function assigned to a const counts as a declaration");
}

{
  const quoted = [
    "// eve's own bytes: catch (t) { throw t }",
    "/* a block comment that says throw */",
    "const message = 'the hook used to throw here';",
    "const tpl = `also throw`;",
    "const real = 1;",
  ].join("\n");
  const findings = hookThrowFindings([{ file: "made-up.ts", source: quoted }], []);
  ok(findings.length === 0, "a throw inside a line comment, a block comment, a string or a template literal is NOT a throw");

  const mixed = `// quoted throw\nthrow new Error('x');\n`;
  const f2 = hookThrowFindings([{ file: "made-up.ts", source: mixed }], []);
  ok(f2.length === 1 && f2[0]!.line === 2, "the blanker keeps line numbers: the real throw is still line 2 after a comment line");

  const blanked = blankCommentsAndStrings(quoted);
  ok(blanked.split("\n").length === quoted.split("\n").length, "the blanker preserves the line COUNT");
  ok(!/\bthrow\b/.test(blanked), "the blanker leaves no `throw` word behind in comments or strings");
  ok(blanked.includes("const real = 1;"), "the blanker leaves real code alone (negative control)");
  ok(blankCommentsAndStrings("const s = 'it\\'s fine'; throw x;").includes("throw"), "an escaped quote does not run the string to the end of the file");
}

{
  const files = readHookFiles();
  ok(files.length >= MIN_PLAUSIBLE_HOOK_FILES, `the real hooks directory yields ${files.length} files, at or above the floor of ${MIN_PLAUSIBLE_HOOK_FILES}`);
  const findings = hookThrowFindings(files);
  ok(findings.length === 0, `the real tree is CLEAN. Findings: ${findings.map((f) => `${f.rule} ${f.file}:${f.line}`).join("; ")}`);
  {
    const empty = mkdtempSync(join(tmpdir(), "oe-hook-throw-empty-"));
    try {
      const scanned = readHookFiles(empty);
      ok(scanned.length === 0, "the real reader returns nothing for an empty directory");
      ok(scanned.length < MIN_PLAUSIBLE_HOOK_FILES, "…which is below the floor, so `main` refuses rather than reporting `no findings` on a broken scan");
      ok(hookThrowFindings(scanned, []).length === 0, "…and the rules report no findings on it, which is why the FLOOR is the guard and not a rule");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }
  for (const converted of ["egress.ts", "binding-bridge.ts", "eve-patch-gate.ts"]) {
    const source = files.find((f) => f.file === converted)?.source;
    ok(source !== undefined, `the converted hook ${converted} is in the scan`);
    ok(/refuseTurn\(/.test(source ?? ""), `${converted} CALLS refuseTurn — OPE-2249 converted its control throw to ctx.cancel()`);
  }
  {
    for (const clean of ["binding-bridge.ts", "eve-patch-gate.ts"]) {
      const source = files.find((f) => f.file === clean)?.source ?? "";
      ok(!/\bthrow\b/.test(blankCommentsAndStrings(source)), `${clean} carries NO throw in its code`);
    }
    const egress = files.find((f) => f.file === "egress.ts")?.source ?? "";
    const throwLines = blankCommentsAndStrings(egress)
      .split("\n")
      .filter((l) => /\bthrow\b/.test(l));
    ok(throwLines.length === 1, `egress.ts carries exactly ONE throw in its code (found ${throwLines.length}) — the INTERNAL signal, never a control throw`);
    ok(/hook-throw: INTERNAL\(enforceEgress\)/.test(egress), "egress.ts's remaining throw is classified INTERNAL(enforceEgress)");
  }
}

console.log(`\n✓ hook-throw-lint: ${n} assertions passed (all 4 rules fired on synthetic sources; blanker pinned; empty scan driven through the real reader; real tree clean)\n`);
