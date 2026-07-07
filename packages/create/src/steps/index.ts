import type { WizardStep } from "../engine.js";
import { prerequisitesStep } from "./prerequisites.js";
import { repoStep } from "./repo.js";
import { vercelStep } from "./vercel.js";
import { databaseStep } from "./database.js";
import { slackStep } from "./slack.js";
import { envChecklistStep } from "./env-checklist.js";
import { telemetryDisclosureStep } from "./telemetry-disclosure.js";
import { buildDeployStep } from "./build-deploy.js";
import { verifyStep } from "./verify.js";

export const WIZARD_STEPS: readonly WizardStep[] = [
  prerequisitesStep,
  repoStep,
  vercelStep,
  databaseStep,
  slackStep,
  envChecklistStep,
  telemetryDisclosureStep,
  buildDeployStep,
  verifyStep,
];

export {
  prerequisitesStep,
  repoStep,
  vercelStep,
  databaseStep,
  slackStep,
  envChecklistStep,
  telemetryDisclosureStep,
  buildDeployStep,
  verifyStep,
};
