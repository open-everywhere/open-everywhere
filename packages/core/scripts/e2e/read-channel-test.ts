import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditWireEntry } from "./audit-read.js";
import { deployedBuildCarries } from "./deployed-build.js";
import { awaitDelegatedAnswer, classifyDelegatedAnswer, classifyDelegatedReadEvidence, GENERIC_READ_VERBS_SHA, pollForDelegationSettlement, pollForFinalReply, pollForOwnWakeReply, shouldAssertShaAncestry, type DelegatedReadVerdict, type OwnWakeCandidate } from "./read-channel-lib.js";

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

  {
    const idAck = rowAt("reply.post", "2026-04-15T09:30:02.000Z", { sessionId: "s1", wakeId: "w1", chars: 24, id: "c5737095823" });
    const foldEdit = rowAt("reply.edit", "2026-04-15T09:30:50.000Z", { sessionId: "s1", wakeId: "w1", chars: 640, id: "c5737095823" });
    const { deps } = makeDeps([[idAck, started], [idAck, started, settled, foldEdit]]);
    const o = await pollForFinalReply(deps, "w1", "s1", 100_000, 4000, 12_000);
    ok(o.kind === "settled-relay", `a reply.edit of the turn's OWN ack id at/after the settle row ⇒ "settled-relay" (got "${o.kind}": ${o.detail})`);
    ok(o.detail.includes("reply.edit") && o.detail.includes("c5737095823"), `…and the detail names the edit and the id it rewrote, so the log says WHICH shape settled (got: ${o.detail})`);
    ok(o.replyCount === 1, `…while the reply COUNT still counts posts only — an edit creates no new message (got ${o.replyCount})`);

    const foreignEdit = rowAt("reply.edit", "2026-04-15T09:30:50.000Z", { sessionId: "s1", wakeId: "w1", chars: 640, id: "c-SOMEONE-ELSE" });
    const { deps: d2 } = makeDeps([[idAck, started, settled, foreignEdit]]);
    const o2 = await pollForFinalReply(d2, "w1", "s1", 40_000, 4000, 12_000);
    ok(o2.kind !== "settled-relay", `an edit of an id this turn never posted is NOT this turn's settlement (got "${o2.kind}")`);

    const earlyEdit = rowAt("reply.edit", "2026-04-15T09:30:05.000Z", { sessionId: "s1", wakeId: "w1", chars: 30, id: "c5737095823" });
    const { deps: d3 } = makeDeps([[idAck, started, settled, earlyEdit]]);
    const o3 = await pollForFinalReply(d3, "w1", "s1", 40_000, 4000, 12_000);
    ok(o3.kind !== "settled-relay", `an edit made BEFORE delegation.task_settled is not the settlement (got "${o3.kind}")`);

    const otherTurnEdit = rowAt("reply.edit", "2026-04-15T09:30:50.000Z", { sessionId: "OTHER", wakeId: "wX", chars: 640, id: "c5737095823" });
    const { deps: d4 } = makeDeps([[idAck, started, settled, otherTurnEdit]]);
    const o4 = await pollForFinalReply(d4, "w1", "s1", 40_000, 4000, 12_000);
    ok(o4.kind !== "settled-relay", `an edit carrying ANOTHER session and wake never fires the relay exit (got "${o4.kind}")`);
  }

  {
    const rows: readonly AuditWireEntry[][] = [
      [ack, started], [ack, started], [ack, started], [ack, started],
      [ack, started, settled],
      [ack, started, settled, relay],
    ];
    const { deps } = makeDeps(rows);
    const o = await pollForFinalReply(deps, "w1", "s1", 100_000, 4000, 12_000);
    ok(
      o.kind === "settled-relay",
      `a settlement that lands AFTER the ack has been quiet for longer than quietMs still gets its own window ⇒ "settled-relay" (got "${o.kind}": ${o.detail})`,
    );
    ok(o.replyCount === 2, `…and the settlement reply is counted (got ${o.replyCount})`);
  }

  {
    const { deps, sleepCount } = makeDeps([[ack, started], [ack, started, settled]]);
    const o = await pollForFinalReply(deps, "w1", "s1", 100_000, 4000, 12_000);
    ok(o.kind === "quiet", `a settlement with no reply after it still reaches "quiet" — the restart is one-shot (got "${o.kind}": ${o.detail})`);
    ok(sleepCount() === 5, `…after holding the full 12000ms from the SETTLEMENT, not from the ack (got ${sleepCount()} polls; 4 would mean no restart, >5 a repeating one)`);
    ok(o.detail.includes("clock measured from the settlement"), `…and the detail says which instant the clock ran from (got: ${o.detail})`);
  }
}

