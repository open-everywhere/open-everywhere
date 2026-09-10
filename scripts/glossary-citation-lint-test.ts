import { CITATION, parseCitations } from "./glossary-citation-lint.js";

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

{
  const text =
    "Source: `packages/core/agent/access/roster.ts:99` (`WORKER_ONLY_TOOLS_STANDING`, 79 entries) " +
    "and `:103` (`WORKER_ONLY_TOOLS_THREAD`, 79 entries).";
  const found = parseCitations(text);
  ok(found.length === 2, `both citations parse (got ${found.length})`);
  ok(
    found[0]?.symbol === "WORKER_ONLY_TOOLS_STANDING",
    `🔴 the symbol survives a COMMA after its backtick — this is what OPE-1665 fixed (got ${JSON.stringify(found[0]?.symbol)})`,
  );
  ok(
    found[1]?.symbol === "WORKER_ONLY_TOOLS_THREAD",
    `🔴 …and so does the SECOND one on the same line — one comma-form symbol proves nothing about a parser that stops at the first (got ${JSON.stringify(found[1]?.symbol)})`,
  );
  ok(found[0]?.path === "packages/core/agent/access/roster.ts", "the first citation carries its own path");
  ok(found[1]?.path === "packages/core/agent/access/roster.ts", "the CONTINUATION `:103` carries the last path seen");
  ok(found[0]?.start === 99 && found[1]?.start === 103, "each citation keeps its own start line");
}

{
  const found = parseCitations("Source: `packages/core/agent/routines/gate.ts:12` (`evaluateRoutineGate`).");
  ok(found.length === 1 && found[0]?.symbol === "evaluateRoutineGate", "the `(`symbol`)` form with no comma is unchanged");
}

{
  const found = parseCitations("Source: `packages/core/agent/routines/gate.ts:12`.");
  ok(found.length === 1, "a citation with no parenthetical still parses");
  ok(found[0]?.symbol === undefined, "🔴 …and names NO symbol, so it falls to rule ③ as it must");
}
{
  const found = parseCitations("Source: `packages/core/agent/routines/gate.ts:12` (the standing gate).");
  ok(found[0]?.symbol === undefined, "a parenthetical carrying no backticked symbol names no symbol");
}
{
  const found = parseCitations("Source: `packages/core/agent/routines/gate.ts:12` (``).");
  ok(found[0]?.symbol === undefined, "an EMPTY backtick pair is not a symbol — declared is not named");
}

{
  const found = parseCitations("Source: `packages/core/agent/routines/gate.ts:12` (`packages/core/agent/routines/collector.ts:300`, and see the header).");
  ok(found.length === 2, `both citations are still counted, the nested one included (got ${found.length})`);
  ok(found[0]?.symbol === undefined, "🔴 the outer citation takes NO symbol — a `path:line` is not a symbol name");
  ok(found[1]?.path === "packages/core/agent/routines/collector.ts" && found[1]?.start === 300, "…and the nested citation is parsed on its own, path and line intact");
}
{
  const ranged = parseCitations("`a.ts:1` (`packages/core/b.ts:59-71`).");
  ok(ranged.length === 2 && ranged[0]?.symbol === undefined, "🔴 a nested RANGE citation is refused as a symbol too");
  const real = parseCitations("`a.ts:1` (`tool:notion__search`, the declared permission).");
  ok(real[0]?.symbol === "tool:notion__search", "the control: a real symbol carrying a colon is NOT mistaken for a citation");
}

{
  const found = parseCitations("Source: `packages/core/agent/routines/gate.ts:59-71` (`evaluateRoutineGate`, the whole body).");
  ok(found.length === 1 && found[0]?.start === 59, "a range citation reports its START line");
  ok(found[0]?.symbol === "evaluateRoutineGate", "…and a range citation keeps its comma-form symbol too");
}

{
  const found = parseCitations("It moved to `:341` last week.");
  ok(found.length === 1 && found[0]?.path === undefined, "a CONTINUATION with no earlier path carries no path");
}

{
  const found = parseCitations("`a.ts:1` and then a whole sentence about something else (`notASymbol`).");
  ok(found[0]?.symbol === undefined, "prose between the citation and a parenthetical breaks the join, as it must");
}

ok(CITATION.global === true, "the citation pattern is global — `matchAll` refuses a pattern that is not");

console.log(`\n✓ glossary-citation-lint: ${passed} assertions passed`);
