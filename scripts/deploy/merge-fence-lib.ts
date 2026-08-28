import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  fetchGithubApi,
  type GithubApiFetchLike,
  realGithubApiFetch,
  resolveGithubOwnerRepoFromEnv,
  resolveGithubOwnerRepoFromGit,
  resolveGithubRestToken,
} from "./ci-gate-lib.js";
import { runDcoRung } from "./dco-lib.js";
import { type Env, type Exec, realExec } from "./lib.js";

export const FENCE_DRIVER_PATH = "scripts/upgrade-diff-fence.ts";

export const FENCE_MODULE_DIR = "scripts/upgrade-fence";

export type SpawnResult = { code: number; stdout: string; stderr: string; spawnError?: string };
export type SpawnDriver = (input: { command: string; args: string[]; env: Record<string, string>; cwd: string }) => Promise<SpawnResult>;

export const realSpawnDriver: SpawnDriver = ({ command, args, env, cwd }) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const rawCode = (err as { code?: unknown } | null)?.code;
      const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0;
      const spawnError = typeof rawCode === "string" ? `${rawCode}: ${(err as Error).message}` : undefined;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(spawnError ? { spawnError } : {}) });
    });
  });

export type FenceSubject = {
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  authorLogin: string;
  authorType: string;
  merged: boolean;
  mergeCommitSha?: string;
};

export type SubjectParse = { ok: true; subject: FenceSubject } | { ok: false; reason: string };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function parsePullRequestSubject(body: unknown): SubjectParse {
  const pr = record(body);
  if (!pr) return { ok: false, reason: "the pull-request response is not a JSON object" };

  const number = typeof pr.number === "number" ? pr.number : undefined;
  if (number === undefined) return { ok: false, reason: "the pull-request response carries no `number`" };

  const head = record(pr.head);
  const headSha = head ? str(head.sha) : undefined;
  if (!headSha) return { ok: false, reason: `pull request #${number} carries no \`head.sha\` — there is no proposal sha to fence` };

  const base = record(pr.base);
  const baseSha = base ? str(base.sha) : undefined;
  if (!baseSha) {
    return {
      ok: false,
      reason: `pull request #${number} carries no \`base.sha\` — the fence is executed from the BASE ref's copy, so without it there is no trustworthy fence to run`,
    };
  }

  const user = record(pr.user);
  const authorLogin = user ? (str(user.login) ?? "") : "";
  const authorType = user ? (str(user.type) ?? "") : "";
  if (!authorLogin && !authorType) {
    return {
      ok: false,
      reason: `pull request #${number} carries no \`user.login\` and no \`user.type\` — the bot-author signal is the fence's only non-forgeable arming signal, so an absent author is a refusal`,
    };
  }

  return {
    ok: true,
    subject: {
      number,
      headSha,
      baseSha,
      baseRef: base ? (str(base.ref) ?? "") : "",
      authorLogin,
      authorType,
      merged: pr.merged === true,
      ...(str(pr.merge_commit_sha) ? { mergeCommitSha: str(pr.merge_commit_sha) as string } : {}),
    },
  };
}

export type BaseFenceExtract = { ok: true; dir: string; files: string[] } | { ok: false; reason: string };

