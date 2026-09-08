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

console.log("notion write seam (OPE-1233):");

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_SEAM_REL = "agent/channels/notion-api.ts";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const BARE_FETCH = /(?<![.\w])fetch\s*\(/;
const OWN_TRANSPORT = /globalThis\.fetch/;

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
  ok(!BARE_FETCH.test(stripComments("const res = await notionFetch(url);")), "§0 …nor is a call to the funnel itself");
  ok(!BARE_FETCH.test(stripComments("const res = await deps.fetch(url);")), "§0 …nor is a call through an injected seam");

  ok(OWN_TRANSPORT.test(stripComments("const base = globalThis.fetch as FetchLike;")), "§0 the own-transport matcher DOES match a module reaching for the global");
  ok(!OWN_TRANSPORT.test(stripComments("// globalThis.fetch is what this module wraps\n")), "§0 …and prose about it is not a transport");
}

const AGENT_FILES = tsFiles(join(PKG_ROOT, "agent"));

{
  const api = stripComments(readFileSync(join(PKG_ROOT, API_SEAM_REL), "utf8"));
  ok(/withRetryAfter\(\(\)\s*=>\s*send\(url, init\)/.test(api), "🔴 §1 `notionFetch` still dispatches through `withRetryAfter` — remove it and every Notion REST call silently loses its backoff");
  ok(/surface:\s*"notion"/.test(api), "§1 the REST funnel names the notion surface");
}

{
  const KNOWN_TRANSPORTS: ReadonlyArray<{ file: string; covered: boolean; why: string }> = [
    { file: API_SEAM_REL, covered: true, why: "notionFetch — every REST call the channel makes, reads and writes alike" },
    {
      file: "agent/memory/memory.ts",
      covered: true,
      why: "NotionClient — the memory backing's block reader AND its block appender (OPE-70). Typed over HttpFetch, not Response; both calls carry the 429 backoff via withRetryAfterLoose since OPE-1255.",
    },
  ];

  const found: string[] = [];
  for (const file of AGENT_FILES) {
    if (OWN_TRANSPORT.test(stripComments(readFileSync(file, "utf8")))) found.push(relative(PKG_ROOT, file));
  }
  eq(
    found.slice().sort(),
    KNOWN_TRANSPORTS.map((t) => t.file).sort(),
    "🔴 §2 the modules that own a Notion transport are EXACTLY the tracked inventory — a NEW one appearing, or a listed one vanishing, reds here",
  );

  for (const entry of KNOWN_TRANSPORTS) {
    const src = stripComments(readFileSync(join(PKG_ROOT, entry.file), "utf8"));
    const wrapped = /withRetryAfter/.test(src);
    if (entry.covered) {
      ok(wrapped, `§2 \`${entry.file}\` is marked COVERED and must carry the backoff — it does not, so either the wrap was removed or the flag is wrong`);
    } else {
      ok(!wrapped, `§2 \`${entry.file}\` is marked UNCOVERED and must not carry the backoff — wrap it and mark it covered here and in docs/extending/provider-rate-limits.md`);
    }
  }
}

{
  const offenders: string[] = [];
  for (const file of AGENT_FILES) {
    if (BARE_FETCH.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(PKG_ROOT, file));
  }
  eq(offenders, [], `🔴 §3 no file in the Notion agent tree may call the global fetch directly — found ${offenders.length}: ${offenders.join(", ")}`);
}

console.log(`  ${n} assertions passed`);
