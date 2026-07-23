import type { TokenResult } from "eve/connections";

export type UserAuthSubject =
  | { readonly type: "user"; readonly id: string; readonly issuer?: string }
  | { readonly type: "app" };

export interface UserTokenMintParams {
  readonly subject: { readonly type: "user"; readonly id: string; readonly issuer?: string };
  readonly scopes?: readonly string[];
  readonly resources?: readonly string[];
}

export interface UserAuthFlowProvider {
  mintServiceToken(providerRef: string, getTokenOptions: unknown): Promise<TokenResult>;
  mintUserToken(providerRef: string, params: UserTokenMintParams): Promise<TokenResult>;
  startAuthorization(
    providerRef: string,
    params: { readonly subject: UserAuthSubject },
    options: { readonly expiresInMs?: number },
  ): Promise<{ url: string }>;
  isUserAuthRequired(error: unknown): boolean;
  environmentClaim(): Promise<string>;
  hasFreshGrant?(providerRef: string, subject: UserAuthSubject): Promise<boolean>;
}

let registeredFlow: UserAuthFlowProvider | undefined;

export function registerUserAuthFlow(flow: UserAuthFlowProvider): void {
  registeredFlow = flow;
}

export function resetUserAuthFlow(): void {
  registeredFlow = undefined;
}

export function userAuthFlowProvider(): UserAuthFlowProvider | undefined {
  return registeredFlow;
}

export function requireUserAuthFlow(connector: string): UserAuthFlowProvider {
  if (!registeredFlow) {
    throw new Error(
      `connection "${connector}": no user-auth-flow provider is registered — the connector-OAuth adapter ` +
        `(own-rolled OAuth) is not wired. Register it at boot (register-adapters.ts), or ` +
        `use a fixed-key credential.`,
    );
  }
  return registeredFlow;
}

export function userAuthRequiredSignal(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return (
    (typeof code === "string" && /user_authorization_required/i.test(code)) ||
    /user[_ ]?authorization[_ ]?required/i.test(e.message)
  );
}
