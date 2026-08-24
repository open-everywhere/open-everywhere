import {
  ResourceCapability,
  resourceCapabilityProblems,
  DEFAULT_RESOURCE_CAPABILITIES,
  defaultResourceCapabilitiesFor,
} from "./resource-capabilities.js";

export interface ResourceAddress {
  readonly connector: string;
  readonly type: string;
  readonly id: string;
}

const RESOURCE_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  slack: Object.freeze(["channel", "person"]),
  discord: Object.freeze(["channel", "person"]),
  teams: Object.freeze(["channel", "person"]),
});

export const RESOURCE_CONNECTORS: readonly string[] = Object.keys(RESOURCE_TYPES).sort();

export function resourceTypesFor(connector: string): readonly string[] {
  return RESOURCE_TYPES[connector] ?? [];
}

const RESOURCE_ID = /^[A-Za-z0-9._-]+$/u;

export function parseResourceAddress(address: string): ResourceAddress | undefined {
  if (typeof address !== "string") return undefined;
  const colon = address.indexOf(":");
  if (colon <= 0) return undefined;
  const connector = address.slice(0, colon);
  const rest = address.slice(colon + 1);
  if (rest.includes(":")) return undefined;
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const type = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (id.length === 0 || id.includes("/")) return undefined;
  if (!RESOURCE_ID.test(id)) return undefined;
  if (!RESOURCE_ID.test(connector) || !RESOURCE_ID.test(type)) return undefined;
  return { connector, type, id };
}

export function resourceAddress(connector: string, type: string, id: string): string {
  return `${connector}:${type}/${id}`;
}

export interface ResourceGrant {
  readonly connector: string;
  readonly resources: readonly string[];
  readonly capabilities?: readonly ResourceCapability[];
}

export function resourceGrantType(grant: ResourceGrant): string | undefined {
  const types = new Set<string>();
  for (const entry of grant.resources ?? []) {
    const parsed = typeof entry === "string" ? parseResourceAddress(entry) : undefined;
    if (!parsed) return undefined;
    types.add(parsed.type);
  }
  return types.size === 1 ? [...types][0] : undefined;
}

export function resourceGrantCapabilities(grant: ResourceGrant): readonly ResourceCapability[] {
  if (grant.capabilities) return grant.capabilities;
  const type = resourceGrantType(grant);
  if (type === undefined) return DEFAULT_RESOURCE_CAPABILITIES;
  return defaultResourceCapabilitiesFor(type);
}

export function resourceGrantProblems(where: string, grants: readonly ResourceGrant[] | undefined): string[] {
  if (grants === undefined) return [];
  const known = RESOURCE_CONNECTORS.map((c) => JSON.stringify(c)).join(", ");
  if (!Array.isArray(grants)) {
    return [`  ${where} has a \`resourceGrants\` that is not an array — got ${JSON.stringify(grants)}`];
  }
  const problems: string[] = [];
  const seenAddresses = new Set<string>();
  for (const [index, grant] of grants.entries()) {
    const row = `${where} resourceGrants[${index}]`;
    const rowTypes = new Set<string>();
    if (typeof grant !== "object" || grant === null) {
      problems.push(`  ${row} is not an object — a resource row is { connector, resources, capabilities? }`);
      continue;
    }
    const connector = grant.connector;
    if (typeof connector !== "string" || connector.trim() === "") {
      problems.push(`  ${row} names no \`connector\` — name one of ${known}`);
    } else if (resourceTypesFor(connector).length === 0) {
      problems.push(
        `  ${row} names unknown connector ${JSON.stringify(connector)} — this deployment implements resource grants for ${known}. ` +
          `A connector is added in the diff that wires its write transport, never in config.`,
      );
    }
    if (!Array.isArray(grant.resources) || grant.resources.length === 0) {
      problems.push(
        `  ${row} declares no \`resources\` — name at least one address, e.g. ${JSON.stringify(resourceAddress(connector || "slack", "channel", "C0123ABC"))}`,
      );
    } else {
      for (const entry of grant.resources) {
        if (typeof entry !== "string" || entry.trim() === "") {
          problems.push(`  ${row} declares an empty resource address — write \`<connector>:<type>/<id>\``);
          continue;
        }
        const parsed = parseResourceAddress(entry);
        if (!parsed) {
          problems.push(
            `  ${row} declares malformed resource ${JSON.stringify(entry)} — the address form is \`<connector>:<type>/<id>\` ` +
              `(e.g. "slack:channel/C0123ABC"). No wildcards: a grant names containers one by one.`,
          );
          continue;
        }
        if (typeof connector === "string" && connector !== "" && parsed.connector !== connector) {
          problems.push(
            `  ${row} declares resource ${JSON.stringify(entry)} on connector ${JSON.stringify(parsed.connector)}, but the row's \`connector\` is ${JSON.stringify(connector)} — ` +
              `one row names one connector, so split them into two rows or fix the address.`,
          );
          continue;
        }
        const types = resourceTypesFor(parsed.connector);
        if (types.length > 0 && !types.includes(parsed.type)) {
          problems.push(
            `  ${row} declares resource type ${JSON.stringify(parsed.type)} on ${JSON.stringify(parsed.connector)}, which implements ${types.map((t) => JSON.stringify(t)).join(", ")}`,
          );
          continue;
        }
        if (seenAddresses.has(entry)) {
          problems.push(`  ${row} declares resource ${JSON.stringify(entry)} more than once in this bundle — remove the duplicate`);
        }
        seenAddresses.add(entry);
        rowTypes.add(parsed.type);
      }
    }
    if (rowTypes.size > 1) {
      problems.push(
        `  ${row} mixes resource types (${[...rowTypes].sort().map((t) => JSON.stringify(t)).join(", ")}) — one row names ONE type, ` +
          `because a row's capabilities apply to every address in it and each capability acts on one type. Split them into one row per type.`,
      );
    }
    problems.push(...resourceCapabilityProblems(row, grant.capabilities, rowTypes.size === 1 ? [...rowTypes][0] : undefined));
  }
  return problems;
}
