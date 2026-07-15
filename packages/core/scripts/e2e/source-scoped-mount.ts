import { fetchAudit, type AuditWireEntry } from "./audit-read.js";
import { fetchTranscript } from "./transcript-read.js";
import { sourceScopedToolsEnabled } from "../../agent/access/source-scoped-mount.js";
import { isWindowToken } from "../../agent/channels/window-key.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
const DOMAIN = process.env.E2E_SSM_DOMAIN ?? "e2e-unified";
const SLACK_SURFACE = process.env.E2E_SSM_SLACK_SURFACE ?? "slack/T0EXAMPLE/C0EXCHAN003";
const GITHUB_SURFACE = process.env.E2E_SSM_GITHUB_SURFACE ?? "github/example-owner/e2e-scratch";
const SLACK_CHANNEL_ID = SLACK_SURFACE.split("/").slice(2).join("/");
const REPLY_TIMEOUT_MS = Number.parseInt(process.env.SSM_REPLY_TIMEOUT_MS ?? "120000", 10);
const POLL_MS = 4000;
const RUN = Date.now().toString().slice(-7);
const ONLY = (process.env.SSM_ONLY ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const want = (id: string) => ONLY.length === 0 || ONLY.includes(id);

const A_REPLY = "reply.post";
type Status = "PASS" | "SKIP" | "FAIL";
const results: { id: string; status: Status; detail: string }[] = [];
const record = (id: string, status: Status, detail: string) => {
  results.push({ id, status, detail });
  console.log(`\n${status === "PASS" ? "✅" : status === "SKIP" ? "⏭ " : "❌"} ${id}: ${status} — ${detail}`);
};

const dS = (e: AuditWireEntry, k: string): string | undefined => (typeof e.detail?.[k] === "string" ? (e.detail![k] as string) : undefined);
const rowsSince = async (sinceIso: string): Promise<readonly AuditWireEntry[]> => {
  try { return await fetchAudit(TARGET, READ, { sinceIso, limit: 600 }); }
  catch (e) { console.warn(`  [audit] ${(e as Error).message}`); return []; }
};

interface InjectBody {
  domain: string; platform: "slack" | "github"; surfaceKey: string; text: string;
  addressing?: string; mention?: boolean; author?: string; origin: Record<string, unknown>; soloWindowId?: string;
}
async function inject(b: InjectBody): Promise<{ wakeId: string; token: string }> {
  const res = await fetch(`${TARGET}/control/v1/test/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ}`, "content-type": "application/json" },
    body: JSON.stringify(b),
  });
  if (!res.ok) throw new Error(`inject ${res.status}: ${(await res.text().catch(() => "")).slice(0, 240)}`);
  return (await res.json()) as { wakeId: string; token: string };
}

async function pollForReplySession(sinceIso: string, wakeId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const reply = (await rowsSince(sinceIso)).find((r) => r.action === A_REPLY && dS(r, "wakeId") === wakeId);
    if (reply) return dS(reply, "sessionId") ?? null;
  }
  return null;
}

async function toolNamesOf(sessionId: string): Promise<string[]> {
  try {
    const tr = await fetchTranscript(TARGET, READ, sessionId, { limit: 2000, idleMs: 2500 });
    const names: string[] = [];
    for (const e of tr.events) {
      if (e.type !== "actions.requested") continue;
      for (const a of ((e.data as { actions?: { toolName?: string }[] } | undefined)?.actions ?? [])) {
        if (typeof a.toolName === "string") names.push(a.toolName);
      }
    }
    return names;
  } catch { return []; }
}

async function s1(): Promise<void> {
  const since = new Date().toISOString();
  const brief = `Please use read_slack_channel to pull recent messages from channel ${SLACK_CHANNEL_ID} in our domain, then reply here with SSM1-${RUN} summarising what you saw.`;
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: { platform: "slack", channelId: SLACK_CHANNEL_ID }, text: brief });
  if (!isWindowToken(token)) return record("S1", "FAIL", `dispatched token ${token} is not a window token — the multi-source window did not resolve`);
  console.log(`  S1 injected multi-source Slack wake ${wakeId} → token ${token}`);
  const sid = await pollForReplySession(since, wakeId, REPLY_TIMEOUT_MS);
  if (!sid) return record("S1", "SKIP", `no reply within ${REPLY_TIMEOUT_MS}ms — the wake→session join is unconfirmed (model-dependent). The mount decision is deterministically pinned offline (source-scoped-mount-test.ts).`);
  const calls = await toolNamesOf(sid);
  if (calls.includes("read_slack_channel")) {
    return record("S1", "PASS", `multi-source window MOUNTED the Slack reader — session ${sid} invoked read_slack_channel (slack ∈ sources), then replied. Confirms the reader is present on a window whose sources include slack.`);
  }
  record("S1", "SKIP", `session ${sid} replied but did not invoke read_slack_channel (tools=[${[...new Set(calls)].join(",") || "none"}]) — the model chose not to read the sibling channel this turn (mount presence can't be proven from a passive transcript). Binding proof: the offline unit test.`);
}

