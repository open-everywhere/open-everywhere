import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditChainRow, OperationalStore } from "../operational/store.js";
import type { MemoryProvider } from "../memory/provider.js";
import { walkAuditChain } from "../audit/chain.js";
import { EXIT_TABLES, EXPORT_SECRET_MARKER } from "./catalogue.js";
import { EXIT_PAGE_BYTES } from "./sql.js";
import { listLocalRuns } from "./workflow-world.js";
import { HOSTED_TRANSCRIPTS_NOTE, UNREACHED_TRANSCRIPTS_NOTE, orgSessionIds, type TranscriptStore } from "./transcript-store.js";
import { TRANSCRIPT_EXPORT_MAX_LIMIT, TranscriptNotFoundError, type TranscriptPageReader } from "../control/transcript-export.js";

export const EXIT_EXPORT_ACTION = "exit.export";

const EXPORT_FORMAT_VERSION = 1;

const PAGE = 1000;

export interface ExportOptions {
  readonly store: OperationalStore;
  readonly org: string;
  readonly outDir: string;
  readonly memory?: readonly MemoryProvider[];
  readonly transcripts?: TranscriptStore;
  readonly transcriptReader?: { readonly baseUrl: string; readonly pages: TranscriptPageReader } | { readonly missing: readonly string[] };
  readonly actor: string;
  readonly now?: Date;
  readonly pageBytes?: number;
}

export interface ExportManifest {
  readonly format: "open-everywhere-export";
  readonly formatVersion: number;
  readonly org: string;
  readonly exportedAt: string;
  readonly store: string;
  readonly tables: readonly { readonly table: string; readonly file: string; readonly rows: number; readonly holds: string; readonly secretColumns: readonly string[] }[];
  readonly memory: readonly { readonly backing: string; readonly file?: string; readonly files: number; readonly note?: string }[];
  readonly transcripts: {
    readonly store: "local" | "hosted" | "none" | "deployment";
    readonly runs: number;
    readonly dir?: string;
    readonly note?: string;
    readonly unreached?: readonly { readonly sessionId: string; readonly reason: string }[];
    readonly incomplete?: readonly { readonly sessionId: string; readonly events: number; readonly reason: string }[];
  };
  readonly auditChain: { readonly rows: number; readonly breaks: number; readonly verified: boolean };
  readonly notExported: readonly string[];
  readonly sha256: string;
}

function jsonLine(row: Record<string, unknown>): string {
  return `${JSON.stringify(row, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}\n`;
}

