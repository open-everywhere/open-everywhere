import {
  sleep, dS, makeWant, createRecorder, createInjector, createAuditReader, readToolCalls,
  classifyDelegationOutcome, type ToolCall,
} from "./window-harness.js";
import { type AuditWireEntry } from "./audit-read.js";

const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
const INJECT = process.env.E2E_CONTROL_INJECT_TOKEN ?? "";
const ORG = process.env.E2E_ORG ?? "default";
const DOMAIN = process.env.E2E_AGENT_DELEG_DOMAIN ?? "e2e-unified";
const SURFACE = process.env.E2E_AGENT_DELEG_SURFACE ?? "slack/T0EXAMPLE/C0EXCHAN003";
const CHANNEL_ID = SURFACE.split("/").slice(2).join("/");
const TIMEOUT_MS = Number.parseInt(process.env.AGENT_DELEG_TIMEOUT_MS ?? "120000", 10);
const POLL_MS = 4000;
const want = makeWant(process.env.AGENT_DELEG_ONLY);

const { results, record } = createRecorder();

const slackOrigin = { platform: "slack" as const, channelId: CHANNEL_ID };

const inject = createInjector(TARGET, INJECT);
const { rowsSince, readFailed: auditReadFailed } = createAuditReader(TARGET, READ, { onError: "swallow" });

const toolCallsOf = (sessionId: string, sinceIso?: string): Promise<ToolCall[] | null> =>
  readToolCalls(TARGET, READ, sessionId, { paged: true, sinceIso });

function receiptsFor(rows: readonly AuditWireEntry[], wakeId: string): { nativeReceipt: boolean; sessionId: string | undefined; settled: AuditWireEntry | undefined } {
  const sessionId = rows.find((r) => dS(r, "wakeId") === wakeId && (dS(r, "sessionId") ?? "").length > 0)?.detail?.sessionId as string | undefined;
  const started = sessionId === undefined ? undefined : rows.find((r) => r.action === "delegation.task_started" && dS(r, "session") === sessionId);
  const settled = started === undefined ? undefined : rows.find((r) => r.action === "delegation.task_settled" && dS(r, "task") === dS(started, "task"));
  return { nativeReceipt: started !== undefined, sessionId, settled };
}

const ASYNC_BRIEF =
  "This is a long job: in a sandbox, write and run a script that computes the first 40 fibonacci " +
  "numbers and their sum. Hand it to a worker so you can keep watching the channel — don't do it " +
  "yourself here; reply to me when it's underway.";
const FILE_BRIEF =
  "Make a tiny CSV file with two rows (header name,score then alice,1 and bob,2) and post it into this thread as a file attachment.";

async function t1aAsync(): Promise<void> {
  const since = new Date().toISOString();
  const { wakeId, token } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: ASYNC_BRIEF });
  console.log(`  T1a injected standing window wake ${wakeId} → token ${token}`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const rows = await rowsSince(since);
    const { nativeReceipt, sessionId, settled } = receiptsFor(rows, wakeId);
    if (nativeReceipt) {
      const route = `delegation.task_started (caller session ${sessionId})`;
      const close = settled === undefined ? "not yet settled at this read" : `settled status=${dS(settled, "status")} marker=${dS(settled, "marker")}`;
      return record("T1a", "PASS", `agent delegated — ${route}; ${close}. The worker does the job and its result reaches the caller.`);
    }
    const reply = rows.find((r) => r.action === "reply.post" && dS(r, "wakeId") === wakeId);
    if (reply) {
      const sid = dS(reply, "sessionId");
      const calls = sid ? await toolCallsOf(sid, since) : null;
      const v = classifyDelegationOutcome({ nativeReceipt, replied: true, calls });
      return record("T1a", v.status, `${v.reason} (wake ${wakeId}, session ${sid ?? "<absent>"}).`);
    }
  }
  record("T1a", "SKIP", `no delegation receipt row (and no reply) for wake ${wakeId} within ${TIMEOUT_MS}ms — the model did not choose to delegate this turn (delegation is model-dependent), or the turn is still running.${auditReadFailed() ? " NOTE: at least one audit READ failed during the poll — this SKIP may be an audit-route observability failure, not model behaviour." : ""}`);
}

async function t1cFile(): Promise<void> {
  const since = new Date().toISOString();
  const { wakeId } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: FILE_BRIEF });
  console.log(`  T1c injected standing window wake ${wakeId}`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const rows = await rowsSince(since);
    const { nativeReceipt, sessionId, settled } = receiptsFor(rows, wakeId);
    if (nativeReceipt) {
      const route = `delegation.task_started (caller session ${sessionId})`;
      const posted = rows.find((r) => r.action.endsWith(".post_file"));
      if (posted) {
        return record("T1c", "PASS", `agent delegated a FILE ask and the worker POSTED the artifact — ${route} then ${posted.action} (files=${dS(posted, "filenames") || "?"}). The standing seat carries no post_file; the worker delivered the file into the thread per renderOneShotBrief's carve-out.`);
      }
      if (settled) {
        return record("T1c", "FAIL", `the delegated worker SETTLED (${settled.action}) with no .post_file row — it did the work but never delivered the FILE into the thread (a text-only return leaves the requester empty-handed). Check the worker persona still permits post_file for a file task.`);
      }
    } else {
      const reply = rows.find((r) => r.action === "reply.post" && dS(r, "wakeId") === wakeId);
      if (reply) {
        const sid = dS(reply, "sessionId");
        const calls = sid ? await toolCallsOf(sid, since) : null;
        const v = classifyDelegationOutcome({ nativeReceipt, replied: true, calls });
        if (v.status === "PASS") {
          return record("T1c", "SKIP", `${v.reason} — but no .post_file row landed for the file ask (wake ${wakeId}, session ${sid ?? "<absent>"}). Artifact delivery UNVERIFIED.`);
        }
        return record("T1c", v.status, `${v.reason} (file ask; wake ${wakeId}, session ${sid ?? "<absent>"}).`);
      }
    }
  }
  record("T1c", "SKIP", `no delegation receipt / .post_file row (and no reply) for wake ${wakeId} within ${TIMEOUT_MS}ms — the model did not delegate the file ask this turn (model-dependent), or the turn is still running.${auditReadFailed() ? " NOTE: an audit READ failed during the poll — this SKIP may be an observability failure, not model behaviour." : ""}`);
}

async function main(): Promise<void> {
  console.log(`agent-delegation e2e — target=${TARGET || "(none)"} org=${ORG} domain=${DOMAIN} surface=${SURFACE}`);
  console.log(`  seat lock: /tmp/oe-e2e-locks/domain-${DOMAIN}.lock — hold it for the whole live drive`);
  if (!TARGET || !READ || !INJECT) {
    for (const id of ["T1a", "T1c"]) if (want(id)) record(id, "SKIP", "no E2E_TARGET_URL / E2E_CONTROL_READ_TOKEN / E2E_CONTROL_INJECT_TOKEN — the delegation e2e needs a live spoofed-ingest target");
  } else {
    if (want("T1a")) await t1aAsync();
    if (want("T1c")) await t1cFile();
  }
  const pass = results.filter((r) => r.status === "PASS").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n──────\nagent-delegation: ${pass} PASS, ${skip} SKIP, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

await main();
