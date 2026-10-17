import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { pinSuiteStore, pinnedSuiteStorePath } from "./_suite-store.js";

const SUITE_DIR = pinSuiteStore("exit-kit");
mkdirSync(SUITE_DIR, { recursive: true });
process.env.OE_MEMORY_DIR = join(SUITE_DIR, "git-memory");

const { OPERATIONAL_TABLES } = await import("../agent/operational/store.js");
const { EXIT_TABLES, EXPORT_SECRET_MARKER, catalogueColumns } = await import("../agent/exit/catalogue.js");
const { buildExitDelete, buildExitSelectDistinct, buildExitSelectPage } = await import("../agent/exit/sql.js");
const { personIds, erasePerson, EXIT_PERSON_ERASED_ACTION } = await import("../agent/exit/erase.js");
const { exportOrg, EXIT_EXPORT_ACTION } = await import("../agent/exit/export.js");
const { retentionSweep, EXIT_RETENTION_SWEPT_ACTION } = await import("../agent/exit/retention.js");
const { deleteTranscript, EXIT_TRANSCRIPT_DELETED_ACTION } = await import("../agent/exit/transcript-delete.js");
const { LOCAL_WORKFLOW_DATA_DIR, listLocalRuns } = await import("../agent/exit/workflow-world.js");
const { walkAuditChain } = await import("../agent/audit/chain.js");
const { sqliteOperationalStore } = await import("../agent/operational/sqlite.js");
const { initOperationalSchema, makeOperationalPostgresStore } = await import("../agent/operational/postgres.js");
const { openOperationalPglite } = await import("../agent/operational/pglite-client.js");
const { sqliteProvider } = await import("../agent/memory/sqlite.js");
const { initPostgresSchema, makePostgresProvider } = await import("../agent/memory/postgres.js");
const { SURFACE } = await import("../agent/memory/store.js");
type OperationalStore = import("../agent/operational/store.js").OperationalStore;
type MemoryProvider = import("../agent/memory/provider.js").MemoryProvider;

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function ok(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throws(fn: () => unknown, re: RegExp, label: string): void {
  try {
    fn();
  } catch (err) {
    ok(re.test(String(err instanceof Error ? err.message : err)), `${label} (message: ${String(err)})`);
    return;
  }
  ok(false, `${label} — did not throw`);
}

{
  const names = EXIT_TABLES.map((t) => t.table);
  ok(new Set(names).size === names.length, "catalogue: no table twice");
  for (const t of OPERATIONAL_TABLES) ok(names.includes(t), `catalogue: operational table "${t}" has a row`);
  for (const t of names) ok((OPERATIONAL_TABLES as readonly string[]).includes(t), `catalogue: "${t}" is an operational table`);

  const ddl = (file: string, re: RegExp): Map<string, Set<string>> => {
    const src = readFileSync(join(CORE, "agent/operational", file), "utf8");
    const out = new Map<string, Set<string>>();
    for (const m of src.matchAll(re)) {
      const cols = new Set<string>();
      for (const line of m[2]!.split("\n")) {
        const w = /^\s*([a-z_]+)\s+(?:text|integer|bigint|boolean|bytea|real|double|timestamptz|TEXT|INTEGER|REAL|BLOB)/u.exec(line);
        if (w) cols.add(w[1]!);
      }
      out.set(m[1]!, cols);
    }
    return out;
  };
  const pg = ddl("postgres.ts", /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\)`/gu);
  const sq = ddl("sqlite.ts", /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\)/gu);
  for (const spec of EXIT_TABLES) {
    for (const col of catalogueColumns(spec)) {
      ok(pg.get(spec.table)?.has(col), `catalogue: ${spec.table}.${col} is a Postgres column`);
      ok(sq.get(spec.table)?.has(col), `catalogue: ${spec.table}.${col} is a sqlite column`);
    }
  }
  const forced = [...readFileSync(join(CORE, "agent/operational/postgres.ts"), "utf8").matchAll(/ALTER TABLE (\w+) FORCE ROW LEVEL SECURITY/gu)].map((m) => m[1]).sort();
  ok(JSON.stringify(EXIT_TABLES.filter((t) => t.appendOnly).map((t) => t.table).sort()) === JSON.stringify(forced), `catalogue: appendOnly is the FORCE RLS set (${forced.join(", ")})`);

  throws(() => buildExitSelectPage("dollar", "users; DROP TABLE audit_entry", "o", 0, 10), /not an operational table/u, "sql: an unknown table is refused");
  throws(() => buildExitDelete("dollar", "person_opt_out", "o", { anyOf: [{ column: "principal_key; --", values: ["x"] }] }), /no catalogued column/u, "sql: an unknown column is refused");
  throws(() => buildExitDelete("qmark", "audit_entry", "o", { anyOf: [{ column: "org_id", values: ["o"] }] }), /append-only/u, "sql: an append-only delete is refused");
  throws(() => buildExitDelete("qmark", "task_result", "o", {}), /needs a filter/u, "sql: a delete with no filter is refused");
  const empty = buildExitDelete("dollar", "person_opt_out", "o", { anyOf: [{ column: "principal_key", values: [] }] });
  ok(empty.sql.includes("1 = 0"), "sql: a filter that names nobody matches nothing");
  const d = buildExitSelectDistinct("dollar", "usage_events", "o", "session_id", { anyOf: [{ column: "principal_id", values: ["a", "b"] }] });
  ok(d.sql === "SELECT DISTINCT session_id AS v FROM usage_events WHERE org_id = $1 AND (principal_id IN ($2, $3)) AND session_id IS NOT NULL" && d.params.length === 3, `sql: distinct is bound, not interpolated (${d.sql})`);

  const pgSrc = readFileSync(join(CORE, "agent/operational/postgres.ts"), "utf8");
  const verbsBlock = pgSrc.slice(pgSrc.indexOf("const MUTABLE_TABLE_VERBS"), pgSrc.indexOf("\n};", pgSrc.indexOf("const MUTABLE_TABLE_VERBS")));
  const deletable = new Set([...verbsBlock.matchAll(/^  ([a-z_]+): \[([^\]]*)\]/gmu)].filter((m) => m[2]!.includes("DELETE")).map((m) => m[1]!));
  for (const m of pgSrc.matchAll(/GRANT [A-Z, ]*DELETE[A-Z, ]* ON ([a-z_, ]+) TO/gu)) for (const t of m[1]!.split(",")) deletable.add(t.trim());
  ok(deletable.has("session_tail") && !deletable.has("pending_actions"), "grants: the runtime DELETE set parses (negative control: pending_actions has none)");
  for (const spec of EXIT_TABLES.filter((t) => t.ageColumn !== undefined)) ok(deletable.has(spec.table), `retention: the runtime role may DELETE from ${spec.table}`);
  const aged = EXIT_TABLES.filter((t) => t.ageColumn !== undefined).map((t) => t.table).sort();
  ok(JSON.stringify(aged) === JSON.stringify(["attention_state", "model_call_capture", "question_ledger", "session_tail", "slack_attachment", "task_result", "webhook_capture"]), `retention: the aged tables are exactly the reviewed seven (${aged.join(", ")})`);
  ok(EXIT_TABLES.find((t) => t.table === "meeting_data")?.ageColumn === undefined, "retention: meeting_data is never aged (its provenance marks outlive any window)");
  const allOf = buildExitDelete("dollar", "attention_state", "o", { anyOf: [{ column: "person_id", values: ["U1"] }], allOf: [{ column: "person_platform", values: ["slack"] }] });
  ok(allOf.sql.includes("person_platform IN ($3)") && allOf.params.length === 3, `sql: allOf ANDs a bound platform term (${allOf.sql})`);

  const ids = personIds("slack/T0123/U0456");
  ok(ids.all.includes("slack/T0123/U0456") && ids.all.includes("U0456") && ids.all.includes("slack:person/U0456"), "person: the key, the platform id and the audience address");
  throws(() => personIds("U0456"), /not a person key/u, "person: a bare id is refused");

  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const eveDir = (await import(pathToFileURL(join(eveRoot, "dist/src/internal/workflow/local-world-data-directory.js")).href)) as { LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH: string };
  ok(eveDir.LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_RELATIVE_PATH === LOCAL_WORKFLOW_DATA_DIR, "world: the transcript directory is eve's own");
}

{
  await sqliteOperationalStore.readAuditChain("warm-up");
  const inner = sqliteOperationalStore.exitTables!;
  const tried: string[] = [];
  const store = {
    ...sqliteOperationalStore,
    exitTables: {
      ...inner,
      async deleteRows(table: string, org: string, filter: Parameters<typeof inner.deleteRows>[2]) {
        tried.push(table);
        if (table === "memory_proposal") throw new Error("permission denied for table memory_proposal");
        return inner.deleteRows(table, org, filter);
      },
    },
  } as OperationalStore;
  const deletedTiers: string[] = [];
  const recorder = { id: "recorder", readTier: async () => ({}), ensureTier: async () => ({}), writeTier: async () => null, deleteTier: async (p: { surfaceKey: string }) => void deletedTiers.push(p.surfaceKey) } as unknown as MemoryProvider;
  const gitLike = { ...recorder, id: "git", deleteTier: async () => void deletedTiers.push("git!") } as unknown as MemoryProvider;
  const r = await erasePerson({ store, org: "refusedco", person: "slack/T1/U1", dmRooms: ["slack/T1/..", "slack/../D2", "slack/T1/D1"], memory: [recorder, gitLike], actor: "test" });
  ok(JSON.stringify(deletedTiers) === JSON.stringify(["slack/T1/D1"]), `erase: a room key with a path step reaches no memory tier, and the git backing is never asked (${deletedTiers.join(", ")})`);
  ok(r.refused.length === 1 && r.refused[0] === "memory_proposal", `erase: a refused table is reported (${r.refused.join(", ")})`);
  ok(tried.indexOf("memory_proposal") < tried.length - 1, "erase: the tables after a refused one are still erased");
  ok(!tried.includes("pending_actions") && !tried.includes("person_opt_out"), "erase: a table kept by design is never matched by person");
}

const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
type World = {
  events: { create(runId: string | null, ev: Record<string, unknown>): Promise<{ run?: { runId: string } }> };
  runs: { get(id: string): Promise<{ status: string }> };
  streams: { write(runId: string, name: string, chunk: string): Promise<void>; close(runId: string, name: string): Promise<void> };
  close?(): Promise<void>;
};
const { createWorld } = (await import(pathToFileURL(join(eveRoot, "dist/src/compiled/@workflow/world-local/index.js")).href)) as { createWorld(o: { dataDir: string }): World };

async function makeRun(w: World, opts: { live?: boolean } = {}): Promise<string> {
  const r = await w.events.create(null, { eventType: "run_created", specVersion: 2, eventData: { deploymentId: "d", workflowName: "wf", input: new Uint8Array([1]) } });
  const id = r.run!.runId;
  await w.events.create(id, { eventType: "run_started", specVersion: 2 });
  await w.events.create(id, { eventType: "step_created", specVersion: 2, correlationId: `step_${id.slice(-6)}`, eventData: { stepName: "s", input: new Uint8Array([2]) } });
  await w.events.create(id, { eventType: "hook_created", specVersion: 2, correlationId: `hook_${id.slice(-6)}`, eventData: { token: `tok-${id}`, metadata: {} } });
  await w.streams.write(id, `strm_${id.slice(-8)}`, "a transcript line");
  await w.streams.close(id, `strm_${id.slice(-8)}`);
  if (!opts.live) await w.events.create(id, { eventType: "run_completed", specVersion: 2, eventData: { output: new Uint8Array([3]) } });
  return id;
}

function filesOf(dataDir: string, runId: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.includes(runId) || (p.endsWith(".json") && readFileSync(p, "utf8").includes(runId)) || p.includes(`strm_${runId.slice(-8)}`)) out.push(p);
    }
  };
  walk(dataDir);
  return out;
}

function snapshot(dataDir: string, runIds: readonly string[]): string {
  return JSON.stringify(runIds.map((id) => filesOf(dataDir, id).sort()));
}

function ageRun(dataDir: string, runId: string, days: number): void {
  const path = join(dataDir, "runs", `${runId}.json`);
  const run = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const at = new Date(Date.now() - days * 86_400_000).toISOString();
  for (const k of ["createdAt", "updatedAt", "completedAt", "startedAt"]) if (k in run) run[k] = at;
  writeFileSync(path, JSON.stringify(run));
}

interface Engine {
  readonly name: string;
  readonly store: OperationalStore;
  readonly memory: MemoryProvider;
  exec(sql: string, params: readonly unknown[]): Promise<void>;
  count(sql: string, params: readonly unknown[]): Promise<number>;
  close(): Promise<void>;
}

async function sqliteEngine(): Promise<Engine> {
  await sqliteOperationalStore.readAuditChain("warm-up");
  const db = new DatabaseSync(pinnedSuiteStorePath());
  return {
    name: "sqlite",
    store: sqliteOperationalStore,
    memory: sqliteProvider,
    exec: async (sql, params) => void db.prepare(sql.replace(/\$\d+/gu, "?")).run(...(params as (string | number | null)[])),
    count: async (sql, params) => Number((db.prepare(sql.replace(/\$\d+/gu, "?")).get(...(params as (string | number)[])) as { n: number }).n),
    close: async () => db.close(),
  };
}

async function pgliteEngine(): Promise<Engine> {
  const dir = join(SUITE_DIR, "pglite");
  const opened = await openOperationalPglite(dir);
  await initOperationalSchema(opened.client);
  await initPostgresSchema(opened.client);
  return {
    name: "postgres (PGlite)",
    store: makeOperationalPostgresStore(opened.client),
    memory: makePostgresProvider(opened.client),
    exec: async (sql, params) => void (await opened.client.query(sql, params)),
    count: async (sql, params) => Number(((await opened.client.query(sql, params)).rows[0] as { n: number | string }).n),
    close: opened.close,
  };
}

const PERSON = "slack/T0123/U0456";
const OTHER = "U0999";
const DM_ROOM = "slack/T0123/D0456";
const CHANNEL = "slack/T0123/C0001";

async function auditRows(store: OperationalStore, org: string, action: string) {
  return (await store.readAuditChain(org)).filter((r) => r.action === action);
}

for (const make of [sqliteEngine, pgliteEngine]) {
  const e = await make();
  const org = `exitco-${e.name.split(" ")[0]}`;
  const now = new Date();
  const iso = now.toISOString();
  const old = new Date(now.getTime() - 200 * 86_400_000).toISOString();
  const worldDir = join(SUITE_DIR, `world-${e.name.split(" ")[0]}`);
  const w = createWorld({ dataDir: worldDir });
  const soleRun = await makeRun(w);
  const sharedRun = await makeRun(w);
  const dmRun = await makeRun(w);
  const liveRun = await makeRun(w, { live: true });
  const otherRun = await makeRun(w);
  const L = e.name;

  const seed: [string, unknown[]][] = [
    ["INSERT INTO person_opt_out (org_id, principal_key, opted_out_at) VALUES ($1, $2, $3)", [org, PERSON, iso]],
    ["INSERT INTO person_opt_out (org_id, principal_key, opted_out_at) VALUES ($1, $2, $3)", [org, `slack/T0123/${OTHER}`, iso]],
    ["INSERT INTO personal_watch (org_id, principal_key, state_json, version, updated_at) VALUES ($1, $2, $3, 1, $4)", [org, PERSON, '{"secretPlan":"the-erased-words"}', iso]],
    ["INSERT INTO dm_rule (org_id, surface_key, rule_id, owner_id, rule, subject_json, source_action_id, created_at, updated_at) VALUES ($1, $2, 'r1', $3, 'always ok', '{}', 'a1', $4, $5)", [org, DM_ROOM, "U0456", iso, iso]],
    ["INSERT INTO session_tail (org_id, surface_key, token, seq, at, entry_json) VALUES ($1, $2, 'tok', 1, $3, $4)", [org, DM_ROOM, iso, '{"text":"the-erased-words"}']],
    ["INSERT INTO session_tail (org_id, surface_key, token, seq, at, entry_json) VALUES ($1, $2, 'tok', 1, $3, $4)", [org, CHANNEL, iso, '{"text":"a channel line"}']],
    ["INSERT INTO question_ledger (org_id, ts, surface_key, surface_mode, principal_id, fingerprint, words) VALUES ($1, $2, $3, 'channel', 'U0456', 'f1', 'the-erased-words')", [org, iso, CHANNEL]],
    ["INSERT INTO question_ledger (org_id, ts, surface_key, surface_mode, principal_id, fingerprint, words) VALUES ($1, $2, $3, 'channel', $4, 'f2', 'other words')", [org, iso, CHANNEL, OTHER]],
    ["INSERT INTO stored_credential (org_id, ref, ciphertext, connector, domain, created_by, created_at) VALUES ($1, 'db:k', 'CIPHERTEXT-BYTES', 'notion', 'd', 'U0001', $2)", [org, iso]],
    ["INSERT INTO usage_events (org_id, surface_key, session_id, principal_id, ts) VALUES ($1, $2, $3, 'U0456', $4)", [org, CHANNEL, soleRun, iso]],
    ["INSERT INTO usage_events (org_id, surface_key, session_id, principal_id, ts) VALUES ($1, $2, $3, 'U0456', $4)", [org, CHANNEL, sharedRun, iso]],
    ["INSERT INTO usage_events (org_id, surface_key, session_id, principal_id, ts) VALUES ($1, $2, $3, $4, $5)", [org, CHANNEL, sharedRun, OTHER, iso]],
    ["INSERT INTO usage_events (org_id, surface_key, session_id, principal_id, ts) VALUES ($1, $2, $3, 'U0456', $4)", [org, DM_ROOM, dmRun, iso]],
    ["INSERT INTO usage_events (org_id, surface_key, session_id, principal_id, ts) VALUES ($1, $2, $3, 'U0456', $4)", [org, DM_ROOM, liveRun, iso]],
    ["INSERT INTO attention_state (org_id, session_id, state, summary, surface_key, channel_id, person_platform, person_id, since, updated_at) VALUES ($1, $2, 'blocked', 'waits on you', $3, 'D0456', 'slack', 'U0456', $4, $5)", [org, dmRun, DM_ROOM, iso, iso]],
    ["INSERT INTO attention_state (org_id, session_id, state, summary, surface_key, channel_id, person_platform, person_id, since, updated_at) VALUES ($1, 'discord-session', 'working', 'another platform', 'discord/G1/C1', 'C1', 'discord', 'U0456', $2, $3)", [org, iso, iso]],
    ["INSERT INTO routine_report_thread (org_id, channel_key, thread_key, routine_surface, routine_id, created_at, expires_at) VALUES ($1, $2, 't1', $3, 'r1', $4, $5)", [org, DM_ROOM, DM_ROOM, iso, iso]],
    ["INSERT INTO routine_report_thread (org_id, channel_key, thread_key, routine_surface, routine_id, created_at, expires_at) VALUES ($1, $2, 't2', $3, 'r2', $4, $5)", [org, CHANNEL, CHANNEL, iso, iso]],
    ["INSERT INTO task_result (org_id, task_id, result_json, created_at) VALUES ($1, 'old', '{}', $2)", [org, old]],
    ["INSERT INTO task_result (org_id, task_id, result_json, created_at) VALUES ($1, 'new', '{}', $2)", [org, iso]],
  ];
  for (const [sql, params] of seed) await e.exec(sql, params);
  await e.store.appendAudit({ ts: iso, org, platform: "slack", workspace: "T0123", principalId: "U0456", action: "memory.write", detail: { n: 1 } });
  const dmPartition = { org, platform: "slack", workspace: "T0123", surface: "D0456", workspaceKey: "slack/T0123", surfaceKey: DM_ROOM, key: DM_ROOM };
  await e.memory.writeTier(dmPartition, SURFACE, { "MEMORY.md": "- the-erased-words in DM memory\n" }, "seed");
  const chanPartition = { ...dmPartition, surface: "C0001", surfaceKey: CHANNEL, key: CHANNEL };
  await e.memory.writeTier(chanPartition, SURFACE, { "MEMORY.md": "- a channel fact\n" }, "seed");

  const out = join(SUITE_DIR, `export-${e.name.split(" ")[0]}`);
  const manifest = await exportOrg({ store: e.store, org, outDir: out, memory: [e.memory, e.memory], transcripts: { kind: "local", dataDir: worldDir }, actor: "operator:cli", now });
  ok(manifest.tables.length === OPERATIONAL_TABLES.length, `${L} export: one file per operational table`);
  const creds = readFileSync(join(out, "operational/stored_credential.jsonl"), "utf8");
  ok(creds.includes(EXPORT_SECRET_MARKER) && !creds.includes("CIPHERTEXT-BYTES"), `${L} export: the secret column is replaced, never written`);
  ok(readFileSync(join(out, "operational/personal_watch.jsonl"), "utf8").includes("the-erased-words"), `${L} export: the person's rows are in the export`);
  ok(manifest.tables.find((t) => t.table === "usage_events")?.rows === 5, `${L} export: every usage row`);
  ok(manifest.memory.length === 1 && manifest.memory[0]!.files === 2, `${L} export: memory once per backing, every file (${JSON.stringify(manifest.memory)})`);
  ok(readFileSync(join(out, `memory/${e.memory.id}.jsonl`), "utf8").includes('"tierPath":"slack/T0123/@surfaces/D0456"'), `${L} export: memory names its tier`);
  ok(manifest.transcripts.runs === 5 && existsSync(join(out, "transcripts/workflow-data/runs", `${soleRun}.json`)), `${L} export: the transcripts are copied`);
  ok(!existsSync(join(out, "transcripts/workflow-data/.locks")), `${L} export: the world's lock files are not`);
  ok(manifest.auditChain.verified && manifest.auditChain.rows >= 1, `${L} export: the audit chain verified`);
  ok(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).sha256 === manifest.sha256, `${L} export: the manifest is on disk`);
  ok((await auditRows(e.store, org, EXIT_EXPORT_ACTION)).length === 1, `${L} export: one exit.export row`);
  let refused = false;
  await exportOrg({ store: e.store, org, outDir: out, actor: "x" }).catch(() => (refused = true));
  ok(refused, `${L} export: a non-empty directory is refused`);

  const keepBefore = snapshot(worldDir, [sharedRun, liveRun, otherRun]);
  const report = await erasePerson({ store: e.store, org, person: PERSON, memory: [e.memory], transcripts: { kind: "local", dataDir: worldDir }, actor: "operator:cli", now });
  const n = (sql: string, ...params: unknown[]) => e.count(sql, params);
  ok((await n("SELECT COUNT(*) AS n FROM person_opt_out WHERE org_id = $1 AND principal_key = $2", org, PERSON)) === 1, `${L} erase: the person's own opt-out is KEPT, so the agent still leaves their content alone`);
  ok(report.kept["person_opt_out"] !== undefined && report.kept["pending_actions"] !== undefined, `${L} erase: the report names the tables kept by design`);
  ok(report.refused.length === 0, `${L} erase: the owner role is refused nothing`);
  ok((await n("SELECT COUNT(*) AS n FROM personal_watch WHERE org_id = $1", org)) === 0, `${L} erase: the watch record is gone`);
  ok((await n("SELECT COUNT(*) AS n FROM dm_rule WHERE org_id = $1", org)) === 0, `${L} erase: the DM rule is gone`);
  ok((await n("SELECT COUNT(*) AS n FROM session_tail WHERE org_id = $1 AND surface_key = $2", org, DM_ROOM)) === 0, `${L} erase: the DM room's tail is gone`);
  ok((await n("SELECT COUNT(*) AS n FROM session_tail WHERE org_id = $1 AND surface_key = $2", org, CHANNEL)) === 1, `${L} erase: the channel's tail stays`);
  ok((await n("SELECT COUNT(*) AS n FROM routine_report_thread WHERE org_id = $1 AND routine_surface = $2", org, DM_ROOM)) === 0, `${L} erase: a DM routine's report thread goes with the DM`);
  ok((await n("SELECT COUNT(*) AS n FROM routine_report_thread WHERE org_id = $1 AND routine_surface = $2", org, CHANNEL)) === 1, `${L} erase: a channel routine's report thread stays`);
  ok((await n("SELECT COUNT(*) AS n FROM question_ledger WHERE org_id = $1", org)) === 1, `${L} erase: only the person's question words go`);
  ok((await n("SELECT COUNT(*) AS n FROM attention_state WHERE org_id = $1 AND person_platform = 'slack'", org)) === 0, `${L} erase: the status line is gone`);
  ok((await n("SELECT COUNT(*) AS n FROM usage_events WHERE org_id = $1", org)) === 5, `${L} erase: the append-only usage ledger stays whole`);
  ok(report.dmRooms.length === 1 && report.dmRooms[0] === DM_ROOM, `${L} erase: the DM room came from the store's own dm_rule`);
  ok(Object.keys(await e.memory.readTier(dmPartition, SURFACE)).length === 0 && report.memoryTiers === 1, `${L} erase: the DM memory tier is gone`);
  ok(Object.keys(await e.memory.readTier(chanPartition, SURFACE)).length === 1, `${L} erase: the channel's memory stays`);
  ok(filesOf(worldDir, soleRun).length === 0, `${L} erase: the person's sole session transcript is gone (${filesOf(worldDir, soleRun).join(", ")})`);
  ok(filesOf(worldDir, dmRun).length === 0, `${L} erase: the DM session transcript is gone`);
  ok(filesOf(worldDir, sharedRun).length > 0 && report.transcripts.shared.includes(sharedRun), `${L} erase: a shared session stays, and the report names it`);
  ok(filesOf(worldDir, liveRun).length > 0 && report.transcripts.live === 1, `${L} erase: a live run is never touched`);
  ok(filesOf(worldDir, otherRun).length > 0, `${L} erase: an unrelated run stays`);
  ok(snapshot(worldDir, [sharedRun, liveRun, otherRun]) === keepBefore, `${L} erase: every kept run's file set is unchanged, file for file`);
  ok((await n("SELECT COUNT(*) AS n FROM attention_state WHERE org_id = $1 AND person_platform = 'discord'", org)) === 1, `${L} erase: the same bare id on ANOTHER platform is not matched`);
  let gone = false;
  await w.runs.get(soleRun).catch(() => (gone = true));
  ok(gone, `${L} erase: eve's own world no longer finds the erased run`);
  ok((await w.runs.get(otherRun)).status === "completed", `${L} erase: eve's own world still reads the unrelated run`);
  const erased = await auditRows(e.store, org, EXIT_PERSON_ERASED_ACTION);
  ok(erased.length === 1, `${L} erase: one exit.person_erased row`);
  const detail = JSON.stringify(erased[0]!.detail);
  ok(!detail.includes("U0456") && !detail.includes("the-erased-words") && !detail.includes("D0456"), `${L} erase: the audit row holds no erased value (${detail})`);
  ok(erased[0]!.detail?.["personSha256"] === report.personSha256 && report.personSha256.length === 64, `${L} erase: the row names the person by hash`);
  const walk = walkAuditChain(await e.store.readAuditChain(org), { expectGenesis: true });
  ok(walk.breaks.length === 0, `${L} erase: the audit chain still verifies (${walk.breaks.length} breaks)`);

  const delBefore = snapshot(worldDir, [sharedRun, liveRun]);
  const del = await deleteTranscript({ store: e.store, org, sessionId: otherRun, transcripts: { kind: "local", dataDir: worldDir }, actor: "operator:cli", now });
  ok(del.outcome === "deleted" && filesOf(worldDir, otherRun).length === 0, `${L} transcript: the run's every file is gone`);
  ok(snapshot(worldDir, [sharedRun, liveRun]) === delBefore, `${L} transcript: every other run's file set is unchanged`);
  const half = await makeRun(w);
  for (const f of filesOf(worldDir, half)) if (!f.endsWith(join("runs", `${half}.json`))) rmSync(f, { force: true });
  ok(existsSync(join(worldDir, "runs", `${half}.json`)), `${L} transcript: a half-deleted run still has its record`);
  ok((await deleteTranscript({ store: e.store, org, sessionId: half, transcripts: { kind: "local", dataDir: worldDir }, actor: "x" })).outcome === "deleted", `${L} transcript: a second delete of a half-deleted run finishes it`);
  ok(filesOf(worldDir, half).length === 0, `${L} transcript: nothing of the half-deleted run is left`);
  const broken = await makeRun(w);
  writeFileSync(join(worldDir, "runs", `${broken}.json`), "{ not json");
  const brokenBefore = snapshot(worldDir, [broken]);
  const unreadable = await deleteTranscript({ store: e.store, org, sessionId: broken, transcripts: { kind: "local", dataDir: worldDir }, actor: "x" });
  ok(unreadable.outcome === "refused-live" && unreadable.status === "unreadable", `${L} transcript: an unreadable run record is refused, and says why`);
  rmSync(join(worldDir, "runs", `${broken}.json`));
  ok((await deleteTranscript({ store: e.store, org, sessionId: broken, transcripts: { kind: "local", dataDir: worldDir }, actor: "x" })).outcome === "refused-live", `${L} transcript: files with no run record are refused`);
  ok(snapshot(worldDir, [broken]) !== "[[]]" && JSON.parse(snapshot(worldDir, [broken]))[0].length === JSON.parse(brokenBefore)[0].length - 1, `${L} transcript: a refused run keeps its files`);
  ok((await deleteTranscript({ store: e.store, org, sessionId: liveRun, transcripts: { kind: "local", dataDir: worldDir }, actor: "x" })).outcome === "refused-live", `${L} transcript: a live run is refused`);
  ok((await deleteTranscript({ store: e.store, org, sessionId: otherRun, transcripts: { kind: "hosted" }, actor: "x" })).outcome === "hosted", `${L} transcript: the hosted store deletes nothing and says so`);
  ok((await auditRows(e.store, org, EXIT_TRANSCRIPT_DELETED_ACTION)).length === 3, `${L} transcript: one row per delete that ran (not the refused ones)`);

  const oldRun = await makeRun(w);
  const oldLive = await makeRun(w, { live: true });
  ageRun(worldDir, oldRun, 200);
  ageRun(worldDir, oldLive, 200);
  const sweepBefore = snapshot(worldDir, [sharedRun, liveRun]);
  const swept = await retentionSweep({ store: e.store, org, now, storedStateDays: 90, sessionTranscriptDays: 90, transcripts: { kind: "local", dataDir: worldDir } });
  ok((await n("SELECT COUNT(*) AS n FROM task_result WHERE org_id = $1 AND task_id = 'old'", org)) === 0, `${L} retention: an old row ages out`);
  ok((await n("SELECT COUNT(*) AS n FROM task_result WHERE org_id = $1 AND task_id = 'new'", org)) === 1, `${L} retention: a new row stays`);
  ok(swept.rows["task_result"] === 1 && swept.transcriptsDeleted === 1, `${L} retention: the report counts (${JSON.stringify(swept)})`);
  ok(filesOf(worldDir, oldRun).length === 0, `${L} retention: an old finished run ages out`);
  ok(filesOf(worldDir, oldLive).length > 0, `${L} retention: an old LIVE run stays`);
  ok(snapshot(worldDir, [sharedRun, liveRun]) === sweepBefore, `${L} retention: new and live runs keep every file`);
  ok((await n("SELECT COUNT(*) AS n FROM usage_events WHERE org_id = $1", org)) === 5, `${L} retention: the append-only ledger is never aged`);
  const kept = await retentionSweep({ store: e.store, org, now: new Date(now.getTime() + 400 * 86_400_000), storedStateDays: 0, sessionTranscriptDays: 0, transcripts: { kind: "local", dataDir: worldDir } });
  ok(Object.keys(kept.rows).length === 0 && kept.transcriptsDeleted === 0, `${L} retention: 0 days keeps everything`);
  ok((await auditRows(e.store, org, EXIT_RETENTION_SWEPT_ACTION)).length === 2, `${L} retention: one exit.retention_swept row per sweep`);
  ok(walkAuditChain(await e.store.readAuditChain(org), { expectGenesis: true }).breaks.length === 0, `${L} retention: the chain still verifies`);
  ok(listLocalRuns(worldDir).every((r) => r.runId !== oldRun), `${L} retention: the world's run list no longer holds the aged run`);

  if (w.close) await w.close();
  await e.close();
  console.log(`  ✓ ${L}: export, erase, transcript delete and retention`);
}

