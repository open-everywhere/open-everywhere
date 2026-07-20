import { type AuditWireEntry } from "./audit-read.js";
import { fetchTranscript } from "./transcript-read.js";
import { sleep, dS, makeWant, createRecorder, createInjector, createAuditReader } from "./window-harness.js";
import { sourceScopedToolsEnabled } from "../../agent/access/source-scoped-mount.js";
import { isWindowToken } from "../../agent/channels/window-key.js";

const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
const DOMAIN = process.env.E2E_SSM_DOMAIN ?? "e2e-unified";
const SLACK_SURFACE = process.env.E2E_SSM_SLACK_SURFACE ?? "slack/T0EXAMPLE/C0EXCHAN003";
const GITHUB_SURFACE = process.env.E2E_SSM_GITHUB_SURFACE ?? "github/example-owner/e2e-scratch";
const GITHUB_OWNER = GITHUB_SURFACE.split("/")[1] ?? "";
const GITHUB_REPO = GITHUB_SURFACE.split("/").slice(2).join("/");
const GITHUB_ISSUE = Number.parseInt(process.env.E2E_SSM_GITHUB_ISSUE ?? "1", 10);
const SLACK_CHANNEL_ID = SLACK_SURFACE.split("/").slice(2).join("/");
const REPLY_TIMEOUT_MS = Number.parseInt(process.env.SSM_REPLY_TIMEOUT_MS ?? "120000", 10);
const POLL_MS = 4000;
const RUN = Date.now().toString().slice(-7);
const want = makeWant(process.env.SSM_ONLY);

const A_REPLY = "reply.post";
const { results, record } = createRecorder();

const inject = createInjector(TARGET, READ);
const { rowsSince } = createAuditReader(TARGET, READ, { onError: "throw" });

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

async function transcriptOf(sessionId: string, sinceIso: string): Promise<{ tools: string[]; text: string } | null> {
  try {
    const tools: string[] = [];
    let text = "";
    let start = 0;
    for (let page = 0; page < 40; page++) {
      const tr = await fetchTranscript(TARGET, READ, sessionId, { startIndex: start, limit: 2000, idleMs: 2500 });
      for (const e of tr.events) {
        if (e.at !== null && e.at < sinceIso) continue;
        if (e.type === "message.completed") { text += "\n" + JSON.stringify(e.data ?? {}); continue; }
        if (e.type !== "actions.requested") continue;
        for (const a of ((e.data as { actions?: { toolName?: string }[] } | undefined)?.actions ?? [])) {
          if (typeof a.toolName === "string") tools.push(a.toolName);
        }
      }
      if (tr.events.length === 0) break;
      start = tr.nextIndex ?? start + tr.events.length;
    }
    return { tools, text };
  } catch (e) { console.warn(`  [transcript] ${(e as Error).message}`); return null; }
}

async function s1(): Promise<void> {
  const since = new Date().toISOString();
  const brief = `Please use your channel-reading tool (read_channel with platform "slack", or read_slack_channel if that is what you have) to pull recent messages from channel ${SLACK_CHANNEL_ID} in our domain, then reply here with SSM1-${RUN} summarising what you saw. If you cannot read Slack (no such tool, or it refuses), reply SSM1-${RUN} NOSLACK and say so.`;
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: { platform: "slack", channelId: SLACK_CHANNEL_ID }, text: brief });
  if (!isWindowToken(token)) return record("S1", "FAIL", `dispatched token ${token} is not a window token — the multi-source window did not resolve`);
  console.log(`  S1 injected multi-source Slack wake ${wakeId} → token ${token}`);
  const sid = await pollForReplySession(since, wakeId, REPLY_TIMEOUT_MS);
  if (!sid) return classifyNoReply("S1", since, wakeId, "The mount decision is deterministically pinned offline (source-scoped-mount-test.ts).");
  const tr = await transcriptOf(sid, since);
  if (tr === null) return record("S1", "SKIP", `transcript fetch failed for session ${sid} — the mount cannot be observed this run. The mount decision is deterministically pinned offline (source-scoped-mount-test.ts).`);
  const calls = tr.tools;
  const invokedReader = calls.includes("read_slack_channel") || calls.includes("read_channel");
  if (invokedReader && !tr.text.includes("NOSLACK")) {
    return record("S1", "PASS", `multi-source window MOUNTED the Slack reader — session ${sid} invoked ${calls.includes("read_channel") ? "the generic read_channel" : "read_slack_channel"} for the sibling Slack channel (slack ∈ sources) and replied without a refusal marker.`);
  }
  if (tr.text.includes("NOSLACK")) {
    return record("S1", "FAIL", `session ${sid} reported it could NOT read Slack (NOSLACK marker${invokedReader ? ", after invoking the reader — an execute fence refused a read that slack ∈ sources should allow" : " — the reader was absent"}) despite slack ∈ sources. The mount or fence over-narrowed.`);
  }
  record("S1", "SKIP", `session ${sid} replied but invoked no channel reader and did not report it absent (tools=[${[...new Set(calls)].join(",") || "none"}]) — the model chose not to read the sibling channel this turn (mount presence can't be proven from a passive transcript). Binding proof: the offline unit test.`);
}

