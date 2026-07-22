export const OE_OAUTH_ENABLED_ENV = "OE_OAUTH_ENABLED";
export const OE_OAUTH_CONFIG_ENV = "OE_OAUTH_CONFIG";
export const OE_OAUTH_NOTION_RESOURCE_ENV = "OE_OAUTH_NOTION_RESOURCE";

export interface OeOauthProviderConfig {
  readonly ref: string;
  readonly resource: string;
  readonly scopes?: readonly string[];
  readonly clientName?: string;
}

export function oeOauthEnabled(): boolean {
  const raw = process.env[OE_OAUTH_ENABLED_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
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
    throw new Error(`${OE_OAUTH_CONFIG_ENV} must be a JSON object mapping provider ref → { resource, scopes?, clientName? }.`);
  }
  for (const [ref, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const rec = v as { resource?: unknown; scopes?: unknown; clientName?: unknown };
    const resource = typeof rec.resource === "string" ? rec.resource.trim() : "";
    if (!resource) throw new Error(`${OE_OAUTH_CONFIG_ENV}["${ref}"] is missing a string "resource".`);
    const scopes = Array.isArray(rec.scopes) ? rec.scopes.filter((s): s is string => typeof s === "string") : undefined;
    out.set(ref, {
      ref,
      resource,
      ...(scopes && scopes.length ? { scopes } : {}),
      ...(typeof rec.clientName === "string" && rec.clientName.trim() ? { clientName: rec.clientName.trim() } : {}),
    });
  }
  return out;
}

export function loadOeOauthConfig(): Map<string, OeOauthProviderConfig> | undefined {
  const providers = new Map<string, OeOauthProviderConfig>();

  const notionResource = process.env[OE_OAUTH_NOTION_RESOURCE_ENV]?.trim();
  if (notionResource) providers.set("notion", { ref: "notion", resource: notionResource });

  const rawJson = process.env[OE_OAUTH_CONFIG_ENV]?.trim();
  if (rawJson) for (const [ref, cfg] of parseJsonConfig(rawJson)) providers.set(ref, cfg);

  return providers.size > 0 ? providers : undefined;
}
