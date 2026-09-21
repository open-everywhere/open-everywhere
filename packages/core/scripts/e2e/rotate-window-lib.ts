import { unifiedDomainSessionKey } from "../../agent/channels/unified-supervisor.js";
import { buildTail } from "../../agent/channels/session-tail.js";
import { formatWindowToken, parseWindowToken, saltSupervisorGeneration, isDmAnchorDomain } from "../../agent/channels/window-key.js";
import { standingSeatDomainFor } from "../../agent/memory/domain.js";
import { registerOperationalPostgres, getOperationalStore } from "../../agent/operational/provider.js";
import type { PgClient } from "../../agent/operational/postgres.js";
import type { OperationalStore, ChannelSessionRow } from "../../agent/operational/store.js";
import type { Domain } from "../../agent/memory/domain.js";

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
  opts: { readonly force?: boolean; readonly domains?: readonly Domain[] } = {},
): Promise<RotateResult> {
  const window = windowId ?? domain;
  const registryKey = unifiedDomainSessionKey(window);
  const cur = await store.getChannelSession(org, registryKey);
  if (opts.force !== true) {
    if (opts.domains !== undefined) {
      const configCheck = checkWindowTargetAgainstConfig(domain, windowId, opts.domains);
      if (!configCheck.ok) throw new WindowTargetRefused(configCheck.error);
    }
    const check = checkWindowTargetResumable(domain, windowId, cur);
    if (!check.ok) throw new WindowTargetRefused(check.error);
  }
  const generation = Date.now();
  const newToken = saltSupervisorGeneration(formatWindowToken({ domain, windowId: window, generation }));
  assertTokenRoundTrips(newToken, domain, window, generation);
  const newRow = await store.rotateChannelSession(org, registryKey, newToken, new Date().toISOString());
  return {
    registryKey,
    oldGeneration: cur ? cur.generation : null,
    oldToken: cur?.token ?? null,
    mintedGeneration: generation,
    newRow,
  };
}

export type WindowTargetCheck = { readonly ok: true } | { readonly ok: false; readonly error: string };

export class WindowTargetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowTargetRefused";
  }
}

export function checkWindowTargetResumable(domain: string, windowId: string | undefined, existing: ChannelSessionRow | null): WindowTargetCheck {
  const window = windowId ?? domain;
  const registryKey = unifiedDomainSessionKey(window);
  const asked = `domain "${domain}" window "${window}"`;

  if (existing === null) {
    if (window === domain) return { ok: true };
    return {
      ok: false,
      error:
        `refusing to rotate ${registryKey}: no channel_session row exists there.\n` +
        `A solo per-channel window row is minted by the LIVE wake path, so its absence means no wake has ever landed on this window. ` +
        `There is no accumulated context to isolate from, and the row this would create may be one no wake ever reads — ` +
        `a domain in "unified" mode keeps ONE degenerate window at ${unifiedDomainSessionKey(domain)}.\n` +
        `Read the channel's domain and mode in agent/memory/config/domains.ts, then rotate the window it actually has:\n` +
        `  rotate-window.ts ${domain}\n` +
        `Or pass --force to mint ${asked} anyway.`,
    };
  }

  const live = parseWindowToken(existing.token);
  if (!live) {
    return {
      ok: false,
      error:
        `refusing to rotate ${registryKey}: its live token is not a window token, so this tool cannot check what it addresses.\n` +
        `  live token: ${existing.token}\n` +
        `Read the row before rotating it, or pass --force to mint ${asked} anyway.`,
    };
  }
  if (live.domain === domain && live.windowId === window) return { ok: true };

  const rightCall = live.windowId === live.domain ? `rotate-window.ts ${live.domain}` : `rotate-window.ts ${live.domain} --window ${live.windowId}`;
  return {
    ok: false,
    error:
      `refusing to rotate ${registryKey}: its live token addresses domain "${live.domain}" window "${live.windowId}", but this invocation mints ${asked}.\n` +
      `  live token: ${existing.token}\n` +
      `eve keys a session by the exact token, and every wake resumes the token this row holds. ` +
      `A token the live wake path never composes is a token no wake resumes, so this rotation would report a fresh generation and change nothing.\n` +
      `Re-run with the addressing the row already carries:\n` +
      `  ${rightCall}\n` +
      `Or pass --force to mint ${asked} anyway.`,
  };
}

