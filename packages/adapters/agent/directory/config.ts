export const OE_DIRECTORY_PROVIDER_ENV = "OE_DIRECTORY_PROVIDER";
export const OE_DIRECTORY_OKTA_ORG_URL_ENV = "OE_DIRECTORY_OKTA_ORG_URL";
export const OE_DIRECTORY_OKTA_TOKEN_REF_ENV = "OE_DIRECTORY_OKTA_TOKEN_REF";
export const OE_DIRECTORY_OKTA_TOKEN_BROKER_ENV = "OE_DIRECTORY_OKTA_TOKEN_BROKER";
export const OE_DIRECTORY_OKTA_APPS_ENV = "OE_DIRECTORY_OKTA_APPS";

export type OktaAppIdField = "externalId" | "userName";

export interface OktaAppMapping {
  readonly platform: string;
  readonly appId: string;
  readonly field: OktaAppIdField;
}

export interface OktaDirectoryConfig {
  readonly orgUrl: string;
  readonly tokenRef: string;
  readonly tokenBroker: string;
  readonly apps: readonly OktaAppMapping[];
}

export function oktaDirectoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[OE_DIRECTORY_PROVIDER_ENV] ?? "").trim().toLowerCase() === "okta";
}

export function parseOktaAppMap(raw: string | undefined): readonly OktaAppMapping[] {
  const out: OktaAppMapping[] = [];
  for (const entry of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split(":").map((s) => s.trim());
    const [platform, appId, field] = parts;
    if (parts.length < 2 || parts.length > 3 || !platform || !appId) {
      throw new Error(
        `${OE_DIRECTORY_OKTA_APPS_ENV} entry "${entry}" is malformed — expected "<platform>:<oktaAppId>" ` +
          `with an optional ":externalId"/":userName" suffix, e.g. "slack:0oa1a2b3c4d5".`,
      );
    }
    if (field !== undefined && field !== "externalId" && field !== "userName") {
      throw new Error(`${OE_DIRECTORY_OKTA_APPS_ENV} entry "${entry}" names field "${field}" — only "externalId" (default) or "userName" are valid.`);
    }
    out.push({ platform: platform.toLowerCase(), appId, field: field ?? "externalId" });
  }
  return out;
}

function requireHttpsOrgUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${OE_DIRECTORY_OKTA_ORG_URL_ENV}="${raw}" is not a URL — expected your Okta org URL, e.g. "https://acme.okta.com".`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `${OE_DIRECTORY_OKTA_ORG_URL_ENV}="${raw}" is not https — refusing to arm directory sync. Every Okta request carries the ` +
        `SSWS API token in an authorization header, so a plaintext org URL would put an admin credential on the wire on every ` +
        `sync. Use "https://<your-org>.okta.com".`,
    );
  }
}

export function loadOktaDirectoryConfig(env: NodeJS.ProcessEnv = process.env): OktaDirectoryConfig {
  const orgUrl = env[OE_DIRECTORY_OKTA_ORG_URL_ENV]?.trim();
  const tokenRef = env[OE_DIRECTORY_OKTA_TOKEN_REF_ENV]?.trim();
  const missing: string[] = [];
  if (!orgUrl) missing.push(OE_DIRECTORY_OKTA_ORG_URL_ENV);
  if (!tokenRef) missing.push(OE_DIRECTORY_OKTA_TOKEN_REF_ENV);
  if (missing.length) {
    throw new Error(`${OE_DIRECTORY_PROVIDER_ENV}="okta" but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set — directory sync cannot be armed.`);
  }
  requireHttpsOrgUrl(orgUrl!);
  const apps = parseOktaAppMap(env[OE_DIRECTORY_OKTA_APPS_ENV]);
  return {
    orgUrl: orgUrl!.replace(/\/+$/u, ""),
    tokenRef: tokenRef!,
    tokenBroker: env[OE_DIRECTORY_OKTA_TOKEN_BROKER_ENV]?.trim() || "env",
    apps,
  };
}
