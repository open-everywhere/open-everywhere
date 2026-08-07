import { registerUserAuthFlow, registerOeOauthCallbackCompleter, registerCredentialPurgeHook } from "@open-everywhere/core/agent/adapter-api.js";
import { loadOeOauthConfig, type OeOauthProviderConfig } from "./config.js";
import { makeOeOauth } from "./user-auth-flow.js";
import type { OeOauthVaultDeps } from "./token-vault.js";

export interface RegisterOeOauthOptions {
  readonly providers?: ReadonlyMap<string, OeOauthProviderConfig>;
  readonly deps?: OeOauthVaultDeps;
}

export function registerOeOauth(opts: RegisterOeOauthOptions = {}) {
  const providers = opts.providers ?? loadOeOauthConfig();
  if (!providers || providers.size === 0) {
    throw new Error("registerOeOauth: no oe-oauth provider config (set OE_OAUTH_CONFIG / OE_OAUTH_NOTION_RESOURCE).");
  }
  const { flow, completer, purge } = makeOeOauth(providers, opts.deps ?? {});
  registerUserAuthFlow(flow);
  registerOeOauthCallbackCompleter(completer);
  registerCredentialPurgeHook(purge);
  return { flow, completer, purge };
}
