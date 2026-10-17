import { createHash } from "node:crypto";
import { seedFor, tierRelDir } from "./layout.js";
import type { Partition } from "./partition.js";
import type { MemoryProvider } from "./provider.js";
import type { MemoryFiles, Tier } from "./store.js";

export interface PgClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  withConnection?<T>(fn: (client: PgClient) => Promise<T>): Promise<T>;
}

const ORG_GUC =
  `(org_id = current_setting('app.current_org', true)
     OR NULLIF(current_setting('app.current_org', true), '') IS NULL)`;

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_file (
     org_id     text        NOT NULL,
     tier_path  text        NOT NULL,
     rel_path   text        NOT NULL,
     content    text        NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (org_id, tier_path, rel_path)
   )`,
  `CREATE TABLE IF NOT EXISTS memory_tier (
     org_id     text   NOT NULL,
     tier_path  text   NOT NULL,
     version    bigint NOT NULL DEFAULT 0,
     PRIMARY KEY (org_id, tier_path)
   )`,
  `ALTER TABLE memory_file ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE memory_tier ENABLE ROW LEVEL SECURITY`,
];

const POLICY_STATEMENTS: readonly string[] = [
  `DROP POLICY IF EXISTS memory_file_org_isolation ON memory_file`,
  `DROP POLICY IF EXISTS memory_tier_org_isolation ON memory_tier`,
  `CREATE POLICY memory_file_org_isolation ON memory_file
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
  `CREATE POLICY memory_tier_org_isolation ON memory_tier
     USING ${ORG_GUC}
     WITH CHECK ${ORG_GUC}`,
];

const SCHEMA_POLICY_LOCK_CLASS = createHash("sha256").update("open-everywhere:schema-policy").digest().readInt32BE(0);

const MEMORY_POLICY_LOCK_KEY = createHash("sha256").update("open-everywhere:memory-policy-span").digest().readInt32BE(0);

const SCHEMA_POLICY_LOCK_TIMEOUT_MS = 60_000;

let policySpanAtomicityWarned = false;
function warnIfPolicySpanCannotBeAtomic(client: PgClient): void {
  if (client.withConnection || policySpanAtomicityWarned) return;
  policySpanAtomicityWarned = true;
  console.warn(
    "[open-everywhere:memory] this Postgres client offers no withConnection seam, so the RLS policy span re-applies in " +
      "AUTOCOMMIT. That is correct for the embedded PGlite floor. On a POOLED hosted client it means a pass that aborts inside " +
      "the span leaves memory_file and memory_tier with NO policy, which denies every memory read and write to a non-owner " +
      "runtime role until the next owner-mode init. A one-connection engine can run BEGIN and COMMIT; what this seam buys is " +
      "the proof that every statement lands on ONE connection. Give the client a withConnection implementation " +
      "(packages/adapters/agent/postgres/neon.ts is the reference).",
  );
}

export function _resetMemoryPolicySpanAtomicityWarnForTest(): void {
  policySpanAtomicityWarned = false;
}

