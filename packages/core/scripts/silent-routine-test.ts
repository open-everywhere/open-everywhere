
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

const dir = join(tmpdir(), `open-everywhere-silent-routine-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const throws = (fn: () => unknown, match: RegExp, label: string): void => {
  let msg: string | null = null;
  try {
    fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  assert.ok(msg !== null && match.test(msg), `${label} (got: ${msg ?? "no throw"})`);
  n++;
};

const {
  assertReportConsistent,
  describeTrigger,
  isSilentRoutine,
  routineSilentStamped,
  ROUTINE_MARKER,
} = await import("../agent/routines/routine.js");
const { storedTrigger, storedReport } = await import("../agent/tools/create_routine.js");
const { renderFailureBlock, renderScheduledMessage, renderSilentBlock, renderWatchMessage, WATCH_SILENCE_SENTINEL } = await import(
  "../agent/routines/watch.js"
);
const { renderJobMessage } = await import("../agent/routines/job.js");
const { routineFireAttributes } = await import("../agent/routines/fire-auth.js");
const { markSilentRoutineTurn, clearSilentRoutineTurn, silentRoutineThisTurn, SILENT_ROUTINE_DROP_REASON } = await import(
  "../agent/routines/report.js"
);
const { finalMessageActionForTurn, isBareStop, NO_REPLY_SENTINEL } = await import("../agent/channels/turn-delivery.js");
const { markNoReplyThisTurn, consumeNoReplyThisTurn } = await import("../agent/channels/no-reply-signal.js");
const silenceHook = (await import("../agent/hooks/routine-silence.js")).default;
const { announceSelfDisable, disableNoticeText } = await import("../agent/routines/disable-notice.js");
const { auditRoutineFire, ROUTINE_AUDIT } = await import("../agent/routines/fire-audit.js");
const store = await import("../agent/routines/store.js");
const { readAudit } = await import("../agent/audit/audit.js");

type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;

const ORG = "acme";
const SURFACE = "slack/T1/C1";

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: "C1" },
    trigger: { kind: "interval", everyMinutes: 30 },
    prompt: "Reconcile the release board with the open PRs.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
const inSession = <T>(fn: () => Promise<T>, attributes?: Record<string, string>): Promise<T> => {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "silent-routine-test", auth: attributes ? { current: { attributes }, initiator: null } : null, turn: 1, parent: undefined });
  return contextStorage.run(c, fn);
};
const hookCtx = (attributes?: Record<string, string>): never =>
  ({ session: { id: "s1", auth: { current: { attributes: attributes ?? {} } } } }) as never;
const turnStarted = (attributes?: Record<string, string>): Promise<unknown> =>
  Promise.resolve(silenceHook.events!["turn.started"]!({} as never, hookCtx(attributes)));

{
  const cron = storedTrigger({ kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "never" } as never);
  ok(cron.kind === "cron" && cron.expr === "0 9 * * 1-5", "`never` + cron stores a plain cron trigger (NOT watch)");
  const every = storedTrigger({ kind: "scheduled", everyMinutes: 30, postPolicy: "never" } as never);
  ok(every.kind === "interval" && every.everyMinutes === 30, "`never` + everyMinutes stores a plain interval trigger (NOT watch)");
  ok(storedReport({ kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "never" } as never)?.kind === "silent", "`never` stores report {kind:'silent'}");
  ok(storedReport({ kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as never) === undefined, "`every-run` stores NO report (absent = post — every pre-OPE-149 row is unchanged)");
  ok(storedReport({ kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "only-on-change" } as never) === undefined, "`only-on-change` stores NO report — the watch trigger already IS its policy");
  ok(storedReport({ kind: "scheduled", at: "2030-01-01T00:00:00.000Z", postPolicy: "never" } as never) === undefined, "a one-shot ignores `never` (postPolicy is documented as ignored for `at`)");
  ok(storedReport({ kind: "event", source: "github" } as never) === undefined, "an event subscription has no postPolicy, so no report");
  ok(isSilentRoutine(routine({ id: "r1", report: { kind: "silent" } })), "isSilentRoutine reads the stored report");
  ok(!isSilentRoutine(routine({ id: "r2" })), "a routine with no report is NOT silent (absent = post)");
}

{
  throws(
    () => assertReportConsistent({ kind: "watch", everyMinutes: 15 }, { kind: "silent" }),
    /never.*only-on-change|silent watch/i,
    "a silent WATCH is refused (a silent watch is just a silent cron)",
  );
  assertReportConsistent({ kind: "cron", expr: "0 9 * * *" }, { kind: "silent" });
  assertReportConsistent({ kind: "watch", everyMinutes: 15 }, undefined);
  ok(true, "a silent cron and an ordinary watch both pass the consistency check");
}

{
  const silent = routine({ id: "r-silent", report: { kind: "silent" } });
  const block = renderSilentBlock(silent);
  ok(block.includes("[silent]"), "the silent block is tagged like the [watch] protocol block beside it");
  ok(block.includes(WATCH_SILENCE_SENTINEL) && WATCH_SILENCE_SENTINEL === NO_REPLY_SENTINEL, "it names the SAME silence sentinel the rest of the tree uses (no second vocabulary)");
  ok(/cannot resolve/i.test(block) && /WILL post/i.test(block), "it states the ONE exception — an unresolvable problem WILL post");
  ok(block.includes("`reply`"), "it points the exception at the mid-turn `reply` tool — the positive act the gate never touches");
  ok(renderSilentBlock(routine({ id: "r-plain" })) === "", "a non-silent routine renders NO block");

  const msg = renderScheduledMessage(silent);
  ok(msg.includes("[silent]"), "renderScheduledMessage carries the block for a silent routine");
  ok(msg.indexOf("[silent]") < msg.indexOf(silent.prompt), "the block sits between the fire preamble and the prompt (trusted framing before the instruction)");
  const plain = routine({ id: "r-plain" });
  ok(
    renderScheduledMessage(plain) ===
      `[routine r-plain] Scheduled fire (routine created: ${plain.createdAt}; previous run: none — this is the FIRST run).\n\n${renderFailureBlock()}\n\n${plain.prompt}`,
    "an ordinary fire's message is preamble + health block + prompt, with no stray blank paragraph where the silent block would have been",
  );
  ok(!renderWatchMessage(routine({ id: "r-w", trigger: { kind: "watch", everyMinutes: 15 } })).includes("[silent]"), "a watch fire never carries the silent block (the pair is refused anyway)");
  ok(renderJobMessage(routine({ id: "r-j", sessionMode: "job", report: { kind: "silent" } })).includes("[silent]"), "a durable JOB can be silent too, and gets the same block");
  ok(!renderJobMessage(routine({ id: "r-j2", sessionMode: "job" })).includes("[silent]"), "an ordinary job's message is unchanged");
}

{
  const silentAttrs = routineFireAttributes(routine({ id: "r-s", report: { kind: "silent" } }), { team_id: "T1", channel_id: "C1" }, "channel", false);
  ok(silentAttrs[ROUTINE_MARKER.silent] === "true", "a silent routine's fire stamps the silent marker");
  ok(routineSilentStamped(silentAttrs), "routineSilentStamped reads its own stamp back");
  const plainAttrs = routineFireAttributes(routine({ id: "r-p" }), { team_id: "T1", channel_id: "C1" }, "channel", false);
  ok(!(ROUTINE_MARKER.silent in plainAttrs), "an ordinary fire stamps NOTHING (byte-identical bag)");
  ok(!routineSilentStamped(plainAttrs), "an unstamped bag reads as 'posts'");
  ok(!routineSilentStamped({ [ROUTINE_MARKER.silent]: "false" }), "positive-only: any value but 'true' reads as 'posts' (fail to the pre-OPE-149 behaviour)");
  ok(!routineSilentStamped(undefined), "an absent attribute bag reads as 'posts'");
}

{
  await inSession(async () => {
    ok(!silentRoutineThisTurn(), "a fresh session starts un-silenced");
    await turnStarted({ [ROUTINE_MARKER.silent]: "true", [ROUTINE_MARKER.id]: "r-s" });
    ok(silentRoutineThisTurn(), "turn.started seeds the signal from the host-set stamp");
    await turnStarted({ [ROUTINE_MARKER.id]: "r-s" });
    ok(!silentRoutineThisTurn(), "a LATER turn in the SAME session without the stamp CLEARS it (the durable-job re-wake case)");
    await turnStarted({ [ROUTINE_MARKER.silent]: "true" });
    ok(silentRoutineThisTurn(), "…and re-seeds on the next silent fire");
    await Promise.resolve(silenceHook.events!["turn.completed"]!({} as never, hookCtx() as never));
    ok(!silentRoutineThisTurn(), "turn.completed drops the signal (belt on the clear-first brace)");
  });
  await inSession(async () => {
    ok(!silentRoutineThisTurn(), "a different session never sees a previous session's signal");
  });
  markSilentRoutineTurn();
  clearSilentRoutineTurn();
  ok(silentRoutineThisTurn() === false, "outside an eve context the signal is a fail-soft no-op reading false");
}

{
  await inSession(async () => {
    markSilentRoutineTurn();
    const a = finalMessageActionForTurn("stop", "Reconciled 4 tickets and updated the board.");
    ok(a.kind === "silent" && a.reason === SILENT_ROUTINE_DROP_REASON, "a NON-COMPLIANT silent turn (real prose) is dropped, with its own reason");
  });
  await inSession(async () => {
    markSilentRoutineTurn();
    const a = finalMessageActionForTurn("stop", NO_REPLY_SENTINEL);
    ok(a.kind === "silent", "a COMPLIANT silent turn (the sentinel) is silent too — the two routes agree");
  });
  await inSession(async () => {
    markSilentRoutineTurn();
    const a = finalMessageActionForTurn("stop", "");
    ok(a.kind === "silent" && a.reason === SILENT_ROUTINE_DROP_REASON, "an EMPTY silent turn reports the structural reason, not 'empty final message'");
    ok(!isBareStop(a as never, false), "…so it is never a BARE STOP: a silent routine saying nothing is the design, not an unexplained stop");
  });
  await inSession(async () => {
    markSilentRoutineTurn();
    const buf = finalMessageActionForTurn("tool-calls", null);
    ok(buf.kind === "buffer-tool-status", "an INTERMEDIATE tool-call step is untouched — the gate is terminal-only, so the turn still runs its tools");
  });
  await inSession(async () => {
    markSilentRoutineTurn();
    markNoReplyThisTurn("nothing_to_add");
    finalMessageActionForTurn("stop", "some prose");
    ok(consumeNoReplyThisTurn() === null, "the no_reply signal is consumed even when the silent gate wins — it can never bleed into the next turn");
  });
  await inSession(async () => {
    const a = finalMessageActionForTurn("stop", "here's the digest");
    ok(a.kind === "post" && a.text === "here's the digest", "a NON-silent turn posts exactly as before");
    const b = finalMessageActionForTurn("stop", NO_REPLY_SENTINEL);
    ok(b.kind === "silent" && b.reason.includes("sentinel"), "…and the sentinel still resolves to judged silence with ITS reason");
  });
}

{
  const replyPost = readFileSync(new URL("../agent/channels/reply-post.ts", import.meta.url), "utf8");
  ok(!replyPost.includes("routines/report.js"), "the mid-turn reply spine (channels/reply-post.ts) does NOT consult the silent signal — the escape hatch stays open");
  const unifiedReply = readFileSync(new URL("../agent/channels/unified-reply.ts", import.meta.url), "utf8");
  ok(!unifiedReply.includes("routines/report.js"), "the unified reply dispatch does NOT consult it either — a host-side post (including the self-disable notice) is never gated");
}

{
  ok(describeTrigger({ kind: "cron", expr: "0 9 * * 1-5" }, { kind: "silent" }) === 'cron "0 9 * * 1-5" (UTC; posts nothing)', "leg 1: a silent cron is described as 'posts nothing'");
  ok(describeTrigger({ kind: "interval", everyMinutes: 30 }, { kind: "silent" }) === "every 30 min (posts nothing)", "leg 1: a silent interval is described as 'posts nothing'");
  ok(describeTrigger({ kind: "cron", expr: "0 9 * * 1-5" }) === 'cron "0 9 * * 1-5" (UTC; posts every run)', "leg 1: an ordinary trigger's copy is unchanged");
  ok(describeTrigger({ kind: "watch", everyMinutes: 30 }) === "every 30 min (posts only on change)", "leg 1: only-on-change copy is unchanged");
}

{
  const silent = routine({ id: "r-audit-silent", report: { kind: "silent" } });
  await auditRoutineFire(silent, "sess-silent", "ok");
  const plain = routine({ id: "r-audit-plain" });
  await auditRoutineFire(plain, "sess-plain", "ok");
  const rows = (await readAudit({ org: ORG, action: ROUTINE_AUDIT.fire })) as AuditInput[];
  const row = (id: string): AuditInput | undefined => rows.find((r) => r.detail?.["routineId"] === id);
  ok(row("r-audit-silent")?.detail?.["silent"] === true, "leg 2: a silent fire's routine.fire row carries silent:true");
  ok(row("r-audit-silent")?.detail?.["sessionId"] === "sess-silent", "leg 2: …alongside the session id, so the transcript stays reachable from the routine id");
  ok(!("silent" in (row("r-audit-plain")?.detail ?? {})), "leg 2: an ordinary fire's row is unchanged (positive-only)");
}

{
  const silent = routine({ id: "r-dead", report: { kind: "silent" }, prompt: "Reconcile the release board." });
  const posts: Array<{ origin: unknown; text: string }> = [];
  const origin = { platform: "slack", channelId: "C1" };
  const landed = await announceSelfDisable(silent, "3 consecutive failures", 3, {
    resolveTarget: (() => ({ origin })) as never,
    post: async (o, text) => {
      posts.push({ origin: o, text });
      return "ts-1";
    },
  });
  ok(landed && posts.length === 1, "leg 3: a self-disable posts EXACTLY one notice into the routine's own surface");
  ok(posts[0]!.origin === origin, "leg 3: it goes to the routine's own dispatch origin — the same place a fire's reply would land, not a guessed target");
  const text = posts[0]!.text;
  ok(text.includes("r-dead") && /will not run again/i.test(text), "leg 3: the notice names the routine and says it STOPPED (the news is the future, not the past failures)");
  ok(text.includes("3 consecutive failures"), "leg 3: it carries the reason from the row");
  ok(/set it up again/i.test(text), "leg 3: it gives the recovery action (subscribe_pr's retirement-notice shape)");
  ok(/only sign it stopped/i.test(text), "leg 3: a SILENT routine's notice says why this message matters — nothing else would have told you");
  ok(!/only sign it stopped/i.test(disableNoticeText(routine({ id: "r-p" }), "x", 3)), "leg 3: an ordinary routine gets the same notice WITHOUT the silent-specific line (one code path, not a special case)");

  ok((await announceSelfDisable(silent, "x", 3, { resolveTarget: (() => null) as never })) === false, "leg 3: an unresolvable target skips the notice (the routine.disabled audit row still stands)");
  ok((await announceSelfDisable(silent, "x", 3, { resolveTarget: (() => ({ origin })) as never })) === false, "leg 3: a platform with no wired post arm fails soft rather than throwing out of the hook");
  ok(
    (await announceSelfDisable(silent, "x", 3, {
      resolveTarget: (() => ({ origin })) as never,
      post: async () => {
        throw new Error("slack 429");
      },
    })) === false,
    "leg 3: a FAILED post is swallowed — the fold and the audit row have already landed",
  );
}

{
  const partition = { org: ORG, surfaceKey: SURFACE } as never;
  await store.addRoutine(partition, routine({ id: "r-store-ok", report: { kind: "silent" } }));
  ok((await store.getRoutine(ORG, SURFACE, "r-store-ok"))?.report?.kind === "silent", "the report round-trips through the durable store");
  let refused = false;
  try {
    await store.addRoutine(partition, routine({ id: "r-store-bad", trigger: { kind: "watch", everyMinutes: 15 }, report: { kind: "silent" } }));
  } catch {
    refused = true;
  }
  ok(refused, "addRoutine REFUSES a silent watch — the contradiction is an invariant of the store, not a property of create_routine's enum (subscribe_pr writes rows directly too)");
  ok((await store.getRoutine(ORG, SURFACE, "r-store-bad")) === null, "…and nothing was written");
}

console.log(`✓ silent routines (OPE-149): ${n} assertions passed`);
