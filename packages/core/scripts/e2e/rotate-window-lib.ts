import { unifiedDomainSessionKey } from "../../agent/channels/unified-supervisor.js";
import { buildTail } from "../../agent/channels/session-tail.js";
import { formatWindowToken, saltSupervisorGeneration } from "../../agent/channels/window-key.js";
import { registerOperationalPostgres, getOperationalStore } from "../../agent/operational/provider.js";
import type { PgClient } from "../../agent/operational/postgres.js";
import type { OperationalStore, ChannelSessionRow } from "../../agent/operational/store.js";

export async function wireNeonOperationalStore(dbUrl: string): Promise<OperationalStore> {
  const pkg = "@neondatabase/serverless";
  const { neon } = (await import(pkg)) as {
    neon: (url: string) => { query(text: string, params?: unknown[]): Promise<unknown> };
  };
  const sql = neon(dbUrl);
  const client: PgClient = {
    query: async (text, params) => ({ rows: (await sql.query(text, (params ?? []) as unknown[])) as unknown[] }),
  };
  process.env.OE_OPERATIONAL_PROVIDER = "postgres";
  registerOperationalPostgres(client);
  return getOperationalStore();
}

export interface RotateResult {
  readonly registryKey: string;
  readonly oldGeneration: number | null;
  readonly oldToken: string | null;
  readonly mintedGeneration: number;
  readonly newRow: ChannelSessionRow;
}

export async function rotateUnifiedWindow(
  store: OperationalStore,
  org: string,
  domain: string,
  windowId?: string,
): Promise<RotateResult> {
  const window = windowId ?? domain;
  const registryKey = unifiedDomainSessionKey(window);
  const cur = await store.getChannelSession(org, registryKey);
  const generation = Date.now();
  const newToken = saltSupervisorGeneration(formatWindowToken({ domain, windowId: window, generation }));
  const newRow = await store.rotateChannelSession(org, registryKey, newToken, new Date().toISOString());
  return {
    registryKey,
    oldGeneration: cur ? cur.generation : null,
    oldToken: cur?.token ?? null,
    mintedGeneration: generation,
    newRow,
  };
}

export interface MarkRotateResult {
  readonly registryKey: string;
  readonly generation: number;
  readonly token: string;
  readonly markedAt: string;
  readonly tailPending: number;
}

export async function markSeatForRotation(store: OperationalStore, org: string, registryKey: string, atIso: string): Promise<MarkRotateResult | null> {
  const existing = await store.getChannelSession(org, registryKey);
  if (!existing) return null;
  await store.markChannelSessionRotation(org, registryKey, atIso);
  const after = await store.getChannelSession(org, registryKey);
  if (!after || after.rotateMarkedAt == null) {
    throw new Error(`markSeatForRotation: ${registryKey} read back UNMARKED after the write — the sweep is not doing what it reports`);
  }
  const ring = await store.readSessionTail(org, registryKey, after.token);
  return { registryKey, generation: after.generation, token: after.token, markedAt: after.rotateMarkedAt, tailPending: buildTail(ring).length };
}

export interface SweepMarkResult {
  readonly marked: readonly MarkRotateResult[];
  readonly vanished: readonly string[];
}

export async function markAllSeatsForRotation(store: OperationalStore, org: string, atIso: string, keyPrefix = "oe-domain::"): Promise<SweepMarkResult> {
  const rows = await store.listChannelSessions(org, keyPrefix);
  const marked: MarkRotateResult[] = [];
  const vanished: string[] = [];
  for (const row of rows) {
    const r = await markSeatForRotation(store, org, row.surfaceKey, atIso);
    if (r) marked.push(r);
    else vanished.push(row.surfaceKey);
  }
  return { marked, vanished };
}
