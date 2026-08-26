import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditWireEntry } from "./audit-read.js";
import { deployedBuildCarries } from "./deployed-build.js";
import { classifyDelegatedReadEvidence, GENERIC_READ_VERBS_SHA, pollForDelegationSettlement, pollForFinalReply, shouldAssertShaAncestry, type DelegatedReadVerdict } from "./read-channel-lib.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const runsClean = (args: readonly string[]): boolean => {
  try {
    execFileSync("git", [...args], { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const gitStdout = (args: readonly string[]): string => {
  try {
    return execFileSync("git", [...args], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

{
  ok(/^[0-9a-f]{40}$/.test(GENERIC_READ_VERBS_SHA), "GENERIC_READ_VERBS_SHA is a full 40-char sha (not a typo/abbreviation)");

  const shaKnownLocally = runsClean(["cat-file", "-e", `${GENERIC_READ_VERBS_SHA}^{commit}`]);
  const shallowClone = gitStdout(["rev-parse", "--is-shallow-repository"]) === "true";
  if (shouldAssertShaAncestry({ objectPresent: shaKnownLocally, shallowClone })) {
    const isAncestorOfHead = runsClean(["merge-base", "--is-ancestor", GENERIC_READ_VERBS_SHA, "HEAD"]);
    ok(isAncestorOfHead, `GENERIC_READ_VERBS_SHA (${GENERIC_READ_VERBS_SHA.slice(0, 8)}) is a real ancestor of HEAD — the earliest build that mounts the generic read verbs, OPE-434`);
  } else {
    const why = shallowClone
      ? "this checkout is a SHALLOW clone, so the ancestry chain to HEAD is not present locally"
      : `${GENERIC_READ_VERBS_SHA.slice(0, 8)} is not present in this checkout's git history`;
    console.log(`  (skipping the ancestor-of-HEAD sanity check — ${why}. The deployedBuildCarries controls below don't depend on it.)`);
  }

  ok(shouldAssertShaAncestry({ objectPresent: true, shallowClone: false }) === true, "full clone + object present → assert ancestry (the only state that proves the constant)");
  ok(shouldAssertShaAncestry({ objectPresent: true, shallowClone: true }) === false, "SHALLOW clone + object present → skip (a graft boundary has no parent links; OPE-1111)");
  ok(shouldAssertShaAncestry({ objectPresent: false, shallowClone: true }) === false, "shallow clone + object absent → skip (the CI runner's fetch-depth 1 shape)");
  ok(shouldAssertShaAncestry({ objectPresent: false, shallowClone: false }) === false, "full clone + object absent → skip (nothing to probe)");

  const recordDir = join(REPO_ROOT, ".open-everywhere-deploy");
  const recordFile = join(recordDir, "known-good.json");
  const hadRecord = existsSync(recordFile);
  const backup = hadRecord ? readFileSync(recordFile, "utf8") : null;
  try {
    if (hadRecord) rmSync(recordFile);

    ok(deployedBuildCarries("HEAD") === false, "no known-good.json record ⇒ deployedBuildCarries reports false (never guesses armed)");

    mkdirSync(recordDir, { recursive: true });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
    writeFileSync(recordFile, JSON.stringify({ lastGood: { commit: head } }));
    ok(deployedBuildCarries(head) === true, "a known-good.json naming HEAD, checked for carrying HEAD itself ⇒ deployedBuildCarries reports true (self-ancestry)");

    const unknownSha = "f".repeat(40);
    ok(deployedBuildCarries(unknownSha) === false, "checking for a sha git has never heard of ⇒ deployedBuildCarries reports false (deployed-build.ts's documented unknown-commit limit)");
  } finally {
    rmSync(recordFile, { force: true });
    if (hadRecord && backup !== null) {
      mkdirSync(recordDir, { recursive: true });
      writeFileSync(recordFile, backup);
    } else {
      rmSync(recordDir, { recursive: true, force: true });
    }
  }
}

{
  const row = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: new Date().toISOString(), org: "default", platform: "unified", workspace: "delegation", action, detail,
  });

  {
    const v = classifyDelegatedReadEvidence([], "s1", "slack");
    ok(v.kind === "none", `no rows ⇒ kind "none" (got "${v.kind}")`);
  }

  {
    const rows = [row("delegation.task_started", { task: "t1", session: "OTHER-SESSION" })];
    const v = classifyDelegatedReadEvidence(rows, "s1", "slack");
    ok(v.kind === "none", `task_started for a different session ⇒ kind "none", not joined (got "${v.kind}")`);
  }

  {
    const rows = [row("delegation.task_started", { task: "t1", session: "s1" })];
    const v = classifyDelegatedReadEvidence(rows, "s1", "slack");
    ok(v.kind === "delegated-unsettled", `task_started with no matching task_settled ⇒ kind "delegated-unsettled" (got "${v.kind}")`);
    ok(v.kind === "delegated-unsettled" && v.taskId === "t1", "delegated-unsettled carries the taskId");
  }

  {
    const rows = [
      row("delegation.task_started", { task: "t1", session: "s1" }),
      row("delegation.task_settled", { task: "t1", session: "s1", status: "failed", marker: "clean" }),
    ];
    const v = classifyDelegatedReadEvidence(rows, "s1", "slack");
    ok(v.kind === "delegated-failed", `task_settled status:"failed" ⇒ kind "delegated-failed" (got "${v.kind}")`);
    ok(v.kind === "delegated-failed" && v.status === "failed", "delegated-failed carries the observed status");
  }

  {
    const rows = [
      row("delegation.task_started", { task: "t1", session: "s1" }),
      row("delegation.task_settled", { task: "t1", session: "s1", status: "cancelled" }),
    ];
    const v = classifyDelegatedReadEvidence(rows, "s1", "slack");
    ok(v.kind === "delegated-failed", `task_settled status:"cancelled" ⇒ kind "delegated-failed" (got "${v.kind}")`);
  }

  {
    const rows = [
      row("delegation.task_started", { task: "task_8a31fc36c369a4c4dad888af", session: "s1" }),
      row("delegation.task_settled", { task: "task_8a31fc36c369a4c4dad888af", session: "s1", status: "completed", marker: "clean" }),
    ];
    const v = classifyDelegatedReadEvidence(rows, "s1", "slack");
    ok(v.kind === "delegated-completed", `task_settled status:"completed" ⇒ kind "delegated-completed" (got "${v.kind}")`);
    ok(v.kind === "delegated-completed" && v.taskId === "task_8a31fc36c369a4c4dad888af", "delegated-completed carries the taskId");
    ok(v.kind === "delegated-completed" && /not specifically that read_channel/.test(v.detail), "delegated-completed states the honest limit (delegation settled, not specifically read_channel) in its own detail string");
  }

  {
    const rows = [
      row("delegation.task_started", { task: "t1", session: "s1" }),
      row("delegation.task_settled", { task: "t1", session: "OTHER-SESSION", status: "completed" }),
    ];
    const v = classifyDelegatedReadEvidence(rows, "s1", "slack");
    ok(v.kind === "delegated-unsettled", `task_settled under a different session ⇒ still "delegated-unsettled" for s1 (got "${v.kind}")`);
  }

  {
    const rows = [row("slack.sources_refused", { target: "slack", origin: "slack", sessionId: "WORKER-SESSION-UNKNOWN" })];
    const v = classifyDelegatedReadEvidence(rows, "s1", "slack");
    ok(v.kind === "refused", `a slack.sources_refused row ⇒ kind "refused" (got "${v.kind}")`);
    ok(v.kind === "refused" && v.action === "slack.sources_refused", "refused carries the specific action name");
  }
  {
    const rows = [row("slack.origin_refused", { target: "slack" })];
    const v = classifyDelegatedReadEvidence(rows, "s1", "slack");
    ok(v.kind === "refused", `a slack.origin_refused row ⇒ kind "refused" (got "${v.kind}")`);
  }

  {
    const rows = [row("discord.sources_refused", { target: "discord" })];
    const v = classifyDelegatedReadEvidence(rows, "s1", "slack");
    ok(v.kind === "none", `a discord refusal row never matches platform:"slack" (got "${v.kind}")`);
  }
  {
    const rows = [row("slack.sources_refused", { target: "slack" })];
    const v = classifyDelegatedReadEvidence(rows, "s1", "discord");
    ok(v.kind === "none", `a slack refusal row never matches platform:"discord" (got "${v.kind}")`);
  }
}

{
  const row = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: new Date().toISOString(), org: "default", platform: "unified", workspace: "delegation", action, detail,
  });

  function makeDeps(rowsSequence: readonly (readonly AuditWireEntry[])[]): { deps: { sleep: (ms: number) => Promise<void>; now: () => number; fetchRows: () => Promise<readonly AuditWireEntry[]> }; sleepCount: () => number } {
    let now = 1_000_000;
    let call = 0;
    let sleeps = 0;
    return {
      deps: {
        now: () => now,
        sleep: async (ms: number) => { sleeps++; now += ms; },
        fetchRows: async () => rowsSequence[Math.min(call++, rowsSequence.length - 1)] ?? [],
      },
      sleepCount: () => sleeps,
    };
  }

  const firstUnsettled: DelegatedReadVerdict = { kind: "delegated-unsettled", taskId: "t1", detail: `delegation.task_started for task t1 (session s1) has no matching delegation.task_settled in this window — the background worker never reached a terminal state` };

  {
    const { deps, sleepCount } = makeDeps([[row("delegation.task_started", { task: "t1", session: "s1" }), row("delegation.task_settled", { task: "t1", session: "s1", status: "completed" })]]);
    const v = await pollForDelegationSettlement(deps, "s1", "slack", 100_000, 4000, firstUnsettled);
    ok(v.kind === "delegated-completed", `settling on the first poll ⇒ "delegated-completed" (got "${v.kind}")`);
    ok(sleepCount() === 1, `settling on the first poll ⇒ exactly one poll happened (got ${sleepCount()})`);
  }

  {
    const { deps, sleepCount } = makeDeps([
      [row("delegation.task_started", { task: "t1", session: "s1" })],
      [row("delegation.task_started", { task: "t1", session: "s1" })],
      [row("delegation.task_started", { task: "t1", session: "s1" }), row("delegation.task_settled", { task: "t1", session: "s1", status: "completed" })],
    ]);
    const v = await pollForDelegationSettlement(deps, "s1", "slack", 100_000, 4000, firstUnsettled);
    ok(v.kind === "delegated-completed", `settling on the third poll ⇒ "delegated-completed" (got "${v.kind}")`);
    ok(sleepCount() === 3, `two unsettled reads then a settle ⇒ three polls total, not one (got ${sleepCount()})`);
  }

  {
    const { deps, sleepCount } = makeDeps([[row("delegation.task_started", { task: "t1", session: "s1" })]]);
    const v = await pollForDelegationSettlement(deps, "s1", "slack", 10_000, 4000, firstUnsettled);
    ok(v.kind === "delegated-unsettled", `never settling within the bound ⇒ still "delegated-unsettled" (got "${v.kind}")`);
    ok(v.kind === "delegated-unsettled" && v.taskId === "t1", "the timed-out verdict still carries the taskId");
    ok(v.kind === "delegated-unsettled" && /never settled within 10000ms/.test(v.detail), `the timed-out detail names the bound explicitly (got "${v.kind === "delegated-unsettled" ? v.detail : ""}")`);
    ok(v.kind === "delegated-unsettled" && v.detail !== firstUnsettled.detail, "the timed-out detail is DIFFERENT from the pre-poll detail — a real timeout must not read as the pre-fix bug");
    ok(sleepCount() >= 2, `a 10s bound at a 4s poll interval polls more than once before giving up (got ${sleepCount()} polls)`);
  }

  {
    const { deps } = makeDeps([[row("delegation.task_started", { task: "t1", session: "s1" }), row("delegation.task_settled", { task: "t1", session: "s1", status: "failed" })]]);
    const v = await pollForDelegationSettlement(deps, "s1", "slack", 100_000, 4000, firstUnsettled);
    ok(v.kind === "delegated-failed", `a failed settlement appearing mid-poll ⇒ "delegated-failed", not a timeout (got "${v.kind}")`);
  }

  {
    const { deps } = makeDeps([[row("slack.sources_refused", { target: "slack" })]]);
    const v = await pollForDelegationSettlement(deps, "s1", "slack", 100_000, 4000, firstUnsettled);
    ok(v.kind === "refused", `a refusal row appearing mid-poll ⇒ "refused" (got "${v.kind}")`);
  }
}

{
  const rowAt = (action: string, ts: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts, org: "default", platform: "unified", workspace: "delegation", action, detail,
  });
  const ack = rowAt("reply.post", "2026-04-15T09:30:02.000Z", { sessionId: "s1", wakeId: "w1", chars: 24 });
  const started = rowAt("delegation.task_started", "2026-04-15T09:30:03.000Z", { task: "t1", session: "s1" });
  const settled = rowAt("delegation.task_settled", "2026-04-15T09:30:45.000Z", { task: "t1", session: "s1", status: "completed" });
  const relay = rowAt("reply.post", "2026-04-15T09:30:47.000Z", { sessionId: "s1", wakeId: "w2-completion", chars: 900 });

  function makeDeps(rowsSequence: readonly (readonly AuditWireEntry[])[]): { deps: { sleep: (ms: number) => Promise<void>; now: () => number; fetchRows: () => Promise<readonly AuditWireEntry[]> }; sleepCount: () => number } {
    let now = 1_000_000;
    let call = 0;
    let sleeps = 0;
    return {
      deps: { now: () => now, sleep: async (ms: number) => { sleeps++; now += ms; }, fetchRows: async () => rowsSequence[Math.min(call++, rowsSequence.length - 1)] ?? [] },
      sleepCount: () => sleeps,
    };
  }

  {
    const { deps, sleepCount } = makeDeps([[ack, started], [ack, started], [ack, started, settled, relay]]);
    const o = await pollForFinalReply(deps, "w1", "s1", 100_000, 4000, 12_000);
    ok(o.kind === "settled-relay", `an ack then a worker then the relay answer ⇒ "settled-relay" (got "${o.kind}": ${o.detail})`);
    ok(o.replyCount === 2, `…and it reports BOTH reply rows, not just the ack (got ${o.replyCount})`);
    ok(sleepCount() === 3, `…and it waited through the running worker rather than returning on the ack's poll (got ${sleepCount()} polls)`);
  }

  {
    const { deps } = makeDeps([[ack, started]]);
    const o = await pollForFinalReply(deps, "w1", "s1", 40_000, 4000, 12_000);
    ok(o.kind === "timeout", `an unsettled delegation holds the wait open to the bound ⇒ "timeout", never "quiet" (got "${o.kind}": ${o.detail})`);
  }

  {
    const { deps, sleepCount } = makeDeps([[ack]]);
    const o = await pollForFinalReply(deps, "w1", "s1", 100_000, 4000, 12_000);
    ok(o.kind === "quiet", `a single in-seat reply with no delegation ⇒ "quiet" (got "${o.kind}": ${o.detail})`);
    ok(o.replyCount === 1, `…reporting the one reply row (got ${o.replyCount})`);
    ok(sleepCount() === 4, `…after actually holding the 12000ms quiet window at a 4000ms poll (got ${sleepCount()} polls, 1 to see the reply + 3 to hold)`);
  }

  {
    const second = rowAt("reply.post", "2026-04-15T09:30:14.000Z", { sessionId: "s1", wakeId: "w1", chars: 700 });
    const { deps, sleepCount } = makeDeps([[ack], [ack], [ack, second]]);
    const o = await pollForFinalReply(deps, "w1", "s1", 100_000, 4000, 12_000);
    ok(o.kind === "quiet" && o.replyCount === 2, `a second in-seat reply mid-wait ⇒ "quiet" once BOTH are seen (got "${o.kind}", ${o.replyCount} replies)`);
    ok(sleepCount() === 6, `…and the quiet clock restarted on the second reply (got ${sleepCount()} polls; 4 would mean it never reset)`);
  }

  {
    const otherSettled = rowAt("delegation.task_settled", "2026-04-15T09:30:45.000Z", { task: "tX", session: "OTHER", status: "completed" });
    const otherReply = rowAt("reply.post", "2026-04-15T09:30:46.000Z", { sessionId: "OTHER", wakeId: "wX", chars: 50 });
    const { deps } = makeDeps([[ack, otherSettled, otherReply]]);
    const o = await pollForFinalReply(deps, "w1", "s1", 100_000, 4000, 12_000);
    ok(o.kind === "quiet", `a settled row for ANOTHER session never fires the relay exit (got "${o.kind}": ${o.detail})`);
    ok(o.replyCount === 1, `…and another session's reply is not counted as this turn's (got ${o.replyCount}, 2 would mean the join leaks)`);
  }

  for (const [label, settledTs, relayTs] of [
    ["whole-second settle vs sub-second reply", "2026-04-15T09:30:45Z", "2026-04-15T09:30:45.100Z"],
    ["+01:00 settle vs UTC reply", "2026-04-15T10:30:45.000+01:00", "2026-04-15T09:30:47.000Z"],
  ] as const) {
    const s = rowAt("delegation.task_settled", settledTs, { task: "t1", session: "s1", status: "completed" });
    const r = rowAt("reply.post", relayTs, { sessionId: "s1", wakeId: "w2-completion", chars: 900 });
    const { deps } = makeDeps([[ack, started, s, r]]);
    const o = await pollForFinalReply(deps, "w1", "s1", 40_000, 4000, 12_000);
    ok(o.kind === "settled-relay", `relay detection parses timestamps — ${label} (got "${o.kind}": ${o.detail})`);
  }

  {
    const s = rowAt("delegation.task_settled", "2026-04-15T09:30:45.000Z", { task: "t1", session: "s1", status: "completed" });
    const bad = rowAt("reply.post", "not-a-timestamp", { sessionId: "s1", wakeId: "w2-completion", chars: 900 });
    const { deps } = makeDeps([[ack, started, s, bad]]);
    const o = await pollForFinalReply(deps, "w1", "s1", 40_000, 4000, 12_000);
    ok(o.kind !== "settled-relay", `an unparseable reply ts never counts as the relay answer (got "${o.kind}")`);
  }
}

console.log(`✓ ${n} read-channel-e2e assertions passed`);
