import { CHECK_FAILURE_CONCLUSIONS, type PrStatusSnapshot } from "./pr-status.js";

export const PR_FINGERPRINT_VERSION = "v1";

export const MAX_CHECKS_PER_SUBSCRIPTION = 96;

function fingerprintFields(s: PrStatusSnapshot): Record<string, string> {
  const a = s.activity;
  const c = s.checks;
  let failing = 0;
  for (const [conclusion, count] of Object.entries(c?.byConclusion ?? {})) {
    if (CHECK_FAILURE_CONCLUSIONS.has(conclusion)) failing += count;
  }
  return {
    st: s.state,
    mg: s.merged ? "1" : "0",
    dr: s.draft ? "1" : "0",
    ti: shortHash(s.title),
    rv: String(a?.reviews ?? 0),
    ap: String(a?.approvals ?? 0),
    cr: String(a?.changesRequested ?? 0),
    ic: String(a?.issueComments ?? 0),
    rc: String(a?.reviewComments ?? 0),
    cm: String(a?.commits ?? 0),
    ck: `${c?.total ?? 0}/${failing}/${c?.pending ?? 0}`,
  };
}

export function prFingerprint(s: PrStatusSnapshot): string {
  const fields = fingerprintFields(s);
  return [PR_FINGERPRINT_VERSION, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join(" ");
}

export function parsePrFingerprint(fp: string | undefined): Record<string, string> | null {
  const parts = (fp ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts[0] !== PR_FINGERPRINT_VERSION) return null;
  const out: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function diffPrFingerprint(prev: string | undefined, s: PrStatusSnapshot): string[] {
  const before = parsePrFingerprint(prev);
  if (!before) return [];
  const now = fingerprintFields(s);
  const grew = (k: string): number => {
    const a = Number(before[k]);
    const b = Number(now[k]);
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a : 0;
  };

  const out: string[] = [];
  if (now.mg === "1" && before.mg !== "1") out.push("MERGED");
  else if (now.st === "closed" && before.st !== "closed") out.push("CLOSED without merging");
  if (before.dr === "1" && now.dr === "0") out.push("marked ready for review");
  if (before.dr === "0" && now.dr === "1") out.push("converted back to draft");
  if (before.ti !== now.ti) out.push("title changed");

  const approvals = grew("ap");
  const changes = grew("cr");
  if (approvals > 0) out.push(withReviewer(`${count(approvals, "new approval")}`, s, "APPROVED"));
  if (changes > 0) out.push(withReviewer(`${count(changes, "new change request")}`, s, "CHANGES_REQUESTED"));
  const otherReviews = grew("rv") - approvals - changes;
  if (otherReviews > 0) out.push(count(otherReviews, "new review"));

  const issueComments = grew("ic");
  if (issueComments > 0) out.push(count(issueComments, "new comment"));
  const reviewComments = grew("rc");
  if (reviewComments > 0) out.push(count(reviewComments, "new inline review comment"));
  const commits = grew("cm");
  if (commits > 0) out.push(`${count(commits, "new commit")} pushed`);

  const checks = diffChecks(before.ck, now.ck, s);
  if (checks) out.push(checks);
  return out;
}

export function prChangedSince(prev: string | undefined, s: PrStatusSnapshot): boolean {
  return diffPrFingerprint(prev, s).length > 0;
}

function count(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

function withReviewer(label: string, s: PrStatusSnapshot, state: string): string {
  const latest = s.activity?.latestReview;
  return latest && latest.state === state ? `${label} (${latest.author})` : label;
}

function diffChecks(beforeCk: string | undefined, nowCk: string, s: PrStatusSnapshot): string | null {
  const b = triple(beforeCk);
  const a = triple(nowCk);
  if (!b || !a) return null;
  if (a.failing > 0 && b.failing === 0) {
    const names = s.checks?.failing ?? [];
    return `checks FAILING${names.length > 0 ? ` (${names.join(", ")})` : ""}`;
  }
  if (a.failing === 0 && a.pending === 0 && a.total > 0 && (b.failing > 0 || b.pending > 0)) {
    return "checks now green";
  }
  return null;
}

function triple(v: string | undefined): { total: number; failing: number; pending: number } | null {
  const parts = (v ?? "").split("/");
  if (parts.length !== 3) return null;
  const [total, failing, pending] = parts.map(Number);
  return [total, failing, pending].every(Number.isFinite) ? { total, failing, pending } : null;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
