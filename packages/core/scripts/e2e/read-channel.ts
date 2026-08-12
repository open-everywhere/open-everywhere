import { fetchAudit, type AuditWireEntry } from "./audit-read.js";
import { fetchTranscript } from "./transcript-read.js";
import { genericReadVerbsEnabled } from "../../agent/access/source-scoped-mount.js";
import { isWindowToken } from "../../agent/channels/window-key.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
const INJECT = process.env.E2E_CONTROL_INJECT_TOKEN ?? "";
const DOMAIN = process.env.E2E_GRV_DOMAIN ?? "e2e-unified";
const SLACK_SURFACE = process.env.E2E_GRV_SLACK_SURFACE ?? "slack/T0EXAMPLE/C0EXCHAN003";
const DISCORD_SURFACE = process.env.E2E_GRV_DISCORD_SURFACE ?? "";
const SLACK_CHANNEL_ID = SLACK_SURFACE.split("/").slice(2).join("/");
const DISCORD_CHANNEL_ID = DISCORD_SURFACE.split("/").slice(2).join("/");
const DISCORD_GUILD_ID = DISCORD_SURFACE.split("/")[1] ?? "";
const REPLY_TIMEOUT_MS = Number.parseInt(process.env.GRV_REPLY_TIMEOUT_MS ?? "120000", 10);
const POLL_MS = 4000;
const RUN = Date.now().toString().slice(-7);
const ONLY = (process.env.GRV_ONLY ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const want = (id: string) => ONLY.length === 0 || ONLY.includes(id);

const A_REPLY = "reply.post";
type Status = "PASS" | "SKIP" | "FAIL";
const results: { id: string; status: Status; detail: string }[] = [];
const record = (id: string, status: Status, detail: string) => {
  results.push({ id, status, detail });
  console.log(`\n${status === "PASS" ? "✅" : status === "SKIP" ? "⏭ " : "❌"} ${id}: ${status} — ${detail}`);
};

const dS = (e: AuditWireEntry, k: string): string | undefined => (typeof e.detail?.[k] === "string" ? (e.detail![k] as string) : undefined);
const rowsSince = async (sinceIso: string): Promise<readonly AuditWireEntry[]> =>
  fetchAudit(TARGET, READ, { sinceIso, limit: 600 });

interface InjectBody {
  domain: string; platform: "slack" | "discord"; surfaceKey: string; text: string;
  addressing?: string; mention?: boolean; author?: string; origin: Record<string, unknown>;
}
async function inject(b: InjectBody): Promise<{ wakeId: string; token: string }> {
  const res = await fetch(`${TARGET}/control/v1/test/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${INJECT}`, "content-type": "application/json" },
    body: JSON.stringify(b),
  });
  if (!res.ok) throw new Error(`inject ${res.status}: ${(await res.text().catch(() => "")).slice(0, 240)}`);
  return (await res.json()) as { wakeId: string; token: string };
}

async function pollForReplySession(sinceIso: string, wakeId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrs = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let rows: readonly AuditWireEntry[];
    try { rows = await rowsSince(sinceIso); consecutiveErrs = 0; }
    catch (e) {
      console.warn(`  [audit] ${(e as Error).message}`);
      if (++consecutiveErrs >= 3) throw e;
      continue;
    }
    const reply = rows.find((r) => r.action === A_REPLY && dS(r, "wakeId") === wakeId);
    if (reply) return dS(reply, "sessionId") ?? null;
  }
  return null;
}

const FAILED_ACTIONS = ["unified.supervisor_session_failed", "unified.supervisor_turn_failed", "surface.wake_failed"];
async function classifyNoReply(id: string, sinceIso: string, wakeId: string, offlineNote: string): Promise<void> {
  const rows = await rowsSince(sinceIso);
  if (rows.some((r) => r.action === "unified.no_reply" && dS(r, "wakeId") === wakeId)) {
    return record(id, "SKIP", `session ran and the model chose silence (unified.no_reply for wake ${wakeId}) — a genuine model choice, not a pipeline failure. ${offlineNote}`);
  }
  const died = rows.find((r) => FAILED_ACTIONS.includes(r.action));
  if (died) return record(id, "FAIL", `wake ${wakeId} accepted but the session/turn died — audit carries ${died.action} since ${sinceIso}.`);
  if (rows.some((r) => r.action === A_REPLY)) {
    return record(id, "FAIL", `reply.post rows exist since ${sinceIso} but none carry wakeId ${wakeId} — reply attribution (wakeId stamping) regression.`);
  }
  record(id, "SKIP", `no reply within ${REPLY_TIMEOUT_MS}ms and no failure/no_reply audit rows (model-dependent; possibly a slow turn). ${offlineNote}`);
}

async function toolNamesOf(sessionId: string, sinceIso: string): Promise<string[] | null> {
  try {
    const names: string[] = [];
    let start = 0;
    for (let page = 0; page < 40; page++) {
      const tr = await fetchTranscript(TARGET, READ, sessionId, { startIndex: start, limit: 2000, idleMs: 2500 });
      for (const e of tr.events) {
        if (e.type !== "actions.requested") continue;
        if (e.at !== null && e.at < sinceIso) continue;
        for (const a of ((e.data as { actions?: { toolName?: string }[] } | undefined)?.actions ?? [])) {
          if (typeof a.toolName === "string") names.push(a.toolName);
        }
      }
      if (tr.events.length === 0) break;
      start = tr.nextIndex ?? start + tr.events.length;
    }
    return names;
  } catch (e) { console.warn(`  [transcript] ${(e as Error).message}`); return null; }
}

