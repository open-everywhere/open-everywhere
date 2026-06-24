export type ScopeLevel = "org" | "workspace" | "domain" | "channel";

export interface Scope {
  readonly level: ScopeLevel;
  readonly workspace?: string;
  readonly domain?: string;
  readonly channel?: string;
}

export type CredentialType =
  | "bearer"
  | "basic"
  | "body-parameter"
  | "aws-sigv4"
  | "gcp-access-token"
  | "gcp-iap"
  | "oauth2-jwt-bearer"
  | "oauth2-client-credentials"
  | "oauth2-authorization-code"
  | "github-app";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Connection {
  readonly id: string;
  readonly credentialType: CredentialType;
  readonly secretRef: string;
  readonly allowedWebsites: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly methods?: readonly HttpMethod[];
}

export interface Plugin {
  readonly id: string;
  readonly kind: "mcp" | "openapi";
  readonly ref: string;
  readonly connectionId?: string;
}

export interface Bundle {
  readonly name: string;
  readonly connections?: readonly Connection[];
  readonly repos?: readonly string[];
  readonly domains?: readonly string[];
  readonly plugins?: readonly Plugin[];
  readonly instructions?: string;
}

export interface Binding {
  readonly bundle: string;
  readonly scope: Scope;
}

export function defineBundle(bundle: Bundle): Bundle {
  return bundle;
}

export function defineBinding(binding: Binding): Binding {
  return binding;
}
