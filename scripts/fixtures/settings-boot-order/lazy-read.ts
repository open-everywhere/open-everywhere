import { oneshotAgentEnabled } from "@open-everywhere/core/agent/access/delegation-flag.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";

export function delegates(): boolean {
  return oneshotAgentEnabled();
}

export const TABLE = {
  get delegates(): boolean {
    return oneshotAgentEnabled();
  },
};

export const AT_BUILD = getSettings(process.env, { delegation: { oneshotAgent: false } }).delegation.oneshotAgent;