{
  const ms = (iso: string): number => Date.parse(iso);
  const SURFACE = "slack/T0AAAA/D0EXDMCH001";
  const slackTs = (iso: string): string => (ms(iso) / 1000).toFixed(6);
  const msg = (iso: string, substantive = true): OwnWakeCandidate => ({ id: slackTs(iso), atMs: ms(iso), substantive });

  const row = (action: string, iso: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: iso, org: "default", platform: "slack", workspace: "dm", action, detail,
  });

  const ASK = "2026-05-15T11:00:24.665Z";
  const CARD = "2026-05-15T11:00:24.671Z";
  const REAL = "2026-05-15T11:00:35.500Z";
  const NARRATION = "2026-05-15T11:00:36.900Z";

  const ingress = row("wake.ingress", "2026-05-15T11:00:24.910Z", { wakeId: "w-mine", surfaceKey: SURFACE, vendorTs: ASK });
  const turnStart = row("wake.turn_start", "2026-05-15T11:00:25.100Z", { wakeId: "w-mine" });
  const narrationRow = row("reply.post", NARRATION, { wakeId: "w-prev", id: slackTs(NARRATION), chars: 64 });
  const realRow = row("reply.post", REAL, { wakeId: "w-mine", id: slackTs(REAL), chars: 240 });

  const post = { vendorMs: ms(ASK), surfaceKey: SURFACE } as const;

  function makeDeps(
    rowsSeq: readonly (readonly AuditWireEntry[])[],
    msgSeq: readonly (readonly OwnWakeCandidate[])[],
  ): { deps: { sleep: (ms: number) => Promise<void>; now: () => number; fetchRows: () => Promise<readonly AuditWireEntry[]>; fetchCandidates: () => Promise<readonly OwnWakeCandidate[]> }; polls: () => number } {
    let now = 1_000_000;
    let rowCall = 0;
    let msgCall = 0;
    let polls = 0;
    const at = <T,>(seq: readonly (readonly T[])[], i: number): readonly T[] => seq[Math.min(i, seq.length - 1)] ?? [];
    return {
      deps: {
        now: () => now,
        sleep: async (d: number) => { polls++; now += d; },
        fetchRows: async () => at(rowsSeq, rowCall++),
        fetchCandidates: async () => at(msgSeq, msgCall++),
      },
      polls: () => polls,
    };
  }

  {
    const { deps, polls } = makeDeps(
      [[ingress, turnStart], [ingress, turnStart], [ingress, turnStart, realRow]],
      [[msg(CARD)], [msg(CARD)], [msg(CARD), msg(REAL)]],
    );
    const o = await pollForOwnWakeReply(deps, post, { timeoutMs: 100_000, pollMs: 5_000 });
    ok(o.kind === "own-wake", `the previous leg's approval card is not this leg's reply — the wake-keyed answer is (got "${o.kind}": ${o.detail})`);
    ok(o.kind === "own-wake" && o.id === slackTs(REAL), `…and the message returned is the one wake w-mine posted (got "${o.kind === "own-wake" ? o.id : "n/a"}", the card is ${slackTs(CARD)})`);
    ok(polls() === 2, `…after holding the wait open for it rather than returning on the card's read (got ${polls()} polls)`);
  }

  {
    const late = "2026-05-15T11:00:26.000Z";
    const { deps } = makeDeps([[ingress, turnStart]], [[msg(late)]]);
    const o = await pollForOwnWakeReply(deps, post, { timeoutMs: 40_000, pollMs: 5_000 });
    ok(o.kind === "unattributed" && o.id === slackTs(late), `an unattributed post from AFTER this turn started is admitted — the floor is what excluded the card (got "${o.kind}")`);
  }

  {
    const { deps } = makeDeps([[ingress, turnStart, narrationRow]], [[msg(NARRATION)]]);
    const o = await pollForOwnWakeReply(deps, post, { timeoutMs: 40_000, pollMs: 5_000 });
    ok(o.kind === "timeout", `a reply.post row on ANOTHER wake is never this leg's reply, on either arm (got "${o.kind}": ${o.detail})`);
    ok(o.detail.includes("1 of them attributed to ANOTHER wake"), `…and the timeout says so, so a red names the cause instead of "no reply" (got: ${o.detail})`);
  }

  {
    const { deps } = makeDeps([[ingress, turnStart]], [[msg(REAL)]]);
    const o = await pollForOwnWakeReply(deps, post, { timeoutMs: 40_000, pollMs: 5_000 });
    ok(o.kind === "unattributed" && o.id === slackTs(REAL), `a host-delivered answer that no reply.post row names is admitted from this turn's start (got "${o.kind}")`);

    const { deps: d2 } = makeDeps([[ingress]], [[msg(REAL)]]);
    const o2 = await pollForOwnWakeReply(d2, post, { timeoutMs: 40_000, pollMs: 5_000 });
    ok(o2.kind === "timeout", `…and with no ${"wake.turn_start"} row for this wake there is no floor, so the arm stays closed (got "${o2.kind}")`);
  }

  {
    const wakeless = row("reply.post", REAL, { id: slackTs(REAL), chars: 240 });
    const { deps } = makeDeps([[ingress, turnStart, wakeless]], [[msg(REAL)]]);
    const o = await pollForOwnWakeReply(deps, post, { timeoutMs: 40_000, pollMs: 5_000 });
    ok(o.kind === "unattributed", `a reply.post row with NO wakeId leaves its message unattributed, never foreign (got "${o.kind}": ${o.detail})`);

    const foreign = row("reply.post", REAL, { wakeId: "w-prev", id: slackTs(REAL), chars: 240 });
    const { deps: d2 } = makeDeps([[ingress, turnStart, foreign]], [[msg(REAL)]]);
    const o2 = await pollForOwnWakeReply(d2, post, { timeoutMs: 40_000, pollMs: 5_000 });
    ok(o2.kind === "timeout", `…while the SAME row carrying another wake makes it foreign (got "${o2.kind}")`);
  }

  {
    const { deps } = makeDeps([[]], [[msg(REAL)]]);
    const o = await pollForOwnWakeReply(deps, post, { timeoutMs: 40_000, pollMs: 5_000 });
    ok(o.kind === "no-wake", `with no wake.ingress row for the driver's own post there is no key, so nothing in the room is the reply (got "${o.kind}")`);
    ok(!o.detail.includes("never admitted"), `…and it does not assert an absence the read cannot earn — the row may sit behind a capped page (got: ${o.detail})`);
  }

  for (const [label, wrong] of [
    ["another message's ingress row", row("wake.ingress", "2026-05-15T10:59:55.100Z", { wakeId: "w-prev", surfaceKey: SURFACE, vendorTs: "2026-05-15T10:59:55.000Z" })],
    ["this message's instant on another surface", row("wake.ingress", "2026-05-15T11:00:24.910Z", { wakeId: "w-elsewhere", surfaceKey: "slack/T0AAAA/C0OTHER", vendorTs: ASK })],
  ] as const) {
    const { deps } = makeDeps([[wrong]], [[msg(REAL)]]);
    const o = await pollForOwnWakeReply(deps, post, { timeoutMs: 40_000, pollMs: 5_000 });
    ok(o.kind === "no-wake", `${label} does not supply this leg's wake (got "${o.kind}")`);
  }

  {
    const ACK = "2026-05-15T11:00:26.000Z";
    const ackRow = row("reply.post", ACK, { wakeId: "w-mine", id: slackTs(ACK), chars: 18 });
    const { deps } = makeDeps([[ingress, turnStart, ackRow, realRow]], [[msg(ACK, false), msg(REAL)]]);
    const o = await pollForOwnWakeReply(deps, post, { timeoutMs: 40_000, pollMs: 5_000 });
    ok(o.kind === "own-wake" && o.id === slackTs(REAL), `an interim ack on this leg's own wake is stepped over for the substantive reply (got "${o.kind}": ${o.detail})`);
  }

  {
    const S228 = "slack/T0EXAMPLE/D0EXDMCH001";
    const WAKE = "00000000-0000-4000-8000-000000000031";
    const ASK_Rc = "2026-05-25T22:27:18.890Z";
    const REPLY_ID = "1779748052.241000";
    const REPLY_AT = ms("2026-05-25T22:27:32.241Z");
    const ing228 = row("wake.ingress", ASK_Rc, { wakeId: WAKE, surfaceKey: S228, vendorTs: ASK_Rc });
    const turn228 = row("wake.turn_start", "2026-05-25T22:27:27.017Z", { wakeId: WAKE, sessionId: "wrun_example30", turnId: "turn_0" });
    const post228 = row("reply.post", "2026-05-25T22:27:32.269Z", { wakeId: WAKE, id: REPLY_ID, chars: 200, route: "tool", platform: "slack" });
    const driverPost = { vendorMs: ms(ASK_Rc), surfaceKey: S228 } as const;
    const acked: OwnWakeCandidate = { id: REPLY_ID, atMs: REPLY_AT, substantive: false };

    const { deps } = makeDeps([[ing228, turn228, post228]], [[acked]]);
    const o = await pollForOwnWakeReply(deps, driverPost, { timeoutMs: 420_000, pollMs: 5_000 });
    ok(o.kind === "timeout", `a wake whose only post the leg skipped still times out — the skip decides, not the key (got "${o.kind}": ${o.detail})`);
    ok(o.kind === "timeout" && o.ownSkipped === 1, `…and the timeout COUNTS that post as this wake's own, stepped over by the caller (got ownSkipped=${o.kind === "timeout" ? o.ownSkipped : "n/a"})`);
    ok(!o.detail.includes("produced no reply row"), `…and never claims the wake produced no reply row, which is the sentence that sent OPE-2017 at the audit read (got: ${o.detail})`);
    ok(o.detail.includes("1 carried a reply.post row for this wake's own lineage"), `…the detail says it in words too, so a ship report names the seam without re-reading the store (got: ${o.detail})`);

    const { deps: d2 } = makeDeps([[ing228, turn228]], [[acked]]);
    const o2 = await pollForOwnWakeReply(d2, driverPost, { timeoutMs: 420_000, pollMs: 5_000 });
    ok(o2.kind === "timeout" && o2.ownSkipped === 0, `with NO reply.post row in the read the same skipped message attributes to nobody (got ownSkipped=${o2.kind === "timeout" ? o2.ownSkipped : "n/a"})`);

    const { deps: d3 } = makeDeps([[ing228, turn228]], [[{ ...acked, substantive: true }]]);
    const o3 = await pollForOwnWakeReply(d3, driverPost, { timeoutMs: 420_000, pollMs: 5_000 });
    ok(o3.kind === "unattributed", `a missing reply.post row alone ends the wait on the unattributed arm, never in a timeout (got "${o3.kind}": ${o3.detail})`);

    const early: OwnWakeCandidate = { id: "1779748039.000100", atMs: ms("2026-05-25T22:27:19.000Z"), substantive: true };
    const { deps: d4 } = makeDeps([[ing228, turn228]], [[early]]);
    const o4 = await pollForOwnWakeReply(d4, driverPost, { timeoutMs: 420_000, pollMs: 5_000 });
    ok(o4.kind === "timeout" && o4.belowFloor === 1, `a message standing before this wake's turn start is counted at the floor (got belowFloor=${o4.kind === "timeout" ? o4.belowFloor : "n/a"})`);
    ok(o4.kind === "timeout" && o4.ownSkipped === 0, `…and it is NOT counted as a post this wake made (got ownSkipped=${o4.kind === "timeout" ? o4.ownSkipped : "n/a"})`);

    const { deps: d5 } = makeDeps([[ing228]], [[{ ...acked, substantive: true }]]);
    const o5 = await pollForOwnWakeReply(d5, driverPost, { timeoutMs: 420_000, pollMs: 5_000 });
    ok(o5.kind === "timeout" && o5.belowFloor === 1, `with NO wake.turn_start row the arm is shut and the refusal is counted (got "${o5.kind}" belowFloor=${o5.kind === "timeout" ? o5.belowFloor : "n/a"})`);
    ok(o5.detail.includes("that arm stayed closed"), `…and the detail says the floor was never fixed, so belowFloor is not read as "it arrived early" (got: ${o5.detail})`);
  }
}

