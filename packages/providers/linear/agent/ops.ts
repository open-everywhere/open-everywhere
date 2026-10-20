import { registerOperatorSecretNames } from "@open-everywhere/core/agent/adapter-api-ops.js";

export function registerLinearOps(): void {
  registerOperatorSecretNames([
    "LINEAR_AGENT_ACCESS_TOKEN",
    "LINEAR_ACCESS_TOKEN",
    "LINEAR_API_KEY",
    "LINEAR_API_TOKEN",
    "LINEAR_CLIENT_SECRET",
    "LINEAR_WEBHOOK_SECRET",
  ]);
}
