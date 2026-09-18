import { CITATION, LINE_CITATION, GLOSSARY_MARKER, anchorLine, citationProblem, declarationLines, isExportedDeclaration, parseCitations } from "./glossary-citation-lint.js";

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

const treeOf =
  (files: Record<string, string>) =>
  (path: string): string[] | undefined =>
    files[path]?.split("\n");

{
  const text =
    "Source: `packages/core/agent/access/roster.ts#WORKER_ONLY_TOOLS_STANDING` " +
    "and `#WORKER_ONLY_TOOLS_THREAD`.";
  const found = parseCitations(text);
  ok(found.length === 2, `both citations parse (got ${found.length})`);
  ok(found[0]?.anchor === "WORKER_ONLY_TOOLS_STANDING", `the first anchor is read (got ${JSON.stringify(found[0]?.anchor)})`);
  ok(found[1]?.anchor === "WORKER_ONLY_TOOLS_THREAD", `…and so is the SECOND on the same line (got ${JSON.stringify(found[1]?.anchor)})`);
  ok(found[0]?.path === "packages/core/agent/access/roster.ts", "the first citation carries its own path");
  ok(found[1]?.path === "packages/core/agent/access/roster.ts", "the CONTINUATION `#…` carries the last path seen");
}

{
  const found = parseCitations("It moved to `#windowGrainOf` last week.");
  ok(found.length === 1 && found[0]?.path === undefined, "a CONTINUATION with no earlier path carries no path");
  ok(citationProblem(found[0]!, treeOf({}))?.problem?.includes("no earlier path") === true, "…and the lint says exactly that");
}

{
  ok(parseCitations("`packages/core/agent/routines/gate.ts`").length === 0, "a path with no anchor is not a citation");
  ok(parseCitations("a plain `identifier` in prose").length === 0, "a bare code span is not a citation");
  ok(parseCitations("`gate.ts#has-a-dash`").length === 0, "an anchor that is not an identifier is not a citation");
  ok(CITATION.global === true && LINE_CITATION.global === true, "both patterns are global — `matchAll` refuses one that is not");
}

{
  const hits = [...`Source: \`packages/core/agent/identity/binding.ts:862\`.`.matchAll(LINE_CITATION)];
  ok(hits.length === 1 && hits[0]?.[2] === "862", "a FILE:LINE citation is found, so the gate can refuse it");
  ok([...`\`a.ts:59-71\``.matchAll(LINE_CITATION)].length === 1, "…and a RANGE citation is the same shape");
  ok([...`\`packages/core/agent/identity/binding.ts#windowGrainOf\``.matchAll(LINE_CITATION)].length === 0, "a symbol citation is NOT refused");
  ok([...`\`tool:notion__search\``.matchAll(LINE_CITATION)].length === 0, "a qualified tool name carrying a colon is not a citation");
  ok([...`at \`12:30\` today`.matchAll(LINE_CITATION)].length === 0, "a clock time is not a citation");
}

