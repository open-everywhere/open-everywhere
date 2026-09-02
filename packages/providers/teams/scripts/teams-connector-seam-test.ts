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

console.log(`  ${n} assertions passed`);
