import { registerUserAuthFlow, registerOeOauthCallbackCompleter, registerCredentialPurgeHook } from "@open-everywhere/core/agent/adapter-api.js";
import { loadOeOauthConfig } from "./config.js";
import { makeOeOauth } from "./user-auth-flow.js";
import type { OeOauthProviderSource, OeOauthVaultDeps } from "./token-vault.js";

export interface RegisterOeOauthOptions {
  readonly providers?: OeOauthProviderSource;
  readonly deps?: OeOauthVaultDeps;
}

const declaredProviders = () => loadOeOauthConfig() ?? new Map();

export function registerOeOauth(opts: RegisterOeOauthOptions = {}) {
  const { flow, completer, purge } = makeOeOauth(opts.providers ?? declaredProviders, opts.deps ?? {});
  registerUserAuthFlow(flow);
  registerOeOauthCallbackCompleter(completer);
  registerCredentialPurgeHook("oe-oauth", purge);
  return { flow, completer, purge };
}
