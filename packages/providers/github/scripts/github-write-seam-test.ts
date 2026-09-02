import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("github write seam (OPE-1235):");

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEAM_REL = "agent/channels/github-post-arm.ts";
const SEAM = join(PKG_ROOT, SEAM_REL);

const BARE_FETCH = /(?<![.\w])fetch\s*\(/;
const OWN_TRANSPORT = /globalThis\.fetch/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

{
  ok(BARE_FETCH.test(stripComments("const res = await fetch(url);")), "§0 the bare-fetch matcher DOES match a real direct call");
  ok(BARE_FETCH.test(stripComments("const res = await  fetch  (url);")), "§0 …and is not fooled by whitespace before the paren");
  ok(!BARE_FETCH.test(stripComments("// const res = await fetch(url);\n")), "§0 …and a commented-out call is NOT an offender");
  ok(!BARE_FETCH.test(stripComments("/** prose naming fetch(url) */\nconst x = 1;")), "§0 …nor is prose in a block comment");
  ok(!BARE_FETCH.test(stripComments("const res = await githubWrite(input);")), "§0 …nor is a call to the funnel itself");
  ok(!BARE_FETCH.test(stripComments("const res = await deps.fetch(url, init);")), "§0 …nor is a call through an injected seam");
  ok(!BARE_FETCH.test(stripComments("const raw = await fetchIssue(fn, token, target);")), "§0 …nor is a helper whose name merely starts with fetch");

  ok(OWN_TRANSPORT.test(stripComments("const base = globalThis.fetch as GitHubFetchLike;")), "§0 the own-transport matcher DOES match a module reaching for the global");
  ok(!OWN_TRANSPORT.test(stripComments("// globalThis.fetch is what this module wraps\n")), "§0 …and prose about it is not a transport");
}

const AGENT_FILES = tsFiles(join(PKG_ROOT, "agent"));
const seamCode = stripComments(readFileSync(SEAM, "utf8"));

{
  ok(/export async function githubWrite\(/.test(seamCode), "§1 the funnel `githubWrite` is still exported from the seam");
  ok(/withRetryAfter\(send,\s*\{/.test(seamCode), "🔴 §1 the funnel still dispatches through `withRetryAfter` — remove it and every GitHub write silently loses its backoff");
  ok(/surface:\s*"github"/.test(seamCode), "§1 the retry names the github surface, so `RateLimitExhaustedError` says which vendor refused");
  ok(
    /retryForbiddenWithRetryAfter:\s*true/.test(seamCode),
    "🔴 §1 the funnel still sets `retryForbiddenWithRetryAfter` — this seam is the ONLY place in the repo that opts into GitHub's 403 spelling of a rate-limit refusal (OPE-1256). Drop the flag and the whole delivered behaviour is gone with every other suite still green.",
  );
}

{
  const EXPECTED_OPERATIONS = ["issues.createComment", "issues.updateComment", "issues.createReaction"];
  const calls = [...seamCode.matchAll(/githubWrite\(\{\s*operation:\s*"([^"]+)"/g)].map((m) => m[1]);
  eq(
    calls.slice().sort(),
    EXPECTED_OPERATIONS.slice().sort(),
    "§2 exactly the three GitHub writes dispatch through the funnel — a new one that does not, or a lost one, reds here",
  );
  eq(new Set(calls).size, calls.length, "§2 each write carries a DISTINCT route name, so an exhaustion failure says which write it was");
}

{
  const offenders: string[] = [];
  for (const file of AGENT_FILES) {
    if (BARE_FETCH.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(PKG_ROOT, file));
  }
  eq(offenders, [], `🔴 §3 no file in the GitHub agent tree may call the global fetch directly — found ${offenders.length}: ${offenders.join(", ")}`);
}

{
  const KNOWN_TRANSPORTS: ReadonlyArray<{ file: string; covered: boolean; why: string }> = [
    { file: SEAM_REL, covered: true, why: "the write seam itself — comment, edit and reaction, all with the 429 backoff" },
    {
      file: "agent/channels/github-read.ts",
      covered: true,
      why: "PrFetchFn — the READ-ONLY issue/PR reader. Distinct from the write path OPE-1235 covers; carries the 429 backoff via withRetryAfterLoose since OPE-1255.",
    },
  ];

  const found: string[] = [];
  for (const file of AGENT_FILES) {
    if (OWN_TRANSPORT.test(stripComments(readFileSync(file, "utf8")))) found.push(relative(PKG_ROOT, file));
  }
  eq(
    found.slice().sort(),
    KNOWN_TRANSPORTS.map((t) => t.file).sort(),
    "🔴 §4 the modules that own a GitHub transport are EXACTLY the tracked inventory — a NEW one appearing, or a listed one vanishing, reds here",
  );

  for (const entry of KNOWN_TRANSPORTS) {
    const src = stripComments(readFileSync(join(PKG_ROOT, entry.file), "utf8"));
    const wrapped = /withRetryAfter/.test(src);
    if (entry.covered) {
      ok(wrapped, `§4 \`${entry.file}\` is marked COVERED and must carry the backoff — it does not, so either the wrap was removed or the flag is wrong`);
    } else {
      ok(!wrapped, `§4 \`${entry.file}\` is marked UNCOVERED and must not carry the backoff — wrap it and mark it covered here and in docs/extending/provider-rate-limits.md`);
    }
  }
}

console.log(`  ${n} assertions passed`);
