import { unifiedDomainSessionKey } from "../../agent/channels/unified-supervisor.js";
import { carryTailForward } from "../../agent/channels/session-tail-record.js";
import { formatWindowToken, parseWindowToken, saltSupervisorGeneration } from "../../agent/channels/window-key.js";
import { registerOperationalPostgres, getOperationalStore } from "../../agent/operational/provider.js";
import type { PgClient } from "../../agent/operational/postgres.js";
import type { OperationalStore, ChannelSessionRow } from "../../agent/operational/store.js";
import type { WakeMessageInput } from "../../agent/channels/wake-envelope.js";

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

export interface CarryRotateResult {
  readonly registryKey: string;
  readonly oldGeneration: number;
  readonly oldToken: string;
  readonly newToken: string;
  readonly newRow: ChannelSessionRow;
  readonly tail: readonly WakeMessageInput[];
  readonly tailCarried: number;
}

export async function rotateSeatCarryingTail(store: OperationalStore, org: string, registryKey: string, atIso: string): Promise<CarryRotateResult | null> {
  const existing = await store.getChannelSession(org, registryKey);
  if (!existing) return null;
  const parsed = parseWindowToken(existing.token);
  if (!parsed) {
    throw new Error(`rotateSeatCarryingTail: ${registryKey}'s current token is not a window token (got "${existing.token}") — refusing to guess a shape`);
  }
  const tail = await carryTailForward(org, registryKey, existing.token, store);
  const newToken = saltSupervisorGeneration(formatWindowToken({ domain: parsed.domain, windowId: parsed.windowId, generation: existing.generation + 1 }));
  const newRow = await store.rotateChannelSession(org, registryKey, newToken, atIso);
  return { registryKey, oldGeneration: existing.generation, oldToken: existing.token, newToken: newRow.token, newRow, tail, tailCarried: tail.length };
}

export interface SweepCarryRotateResult {
  readonly rotated: readonly CarryRotateResult[];
  readonly vanished: readonly string[];
}

export async function rotateAllSeatsCarryingTail(store: OperationalStore, org: string, atIso: string, keyPrefix = "oe-domain::"): Promise<SweepCarryRotateResult> {
  const rows = await store.listChannelSessions(org, keyPrefix);
  const rotated: CarryRotateResult[] = [];
  const vanished: string[] = [];
  for (const row of rows) {
    const r = await rotateSeatCarryingTail(store, org, row.surfaceKey, atIso);
    if (r) rotated.push(r);
    else vanished.push(row.surfaceKey);
  }
  return { rotated, vanished };
}