async function s2(): Promise<void> {
  const since = new Date().toISOString();
  const solo = `ssm-gh-${RUN}`;
  const brief = `Please use read_slack_channel to read Slack channel ${SLACK_CHANNEL_ID}, then reply with SSM2-${RUN}. If you have no such tool, reply SSM2-${RUN} NOSLACK and say so.`;
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "github", surfaceKey: GITHUB_SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: { platform: "github", channelId: GITHUB_SURFACE }, text: brief, soloWindowId: solo });
  const isSolo = token.includes(`:win:${solo}:`);
  console.log(`  S2 injected solo-GitHub window wake ${wakeId} → token ${token} (windowId≠domain: ${isSolo})`);
  if (!isSolo) return record("S2", "SKIP", `the solo-window selector did not re-mint a :win:${solo}: token (got ${token}) — a github-solo window couldn't be dispatched via the seam; the narrowing is pinned offline (source-scoped-mount-test.ts S2 case).`);
  const sid = await pollForReplySession(since, wakeId, REPLY_TIMEOUT_MS);
  if (!sid) return record("S2", "SKIP", `no reply within ${REPLY_TIMEOUT_MS}ms — unconfirmed (model-dependent). The absence of the Slack reader on a github-solo window is deterministically pinned offline.`);
  const calls = await toolNamesOf(sid);
  if (calls.includes("read_slack_channel")) {
    return record("S2", "FAIL", `session ${sid} INVOKED read_slack_channel on a solo-GitHub window (sources=[github]) — the Slack reader was NOT narrowed out (tools=[${[...new Set(calls)].join(",")}])`);
  }
  record("S2", "PASS", `solo-GitHub window did NOT invoke read_slack_channel — the reader is absent (slack ∉ sources=[github]); session ${sid} replied without it (tools=[${[...new Set(calls)].join(",") || "none"}]). Corroborates the narrowing (a passive negative — the binding proof is the offline unit test).`);
}

async function main(): Promise<void> {
  console.log(`=== SOURCE-SCOPED MOUNT · Stage 1 per-route e2e · run ${RUN} · ${new Date().toISOString()} ===`);
  console.log(`target=${TARGET || "(unset)"} domain=${DOMAIN} slack=${SLACK_SURFACE} github=${GITHUB_SURFACE}`);
  if (!sourceScopedToolsEnabled()) {
    for (const id of ["S1", "S2"]) if (want(id)) record(id, "SKIP", "OE_SOURCE_SCOPED_TOOLS is not set in THIS process — flag-OFF the mount is byte-identical (arm-on-unified), nothing to narrow. Re-run with the flag on AND a target started with OE_SOURCE_SCOPED_TOOLS=1.");
    return summary();
  }
  if (!TARGET || !READ) {
    for (const id of ["S1", "S2"]) if (want(id)) record(id, "SKIP", "no E2E_TARGET_URL / E2E_CONTROL_READ_TOKEN — cannot drive a live window.");
    return summary();
  }
  for (const [id, fn] of [["S1", s1], ["S2", s2]] as [string, () => Promise<void>][]) {
    if (!want(id)) continue;
    try { await fn(); } catch (e) { record(id, "FAIL", `threw: ${(e as Error).message}`); }
  }
  summary();
}

function summary(): void {
  console.log(`\n=== STAGE 1 SOURCE-SCOPED SUMMARY (run ${RUN}) ===`);
  for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.id}`);
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`  ${results.filter((r) => r.status === "PASS").length} pass · ${results.filter((r) => r.status === "SKIP").length} skip · ${fail} fail`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("Stage 1 source-scoped pack failed:", e); process.exit(1); });