{
  await import("./_register-test-config.js");
  const tidy = await import("../agent/schedules/tidy.js");
  const cwd = join(SUITE_DIR, "tidy-host");
  const dataDir = join(cwd, ...LOCAL_WORKFLOW_DATA_DIR.split("/"));
  mkdirSync(dataDir, { recursive: true });
  const w = createWorld({ dataDir });
  const aged = await makeRun(w);
  ageRun(dataDir, aged, 200);
  const db = new DatabaseSync(pinnedSuiteStorePath());
  db.prepare("INSERT INTO task_result (org_id, task_id, result_json, created_at) VALUES ('tidyco', 'aged', '{}', ?)").run(new Date(Date.now() - 200 * 86_400_000).toISOString());
  db.close();
  const before = process.cwd();
  process.chdir(cwd);
  let report;
  try {
    report = await tidy.tidyTick({ now: new Date(), orgs: ["tidyco"] });
  } finally {
    process.chdir(before);
  }
  ok(report.retentionRows === 1 && report.retentionTranscripts === 1, `tidy: the daily tick ran the retention sweep (${report.retentionRows} row, ${report.retentionTranscripts} transcript)`);
  ok(filesOf(dataDir, aged).length === 0, "tidy: the aged run is gone from the host's world");
  ok((await auditRows(sqliteOperationalStore, "tidyco", EXIT_RETENTION_SWEPT_ACTION)).length === 1, "tidy: the tick wrote the exit.retention_swept row");
  if (w.close) await w.close();
}

