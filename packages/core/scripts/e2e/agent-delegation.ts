import {
  sleep, dS, makeWant, createRecorder, createInjector, createAuditReader, readToolCalls,
} from "./window-harness.js";
import { classifyT1bSpawnedOutcome } from "./agent-delegation-classify.js";

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
const degradedIds: string[] = [];

const slackOrigin = { platform: "slack" as const, channelId: CHANNEL_ID };

const inject = createInjector(TARGET, INJECT);
const { rowsSince, readFailed: auditReadFailed } = createAuditReader(TARGET, READ, { onError: "swallow" });

const toolCallsOf = (sessionId: string, sinceIso?: string): Promise<{ name: string; errored: boolean }[] | null> =>
  readToolCalls(TARGET, READ, sessionId, { paged: true, sinceIso });

const ASYNC_BRIEF =
  "This is a long job: in a sandbox, write and run a script that computes the first 40 fibonacci " +
  "numbers and their sum. Hand it to a worker so you can keep watching the channel — don't do it " +
  "yourself here; reply to me when it's underway.";
const SYNC_BRIEF =
  "Quick bounded task I need finished now: run `echo hello-from-worker` in a sandbox and tell me the exact output.";
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
    const spawn = rows.find((r) => r.action === "task.spawned" && (dS(r, "parentWakeId") === wakeId || dS(r, "wakeId") === wakeId));
    if (spawn) {
      return record("T1a", "PASS", `agent(async) delegated — a task.spawned row appeared (taskId=${dS(spawn, "taskId")}, parentWakeId=${dS(spawn, "parentWakeId")}). The one-shot worker does the job and wakes the caller with return_result; this is spawnOneShotTask reached through \`agent\`.`);
    }
    const reply = rows.find((r) => r.action === "reply.post" && dS(r, "wakeId") === wakeId);
    if (reply) {
      const sid = dS(reply, "sessionId");
      const calls = sid ? await toolCallsOf(sid, since) : null;
      if (calls === null) {
        return record("T1a", "SKIP", `the seat replied (wake ${wakeId}, session ${sid ?? "<absent>"}) with no task.spawned row, but the transcript is UNREADABLE — delegation outcome UNVERIFIED (an observability failure, not model behaviour); fix the transcript read and re-run.`);
      }
      if (calls.some((c) => c.name === "agent")) {
        return record("T1a", "FAIL", `the model CALLED agent (session ${sid}) but NO task.spawned row landed for wake ${wakeId} — the execute refused/errored (window-token attr absent?) or the self-dispatch route failed (OE_SPAWN_DISPATCH_SECRET / OE_PUBLIC_BASE_URL); read the action.result error in the transcript.`);
      }
      return record("T1a", "SKIP", `the seat replied (session ${sid}, tools=[${[...new Set(calls.map((c) => c.name))].join(",") || "none"}]) without invoking agent — the model did not choose agent(async) this turn (delegation is model-dependent), or the flag was off. Re-run with OE_ONESHOT_AGENT=1.`);
    }
  }
  record("T1a", "SKIP", `no task.spawned row (and no reply) for wake ${wakeId} within ${TIMEOUT_MS}ms — the model did not choose agent(async) this turn (delegation is model-dependent), OR the target was not started with OE_ONESHOT_AGENT=1 (agent is then absent). Re-run with the flag ON.${auditReadFailed() ? " NOTE: at least one audit READ failed during the poll — this SKIP may be an audit-route observability failure, not model behaviour." : ""}`);
}

async function t1bSync(): Promise<void> {
  const since = new Date().toISOString();
  const startedAt = Date.now();
  const { wakeId } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: SYNC_BRIEF });
  console.log(`  T1b injected standing window wake ${wakeId}`);
  const deadline = startedAt + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const rows = await rowsSince(since);
    const reply = rows.find((r) => r.action === "reply.post" && dS(r, "wakeId") === wakeId);
    if (reply) {
      const sid = dS(reply, "sessionId");
      const calls = sid ? await toolCallsOf(sid, since) : null;
      if (calls === null) {
        return record("T1b", "SKIP", `the seat replied (wake ${wakeId}, session ${sid ?? "<absent>"}) but the transcript is UNREADABLE — delegation outcome UNVERIFIED (an observability failure; never conclude "the model handled it another way" without the observation). Fix the transcript read and re-run.`);
      }
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
  const rows = await rowsSince(since);
  const spawn = rows.find((r) => r.action === "task.spawned" && (dS(r, "parentWakeId") === wakeId || dS(r, "wakeId") === wakeId));
  if (spawn) {
    const taskId = dS(spawn, "taskId") ?? "?";
    const returned = taskId !== "?" ? rows.find((r) => r.action === "task.returned" && dS(r, "taskId") === taskId) : undefined;
    const outcome = classifyT1bSpawnedOutcome({
      taskId,
      returned: !!returned,
      returnedHasError: returned?.detail?.hasError === true,
      returnedDelivered: returned?.detail?.delivered === true,
      timeoutMs: TIMEOUT_MS,
      observedMs: Date.now() - startedAt,
    });
    if (outcome.degraded) degradedIds.push("T1b");
    return record("T1b", outcome.status, outcome.detail);
  }
  record("T1b", "SKIP", `no reply and no task.spawned row for wake ${wakeId} within ${TIMEOUT_MS}ms — the seat did not complete a turn (model-dependent / flag off).${auditReadFailed() ? " NOTE: at least one audit READ failed during the poll — this SKIP may be an audit-route observability failure, not model behaviour." : ""}`);
}