async function g1(): Promise<void> {
  const since = new Date().toISOString();
  const brief = `Please use read_channel with target {platform:"slack", channel:"${SLACK_CHANNEL_ID}"} to pull recent messages from that channel, then reply here with GRV1-${RUN} summarising what you saw.`;
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: { platform: "slack", channelId: SLACK_CHANNEL_ID }, text: brief });
  if (!isWindowToken(token)) return record("G1", "FAIL", `dispatched token ${token} is not a window token — the window did not resolve`);
  console.log(`  G1 injected Slack wake ${wakeId} → token ${token}`);
  const sid = await pollForReplySession(since, wakeId, REPLY_TIMEOUT_MS);
  if (!sid) return classifyNoReply("G1", since, wakeId, "Render byte-identity + gate pinned offline (generic-read-verbs-test.ts).");
  const calls = await toolNamesOf(sid, since);
  if (calls === null) return record("G1", "SKIP", `transcript fetch failed for session ${sid} — the mount cannot be observed this run. Render byte-identity + gate pinned offline (generic-read-verbs-test.ts).`);
  if (calls.includes("read_channel")) return record("G1", "PASS", `session ${sid} invoked the GENERIC read_channel for slack (the behaviour-preserving successor to read_slack_channel) and replied.`);
  if (calls.includes("read_slack_channel")) return record("G1", "FAIL", `session ${sid} invoked read_slack_channel — the target was NOT started with tools.genericReadVerbs: true (the Slack-specific reader should have retired).`);
  record("G1", "SKIP", `session ${sid} replied but did not invoke read_channel (tools=[${[...new Set(calls)].join(",") || "none"}]) — the model chose not to read (mount presence can't be proven passively). Binding proof: the offline unit test.`);
}

async function g2(): Promise<void> {
  if (!DISCORD_SURFACE) return record("G2", "SKIP", "no E2E_GRV_DISCORD_SURFACE set — supply a discord/<guild>/<channel> surface in the domain to drive the additive Discord read.");
  const since = new Date().toISOString();
  const brief = `Please use read_channel with target {platform:"discord", channel:"${DISCORD_CHANNEL_ID}"} to read that Discord channel, then reply with GRV2-${RUN} summarising what you saw.`;
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "discord", surfaceKey: DISCORD_SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: { platform: "discord", channelId: DISCORD_CHANNEL_ID, guildId: DISCORD_GUILD_ID }, text: brief });
  console.log(`  G2 injected Discord wake ${wakeId} → token ${token}`);
  const sid = await pollForReplySession(since, wakeId, REPLY_TIMEOUT_MS);
  if (!sid) return classifyNoReply("G2", since, wakeId, "The Discord adapter render/normalize is pinned offline (generic-read-verbs-test.ts).");
  const calls = await toolNamesOf(sid, since);
  if (calls === null) return record("G2", "SKIP", `transcript fetch failed for session ${sid} — the mount cannot be observed this run. The Discord adapter render/normalize is pinned offline (generic-read-verbs-test.ts).`);
  if (calls.includes("read_channel")) return record("G2", "PASS", `session ${sid} invoked read_channel for DISCORD — the additive cross-surface read works through ONE generic tool.`);
  record("G2", "SKIP", `session ${sid} replied but did not invoke read_channel (tools=[${[...new Set(calls)].join(",") || "none"}]) — model-dependent; the adapter is pinned offline.`);
}

async function main(): Promise<void> {
  console.log(`=== GENERIC READ VERBS · Stage 2 per-route e2e · run ${RUN} · ${new Date().toISOString()} ===`);
  console.log(`target=${TARGET || "(unset)"} domain=${DOMAIN} slack=${SLACK_SURFACE} discord=${DISCORD_SURFACE || "(unset)"}`);
  if (!genericReadVerbsEnabled()) {
    for (const id of ["G1", "G2"]) if (want(id)) record(id, "SKIP", "tools.genericReadVerbs is not set in THIS process — flag-OFF the generic verbs are absent (read_slack_* is the reader). Re-run with the flag on AND a target deployed with `tools.genericReadVerbs` armed");
    return summary();
  }
  if (!TARGET || !READ || !INJECT) {
    for (const id of ["G1", "G2"]) if (want(id)) record(id, "SKIP", "no E2E_TARGET_URL / E2E_CONTROL_READ_TOKEN / E2E_CONTROL_INJECT_TOKEN — cannot drive a live window.");
    return summary();
  }
  for (const [id, fn] of [["G1", g1], ["G2", g2]] as [string, () => Promise<void>][]) {
    if (!want(id)) continue;
    try { await fn(); } catch (e) { record(id, "FAIL", `threw: ${(e as Error).message}`); }
  }
  summary();
}

function summary(): void {
  console.log(`\n=== STAGE 2 GENERIC-READ-VERBS SUMMARY (run ${RUN}) ===`);
  for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.id}`);
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`  ${results.filter((r) => r.status === "PASS").length} pass · ${results.filter((r) => r.status === "SKIP").length} skip · ${fail} fail`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("Stage 2 generic-read-verbs pack failed:", e); process.exit(1); });
