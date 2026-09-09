const OE_OAUTH_ENABLED_ENV = "OE_OAUTH_ENABLED";
export const OE_OAUTH_CONFIG_ENV = "OE_OAUTH_CONFIG";
const OE_OAUTH_NOTION_RESOURCE_ENV = "OE_OAUTH_NOTION_RESOURCE";

export const OE_OAUTH_MODE_DISCOVERY = "discovery-dcr-pkce";
export const OE_OAUTH_MODE_STATIC = "static-confidential";

export type OeOauthBodyEncoding = "json" | "form";

interface OeOauthProviderConfigBase {
  readonly ref: string;
  readonly scopes?: readonly string[];
}

export interface OeOauthDiscoveryProviderConfig extends OeOauthProviderConfigBase {
  readonly mode: typeof OE_OAUTH_MODE_DISCOVERY;
  readonly resource: string;
  readonly clientName?: string;
}

export interface OeOauthStaticProviderConfig extends OeOauthProviderConfigBase {
  readonly mode: typeof OE_OAUTH_MODE_STATIC;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly clientId: string;
  readonly clientSecretRef: string;
  readonly clientSecretBroker: string;
  readonly authorizeParams?: Readonly<Record<string, string>>;
  readonly tokenHeaders?: Readonly<Record<string, string>>;
  readonly bodyEncoding: OeOauthBodyEncoding;
}

export type OeOauthProviderConfig = OeOauthDiscoveryProviderConfig | OeOauthStaticProviderConfig;

export function isStaticConfidential(cfg: OeOauthProviderConfig): cfg is OeOauthStaticProviderConfig {
  return cfg.mode === OE_OAUTH_MODE_STATIC;
}

