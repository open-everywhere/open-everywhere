import { directoryProvider, type DirectoryGroupReport, type DirectoryPerson, type DirectoryProvider, type DirectorySourceReport } from "./directory.js";
import { directoryMode, planDirectoryOrg, type DirectorySyncPlan, type DirectorySyncStep } from "./directory-sync.js";
import { directoryGroupAllowlist, planDirectoryGroups } from "./group-sync.js";
import { directoryGroupsOf } from "./groups-codemod.js";
import { getConfig } from "../access/config.js";
import type { DirectoryAutoConfirm, DirectoryMode } from "../settings/settings.js";

export const DIRECTORY_PREVIEW_DEFAULT_PEOPLE = 50;
export const DIRECTORY_PREVIEW_MAX_PEOPLE = 500;

const SECTION_CAP = 100;

export function platformIdShapeProblem(platform: string, nativeId: string): string | undefined {
  if (nativeId.includes("@")) return "looks like an email, not a platform user id";
  switch (platform) {
    case "slack":
      return /^[UW][A-Z0-9]{2,}$/u.test(nativeId) ? undefined : "is not a Slack member id (U… or W…), which is what Slack people are keyed by";
    case "github":
      if (/^\d+$/u.test(nativeId)) return "is a numeric id; GitHub people are keyed by their login";
      return /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/u.test(nativeId) ? undefined : "is not a GitHub login, which is what GitHub people are keyed by";
    case "notion":
      return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu.test(nativeId) ? undefined : "is not a Notion user id (a UUID)";
    default:
      return undefined;
  }
}

export interface DirectoryPreviewProblem {
  readonly externalId: string;
  readonly platform: string;
  readonly nativeId: string;
  readonly reason: string;
}

export interface DirectoryPreviewPerson {
  readonly externalId: string;
  readonly displayName: string;
  readonly deprovisioned: boolean;
  readonly accounts: readonly { readonly platform: string; readonly tenant?: string; readonly nativeId: string; readonly grade: string }[];
  readonly groups: number;
  readonly wouldDo: readonly string[];
}

export interface DirectoryPreview {
  readonly org: string;
  readonly provider: { readonly id: string; readonly name: string };
  readonly mode: DirectoryMode;
  readonly policy: DirectoryAutoConfirm;
  readonly wrote: "none";
  readonly requests?: number;
  readonly people: { readonly total: number; readonly active: number; readonly deprovisioned: number; readonly withAccounts: number; readonly withoutAccounts: number };
  readonly accounts: readonly { readonly platform: string; readonly tenant?: string; readonly count: number }[];
  readonly sources?: readonly DirectorySourceReport[];
  readonly problems: { readonly count: number; readonly items: readonly DirectoryPreviewProblem[] };
  readonly groups?: DirectoryGroupReport & {
    readonly overlay?: { readonly counts: Record<string, number> };
    readonly overlayNote?: string;
  };
  readonly wouldDo: {
    readonly counts: DirectorySyncPlan["counts"];
    readonly newLinkSets: number;
    readonly suspensions: readonly { readonly externalId: string; readonly displayName: string; readonly linkSetId: string; readonly handle: string }[];
  };
  readonly warnings: { readonly count: number; readonly items: readonly string[] };
  readonly persons: { readonly shown: number; readonly total: number; readonly items: readonly DirectoryPreviewPerson[] };
  readonly report: readonly string[];
}

function describeStep(step: DirectorySyncStep): string {
  switch (step.kind) {
    case "suggest":
      return (
        `would suggest ${step.platform} "${step.nativeId}" (${step.grade}) into ${step.newSet ? "a NEW link-set" : `link-set ${step.linkSetId}`}` +
        (step.autoConfirm ? ", and confirm it at once (directory.autoConfirm)" : ", waiting for the person's own DM confirmation")
      );
    case "confirm":
      return `would confirm the waiting suggestion ${step.platform} "${step.nativeId}" (${step.grade})`;
    case "suspend":
      return `would SUSPEND link-set ${step.linkSetId} ("${step.handle}"), because the directory reports this person deprovisioned`;
    case "noop":
      return step.platform ? `no change for ${step.platform} "${step.nativeId}": ${step.why}` : `no change: ${step.why}`;
  }
}

function isPlacementProblem(step: DirectorySyncStep): step is Extract<DirectorySyncStep, { kind: "noop" }> & { platform: string; nativeId: string } {
  return step.kind === "noop" && step.platform !== undefined && step.nativeId !== undefined && step.why !== "already confirmed" && !step.why.startsWith("suggested");
}

