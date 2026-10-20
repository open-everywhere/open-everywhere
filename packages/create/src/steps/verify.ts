import { routeOf, type SetupStep, type StepContext } from "../engine.js";
import { prerequisitesStep } from "./prerequisites.js";
import { repoStep } from "./repo.js";
import { slackStep } from "./slack.js";
import { databaseStep } from "./database.js";
import { buildDeployStep } from "./build-deploy.js";
import { rosterStep } from "./roster.js";
import { envChecklistStep } from "./env-checklist.js";

const DEPLOYMENT_ENV_NAMES = ["DATABASE_URL", "OE_CREDENTIAL_ENCRYPTION_KEY", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;

export function verifyVerdict(parts: {
  readonly prereq: boolean;
  readonly repo: boolean;
  readonly slack: boolean;
  readonly database: boolean;
  readonly build: boolean;
  readonly roster?: boolean;
  readonly env?: boolean;
}): { satisfied: boolean; detail: string } {
  const failing = [
    !parts.prereq && "prerequisites",
    !parts.repo && "repo",
    parts.roster === false && "roster",
    parts.env === false && "env vars",
    !parts.slack && "slack (or another surface)",
    !parts.database && "durable state backing",
    !parts.build && "build",
  ].filter((x): x is string => Boolean(x));
  return {
    satisfied: failing.length === 0,
    detail: failing.length === 0
      ? "ready: every step this check can see is in place"
      : `not ready yet: ${failing.join(", ")}`,
  };
}

export const verifyStep: SetupStep = {
  id: "verify",
  title: "Final verification",
  async check(ctx: StepContext) {
    const [prereq, repo, roster, slack, database, env, build] = await Promise.all([
      prerequisitesStep.check(ctx),
      repoStep.check(ctx),
      rosterStep.check(ctx),
      slackStep.check(ctx),
      databaseStep.check(ctx),
      envChecklistStep.check(ctx),
      buildDeployStep.check(ctx),
    ]);
    const verdict = verifyVerdict({
      prereq: prereq.satisfied,
      repo: repo.satisfied,
      roster: roster.satisfied,
      slack: slack.satisfied,
      database: database.satisfied,
      env: env.satisfied,
      build: build.satisfied,
    });
    if (!verdict.satisfied) return { ...verdict, next: "follow the `next` of each unsatisfied step above, then re-run this check" };
    return {
      ...verdict,
      next:
        "set the deployment's OWN environment — this check never reads it: " +
        `${DEPLOYMENT_ENV_NAMES.join(", ")} (${routeOf(ctx) === "docker" ? "the container's environment" : "the Vercel project's Production environment"}). ` +
        "Then confirm the Slack app's Event Subscriptions shows the request URL as Verified (that proves SLACK_SIGNING_SECRET on the deployment; this check cannot), and send the app a direct message",
    };
  },
  guide(ctx: StepContext) {
    const vercel = routeOf(ctx) === "vercel";
    return {
      summary: "Before going live, run a real task in a pilot channel and walk the setup runbook's safety checklist (access bundles, egress enforcement, spend caps).",
      instructions: [
        `🔴 THIS CHECK NEVER READS THE DEPLOYMENT'S OWN ENVIRONMENT. Every step above reads .env.local and your shell. \`.env.local\` is gitignored and never ships, so the deployment reads only what you set ON it: ${DEPLOYMENT_ENV_NAMES.join(", ")}. A full house here says nothing about any of them.`,
        vercel
          ? "Set each one for Production without printing it: `npm run -s env:pipe -- <NAME> | npx vercel env add <NAME> production`. Always pipe it straight into `vercel env add`; never run `env:pipe` bare, because a shell that is not a terminal prints the value. The Neon integration already set DATABASE_URL there, and it selects postgres for both stores on its own — no provider selector to push. A variable added after a deploy reaches the functions only on the NEXT deploy."
          : "Set each one in the container's environment (a compose file, your orchestrator's secret store — not a tracked file). DATABASE_URL selects postgres for both stores on its own. A variable added after the container starts reaches the app only on the next start.",
        "Mint OE_CREDENTIAL_ENCRYPTION_KEY with the ops tool `scaffold_credential_key`, which writes it to .env.local and never prints it. Without it the encrypted credential store fails closed on every read and write.",
        "Not needed on a deployment: the two store selectors (DATABASE_URL resolves both), OE_PUBLIC_BASE_URL (only for a custom domain) and OE_INTAKE_PAGE_SIGNING_KEY (not an env var since 0.9.0: the deployment mints it into the credential store). On the Vercel route, AI_GATEWAY_API_KEY is not needed either — OIDC covers it.",
        "Send the app a direct message in Slack, then @mention it in a channel you invited it to.",
        "Safety checklist: https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-runbook.md#safety-checklist-the-anti-footgun-list",
      ],
    };
  },
};
