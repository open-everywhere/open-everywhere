import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { getAppInfo } from "../commands/core.js";

export default defineTool({
  description:
    "State which version of this agent is currently running: the Open Everywhere package version, the deployment's commit sha, and the eve framework version this deployment was built against. Use this to answer \"what version are you on?\" or to compare against an upstream release before proposing a self-upgrade. Never guesses — \"unknown\" means this deployment does not expose the fact (e.g. running locally, off Vercel).",
  inputSchema: z.object({}),
  outputSchema: z.object({
    version: z.string().describe("The Open Everywhere package version (this app's own package.json)."),
    deploymentSha: z.string().describe("The commit sha this deployment was built from, or \"unknown\" if the platform doesn't expose it."),
    evePin: z.string().describe("The installed eve framework version, or \"unknown\" if it could not be resolved."),
  }),
  approval: never(),
  async execute() {
    const info = getAppInfo();
    return { version: info.version, deploymentSha: info.deploymentSha, evePin: info.evePin };
  },
});
