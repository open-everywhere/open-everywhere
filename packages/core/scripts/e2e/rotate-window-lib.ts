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

export async function orgHasAnySeat(store: OperationalStore, org: string): Promise<boolean> {
  const rows = await store.listChannelSessions(org);
  return rows.length > 0;
}

export async function checkOrgAllowed(
  store: OperationalStore,
  org: string,
  allowNewOrg: boolean,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  if (allowNewOrg) return { ok: true };
  if (await orgHasAnySeat(store, org)) return { ok: true };
  return {
    ok: false,
    error:
      `org "${org}" has no existing channel_session rows — refusing to mint a seat under what looks like a typo.\n` +
      `Pass --new-org to confirm "${org}" is a genuinely new org.`,
  };
}

export interface ParsedDomainTarget {
  readonly kind: "domain";
  readonly org: string;
  readonly allowNewOrg: boolean;
  readonly domain: string;
  readonly windowId?: string;
}
export interface ParsedDmTarget {
  readonly kind: "dm";
  readonly org: string;
  readonly allowNewOrg: boolean;
  readonly dmSurfaceKey: string;
}
export type ParsedRotateTarget = ParsedDomainTarget | ParsedDmTarget;
export type ParseRotateArgsResult =
  | { readonly ok: true; readonly target: ParsedRotateTarget }
  | { readonly ok: false; readonly error: string };

function takeValueFlag(argv: string[], flag: string): { value?: string; error?: string } {
  const i = argv.indexOf(flag);
  if (i === -1) return {};
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) return { error: `${flag} requires a value` };
  argv.splice(i, 2);
  return { value: v };
}

export function parseRotateArgs(argvIn: readonly string[], env: { E2E_ORG?: string } = process.env): ParseRotateArgsResult {
  const argv = [...argvIn];

  const orgFlag = takeValueFlag(argv, "--org");
  if (orgFlag.error) return { ok: false, error: orgFlag.error };
  const explicitOrg = orgFlag.value;

  const newOrgIdx = argv.indexOf("--new-org");
  const allowNewOrg = newOrgIdx !== -1;
  if (allowNewOrg) argv.splice(newOrgIdx, 1);

  const dmFlag = argv.indexOf("--dm");
  if (dmFlag !== -1) {
    const dmSurfaceKey = argv[dmFlag + 1];
    if (!dmSurfaceKey || dmSurfaceKey.startsWith("--")) {
      return {
        ok: false,
        error: "--dm requires a DM SURFACE KEY, `platform/workspace/channel` (e.g. --dm slack/T0AB12CD/D0EXDMCH001)",
      };
    }
    if (dmSurfaceKey.split("/").length < 3) {
      return {
        ok: false,
        error: `--dm takes a SURFACE KEY, not a bare channel id — got "${dmSurfaceKey}". Since OPE-351 stage 2 a DM seat is a window on \`oe-dm/<platform>/<workspace>/<surface>\`; try --dm slack/<teamId>/${dmSurfaceKey}`,
      };
    }
    argv.splice(dmFlag, 2);
    const org = explicitOrg ?? argv[0] ?? env.E2E_ORG ?? "default";
    return { ok: true, target: { kind: "dm", org, allowNewOrg, dmSurfaceKey } };
  }

  const windowFlag = takeValueFlag(argv, "--window");
  if (windowFlag.error) return { ok: false, error: `${windowFlag.error} (the grain's windowId — a surfaceKey for a solo window)` };
  const windowId = windowFlag.value;

  const domain = argv[0];
  if (!domain) {
    return { ok: false, error: "usage: rotate-window.ts <domain> [org] [--org <id>] [--window <windowId>] [--new-org]" };
  }
  const org = explicitOrg ?? argv[1] ?? env.E2E_ORG ?? "default";
  return { ok: true, target: { kind: "domain", org, allowNewOrg, domain, windowId } };
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
