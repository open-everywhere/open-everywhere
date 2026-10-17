import { registerCredentialPurgeHook, registerLongLivedBoxBackend } from "@open-everywhere/core/agent/adapter-api.js";
import { makeOeOauth } from "./oe-oauth/user-auth-flow.js";
import { loadOeOauthConfig } from "./oe-oauth/config.js";
import { makeAwsSsoPurgeHook } from "./aws/sso.js";
import { createDockerBoxBackend, createVercelBoxBackend } from "./sandbox/long-lived-box.js";

export const OPERATOR_BOX_BACKENDS = ["vercel", "docker"] as const;
export type OperatorBoxBackend = (typeof OPERATOR_BOX_BACKENDS)[number];

export interface OperatorHolders {
  readonly purgeHooks: readonly string[];
  readonly boxBackend: OperatorBoxBackend | undefined;
}

export function registerOperatorHolders(opts: { readonly boxBackend?: OperatorBoxBackend } = {}): OperatorHolders {
  const { purge } = makeOeOauth(() => loadOeOauthConfig() ?? new Map());
  registerCredentialPurgeHook("oe-oauth", purge);
  registerCredentialPurgeHook("aws-sso", makeAwsSsoPurgeHook());
  if (opts.boxBackend === "vercel") registerLongLivedBoxBackend(createVercelBoxBackend());
  else if (opts.boxBackend === "docker") registerLongLivedBoxBackend(createDockerBoxBackend());
  return { purgeHooks: ["oe-oauth", "aws-sso"], boxBackend: opts.boxBackend };
}
