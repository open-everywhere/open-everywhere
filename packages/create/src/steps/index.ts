import type { SetupStep } from "../engine.js";
import { prerequisitesStep } from "./prerequisites.js";
import { repoStep } from "./repo.js";
import { rosterStep } from "./roster.js";
import { vercelStep } from "./vercel.js";
import { databaseStep } from "./database.js";
import { slackStep } from "./slack.js";
import { envChecklistStep } from "./env-checklist.js";
import { buildDeployStep } from "./build-deploy.js";
import { verifyStep } from "./verify.js";

export const SETUP_STEPS: readonly SetupStep[] = [
  prerequisitesStep,
  repoStep,
  rosterStep,
  vercelStep,
  databaseStep,
  slackStep,
  envChecklistStep,
  buildDeployStep,
  verifyStep,
];

export {
  prerequisitesStep,
  repoStep,
  rosterStep,
  vercelStep,
  databaseStep,
  slackStep,
  envChecklistStep,
  buildDeployStep,
  verifyStep,
};
