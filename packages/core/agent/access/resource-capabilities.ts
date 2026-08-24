export interface ResourceCapabilitySpec {
  readonly summary: string;
  readonly resourceType: string;
}

const CAPABILITY_TABLE = {
  post: {
    summary: "post a message into the granted container",
    resourceType: "channel",
  },
  dm: {
    summary: "open a direct message with the granted person and post to it",
    resourceType: "person",
  },
} as const satisfies Readonly<Record<string, ResourceCapabilitySpec>>;

export type ResourceCapability = keyof typeof CAPABILITY_TABLE;

export const RESOURCE_CAPABILITIES: Readonly<Record<ResourceCapability, ResourceCapabilitySpec>> = CAPABILITY_TABLE;

export const RESOURCE_CAPABILITY_NAMES: readonly ResourceCapability[] = (
  Object.keys(CAPABILITY_TABLE) as ResourceCapability[]
).sort();

export function defaultResourceCapabilitiesFor(resourceType: string): readonly ResourceCapability[] {
  return RESOURCE_CAPABILITY_NAMES.filter((name) => CAPABILITY_TABLE[name].resourceType === resourceType);
}

export const DEFAULT_RESOURCE_CAPABILITIES: readonly ResourceCapability[] = defaultResourceCapabilitiesFor("channel");

export function isResourceCapability(value: string): value is ResourceCapability {
  return Object.hasOwn(CAPABILITY_TABLE, value);
}

export function resourceCapabilityType(capability: ResourceCapability): string {
  return CAPABILITY_TABLE[capability].resourceType;
}

export function resourceCapabilityProblems(where: string, capabilities: readonly string[] | undefined, resourceType?: string): string[] {
  if (capabilities === undefined) return [];
  const known = RESOURCE_CAPABILITY_NAMES.map((n) => JSON.stringify(n)).join(", ");
  const forType = resourceType === undefined ? undefined : defaultResourceCapabilitiesFor(resourceType);
  if (!Array.isArray(capabilities)) {
    return [`  ${where} has a \`capabilities\` that is not an array — got ${JSON.stringify(capabilities)}`];
  }
  if (capabilities.length === 0) {
    const fallback = (forType && forType.length > 0 ? forType : DEFAULT_RESOURCE_CAPABILITIES).map((c) => JSON.stringify(c)).join(", ");
    return [
      `  ${where} declares \`capabilities: []\` — an empty list grants nothing; omit the key for the default (${fallback}) or name a capability (${known})`,
    ];
  }
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const cap of capabilities) {
    if (typeof cap !== "string" || cap.trim() === "") {
      bad.push(`  ${where} declares an empty capability name — name one of ${known}`);
      continue;
    }
    if (!isResourceCapability(cap)) {
      bad.push(
        `  ${where} declares unknown capability ${JSON.stringify(cap)} — the implemented capabilities are ${known}. ` +
          `Capabilities are NAMES this deployment implements, never raw vendor permission strings (e.g. "chat:write" is not writable here).`,
      );
      continue;
    }
    if (forType !== undefined && !forType.includes(cap)) {
      bad.push(
        `  ${where} declares capability ${JSON.stringify(cap)}, which acts on ${JSON.stringify(resourceCapabilityType(cap))} resources, but this row names ` +
          `${JSON.stringify(resourceType)} resources. The capabilities for ${JSON.stringify(resourceType)} are ${forType.map((c) => JSON.stringify(c)).join(", ") || "(none)"}. ` +
          `Split the row, or drop the key for that type's default.`,
      );
      continue;
    }
    if (seen.has(cap)) bad.push(`  ${where} declares capability ${JSON.stringify(cap)} more than once — remove the duplicate`);
    seen.add(cap);
  }
  return bad;
}

export function unionResourceCapabilities(
  a: readonly ResourceCapability[],
  b: readonly ResourceCapability[],
): readonly ResourceCapability[] {
  return [...new Set([...a, ...b])].sort();
}