async function t1cFile(): Promise<void> {
  const since = new Date().toISOString();
  const { wakeId } = await inject({ domain: DOMAIN, platform: "slack", surfaceKey: SURFACE, addressing: "direct-mention", mention: true, author: "tester", origin: slackOrigin, text: FILE_BRIEF });
  console.log(`  T1c injected standing window wake ${wakeId}`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const rows = await rowsSince(since);
    const spawn = rows.find((r) => r.action === "task.spawned" && (dS(r, "parentWakeId") === wakeId || dS(r, "wakeId") === wakeId));
    if (spawn) {
      const taskId = dS(spawn, "taskId");
      const posted = rows.find((r) => r.action.endsWith(".post_file"));
      if (posted) {
        return record("T1c", "PASS", `agent delegated a FILE ask and the worker POSTED the artifact — task.spawned (taskId=${taskId}) then ${posted.action} (files=${dS(posted, "filenames") || "?"}). The standing seat carries no post_file; the worker delivered the file into the thread per renderOneShotBrief's carve-out.`);
      }
      const returned = taskId ? rows.find((r) => r.action === "task.returned" && dS(r, "taskId") === taskId) : undefined;
      if (returned) {
        return record("T1c", "FAIL", `the worker for task ${taskId} RETURNED with no .post_file row — it did the work but never delivered the FILE into the thread (a text-only return_result leaves the requester empty-handed). Check renderOneShotBrief still permits post_file for a file task.`);
      }
    } else {
      const reply = rows.find((r) => r.action === "reply.post" && dS(r, "wakeId") === wakeId);
      if (reply) {
        const sid = dS(reply, "sessionId");
        const calls = sid ? await toolCallsOf(sid, since) : null;
        if (calls === null) {
          return record("T1c", "SKIP", `the seat replied (wake ${wakeId}, session ${sid ?? "<absent>"}) with no task.spawned row, but the transcript is UNREADABLE — outcome UNVERIFIED (observability failure, not model behaviour); fix the transcript read and re-run.`);
        }
        if (calls.some((c) => c.name === "agent")) {
          return record("T1c", "FAIL", `the model CALLED agent (session ${sid}) but NO task.spawned row landed for wake ${wakeId} — the execute refused/errored or the self-dispatch route failed; read the action.result error in the transcript.`);
        }
        return record("T1c", "SKIP", `the seat replied (session ${sid}, tools=[${[...new Set(calls.map((c) => c.name))].join(",") || "none"}]) without delegating the file ask — the model did not choose agent this turn (model-dependent), or the flag was off. Re-run with OE_ONESHOT_AGENT=1.`);
      }
    }
  }
  record("T1c", "SKIP", `no task.spawned/post_file (and no reply) for wake ${wakeId} within ${TIMEOUT_MS}ms — the model did not delegate the file ask this turn (model-dependent), OR the target was not started with OE_ONESHOT_AGENT=1.${auditReadFailed() ? " NOTE: an audit READ failed during the poll — this SKIP may be an observability failure, not model behaviour." : ""}`);
}

async function main(): Promise<void> {
  console.log(`agent-delegation e2e — target=${TARGET || "(none)"} org=${ORG} domain=${DOMAIN} surface=${SURFACE}`);
  if (!TARGET || !READ || !INJECT) {
    for (const id of ["T1a", "T1b", "T1c"]) if (want(id)) record(id, "SKIP", "no E2E_TARGET_URL / E2E_CONTROL_READ_TOKEN / E2E_CONTROL_INJECT_TOKEN — the delegation e2e needs the live spoofed-ingest target started with OE_ONESHOT_AGENT=1");
  } else {
    if (want("T1a")) await t1aAsync();
    if (want("T1b")) await t1bSync();
    if (want("T1c")) await t1cFile();
  }
  const pass = results.filter((r) => r.status === "PASS").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const degradeNote = degradedIds.length > 0
    ? ` — ⚠ ${degradedIds.length} DEGRADED (${degradedIds.join(",")}): passed via the absorb-a-timeout path, not by observing the asserted behaviour. See the per-route detail above.`
    : "";
  console.log(`\n──────\nagent-delegation: ${pass} PASS, ${skip} SKIP, ${fail} FAIL${degradeNote}`);
  if (fail > 0) process.exit(1);
}

await main();
