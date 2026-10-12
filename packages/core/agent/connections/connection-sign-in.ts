import { processRegistryMap } from "../lib/process-registry.js";

export interface DiscoverySignIn {
  readonly mode?: "discovery-dcr-pkce";
  readonly resource: string;
  readonly scopes?: readonly string[];
  readonly clientName?: string;
}

export interface StaticConfidentialSignIn {
  readonly mode: "static-confidential";
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly clientId: string;
  readonly clientSecretRef: string;
  readonly clientSecretBroker?: string;
  readonly authorizeParams?: Readonly<Record<string, string>>;
  readonly tokenHeaders?: Readonly<Record<string, string>>;
  readonly bodyEncoding: "json" | "form";
  readonly scopes?: readonly string[];
}

export interface XaaSignIn {
  readonly mode: "xaa";
  readonly idpIssuer: string;
  readonly idpClientId: string;
  readonly idpClientSecretRef: string;
  readonly idpClientSecretBroker?: string;
  readonly audience: string;
  readonly resource?: string;
  readonly scopes?: readonly string[];
  readonly resourceTokenEndpoint: string;
  readonly resourceClientId: string;
  readonly resourceClientSecretRef: string;
  readonly resourceClientSecretBroker?: string;
}

export type ConnectionSignIn = DiscoverySignIn | StaticConfidentialSignIn | XaaSignIn;

const DECLARED = processRegistryMap<ConnectionSignIn>("connection-sign-in.v1");

export function declareConnectionSignIn(homeRef: string, signIn: ConnectionSignIn): void {
  const ref = homeRef.trim();
  if (ref === "") throw new Error("declareConnectionSignIn: the home ref must be a non-empty string.");
  const prior = DECLARED.get(ref);
  if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(signIn)) {
    throw new Error(
      `declareConnectionSignIn: two different sign-in declarations for the home ref "${ref}". One OAuth home holds one ` +
        "client, so two connections cannot declare it differently.",
    );
  }
  DECLARED.set(ref, signIn);
}

export function declaredConnectionSignIns(): ReadonlyMap<string, ConnectionSignIn> {
  return new Map(DECLARED);
}

export function _resetConnectionSignInsForTest(): void {
  DECLARED.clear();
}
