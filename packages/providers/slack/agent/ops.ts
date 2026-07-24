import { registerQuickstartSurfaceGoal, registerSurfaceCredentialProbe } from "@open-everywhere/core/agent/adapter-api.js";

const set = (v: string | undefined): boolean => v !== undefined && v !== "";

export function registerSlackOps(): void {
  registerQuickstartSurfaceGoal("slack", (env) => {
    const ok = set(env.SLACK_BOT_TOKEN) && set(env.SLACK_SIGNING_SECRET);
    return {
      id: "slack",
      title: "Slack app",
      status: ok ? "done" : "todo",
      detail: "Create a Slack app; subscribe to app_mention + message.im; copy the bot token + signing secret.",
      command: ok ? undefined : "set SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET in .env.local",
    };
  });
  registerSurfaceCredentialProbe("slack", () => Boolean(process.env.SLACK_BOT_TOKEN));
}
