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
  ok(r.problems.length === 1 && r.problems[0]?.includes("not a number") === true, "3: a non-numeric capture is reported, never coerced");
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

  ok(covered.has("docs/capabilities/connectors-and-providers.md"), "8h: the connectors manual is still covered");
  ok(COUNTED_CLAIMS.some((c) => c.kind === "scalar"), "8i: at least one shipped claim checks a bare bound");
}

{
  const facts: CountedFacts = { ...FACTS, cap: 3 };
  const scalar = (over: Partial<CountedClaim> = {}): Partial<CountedClaim> => ({
    fact: "cap",
    kind: "scalar",
    pattern: String.raw`capped at (\d+) per row`,
    ...over,
  });

  const bad = run("Refunds are capped at 5 per row today.", scalar(), facts);
  ok(bad.problems.length === 1, "9a: a stated bound that differs from the constant is a problem");
  ok(bad.problems[0]?.includes("says 5") === true, "9b: the problem quotes what the document says");
  ok(bad.problems[0]?.includes("code holds 3") === true, "9c: the problem quotes the constant, not a list length");

  const good = run("Refunds are capped at 3 per row today.", scalar(), facts);
  ok(good.problems.length === 0, "9d: the same document with the right number is green");
  ok(good.checked === 1, "9e: the green reports the claim as actually evaluated, not skipped");

  const asLength = run("Refunds are capped at 3 per row today.", scalar({ fact: "roster" }), facts);
  ok(asLength.problems.length === 1, "9f: a scalar claim over a NAME LIST is a problem, even when the length matches");
  ok(asLength.problems[0]?.includes("needs a number fact") === true, "9g: the problem says the fact's shape is wrong");
}

{
  const facts: CountedFacts = { ...FACTS, cap: 3, attempts: 4 };
  const words = (pattern: string, fact: string): Partial<CountedClaim> => ({ fact, kind: "scalar", pattern });

  const cardinal = run("It admits at most four sessions.", words(String.raw`at most (\w+) sessions`, "attempts"), facts);
  ok(cardinal.problems.length === 0, "10a: a cardinal word that states the constant is green");

  const cardinalWrong = run("It admits at most five sessions.", words(String.raw`at most (\w+) sessions`, "attempts"), facts);
  ok(cardinalWrong.problems.length === 1 && cardinalWrong.problems[0]?.includes("says 5") === true, "10b: the WRONG cardinal word is red, and the problem reports its value");

  const ordinal = run("The fourth refund is refused.", words(String.raw`The (\w+) refund is refused`, "attempts"), facts);
  ok(ordinal.problems.length === 0, "10c: an ordinal word resolves to the same value as its cardinal");

  const ordinalWrong = run("The third refund is refused.", words(String.raw`The (\w+) refund is refused`, "attempts"), facts);
  ok(ordinalWrong.problems.length === 1 && ordinalWrong.problems[0]?.includes("says 3") === true, "10d: the WRONG ordinal word is red");

  const tooBig = run("It admits at most nineteen sessions.", words(String.raw`at most (\w+) sessions`, "attempts"), facts);
  ok(tooBig.problems.length === 1 && tooBig.problems[0]?.includes("not a number") === true, "10e: a number word past the supported range is reported, not coerced");

  const asCount = run("The seat holds three tools today.", { pattern: String.raw`holds (\w+) tools` }, facts);
  ok(asCount.problems.length === 0, "10f: a count claim reads a number word as well");
}

{
  const facts: CountedFacts = { ...FACTS, cap: 3 };

  const asCount = run("The seat holds 3 tools today.", { fact: "cap" }, facts);
  ok(asCount.problems.length === 1, "11a: a count claim over a number fact is a problem, even when the number matches");
  ok(asCount.problems[0]?.includes("needs a name-list fact") === true, "11b: the problem says a bound holds no members to count");

  const asNames = run("The roster is exactly: `reply`.", { fact: "cap", kind: "names", pattern: String.raw`exactly: ([^.]+)\.` }, facts);
  ok(asNames.problems.length === 1 && asNames.problems[0]?.includes("needs a name-list fact") === true, "11c: a names claim over a number fact is the same problem");
}

console.log(
  `✓ counted-claims: ${passed} assertions — a drifted count, name list or bound fails, a number word reads as its value, ` +
    `and a claim that stops matching its prose fails rather than passing silently`,
);
