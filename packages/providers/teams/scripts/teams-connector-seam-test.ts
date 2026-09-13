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

console.log("teams connector seam (OPE-1298):");

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEAM_REL = "agent/channels/teams-connector.ts";
const SEAM = join(PKG_ROOT, SEAM_REL);

const BARE_CONNECTOR_CALL = /(?<![.\w])callTeamsConnectorApi\s*\(/;
const CONNECTOR_WRITE_METHOD = /method:\s*"(?:POST|PUT|PATCH|DELETE)"/;
const EVE_ACTIVITY_WRITER = /(?<![.\w])(?:sendTeamsActivity|replyToTeamsActivity|updateTeamsActivity)\s*[(,}]/;
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
  ok(
    BARE_CONNECTOR_CALL.test(stripComments(`const res = await callTeamsConnectorApi({ serviceUrl, path });`)),
    "§0 the bare-connector matcher DOES match a real direct call",
  );
  ok(BARE_CONNECTOR_CALL.test(stripComments(`await callTeamsConnectorApi  ({ x });`)), "§0 …and is not fooled by whitespace before the paren");
  ok(!BARE_CONNECTOR_CALL.test(stripComments("// await callTeamsConnectorApi({ x });\n")), "§0 …and a commented-out call is NOT an offender");
  ok(!BARE_CONNECTOR_CALL.test(stripComments("/** prose naming callTeamsConnectorApi({}) */\nconst x = 1;")), "§0 …nor is prose in a block comment");
  ok(!BARE_CONNECTOR_CALL.test(stripComments("await deps.callTeamsConnectorApi({ x });")), "§0 …nor is a call through an injected seam");

  ok(CONNECTOR_WRITE_METHOD.test(stripComments(`await x({ path, method: "POST" });`)), "🔴 §0 the write-method matcher DOES match a POST");
  ok(CONNECTOR_WRITE_METHOD.test(stripComments(`await x({ path, method: "DELETE" });`)), "🔴 §0 …and a DELETE");
  ok(CONNECTOR_WRITE_METHOD.test(stripComments(`await x({ path, method: "PUT" });`)), "🔴 §0 …and a PUT");
  ok(!CONNECTOR_WRITE_METHOD.test(stripComments(`await x({ path, method: "GET" });`)), "§0 …and a GET is NOT a write");
  ok(!CONNECTOR_WRITE_METHOD.test(stripComments("await x({ path, method: verb });")), "🔴 §0 a method passed as a VARIABLE is NOT seen — the matcher reads literals only");
  ok(!CONNECTOR_WRITE_METHOD.test(stripComments("await x({ path, method: `POST` });")), "🔴 §0 …nor a TEMPLATE literal");
  ok(!CONNECTOR_WRITE_METHOD.test(stripComments("await x({ path, ...writeOpts });")), "🔴 §0 …nor a spread that carries the method");
  ok(!CONNECTOR_WRITE_METHOD.test(stripComments(`await x({ path, method: "post" });`)), "🔴 §0 …nor a lowercase spelling");

  ok(EVE_ACTIVITY_WRITER.test(stripComments(`await sendTeamsActivity({ x });`)), "§0 the eve-activity-writer matcher DOES match a direct call");
  ok(EVE_ACTIVITY_WRITER.test(stripComments(`import { updateTeamsActivity } from "eve/channels/teams";`)), "§0 …and an import of one");
  ok(!EVE_ACTIVITY_WRITER.test(stripComments(`await sendTeamsActivityBackedOff({ x });`)), "🔴 §0 …and the BACKED-OFF wrapper is not an offender — this is the line that decides whether the gate is usable at all");
  ok(!EVE_ACTIVITY_WRITER.test(stripComments("// sendTeamsActivity is what this wraps\n")), "§0 …nor is prose about one");

  ok(BARE_FETCH.test(stripComments("const res = await fetch(url);")), "§0 the bare-fetch matcher DOES match a real direct call");
  ok(BARE_FETCH.test(stripComments("const res = await  fetch  (url);")), "§0 …and is not fooled by whitespace before the paren");
  ok(
    BARE_FETCH.test(stripComments("const res = await fetch(`${serviceUrl}/v3/conversations/${id}/activities`, { method: \"POST\" });")),
    "🔴 §0 …and it matches the shape §5 exists for: a raw Connector write to a serviceUrl, which names neither `callTeamsConnectorApi` nor an eve activity writer",
  );
  ok(!BARE_FETCH.test(stripComments("// const res = await fetch(url);\n")), "§0 …and a commented-out call is NOT an offender");
  ok(!BARE_FETCH.test(stripComments("/** prose naming fetch(url) */\nconst x = 1;")), "§0 …nor is prose in a block comment");
  ok(!BARE_FETCH.test(stripComments("const res = await deps.fetch(url, init);")), "§0 …nor is a call through an injected seam");
  ok(!BARE_FETCH.test(stripComments("const r = await fetchRoster(token, target);")), "§0 …nor is a helper whose name merely starts with fetch");

  ok(OWN_TRANSPORT.test(stripComments("const base = globalThis.fetch as TeamsFetchLike;")), "§0 the own-transport matcher DOES match a module reaching for the global");
  ok(!OWN_TRANSPORT.test(stripComments("// globalThis.fetch is what this seam wraps\n")), "§0 …and prose about it is not a transport");
}