export async function exportOrg(opts: ExportOptions): Promise<ExportManifest> {
  const { store, org, outDir } = opts;
  if (store.exitTables === undefined) throw new Error(`the ${store.id} operational store has no exit-kit table access, so it cannot export`);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty — name a new directory for the export`);
  mkdirSync(join(outDir, "operational"), { recursive: true });
  const digest = createHash("sha256");
  const pageBytes = opts.pageBytes ?? EXIT_PAGE_BYTES;

  const tables: ExportManifest["tables"][number][] = [];
  for (const spec of EXIT_TABLES) {
    const file = `operational/${spec.table}.jsonl`;
    const path = join(outDir, file);
    writeFileSync(path, "");
    const secrets = new Set(spec.secretColumns ?? []);
    let rows = 0;
    for (let offset = 0; ; ) {
      const page = await store.exitTables.readRows(spec.table, spec.orgColumn === null ? null : org, offset, PAGE, pageBytes);
      if (page.length === 0) break;
      let chunk = "";
      for (const row of page) {
        for (const col of secrets) if (col in row && row[col] !== null) row[col] = EXPORT_SECRET_MARKER;
        chunk += jsonLine(row);
      }
      if (chunk.length > 0) {
        appendFileSync(path, chunk);
        if (rows === 0) digest.update(file);
        digest.update(chunk);
      }
      rows += page.length;
      offset += page.length;
    }
    tables.push({ table: spec.table, file, rows, holds: spec.holds, secretColumns: [...secrets] });
  }

  const memory: ExportManifest["memory"][number][] = [];
  const seen = new Set<string>();
  for (const provider of opts.memory ?? []) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    if (provider.exportFiles === undefined) {
      memory.push({ backing: provider.id, files: 0, note: `the ${provider.id} backing keeps its files in your own workspace there; read them where they live` });
      continue;
    }
    mkdirSync(join(outDir, "memory"), { recursive: true });
    const file = `memory/${provider.id}.jsonl`;
    const files = await provider.exportFiles(org, { pageBytes });
    const body = files.map((f) => jsonLine({ tierPath: f.tierPath, relPath: f.relPath, content: f.content })).join("");
    writeFileSync(join(outDir, file), body);
    digest.update(file).update(body);
    memory.push({
      backing: provider.id,
      file,
      files: files.length,
      ...(provider.id === "git" ? { note: "the working tree only — earlier versions stay in the memory repository's Git history" } : {}),
    });
  }

  let transcripts: ExportManifest["transcripts"];
  if (opts.transcripts?.kind === "local") {
    const dir = "transcripts/workflow-data";
    const runs = listLocalRuns(opts.transcripts.dataDir).length;
    if (existsSync(opts.transcripts.dataDir)) {
      cpSync(opts.transcripts.dataDir, join(outDir, dir), { recursive: true, filter: (src) => !src.split(/[\\/]/).includes(".locks") });
    }
    digest.update(dir).update(String(runs));
    transcripts = { store: "local", runs, dir, note: "the copy is the host's whole local workflow world: on a host that serves several orgs it holds every org's runs" };
  } else {
    const sessions = await orgSessionIds(store.exitTables, org);
    const reader = opts.transcriptReader;
    if (reader !== undefined && "pages" in reader) {
      transcripts = await readDeploymentTranscripts(outDir, sessions, reader, digest);
    } else {
      const base = opts.transcripts?.kind === "hosted" ? HOSTED_TRANSCRIPTS_NOTE : UNREACHED_TRANSCRIPTS_NOTE;
      const how = reader !== undefined && reader.missing.length > 0 ? ` Set ${reader.missing.join(" and ")} to read them through the deployment's transcript route.` : "";
      const note = `${base.endsWith(".") ? base : `${base}.`}${how}`;
      transcripts = { store: opts.transcripts?.kind ?? "none", runs: 0, note, unreached: sessions.map((sessionId) => ({ sessionId, reason: note })) };
    }
  }

  const chain: AuditChainRow[] = [];
  for (;;) {
    const page = await store.readAuditChain(org, { afterSeq: chain.at(-1)?.seq ?? 0, limit: PAGE, maxBytes: pageBytes });
    if (page.length === 0) break;
    chain.push(...page);
  }
  const walk = walkAuditChain(chain, { expectGenesis: true });

  const notExported = [
    `secret values: the ${EXIT_TABLES.filter((t) => t.secretColumns).map((t) => t.table).join(" and ")} columns ${EXIT_TABLES.flatMap((t) => t.secretColumns ?? []).join(", ")} are written as "${EXPORT_SECRET_MARKER}"`,
    "settings, access bundles, domains and roles: they are config in your deployment's Git repository (agent/), which you already hold",
    ...(transcripts.unreached !== undefined && transcripts.unreached.length > 0
      ? [`${transcripts.unreached.length} session transcript(s) the store's rows name: manifest.json lists each one under transcripts.unreached, with the reason`]
      : []),
    ...(transcripts.incomplete !== undefined && transcripts.incomplete.length > 0
      ? [`the rest of ${transcripts.incomplete.length} session transcript(s) whose file ends before a terminal event: manifest.json lists each one under transcripts.incomplete`]
      : []),
    ...(transcripts.store !== "local" && transcripts.store !== "deployment" ? [transcripts.note!] : []),
  ];

  const manifest: ExportManifest = {
    format: "open-everywhere-export",
    formatVersion: EXPORT_FORMAT_VERSION,
    org,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    store: store.id,
    tables,
    memory,
    transcripts,
    auditChain: { rows: walk.rowsWalked, breaks: walk.breaks.length, verified: walk.breaks.length === 0 },
    notExported,
    sha256: digest.digest("hex"),
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(outDir, "README.md"), readme(manifest));

  await store.appendAudit({
    ts: manifest.exportedAt,
    org,
    platform: "exit",
    workspace: "export",
    principalId: opts.actor,
    action: EXIT_EXPORT_ACTION,
    detail: {
      tables: tables.length,
      rows: tables.reduce((n, t) => n + t.rows, 0),
      memoryFiles: memory.reduce((n, m) => n + m.files, 0),
      transcriptStore: transcripts.store,
      transcriptRuns: transcripts.runs,
      transcriptsUnreached: transcripts.unreached?.length ?? 0,
      transcriptsIncomplete: transcripts.incomplete?.length ?? 0,
      auditChainVerified: manifest.auditChain.verified,
      sha256: manifest.sha256,
    },
  });
  return manifest;
}

