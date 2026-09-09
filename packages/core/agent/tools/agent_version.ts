import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { getAppInfo } from "../commands/core.js";

export default defineTool({
  description:
    "State which version of this agent is currently running: the deployment's commit sha, the eve framework version this deployment was built against, the Open Everywhere package version where the build carries one, and this deployment's context window with the token count at which compaction fires. The commit sha is the identity that separates two builds — report it first. Use this to answer \"what version are you on?\", \"how big is your context window?\" or \"when do you compact?\", or to compare against an upstream release before proposing a self-upgrade. Never guesses — \"unknown\" means this deployment does not expose the fact (e.g. running locally, off Vercel), \"unversioned\" means the build carries no package version, so the sha is the only answer, and an ABSENT token count means this deployment registered none.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    version: z
      .string()
      .describe(
        "The Open Everywhere package version, or \"unversioned\" when this build carries none (OPE-1057). A deployment that does not bump its own package.json is identified by deploymentSha, not by this field — do not report \"unversioned\" as a version number.",
      ),
    deploymentSha: z.string().describe("The commit sha this deployment was built from, or \"unknown\" if the platform doesn't expose it."),
    evePin: z.string().describe("The installed eve framework version, or \"unknown\" if it could not be resolved."),
    contextWindowTokens: z
      .number()
      .optional()
      .describe(
        "The primary model's context window, in tokens. ABSENT when this deployment registered no window — never a default, and never derived from the model id.",
      ),
    compactionThresholdTokens: z
      .number()
      .optional()
      .describe(
        "The absolute token count at which compaction fires: the context window times the configured threshold percent. ABSENT when this deployment registered no window. This is the same number `/oe status` prints.",
      ),
  }),
  approval: never(),
  async execute() {
    const info = getAppInfo();
    return {
      version: info.version,
      deploymentSha: info.deploymentSha,
      evePin: info.evePin,
      contextWindowTokens: info.contextWindowTokens,
      compactionThresholdTokens: info.compactionThresholdTokens,
    };
  },
});
