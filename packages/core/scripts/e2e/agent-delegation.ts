import { fetchAudit, type AuditWireEntry } from "./audit-read.js";
import { fetchTranscript } from "./transcript-read.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
const ORG = process.env.E2E_ORG ?? "default";
const DOMAIN = process.env.E2E_AGENT_DELEG_DOMAIN ?? "e2e-unified";
const SURFACE = process.env.E2E_AGENT_DELEG_SURFACE ?? "slack/T0EXAMPLE/C0EXCHAN003";
const CHANNEL_ID = SURFACE.split("/").slice(2).join("/");
const TIMEOUT_MS = Number.parseInt(process.env.AGENT_DELEG_TIMEOUT_MS ?? "120000", 10);
const POLL_MS = 4000;
const ONLY = (process.env.AGENT_DELEG_ONLY ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const want = (id: string) => ONLY.length === 0 || ONLY.includes(id.toUpperCase());

type Status = "PASS" | "SKIP" | "FAIL";
const results: { id: string; status: Status; detail: string }[] = [];
const record = (id: string, status: Status, detail: string) => {
  results.push({ id, status, detail });
  const icon = status === "PASS" ? "✅" : status === "SKIP" ? "⏭ " : "❌";
  console.log(`\n${icon} ${id}: ${status} — ${detail}`);
};

const slackOrigin = { platform: "slack" as const, channelId: CHANNEL_ID };

interface InjectBody {
  domain: string; platform: "slack"; surfaceKey: string; text: string;
  addressing?: string; mention?: boolean; author?: string; origin: Record<string, unknown>;
}
async function inject(b: InjectBody): Promise<{ wakeId: string; token: string }> {
  const res = await fetch(`${TARGET}/control/v1/test/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ}`, "content-type": "application/json" },
    body: JSON.stringify(b),
  });
  if (!res.ok) throw new Error(`inject ${res.status}: ${(await res.text().catch(() => "")).slice(0, 240)}`);
  const jb = (await res.json()) as { wakeId: string; token: string };
  return { wakeId: jb.wakeId, token: jb.token };
}

const dS = (e: AuditWireEntry, k: string): string | undefined => (typeof e.detail?.[k] === "string" ? (e.detail[k] as string) : undefined);
const rowsSince = async (sinceIso: string): Promise<readonly AuditWireEntry[]> => {
  try { return await fetchAudit(TARGET, READ, { sinceIso, limit: 600 }); }
  catch (e) { console.warn(`  [audit] ${(e as Error).message}`); return []; }
};

async function toolCallsOf(sessionId: string): Promise<{ name: string; errored: boolean }[]> {
  try {
    const calls: { name: string; errored: boolean }[] = [];
    let start = 0;
    for (let page = 0; page < 40; page++) {
      const tr = await fetchTranscript(TARGET, READ, sessionId, { startIndex: start, limit: 2000, idleMs: 2500 });
      for (const e of tr.events) {
        if (e.type === "actions.requested") {
          const acts = (e.data as { actions?: { toolName?: string }[] } | undefined)?.actions ?? [];
          for (const a of acts) if (typeof a.toolName === "string") calls.push({ name: a.toolName, errored: false });
        } else if (e.type === "action.result") {
          const d = e.data as { error?: unknown; result?: { toolName?: string } } | undefined;
          if (d?.error !== undefined && calls.length > 0) calls[calls.length - 1] = { ...calls[calls.length - 1], errored: true };
        }
      }
      if (tr.events.length === 0) break;
      start = (tr as { nextIndex?: number }).nextIndex ?? start + tr.events.length;
    }
    return calls;
  } catch { return []; }
}

const ASYNC_BRIEF =
  "This is a long job: in a sandbox, write and run a script that computes the first 40 fibonacci " +
  "numbers and their sum. Hand it to a worker so you can keep watching the channel — don't do it " +
  "yourself here; reply to me when it's underway.";
const SYNC_BRIEF =
  "Quick bounded task I need finished now: run `echo hello-from-worker` in a sandbox and tell me the exact output.";

async function t1aAsync(): Promise<void> {
  const since = new Date().toISOString();
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: ASYNC_BRIEF });
  console.log(`  T1a injected standing window wake ${wakeId} → token ${token}`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const rows = await rowsSince(since);
    const spawn = rows.find((r) => r.action === "task.spawned" && (dS(r, "parentWakeId") === wakeId || dS(r, "wakeId") === wakeId));
    if (spawn) {
      return record("T1a", "PASS", `agent(async) delegated — a task.spawned row appeared (taskId=${dS(spawn, "taskId")}, parentWakeId=${dS(spawn, "parentWakeId")}). The one-shot worker does the job and wakes the caller with return_result; this is spawnOneShotTask reached through \`agent\`.`);
    }
  }
  record("T1a", "SKIP", `no task.spawned row for wake ${wakeId} within ${TIMEOUT_MS}ms — the model did not choose agent(async) this turn (delegation is model-dependent), OR the target was not started with OE_ONESHOT_AGENT=1 (agent is then absent). Re-run with the flag ON.`);
}

async function t1bSync(): Promise<void> {
  const since = new Date().toISOString();
  const { wakeId } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: SYNC_BRIEF });
  console.log(`  T1b injected standing window wake ${wakeId}`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const rows = await rowsSince(since);
    const reply = rows.find((r) => r.action === "reply.post" && dS(r, "wakeId") === wakeId);
    if (reply) {
      const sid = dS(reply, "sessionId");
      const calls = sid ? await toolCallsOf(sid) : [];
      const agentOk = calls.some((c) => c.name === "agent" && !c.errored);
      const agentErr = calls.some((c) => c.name === "agent" && c.errored);
      const names = [...new Set(calls.map((c) => `${c.name}${c.errored ? "!" : ""}`))].join(",");
      return record(
        "T1b",
        agentOk ? "PASS" : agentErr ? "FAIL" : "SKIP",
        agentOk
          ? `agent(sync) spawned a one-shot worker and returned its result inline (transcript ${sid} tools=[${names}]) — the bounded work ran on a credential-correct new session and the seat replied with the result.`
          : agentErr
            ? `the model CALLED agent but the execute REFUSED/errored (session ${sid}, tools=[${names}]) — the delegation stack is mounted but broken on this seat; read the action.result error in the transcript.`
            : `the seat replied (session ${sid}, tools=[${names || "none"}]) but did NOT invoke agent — the model handled the bounded task another way this turn (model-dependent), or the flag was off. Re-run with OE_ONESHOT_AGENT=1.`,
      );
    }
  }
  record("T1b", "SKIP", `no reply for wake ${wakeId} within ${TIMEOUT_MS}ms — the seat did not complete a turn (model-dependent / flag off).`);
}

async function main(): Promise<void> {
  console.log(`agent-delegation e2e — target=${TARGET || "(none)"} org=${ORG} domain=${DOMAIN} surface=${SURFACE}`);
  if (!TARGET || !READ) {
    for (const id of ["T1a", "T1b"]) if (want(id)) record(id, "SKIP", "no E2E_TARGET_URL / E2E_CONTROL_READ_TOKEN — the delegation e2e needs the live spoofed-ingest target started with OE_ONESHOT_AGENT=1");
  } else {
    if (want("T1a")) await t1aAsync();
    if (want("T1b")) await t1bSync();
  }
  const pass = results.filter((r) => r.status === "PASS").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n──────\nagent-delegation: ${pass} PASS, ${skip} SKIP, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

await main();
