export interface ResourceCapabilitySpec {
  readonly summary: string;
}

const CAPABILITY_TABLE = {
  post: {
    summary: "post a message into the granted container",
  },
} as const satisfies Readonly<Record<string, ResourceCapabilitySpec>>;

export type ResourceCapability = keyof typeof CAPABILITY_TABLE;

export const RESOURCE_CAPABILITIES: Readonly<Record<ResourceCapability, ResourceCapabilitySpec>> = CAPABILITY_TABLE;

export const RESOURCE_CAPABILITY_NAMES: readonly ResourceCapability[] = (
  Object.keys(CAPABILITY_TABLE) as ResourceCapability[]
).sort();

export const DEFAULT_RESOURCE_CAPABILITIES: readonly ResourceCapability[] = ["post"];

export function isResourceCapability(value: string): value is ResourceCapability {
  return Object.hasOwn(CAPABILITY_TABLE, value);
}

export function resourceCapabilityProblems(where: string, capabilities: readonly string[] | undefined): string[] {
  if (capabilities === undefined) return [];
  const known = RESOURCE_CAPABILITY_NAMES.map((n) => JSON.stringify(n)).join(", ");
  if (!Array.isArray(capabilities)) {
    return [`  ${where} has a \`capabilities\` that is not an array — got ${JSON.stringify(capabilities)}`];
  }
  if (capabilities.length === 0) {
    return [
      `  ${where} declares \`capabilities: []\` — an empty list grants nothing; omit the key for the default (${DEFAULT_RESOURCE_CAPABILITIES.map((c) => JSON.stringify(c)).join(", ")}) or name a capability (${known})`,
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
