import { getSettings } from "@open-everywhere/core/agent/adapter-api.js";

const OE_AWS_REGION_ENV = "OE_AWS_REGION";

const OE_AWS_SSO_REGION_ENV = "OE_AWS_SSO_REGION";
const OE_AWS_SSO_CLIENT_ID_ENV = "OE_AWS_SSO_CLIENT_ID";
export function awsAccessEnabled(): boolean {
  return getSettings().aws.enabled;
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
  const scopes = getSettings().aws.ssoScopes;
  return {
    ...(region ? { region } : {}),
    ...(clientId ? { clientId } : {}),
    ...(scopes && scopes.length ? { scopes } : {}),
  };
}
