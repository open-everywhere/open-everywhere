import { defineDynamic, defineSkill } from "eve/skills";
import { resolveAccessFor, unattendedOf } from "../access/request.js";
import { getConfig } from "../access/config.js";
import { repoSkillPackages } from "../scm/repo-skills.js";
import { resolveDomainSkillRows, skillPackageFromRow } from "./domain-skills.js";
import { resolveLeanSeatPosture } from "../access/lean-seat.js";
import { canDelegateFromSeat } from "../access/delegation-mount.js";
import { windowGrainOf, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import type { SkillPackageDefinition } from "eve/skills";

function seatMayLoadSkills(ctx: BindableContext): boolean {
  try {
    const grain = windowGrainOf(ctx);
    const canDelegate = canDelegateFromSeat(ctx);
    const unattendedFire = unattendedOf(ctx);
    return resolveLeanSeatPosture({ grain, canDelegate, unattendedFire }) !== "lean";
  } catch {
    return true;
  }
}

export interface ResolvedSkillEntry {
  readonly name: string;
  readonly tier: "granted" | "domain" | "repo";
  readonly pkg: SkillPackageDefinition;
  readonly updatedBy?: string;
  readonly updatedAt?: string;
}

function withSessionFiles(
  pkg: SkillPackageDefinition,
  files: ((where: { readonly platform: string; readonly surface: string }) => Record<string, string>) | undefined,
  ctx: BindableContext,
): SkillPackageDefinition {
  if (!files) return pkg;
  const { platform, surface } = resolvePartition(ctx);
  return { ...pkg, files: { ...pkg.files, ...files({ platform, surface }) } };
}

export async function resolveSkillEntries(ctx: BindableContext): Promise<ResolvedSkillEntry[]> {
  if (!seatMayLoadSkills(ctx)) return [];
  const access = resolveAccessFor(ctx);
  const skillContent = getConfig().skillContent;
  const grantedNames = new Set(access.skills);
  const entries: ResolvedSkillEntry[] = [];
  const claimed = new Set<string>();

  const sessionFiles = getConfig().skillSessionFiles ?? {};
  for (const name of access.skills) {
    const content = skillContent[name];
    if (!content) continue;
    entries.push({ name, tier: "granted", pkg: withSessionFiles(content, sessionFiles[name], ctx) });
    claimed.add(name);
  }

  for (const row of await resolveDomainSkillRows(ctx, grantedNames)) {
    entries.push({ name: row.name, tier: "domain", pkg: skillPackageFromRow(row), updatedBy: row.updatedBy, updatedAt: row.updatedAt });
    claimed.add(row.name);
  }

  for (const [name, pkg] of Object.entries(repoSkillPackages(grantedNames))) {
    if (claimed.has(name)) {
      console.warn(`[open-everywhere:skills] repo skill "${name}" collides with an already-resolved skill for this session — that one wins, repo skill dropped`);
      continue;
    }
    entries.push({ name, tier: "repo", pkg });
    claimed.add(name);
  }

  return entries;
}

async function granted(ctx: BindableContext) {
  const out: Record<string, ReturnType<typeof defineSkill>> = {};
  for (const entry of await resolveSkillEntries(ctx)) out[entry.name] = defineSkill(entry.pkg);
  return out;
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => granted(ctx),
    "turn.started": (_event, ctx) => granted(ctx),
  },
});