export async function extractBaseFence(input: { baseSha: string; exec?: Exec; tmpRoot?: string }): Promise<BaseFenceExtract> {
  const exec = input.exec ?? realExec;
  const short = input.baseSha.slice(0, 12);

  const haveObject = async (): Promise<boolean> => {
    const res = await exec("git", ["cat-file", "-e", `${input.baseSha}^{commit}`]);
    return !res.spawnError && res.code === 0;
  };

  if (!(await haveObject())) {
    const fetched = await exec("git", ["fetch", "--depth=1", "origin", input.baseSha]);
    if (fetched.spawnError) return { ok: false, reason: `could not run \`git\` (${fetched.spawnError}) — the fence cannot read the base ref without it` };
    if (!(await haveObject())) {
      return {
        ok: false,
        reason:
          `the pull request's base commit ${short} is not in this clone, and \`git fetch --depth=1 origin ${input.baseSha}\` did not bring it in ` +
          "— the fence must run the BASE ref's copy of itself, so it refuses rather than fall back to the head's.",
      };
    }
  }

  const listed = await exec("git", ["ls-tree", "-r", "--name-only", input.baseSha, `${FENCE_MODULE_DIR}/`]);
  if (listed.spawnError || listed.code !== 0) {
    const detail = listed.spawnError ?? `exited ${listed.code}: ${(listed.stderr || listed.stdout || "no output").trim().slice(0, 300)}`;
    return { ok: false, reason: `could not list ${FENCE_MODULE_DIR}/ at ${short} (${detail}) — refusing rather than running an unknown fence.` };
  }
  const modules = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (modules.length === 0) {
    return {
      ok: false,
      reason:
        `the base commit ${short} has no ${FENCE_MODULE_DIR}/ — there is no base-ref fence to run. ` +
        "The head's own copy is not a substitute: a fence the proposal can rewrite is not a fence.",
    };
  }

  const dir = mkdtempSync(join(input.tmpRoot ?? tmpdir(), "oe-merge-fence-"));

  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`, "utf8");

  const written: string[] = [];
  for (const path of [FENCE_DRIVER_PATH, ...modules]) {
    const shown = await exec("git", ["show", `${input.baseSha}:${path}`]);
    if (shown.spawnError || shown.code !== 0) {
      const detail = shown.spawnError ?? `exited ${shown.code}: ${(shown.stderr || shown.stdout || "no output").trim().slice(0, 300)}`;
      return { ok: false, reason: `could not read ${path} at ${short} (${detail}) — refusing rather than running a half-copied fence.` };
    }
    const relative = path.startsWith("scripts/") ? path.slice("scripts/".length) : path;
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, shown.stdout, "utf8");
    written.push(relative);
  }

  return { ok: true, dir, files: written };
}

export type MergeFenceDecision = {
  verdict: "clear" | "refuse";
  fence: "pass" | "warn" | "refuse" | "unknown";
  dco: "pass" | "refuse" | "unreadable" | "unknown";
  message: string;
  detail: string;
  subject?: FenceSubject;
};

export const GITHUB_API_URL_DEFAULT = "https://api.github.com";

function refuse(message: string, detail = "", subject?: FenceSubject): MergeFenceDecision {
  return { verdict: "refuse", fence: "unknown", dco: "unknown", message, detail, ...(subject ? { subject } : {}) };
}

export async function runMergeFence(input: {
  prNumber: number;
  expectedHeadSha?: string;
  requiredBaseRef?: string;
  exec?: Exec;
  fetchImpl?: GithubApiFetchLike;
  env?: Env;
  spawn?: SpawnDriver;
  tmpRoot?: string;
  cwd?: string;
  tsxCli?: string;
}): Promise<MergeFenceDecision> {
  const exec = input.exec ?? realExec;
  const fetchImpl = input.fetchImpl ?? realGithubApiFetch;
  const env = input.env ?? process.env;
  const spawn = input.spawn ?? realSpawnDriver;
  const cwd = input.cwd ?? process.cwd();
  const tsxCli = input.tsxCli ?? join(cwd, "node_modules", "tsx", "dist", "cli.mjs");

  const token = resolveGithubRestToken(env);
  if (!token) {
    return refuse(
      "no GitHub credential — set GH_TOKEN (or GITHUB_TOKEN) so the fence can read the pull request and its changed files. " +
        "A fence with no credential refuses; it never reports clean.",
    );
  }

  const ownerRepo = resolveGithubOwnerRepoFromEnv(env) ?? (await resolveGithubOwnerRepoFromGit(exec));
  if (!ownerRepo) {
    return refuse("neither GITHUB_REPOSITORY nor `git remote get-url origin` named a github.com owner/repo — the fence cannot tell which pull request to read.");
  }
  const repo = `${ownerRepo.owner}/${ownerRepo.repo}`;

  const raw = await fetchGithubApi({
    ghArgs: ["api", `repos/{owner}/{repo}/pulls/${input.prNumber}`, "--method", "GET"],
    restPathSuffix: `pulls/${input.prNumber}`,
    exec,
    fetchImpl,
    env,
  });
  if (!raw.ok) return refuse(`could not read pull request #${input.prNumber} (${raw.reason}) — refusing rather than merging unjudged.`);

  const parsed = parsePullRequestSubject(raw.body);
  if (!parsed.ok) return refuse(`${parsed.reason} — refusing rather than merging unjudged.`);
  const subject = parsed.subject;

  if (input.requiredBaseRef !== undefined && subject.baseRef !== input.requiredBaseRef) {
    return refuse(
      `pull request #${subject.number} targets \`${subject.baseRef || "(no base ref)"}\`, but this run may only execute the fence from \`${input.requiredBaseRef}\`. ` +
        "The fence is the BASE ref's own code, run in this process — a base the proposal controls would make this an arbitrary-code path. " +
        "Judge a stacked pull request from a session with no more authority than its author.",
      "",
      subject,
    );
  }

  if (subject.merged) {
    return refuse(
      `pull request #${subject.number} is already merged — this rung judges a PROPOSAL, and there is nothing left to fence. ` +
        "A fence that runs after merge is a gate on the consequence, not a fence.",
      "",
      subject,
    );
  }

  if (input.expectedHeadSha && input.expectedHeadSha !== subject.headSha) {
    return refuse(
      `pull request #${subject.number} has head ${subject.headSha.slice(0, 12)}, but this run was asked to clear ${input.expectedHeadSha.slice(0, 12)} — ` +
        "these must match exactly. Push, then re-run; clearing a sha the fence did not judge proves nothing.",
      "",
      subject,
    );
  }

  const extracted = await extractBaseFence({ baseSha: subject.baseSha, exec, ...(input.tmpRoot ? { tmpRoot: input.tmpRoot } : {}) });
  if (!extracted.ok) return refuse(extracted.reason, "", subject);

  const eventPath = join(extracted.dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: raw.body }), "utf8");

  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") inherited[key] = value;

  const driver = join(extracted.dir, FENCE_DRIVER_PATH.slice("scripts/".length));
  const ran = await spawn({
    command: process.execPath,
    args: [tsxCli, driver],
    cwd,
    env: {
      ...inherited,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: repo,
      GITHUB_TOKEN: token,
      GITHUB_API_URL: env.GITHUB_API_URL?.trim() || GITHUB_API_URL_DEFAULT,
    },
  });

  const report = `${ran.stdout}${ran.stderr}`.trim();
  if (ran.spawnError) {
    return refuse(`the fence driver never ran (${ran.spawnError}) — a fence that could not start must never read as a pass.`, report, subject);
  }
  if (ran.code !== 0) {
    return {
      verdict: "refuse",
      subject,
      fence: report.includes("REFUSED") ? "refuse" : "unknown",
      dco: "unknown",
      message:
        `the base-ref fence exited ${ran.code} for pull request #${subject.number} (head ${subject.headSha.slice(0, 12)}, base ${subject.baseSha.slice(0, 12)}). ` +
        "DO NOT MERGE. A guardrail change goes in its own hand-written pull request, opened by a person.",
      detail: report,
    };
  }

  const warned = report.includes("::warning file=");
  const fence = warned ? "warn" : "pass";
  const fenceMessage = warned
    ? `the base-ref fence WARNS on pull request #${subject.number}: it changes a protected path, and it reads as person-authored so the fence does not refuse it. Review those files as a guardrail change.`
    : `the base-ref fence passes pull request #${subject.number} (head ${subject.headSha.slice(0, 12)}, judged with the fence at base ${subject.baseRef || "?"}@${subject.baseSha.slice(0, 12)}).`;

  const dcoRun = await runDcoRung({ prNumber: subject.number, exec, fetchImpl, env });
  if (!dcoRun.ok) {
    return {
      verdict: "refuse",
      subject,
      fence,
      dco: "unreadable",
      message: `${fenceMessage} But the DCO sign-off rung could not judge the commits: ${dcoRun.reason} — refusing rather than clearing commits it did not read.`,
      detail: report,
    };
  }
  if (dcoRun.judgement.verdict === "refuse") {
    return {
      verdict: "refuse",
      subject,
      fence,
      dco: "refuse",
      message:
        `${fenceMessage} But the DCO sign-off rung REFUSES pull request #${subject.number}: ${dcoRun.judgement.message}\n` +
        "  The DCO is what CONTRIBUTING.md, the pull-request template, the README badge and AGENTS.md all state this project requires.",
      detail: report,
    };
  }

  return {
    verdict: "clear",
    subject,
    fence,
    dco: "pass",
    message: `${fenceMessage} DCO: ${dcoRun.judgement.message}`,
    detail: report,
  };
}
