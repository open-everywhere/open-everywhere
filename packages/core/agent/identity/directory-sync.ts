import { createHash } from "node:crypto";
import { appendAudit, readAudit } from "../audit/audit.js";
import { directoryProvider, type DirectoryGrade, type DirectoryPerson, type DirectoryProvider } from "./directory.js";
import { ensureLinkSet, confirmLinkedId, listLinkSetsWithIds, setLinkSetHold, suggestLinkedId, type LinkEvidence } from "./link-store.js";
import { principalKey } from "./principal-key.js";
import { accessReferencedLinkSets } from "../access/access-referenced-link-sets.js";
import { getConfig } from "../access/config.js";
import { connectorLinkSetVaultEnabled, OE_CONNECTOR_LINKSET_VAULT_ENV } from "../connections/connector-flags.js";
import type { LinkSetRow, LinkedIdRow } from "../operational/store.js";

function log(msg: string): void {
  console.log(`[open-everywhere:identity/directory-sync] ${msg}`);
}

function accessReferencedSetsFromConfig(): Set<string> {
  try {
    const cfg = getConfig();
    return accessReferencedLinkSets({
      bindings: cfg.loadBindings(),
      groups: cfg.loadGroups?.() ?? [],
    });
  } catch {
    return new Set<string>();
  }
}

export function directoryLinkSetVaultArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return connectorLinkSetVaultEnabled(env);
  } catch {
    return true;
  }
}

export type DirectoryAutoConfirm = "off" | "attested";

export const OE_DIRECTORY_AUTOCONFIRM_ENV = "OE_DIRECTORY_AUTOCONFIRM";