export function oeOauthEnabled(): boolean {
  const raw = process.env[OE_OAUTH_ENABLED_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

const RESERVED_AUTHORIZE_PARAMS = new Set(["response_type", "client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method"]);

function requireString(v: unknown, where: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${where} must be a non-empty string.`);
  return v.trim();
}

function requireHttpsUrl(v: unknown, where: string): string {
  const raw = requireString(v, where);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${where} must be an absolute URL (got ${JSON.stringify(raw)}).`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${where} must use https — a confidential client presents its secret on this request, so ${JSON.stringify(parsed.protocol)} is refused.`);
  }
  return raw;
}

function optionalStringMap(v: unknown, where: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${where} must be a JSON object of string values.`);
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "string") throw new Error(`${where}["${k}"] must be a string.`);
    out[k] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseScopes(v: unknown): readonly string[] | undefined {
  const scopes = Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
  return scopes && scopes.length ? scopes : undefined;
}

function parseStaticProvider(ref: string, rec: Record<string, unknown>): OeOauthStaticProviderConfig {
  const where = `${OE_OAUTH_CONFIG_ENV}["${ref}"]`;
  if ("clientSecret" in rec) {
    throw new Error(
      `${where} carries a literal "clientSecret". The client secret must NEVER live in this config block — ` +
        `store it in the credential store and name it with "clientSecretRef" (for example "db:notion:rest-client-secret").`,
    );
  }
  const authorizeParams = optionalStringMap(rec.authorizeParams, `${where}.authorizeParams`);
  for (const name of Object.keys(authorizeParams ?? {})) {
    if (RESERVED_AUTHORIZE_PARAMS.has(name.toLowerCase())) {
      throw new Error(`${where}.authorizeParams may not set "${name}" — the adapter composes that parameter itself.`);
    }
  }
  const tokenHeaders = optionalStringMap(rec.tokenHeaders, `${where}.tokenHeaders`);
  for (const name of Object.keys(tokenHeaders ?? {})) {
    if (name.toLowerCase() === "authorization") {
      throw new Error(`${where}.tokenHeaders may not set "${name}" — that header carries the confidential client's Basic credential.`);
    }
  }
  const bodyEncoding = requireString(rec.bodyEncoding, `${where}.bodyEncoding`);
  if (bodyEncoding !== "json" && bodyEncoding !== "form") {
    throw new Error(`${where}.bodyEncoding must be "json" or "form" — the dialect is declared, not guessed.`);
  }
  const revocationEndpoint = rec.revocationEndpoint === undefined ? undefined : requireHttpsUrl(rec.revocationEndpoint, `${where}.revocationEndpoint`);
  const scopes = parseScopes(rec.scopes);
  return {
    mode: OE_OAUTH_MODE_STATIC,
    ref,
    authorizationEndpoint: requireHttpsUrl(rec.authorizationEndpoint, `${where}.authorizationEndpoint`),
    tokenEndpoint: requireHttpsUrl(rec.tokenEndpoint, `${where}.tokenEndpoint`),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    clientId: requireString(rec.clientId, `${where}.clientId`),
    clientSecretRef: requireString(rec.clientSecretRef, `${where}.clientSecretRef`),
    clientSecretBroker: rec.clientSecretBroker === undefined ? "db" : requireString(rec.clientSecretBroker, `${where}.clientSecretBroker`),
    ...(authorizeParams ? { authorizeParams } : {}),
    ...(tokenHeaders ? { tokenHeaders } : {}),
    bodyEncoding,
  };
}

function parseDiscoveryProvider(ref: string, rec: Record<string, unknown>): OeOauthDiscoveryProviderConfig {
  const where = `${OE_OAUTH_CONFIG_ENV}["${ref}"]`;
  const resource = typeof rec.resource === "string" ? rec.resource.trim() : "";
  if (!resource) throw new Error(`${where} is missing a string "resource".`);
  const scopes = parseScopes(rec.scopes);
  return {
    mode: OE_OAUTH_MODE_DISCOVERY,
    ref,
    resource,
    ...(scopes ? { scopes } : {}),
    ...(typeof rec.clientName === "string" && rec.clientName.trim() ? { clientName: rec.clientName.trim() } : {}),
  };
}

function parseJsonConfig(raw: string): Map<string, OeOauthProviderConfig> {
  const out = new Map<string, OeOauthProviderConfig>();
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`${OE_OAUTH_CONFIG_ENV} is not valid JSON — expected {"<ref>":{"resource":"..."}}.`);
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error(`${OE_OAUTH_CONFIG_ENV} must be a JSON object mapping provider ref → one provider entry.`);
  }
  for (const [ref, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const rec = v as Record<string, unknown>;
    const mode = rec.mode === undefined ? OE_OAUTH_MODE_DISCOVERY : rec.mode;
    if (mode === OE_OAUTH_MODE_STATIC) {
      out.set(ref, parseStaticProvider(ref, rec));
      continue;
    }
    if (mode !== OE_OAUTH_MODE_DISCOVERY) {
      throw new Error(
        `${OE_OAUTH_CONFIG_ENV}["${ref}"].mode ${JSON.stringify(mode)} is not a known oe-oauth mode — use "${OE_OAUTH_MODE_DISCOVERY}" or "${OE_OAUTH_MODE_STATIC}".`,
      );
    }
    const parsed = parseDiscoveryProvider(ref, rec);
    for (const field of ["clientId", "clientSecretRef", "clientSecret", "tokenEndpoint", "authorizationEndpoint"]) {
      if (field in rec) {
        throw new Error(
          `${OE_OAUTH_CONFIG_ENV}["${ref}"] carries "${field}" but declares no mode, so it reads as "${OE_OAUTH_MODE_DISCOVERY}" ` +
            `(discovery + dynamic registration + PKCE), which ignores that field. Add "mode": "${OE_OAUTH_MODE_STATIC}" if that is what you meant.`,
        );
      }
    }
    out.set(ref, parsed);
  }
  return out;
}

export function loadOeOauthConfig(): Map<string, OeOauthProviderConfig> | undefined {
  const providers = new Map<string, OeOauthProviderConfig>();

  const notionResource = process.env[OE_OAUTH_NOTION_RESOURCE_ENV]?.trim();
  if (notionResource) providers.set("notion", { mode: OE_OAUTH_MODE_DISCOVERY, ref: "notion", resource: notionResource });

  const rawJson = process.env[OE_OAUTH_CONFIG_ENV]?.trim();
  if (rawJson) for (const [ref, cfg] of parseJsonConfig(rawJson)) providers.set(ref, cfg);

  return providers.size > 0 ? providers : undefined;
}
