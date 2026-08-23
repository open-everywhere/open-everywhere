export const UPGRADE_UNITS = ["config", "oeVersion", "evePin", "provider"] as const;
export type UpgradeUnit = (typeof UPGRADE_UNITS)[number];

export interface ReleaseChange {
  readonly unit: UpgradeUnit;
  readonly summary: string;
  readonly derived: boolean;
}

export interface ReleaseMigration {
  readonly id: string;
  readonly unit: UpgradeUnit;
  readonly required: boolean;
  readonly backwardsCompatible: boolean;
  readonly description: string;
  readonly derived: boolean;
}

export interface ReleaseRollback {
  readonly command: string;
  readonly notes?: string;
}

export interface ReleaseRecord {
  readonly formatVersion: 1;
  readonly sha: string;
  readonly previousSha: string | null;
  readonly date: string;
  readonly summary: string;
  readonly changes: readonly ReleaseChange[];
  readonly migrations: readonly ReleaseMigration[];
  readonly verify: readonly string[];
  readonly rollback: ReleaseRollback;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function parseReleaseRecord(raw: unknown, context: string): { record?: ReleaseRecord; problems: string[] } {
  const problems: string[] = [];
  const p = (msg: string) => problems.push(`${context}: ${msg}`);

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    p("is not a JSON object");
    return { problems };
  }
  const r = raw as Record<string, unknown>;

  if (r.formatVersion !== 1) p(`formatVersion must be the literal 1 — got ${JSON.stringify(r.formatVersion)}`);
  if (!isNonEmptyString(r.sha) || !SHA_RE.test(r.sha)) p(`sha must be a 40-char lowercase hex commit sha — got ${JSON.stringify(r.sha)}`);
  if (r.previousSha !== null && (!isNonEmptyString(r.previousSha) || !SHA_RE.test(r.previousSha as string))) {
    p(`previousSha must be null or a 40-char lowercase hex commit sha — got ${JSON.stringify(r.previousSha)}`);
  }
  if (!isNonEmptyString(r.date) || !isValidCalendarDate(r.date)) p(`date must be a real YYYY-MM-DD calendar date — got ${JSON.stringify(r.date)}`);
  if (!isNonEmptyString(r.summary)) p(`summary must be a non-empty string`);

  const changes = Array.isArray(r.changes) ? r.changes : undefined;
  if (!changes) p(`changes must be an array`);
  else if (changes.length === 0) p(`changes must describe at least one thing — an empty array means nothing happened, which is not a release`);
  else {
    changes.forEach((c, i) => {
      if (typeof c !== "object" || c === null) return p(`changes[${i}] is not an object`);
      const cc = c as Record<string, unknown>;
      if (!UPGRADE_UNITS.includes(cc.unit as UpgradeUnit)) p(`changes[${i}].unit must be one of ${UPGRADE_UNITS.join(", ")} — got ${JSON.stringify(cc.unit)}`);
      if (!isNonEmptyString(cc.summary)) p(`changes[${i}].summary must be a non-empty string`);
      if (typeof cc.derived !== "boolean") p(`changes[${i}].derived must be a boolean`);
    });
  }

  const migrations = Array.isArray(r.migrations) ? r.migrations : undefined;
  if (!migrations) p(`migrations must be an array (empty is fine — not every release needs deployer action)`);
  else {
    const ids = new Set<string>();
    migrations.forEach((m, i) => {
      if (typeof m !== "object" || m === null) return p(`migrations[${i}] is not an object`);
      const mm = m as Record<string, unknown>;
      if (!isNonEmptyString(mm.id)) p(`migrations[${i}].id must be a non-empty string`);
      else if (ids.has(mm.id)) p(`migrations[${i}].id "${mm.id}" duplicates an earlier migration in this record`);
      else ids.add(mm.id);
      if (!UPGRADE_UNITS.includes(mm.unit as UpgradeUnit)) p(`migrations[${i}].unit must be one of ${UPGRADE_UNITS.join(", ")} — got ${JSON.stringify(mm.unit)}`);
      if (typeof mm.required !== "boolean") p(`migrations[${i}].required must be a boolean`);
      if (typeof mm.backwardsCompatible !== "boolean") p(`migrations[${i}].backwardsCompatible must be a boolean`);
      if (!isNonEmptyString(mm.description)) p(`migrations[${i}].description must be a non-empty string`);
      if (typeof mm.derived !== "boolean") p(`migrations[${i}].derived must be a boolean`);
    });
  }

  const verify = Array.isArray(r.verify) ? r.verify : undefined;
  if (!verify) p(`verify must be an array`);
  else if (verify.length === 0) p(`verify must name at least one acceptance rung`);
  else verify.forEach((v, i) => { if (!isNonEmptyString(v)) p(`verify[${i}] must be a non-empty string`); });

  const rollback = typeof r.rollback === "object" && r.rollback !== null ? (r.rollback as Record<string, unknown>) : undefined;
  if (!rollback) p(`rollback must be an object`);
  else {
    if (!isNonEmptyString(rollback.command)) p(`rollback.command must be a non-empty string`);
    if (rollback.notes !== undefined && !isNonEmptyString(rollback.notes)) p(`rollback.notes, when present, must be a non-empty string`);
  }

  if (problems.length > 0) return { problems };
  return { record: raw as unknown as ReleaseRecord, problems: [] };
}