export function directoryAutoConfirm(env: NodeJS.ProcessEnv = process.env): DirectoryAutoConfirm {
  const raw = env[OE_DIRECTORY_AUTOCONFIRM_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return "off";
  if (raw === "off" || raw === "attested") return raw;
  throw new Error(
    `${OE_DIRECTORY_AUTOCONFIRM_ENV}="${env[OE_DIRECTORY_AUTOCONFIRM_ENV]}" is not a policy — use "off" (default: every ` +
      `directory suggestion waits for the person's own DM confirmation) or "attested" (mappings the IdP itself ` +
      `provisions are auto-confirmed; weaker "asserted" and "email-match" mappings still wait).`,
  );
}

export const DIRECTORY_SYNC_ACTOR = "directory-sync";

export const DIRECTORY_SYNC_ACTION = "identity.directory.sync";

export function directoryLinkSetId(provider: string, externalId: string): string {
  return `dir-${createHash("sha256").update(`${provider}\u0000${externalId}`, "utf8").digest("hex").slice(0, 32)}`;
}

export type DirectorySyncStep =
  | {
      readonly kind: "suggest";
      readonly externalId: string;
      readonly platform: string;
      readonly nativeId: string;
      readonly grade: DirectoryGrade;
      readonly linkSetId: string;
      readonly newSet: boolean;
      readonly handle: string;
      readonly autoConfirm: boolean;
    }
  | {
      readonly kind: "confirm";
      readonly externalId: string;
      readonly platform: string;
      readonly nativeId: string;
      readonly grade: DirectoryGrade;
      readonly linkSetId: string;
    }
  | { readonly kind: "suspend"; readonly externalId: string; readonly linkSetId: string; readonly handle: string }
  | {
      readonly kind: "noop";
      readonly externalId: string;
      readonly platform?: string;
      readonly nativeId?: string;
      readonly why: string;
    };

export interface DirectorySyncPlan {
  readonly provider: string;
  readonly policy: DirectoryAutoConfirm;
  readonly people: number;
  readonly steps: readonly DirectorySyncStep[];
  readonly warnings: readonly string[];
  readonly counts: {
    readonly suggest: number;
    readonly confirm: number;
    readonly suspend: number;
    readonly noop: number;
  };
}

export function planIsNoop(plan: DirectorySyncPlan): boolean {
  return plan.steps.every((s) => s.kind === "noop");
}

export type DirectoryLinkState = readonly { readonly set: LinkSetRow; readonly ids: readonly LinkedIdRow[] }[];

const GRADE_ORDER: readonly DirectoryGrade[] = ["attested", "asserted", "email-match"];

function gradeRank(g: DirectoryGrade): number {
  const i = GRADE_ORDER.indexOf(g);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

function strongerGrade(a: DirectoryGrade, b: DirectoryGrade): DirectoryGrade {
  return gradeRank(a) <= gradeRank(b) ? a : b;
}

function whyNotConfirmed(grade: DirectoryGrade): string {
  switch (grade) {
    case "attested":
      return "suggested — awaiting this person's DM confirmation";
    case "asserted":
      return "suggested (asserted) — the IdP states this mapping but the platform never confirmed it; only this account can";
    case "email-match":
      return "suggested (email-match) — only a person can confirm this one";
    default:
      return `suggested (${String(grade)}) — unrecognised evidence grade; only this account can confirm it`;
  }
}

export function planDirectorySync(input: {
  readonly provider: string;
  readonly people: readonly DirectoryPerson[];
  readonly current: DirectoryLinkState;
  readonly autoConfirm: DirectoryAutoConfirm;
  readonly accessReferencedSets?: ReadonlySet<string>;
  readonly linkSetVaultArmed?: boolean;
}): DirectorySyncPlan {
  const steps: DirectorySyncStep[] = [];
  const warnings: string[] = [];

  const vaultArmed = input.linkSetVaultArmed === true;
  if (vaultArmed && input.autoConfirm === "attested") {
    warnings.push(
      `${OE_CONNECTOR_LINKSET_VAULT_ENV} is armed, so EVERY confirmed member of an active link-set can mint that set's SHARED user-OAuth token (C.3) — ` +
        `directory auto-confirm is therefore SUPPRESSED for ALL link-sets, not only the ones access config names (C2.4, threat (c)). ` +
        `Every attested mapping lands as a suggestion awaiting the person's own DM confirmation, because an IdP edit must not hand a brand-new account somebody else's live credential.`,
    );
  }

  const rowByKey = new Map<string, { readonly row: LinkedIdRow; readonly set: LinkSetRow }>();
  const setById = new Map<string, LinkSetRow>();
  const idsBySetId = new Map<string, readonly LinkedIdRow[]>();
  for (const { set, ids } of input.current) {
    setById.set(set.id, set);
    idsBySetId.set(set.id, ids);
    for (const row of ids) rowByKey.set(principalKey(row.platform, row.nativeId), { row, set });
  }

  const claimedBy = new Map<string, string>();
  for (const person of input.people) {
    for (const acct of person.accounts) {
      const key = principalKey(acct.platform, acct.nativeId);
      const first = claimedBy.get(key);
      if (first === undefined) claimedBy.set(key, person.externalId);
      else if (first !== person.externalId) claimedBy.set(key, "\u0000conflict");
    }
  }

  for (const person of input.people) {
    const accounts = new Map<string, { platform: string; nativeId: string; grade: DirectoryGrade }>();
    for (const acct of person.accounts) {
      const key = principalKey(acct.platform, acct.nativeId);
      const seen = accounts.get(key);
      accounts.set(key, seen ? { ...seen, grade: strongerGrade(seen.grade, acct.grade) } : { ...acct });
    }

    for (const [key, acct] of [...accounts]) {
      if (claimedBy.get(key) === "\u0000conflict") {
        accounts.delete(key);
        steps.push({ kind: "noop", externalId: person.externalId, platform: acct.platform, nativeId: acct.nativeId, why: "two directory records claim this account" });
        warnings.push(`${key} is claimed by more than one directory person — refusing to link it to any of them. Fix the duplicate in the IdP.`);
      }
    }

    const anchors = new Set<string>();
    for (const key of accounts.keys()) {
      const found = rowByKey.get(key);
      if (found) anchors.add(found.set.id);
    }

    if (anchors.size > 1) {
      const named = [...anchors].sort().join(", ");
      warnings.push(
        `directory person "${person.externalId}" maps accounts that already belong to ${anchors.size} DIFFERENT link-sets (${named}) — refusing to merge them. ` +
          `An account is exactly one person; an admin has to decide which set is right (link_sets_list / revoke_link_set).`,
      );
      steps.push({ kind: "noop", externalId: person.externalId, why: `ambiguous: accounts span ${anchors.size} link-sets` });
      continue;
    }

    const anchorId = [...anchors][0];
    const anchored = anchorId === undefined ? undefined : setById.get(anchorId);
    const derivedId = directoryLinkSetId(input.provider, person.externalId);
    const target = anchored ?? setById.get(derivedId);

    if (person.deprovisioned) {
      if (!target) {
        steps.push({ kind: "noop", externalId: person.externalId, why: "deprovisioned in the directory, and holds no link-set here" });
      } else if (target.status === "active") {
        const members = idsBySetId.get(target.id) ?? [];
        const challengeBuilt = members.some((r) => r.status !== "revoked" && r.establishedBy.startsWith("challenge:"));
        if (challengeBuilt) {
          steps.push({ kind: "noop", externalId: person.externalId, why: "deprovisioned, but the anchored link-set has challenge-proven members — refusing to suspend a set the directory did not build" });
          warnings.push(
            `directory person "${person.externalId}" is deprovisioned, but the link-set it anchors (${target.id}) contains challenge-established account(s) — refusing to suspend a proof-of-control-built set on an IdP deprovision. ` +
              `If this offboarding is real, an admin has suspend_link_set / revoke_link_set.`,
          );
        } else {
          steps.push({ kind: "suspend", externalId: person.externalId, linkSetId: target.id, handle: target.handle });
        }
      } else {
        steps.push({ kind: "noop", externalId: person.externalId, why: `deprovisioned; link-set is already ${target.status}` });
      }
      continue;
    }

    if (accounts.size === 0) {
      steps.push({ kind: "noop", externalId: person.externalId, why: "directory maps no platform accounts for this person" });
      continue;
    }

    if (target && target.status !== "active") {
      for (const acct of accounts.values()) {
        steps.push({ kind: "noop", externalId: person.externalId, platform: acct.platform, nativeId: acct.nativeId, why: `link-set is ${target.status}` });
      }
      continue;
    }

    const targetId = target?.id ?? derivedId;
    const newSet = target === undefined;
    const targetAccessReferenced = vaultArmed || (input.accessReferencedSets?.has(targetId) ?? false);
    if (!vaultArmed && targetAccessReferenced && input.autoConfirm === "attested" && accounts.size > 0) {
      warnings.push(
        `link-set ${targetId} is referenced by ACCESS config (a \`principal\` credential binding or a person-group), so directory auto-confirm is SUPPRESSED for it (C2.4) — an attested mapping still lands as a suggestion awaiting the person's own DM confirmation, because an IdP attestation must not widen an access-bearing set without a human in the loop.`,
      );
    }
    for (const [key, acct] of accounts) {
      const found = rowByKey.get(key);
      const mayAutoConfirm = input.autoConfirm === "attested" && acct.grade === "attested" && !targetAccessReferenced;
      if (!found) {
        steps.push({
          kind: "suggest",
          externalId: person.externalId,
          platform: acct.platform,
          nativeId: acct.nativeId,
          grade: acct.grade,
          linkSetId: targetId,
          newSet,
          handle: person.displayName || person.externalId,
          autoConfirm: mayAutoConfirm,
        });
        continue;
      }
      if (found.set.id !== targetId) {
        warnings.push(`${key} belongs to link-set ${found.set.id}, not ${targetId} — refusing to move it.`);
        steps.push({ kind: "noop", externalId: person.externalId, platform: acct.platform, nativeId: acct.nativeId, why: "belongs to another link-set" });
        continue;
      }
      if (found.row.status === "revoked") {
        steps.push({ kind: "noop", externalId: person.externalId, platform: acct.platform, nativeId: acct.nativeId, why: "revoked (terminal)" });
        continue;
      }
      if (found.row.status === "confirmed") {
        steps.push({ kind: "noop", externalId: person.externalId, platform: acct.platform, nativeId: acct.nativeId, why: "already confirmed" });
        continue;
      }
      if (mayAutoConfirm) {
        steps.push({ kind: "confirm", externalId: person.externalId, platform: acct.platform, nativeId: acct.nativeId, grade: acct.grade, linkSetId: targetId });
      } else {
        steps.push({
          kind: "noop",
          externalId: person.externalId,
          platform: acct.platform,
          nativeId: acct.nativeId,
          why: whyNotConfirmed(acct.grade),
        });
      }
    }
  }

  const counts = {
    suggest: steps.filter((s) => s.kind === "suggest").length,
    confirm: steps.filter((s) => s.kind === "confirm").length,
    suspend: steps.filter((s) => s.kind === "suspend").length,
    noop: steps.filter((s) => s.kind === "noop").length,
  };
  return { provider: input.provider, policy: input.autoConfirm, people: input.people.length, steps, warnings, counts };
}

export interface DirectorySyncResult {
  readonly org: string;
  readonly provider: string;
  readonly policy: DirectoryAutoConfirm;
  readonly plan: DirectorySyncPlan;
  readonly applied: {
    readonly setsCreated: number;
    readonly suggested: number;
    readonly confirmed: number;
    readonly suspended: number;
  };
  readonly refusals: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export async function syncDirectoryOrg(input: {
  readonly org: string;
  readonly provider?: DirectoryProvider;
  readonly autoConfirm?: DirectoryAutoConfirm;
  readonly accessReferencedSets?: ReadonlySet<string>;
  readonly linkSetVaultArmed?: boolean;
  readonly now?: Date;
}): Promise<DirectorySyncResult | null> {
  const provider = input.provider ?? directoryProvider();
  if (!provider) return null;
  const policy = input.autoConfirm ?? directoryAutoConfirm();
  const startedAt = (input.now ?? new Date()).toISOString();
  const accessReferencedSets = input.accessReferencedSets ?? accessReferencedSetsFromConfig();
  const vaultArmed = input.linkSetVaultArmed ?? directoryLinkSetVaultArmed();

  const people = await provider.listPeople();
  const current = await listLinkSetsWithIds(input.org);
  const plan = planDirectorySync({ provider: provider.id, people, current, autoConfirm: policy, accessReferencedSets, linkSetVaultArmed: vaultArmed });

  const refusals: string[] = [];
  let setsCreated = 0;
  let suggested = 0;
  let confirmed = 0;
  let suspended = 0;
  const ensured = new Set<string>();

  for (const step of plan.steps) {
    const now = input.now;
    if (step.kind === "noop") continue;
    if (step.kind === "suspend") {
      const res = await setLinkSetHold({ org: input.org, linkSetId: step.linkSetId, hold: "suspended", actor: `${DIRECTORY_SYNC_ACTOR}:${provider.id}`, ...(now ? { now } : {}) });
      if (res.ok) suspended++;
      else refusals.push(`suspend ${step.linkSetId}: ${res.reason}`);
      continue;
    }
    const evidence: LinkEvidence = { kind: "directory-sync", provider: provider.id, grade: step.grade, externalId: step.externalId };
    if (step.kind === "suggest") {
      if (step.newSet && !ensured.has(step.linkSetId)) {
        const { created } = await ensureLinkSet({ org: input.org, linkSetId: step.linkSetId, handle: step.handle, ...(now ? { now } : {}) });
        if (created) setsCreated++;
        ensured.add(step.linkSetId);
      }
      const res = await suggestLinkedId({
        org: input.org,
        linkSetId: step.linkSetId,
        account: { platform: step.platform, nativeId: step.nativeId },
        evidence,
        ...(now ? { now } : {}),
      });
      if (!res.ok) {
        refusals.push(`suggest ${principalKey(step.platform, step.nativeId)}: ${res.reason}`);
        continue;
      }
      suggested++;
      if (!step.autoConfirm) continue;
    }
    const res = await confirmLinkedId({ org: input.org, account: { platform: step.platform, nativeId: step.nativeId }, evidence, ...(now ? { now } : {}) });
    if (res.ok) confirmed++;
    else refusals.push(`confirm ${principalKey(step.platform, step.nativeId)}: ${res.reason}`);
  }

  const finishedAt = new Date(input.now ?? Date.now()).toISOString();
  const result: DirectorySyncResult = {
    org: input.org,
    provider: provider.id,
    policy,
    plan,
    applied: { setsCreated, suggested, confirmed, suspended },
    refusals,
    startedAt,
    finishedAt,
  };

  await appendAudit({
    org: input.org,
    platform: "directory",
    workspace: provider.id,
    principalId: `${DIRECTORY_SYNC_ACTOR}:${provider.id}`,
    action: DIRECTORY_SYNC_ACTION,
    detail: {
      provider: provider.id,
      policy,
      people: plan.people,
      planned: plan.counts,
      applied: result.applied,
      warnings: plan.warnings.slice(0, 20),
      refusals: refusals.slice(0, 20),
      startedAt,
      finishedAt,
    },
  });

  for (const w of plan.warnings) log(`⚠ ${input.org}: ${w}`);
  log(
    `${input.org} (${provider.id}, autoconfirm=${policy}): ${plan.people} person(s) — ` +
      `${result.applied.suggested} suggested, ${result.applied.confirmed} confirmed, ${result.applied.suspended} suspended, ` +
      `${plan.counts.noop} no-op, ${plan.warnings.length} warning(s), ${refusals.length} refusal(s)`,
  );
  return result;
}

export async function runDirectorySync(opts: { readonly orgs?: readonly string[]; readonly now?: Date } = {}): Promise<readonly DirectorySyncResult[]> {
  const provider = directoryProvider();
  if (!provider) {
    log("no directory provider registered — nothing to sync (set OE_DIRECTORY_PROVIDER and wire the adapter to arm it)");
    return [];
  }
  const orgs = opts.orgs ?? directorySyncOrgs();
  const out: DirectorySyncResult[] = [];
  for (const org of orgs) {
    try {
      const res = await syncDirectoryOrg({ org, provider, ...(opts.now ? { now: opts.now } : {}) });
      if (res) out.push(res);
    } catch (err) {
      log(`skip ${org} — ${String(err)}`);
    }
  }
  return out;
}

export function directorySyncOrgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OE_TIDY_ORGS;
  if (!raw) return ["default"];
  const orgs = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return orgs.length > 0 ? orgs : ["default"];
}

export async function lastDirectorySync(org: string): Promise<{ readonly ts: string; readonly detail: Record<string, unknown> } | null> {
  const rows = await readAudit({ org, action: DIRECTORY_SYNC_ACTION, limit: 1 });
  const row = rows[0];
  return row ? { ts: row.ts, detail: { ...(row.detail ?? {}) } } : null;
}

export interface PendingDirectorySuggestion {
  readonly linkSetId: string;
  readonly platform: string;
  readonly nativeId: string;
  readonly principal: string;
  readonly grade: string;
  readonly provider: string;
}

export async function pendingDirectorySuggestionsFor(org: string, platform: string, nativeId: string): Promise<readonly PendingDirectorySuggestion[]> {
  const sets = await listLinkSetsWithIds(org);
  const me = principalKey(platform, nativeId);
  for (const { set, ids } of sets) {
    if (set.status !== "active") continue;
    const mine = ids.find((r) => principalKey(r.platform, r.nativeId) === me);
    if (!mine || (mine.status !== "confirmed" && mine.status !== "suggested")) continue;
    const bootstrapOnly = mine.status !== "confirmed";
    const out: PendingDirectorySuggestion[] = [];
    for (const row of ids) {
      if (row.status !== "suggested") continue;
      if (!row.establishedBy.startsWith("directory-sync:")) continue;
      const isOwn = principalKey(row.platform, row.nativeId) === me;
      if (bootstrapOnly && !isOwn) continue;
      let grade = "unknown";
      try {
        const parsed = JSON.parse(row.evidenceJson ?? "{}") as { grade?: unknown };
        if (typeof parsed.grade === "string") grade = parsed.grade;
      } catch {
      }
      if (grade !== "attested" && !isOwn) continue;
      out.push({
        linkSetId: set.id,
        platform: row.platform,
        nativeId: row.nativeId,
        principal: principalKey(row.platform, row.nativeId),
        grade,
        provider: row.establishedBy.slice("directory-sync:".length),
      });
    }
    return out;
  }
  return [];
}
