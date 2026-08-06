import { directoryGroupName, type Group } from "./groups.js";
import { directoryLinkSetId } from "./directory-sync.js";
import { emitGroupsModule, type GroupsFile } from "./groups-codemod.js";
import type { DirectoryPerson } from "./directory.js";

export type GroupSyncStep =
  | { readonly kind: "add-group"; readonly group: string; readonly title: string; readonly members: number }
  | { readonly kind: "drop-group"; readonly group: string; readonly members: number }
  | { readonly kind: "add-member"; readonly group: string; readonly linkSet: string }
  | { readonly kind: "remove-member"; readonly group: string; readonly linkSet: string };

export interface GroupSyncPlan {
  readonly provider: string;
  readonly people: number;
  readonly next: GroupsFile;
  readonly steps: readonly GroupSyncStep[];
  readonly warnings: readonly string[];
  readonly counts: {
    readonly addGroup: number;
    readonly dropGroup: number;
    readonly addMember: number;
    readonly removeMember: number;
  };
}

export function groupPlanIsNoop(plan: GroupSyncPlan): boolean {
  return plan.steps.length === 0;
}

export function planDirectoryGroups(input: {
  readonly provider: string;
  readonly people: readonly DirectoryPerson[];
  readonly current: GroupsFile;
  readonly allowGroups?: readonly string[];
}): GroupSyncPlan {
  const warnings: string[] = [];
  const allow = input.allowGroups ? new Set(input.allowGroups) : undefined;

  const desired = new Map<string, { title: string; members: Set<string> }>();
  for (const person of input.people) {
    if (person.deprovisioned) continue;
    const linkSet = directoryLinkSetId(input.provider, person.externalId);
    for (const raw of person.groups) {
      if (typeof raw !== "string" || raw.trim().length === 0) {
        warnings.push(`directory person "${person.externalId}" carries an empty group name — skipped (fix the duplicate/blank group in the IdP).`);
        continue;
      }
      if (allow && !allow.has(raw)) continue;
      const name = directoryGroupName(raw);
      const entry = desired.get(name) ?? { title: raw, members: new Set<string>() };
      entry.members.add(linkSet);
      desired.set(name, entry);
    }
  }

  const currentByName = new Map(input.current.groups.map((g) => [g.name, g]));
  const steps: GroupSyncStep[] = [];

  for (const name of [...desired.keys()].sort()) {
    const want = desired.get(name)!;
    const have = currentByName.get(name);
    if (!have) {
      steps.push({ kind: "add-group", group: name, title: want.title, members: want.members.size });
      continue;
    }
    const haveSets = new Set(have.members.map((m) => (typeof m === "string" ? m : m.linkSet)));
    for (const linkSet of [...want.members].sort()) if (!haveSets.has(linkSet)) steps.push({ kind: "add-member", group: name, linkSet });
    for (const linkSet of [...haveSets].sort()) if (!want.members.has(linkSet)) steps.push({ kind: "remove-member", group: name, linkSet });
  }

  for (const g of [...input.current.groups].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!desired.has(g.name)) steps.push({ kind: "drop-group", group: g.name, members: g.members.length });
  }

  const next: GroupsFile = {
    groups: [...desired.entries()]
      .filter(([, v]) => v.members.size > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]): Group => ({ name, title: v.title, members: [...v.members].sort().map((linkSet) => ({ linkSet })) })),
  };

  return {
    provider: input.provider,
    people: input.people.length,
    next,
    steps,
    warnings,
    counts: {
      addGroup: steps.filter((s) => s.kind === "add-group").length,
      dropGroup: steps.filter((s) => s.kind === "drop-group").length,
      addMember: steps.filter((s) => s.kind === "add-member").length,
      removeMember: steps.filter((s) => s.kind === "remove-member").length,
    },
  };
}

export function planOverlayContent(plan: GroupSyncPlan): string {
  return emitGroupsModule(plan.next);
}

export const OE_DIRECTORY_GROUP_ALLOWLIST_ENV = "OE_DIRECTORY_GROUP_ALLOWLIST";

export function directoryGroupAllowlist(env: NodeJS.ProcessEnv = process.env): readonly string[] | undefined {
  const raw = env[OE_DIRECTORY_GROUP_ALLOWLIST_ENV]?.trim();
  if (!raw) return undefined;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length > 0 ? names : undefined;
}

export function renderGroupPlan(plan: GroupSyncPlan): string[] {
  return plan.steps.map((s) => {
    switch (s.kind) {
      case "add-group":
        return `+ group "${s.group}" (${s.title}) with ${s.members} member(s)`;
      case "drop-group":
        return `- group "${s.group}" (had ${s.members} member(s)) — no longer in the directory`;
      case "add-member":
        return `+ ${s.linkSet} → "${s.group}" (LIVE once merged — every CONFIRMED account of this link-set gets the group's bundle in its own DM)`;
      case "remove-member":
        return `- ${s.linkSet} from "${s.group}"`;
    }
  });
}
