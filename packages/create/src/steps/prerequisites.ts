import { execFileSync } from "node:child_process";
import { coreNodeRange, nodeRangeSatisfied } from "@open-everywhere/core/agent/ops/package-info.js";
import type { SetupStep } from "../engine.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function nodeVerdict(version: string, range: string | undefined): { ok: boolean; detail: string } {
  if (range === undefined) return { ok: false, detail: `node ${version} (cannot read @open-everywhere/core's engines.node — run \`npm install\`)` };
  const ok = nodeRangeSatisfied(range, version);
  if (ok === undefined) return { ok: false, detail: `node ${version} (cannot parse the engines range "${range}")` };
  return { ok, detail: ok ? `node ${version}` : `node ${version} (need ${range})` };
}

export const prerequisitesStep: SetupStep = {
  id: "prerequisites",
  title: "Prerequisites (Node 24, git)",
  check() {
    const node = nodeVerdict(process.versions.node, coreNodeRange());
    const git = gitAvailable();
    const satisfied = node.ok && git;
    const detail = `${node.detail}${git ? ", git present" : ", git NOT found on PATH"}`;
    const next = !node.ok ? "nvm install 24 && nvm use 24" : !git ? "install git: https://git-scm.com/downloads" : undefined;
    return { satisfied, detail, next };
  },
  guide() {
    return {
      summary: `Open Everywhere needs the Node range @open-everywhere/core declares (${coreNodeRange() ?? "see its engines.node"}) and git.`,
      instructions: [
        "Install Node 24: `nvm install 24 && nvm use 24` (or your platform's installer).",
        "Install git if `git --version` fails (https://git-scm.com/downloads).",
      ],
    };
  },
};
