import { registerDirectoryProvider } from "@open-everywhere/core/agent/adapter-api.js";
import { loadOktaDirectoryConfig, oktaDirectoryEnabled } from "./config.js";
import { makeOktaDirectoryProvider, resolveOktaApiToken } from "./okta.js";

export interface DirectoryAdapterDeps {
  readonly resolveSecret?: (name: string) => Promise<{ readonly value: string; readonly source: string }>;
}

export function registerDirectoryAdapter(deps: DirectoryAdapterDeps = {}): string | null {
  if (!oktaDirectoryEnabled()) return null;
  const { resolveSecret } = deps;
  registerDirectoryProvider(
    makeOktaDirectoryProvider({
      config: loadOktaDirectoryConfig(),
      ...(resolveSecret ? { resolveToken: () => resolveOktaApiToken(resolveSecret) } : {}),
    }),
  );
  return "okta";
}