const AGENT_FILES = tsFiles(join(PKG_ROOT, "agent"));
const seamCode = stripComments(readFileSync(SEAM, "utf8"));

{
  ok(/export async function teamsConnectorWrite\(/.test(seamCode), "§1 the funnel `teamsConnectorWrite` is still exported from the seam");
  ok(
    /withRetryAfter\(send,\s*\{/.test(seamCode),
    "🔴 §1 the funnel still dispatches through `withRetryAfter` — remove it and every Teams Connector write silently loses its backoff",
  );
  ok(/surface:\s*"teams"/.test(seamCode), "§1 the retry names the teams surface, so `RateLimitExhaustedError` says which vendor refused");
}

{
  const EXPECTED_OPERATIONS = ["conversations.activities.send", "conversations.activities.reply", "conversations.activities.update"];
  const calls = [...seamCode.matchAll(/operation:\s*"([^"]+)"/g)].map((m) => m[1]);
  eq(
    calls.slice().sort(),
    EXPECTED_OPERATIONS.slice().sort(),
    "§2 exactly the three activity writes name a route through the funnel — a new one that does not, or a lost one, reds here",
  );
  eq(new Set(calls).size, calls.length, "§2 each write carries a DISTINCT route name, so an exhaustion failure says which write it was");
}

{
  const KNOWN_DIRECT_CALLERS: ReadonlyArray<{ file: string; why: string }> = [
    {
      file: "agent/channels/teams-roster.ts",
      why: "the app-token roster probe — a GET. Reads a conversation's member record; no write, so no lost write, but no backoff either.",
    },
    {
      file: "agent/channels/teams-directory.ts",
      why: "the conversation-member directory read — a GET, same posture as the roster probe.",
    },
    {
      file: "agent/channels/teams-graph-team-id.ts",
      why: "the team-details read that maps the Connector's team id onto the Microsoft 365 group id Graph takes (OPE-1808) — a GET. Cached per team, so a RESOLVED team costs one uncovered read per process; a team that does not resolve is re-read on every wake, because a failure is deliberately never cached.",
    },
  ];

  const found: string[] = [];
  for (const file of AGENT_FILES) {
    if (file === SEAM) continue;
    if (BARE_CONNECTOR_CALL.test(stripComments(readFileSync(file, "utf8")))) found.push(relative(PKG_ROOT, file));
  }
  eq(
    found.slice().sort(),
    KNOWN_DIRECT_CALLERS.map((c) => c.file).sort(),
    "🔴 §3 the files calling eve's `callTeamsConnectorApi` directly are EXACTLY the tracked inventory — a NEW one appearing (a Connector call with no backoff), or a listed one vanishing (the inventory going stale), reds here",
  );

  for (const entry of KNOWN_DIRECT_CALLERS) {
    const src = stripComments(readFileSync(join(PKG_ROOT, entry.file), "utf8"));
    ok(
      !CONNECTOR_WRITE_METHOD.test(src),
      `🔴 §3 \`${entry.file}\` calls eve's Connector client directly and must stay READ-ONLY — it now carries a double-quoted uppercase write-method literal, so a Teams Connector WRITE is bypassing the 429 backoff. Route it through \`teamsConnectorWrite\` (agent/channels/teams-connector.ts) instead.`,
    );
    ok(
      BARE_CONNECTOR_CALL.test(src),
      `§3 \`${entry.file}\` is listed as a direct caller and must actually be one — if the call moved to the seam, drop the entry here and in docs/extending/provider-rate-limits.md`,
    );
  }
}

{
  const offenders: string[] = [];
  for (const file of AGENT_FILES) {
    if (file === SEAM) continue;
    if (EVE_ACTIVITY_WRITER.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(PKG_ROOT, file));
  }
  eq(
    offenders,
    [],
    `🔴 §4 no file may call or import eve's \`sendTeamsActivity\`/\`replyToTeamsActivity\`/\`updateTeamsActivity\` directly — those are the writes the backed-off wrappers replace. Found ${offenders.length}: ${offenders.join(", ")}`,
  );
  ok(
    !EVE_ACTIVITY_WRITER.test(seamCode),
    "🔴 §4 the seam itself does the Connector fetch host-side and must not fall back to eve's activity writers — eve's client discards the response headers, so a `Retry-After` cannot be read through it at all",
  );
}

{
  const KNOWN_TRANSPORTS: ReadonlyArray<{ file: string; route: "bare" | "global"; why: string }> = [
    {
      file: SEAM_REL,
      route: "global",
      why: "the Connector write seam itself — it does the Connector fetch host-side because eve's client discards the response headers a 429 backoff has to read.",
    },
    {
      file: "agent/channels/teams-read.ts",
      route: "bare",
      why: "Microsoft GRAPH: `mintTeamsGraphTokenOnce` (the client-credentials token) and `liveTeamsGraphRequest` (the Graph read). A different vendor API with a different rate-limit contract — nothing here claims a backoff for it.",
    },
    {
      file: "agent/ops.ts",
      route: "bare",
      why: "Microsoft GRAPH: `mintGraphTokenFromEnv`, the ops CLI's own token mint. Same vendor and same posture as teams-read.ts.",
    },
  ];

  const found: string[] = [];
  for (const file of AGENT_FILES) {
    const src = stripComments(readFileSync(file, "utf8"));
    if (BARE_FETCH.test(src) || OWN_TRANSPORT.test(src)) found.push(relative(PKG_ROOT, file));
  }
  eq(
    found.slice().sort(),
    KNOWN_TRANSPORTS.map((t) => t.file).sort(),
    "🔴 §5 the modules reaching the global fetch are EXACTLY the tracked inventory — a NEW one appearing (which is how a raw Connector write to a serviceUrl would arrive, naming neither `callTeamsConnectorApi` nor an eve activity writer), or a listed one vanishing (the inventory going stale), reds here",
  );

  for (const entry of KNOWN_TRANSPORTS) {
    const src = stripComments(readFileSync(join(PKG_ROOT, entry.file), "utf8"));
    const bare = BARE_FETCH.test(src);
    const global = OWN_TRANSPORT.test(src);
    if (entry.route === "bare") {
      ok(bare, `§5 \`${entry.file}\` is tracked as a BARE-fetch transport and must still hold one — if the call moved behind a seam, drop the entry here`);
      ok(!global, `§5 \`${entry.file}\` is tracked as a BARE-fetch transport and must not ALSO reach globalThis.fetch — a second route needs its own entry`);
    } else {
      ok(global, `§5 \`${entry.file}\` is tracked as a globalThis.fetch transport and must still hold one`);
      ok(!bare, `§5 \`${entry.file}\` is tracked as a globalThis.fetch transport and must not ALSO call the global directly — the seam's whole point is one injectable transport`);
    }
  }

  ok(!BARE_FETCH.test(stripComments("await deps.fetch(url);")) && !OWN_TRANSPORT.test(stripComments("await deps.fetch(url);")),
    "🔴 §5 a call through an INJECTED fetch is seen by neither matcher — the inventory bounds new transports, not every HTTP call");
  const trackedGraphSource = stripComments(readFileSync(join(PKG_ROOT, "agent/channels/teams-read.ts"), "utf8"));
  ok(
    CONNECTOR_WRITE_METHOD.test(trackedGraphSource),
    "🔴 §5 a tracked Graph transport ALREADY carries a write-method literal (its token mint POSTs) — which is why §5 cannot scan the tracked modules for one",
  );
}

console.log(`  ${n} assertions passed`);
