import type { StepContext, WizardStep } from "../engine.js";
import { prerequisitesStep } from "./prerequisites.js";
import { repoStep } from "./repo.js";
import { slackStep } from "./slack.js";
import { databaseStep } from "./database.js";
import { buildDeployStep } from "./build-deploy.js";

export function verifyVerdict(parts: {
  readonly prereq: boolean;
  readonly repo: boolean;
  readonly slack: boolean;
  readonly database: boolean;
  readonly build: boolean;
}): { satisfied: boolean; detail: string } {
  const failing = [
    !parts.prereq && "prerequisites",
    !parts.repo && "repo",
    !parts.slack && "slack (or another surface)",
    !parts.database && "durable state backing",
    !parts.build && "build",
  ].filter((x): x is string => Boolean(x));
  return {
    satisfied: failing.length === 0,
    detail: failing.length === 0
      ? "ready: prerequisites, repo, a surface, a durable state backing, and a build are all in place"
      : `not ready yet: ${failing.join(", ")}`,
  };
}

export const verifyStep: WizardStep = {
  id: "verify",
  title: "Final verification",
  async check(ctx: StepContext) {
    const [prereq, repo, slack, database, build] = await Promise.all([
      prerequisitesStep.check(ctx),
      repoStep.check(ctx),
      slackStep.check(ctx),
      databaseStep.check(ctx),
      buildDeployStep.check(ctx),
    ]);
    return verifyVerdict({
      prereq: prereq.satisfied,
      repo: repo.satisfied,
      slack: slack.satisfied,
      database: database.satisfied,
      build: build.satisfied,
    });
  },
  guide() {
    return {
      summary: "Before going live: run a real task in a pilot channel and check docs/deploy/setup-runbook.md's safety checklist (access bundles, egress enforcement, spend caps).",
      instructions: [
        "npm run access:preview -- --platform slack --workspace T_TEAM --channel C_CHANNEL",
        "npm run audit --org <org> — confirm actions land under the expected identity/scope.",
        "@mention the agent in the channel you wired up.",
      ],
    };
  },
};
