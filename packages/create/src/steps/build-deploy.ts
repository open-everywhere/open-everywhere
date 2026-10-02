import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { routeOf, type SetupStep, type StepContext } from "../engine.js";
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

function deployCommand(ctx: StepContext): string {
  return routeOf(ctx) === "docker"
    ? "build the image and run it on your server (the deployment contract states what it must satisfy)"
    : "npx vercel deploy --prod";
}

export const buildDeployStep: SetupStep = {
  id: "build-deploy",
  title: "Build + deploy",
  async check(ctx: StepContext) {
    if (!buildOutputPresent(ctx.cwd)) return { satisfied: false, detail: "not built yet", next: "npm run build" };
    const origin = deployOrigin(ctx);
    if (origin === undefined) {
      return {
        satisfied: false,
        detail: "built. The deploy is unproven: no host to probe",
        next: `${deployCommand(ctx)}, then re-run with --host https://<host>`,
      };
    }
    const probe = await probeDeployment(origin);
    return probe.ok
      ? { satisfied: true, detail: probe.detail }
      : { satisfied: false, detail: probe.detail, next: `${deployCommand(ctx)}, then re-run this check` };
  },
  guide(ctx: StepContext) {
    const vercel = routeOf(ctx) === "vercel";
    return {
      summary: "Build before you deploy — a broken build must never be promoted.",
      instructions: [
        "`npm run build` (= `oe build`, then `eve build`) — must be green.",
        vercel
          ? "Deploy is a SEPARATE, explicit step: `npx vercel deploy --prod` (confirm the scope and team first). A `git push` does NOT deploy."
          : "Deploy is a SEPARATE, explicit step: build the image and run it on your server, with the contract's environment set. See https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/contract.md.",
        "Then re-run `npx @open-everywhere/create --check --host https://<host>`: it probes the deployed Slack route.",
        "The probe passes on the route's own `401 unauthorized`, which proves the function booted and the route is mounted. It does NOT prove the deployment holds SLACK_SIGNING_SECRET: the route answers the same without it. Only Event Subscriptions showing **Verified** in the Slack console proves that.",
      ],
    };
  },
};