export function checkWindowTargetAgainstConfig(domain: string, windowId: string | undefined, domains: readonly Domain[]): WindowTargetCheck {
  if (isDmAnchorDomain(domain)) return { ok: true };

  const window = windowId ?? domain;
  const registryKey = unifiedDomainSessionKey(window);
  const asked = `domain "${domain}" window "${window}"`;

  if (!domains.some((d) => d.name === domain)) {
    return {
      ok: false,
      error:
        `refusing to rotate ${registryKey}: no domain named "${domain}" exists in agent/memory/config/domains.ts.\n` +
        `Every wake resolves its window through the domain roster, so a target naming a domain the config does not ` +
        `declare addresses a row no live wake will ever read — a permanently dead mint, whatever the store already holds for it.\n` +
        `Read the deployment's real domain names in agent/memory/config/domains.ts, then rotate one of those.\n` +
        `Or pass --force to mint ${asked} anyway.`,
    };
  }

  if (windowId !== undefined) {
    const declaredGroup = domains.find((d) => d.name === domain)?.windows?.some((g) => g.name === windowId) === true;
    const owner = declaredGroup ? undefined : standingSeatDomainFor(windowId, domains);
    if (!declaredGroup && owner?.name !== domain) {
      return {
        ok: false,
        error:
          `refusing to rotate ${registryKey}: the live wake path seats "${windowId}" on ${owner ? `domain "${owner.name}"` : "no domain"}, not "${domain}".\n` +
          (owner
            ? `Re-run with the domain the live path actually seats this channel on:\n  rotate-window.ts ${owner.name} --window ${windowId}\n`
            : `"${windowId}" is neither a channel any domain's channels/containers roster reaches nor a window group declared by "${domain}" in agent/memory/config/domains.ts, and this deployment declares no "org" criteria domain to seat an unclaimed room — so nothing seats it and no live wake reads the row this would mint. Add it there, or rotate a target that already is.\n`) +
          `Or pass --force to mint ${asked} anyway.`,
      };
    }
  }

  return { ok: true };
}

export function assertTokenRoundTrips(token: string, domain: string, windowId: string, generation: number): void {
  const back = parseWindowToken(token);
  if (back && back.domain === domain && back.windowId === windowId && back.generation === generation) return;
  const got = back ? `domain "${back.domain}" window "${back.windowId}" g${back.generation}` : "NOT A WINDOW TOKEN";
  throw new Error(
    `rotate-window: the minted token does not round-trip through parseWindowToken — refusing to write a token the live wake path cannot address.\n` +
      `  minted:     ${token}\n` +
      `  minted for: domain "${domain}" window "${windowId}" g${generation}\n` +
      `  parses as:  ${got}`,
  );
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
  readonly force: boolean;
  readonly domain: string;
  readonly windowId?: string;
}
export interface ParsedDmTarget {
  readonly kind: "dm";
  readonly org: string;
  readonly allowNewOrg: boolean;
  readonly force: boolean;
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

  const forceIdx = argv.indexOf("--force");
  const force = forceIdx !== -1;
  if (force) argv.splice(forceIdx, 1);

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
    return { ok: true, target: { kind: "dm", org, allowNewOrg, force, dmSurfaceKey } };
  }

  const windowFlag = takeValueFlag(argv, "--window");
  if (windowFlag.error) return { ok: false, error: `${windowFlag.error} (the grain's windowId — a surfaceKey for a solo window)` };
  const windowId = windowFlag.value;

  const domain = argv[0];
  if (!domain) {
    return { ok: false, error: "usage: rotate-window.ts <domain> [org] [--org <id>] [--window <windowId>] [--new-org] [--force]" };
  }
  const org = explicitOrg ?? argv[1] ?? env.E2E_ORG ?? "default";
  return { ok: true, target: { kind: "domain", org, allowNewOrg, force, domain, windowId } };
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
