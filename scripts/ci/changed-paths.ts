import type { Exec } from "../deploy/lib.js";
import { realExec } from "../deploy/lib.js";

const ZERO_SHA = "0000000000000000000000000000000000000000";

export function isRealSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(sha) && sha.toLowerCase() !== ZERO_SHA;
}

export type ChangedPathsResult = { ok: true; paths: string[] } | { ok: false; reason: string };

export async function fetchChangedPaths(input: { before: string; after: string; exec?: Exec }): Promise<ChangedPathsResult> {
  const exec = input.exec ?? realExec;
  if (!isRealSha(input.before) || !isRealSha(input.after)) {
    return {
      ok: false,
      reason: `before=${input.before} / after=${input.after} is not a resolvable commit pair (likely the all-zero sentinel sha of a branch's first push)`,
    };
  }
  const res = await exec("git", ["diff", "--name-only", input.before, input.after]);
  if (res.spawnError) {
    return { ok: false, reason: `could not run \`git diff\` (${res.spawnError})` };
  }
  if (res.code !== 0) {
    return {
      ok: false,
      reason: `\`git diff --name-only ${input.before} ${input.after}\` exited ${res.code}: ${(res.stderr || res.stdout || "no output").trim().slice(0, 500)}`,
    };
  }
  const paths = res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ok: true, paths };
}
