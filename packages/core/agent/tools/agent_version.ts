import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { getAppInfo } from "../commands/core.js";

export default defineTool({
  description:
    "State which version of this agent is currently running: the deployment's commit sha, the eve framework version this deployment was built against, and the Open Everywhere package version where the build carries one. The commit sha is the identity that separates two builds — report it first. Use this to answer \"what version are you on?\" or to compare against an upstream release before proposing a self-upgrade. Never guesses — \"unknown\" means this deployment does not expose the fact (e.g. running locally, off Vercel), and \"unversioned\" means the build carries no package version, so the sha is the only answer.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    version: z
      .string()
      .describe(
        "The Open Everywhere package version, or \"unversioned\" when this build carries none (OPE-1057). A deployment that does not bump its own package.json is identified by deploymentSha, not by this field — do not report \"unversioned\" as a version number.",
      ),
    deploymentSha: z.string().describe("The commit sha this deployment was built from, or \"unknown\" if the platform doesn't expose it."),
    evePin: z.string().describe("The installed eve framework version, or \"unknown\" if it could not be resolved."),
  }),
  approval: never(),
  async execute() {
    const info = getAppInfo();
    return { version: info.version, deploymentSha: info.deploymentSha, evePin: info.evePin };
  },
});
