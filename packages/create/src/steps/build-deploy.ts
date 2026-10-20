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
    ? "`docker compose up --build` on your server (the app's Dockerfile and docker-compose.yml; the deployment contract states what it must satisfy)"
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
          : "Deploy is a SEPARATE, explicit step: on your server, put the contract's environment in `.env` (with `OE_EGRESS_PROXY_TOKEN`), declare `egress: { proxyUrl: \"http://oe-egress-proxy:8080\", denialLog: \"/var/log/oe-egress/denied.log\" }` in `agent/settings/settings.ts`, then run `docker compose up --build`. The app's `Dockerfile` builds the image, and `docker-compose.yml` puts it behind the egress proxy with Postgres. This stack runs the `justbash` sandbox backend: the agent's shell shares the app process's filesystem and environment. That is development grade, and it does not meet the contract's `sandbox-backend` requirement. See https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/contract.md.",
        "Then re-run `npx @open-everywhere/create --check --host https://<host>`: it probes the deployed Slack route.",
        "The probe passes on the route's own `401 unauthorized`, which proves the function booted and the route is mounted. It does NOT prove the deployment holds SLACK_SIGNING_SECRET: the route answers the same without it. Only Event Subscriptions showing **Verified** in the Slack console proves that.",
      ],
    };
  },
};