async function applyPolicyStatements(client: PgClient): Promise<void> {
  warnIfPolicySpanCannotBeAtomic(client);
  if (!client.withConnection) {
    for (const stmt of POLICY_STATEMENTS) await client.query(stmt);
    return;
  }
  await client.withConnection(async (conn) => {
    await conn.query("BEGIN");
    try {
      await conn.query(`SET LOCAL lock_timeout = ${SCHEMA_POLICY_LOCK_TIMEOUT_MS}`);
      await conn.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [SCHEMA_POLICY_LOCK_CLASS, MEMORY_POLICY_LOCK_KEY]);
      for (const stmt of POLICY_STATEMENTS) await conn.query(stmt);
      await conn.query("COMMIT");
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

const ISOLATED_TABLES = ["memory_file", "memory_tier"] as const;

const EXPECTED_POLICY: Readonly<Record<string, { readonly name: string; readonly permissive: boolean; readonly cmd: string }>> = {
  memory_file: { name: "memory_file_org_isolation", permissive: true, cmd: "*" },
  memory_tier: { name: "memory_tier_org_isolation", permissive: true, cmd: "*" },
};

const VIOLATION_SUFFIX = {
  noPolicy: ": row-level security is on and NO policy is present — a non-owner runtime role is denied every read and write",
  foreignPolicy: " — not the isolation policy this schema creates",
  widenedPolicy: " — the org predicate is gone, so the policy no longer isolates",
} as const;

const TAMPER_SUFFIXES = [VIOLATION_SUFFIX.foreignPolicy, VIOLATION_SUFFIX.widenedPolicy] as const;

function isOrgGucExpr(expr: string | null): boolean {
  return (
    expr !== null &&
    /\borg_id\b/.test(expr) &&
    /current_setting\(\s*'app\.current_org'(::text)?\s*,\s*true\s*\)/i.test(expr) &&
    /\bNULLIF\s*\(/i.test(expr)
  );
}

export async function verifyMemoryIsolation(client: PgClient): Promise<string[]> {
  const violations: string[] = [];
  for (const table of ISOLATED_TABLES) {
    const { rows } = await client.query(
      `SELECT c.relrowsecurity AS rls FROM pg_class c WHERE c.oid = to_regclass($1)`,
      [table],
    );
    const t = rows[0] as { rls: boolean } | undefined;
    if (!t) {
      violations.push(`${table}: table missing`);
      continue;
    }
    if (t.rls !== true) violations.push(`${table}: ROW LEVEL SECURITY is disabled`);

    const expected = EXPECTED_POLICY[table];
    const pols = await policiesOn(client, table);
    for (const p of pols) {
      if (p.name !== expected.name || p.permissive !== expected.permissive || p.cmd !== expected.cmd) {
        violations.push(`${table}: unexpected ${p.permissive ? "permissive" : "RESTRICTIVE"} policy "${p.name}" (cmd ${p.cmd})${VIOLATION_SUFFIX.foreignPolicy}`);
        continue;
      }
      if (!isOrgGucExpr(p.qual) || !isOrgGucExpr(p.withcheck)) {
        violations.push(`${table}: policy "${p.name}" no longer reads app.current_org${VIOLATION_SUFFIX.widenedPolicy}`);
      }
    }
    if (t.rls === true && pols.length === 0) violations.push(`${table}${VIOLATION_SUFFIX.noPolicy}`);
  }
  return violations;
}

interface FoundPolicy {
  readonly name: string;
  readonly permissive: boolean;
  readonly cmd: string;
  readonly qual: string | null;
  readonly withcheck: string | null;
}

async function policiesOn(client: PgClient, table: string): Promise<FoundPolicy[]> {
  const { rows } = await client.query(
    `SELECT p.polname AS name, p.polpermissive AS permissive, p.polcmd AS cmd,
            pg_get_expr(p.polqual, p.polrelid) AS qual,
            pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
     FROM pg_policy p WHERE p.polrelid = to_regclass($1)`,
    [table],
  );
  return rows as FoundPolicy[];
}

export type MemoryIsolationCause = "aborted-init" | "tampering" | "unknown";

export function memoryIsolationCause(violations: readonly string[]): MemoryIsolationCause {
  if (violations.some((v) => TAMPER_SUFFIXES.some((suffix) => v.endsWith(suffix)))) return "tampering";
  if (violations.some((v) => v.endsWith(VIOLATION_SUFFIX.noPolicy))) return "aborted-init";
  return "unknown";
}

const CAUSE_NOTE: Readonly<Record<MemoryIsolationCause, string>> = {
  "aborted-init":
    "a memory table stood with row-level security on and NO policy — an init aborted inside the policy span leaves this, and so does an owner-credential DROP POLICY; every memory read and write under the non-owner runtime role was denied until now",
  tampering:
    "a policy this schema never creates was present, or the expected one stopped reading app.current_org — an older release's shape reads the same way, so check the release history before treating it as an intrusion",
  unknown: "neither the aborted-init nor the tampering signature explains this state — read the violations",
};

function causeReport(violations: readonly string[]): string {
  const cause = memoryIsolationCause(violations);
  return `cause: ${cause} (${CAUSE_NOTE[cause]})`;
}

function remedy(violations: readonly string[]): string {
  if (violations.some((v) => v.endsWith(VIOLATION_SUFFIX.foreignPolicy))) {
    return (
      "An owner boot does NOT remove a policy this schema did not create, so re-running the init will not repair this: " +
      "DROP the unexpected policy as the owner, then reboot (docs/extending/database.md, two-role split)."
    );
  }
  return "Re-run the schema init as the owner/migration role to repair it, then reboot (docs/extending/database.md, two-role split).";
}

export async function initPostgresSchema(client: PgClient): Promise<void> {
  const { rows } = await client.query(
    `SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS is_owner
     FROM pg_class c WHERE c.oid = to_regclass('memory_file')`,
  );
  const r = rows[0] as { is_owner: boolean } | undefined;
  if (r && r.is_owner !== true) {
    const violations = await verifyMemoryIsolation(client);
    if (violations.length > 0) {
      throw new Error(
        `memory schema: org isolation FAILED verification under the non-owner runtime role — ${causeReport(violations)} — ${violations.join("; ")}. ` +
          remedy(violations),
      );
    }
    return;
  }

  const preViolations = r ? await verifyMemoryIsolation(client) : [];

  for (const stmt of SCHEMA_STATEMENTS) await client.query(stmt);
  await applyPolicyStatements(client);

  if (preViolations.length > 0) {
    console.error(
      `[open-everywhere:memory] org isolation was broken; the policies this schema owns have been re-created — ${causeReport(preViolations)}: ${preViolations.join("; ")}`,
    );
  }

  const post = await verifyMemoryIsolation(client);
  if (post.length > 0) {
    console.error(
      `[open-everywhere:memory] org isolation is STILL broken after the apply — ${causeReport(post)}: ${post.join("; ")}. ` +
        `The org_id filter on every query still isolates tenants; the RLS layer does not. ${remedy(post)}`,
    );
  }
}

export async function setOrgContext(client: PgClient, org: string): Promise<void> {
  await client.query("SELECT set_config('app.current_org', $1, false)", [org]);
}

const UPSERT_FILE =
  `INSERT INTO memory_file (org_id, tier_path, rel_path, content, updated_at)
   VALUES ($1, $2, $3, $4, now())
   ON CONFLICT (org_id, tier_path, rel_path)
   DO UPDATE SET content = excluded.content, updated_at = now()`;

const BUMP_VERSION =
  `INSERT INTO memory_tier (org_id, tier_path, version) VALUES ($1, $2, 1)
   ON CONFLICT (org_id, tier_path) DO UPDATE SET version = memory_tier.version + 1
   RETURNING version`;

export function makePostgresProvider(client: PgClient): MemoryProvider {
  async function readRows(p: Partition, tier: Tier): Promise<MemoryFiles> {
    const path = tierRelDir(p, tier);
    const { rows } = await client.query(
      "SELECT rel_path, content FROM memory_file WHERE org_id = $1 AND tier_path = $2",
      [p.org, path],
    );
    const out: MemoryFiles = {};
    for (const r of rows as { rel_path: string; content: string }[]) out[r.rel_path] = r.content;
    return out;
  }

  async function bumpVersion(org: string, path: string): Promise<string> {
    const { rows } = await client.query(BUMP_VERSION, [org, path]);
    return String((rows[0] as { version: number | string }).version);
  }

  return {
    id: "postgres",

    readTier: readRows,

    async ensureTier(p, tier) {
      const existing = await readRows(p, tier);
      if (Object.keys(existing).length > 0) return existing;
      const path = tierRelDir(p, tier);
      const seed = seedFor(p, tier);
      for (const [rel, content] of Object.entries(seed)) {
        await client.query(UPSERT_FILE, [p.org, path, rel, content]);
      }
      await bumpVersion(p.org, path);
      return seed;
    },

    async tierVersion(p, tier) {
      const path = tierRelDir(p, tier);
      const { rows } = await client.query(
        "SELECT version FROM memory_tier WHERE org_id = $1 AND tier_path = $2",
        [p.org, path],
      );
      const r = rows[0] as { version: number | string } | undefined;
      return r ? String(r.version) : null;
    },

    async writeTier(p, tier, files, _message) {
      const path = tierRelDir(p, tier);
      const existing = await readRows(p, tier);
      const changed = Object.entries(files).filter(([rel, content]) => existing[rel] !== content);
      if (changed.length === 0) return null;
      for (const [rel, content] of changed) {
        await client.query(UPSERT_FILE, [p.org, path, rel, content]);
      }
      return bumpVersion(p.org, path);
    },

    async deleteTier(p, tier) {
      const path = tierRelDir(p, tier);
      await client.query("DELETE FROM memory_file WHERE org_id = $1 AND tier_path = $2", [p.org, path]);
      await client.query("DELETE FROM memory_tier WHERE org_id = $1 AND tier_path = $2", [p.org, path]);
    },

    async exportFiles(org) {
      const { rows } = await client.query(
        "SELECT tier_path, rel_path, content FROM memory_file WHERE org_id = $1 ORDER BY tier_path, rel_path",
        [org],
      );
      return (rows as { tier_path: string; rel_path: string; content: string }[]).map((r) => ({ tierPath: r.tier_path, relPath: r.rel_path, content: r.content }));
    },

    async deleteFile(p, tier, relPath) {
      const path = tierRelDir(p, tier);
      const { rows } = await client.query(
        "SELECT 1 FROM memory_file WHERE org_id = $1 AND tier_path = $2 AND rel_path = $3",
        [p.org, path, relPath],
      );
      if (rows.length === 0) return null;
      await client.query("DELETE FROM memory_file WHERE org_id = $1 AND tier_path = $2 AND rel_path = $3", [p.org, path, relPath]);
      return bumpVersion(p.org, path);
    },
  };
}
