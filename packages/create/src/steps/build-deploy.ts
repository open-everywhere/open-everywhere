import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { goalOf, type StepContext, type WizardIO, type WizardStep } from "../engine.js";
import { npmCommand } from "../npm.js";
import { mergedEnv } from "../env-file.js";
import { normalizeHost, probeDeployment } from "../deploy-probe.js";

function nonEmptyDir(p: string): boolean {
  try {
    return existsSync(p) && readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function buildOutputPresent(cwd: string): boolean {
  return nonEmptyDir(join(cwd, ".output")) || nonEmptyDir(join(cwd, ".vercel", "output"));
}

function deployOrigin(ctx: StepContext): string | undefined {
  if (ctx.host !== undefined) return normalizeHost(ctx.host);
  const fromEnv = mergedEnv(ctx.cwd, ctx.env).OE_PUBLIC_BASE_URL;
  return fromEnv ? normalizeHost(fromEnv) : undefined;
}

export const buildDeployStep: WizardStep = {
  id: "build-deploy",
  title: "Build + deploy",
  async check(ctx: StepContext) {
    if (goalOf(ctx) === "local") {
      return { satisfied: true, detail: "not needed for a local run: `npm run dev` runs `oe build` itself" };
    }
    if (!buildOutputPresent(ctx.cwd)) return { satisfied: false, detail: "not built yet", next: "npm run build" };
    const origin = deployOrigin(ctx);
    if (origin === undefined) {
      return {
        satisfied: false,
        detail: "built. The deploy is unproven: no host to probe",
        next: "npx vercel deploy --prod, then re-run with --host https://<host> (the host the deploy prints)",
      };
    }
    const probe = await probeDeployment(origin);
    return probe.ok
      ? { satisfied: true, detail: probe.detail }
      : { satisfied: false, detail: probe.detail, next: "npx vercel deploy --prod, then re-run this check" };
  },
  guide() {
    return {
      summary: "Build before you deploy — a broken build must never be promoted.",
      instructions: [
        "`npm run build` (= `oe build`, then `eve build`) — must be green.",
        "Deploy is a SEPARATE, explicit step this wizard will not run for you: `npx vercel deploy --prod` (confirm the scope/team first).",
        "`git push` does NOT deploy — pushing only updates the repo.",
        "Then re-run `npx create-open-everywhere --check --host https://<host>`: it probes the deployed Slack route.",
      ],
    };
  },
  async automate(ctx: StepContext, io: WizardIO) {
    if (buildOutputPresent(ctx.cwd)) return { ran: false, ok: false, detail: "built — deploy with `npx vercel deploy --prod`, then re-run with --host" };
    const wantsBuild = await io.confirm("Run `npm run build` now?");
    if (!wantsBuild) return { ran: false, ok: false, detail: "skipped" };
    const [command, args] = npmCommand(["run", "build"], ctx.env);
    const result = spawnSync(command, args, { cwd: ctx.cwd, stdio: "inherit", env: ctx.env });
    const ok = result.status === 0;
    return { ran: true, ok, detail: ok ? "build succeeded" : `build failed (exit ${result.status ?? "unknown"})` };
  },
};
