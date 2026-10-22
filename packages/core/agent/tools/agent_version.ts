import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { getAppInfo } from "../commands/app-info.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { renderAgentSetup, type AgentSetupAnswer } from "../status/agent-setup.js";
import { gatherAgentSetupFacts } from "../status/agent-setup-live.js";
import { publicUrlAnswer, publicUrlDisclosed, publicUrlFacts, type PublicUrlAnswer } from "../status/public-url.js";

export default defineTool({
  description:
    "State which version of this agent is currently running, and how it is set up for the person asking: the deployment's commit sha, the eve framework version this deployment was built against, the Open Everywhere package version where the build carries one, and this deployment's context window with the token count at which compaction fires. The commit sha is the identity that separates two builds — report it first. Use this to answer \"what version are you on?\", \"how big is your context window?\" or \"when do you compact?\", or to compare against an upstream release before proposing a self-upgrade. Its `publicUrl` part answers \"what is your URL?\", \"what is your OAuth callback URL?\" and \"what redirect URI do I give <service>?\" with the full value: every OAuth service, Notion included, uses the one callback URL. Its `setup` part answers \"who are your admins?\", \"am I an admin?\", \"are you connected to GitHub?\" and \"what can an admin change from chat?\" from the live config, in plain words ready to say, with the one step that fixes each gap; say `forOperator` only to an admin who asks how to fix a gap. Never guesses — \"unknown\" means this deployment does not expose the fact (e.g. running locally, off Vercel), \"unversioned\" means the build carries no package version, so the sha is the only answer, and an ABSENT token count means this deployment registered none.",
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
        "The absolute token count at which compaction fires: the context window times the configured threshold percent. ABSENT when this deployment registered no window. This is the same number the status control command prints.",
      ),
    setup: z
      .object({
        you: z.string().describe("The asker's own standing, as one direct sentence."),
        admins: z.string().describe("Who the admins are."),
        connectedTo: z.array(z.string()).describe("What this deployment is connected to, one line each."),
        adminCanDoNow: z.array(z.string()).describe("What an admin can do from chat right now. For a non-admin, one line saying an admin does it."),
        notYet: z.array(z.object({ what: z.string(), step: z.string() })).describe("What an admin cannot do yet, each with the one step that unlocks it."),
        forOperator: z.array(z.string()).describe("The deployment settings behind each gap. Only for an admin who asks how to fix it."),
      })
      .optional()
      .describe("This deployment's setup for the person asking (OPE-2492). ABSENT when it could not be read."),
    publicUrl: z
      .object({
        baseUrl: z.string().optional().describe("This deployment's own web address. ABSENT when none is set, or when this conversation may include people from outside the organisation."),
        oauthCallbackUrl: z
          .string()
          .optional()
          .describe("The one OAuth callback URL (the redirect URI) every OAuth sign-in on this deployment uses, Notion included. Present exactly when baseUrl is."),
        note: z.string().describe("One plain sentence to say with it, or instead of it when the address is absent."),
        forOperator: z.string().optional().describe("The setting behind a gap. Say it only to an admin who asks how to fix it."),
      })
      .optional()
      .describe("This deployment's own address (OPE-2669). ABSENT when it could not be read."),
  }),
  approval: never(),
  async execute(_input, ctx) {
    const info = getAppInfo();
    let setup: AgentSetupAnswer | undefined;
    try {
      setup = renderAgentSetup(await gatherAgentSetupFacts(ctx as BindableContext));
    } catch {
      setup = undefined;
    }
    let publicUrl: PublicUrlAnswer | undefined;
    try {
      publicUrl = publicUrlAnswer(publicUrlFacts(), publicUrlDisclosed(bindFrom(ctx as BindableContext)));
    } catch {
      publicUrl = undefined;
    }
    return {
      version: info.version,
      deploymentSha: info.deploymentSha,
      evePin: info.evePin,
      contextWindowTokens: info.contextWindowTokens,
      compactionThresholdTokens: info.compactionThresholdTokens,
      ...(setup !== undefined
        ? { setup: { ...setup, connectedTo: [...setup.connectedTo], adminCanDoNow: [...setup.adminCanDoNow], notYet: setup.notYet.map((g) => ({ ...g })), forOperator: [...setup.forOperator] } }
        : {}),
      ...(publicUrl !== undefined ? { publicUrl: { ...publicUrl } } : {}),
    };
  },
});
