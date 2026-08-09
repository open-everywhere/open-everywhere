import { RAW_VAULT_SUBJECT_PREFIX, SHARED_VAULT_SUBJECT_PREFIX } from "../agent/identity/oauth-vault-share.js";
import { PRINCIPAL_KEY, isQualifiedPrincipalKey, isTenantScopedPlatform } from "../agent/identity/principal-key.js";
import type { AuditInput, OperationalStore } from "../agent/operational/store.js";

const HOLDERS: readonly VaultHolder[] = [
  {
    name: "oe-oauth",
    prefix: "oe-oauth:tok:",
    subjectOf(rest) {
      const marker = ":user:";
      const first = rest.indexOf(marker);
      if (first < 0) return { kind: "not-subject-keyed" };
      if (rest.indexOf(marker, first + 1) >= 0) {
        return { kind: "skip", reason: `the "${marker}" marker appears more than once — the subject cannot be split out unambiguously` };
      }
      return { kind: "subject", subject: rest.slice(first + marker.length) };
    },
  },
  {
    name: "aws-sso",
    prefix: "aws-sso:tok:",
    subjectOf(rest) {
      return rest.length === 0 ? { kind: "skip", reason: "an empty subject after the holder prefix" } : { kind: "subject", subject: rest };
    },
  },
];

interface VaultHolder {
  readonly name: string;
  readonly prefix: string;
  readonly subjectOf: (rest: string) => { kind: "subject"; subject: string } | { kind: "not-subject-keyed" } | { kind: "skip"; reason: string };
}

export function orphanSweepHolders(): readonly string[] {
  return HOLDERS.map((h) => h.name);
}

export type RefVerdict =
  | { readonly kind: "orphan"; readonly holder: string; readonly subject: string; readonly org: string; readonly platform: string; readonly nativeId: string }
  | { readonly kind: "current"; readonly holder: string; readonly subject: string }
  | { readonly kind: "not-subject-keyed" }
  | { readonly kind: "skip"; readonly holder?: string; readonly subject?: string; readonly reason: string };

export function classifyVaultRef(ref: string, expectedOrg: string): RefVerdict {
  const holder = HOLDERS.find((h) => ref.startsWith(h.prefix));
  if (!holder) return { kind: "not-subject-keyed" };
  const read = holder.subjectOf(ref.slice(holder.prefix.length));
  if (read.kind === "not-subject-keyed") return { kind: "not-subject-keyed" };
  if (read.kind === "skip") return { kind: "skip", holder: holder.name, reason: read.reason };
  const subject = read.subject;

  if (subject.startsWith(SHARED_VAULT_SUBJECT_PREFIX)) return { kind: "current", holder: holder.name, subject };
  if (!subject.startsWith(RAW_VAULT_SUBJECT_PREFIX)) {
    return { kind: "skip", holder: holder.name, subject, reason: `no "${RAW_VAULT_SUBJECT_PREFIX}" prefix — an unqualified pre-OPE-286 subject, out of scope for OPE-349 (it carries no org and no platform to check)` };
  }

  const body = subject.slice(RAW_VAULT_SUBJECT_PREFIX.length);
  const cut = body.indexOf("/");
  if (cut <= 0) return { kind: "skip", holder: holder.name, subject, reason: "no org segment — the subject does not split into <org>/<principal-key>" };
  const org = body.slice(0, cut);
  const key = body.slice(cut + 1);
  if (org !== expectedOrg) {
    return { kind: "skip", holder: holder.name, subject, reason: `the subject's own org segment is "${org}", not the org being swept ("${expectedOrg}")` };
  }

  if (isQualifiedPrincipalKey(key)) return { kind: "current", holder: holder.name, subject };

  const parts = key.split("/");
  if (parts.length === 2 && PRINCIPAL_KEY.test(key) && isTenantScopedPlatform(parts[0])) {
    return { kind: "orphan", holder: holder.name, subject, org, platform: parts[0]!, nativeId: parts[1]! };
  }
  return {
    kind: "skip",
    holder: holder.name,
    subject,
    reason: `"${key}" is neither a key today's grammar composes nor the pre-OPE-309 two-segment shape on a tenant-scoped platform`,
  };
}

export interface ScannedRef {
  readonly ref: string;
  readonly verdict: RefVerdict;
  readonly deleted: boolean;
}

export interface SweepReport {
  readonly org: string;
  readonly apply: boolean;
  readonly scanned: number;
  readonly matched: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly current: number;
  readonly notSubjectKeyed: number;
  readonly byHolder: Readonly<Record<string, { readonly matched: number; readonly deleted: number }>>;
  readonly rows: readonly ScannedRef[];
}

export interface SweepDeps {
  readonly store: Pick<OperationalStore, "listStoredCredentialRefs" | "deleteStoredCredential">;
  readonly org: string;
  readonly apply?: boolean;
  readonly actor: string;
  readonly audit: (entry: AuditInput) => Promise<void>;
}

export async function sweepOrphanedVaultRows(deps: SweepDeps): Promise<SweepReport> {
  const apply = deps.apply === true;
  const refs = await deps.store.listStoredCredentialRefs(deps.org);
  const rows: ScannedRef[] = [];
  const byHolder: Record<string, { matched: number; deleted: number }> = {};
  let matched = 0;
  let deleted = 0;
  let skipped = 0;
  let current = 0;
  let notSubjectKeyed = 0;

  for (const ref of refs) {
    const verdict = classifyVaultRef(ref, deps.org);
    let didDelete = false;
    if (verdict.kind === "orphan") {
      matched++;
      const tally = (byHolder[verdict.holder] ??= { matched: 0, deleted: 0 });
      tally.matched++;
      if (apply) {
        didDelete = await deps.store.deleteStoredCredential(deps.org, ref);
        if (didDelete) {
          deleted++;
          tally.deleted++;
          await deps.audit({
            org: deps.org,
            platform: verdict.platform,
            workspace: verdict.platform,
            principalId: deps.actor,
            action: "identity.credential.orphan_purged",
            detail: { ref, subject: verdict.subject, holder: verdict.holder, platform: verdict.platform, nativeId: verdict.nativeId, reason: "pre-OPE-309 two-segment slack vault subject (unreachable by resolve and by revokeLinkSet's purge sweep)" },
          });
        }
      }
    } else if (verdict.kind === "current") current++;
    else if (verdict.kind === "not-subject-keyed") notSubjectKeyed++;
    else skipped++;
    rows.push({ ref, verdict, deleted: didDelete });
  }

  return { org: deps.org, apply, scanned: refs.length, matched, deleted, skipped, current, notSubjectKeyed, byHolder, rows };
}
