import { isQualifiedPrincipalKey } from "./principal-key.js";
import { tenantRungRemedy } from "../access/tenant-admission.js";

export interface GroupLinkSetMember {
  readonly linkSet: string;
}

export type GroupMember = string | GroupLinkSetMember;

export interface Group {
  readonly name: string;
  readonly title?: string;
  readonly members: readonly GroupMember[];
}

export function defineGroup(group: Group): Group {
  return group;
}

export function isLinkSetMember(member: GroupMember): member is GroupLinkSetMember {
  return typeof member !== "string";
}

export function groupLinkSets(group: Group): readonly string[] {
  return group.members.filter(isLinkSetMember).map((m) => m.linkSet);
}

export function groupPrincipalKeys(group: Group): readonly string[] {
  return group.members.filter((m): m is string => typeof m === "string");
}

export { EVERYONE_GROUP } from "./everyone-group.js";
import { EVERYONE_GROUP } from "./everyone-group.js";

export const DIRECTORY_GROUP_PREFIX = "directory:";

export function directoryGroupName(idpGroup: string): string {
  return `${DIRECTORY_GROUP_PREFIX}${idpGroup}`;
}

export function isDirectoryGroupName(name: string): boolean {
  return name.startsWith(DIRECTORY_GROUP_PREFIX);
}

export function assertGroupsValid(groups: readonly Group[]): void {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const [index, g] of groups.entries()) {
    const where = g.name && g.name.trim().length > 0 ? `group "${g.name}"` : `group (entry #${index})`;
    if (!g.name || g.name.trim().length === 0) {
      bad.push(`  ${where} has an empty name — a group's name is the id every binding references`);
    } else if (g.name === EVERYONE_GROUP) {
      bad.push(`  group "${g.name}" is reserved — it is the built-in "every internal person in their own DM" group (identity/groups.ts EVERYONE_GROUP), and its membership is computed, never listed. Rename this group.`);
    } else if (seen.has(g.name)) {
      bad.push(`  group name "${g.name}" is defined more than once (bindings reference groups by name — names must be unique)`);
    } else {
      seen.add(g.name);
    }
    const members = g.members ?? [];
    if (members.length === 0) {
      bad.push(`  ${where} has no members — an empty group grants nothing; list its people or drop the group`);
    }
    const seenMembers = new Set<string>();
    for (const m of members) {
      if (typeof m === "string") {
        if (!isQualifiedPrincipalKey(m)) {
          bad.push(
            `  ${where} member "${m}" must be the qualified principal key "platform/<principal-id>" — or, on a tenant-scoped platform, "platform/<tenant-id>/<principal-id>" (e.g. "slack/T0AB1CD2E/U0123ABC", "discord/300000000000000104"). A BARE member id has no platform namespace and will NEVER match; on Slack a key without its workspace has no tenant namespace and will never match either (identity/principal-key.ts).${tenantRungRemedy(m)} To name a whole HUMAN across their platforms, use { linkSet: "<id>" } instead.`,
          );
        }
        if (seenMembers.has(`key\u0000${m}`)) bad.push(`  ${where} lists member "${m}" more than once — remove the duplicate`);
        seenMembers.add(`key\u0000${m}`);
        continue;
      }
      if (typeof m?.linkSet !== "string" || m.linkSet.trim().length === 0) {
        bad.push(`  ${where} has a link-set member with an empty \`linkSet\` id — name the link-set, or use a qualified principal key`);
        continue;
      }
      if (seenMembers.has(`set\u0000${m.linkSet}`)) bad.push(`  ${where} lists link-set "${m.linkSet}" more than once — remove the duplicate`);
      seenMembers.add(`set\u0000${m.linkSet}`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid person-group(s):\n" + bad.join("\n") + "\n(identity/groups.ts assertGroupsValid / docs/how-it-works/access-and-scoping.md).",
    );
  }
}

export function assertReservedGroupNamespace(groups: readonly Group[]): void {
  const bad = groups
    .filter((g) => isDirectoryGroupName(g.name))
    .map(
      (g) =>
        `  group "${g.name}" uses the reserved "${DIRECTORY_GROUP_PREFIX}" namespace — that prefix belongs to the machine-owned IdP-group overlay (agent/identity/groups.generated.ts), which the directory codemod rewrites. Rename this group.`,
    );
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: hand-written person-group(s) in the machine-owned namespace:\n" + bad.join("\n") + "\n(identity/groups.ts assertReservedGroupNamespace).",
    );
  }
}

export function groupsForPrincipal(
  groups: readonly Group[],
  callerKey: string | undefined,
  linkSetIds: readonly string[] = [],
): readonly string[] {
  if (!callerKey) return [];
  const sets = new Set(linkSetIds);
  const out = new Set<string>();
  for (const g of groups) {
    for (const m of g.members ?? []) {
      const hit = typeof m === "string" ? m === callerKey : sets.has(m.linkSet);
      if (hit) {
        out.add(g.name);
        break;
      }
    }
  }
  return [...out].sort();
}
