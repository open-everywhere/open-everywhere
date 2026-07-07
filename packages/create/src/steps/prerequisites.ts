import { execFileSync } from "node:child_process";
import type { WizardStep } from "../engine.js";

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const prerequisitesStep: WizardStep = {
  id: "prerequisites",
  title: "Prerequisites (Node 24, git)",
  check() {
    const major = nodeMajor();
    const git = gitAvailable();
    const satisfied = major >= 24 && git;
    const detail = satisfied
      ? `node ${process.versions.node}, git present`
      : `node ${process.versions.node}${major >= 24 ? "" : " (need 24.x)"}${git ? "" : ", git NOT found on PATH"}`;
    return { satisfied, detail };
  },
  guide() {
    return {
      summary: "Open Everywhere pins Node 24.x (engines) and needs git for cloning/PRs.",
      instructions: [
        "Install Node 24: `nvm install 24 && nvm use 24` (or your platform's installer).",
        "Install git if `git --version` fails (https://git-scm.com/downloads).",
      ],
    };
  },
};
