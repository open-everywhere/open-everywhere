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

console.log("discord rest seam (OPE-1236):");

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "providers", "discord");
const SEAM_REL = "agent/channels/discord-rest.ts";
const COVERED_WRITE_FILES = [
  "agent/channels/discord-post.ts",
  "agent/channels/discord-message-ops.ts",
  "agent/channels/discord-gateway.ts",
] as const;

const BARE_FETCH = /(?<![.\w])fetch\s*\(/;

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
  ok(!BARE_FETCH.test(stripComments("const res = await discordFetch(op, url, init);")), "§0 …nor is a call to the funnel itself");
  ok(!BARE_FETCH.test(stripComments("const base = globalThis.fetch as DiscordFetchLike;")), "§0 …nor is the seam reaching for the global through a dot");
  ok(!BARE_FETCH.test(stripComments("const info = await fetchDiscordInfo(kind, id);")), "§0 …nor a helper whose name merely starts with fetch");
}

const AGENT_FILES = tsFiles(join(PKG_ROOT, "agent"));
const seamCode = stripComments(readFileSync(join(PKG_ROOT, SEAM_REL), "utf8"));

{
  ok(/export function discordFetch\(/.test(seamCode), "§1 the funnel `discordFetch` is still exported from the seam");
  ok(/withRetryAfter\(send,\s*\{/.test(seamCode), "🔴 §1 the funnel still dispatches through `withRetryAfter` — remove it and every Discord write silently loses its backoff");
  ok(/surface:\s*DISCORD_SURFACE/.test(seamCode) && /DISCORD_SURFACE\s*=\s*"discord"/.test(seamCode), "§1 the retry names the discord surface");
  ok(/retryAfterMs:\s*\(res\)\s*=>\s*discordBodyRetryAfterMs/.test(seamCode), "🔴 §1 the funnel installs the BODY override — drop it and Discord's authoritative retry_after body field is ignored");
  ok(/res\.clone\(\)\.json\(\)/.test(seamCode), "🔴 §1 the body reader reads a CLONE — otherwise it disturbs the body the primitive must cancel");
  ok(/retry_after/.test(seamCode), "§1 the body reader reads Discord's `retry_after` field");
}

{
  const routed: Record<string, number> = {};
  for (const rel of COVERED_WRITE_FILES) {
    const code = stripComments(readFileSync(join(PKG_ROOT, rel), "utf8"));
    ok(!BARE_FETCH.test(code), `🔴 §2 ${rel} calls the global fetch directly — every write here must go through discordFetch`);
    routed[rel] = (code.match(/discordFetch\(/g) ?? []).length;
  }
  eq(routed["agent/channels/discord-post.ts"], 7, "§2 discord-post.ts routes all 7 of its calls through the seam — a lost route reds");
  eq(routed["agent/channels/discord-message-ops.ts"], 3, "§2 discord-message-ops.ts routes all 3 of its calls through the seam");
  eq(
    routed["agent/channels/discord-gateway.ts"],
    5,
    "🔴 §2 discord-gateway.ts routes ALL FIVE of its writes through the seam (OPE-1311) — the completion post-back, open-DM, typing, the reaction and the thread open. A lost route reds here.",
  );
}

{
  const KNOWN_UNCOVERED: ReadonlyArray<{ file: string; why: string }> = [
    { file: "agent/channels/discord-read.ts", why: "the channel read transport" },
    { file: "agent/channels/discord-backscroll.ts", why: "the backscroll read transport" },
    { file: "agent/channels/discord-directory.ts", why: "the directory read transport" },
    { file: "agent/channels/discord-bot-name.ts", why: "the bot-name read transport" },
  ];

  const offenders: string[] = [];
  for (const file of AGENT_FILES) {
    const rel = relative(PKG_ROOT, file);
    if (rel === SEAM_REL) continue;
    if (BARE_FETCH.test(stripComments(readFileSync(file, "utf8")))) offenders.push(rel);
  }
  eq(
    offenders.slice().sort(),
    KNOWN_UNCOVERED.map((t) => t.file).slice().sort(),
    "🔴 §3 the files calling the global fetch directly are EXACTLY the tracked inventory — a NEW one (a write that bypasses the seam) or a listed one vanishing reds here",
  );

  for (const entry of KNOWN_UNCOVERED) {
    const src = stripComments(readFileSync(join(PKG_ROOT, entry.file), "utf8"));
    ok(!/withRetryAfter/.test(src), `§3 \`${entry.file}\` is tracked UNCOVERED and must not carry the backoff — wrap it through discordFetch and move it out of this inventory (and update docs/extending/provider-rate-limits.md)`);
  }
}

console.log(`  ${n} assertions passed`);
