import assert from "node:assert/strict";
import { join } from "node:path";
import type { AuditQueryOpts, AuditWireEntry } from "./audit-read.js";
import type { HaltOwnershipHandle } from "./control-write-driver.js";

process.env.OE_SQLITE_PATH = join("/tmp", `oe-halt-cleanup-test-${process.pid}.sqlite3`);

const { cleanupExactHalt } = await import("./scenarios.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const KEY = {
  surfaceKey: "slack/T0EXAMPLE/C0EXCHAN011",
  channelId: "C0EXCHAN011",
  workspaceId: "T0EXAMPLE",
  driverUserId: "U0EXOWNER",
  runStart: "2026-01-29T07:58:55.000Z",
} as const;

const ANCHOR_TS = "1769583972.749000";
const ANCHOR_ISO = new Date(1769583972.749000 * 1000).toISOString();
const WAKE = "c9069550-0000-4000-8000-000000000001";

const ingressRow = (over: Record<string, unknown> = {}): AuditWireEntry =>
  ({
    ts: "2026-01-29T07:59:28.000Z",
    org: "default",
    platform: "slack",
    workspace: "engineering",
    surface: KEY.surfaceKey,
    action: "wake.ingress",
    detail: { surfaceKey: KEY.surfaceKey, vendorTs: ANCHOR_ISO, wakeId: WAKE, ...over },
  }) as unknown as AuditWireEntry;

const halt = (over: Partial<HaltOwnershipHandle> = {}): HaltOwnershipHandle =>
  ({ orgWide: false, level: "surface", scopeKey: KEY.surfaceKey, setAt: "2026-01-29T07:59:41.000Z", setBy: KEY.driverUserId, setRef: WAKE, ...over }) as HaltOwnershipHandle;

async function run(opts: {
  readonly anchorTs?: string;
  readonly anchorWakeId?: string;
  readonly owned?: HaltOwnershipHandle;
  readonly alreadyCleared?: boolean;
  readonly rows?: readonly AuditWireEntry[];
  readonly auditThrows?: boolean;
  readonly standing?: HaltOwnershipHandle;
  readonly clearResult?: "cleared" | "missing" | "changed";
}): Promise<{ result: Awaited<ReturnType<typeof cleanupExactHalt>>; cleared: HaltOwnershipHandle[]; inspects: number; read?: AuditQueryOpts }> {
  const cleared: HaltOwnershipHandle[] = [];
  let inspects = 0;
  let read: AuditQueryOpts | undefined;
  const result = await cleanupExactHalt({
    key: KEY,
    anchorTs: opts.anchorTs,
    ...(opts.anchorWakeId !== undefined ? { anchorWakeId: opts.anchorWakeId } : {}),
    ...(opts.owned !== undefined ? { owned: opts.owned } : {}),
    alreadyCleared: opts.alreadyCleared ?? false,
    auditRead: async (o) => {
      read = o;
      if (opts.auditThrows) throw new Error("audit route 503");
      return opts.rows ?? [];
    },
    inspectHalt: async () => {
      inspects++;
      return opts.standing;
    },
    clearOwnedHalt: async (h) => {
      cleared.push(h);
      return opts.clearResult ?? "cleared";
    },
  });
  return { result, cleared, inspects, ...(read !== undefined ? { read } : {}) };
}

