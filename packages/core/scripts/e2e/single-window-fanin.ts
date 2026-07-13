import { resolveSlack, resolveGithub, resolveLinear, resolveDiscord, resolveTeams, resolveNotionAmbient } from "./env.js";
import { SlackDriver } from "./slack-driver.js";
import { GithubDriver } from "./github-driver.js";
import { LinearDriver } from "./linear-driver.js";
import { DiscordDriver } from "./discord-driver.js";
import { TeamsDriver } from "./teams-driver.js";
import { NotionDriver } from "./notion-driver.js";
import { fetchAudit } from "./audit-read.js";
import { fetchTranscript } from "./transcript-read.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
const RUN = Date.now().toString().slice(-6);
const WAIT_MS = Number.parseInt(process.env.FANIN_WAIT_MS ?? "90000", 10);
const ONLY = (process.env.FANIN_ONLY ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const want = (s: string) => ONLY.length === 0 || ONLY.includes(s);

const tag = (surface: string) => `FANIN-${RUN}-${surface.toUpperCase()}`;

interface Ping { surface: string; tag: string; note?: string; }

async function post(): Promise<Ping[]> {
  const pings: Ping[] = [];
  const line = (s: string) => `Housekeeping note for the team — reference marker ${tag(s)}. No action needed.`;

  if (want("slack")) {
    const r = resolveSlack();
    if (r.ok) { await new SlackDriver((r as any).cfg).post(line("slack")); pings.push({ surface: "slack", tag: tag("slack") }); }
    else pings.push({ surface: "slack", tag: tag("slack"), note: `SKIP env: ${r.missing.join(",")}` });
  }
  if (want("discord")) {
    const r = resolveDiscord();
    if (r.ok) { await new DiscordDriver((r as any).cfg).post(line("discord")); pings.push({ surface: "discord", tag: tag("discord") }); }
    else pings.push({ surface: "discord", tag: tag("discord"), note: `SKIP env: ${r.missing.join(",")}` });
  }
  if (want("teams")) {
    const r = resolveTeams();
    if (r.ok) { await new TeamsDriver((r as any).cfg).postPlainRoot(line("teams")); pings.push({ surface: "teams", tag: tag("teams") }); }
    else pings.push({ surface: "teams", tag: tag("teams"), note: `SKIP env: ${r.missing.join(",")}` });
  }
  if (want("github")) {
    const r = resolveGithub();
    if (r.ok) { const g = new GithubDriver((r as any).cfg); await g.comment(g.fixtureIssue, line("github")); pings.push({ surface: "github", tag: tag("github") }); }
    else pings.push({ surface: "github", tag: tag("github"), note: `SKIP env: ${r.missing.join(",")}` });
  }
  if (want("linear")) {
    const r = resolveLinear();
    if (r.ok) {
      const l = new LinearDriver((r as any).cfg);
      const issue = await l.createIssue(`fanin ${RUN}`);
      await l.comment(issue.id, line("linear"));
      pings.push({ surface: "linear", tag: tag("linear"), note: `ambient on ${issue.identifier} (expected: memory-domain session, NOT unified)` });
    } else pings.push({ surface: "linear", tag: tag("linear"), note: `SKIP env: ${r.missing.join(",")}` });
  }
  if (want("notion")) {
    const r = resolveNotionAmbient();
    if (r.ok) {
      const n = new NotionDriver((r as any).cfg);
      const blocks = await n.pageBlocks();
      if (blocks.length) { await n.createBlockDiscussion(blocks[0], line("notion")); pings.push({ surface: "notion", tag: tag("notion") }); }
      else pings.push({ surface: "notion", tag: tag("notion"), note: "SKIP: page has no blocks" });
    } else pings.push({ surface: "notion", tag: tag("notion"), note: `SKIP env: ${r.missing.join(",")}` });
  }
  return pings;
}

async function wholeTranscriptText(sessionId: string): Promise<{ text: string; events: number; complete: boolean }> {
  let startIndex = 0, text = "", events = 0, complete = false, pages = 0;
  while (pages < 30) {
    const tr = await fetchTranscript(TARGET, READ, sessionId, { startIndex, limit: 10000, idleMs: 3000 });
    for (const e of tr.events) text += "\n" + JSON.stringify(e.data ?? {});
    events += tr.count; complete = tr.complete; startIndex = tr.nextIndex; pages++;
    if (tr.complete || tr.count === 0) break;
  }
  return { text, events, complete };
}

async function main() {
  if (!TARGET || !READ) { console.error("need E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN"); process.exit(1); }
  const startIso = new Date().toISOString();
  console.log(`=== SINGLE-WINDOW FAN-IN ${startIso} · run ${RUN} · target ${TARGET} ===\n`);

  const pings = await post();
  for (const p of pings) console.log(`  ${p.note?.startsWith("SKIP") ? "⏭ " : "→ posted"} ${p.surface.padEnd(8)} ${p.tag}${p.note ? `  (${p.note})` : ""}`);
  const active = pings.filter((p) => !p.note?.startsWith("SKIP"));
  if (active.length === 0) { console.error("\n  no surfaces available — nothing posted"); process.exit(1); }

  console.log(`\n  waiting ${Math.round(WAIT_MS / 1000)}s for ambient ingest across ${active.length} surface(s)...`);
  await sleep(WAIT_MS);

  const rows = await fetchAudit(TARGET, READ, { sinceIso: startIso, limit: 800 });
  const sidPlatforms = new Map<string, Set<string>>();
  for (const r of rows) {
    const sid = (r.detail as any)?.sessionId;
    if (typeof sid === "string" && sid) {
      if (!sidPlatforms.has(sid)) sidPlatforms.set(sid, new Set());
      sidPlatforms.get(sid)!.add(`${r.platform}.${r.action}`);
    }
  }
  console.log(`\n--- sessionIds seen in audit (${sidPlatforms.size}) ---`);
  for (const [sid, acts] of sidPlatforms) console.log(`  ${sid}  ← ${[...acts].slice(0, 6).join(", ")}${acts.size > 6 ? " …" : ""}`);
  if (sidPlatforms.size === 0) { console.error("\n  NO sessionId-stamped audit rows in the window — divert may not have fired. Dumping audit:"); for (const r of rows.slice(0, 40)) console.error(`   ${r.ts.slice(11, 19)} ${r.platform}.${r.action}`); process.exit(2); }

  const tagToSession = new Map<string, string[]>();
  for (const sid of sidPlatforms.keys()) {
    const { text, events, complete } = await wholeTranscriptText(sid);
    console.log(`\n  transcript ${sid}: ${events} events, complete=${complete}`);
    for (const p of active) {
      if (text.includes(p.tag)) {
        if (!tagToSession.has(p.tag)) tagToSession.set(p.tag, []);
        tagToSession.get(p.tag)!.push(sid);
        console.log(`    ✓ contains ${p.surface} tag ${p.tag}`);
      }
    }
  }

  console.log(`\n=== MATRIX (tag → session) ===`);
  const landedSessions = new Set<string>();
  for (const p of active) {
    const sids = tagToSession.get(p.tag) ?? [];
    sids.forEach((s) => landedSessions.add(s));
    console.log(`  ${p.surface.padEnd(8)} ${sids.length === 0 ? "✗ NOT FOUND in any session" : sids.map((s) => s.slice(0, 18) + "…").join(", ")}`);
  }

  console.log(`\n=== VERDICT ===`);
  const found = active.filter((p) => (tagToSession.get(p.tag) ?? []).length > 0);
  console.log(`  surfaces landed: ${found.length}/${active.length}`);
  console.log(`  distinct sessions holding a tag: ${landedSessions.size}`);
  if (found.length === active.length && landedSessions.size === 1) {
    console.log(`  ✅ SINGLE WINDOW PROVEN: all ${active.length} surfaces fanned into ONE eve session (${[...landedSessions][0]}).`);
  } else if (landedSessions.size === 1 && found.length > 0) {
    console.log(`  ◑ the ${found.length} landed surfaces share ONE session; ${active.length - found.length} didn't land (see matrix — expected for Linear ambient).`);
  } else {
    console.log(`  ⚠ tags spread across ${landedSessions.size} sessions — inspect the matrix (a genuine multi-session split, or paging/timing).`);
  }
}

main().catch((e) => { console.error("FAN-IN FAILED:", e); process.exit(1); });