{
  const ms = (iso: string): number => Date.parse(iso);
  const SURFACE = "slack/T0AAAA/D0EXDMCH001";
  const slackTs = (iso: string): string => (ms(iso) / 1000).toFixed(6);
  const msg = (iso: string, substantive = true): OwnWakeCandidate => ({ id: slackTs(iso), atMs: ms(iso), substantive });
  const platformOf = (action: string): string =>
    action === "unified.task_wake" ? "unified" : action === "delegation.task_started" ? "ingest" : "slack";
  const row = (action: string, iso: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: iso, org: "default", platform: platformOf(action), workspace: "dm", action, detail,
  });

  const ASK = "2026-05-16T08:53:50.000Z";
  const TURN_START = "2026-05-16T08:53:56.000Z";
  const HANDOFF = "2026-05-16T08:54:02.000Z";
  const DISPATCH = "2026-05-16T08:54:11.000Z";
  const SETTLED = "2026-05-16T08:54:24.000Z";

  const W_ASK = "4c382da1";
  const W_TASK = "1bf93f28";
  const TASK = "task_j4";

  const ingress = row("wake.ingress", "2026-05-16T08:53:50.400Z", { wakeId: W_ASK, surfaceKey: SURFACE, vendorTs: ASK });
  const turnStart = row("wake.turn_start", TURN_START, { wakeId: W_ASK });
  const handoffRow = row("reply.post", HANDOFF, { wakeId: W_ASK, id: slackTs(HANDOFF), route: "tool", chars: 194 });
  const dispatched = row("delegation.task_started", DISPATCH, { task: TASK, call: "call_1", agent: "", session: "s1", continuation: false });
  const taskWake = (over: Record<string, unknown> = {}): AuditWireEntry =>
    row("unified.task_wake", "2026-05-16T08:54:22.000Z", { task: TASK, status: "completed", outcome: "installed", wakeId: W_TASK, inheritedWakeId: W_ASK, turnId: "turn_1", ...over });
  const settledRow = row("reply.post", SETTLED, { wakeId: W_TASK, id: slackTs(SETTLED), route: "tool", chars: 243 });

  const post = { vendorMs: ms(ASK), surfaceKey: SURFACE } as const;

  const run = async (rows: readonly AuditWireEntry[], candidates: readonly OwnWakeCandidate[]) => {
    let now = 1_000_000;
    return pollForOwnWakeReply(
      {
        now: () => now,
        sleep: async (d: number) => { now += d; },
        fetchRows: async () => rows,
        fetchCandidates: async () => candidates,
      },
      post,
      { timeoutMs: 40_000, pollMs: 5_000 },
    );
  };

  {
    const o = await run([ingress, turnStart, handoffRow, dispatched, taskWake(), settledRow], [msg(HANDOFF, false), msg(SETTLED)]);
    ok(o.kind === "own-wake", `a settlement answering under its OWN minted wake is this leg's reply (got "${o.kind}": ${o.detail})`);
    ok(o.kind === "own-wake" && o.id === slackTs(SETTLED), `…and the message returned is the settlement, not the hand-off frame (got "${o.kind === "own-wake" ? o.id : "n/a"}")`);
    ok(o.kind === "own-wake" && o.wakeId === W_ASK, `…while the outcome still names THIS leg's ask as its key — callers join on it (got "${o.kind === "own-wake" ? o.wakeId : "n/a"}")`);
    ok(o.detail.includes(W_TASK) && o.detail.includes("settlement"), `…and the detail names the minted wake that posted it, so a board read can follow the lineage (got: ${o.detail})`);
  }

  {
    const strangerRow = row("reply.post", SETTLED, { wakeId: "w-stranger", id: slackTs(SETTLED), chars: 243 });
    const o = await run([ingress, turnStart, dispatched, taskWake(), strangerRow], [msg(SETTLED)]);
    ok(o.kind === "timeout", `a reply.post row on a wake outside this leg's settlement lineage is never its reply (got "${o.kind}": ${o.detail})`);
    ok(o.detail.includes("1 of them attributed to ANOTHER wake"), `…and the timeout still names the cause (got: ${o.detail})`);
  }

  {
    const o = await run([ingress, turnStart, dispatched, taskWake({ inheritedWakeId: "w-another-leg" }), settledRow], [msg(SETTLED)]);
    ok(o.kind === "timeout", `a task wake inheriting from ANOTHER leg's ask does not adopt its settlement (got "${o.kind}": ${o.detail})`);
  }

  {
    const W_TASK2 = "9817a07c";
    const TASK2 = "task_j4_again";
    const dispatched2 = row("delegation.task_started", "2026-05-16T08:55:10.000Z", { task: TASK2, call: "call_2", agent: "", session: "s1", continuation: false });
    const secondTaskWake = row("unified.task_wake", "2026-05-16T08:55:40.000Z", { task: TASK2, status: "completed", outcome: "installed", wakeId: W_TASK2, inheritedWakeId: W_TASK, turnId: "turn_2" });
    const SECOND = "2026-05-16T08:55:42.000Z";
    const secondReply = row("reply.post", SECOND, { wakeId: W_TASK2, id: slackTs(SECOND), chars: 310 });
    const o = await run([ingress, turnStart, dispatched, dispatched2, secondTaskWake, taskWake(), secondReply], [msg(SECOND)]);
    ok(o.kind === "own-wake" && o.id === slackTs(SECOND), `a settlement OF a settlement is still this leg's reply, whatever order the task wake rows were read in (got "${o.kind}")`);
  }

  {
    const strangerRow = row("reply.post", SETTLED, { wakeId: "w-stranger", id: slackTs(SETTLED), chars: 243 });
    const o = await run([ingress, turnStart, dispatched, taskWake({ wakeId: "w-stranger", inheritedWakeId: null }), strangerRow], [msg(SETTLED)]);
    ok(o.kind === "timeout", `a task wake naming no inherited id joins nothing to this lineage (got "${o.kind}": ${o.detail})`);
  }

  {
    const o = await run([ingress, turnStart, dispatched, taskWake({ outcome: "ingressed" }), settledRow], [msg(SETTLED)]);
    ok(o.kind === "timeout", `a task wake row whose outcome is not "installed" adopts nothing (got "${o.kind}": ${o.detail})`);
  }

  {
    const prevDispatch = row("delegation.task_started", "2026-05-16T08:52:00.000Z", { task: "task_leg15", call: "call_0", agent: "", session: "s1", continuation: false });
    const prevTaskWake = taskWake({ task: "task_leg15", wakeId: "w-leg15-task" });
    const prevReply = row("reply.post", SETTLED, { wakeId: "w-leg15-task", id: slackTs(SETTLED), chars: 243 });
    const o = await run([ingress, turnStart, prevDispatch, prevTaskWake, prevReply], [msg(SETTLED)]);
    ok(o.kind === "timeout", `a PREVIOUS leg's task, settling under this leg's stamp, is never this leg's reply (got "${o.kind}": ${o.detail})`);

    const o2 = await run([ingress, turnStart, prevTaskWake, prevReply], [msg(SETTLED)]);
    ok(o2.kind === "timeout", `…and an absent ${"delegation.task_started"} row fails CLOSED, never open (got "${o2.kind}")`);
  }
}