{
  const SOURCE = [
    "import { x } from './x.js';",
    "export type WindowGrain = 'standing' | 'thread';",
    "const INVOKER_POSTURE_RANK = { a: 1 };",
    "export function windowGrainOf(ctx: C): WindowGrain {",
    "  return 'standing';",
    "}",
    "export interface TrainMember {",
    "  readonly pr: number;",
    "}",
    "export const TABLE = {",
    "  spawn_thread_session: ['standing'],",
    "};",
    "export { helper } from './helper.js';",
  ];
  const declared = (symbol: string): boolean => declarationLines(SOURCE, symbol).length > 0;
  ok(declared("WindowGrain"), "an exported type declaration resolves");
  ok(declared("windowGrainOf"), "an exported function declaration resolves");
  ok(declared("INVOKER_POSTURE_RANK"), "a module-PRIVATE const resolves — a private helper is a legitimate glossary subject");
  ok(declared("pr"), "a property in an interface resolves");
  ok(declared("spawn_thread_session"), "a table KEY resolves — the window-gate manifest is cited by its keys");
  ok(declared("helper"), "a re-export resolves");

  ok(declarationLines(["windowGrainOf(ctx);"], "windowGrainOf").length === 0, "🔴 a bare CALL at the start of a line is not a declaration");
  ok(declarationLines(["restrictToolsetForLeanSeat(toolset, isDm);"], "restrictToolsetForLeanSeat").length === 0, "…with arguments either");
  ok(declarationLines(["count = count + 1;"], "count").length === 0, "🔴 a REASSIGNMENT is not a declaration");
  ok(declarationLines(["auditScrub?(text: string): string;"], "auditScrub").length === 1, "an optional METHOD SIGNATURE in an interface still resolves");
  ok(declarationLines(["export const enum Tier {"], "Tier").length === 1, "`export const enum` still resolves");
  ok(declarationLines(["export {", "  helper,", '} from "./h.js";'], "helper").length === 1, "a multi-line re-export still resolves");
  ok(!declared("ctx"), "a PARAMETER name is not a declaration this gate accepts");
  ok(!declared("x"), "an IMPORTED name is not a declaration — the file does not declare it");
  ok(!declared("WindowGrainOf"), "the resolver is case-sensitive");
  ok(!declared("windowGrain"), "…and matches whole names, never a prefix of one");
  ok(!declared("nothingHere"), "a name the file does not carry does not resolve");

  ok(isExportedDeclaration("export function windowGrainOf(ctx: C): W {", "windowGrainOf"), "an exported function counts toward rule ④");
  ok(!isExportedDeclaration("const INVOKER_POSTURE_RANK = { a: 1 };", "INVOKER_POSTURE_RANK"), "…and a private one does not");
}

{
  const tool = { "t.ts": "import { defineTool } from 'eve/tools';\nconst NAME_RE = /x/;\nexport default defineTool({\n  name: 't',\n});" };
  const cite = (text: string) => citationProblem(parseCitations(text)[0]!, treeOf(tool));
  ok(cite("`t.ts#default`").problem === undefined, "a `#default` anchor resolves to the module's default export");
  ok(cite("`t.ts#default`").exported === true, "…and counts as an exported declaration");
  ok(citationProblem(parseCitations("`p.ts#default`")[0]!, treeOf({ "p.ts": "export const a = 1;\n" })).problem?.includes("declares no `default`") === true, "a module with no default export refuses `#default`");
}

{
  const files = {
    "d.ts": ["export const a = 1;", "// glossary: the replay doctrine — never pick a side", "const b = 2;"].join("\n"),
  };
  const cite = (text: string) => citationProblem(parseCitations(text)[0]!, treeOf(files));
  ok(anchorLine("L2") === 2, "an `#L2` anchor reads as line 2");
  ok(anchorLine("windowGrainOf") === undefined, "a symbol anchor is not a line");
  ok(cite("`d.ts#L2`").problem === undefined, "an anchor landing on a marked line resolves");
  ok(cite("`d.ts#L1`").problem?.includes("carries no `glossary:` marker") === true, "an anchor on an UNMARKED line reds — this is the whole rule");
  ok(cite("`d.ts#L3`").problem?.includes("carries no `glossary:` marker") === true, "…including one that lands on ordinary code");
  ok(cite("`d.ts#L99`").problem?.includes("outside") === true, "an anchor past the end of the file reds");
  ok(GLOSSARY_MARKER.test(" * glossary: in a jsdoc block") && GLOSSARY_MARKER.test("# glossary: in a shell script"), "the marker is read in a jsdoc and a `#` comment too");
  ok(!GLOSSARY_MARKER.test("// the glossary says so"), "prose about the glossary is not a marker");
}

{
  const problem = citationProblem(parseCitations("`gone.ts#thing`")[0]!, treeOf({ "here.ts": "export const thing = 1;\n" })).problem;
  ok(problem?.includes("does not exist") === true, "a citation naming a file that is gone reds, and says so");
  ok(citationProblem(parseCitations("`here.ts#thing`")[0]!, treeOf({ "here.ts": "export const thing = 1;\n" })).problem === undefined, "…and the control: the file that IS there resolves");
}

console.log(`\n✓ glossary-citation-lint: ${passed} assertions passed`);