export async function previewDirectoryOrg(input: {
  readonly org: string;
  readonly provider?: DirectoryProvider;
  readonly limit?: number;
  readonly autoConfirm?: DirectoryAutoConfirm;
  readonly accessReferencedSets?: ReadonlySet<string>;
  readonly linkSetVaultArmed?: boolean;
}): Promise<DirectoryPreview | null> {
  const provider = input.provider ?? directoryProvider();
  if (!provider) return null;
  const limit = Math.max(0, Math.min(DIRECTORY_PREVIEW_MAX_PEOPLE, Math.floor(input.limit ?? DIRECTORY_PREVIEW_DEFAULT_PEOPLE)));

  const inspection = provider.inspect ? await provider.inspect() : undefined;
  const people: readonly DirectoryPerson[] = inspection ? inspection.people : await provider.listPeople();

  const plan = await planDirectoryOrg({
    org: input.org,
    provider: provider.id,
    people,
    ...(input.autoConfirm ? { autoConfirm: input.autoConfirm } : {}),
    ...(input.accessReferencedSets ? { accessReferencedSets: input.accessReferencedSets } : {}),
    ...(input.linkSetVaultArmed !== undefined ? { linkSetVaultArmed: input.linkSetVaultArmed } : {}),
  });

  const deprovisioned = people.filter((p) => p.deprovisioned).length;
  const withAccounts = people.filter((p) => p.accounts.length > 0).length;
  const byPlatform = new Map<string, { platform: string; tenant?: string; count: number }>();
  const problems: DirectoryPreviewProblem[] = [];
  for (const person of people) {
    for (const acct of person.accounts) {
      const key = `${acct.platform}\u0000${acct.tenant ?? ""}`;
      const row = byPlatform.get(key) ?? { platform: acct.platform, ...(acct.tenant ? { tenant: acct.tenant } : {}), count: 0 };
      row.count++;
      byPlatform.set(key, row);
      const shape = platformIdShapeProblem(acct.platform, acct.nativeId);
      if (shape) problems.push({ externalId: person.externalId, platform: acct.platform, nativeId: acct.nativeId, reason: `the id ${shape}, so it can never match a person who talks to the agent` });
    }
  }
  for (const step of plan.steps) {
    if (isPlacementProblem(step)) problems.push({ externalId: step.externalId, platform: step.platform, nativeId: step.nativeId, reason: step.why });
  }

  let groups: DirectoryPreview["groups"];
  if (inspection?.groups) {
    try {
      const current = directoryGroupsOf(getConfig().loadGroups?.() ?? []);
      const allowGroups = directoryGroupAllowlist();
      const gplan = planDirectoryGroups({ provider: provider.id, people, current, ...(allowGroups ? { allowGroups } : {}) });
      groups = { ...inspection.groups, overlay: { counts: { ...gplan.counts } } };
    } catch (e) {
      groups = { ...inspection.groups, overlayNote: `the group overlay plan could not be computed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const nameOf = new Map(people.map((p) => [p.externalId, p.displayName] as const));
  const suspensions = plan.steps
    .filter((s): s is Extract<DirectorySyncStep, { kind: "suspend" }> => s.kind === "suspend")
    .map((s) => ({ externalId: s.externalId, displayName: nameOf.get(s.externalId) ?? s.externalId, linkSetId: s.linkSetId, handle: s.handle }));
  const newLinkSets = new Set(plan.steps.filter((s) => s.kind === "suggest" && s.newSet).map((s) => (s as Extract<DirectorySyncStep, { kind: "suggest" }>).linkSetId)).size;

  const stepsBy = new Map<string, DirectorySyncStep[]>();
  for (const step of plan.steps) stepsBy.set(step.externalId, [...(stepsBy.get(step.externalId) ?? []), step]);
  const problemIds = new Set(problems.map((p) => p.externalId));
  const rank = (p: DirectoryPerson): number => ((stepsBy.get(p.externalId) ?? []).some((s) => s.kind === "suspend") ? 0 : problemIds.has(p.externalId) ? 1 : 2);
  const ordered = [...people].sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
  const persons: DirectoryPreviewPerson[] = ordered.slice(0, limit).map((p) => ({
    externalId: p.externalId,
    displayName: p.displayName,
    deprovisioned: p.deprovisioned,
    accounts: p.accounts.map((a) => ({ platform: a.platform, ...(a.tenant ? { tenant: a.tenant } : {}), nativeId: a.nativeId, grade: a.grade })),
    groups: p.groups.length,
    wouldDo: (stepsBy.get(p.externalId) ?? []).map(describeStep),
  }));

  const preview: Omit<DirectoryPreview, "report"> = {
    org: input.org,
    provider: { id: provider.id, name: provider.name },
    mode: directoryMode(),
    policy: plan.policy,
    wrote: "none",
    ...(inspection?.requests !== undefined ? { requests: inspection.requests } : {}),
    people: { total: people.length, active: people.length - deprovisioned, deprovisioned, withAccounts, withoutAccounts: people.length - withAccounts },
    accounts: [...byPlatform.values()].sort((a, b) => a.platform.localeCompare(b.platform) || (a.tenant ?? "").localeCompare(b.tenant ?? "")),
    ...(inspection ? { sources: inspection.sources } : {}),
    problems: { count: problems.length, items: problems.slice(0, SECTION_CAP) },
    ...(groups ? { groups } : {}),
    wouldDo: { counts: plan.counts, newLinkSets, suspensions: suspensions.slice(0, SECTION_CAP) },
    warnings: { count: plan.warnings.length, items: plan.warnings.slice(0, SECTION_CAP) },
    persons: { shown: persons.length, total: people.length, items: persons },
  };
  const masked = maskEmails(preview);
  return { ...masked, report: renderDirectoryPreview(masked) };
}

const EMAIL = /[^\s"'<>()[\],;:@]+@([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+)/gu;

export function maskEmails<T>(value: T): T {
  if (typeof value === "string") return value.replace(EMAIL, "…@$1") as T;
  if (Array.isArray(value)) return value.map((v) => maskEmails(v)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskEmails(v)])) as T;
  return value;
}

function renderDirectoryPreview(p: Omit<DirectoryPreview, "report">): string[] {
  const out: string[] = [];
  const more = (shown: number, total: number): void => {
    if (total > shown) out.push(`    … and ${total - shown} more`);
  };
  out.push(`Directory preview for org "${p.org}" — ${p.provider.name}. Mode: ${p.mode}. Nothing was written.`);
  if (p.mode === "sync") out.push(`  ⚠ directory.mode is "sync": the daily schedule APPLIES this plan at 03:00 UTC. Set directory.mode: "observe" to stop it.`);
  out.push(
    `People: ${p.people.total} listed — ${p.people.active} active, ${p.people.deprovisioned} deprovisioned; ${p.people.withAccounts} map at least one account, ${p.people.withoutAccounts} map none.`,
  );
  if (p.requests !== undefined) out.push(`Cost: ${p.requests} HTTP request(s) to the directory for this read. A real sync makes the same reads.`);

  out.push("Accounts by platform:");
  if (p.accounts.length === 0) out.push("  (none — no configured source mapped any account)");
  for (const a of p.accounts) out.push(`  ${a.platform}${a.tenant ? ` (workspace ${a.tenant})` : ""}: ${a.count}`);

  if (p.sources) {
    out.push("Sources (one per configured app):");
    if (p.sources.length === 0) out.push("  (none — directory.oktaApps is empty, so no account can be mapped)");
    for (const s of p.sources) {
      out.push(`  ${s.platform}${s.tenant ? `/${s.tenant}` : ""} from ${s.source}: field ${s.field}, grade ${s.grade} — ${s.assignments} assignment(s), ${s.mapped} mapped`);
      for (const k of s.skipped) out.push(`    · ${k.count} skipped: ${k.reason}${k.examples.length ? ` (e.g. ${k.examples.join(", ")})` : ""}`);
    }
  }

  out.push(`Unmatched or malformed mappings: ${p.problems.count}`);
  for (const x of p.problems.items) out.push(`  · ${x.platform} "${x.nativeId}" for ${x.externalId}: ${x.reason}`);
  more(p.problems.items.length, p.problems.count);

  if (p.groups) {
    const g = p.groups;
    out.push(
      `Groups: ${g.total} listed, ${g.read.length} read${g.allowlist ? `, ${g.skipped} not read (outside directory.groupAllowlist)` : " (directory.groupAllowlist is empty, so every group is read)"}.`,
    );
    if (g.allowlistMissing.length) out.push(`  ⚠ allowlisted but not in the directory (the match is verbatim): ${g.allowlistMissing.map((n) => `"${n}"`).join(", ")}`);
    if (g.read.length) out.push(`  read: ${g.read.slice(0, SECTION_CAP).join(", ")}${g.read.length > SECTION_CAP ? ` … and ${g.read.length - SECTION_CAP} more` : ""}`);
    if (g.overlay) {
      const c = g.overlay.counts;
      out.push(`  The person-group overlay directory_groups_plan would propose: +${c["addGroup"] ?? 0} group(s), -${c["dropGroup"] ?? 0} group(s), +${c["addMember"] ?? 0} member(s), -${c["removeMember"] ?? 0} member(s).`);
    }
    if (g.overlayNote) out.push(`  ${g.overlayNote}`);
  }

  const c = p.wouldDo.counts;
  out.push(`What a real sync would do (directory.autoConfirm: "${p.policy}"):`);
  out.push(`  ${c.suggest} suggestion(s) (${p.wouldDo.newLinkSets} into new link-sets), ${c.confirm} confirmation(s), ${c.suspend} SUSPENSION(S), ${c.noop} no-op(s).`);
  for (const s of p.wouldDo.suspensions) out.push(`  · SUSPEND link-set ${s.linkSetId} ("${s.handle}") — the directory reports ${s.externalId} (${s.displayName}) deprovisioned`);
  more(p.wouldDo.suspensions.length, c.suspend);

  out.push(`Warnings: ${p.warnings.count}`);
  for (const w of p.warnings.items) out.push(`  · ${w}`);
  more(p.warnings.items.length, p.warnings.count);

  out.push(`People (${p.persons.shown} of ${p.persons.total}; suspensions first, then people with a problem):`);
  for (const person of p.persons.items) {
    out.push(`  ${person.displayName} [${person.externalId}]${person.deprovisioned ? " — DEPROVISIONED" : ""} — ${person.accounts.length} account(s), ${person.groups} group(s)`);
    for (const line of person.wouldDo) out.push(`    · ${line}`);
  }
  return out;
}