{
  const ASK_MS = Date.parse("2026-05-24T01:24:45.000Z");
  const row = (action: string, ts: string, detail: Record<string, unknown>, seq?: number): AuditWireEntry => ({
    ts, org: "default", platform: "ingest", workspace: "e2e", action, detail, ...(seq !== undefined ? { seq } : {}),
  });
  const started = row("delegation.task_started", "2026-05-24T01:25:02.000Z", { task: "task_bf1fa4e4", session: "s-seat", call: "call_0" }, 10);
  const settled = row("delegation.task_settled", "2026-05-24T01:25:53.088Z", { task: "task_bf1fa4e4", session: "s-seat", status: "completed" }, 20);
  const post = (id: string, ts: string, seq: number): AuditWireEntry => row("reply.post", ts, { id, sessionId: "s-seat", wakeId: "w-ask" }, seq);
  const interimPost = post("1758498819.000100", "2026-05-24T01:25:39.000Z", 15);
  const answerPost = post("1758498837.000200", "2026-05-24T01:25:57.000Z", 25);

  {
    const v = classifyDelegatedAnswer([started, settled, interimPost, answerPost], { messageId: "1758498819.000100", floorMs: ASK_MS });
    ok(v.kind === "pre-settlement", `the interim post, standing before the settlement row, ⇒ "pre-settlement" (got "${v.kind}")`);
    ok(v.kind === "pre-settlement" && v.taskId === "task_bf1fa4e4", "…and the verdict names the task whose settlement it stands before");
  }

  {
    const v = classifyDelegatedAnswer([started, settled, interimPost, answerPost], { messageId: "1758498837.000200", floorMs: ASK_MS });
    ok(v.kind === "answer", `the post standing after the settlement row ⇒ "answer" (got "${v.kind}")`);
  }

  {
    const v = classifyDelegatedAnswer([started, interimPost], { messageId: "1758498819.000100", floorMs: ASK_MS });
    ok(v.kind === "unsettled", `a dispatched task with no settlement row yet ⇒ "unsettled" (got "${v.kind}")`);
  }

  {
    const v = classifyDelegatedAnswer([interimPost], { messageId: "1758498819.000100", floorMs: ASK_MS });
    ok(v.kind === "in-seat", `no delegation.task_started row at all ⇒ "in-seat", graded at once (got "${v.kind}")`);
  }

  {
    const older = row("delegation.task_started", "2026-05-24T01:22:00.000Z", { task: "task_prev", session: "s-seat" }, 2);
    const v = classifyDelegatedAnswer([older, interimPost], { messageId: "1758498819.000100", floorMs: ASK_MS });
    ok(v.kind === "in-seat", `a dispatch row PREDATING the ask is not this ask's delegation (got "${v.kind}")`);
  }

  {
    const v = classifyDelegatedAnswer([started, settled], { messageId: "1758498819.000100", floorMs: ASK_MS });
    ok(v.kind === "unlocatable", `a message no reply.post row names ⇒ "unlocatable" (got "${v.kind}")`);
  }

  {
    const stepped = post("1758498819.000100", "2026-05-24T01:26:30.000Z", 15);
    const v = classifyDelegatedAnswer([started, settled, stepped], { messageId: "1758498819.000100", floorMs: ASK_MS });
    ok(v.kind === "pre-settlement", `with both rows carrying seq, a backward-stepped ts never overrides the insert order (got "${v.kind}")`);
  }

  {
    const noSeq = (action: string, ts: string, detail: Record<string, unknown>): AuditWireEntry => ({ ts, org: "default", platform: "ingest", workspace: "e2e", action, detail });
    const startedNoSeq = noSeq("delegation.task_started", "2026-05-24T01:25:02.000Z", { task: "task_bf1fa4e4", session: "s-seat" });
    const settledNoSeq = noSeq("delegation.task_settled", "2026-05-24T01:25:53.088Z", { task: "task_bf1fa4e4", session: "s-seat", status: "completed" });
    const early = noSeq("reply.post", "2026-05-24T01:25:39.000Z", { id: "1758498819.000100", sessionId: "s-seat" });
    const late = noSeq("reply.post", "2026-05-24T01:25:57.000Z", { id: "1758498837.000200", sessionId: "s-seat" });
    const v1 = classifyDelegatedAnswer([startedNoSeq, settledNoSeq, early, late], { messageId: "1758498819.000100", floorMs: ASK_MS });
    ok(v1.kind === "pre-settlement", `with NO seq on either row the ts fallback places the interim post before the settlement (got "${v1.kind}")`);
    const v2 = classifyDelegatedAnswer([startedNoSeq, settledNoSeq, early, late], { messageId: "1758498837.000200", floorMs: ASK_MS });
    ok(v2.kind === "answer", `…and places the later post after it (got "${v2.kind}") — the arm discriminates, it does not answer one verdict for everything`);
  }

  type Msg = { readonly ts: string };
  const makeDeps = (
    rowsSequence: readonly (readonly AuditWireEntry[])[],
    replies: readonly (Msg | undefined)[],
  ) => {
    let now = 1_000_000;
    let read = 0;
    let handed = 0;
    let sleeps = 0;
    const logs: string[] = [];
    return {
      deps: {
        now: () => now,
        sleep: async (ms: number) => { sleeps++; now += ms; },
        fetchRows: async () => rowsSequence[Math.min(read++, rowsSequence.length - 1)] ?? [],
        nextReply: async () => replies[handed++],
        log: (line: string) => { logs.push(line); },
      },
      sleepCount: () => sleeps,
      logs,
    };
  };

  {
    const { deps, sleepCount, logs } = makeDeps(
      [
        [started, interimPost],
        [started, settled, interimPost],
        [started, settled, interimPost, answerPost],
      ],
      [{ ts: "1758498837.000200" }],
    );
    const out = await awaitDelegatedAnswer<Msg>(deps, { ts: "1758498819.000100" }, { floorMs: ASK_MS, timeoutMs: 180_000, pollMs: 3_000, maxSteps: 3 });
    ok(out.kind === "answer", `interim → settle row → final reply ⇒ the wait ends on "answer" (got "${out.kind}": ${out.detail})`);
    ok(out.message.ts === "1758498837.000200", `…and the message it hands back is the FINAL reply, not the interim post (got ${out.message.ts})`);
    ok(out.stepped === 1, `…having stepped over exactly one interim post (got ${out.stepped})`);
    ok(sleepCount() === 1, `…and it re-read while the worker was unsettled rather than grading at once (got ${sleepCount()} poll(s))`);
    ok(logs.some((l) => l.includes("stepping over")), "…and the run log says which post it stepped over");
  }

  {
    const { deps, sleepCount } = makeDeps([[started, settled, answerPost]], []);
    const out = await awaitDelegatedAnswer<Msg>(deps, { ts: "1758498837.000200" }, { floorMs: ASK_MS, timeoutMs: 180_000, pollMs: 3_000, maxSteps: 3 });
    ok(out.kind === "answer" && out.stepped === 0 && sleepCount() === 0, `an already-settled turn returns its reply with no poll and no step (kind "${out.kind}", ${out.stepped} step(s), ${sleepCount()} poll(s))`);
  }

  {
    const { deps } = makeDeps([[started, settled, interimPost]], [undefined]);
    const out = await awaitDelegatedAnswer<Msg>(deps, { ts: "1758498819.000100" }, { floorMs: ASK_MS, timeoutMs: 180_000, pollMs: 3_000, maxSteps: 3 });
    ok(out.kind === "budget", `no later reply ⇒ the interim post is graded, not an exception (got "${out.kind}")`);
    ok(out.message.ts === "1758498819.000100" && out.detail.includes("OPE-1949"), "…and the detail names the fold-into-edit shape that produces no second post");
  }

  {
    const { deps } = makeDeps([[started, interimPost]], []);
    const out = await awaitDelegatedAnswer<Msg>(deps, { ts: "1758498819.000100" }, { floorMs: ASK_MS, timeoutMs: 9_000, pollMs: 3_000, maxSteps: 3 });
    ok(out.kind === "budget", `a worker that never settles ⇒ the bound elapses and the reply in hand is graded (got "${out.kind}")`);
    ok(out.detail.includes("still running"), "…and the detail carries the last read's own reason");
  }
}

console.log(`✓ ${n} read-channel-e2e assertions passed`);
