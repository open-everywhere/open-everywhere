import { registerDirectoryProvider } from "@open-everywhere/core/agent/adapter-api.js";
import { loadOktaDirectoryConfig, oktaDirectoryEnabled } from "./config.js";
import { makeOktaDirectoryProvider } from "./okta.js";

export function registerDirectoryAdapter(): string | null {
  if (!oktaDirectoryEnabled()) return null;
  registerDirectoryProvider(makeOktaDirectoryProvider({ config: loadOktaDirectoryConfig() }));
  return "okta";
}
