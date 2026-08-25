import { COUNTED_CLAIMS, COUNTED_FACT_KEYS, checkCountedClaims, type CountedClaim, type CountedFacts } from "../agent/docs/counted-claims.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const FACTS: CountedFacts = { roster: ["reply", "react", "agent"], other: ["a", "b"] };

const docMap = (text: string, path = "docs/x.md") => new Map([[path, text]]);
const claim = (over: Partial<CountedClaim> = {}): CountedClaim => ({
  id: "x/claim",
  doc: "docs/x.md",
  fact: "roster",
  kind: "count",
  pattern: String.raw`holds (\d+) tools`,
  ...over,
});
const run = (text: string, over: Partial<CountedClaim> = {}, facts: CountedFacts = FACTS) =>
  checkCountedClaims({ facts, docs: docMap(text), claims: [claim(over)] });

{
  const bad = run("The seat holds 17 tools today.");
  ok(bad.problems.length === 1, "1a: a stated count that differs from the fact's length is a problem");
  ok(bad.problems[0]?.includes("says 17") === true, "1b: the problem quotes what the document says");
  ok(bad.problems[0]?.includes("code holds 3") === true, "1c: the problem quotes what the code holds");

  const good = run("The seat holds 3 tools today.");
  ok(good.problems.length === 0, "1d: the same document with the right number is green");
  ok(good.checked === 1, "1e: the green reports the claim as actually evaluated, not skipped");
}

{
  const names = (over: Partial<CountedClaim> = {}) => ({ kind: "names" as const, pattern: String.raw`exactly: ([^.]+)\.`, ...over });

  const missing = run("The roster is exactly: `reply`, `react`.", names());
  ok(missing.problems.length === 1, "2a: a list that omits a name the code holds is a problem");
  ok(missing.problems[0]?.includes('missing "agent"') === true, "2b: the problem names the omitted member — the OPE-1146 defect");

  const invented = run("The roster is exactly: `reply`, `react`, `agent`, `bash`.", names());
  ok(invented.problems.length === 1, "2c: a list that invents a name the code does not hold is a problem");
  ok(invented.problems[0]?.includes('"bash"') === true, "2d: the problem names the invented member");

  const good = run("The roster is exactly: `reply`, `react`, `agent`.", names());
  ok(good.problems.length === 0, "2e: the exact members are green");

  const reordered = run("The roster is exactly: `agent`, `reply`, `react`.", names());
  ok(reordered.problems.length === 0, "2f: the same members in another order stay green");
}

{
  const r = run("The seat holds many tools today.", { pattern: String.raw`holds (\w+) tools` });
  ok(r.problems.length === 1 && r.problems[0]?.includes("not an integer") === true, "3: a non-integer capture is reported, never coerced");
}

{
  const r = run("The seat carries a roster of 3 verbs today.");
  ok(r.problems.length === 1, "4a: a claim that matches nothing is a problem, not a skip");
  ok(r.problems[0]?.includes("no longer appears") === true, "4b: the problem says the promise could not be found");
  ok(r.problems[0]?.includes("counted-claims.ts") === true, "4c: the problem points the author at the registry to fix");
  ok(r.checked === 0, "4d: an unmatched claim is NOT counted as checked — the green line cannot overstate coverage");
}

{
  const r = run("The seat holds 3 tools today. Elsewhere: it holds 3 tools as well.");
  ok(r.problems.length === 1, "5a: two matches is a problem even when BOTH copies are correct");
  ok(r.problems[0]?.includes("matches 2 times") === true, "5b: the problem says how many times it matched");
}

{
  const unknown = run("The seat holds 3 tools today.", { fact: "nope" });
  ok(unknown.problems.length === 1 && unknown.problems[0]?.includes("unknown fact") === true, "6a: a claim citing an unknown fact is a problem");

  const missingDoc = checkCountedClaims({ facts: FACTS, docs: new Map(), claims: [claim()] });
  ok(missingDoc.problems.length === 1 && missingDoc.problems[0]?.includes("was not read") === true, "6b: a claim whose document is absent is a problem");

  const twoGroups = run("The seat holds 3 tools today.", { pattern: String.raw`(holds) (\d+) tools` });
  ok(twoGroups.problems.length === 1 && twoGroups.problems[0]?.includes("2 capture groups") === true, "6c: a pattern with the wrong group count is a problem");

  const noGroups = run("The seat holds 3 tools today.", { pattern: String.raw`holds \d+ tools` });
  ok(noGroups.problems.length === 1 && noGroups.problems[0]?.includes("0 capture groups") === true, "6d: a pattern with no group is a problem");

  const dupes = checkCountedClaims({ facts: FACTS, docs: docMap("The seat holds 3 tools today."), claims: [claim(), claim()] });
  ok(dupes.problems.length === 1 && dupes.problems[0]?.includes("duplicate claim id") === true, "6e: two claims sharing an id is a problem");
}

{
  const r = checkCountedClaims({
    facts: FACTS,
    docs: docMap("The seat holds 17 tools today."),
    claims: [claim({ id: "sample/one" })],
  });
  ok(r.problems[0]?.startsWith("sample/one (docs/x.md):") === true, "7: a problem leads with `<id> (<doc>)`");
}

{
  ok(COUNTED_CLAIMS.length > 0, "8a: the shipped registry is not empty");

  const ids = COUNTED_CLAIMS.map((c) => c.id);
  ok(new Set(ids).size === ids.length, "8b: every shipped claim id is unique");

  const declared = new Set<string>(COUNTED_FACT_KEYS);
  const undeclared = COUNTED_CLAIMS.filter((c) => !declared.has(c.fact)).map((c) => c.id);
  ok(undeclared.length === 0, `8c: every shipped claim cites a declared fact key (offenders: ${undeclared.join(", ") || "none"})`);

  const badPattern = COUNTED_CLAIMS.filter((c) => {
    try {
      return ((new RegExp(`${c.pattern}|`).exec("")?.length ?? 1) - 1) !== 1;
    } catch {
      return true;
    }
  }).map((c) => c.id);
  ok(badPattern.length === 0, `8d: every shipped pattern compiles with exactly one capture group (offenders: ${badPattern.join(", ") || "none"})`);

  const covered = new Set(COUNTED_CLAIMS.map((c) => c.doc));
  ok(covered.has("docs/glossary.md"), "8e: the glossary is still covered");
  ok(covered.has("AGENTS.md"), "8f: AGENTS.md is still covered");

  ok(COUNTED_CLAIMS.some((c) => c.kind === "names"), "8g: at least one shipped claim checks the name list itself");
}

console.log(`✓ counted-claims: ${passed} assertions — a drifted count or name list fails, and a claim that stops matching its prose fails rather than passing silently`);
