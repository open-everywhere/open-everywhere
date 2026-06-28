export type ScopeLevel = "org" | "workspace" | "domain" | "channel";

export interface Scope {
  readonly level: ScopeLevel;
  readonly workspace?: string;
  readonly domain?: string;
  readonly channel?: string;
}

export type CredentialType = "bearer" | "basic" | "github-app";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CustomHeader {
  readonly name: string;
  readonly prefix?: string;
  readonly secretRef: string;
}

export interface Connection {
  readonly id: string;
  readonly credentialType: CredentialType;
  readonly secretRef: string;
  readonly allowedWebsites: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly customHeaders?: readonly CustomHeader[];
  readonly methods?: readonly HttpMethod[];
}

export interface Bundle {
  readonly name: string;
  readonly connections?: readonly Connection[];
  readonly connectors?: readonly string[];
  readonly repos?: readonly string[];
  readonly domains?: readonly string[];
  readonly plugins?: readonly string[];
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
