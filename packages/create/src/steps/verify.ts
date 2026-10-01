import type { StepContext, WizardStep } from "../engine.js";
import { prerequisitesStep } from "./prerequisites.js";
import { repoStep } from "./repo.js";
import { slackStep } from "./slack.js";
import { databaseStep } from "./database.js";
import { buildDeployStep } from "./build-deploy.js";
import { rosterStep } from "./roster.js";
import { envChecklistStep } from "./env-checklist.js";
import { goalOf } from "../engine.js";

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

export const verifyStep: WizardStep = {
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
        goalOf(ctx) === "local"
          ? "npm run dev"
          : "confirm the Slack app's Event Subscriptions shows the request URL as Verified (that proves SLACK_SIGNING_SECRET on the deployment; this check cannot), then send the app a direct message",
    };
  },
  guide() {
    return {
      summary: "Before going live, run a real task in a pilot channel and walk the setup runbook's safety checklist (access bundles, egress enforcement, spend caps).",
      instructions: [
        "Send the app a direct message in Slack, then @mention it in a channel you invited it to.",
        "Safety checklist: https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-runbook.md#safety-checklist-the-anti-footgun-list",
      ],
    };
  },
};
