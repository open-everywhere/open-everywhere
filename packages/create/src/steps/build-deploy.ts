import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { StepContext, WizardIO, WizardStep } from "../engine.js";
import { npmCommand } from "../npm.js";

function nonEmptyDir(p: string): boolean {
  try {
    return existsSync(p) && readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

export const buildDeployStep: WizardStep = {
  id: "build-deploy",
  title: "Build + deploy",
  check(ctx: StepContext) {
    const built = nonEmptyDir(join(ctx.cwd, ".output")) || nonEmptyDir(join(ctx.cwd, ".vercel", "output"));
    return { satisfied: built, detail: built ? "a build output directory exists (re-build after any source change!)" : "not built yet" };
  },
  guide() {
    return {
      summary: "Build before you deploy — a broken build must never be promoted (AGENTS.md).",
      instructions: [
        "`npm run build` (= `eve build`) — must be green.",
        "Deploy is a SEPARATE, explicit step this wizard will not run for you: `vercel deploy --prod` (confirm the scope/team first).",
        "`git push` does NOT deploy — pushing only updates the repo.",
      ],
    };
  },
  async automate(ctx: StepContext, io: WizardIO) {
    const wantsBuild = await io.confirm("Run `npm run build` now?");
    if (!wantsBuild) return { ran: false, ok: false, detail: "skipped" };
    const [command, args] = npmCommand(["run", "build"], ctx.env);
    const result = spawnSync(command, args, { cwd: ctx.cwd, stdio: "inherit", env: ctx.env });
    const ok = result.status === 0;
    return { ran: true, ok, detail: ok ? "build succeeded" : `build failed (exit ${result.status ?? "unknown"})` };
  },
};
