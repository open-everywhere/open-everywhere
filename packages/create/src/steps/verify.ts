import type { StepContext, WizardStep } from "../engine.js";
import { prerequisitesStep } from "./prerequisites.js";
import { repoStep } from "./repo.js";
import { slackStep } from "./slack.js";
import { buildDeployStep } from "./build-deploy.js";

export const verifyStep: WizardStep = {
  id: "verify",
  title: "Final verification",
  async check(ctx: StepContext) {
    const [prereq, repo, slack, build] = await Promise.all([
      prerequisitesStep.check(ctx),
      repoStep.check(ctx),
      slackStep.check(ctx),
      buildDeployStep.check(ctx),
    ]);
    const satisfied = prereq.satisfied && repo.satisfied && slack.satisfied && build.satisfied;
    const failing = [
      !prereq.satisfied && "prerequisites",
      !repo.satisfied && "repo",
      !slack.satisfied && "slack (or another surface)",
      !build.satisfied && "build",
    ].filter((x): x is string => Boolean(x));
    return {
      satisfied,
      detail: satisfied ? "ready: prerequisites, repo, a surface, and a build are all in place" : `not ready yet: ${failing.join(", ")}`,
    };
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