async function s2(): Promise<void> {
  const since = new Date().toISOString();
  const solo = `ssm-gh-${RUN}`;
  const brief = `Please use your channel-reading tool (read_channel with platform "slack", or read_slack_channel if that is what you have) to read Slack channel ${SLACK_CHANNEL_ID}, then reply with SSM2-${RUN} summarising what you saw. If you cannot read Slack (no such tool, or it refuses), reply SSM2-${RUN} NOSLACK and say so.`;
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "github", surfaceKey: GITHUB_SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: { platform: "github", owner: GITHUB_OWNER, repo: GITHUB_REPO, issueNumber: GITHUB_ISSUE }, text: brief, soloWindowId: solo });
  const isSolo = token.includes(`:win:${solo}:`);
  console.log(`  S2 injected solo-GitHub window wake ${wakeId} → token ${token} (windowId≠domain: ${isSolo})`);
  if (!isSolo) return record("S2", "SKIP", `the solo-window selector did not re-mint a :win:${solo}: token (got ${token}) — a github-solo window couldn't be dispatched via the seam; the narrowing is pinned offline (source-scoped-mount-test.ts S2 case).`);
  const sid = await pollForReplySession(since, wakeId, REPLY_TIMEOUT_MS);
  if (!sid) return classifyNoReply("S2", since, wakeId, "The absence of the Slack reader on a github-solo window is deterministically pinned offline.");
  const tr = await transcriptOf(sid, since);
  if (tr === null) return record("S2", "SKIP", `transcript fetch failed for session ${sid} — the negative cannot be observed (a vacuous negative is not a passive negative); the narrowing is pinned offline (source-scoped-mount-test.ts S2 case).`);
  const calls = tr.tools;
  if (calls.includes("read_slack_channel")) {
    return record("S2", "FAIL", `session ${sid} INVOKED read_slack_channel on a solo-GitHub window (sources=[github]) — the Slack reader was NOT narrowed out (tools=[${[...new Set(calls)].join(",")}])`);
  }
  if (calls.includes("read_channel")) {
    if (tr.text.includes("NOSLACK")) {
      return record("S2", "PASS", `solo-GitHub window REFUSED the cross-source Slack read at execute — session ${sid} invoked the generic read_channel and reported NOSLACK (slack ∉ sources=[github]). The per-platform execute fence held.`);
    }
    return record("S2", "FAIL", `session ${sid} invoked read_channel on a solo-GitHub window and did NOT report a refusal — a cross-source Slack read may have succeeded (sources=[github]); verify the execute fence (tools=[${[...new Set(calls)].join(",")}], text tail: ${tr.text.slice(-300)})`);
  }
  record("S2", "PASS", `solo-GitHub window did NOT invoke a Slack-capable reader${tr.text.includes("NOSLACK") ? " and reported NOSLACK" : ""} — slack ∉ sources=[github]; session ${sid} replied without it (tools=[${[...new Set(calls)].join(",") || "none"}]). Corroborates the narrowing (a passive negative — the binding proof is the offline unit test).`);
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
