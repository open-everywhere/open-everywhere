export const OE_AWS_ENABLED_ENV = "OE_AWS_ENABLED";
export const OE_AWS_REGION_ENV = "OE_AWS_REGION";

export const OE_AWS_SSO_REGION_ENV = "OE_AWS_SSO_REGION";
export const OE_AWS_SSO_CLIENT_ID_ENV = "OE_AWS_SSO_CLIENT_ID";
export const OE_AWS_SSO_SCOPES_ENV = "OE_AWS_SSO_SCOPES";

export function awsAccessEnabled(): boolean {
  const raw = process.env[OE_AWS_ENABLED_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

export interface AwsAccessConfig {
  readonly defaultRegion?: string;
}

export function loadAwsAccessConfig(): AwsAccessConfig {
  const defaultRegion = process.env[OE_AWS_REGION_ENV]?.trim() || process.env.AWS_REGION?.trim();
  return { ...(defaultRegion ? { defaultRegion } : {}) };
}

export interface AwsSsoConfig {
  readonly region?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
}

export function loadAwsSsoConfig(): AwsSsoConfig {
  const region =
    process.env[OE_AWS_SSO_REGION_ENV]?.trim() ||
    process.env[OE_AWS_REGION_ENV]?.trim() ||
    process.env.AWS_REGION?.trim();
  const clientId = process.env[OE_AWS_SSO_CLIENT_ID_ENV]?.trim();
  const scopes = process.env[OE_AWS_SSO_SCOPES_ENV]?.trim()
    ? process.env[OE_AWS_SSO_SCOPES_ENV]!.trim().split(/\s+/u).filter(Boolean)
    : undefined;
  return {
    ...(region ? { region } : {}),
    ...(clientId ? { clientId } : {}),
    ...(scopes && scopes.length ? { scopes } : {}),
  };
}