{
  const already = await run({ anchorTs: ANCHOR_TS, anchorWakeId: WAKE, alreadyCleared: true });
  ok(already.result.status === "already-cleared" && already.cleared.length === 0, "a leg that cleared its own halt inside the run tears nothing down again");

  const byWake = await run({ anchorTs: ANCHOR_TS, anchorWakeId: WAKE, owned: halt() });
  ok(byWake.result.status === "cleared" && byWake.result.via === "wake", "the wake-keyed road still clears the halt the leg already adopted, and names itself");

  const resolved = await run({ anchorTs: ANCHOR_TS, rows: [ingressRow()], standing: halt() });
  ok(resolved.result.status === "cleared" && resolved.result.via === "wake", "…and it still resolves the anchor post to its wake when the leg did not get that far");

  ok(
    resolved.read?.surface === KEY.surfaceKey,
    "🔴 the ingress read narrows `surface` on the FULLY QUALIFIED key — the spelling agent/channels/unified.ts files — never the bare channel id",
  );
  ok(
    resolved.read?.workspace === undefined,
    "🔴 the ingress read does NOT narrow `workspace` — that column holds the window token's domain name, never the team id, so any value would return an empty page",
  );
  ok(
    resolved.read?.limit === 200,
    "the ingress read asks for a 200-row page — rows are served newest-first and the cap applies after that sort, so this leg's own row is the first to fall off a short one",
  );

  const notOwned = await run({ anchorTs: ANCHOR_TS, rows: [ingressRow()], standing: halt({ setRef: "another-wake" }) });
  ok(
    notOwned.result.status === "residue" && notOwned.result.reason === "halt-not-owned" && notOwned.cleared.length === 0,
    "🔴 a halt naming ANOTHER wake is refused once the anchor wake RESOLVED, and nothing is cleared — the fallback never second-guesses a join that worked",
  );
}

{
  const noRows = await run({ anchorTs: ANCHOR_TS, rows: [], standing: halt() });
  ok(
    noRows.result.status === "cleared" && noRows.result.via === "run-scoped",
    "🔴 THE FIX: with NO wake.ingress row to join, teardown adopts the halt on address + driver actor + run start, and clears it",
  );
  ok(noRows.cleared.length === 1 && noRows.cleared[0]!.scopeKey === KEY.surfaceKey, "…and the halt it cleared is the one standing on this run's own surface");

  const ambiguous = await run({ anchorTs: ANCHOR_TS, rows: [ingressRow(), ingressRow({ wakeId: "c9069550-0000-4000-8000-000000000002" })], standing: halt() });
  ok(ambiguous.result.status === "cleared" && ambiguous.result.via === "run-scoped", "an AMBIGUOUS anchor join takes the same fallback rather than guessing a wake");

  const readFailed = await run({ anchorTs: ANCHOR_TS, auditThrows: true, standing: halt() });
  ok(readFailed.result.status === "cleared" && readFailed.result.via === "run-scoped", "an audit read that THROWS falls through to the same fallback — an unreadable route is not a reason to leave a brake on");

  const gone = await run({ anchorTs: ANCHOR_TS, rows: [], standing: undefined });
  ok(gone.result.status === "already-cleared" && gone.cleared.length === 0, "with no halt standing the fallback reports already-cleared rather than inventing residue");
}

{
  const operator = await run({ anchorTs: ANCHOR_TS, rows: [], standing: halt({ setBy: "U-SOMEONE-ELSE" }) });
  ok(
    operator.result.status === "residue" && operator.result.reason === "halt-not-owned" && operator.cleared.length === 0,
    "🔴 an OPERATOR's halt on the same room is LEFT ALONE — residue is the right answer, and clearing it would be the clobber this fallback exists to avoid",
  );

  const older = await run({ anchorTs: ANCHOR_TS, rows: [], standing: halt({ setAt: "2026-01-29T00:28:00.000Z" }) });
  ok(older.result.status === "residue" && older.cleared.length === 0, "🔴 a halt the same driver set BEFORE this run began is a previous run's residue, not this run's to clear");

  const neverPosted = await run({ anchorTs: undefined, rows: [], standing: halt() });
  ok(
    neverPosted.result.status === "residue" && neverPosted.result.reason === "anchor-wake-unresolved" && neverPosted.inspects === 0 && neverPosted.cleared.length === 0,
    "🔴 a run that never POSTED set nothing, so the fallback does not even look — no anchor, no adoption",
  );

  const clearRefused = await run({ anchorTs: ANCHOR_TS, rows: [], standing: halt(), clearResult: "changed" });
  ok(clearRefused.result.status === "residue" && clearRefused.result.reason === "cleanup-changed", "a control plane that refuses the clear is reported as residue, never as a clear that did not happen");
}

console.log(`✓ ${n} S-HALT teardown assertions passed`);
