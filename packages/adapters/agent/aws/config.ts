export const OE_AWS_ENABLED_ENV = "OE_AWS_ENABLED";
export const OE_AWS_REGION_ENV = "OE_AWS_REGION";

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
