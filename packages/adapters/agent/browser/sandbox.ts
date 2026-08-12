import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { onVercel } from "@open-everywhere/core/agent/adapter-api.js";
import { agentBrowserEnabled, loadAgentBrowserConfig } from "./config.js";

export interface BakeableSandbox {
  readonly id: string;
  run(options: { readonly command: string }): PromiseLike<{ readonly exitCode?: number; readonly stderr?: string; readonly stdout?: string }>;
}

export interface AgentBrowserSandboxHooks {
  readonly revalidationKey: () => string;
  readonly bootstrap: (input: { use: () => Promise<BakeableSandbox> }) => Promise<void>;
}

export function agentBrowserSandboxHooks(
  install: (sandbox: BakeableSandbox) => Promise<unknown> = (sandbox) => installAgentBrowser(sandbox),
): AgentBrowserSandboxHooks | Record<string, never> {
  if (!agentBrowserEnabled()) return {};
  const cfg = loadAgentBrowserConfig();
  if (cfg === undefined) return {};
  if (!onVercel()) {
    console.error(
      "[open-everywhere:agent-browser] browser.enabled: true but this is not the Vercel Sandbox backend — " +
        "NOT baking the browser (the self-host image has no Chromium; the Browser-QA MVP posture).",
    );
    return {};
  }
  return {
    revalidationKey: () => agentBrowserRevalidationKey(),
    bootstrap: async ({ use }) => {
      const sandbox = await use();
      await install(sandbox);
    },
  };
}
