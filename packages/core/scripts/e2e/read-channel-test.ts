import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditWireEntry } from "./audit-read.js";
import { deployedBuildCarries } from "./deployed-build.js";
import { classifyDelegatedReadEvidence, GENERIC_READ_VERBS_SHA } from "./read-channel-lib.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

{
  ok(/^[0-9a-f]{40}$/.test(GENERIC_READ_VERBS_SHA), "GENERIC_READ_VERBS_SHA is a full 40-char sha (not a typo/abbreviation)");

  let isAncestorOfHead = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", GENERIC_READ_VERBS_SHA, "HEAD"], { cwd: REPO_ROOT, stdio: "ignore" });
    isAncestorOfHead = true;
  } catch {}
  ok(isAncestorOfHead, `GENERIC_READ_VERBS_SHA (${GENERIC_READ_VERBS_SHA.slice(0, 8)}) is a real ancestor of HEAD — agent/settings/settings.ts's tools.genericReadVerbs:true commit, OPE-434`);

  const recordDir = join(REPO_ROOT, ".open-everywhere-deploy");
  const recordFile = join(recordDir, "known-good.json");
  const hadRecord = existsSync(recordFile);
  const backup = hadRecord ? readFileSync(recordFile, "utf8") : null;
  try {
    if (hadRecord) rmSync(recordFile);

    ok(deployedBuildCarries(GENERIC_READ_VERBS_SHA) === false, "no known-good.json record ⇒ deployedBuildCarries reports false (never guesses armed)");

    mkdirSync(recordDir, { recursive: true });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
    writeFileSync(recordFile, JSON.stringify({ lastGood: { commit: head } }));
    ok(deployedBuildCarries(GENERIC_READ_VERBS_SHA) === true, "a known-good.json naming HEAD (which carries the flag commit) ⇒ deployedBuildCarries reports true");

    const priorCommit = execFileSync("git", ["rev-parse", `${GENERIC_READ_VERBS_SHA}^`], { cwd: REPO_ROOT }).toString().trim();
    writeFileSync(recordFile, JSON.stringify({ lastGood: { commit: priorCommit } }));
    ok(deployedBuildCarries(GENERIC_READ_VERBS_SHA) === false, "a known-good.json naming the flag commit's OWN PARENT ⇒ deployedBuildCarries reports false (pre-flag build correctly reads unarmed)");
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

console.log(`✓ ${n} read-channel-e2e assertions passed`);