function readme(m: ExportManifest): string {
  return [
    `# Data export — ${m.org}`,
    "",
    `Written ${m.exportedAt}. Format version ${m.formatVersion}. \`manifest.json\` lists every file with its row count.`,
    "",
    "- `operational/<table>.jsonl` — one JSON object per row of that table, with the column names the database uses.",
    "- `memory/<backing>.jsonl` — one object per memory file: `tierPath` (whose memory), `relPath` (the file) and `content` (Markdown).",
    "- `transcripts/workflow-data/` — eve's session runs, file for file: `runs/` (one per session), `events/`, `steps/`, `hooks/` and `streams/`.",
    "- `transcripts/sessions/<id>.jsonl` — when the export read transcripts through the deployment: one session's events, one JSON object per line (`index`, `at`, `type`, `data` — eve's own event shape).",
    "",
    `The audit log is \`operational/audit_entry.jsonl\`. Each row's \`prev_sha\` is the sha256 of the row before it. The chain walk at export time covered ${m.auditChain.rows} row(s) and found ${m.auditChain.breaks} break(s).`,
    "",
    "## Not in this export",
    "",
    ...m.notExported.map((n) => `- ${n}`),
    "",
  ].join("\n");
}

async function readDeploymentTranscripts(
  outDir: string,
  sessions: readonly string[],
  reader: { readonly baseUrl: string; readonly pages: TranscriptPageReader },
  digest: ReturnType<typeof createHash>,
): Promise<ExportManifest["transcripts"]> {
  const dir = "transcripts/sessions";
  mkdirSync(join(outDir, dir), { recursive: true });
  const unreached: { sessionId: string; reason: string }[] = [];
  const incomplete: { sessionId: string; events: number; reason: string }[] = [];
  let runs = 0;
  let stopped: string | undefined;
  for (const sessionId of sessions) {
    if (stopped !== undefined) {
      unreached.push({ sessionId, reason: stopped });
      continue;
    }
    let body = "";
    let events = 0;
    let complete = false;
    try {
      for (let startIndex = 0; ; ) {
        const page = await reader.pages({ sessionId, startIndex, limit: TRANSCRIPT_EXPORT_MAX_LIMIT });
        for (const event of page.events) body += `${JSON.stringify(event)}\n`;
        events += page.events.length;
        complete = page.complete;
        if (page.complete || page.events.length === 0 || page.nextIndex <= startIndex) break;
        startIndex = page.nextIndex;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TranscriptNotFoundError) {
        unreached.push({ sessionId, reason: `the deployment holds no such session (expired, or removed by the store's retention): ${message}` });
      } else {
        stopped = `not read: ${message}`;
        unreached.push({ sessionId, reason: stopped });
      }
      continue;
    }
    if (events === 0) {
      unreached.push({ sessionId, reason: "the route returned no event for this session: it idled out before the first event" });
      continue;
    }
    if (!complete) {
      incomplete.push({ sessionId, events, reason: "the read ended before a terminal event: the session is parked or still running, or the route idled out before the next event" });
    }
    const file = `${dir}/${sessionId}.jsonl`;
    writeFileSync(join(outDir, file), body);
    digest.update(file).update(body);
    runs++;
  }
  return {
    store: "deployment",
    runs,
    dir,
    note: `read through ${reader.baseUrl}'s transcript route: the sessions the org's operational rows name, one file per session`,
    unreached,
    incomplete,
  };
}
