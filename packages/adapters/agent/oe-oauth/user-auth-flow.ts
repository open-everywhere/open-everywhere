import type { TokenResult } from "eve/connections";
import type { UserAuthFlowProvider, UserAuthSubject, UserTokenMintParams, OeOauthCallbackCompleter, CredentialPurgeHook } from "@open-everywhere/core/agent/adapter-api.js";
import type { OeOauthProviderConfig } from "./config.js";
import { makeOeOauthTokenVault, type OeOauthVaultDeps, type OeOauthSubject } from "./token-vault.js";
import { isUserAuthRequiredError } from "./errors.js";

function toVaultSubject(subject: UserAuthSubject): OeOauthSubject {
  return subject.type === "app" ? { type: "app" } : { type: "user", id: subject.id };
}

export function makeOeOauth(
  providers: ReadonlyMap<string, OeOauthProviderConfig>,
  deps: OeOauthVaultDeps = {},
): { readonly flow: UserAuthFlowProvider; readonly completer: OeOauthCallbackCompleter; readonly purge: CredentialPurgeHook } {
  const vault = makeOeOauthTokenVault(providers, deps);

  const flow: UserAuthFlowProvider = {
    async mintServiceToken(providerRef: string, _getTokenOptions: unknown): Promise<TokenResult> {
      return { token: await vault.accessTokenFor(providerRef, { type: "app" }) };
    },
    async mintUserToken(providerRef: string, params: UserTokenMintParams): Promise<TokenResult> {
      return { token: await vault.accessTokenFor(providerRef, { type: "user", id: params.subject.id }) };
    },
    async startAuthorization(providerRef, params, options): Promise<{ url: string }> {
      return vault.startAuthorization(providerRef, toVaultSubject(params.subject), { ...(options.expiresInMs ? { expiresInMs: options.expiresInMs } : {}) });
    },
    isUserAuthRequired(e: unknown): boolean {
      return isUserAuthRequiredError(e);
    },
    async environmentClaim(): Promise<string> {
      return "self";
    },
    async hasFreshGrant(providerRef: string, subject: UserAuthSubject): Promise<boolean> {
      try {
        return await vault.hasToken(providerRef, toVaultSubject(subject));
      } catch {
        return false;
      }
    },
  };

  const completer: OeOauthCallbackCompleter = async ({ state, code }) => {
    try {
      const { providerRef } = await vault.completeAuthorization(state, code);
      return { ok: true, connectionName: providerRef };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };

  const purge: CredentialPurgeHook = {
    async purgeSubject(subjectId: string): Promise<number> {
      return vault.forgetAll({ type: "user", id: subjectId });
    },
  };

  return { flow, completer, purge };
}
