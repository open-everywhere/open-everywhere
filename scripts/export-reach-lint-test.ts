import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finishedRun } from "./npm-command.js";
import {
  KNOWN_UNREACHED_EXPORTS,
  auditExportReach,
  exportedNamesIn,
  importSitesIn,
  isGenerated,
  isSurface,
  reexportsStar,
  staleBaselineEntries,
  unownedBaselineEntries,
  unreadableExportsIn,
} from "./export-reach-lint.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(root, "scripts", "export-reach-lint.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

const scratchRoots: string[] = [];

function fixtureTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oe-export-reach-"));
  scratchRoots.push(dir);
  write(dir, "packages/core/package.json", JSON.stringify({ name: "@open-everywhere/core" }));
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  return dir;
}

function write(dir: string, rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${body}\n`);
}

function lint(treeRoot: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, LINT, "--root", treeRoot, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: finishedRun(r, "the export-reach lint").status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

try {
  {
    const HELPERS = `
export function reachedHelper(n: number): number {
  return localHelper(n) + 1;
}
export function localHelper(n: number): number {
  return n * 2;
}
`;
    const CONSUMER = `
import { reachedHelper } from "./helpers.js";
export function useIt(n: number): number {
  return reachedHelper(n);
}
`;
    const tree = fixtureTree({
      "packages/core/agent/helpers.ts": HELPERS,
      "packages/core/agent/consumer.ts": CONSUMER,
      "packages/core/agent/adapter-api.ts": `export { useIt } from "./consumer.js";`,
    });

    const red = lint(tree);
    ok(red.code === 1, "RED: a value export with no importer outside its own file exits 1");
    ok(
      red.out.includes("packages/core/agent/helpers.ts") && red.out.includes("localHelper"),
      "RED: the message names the file AND the export, so the fix needs no search",
    );
    ok(!red.out.includes("`reachedHelper`"), "RED: the export that DOES have an importer is not reported");
    ok(red.out.includes("delete the `export` keyword"), "RED: the remedy is printed under the reds");

    write(tree, "packages/core/agent/consumer.ts", `${CONSUMER}\nimport { localHelper } from "./helpers.js";\nexport const twice = localHelper;\n`);
    write(tree, "packages/core/agent/adapter-api.ts", `export { useIt, twice } from "./consumer.js";\n`);
    const green = lint(tree);
    ok(green.code === 0, "GREEN: adding one importer in another file clears the red");
    ok(green.out.includes("value export(s)"), "GREEN: the pass line reports what it counted");
  }

  {
    const tree = fixtureTree({
      "packages/core/agent/helpers.ts": `export function localHelper(n: number): number {\n  return n;\n}\nexport const seed = localHelper(1);\n`,
      "packages/core/agent/consumer.ts":
        `// import { localHelper } from "./helpers.js";\n` +
        `/* import { seed } from "./helpers.js"; */\n` +
        `const doc = 'import { localHelper } from "./helpers.js";';\n` +
        `export const note = doc;\n`,
      "packages/core/agent/adapter-api.ts": `export { note } from "./consumer.js";`,
    });
    const r = lint(tree);
    ok(r.code === 1, "RED: an import inside a comment or a string does not count as an importer");
    ok(r.out.includes("localHelper") && r.out.includes("`seed`"), "RED: both commented-out imports are seen through");
  }

  {
    const tree = fixtureTree({
      "packages/core/agent/shapes.ts":
        `export interface Shape { readonly n: number }\n` +
        `export type Kind = "a" | "b";\n` +
        `export const DEFAULT_KIND: Kind = "a";\n` +
        `export function make(n: number): Shape {\n  return { n };\n}\n`,
      "packages/core/agent/consumer.ts": `import { make } from "./shapes.js";\nexport const first = make(1);\n`,
      "packages/core/agent/adapter-api.ts": `export { first } from "./consumer.js";`,
    });
    const r = lint(tree);
    ok(r.code === 1, "RED: the unreached CONST is reported");
    ok(r.out.includes("DEFAULT_KIND"), "RED: …by name");
    ok(!r.out.includes("`Shape`") && !r.out.includes("`Kind`"), "the unreached type and interface are NOT reported");
    ok(/1 export\(s\) with no importer/.test(r.out), "exactly one red — the kind split is doing the work");
  }

  {
    const tree = fixtureTree({
      "packages/core/agent/adapter-api.ts": `export function onlyOnTheSurface(): number {\n  return 1;\n}\n`,
      "packages/core/agent/index.ts": `export function alsoASurface(): number {\n  return 2;\n}\n`,
      "packages/core/agent/contributions.ts": `export function registerThings(): number {\n  return 3;\n}\n`,
      "packages/core/agent/docs/generated/root.ts": `export const GENERATED_BLOB = "x";\n`,
      "packages/core/agent/thing.generated.ts": `export const ALSO_GENERATED = "y";\n`,
    });
    const r = lint(tree);
    ok(r.code === 0, "GREEN: surface files and generated modules are exempt");
  }

  {
    const tree = fixtureTree({
      "packages/core/agent/barrel.ts": `export * from "./helpers.js";\n`,
      "packages/core/agent/helpers.ts": `export function h(): number {\n  return 1;\n}\n`,
    });
    const r = lint(tree);
    ok(r.code === 1, "RED: a scanned module using `export *` is refused, not skipped");
    ok(r.out.includes("cannot be enumerated"), "RED: …and it says why");
  }

  {
    const names = (src: string): string[] => exportedNamesIn(src).map((e) => e.name);
    ok(names("export function f() {}").includes("f"), "grammar: export function");
    ok(names("export async function g() {}").includes("g"), "grammar: export async function");
    ok(names("export function* gen() {}").includes("gen"), "grammar: export generator function");
    ok(names("export const c = 1;").includes("c"), "grammar: export const");
    ok(names("export let l = 1;").includes("l"), "grammar: export let");
    ok(names("export class K {}").includes("K"), "grammar: export class");
    ok(names("export abstract class A {}").includes("A"), "grammar: export abstract class");
    ok(names("export enum E { a }").includes("E"), "grammar: export enum");
    ok(names("export interface I { n: number }").includes("I"), "grammar: export interface");
    ok(names("export type T = string;").includes("T"), "grammar: export type alias");
    ok(names("export { a, b };").join(",") === "a,b", "grammar: export list");
    ok(names("export { a as b };").includes("b"), "grammar: an aliased export exports the ALIAS");
    ok(!names("export { a as b };").includes("a"), "grammar: …and not the local name");
    ok(names('export { c } from "./x.js";').includes("c"), "grammar: a re-export is an export of THIS file");
    ok(names("export default function () {}").length === 0, "grammar: a default export has no name to rule on");
    ok(names("const notExported = 1;").length === 0, "grammar: a plain declaration is not an export");
    ok(names('const s = "export function fake() {}";').length === 0, "grammar: an export inside a STRING is not one");
    ok(names("// export function commented() {}").length === 0, "grammar: an export inside a COMMENT is not one");
    ok(
      names("/*\nexport function inBlockComment() {}\n*/").length === 0,
      "grammar: an export at line start inside a BLOCK comment is not one",
    );
    ok(
      names("const doc = `\nexport const inTemplate = 1;\n`;").length === 0,
      "grammar: an export at line start inside a TEMPLATE literal is not one",
    );

    const kindOf = (src: string, name: string): string | undefined =>
      exportedNamesIn(src).find((e) => e.name === name)?.kind;
    ok(kindOf("export const c = 1;", "c") === "value", "kind: const is a value");
    ok(kindOf("export function f() {}", "f") === "value", "kind: function is a value");
    ok(kindOf("export class K {}", "K") === "value", "kind: class is a value");
    ok(kindOf("export enum E { a }", "E") === "value", "kind: enum is a value");
    ok(kindOf("export interface I { n: number }", "I") === "type", "kind: interface is a type");
    ok(kindOf("export type T = string;", "T") === "type", "kind: type alias is a type");
    ok(kindOf("export type { A };", "A") === "type", "kind: `export type { … }` is a type list");
    ok(kindOf("export { type A, b };", "A") === "type", "kind: a per-entry `type` modifier is a type");
    ok(kindOf("export { type A, b };", "b") === "value", "kind: …and its neighbour is still a value");
    ok(
      kindOf("export interface X { n: number }\nexport const X = 1;", "X") === "value",
      "kind: a name declared as both a type and a value counts as a VALUE",
    );
  }

  {
    const sites = (src: string) => importSitesIn(src);
    const named = (src: string): string[] => sites(src).flatMap((s) => [...s.names]);
    ok(named('import { a, b } from "./x.js";').join(",") === "a,b", "import: a named list");
    ok(named('import { a as z } from "./x.js";').includes("a"), "import: an alias takes the SOURCE name");
    ok(!named('import { a as z } from "./x.js";').includes("z"), "import: …never the local alias");
    ok(named('import type { T } from "./x.js";').includes("T"), "import: a type-only import is an importer");
    ok(named('import { type T, v } from "./x.js";').join(",") === "T,v", "import: a per-entry type modifier");
    ok(named('export { a } from "./x.js";').includes("a"), "import: a re-export reads the name it forwards");
    ok(
      named('import {\n  a,\n  b,\n} from "./x.js";').join(",") === "a,b",
      "import: a list broken across lines is one statement",
    );
    ok(sites('import * as ns from "./x.js";')[0]?.whole === true, "import: a namespace import takes the lot");
    ok(sites('import "./x.js";')[0]?.whole === true, "import: a side-effect import takes the lot");
    ok(sites('await import("./x.js");')[0]?.whole === true, "import: a bare dynamic import takes the lot");
    ok(sites('const m = await import("./x.js");')[0]?.whole === true, "import: …and so does one bound to an identifier");
    ok(
      named('const { a, b } = await import("./x.js");').join(",") === "a,b",
      "import: a destructured dynamic import names its bindings",
    );
    ok(
      sites('const { a } = await import("./x.js");')[0]?.whole === false,
      "import: …so it does NOT take the module wholesale",
    );
    ok(
      named('const {\n  a,\n  b,\n} = await import("./x.js");').join(",") === "a,b",
      "import: a destructured dynamic import broken across lines",
    );
    ok(named('const { a } = require("./x.js");').length === 0, "import: a non-import destructuring is not an import site");
    ok(
      sites('await import(/* "wrong" */ "./x.js");')[0]?.spec === "./x.js",
      "import: a quoted pair inside a comment does not win the specifier",
    );
    ok(
      sites('import /* "wrong" */ "./x.js";')[0]?.spec === "./x.js",
      "import: …on a side-effect import either",
    );
    ok(sites('export * from "./x.js";')[0]?.whole === true, "import: `export *` takes the lot");
    ok(sites('import { a } from "./x.js";')[0]?.spec === "./x.js", "import: the specifier survives the mask");
    ok(
      sites('import { a } from "@open-everywhere/core/agent/adapter-api.js";')[0]?.spec ===
        "@open-everywhere/core/agent/adapter-api.js",
      "import: a workspace specifier survives the mask",
    );
    ok(sites('// import { a } from "./x.js";').length === 0, "import: a commented-out import is not one");
    ok(sites('const s = \'import { a } from "./x.js";\';').length === 0, "import: an import inside a string is not one");
    ok(
      sites(`${"export function f() {}\n".repeat(50)}import { a } from "./x.js";`).length === 1,
      "import: many `export` statements before an import yield exactly one site",
    );
    ok(
      sites('export const from = 1;\nexport const x = obj.from;').length === 0,
      "import: `from` as an ordinary identifier is not an import site",
    );
  }

  {
    ok(isSurface("packages/core/agent/adapter-api.ts"), "surface: adapter-api.ts");
    ok(isSurface("packages/core/agent/index.ts"), "surface: index.ts");
    ok(isSurface("packages/core/agent/contributions.ts"), "surface: contributions.ts");
    ok(!isSurface("packages/core/agent/access/config.ts"), "surface: an ordinary module is not one");
    ok(isGenerated("packages/core/agent/docs/generated/root.ts"), "generated: a `generated/` directory");
    ok(isGenerated("packages/core/agent/x.generated.ts"), "generated: a `.generated.ts` suffix");
    ok(isGenerated("packages/core/agent/docs-generated.ts"), "generated: `docs-generated.ts`");
    ok(!isGenerated("packages/core/agent/access/config.ts"), "generated: an ordinary module is not");
    ok(reexportsStar('export * from "./x.js";'), "star: an `export *` is seen");
    ok(!reexportsStar('export { a } from "./x.js";'), "star: a named re-export is not one");
    ok(!reexportsStar('/*\nexport * from "./x.js";\n*/'), "star: not one at line start in a BLOCK comment");
    ok(!reexportsStar('const t = `\nexport * from "./x.js";\n`;'), "star: not one at line start in a TEMPLATE");
  }

  {
    const verdict = auditExportReach(root);
    ok(verdict.reds.length === 0, `the tree is green: ${verdict.reds.slice(0, 5).join(" | ")}`);
    ok(verdict.scanned > 500, `the scan reaches the tree — ${verdict.scanned} modules`);
    ok(verdict.exports > 1000, `…and its exports — ${verdict.exports} value exports`);
    ok(verdict.importers > 1500, `…and the importer sweep — ${verdict.importers} files`);
    const pinned: string[] = [];
    const keys = [...KNOWN_UNREACHED_EXPORTS.keys()].sort();
    ok(
      keys.length === pinned.length && keys.every((k, n) => k === pinned[n]),
      `the baseline is exactly the pinned keeps — it holds ${keys.length}: ${keys.join(", ")}`,
    );
    ok(verdict.carried <= KNOWN_UNREACHED_EXPORTS.size, `carried is a subset of the baseline — ${verdict.carried}`);
    ok(verdict.ruledOn + verdict.wholesaleSkipped === verdict.scanned, "every scanned module is either ruled on or counted as skipped");
    ok(verdict.wholesaleSkipped > 0, `the wholesale skip is real and counted — ${verdict.wholesaleSkipped} module(s)`);
    ok(verdict.ruledOn < verdict.scanned, "…so the rule reaches fewer modules than it scans");
  }

  {
    const stale = staleBaselineEntries(new Set(["a/b.ts::c"]), new Set());
    ok(stale.length === 1, "ratchet: an entry the tree no longer owes is reported");
    ok(stale[0]!.includes("a/b.ts::c"), "ratchet: …by name");
    ok(stale[0]!.includes("may only shrink"), "ratchet: …and the message says what to do");
    ok(
      staleBaselineEntries(new Set(["a/b.ts::c"]), new Set(["a/b.ts::c"])).length === 0,
      "ratchet: an entry the tree still owes is NOT reported (negative control)",
    );
    ok(staleBaselineEntries(new Set(), new Set()).length === 0, "ratchet: an empty baseline reports nothing");
  }

  {
    const tree = fixtureTree({
      "packages/core/agent/helpers.ts": `export function localHelper(n: number): number {\n  return n;\n}\nexport const seed = localHelper(1);\n`,
      "packages/core/agent/consumer.ts": `export async function load(): Promise<unknown> {\n  const m = await import("./helpers.js");\n  return m.seed;\n}\n`,
      "packages/core/agent/adapter-api.ts": `export { load } from "./consumer.js";`,
    });
    const wholesaleRun = auditExportReach(tree);
    ok(wholesaleRun.wholesaleSkipped === 1, "a module bound to one identifier by a dynamic import is skipped wholesale");
    ok(wholesaleRun.reds.length === 0, "…and nothing in it is ruled on");

    write(
      tree,
      "packages/core/agent/consumer.ts",
      `export async function load(): Promise<unknown> {\n  const { seed } = await import("./helpers.js");\n  return seed;\n}\n`,
    );
    const namedRun = auditExportReach(tree);
    ok(namedRun.wholesaleSkipped === 0, "a DESTRUCTURED dynamic import names its bindings, so nothing is skipped");
    ok(namedRun.reds.length === 1, "…and the export it does not name is reported");
    ok(namedRun.reds[0]!.includes("localHelper"), "…by name");
  }

  {
    const key = "packages/core/agent/a.ts::b";
    const bare = unownedBaselineEntries(new Map([[key, ""]]));
    ok(bare.length === 1 && bare[0]!.includes(key), "owner: a line with no owner is reported, by name");
    ok(bare[0]!.includes("OPE-<n>: <why it is kept>"), "owner: …and the message says what to write");
    ok(unownedBaselineEntries(new Map([[key, "OPE-12"]])).length === 1, "owner: a ticket with no reason is reported");
    ok(unownedBaselineEntries(new Map([[key, "keep it: an out-of-tree consumer"]])).length === 1, "owner: a reason with no ticket is reported");
    ok(
      unownedBaselineEntries(new Map([[key, "OPE-12: an out-of-tree consumer reads it"]])).length === 0,
      "owner: a ticket and a reason pass (negative control)",
    );
    ok(unownedBaselineEntries(new Map()).length === 0, "owner: an empty baseline reports nothing");
  }

  {
    const key = "packages/core/agent/helpers.ts::localHelper";
    const tree = fixtureTree({
      "packages/core/agent/helpers.ts": `export function localHelper(n: number): number {\n  return n;\n}\nexport const seed = localHelper(1);\n`,
      "packages/core/agent/adapter-api.ts": `export { seed } from "./helpers.js";`,
    });
    const unowned = auditExportReach(tree, { owners: new Map([[key, ""]]) });
    ok(unowned.reds.length === 1 && unowned.reds[0]!.includes("no owner"), "owner wiring: an owner-less line reds the audit");
    ok(unowned.carried === 1, "owner wiring: …while the export itself is carried by the same line");
    const owned = auditExportReach(tree, { owners: new Map([[key, "OPE-12: a fixture keep"]]) });
    ok(owned.reds.length === 0, `owner wiring: the owned line is green (negative control): ${owned.reds.join(" | ")}`);
  }

  {
    const baseline = new Set(["packages/core/agent/helpers.ts::localHelper"]);
    const tree = fixtureTree({
      "packages/core/agent/helpers.ts": `export function localHelper(n: number): number {\n  return n;\n}\nexport const seed = localHelper(1);\n`,
      "packages/core/agent/consumer.ts": `export async function load(): Promise<unknown> {\n  const { seed } = await import("./helpers.js");\n  return seed;\n}\n`,
      "packages/core/agent/adapter-api.ts": `export { load } from "./consumer.js";`,
    });
    const ruled = auditExportReach(tree, { baseline });
    ok(ruled.carried === 1, "a baseline entry on a module the rule REACHES is carried, not reported");
    ok(ruled.reds.length === 0, "…and nothing is stale");

    write(
      tree,
      "packages/core/agent/consumer.ts",
      `export async function load(): Promise<unknown> {\n  const m = await import("./helpers.js");\n  return m.seed;\n}\n`,
    );
    const skipped = auditExportReach(tree, { baseline });
    ok(skipped.wholesaleSkipped === 1, "…the module is now skipped wholesale");
    ok(skipped.carried === 0, "…so nothing is counted as carried");
    ok(skipped.reds.length === 0, "…and its baseline entry is STILL NOT reported stale — the ratchet keeps it");

    const withGhost = auditExportReach(tree, { baseline: new Set([...baseline, "packages/core/agent/ghost.ts::x"]) });
    ok(withGhost.reds.length === 1, "an entry naming a module that does not exist IS reported stale");
    ok(withGhost.reds[0]!.includes("ghost.ts::x"), "…by name");
  }

  {
    ok(unreadableExportsIn("export const a = 1, b = 2;").length === 1, "unreadable: two declarators in one statement");
    ok(unreadableExportsIn("export const { a, b } = obj;").length === 1, "unreadable: a destructured export");
    ok(unreadableExportsIn("export const [a, b] = arr;").length === 1, "unreadable: an array-destructured export");
    ok(unreadableExportsIn("export namespace N {}").length === 1, "unreadable: `export namespace`");
    ok(unreadableExportsIn("export const a = 1;").length === 0, "readable: one declarator");
    ok(unreadableExportsIn("export function f(a: string, b: number) {}").length === 0, "readable: commas in a parameter list");
    ok(
      unreadableExportsIn("export const x: Record<string, number> = {};").length === 0,
      "readable: a comma inside a GENERIC is not a second declarator",
    );
    ok(unreadableExportsIn("export const o = { a: 1, b: 2 };").length === 0, "readable: commas inside an object literal");
    ok(unreadableExportsIn("export const arr = [1, 2];").length === 0, "readable: commas inside an array literal");
    ok(unreadableExportsIn("export const f = (a: number, b: number) => a + b;").length === 0, "readable: an arrow's parameters");
    ok(unreadableExportsIn("export { a, b };").length === 0, "readable: an export list");
    ok(unreadableExportsIn("export type { A, B };").length === 0, "readable: a type export list");
    ok(unreadableExportsIn("export default function () {}").length === 0, "readable: a default export");
    ok(unreadableExportsIn('export * from "./x.js";').length === 0, "readable: `export *` has its own arm");
    ok(unreadableExportsIn("// export const a = 1, b = 2;").length === 0, "unreadable: not one inside a comment");
  }

  console.log(`\n✓ export-reach-lint: ${passed} assertions passed`);
} finally {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
}
