import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = process.env.OE_AUDIT_DIR
  ? process.env.OE_AUDIT_DIR
  : join(process.cwd(), ".open-everywhere-audit");

export interface AuditEntry {
  readonly ts: string;
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
  readonly action: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type AuditInput = Omit<AuditEntry, "ts"> & { readonly ts?: string };

function seg(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 100) : fallback;
}

function fileFor(org: string, platform: string, workspace: string): string {
  return join(ROOT, seg(org, "default"), seg(platform, "local"), `${seg(workspace, "dev")}.jsonl`);
}

export async function appendAudit(entry: AuditInput): Promise<void> {
  const record: AuditEntry = { ...entry, ts: entry.ts ?? new Date().toISOString() };
  try {
    const file = fileFor(record.org, record.platform, record.workspace);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[open-everywhere:audit] dropped a "${record.action}" entry for ${record.org}/${record.platform}/${record.workspace}: ${String(err)}`);
  }
}

export interface AuditFilter {
  readonly org?: string;
  readonly platform?: string;
  readonly workspace?: string;
  readonly surface?: string;
  readonly action?: string;
  readonly principalId?: string;
  readonly since?: string;
  readonly limit?: number;
}

async function walkJsonl(dir: string, out: string[]): Promise<void> {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(child, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(child);
  }
}

export async function readAudit(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const base = filter.org ? join(ROOT, seg(filter.org, "default")) : ROOT;
  const files: string[] = [];
  await walkJsonl(base, files);

  const rows: AuditEntry[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: AuditEntry;
      try {
        e = JSON.parse(line) as AuditEntry;
      } catch {
        continue;
      }
      if (filter.platform && e.platform !== filter.platform) continue;
      if (filter.workspace && e.workspace !== filter.workspace) continue;
      if (filter.surface && e.surface !== filter.surface) continue;
      if (filter.action && e.action !== filter.action) continue;
      if (filter.principalId && e.principalId !== filter.principalId) continue;
      if (filter.since && e.ts < filter.since) continue;
      rows.push(e);
    }
  }

  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return filter.limit && filter.limit > 0 ? rows.slice(0, filter.limit) : rows;
}

export function auditRoot(): string {
  return ROOT;
}
