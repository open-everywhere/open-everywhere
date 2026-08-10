import { bindFrom, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { domainKeyOf, resolvePartition, type Partition } from "../memory/partition.js";
import { domainForChannel, criteriaDomain, type Domain } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { getOperationalStore } from "../operational/provider.js";
import type { DomainSkillProvenance, DomainSkillRevisionRow, DomainSkillRow } from "../operational/store.js";
import { isSafeSkillName } from "../scm/repo-skills.js";
import { parseFrontmatter } from "../plugins/extract.js";
import { MAX_SKILL_BYTES } from "../scm/git.js";
import { SETTINGS, getSettings } from "../settings/settings.js";
import type { SkillPackageDefinition } from "eve/skills";

export const MAX_DOMAIN_SKILL_BYTES = MAX_SKILL_BYTES;

export const DEFAULT_DOMAIN_SKILL_CAP: number = SETTINGS.skills.domainSkillCap.shipped;

export function domainSkillCap(): number {
  return getSettings().skills.domainSkillCap;
}

export type SkillDomainRefusal = "dm" | "mpim" | "external" | "unassigned";

export type SkillDomainResult = { readonly domain: string } | { readonly domain: null; readonly reason: SkillDomainRefusal };

export function skillDomainFor(binding: SurfaceBinding, partition: Partition, domains: readonly Domain[]): SkillDomainResult {
  if (binding.mode === "dm") return { domain: null, reason: "dm" };
  if (binding.mode === "mpim") return { domain: null, reason: "mpim" };
  if (binding.trust === "external") return { domain: null, reason: "external" };
  const explicit = domainForChannel(domainKeyOf(partition), domains);
  if (explicit) return { domain: explicit.name };
  const org = criteriaDomain("org", domains);
  return org ? { domain: org.name } : { domain: null, reason: "unassigned" };
}

export function resolveSkillDomainDetailed(ctx: BindableContext): SkillDomainResult {
  return skillDomainFor(bindFrom(ctx), resolvePartition(ctx), getConfig().loadDomains());
}

export function resolveSkillDomain(ctx: BindableContext): string | undefined {
  const r = resolveSkillDomainDetailed(ctx);
  return r.domain ?? undefined;
}

export function domainSkillRefusalMessage(reason: SkillDomainRefusal): string {
  switch (reason) {
    case "dm":
      return "Skills can't be authored from a DM — a DM-authored skill would arm across every DM session. Author it from a channel in the target domain instead.";
    case "mpim":
      return "Skills can't be authored from a group chat — group chats are execution-only (no memory domain). Author from a channel in the target domain instead.";
    case "external":
      return "Skills can't be authored from an externally-shared or unconfirmed channel. Author from a channel in the target domain instead.";
    case "unassigned":
      return "This channel isn't in any memory domain and no org-wide default domain is configured — there's nowhere to attach the skill.";
  }
}

export function listDomainSkills(org: string, domain: string): Promise<DomainSkillRow[]> {
  return getOperationalStore().listDomainSkills(org, domain);
}

export function putDomainSkill(
  org: string,
  domain: string,
  name: string,
  content: string,
  updatedBy: string | undefined,
  updatedAt: string,
  provenance?: DomainSkillProvenance,
): Promise<void> {
  return getOperationalStore().putDomainSkill(org, domain, name, content, updatedBy, updatedAt, provenance);
}

export function deleteDomainSkill(org: string, domain: string, name: string): Promise<boolean> {
  return getOperationalStore().deleteDomainSkill(org, domain, name);
}

export function listDomainSkillRevisions(org: string, domain: string, name?: string): Promise<DomainSkillRevisionRow[]> {
  return getOperationalStore().listDomainSkillRevisions(org, domain, name);
}

export function withDescription(content: string, description?: string): string {
  if (!description) return content;
  if (content.trimStart().startsWith("---")) return content;
  const oneLine = description.replace(/\r?\n/g, " ").trim();
  return `---\ndescription: ${oneLine}\n---\n\n${content}`;
}

export function skillPackageFromRow(row: DomainSkillRow): SkillPackageDefinition {
  const desc = parseFrontmatter(row.content).data.description;
  return {
    description:
      typeof desc === "string" && desc
        ? desc
        : `Domain skill "${row.name}" for the "${row.domain}" domain${row.updatedBy ? `, authored by ${row.updatedBy}` : ""}.`,
    markdown: row.content,
  };
}

export async function resolveDomainSkillRows(
  ctx: BindableContext,
  grantedNames: ReadonlySet<string>,
  warn: (msg: string) => void = (msg) => console.warn(`[open-everywhere:domain-skills] ${msg}`),
): Promise<DomainSkillRow[]> {
  const domain = resolveSkillDomain(ctx);
  if (!domain) return [];
  let rows: DomainSkillRow[];
  try {
    rows = await listDomainSkills(resolvePartition(ctx).org, domain);
  } catch (err) {
    warn(`failed to read domain "${domain}"'s skills — skipped for this turn: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const out: DomainSkillRow[] = [];
  for (const row of rows) {
    if (!isSafeSkillName(row.name)) {
      warn(`domain "${domain}" skill "${row.name}" has an unsafe name — dropped (a bad name would otherwise take the whole dynamic skill set down)`);
      continue;
    }
    if (grantedNames.has(row.name)) {
      warn(`domain "${domain}" skill "${row.name}" collides with a granted skill — granted wins, domain skill dropped`);
      continue;
    }
    out.push(row);
  }
  return out;
}
