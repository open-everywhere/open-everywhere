import { SETTINGS, getSettings, type OktaAppSetting } from "@open-everywhere/core/agent/adapter-api.js";

const OE_DIRECTORY_PROVIDER_ENV = "OE_DIRECTORY_PROVIDER";
const OE_DIRECTORY_OKTA_ORG_URL_ENV = "OE_DIRECTORY_OKTA_ORG_URL";
const OE_DIRECTORY_OKTA_TOKEN_REF_ENV = "OE_DIRECTORY_OKTA_TOKEN_REF";
const OE_DIRECTORY_OKTA_TOKEN_BROKER_ENV = "OE_DIRECTORY_OKTA_TOKEN_BROKER";

export type OktaAppIdField = "externalId" | "userName";

export interface OktaAppMapping {
  readonly platform: string;
  readonly tenant?: string;
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

export function oktaAppMappings(entries: readonly OktaAppSetting[]): readonly OktaAppMapping[] {
  const problem = SETTINGS.directory.oktaApps.validate(entries);
  if (problem !== undefined) throw new Error(`directory.oktaApps: ${problem}`);
  return entries.map((a) => ({
    platform: a.platform,
    ...(a.tenant !== undefined ? { tenant: a.tenant } : {}),
    appId: a.appId,
    field: a.field ?? "externalId",
  }));
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

export function loadOktaDirectoryConfig(
  env: NodeJS.ProcessEnv = process.env,
  apps: readonly OktaAppSetting[] = getSettings().directory.oktaApps,
): OktaDirectoryConfig {
  const orgUrl = env[OE_DIRECTORY_OKTA_ORG_URL_ENV]?.trim();
  const tokenRef = env[OE_DIRECTORY_OKTA_TOKEN_REF_ENV]?.trim();
  const missing: string[] = [];
  if (!orgUrl) missing.push(OE_DIRECTORY_OKTA_ORG_URL_ENV);
  if (!tokenRef) missing.push(OE_DIRECTORY_OKTA_TOKEN_REF_ENV);
  if (missing.length) {
    throw new Error(`${OE_DIRECTORY_PROVIDER_ENV}="okta" but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set — directory sync cannot be armed.`);
  }
  requireHttpsOrgUrl(orgUrl!);
  return {
    orgUrl: orgUrl!.replace(/\/+$/u, ""),
    tokenRef: tokenRef!,
    tokenBroker: env[OE_DIRECTORY_OKTA_TOKEN_BROKER_ENV]?.trim() || "db",
    apps: oktaAppMappings(apps),
  };
}