{
  process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
  const { runExitCommand } = await import("./oe-exit.js");
  const cwd = join(SUITE_DIR, "cli");
  mkdirSync(cwd, { recursive: true });
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), cwd };
  const db = new DatabaseSync(pinnedSuiteStorePath());
  db.prepare("INSERT INTO question_ledger (org_id, ts, surface_key, surface_mode, principal_id, fingerprint, words) VALUES ('default', '2026-10-01T00:00:00.000Z', 'slack/T9/C9', 'channel', 'U9', 'f', 'w')").run();
  ok((await runExitCommand("erase", ["--person", "slack/T9/U9"], io)) === 2, "cli: erase without --yes is refused");
  ok(Number((db.prepare("SELECT COUNT(*) AS n FROM question_ledger WHERE org_id = 'default'").get() as { n: number }).n) === 1, "cli: a refused erase deletes nothing");
  ok((await runExitCommand("export", ["--out", "exp"], io)) === 0 && existsSync(join(cwd, "exp", "manifest.json")), `cli: export writes the manifest (${lines.slice(-3).join(" | ")})`);
  ok(lines.some((l) => l.includes("transcripts: not reached")), "cli: with no world on this host, the export says the transcripts were not reached");
  ok((await runExitCommand("erase", ["--person", "slack/T9/U9", "--yes"], io)) === 0, `cli: erase with --yes runs (${lines.slice(-2).join(" | ")})`);
  ok(Number((db.prepare("SELECT COUNT(*) AS n FROM question_ledger WHERE org_id = 'default'").get() as { n: number }).n) === 0, "cli: the erase removed the row");
  ok((await runExitCommand("transcript", ["delete", "wrun_ABC"], io)) === 1, "cli: a transcript delete with no world directory is refused");
  ok((await runExitCommand("transcript", ["delete", "wrun_ABC", "--transcripts-dir", "nowhere"], io)) === 0, "cli: a named directory without the run deletes nothing and says so");
  db.close();
}

rmSync(join(SUITE_DIR, "export-sqlite"), { recursive: true, force: true });
console.log(`exit-kit: ${passed} assertions passed`);
