import { AUDIT_DUMP_BANNER, AUDIT_DUMP_LIMIT, formatAuditTimeoutDump } from "../tests/integration/audit-timeout-dump.js";
import { AUDIT_CURSOR_LOOKBACK_MS, AUDIT_CURSOR_MARK_LIMIT } from "../tests/integration/audit-cursor.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SINCE = "2026-02-08T19:20:00.000Z";

const ANCHOR = { cursorMark: 4200, cursorWallIso: "2026-02-08T19:23:00.000Z", clockDriftMs: 0 } as const;

{
  const dump = formatAuditTimeoutDump({
    ...ANCHOR,
    actions: ["approval.chain", "approval.requested"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [
      { ts: "2026-02-08T19:25:00.000Z", org: "acme", action: "approval.chain", detail: { tool: "create_routine", verdict: "deny" } },
      { ts: "2026-02-08T19:24:00.000Z", org: "acme", action: "approval.requested", detail: { kind: "routine.create" } },
    ],
    capped: false,
    scanTruncated: false,
  });

  ok(dump.includes(AUDIT_DUMP_BANNER), "the dump opens with the banner a log grep finds it by");
  ok(dump.includes(`since=${SINCE}`), "the dump states the WINDOW it re-read — an absence only means anything against a stated window");
  ok(dump.includes("until=<none"), "the dump says it asked for NO upper bound, rather than leaving the reader to assume one");
  ok(!/until=2026/.test(dump), "…and no wall-clock upper bound is printed at all");
  ok(dump.includes(`limit=${AUDIT_DUMP_LIMIT}`), "the dump states the row ceiling it asked for");
  ok(dump.includes("approval.chain,approval.requested"), "the dump names the actions the timed-out wait wanted");

  ok(dump.includes("ts=2026-02-08T19:25:00.000Z"), "the dump prints each row's ts — the wall stamp that a stepping host moves");
  ok(dump.includes("org=acme"), "the dump prints each row's org — the read's partition key");
  ok(dump.includes("action=approval.chain") && dump.includes("action=approval.requested"), "the dump prints EVERY wanted action's rows, not only the first");
  ok(dump.includes("detail.tool=create_routine"), "the dump prints detail.tool — the field these waits join on");
  ok(dump.includes("[idx 0]") && dump.includes("[idx 1]"), "the dump gives each row a positional locator back into the page");
  ok(dump.includes("rows for the wanted actions: 2"), "the dump counts the rows it found");
  ok(dump.includes("routine.create"), "the dump carries the rest of each row's detail, so a wait joining on some other key can read it too");

  ok(dump.includes("capped=false"), "the dump prints the route's capped flag");
  ok(dump.includes("scanTruncated=false"), "the dump prints the route's scanTruncated flag");
}

{
  const dump = formatAuditTimeoutDump({
    ...ANCHOR,
    actions: ["approval.chain"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [],
    capped: true,
    scanTruncated: true,
    scanned: 1000,
  });
  ok(dump.includes("rows for the wanted actions: 0"), "an empty answer says so as a count, not by omission");
  ok(dump.includes("<none>"), "an empty answer is spelled out rather than left as a blank region");
  ok(dump.includes("scanTruncated=true") && dump.includes("scanned=1000"), "an empty answer still carries the flags that decide whether it MEANS anything");
  ok(dump.includes("never written") && dump.includes("did not reach far enough"), "an empty answer names BOTH readings, so a truncated scan is not read as an absent row");
  ok(dump.includes("TWICE the wait's own lookback"), "the empty reading names the dump's real window, not the wait's");
  ok(!dump.includes("10 minutes WIDER"), "…and never the stale claim that the dump looks 10 minutes further than the wait");
}

{
  const dump = formatAuditTimeoutDump({ ...ANCHOR, actions: [], sinceIso: SINCE, limit: AUDIT_DUMP_LIMIT, rows: [] });
  ok(dump.includes("scanTruncated=undefined"), "a flag the response omitted prints as undefined, never as a false the route did not claim");
  ok(dump.includes("scanned=<absent>"), "an absent scan count says absent rather than 0");
  ok(dump.includes("wanted actions: <none>"), "an empty action list is named, not rendered as an empty string");
}

{
  const cyclic: Record<string, unknown> = { tool: "create_routine" };
  cyclic["self"] = cyclic;
  const dump = formatAuditTimeoutDump({
    ...ANCHOR,
    actions: ["approval.chain"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [{ ts: SINCE, org: "acme", action: "approval.chain", detail: cyclic }],
  });
  ok(dump.includes("detail.tool=create_routine"), "a row with an unserialisable detail still prints the field the wait joins on");
  ok(dump.includes("not serialisable"), "…and says why the rest of that bag is missing");
}

{
  const dump = formatAuditTimeoutDump({
    ...ANCHOR,
    actions: ["a"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [{ ts: SINCE, org: "acme", action: "a", detail: { tool: "t", blob: "x".repeat(5000) } }],
  });
  ok(dump.length < 1000, `a huge detail bag is bounded before it reaches the log — got ${dump.length} chars`);
  ok(dump.includes("chars)"), "…and the dump says how much it dropped rather than truncating silently");
  ok(dump.includes("detail.tool=t"), "…while the join key still survives the bound");
}

{
  ok(AUDIT_CURSOR_LOOKBACK_MS === 600_000, "the widened window looks back 10 minutes");
  ok(AUDIT_DUMP_LIMIT === 1000, "the widened re-read asks for the route's full 1000-row page");
  ok(AUDIT_CURSOR_MARK_LIMIT > 1, "a cursor read asks for a PAGE, never a single row");
}

{
  const dump = formatAuditTimeoutDump({
    ...ANCHOR,
    clockDriftMs: -2299,
    actions: ["approval.requested"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [{ seq: 4201, ts: "2026-02-08T19:22:59.256Z", org: "acme", action: "approval.requested", detail: { kind: "routine.create" } }],
    sqlitePath: "/tmp/oe-it-state/ops.sqlite3",
  });
  ok(dump.includes("cursorMark=seq 4200"), "the dump states the cursor mark the wait selected above");
  ok(dump.includes(`takenAt=${ANCHOR.cursorWallIso}`), "the dump states the wall instant the cursor was taken, as ISO");
  ok(dump.includes("seq=4201"), "the dump prints each row's seq — the value the cursor compares");
  ok(dump.includes("-2299 ms"), "the dump states the wall-minus-monotonic drift since the anchor");
  ok(dump.includes("stepped BACKWARD"), "a NEGATIVE drift is called out in words, not left for the reader to sign-check");
  ok(dump.includes("/tmp/oe-it-state/ops.sqlite3"), "the dump names the file the sqlite handle is open at — where the rows would be");
  const steady = formatAuditTimeoutDump({ ...ANCHOR, actions: [], sinceIso: SINCE, limit: AUDIT_DUMP_LIMIT, rows: [] });
  ok(steady.includes("0 ms") && !steady.includes("stepped BACKWARD"), "a zero drift prints the number and makes NO backward-step claim");
  const noSeq = formatAuditTimeoutDump({
    ...ANCHOR,
    actions: ["a"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [{ ts: SINCE, org: "acme", action: "a" }],
  });
  ok(noSeq.includes("seq=<none>"), "a row carrying no seq says so — the field the whole fix rests on is never blank");
}

{
  const dump = formatAuditTimeoutDump({
    ...ANCHOR,
    actions: ["approval.chain"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [],
    scopeKey: "discord/G1/C1",
    kind: "routine.create",
    scopeRows: [{ seq: 4207, ts: "2026-02-08T19:24:00.000Z", org: "acme", action: "approval.autoapproved", detail: { resolvedBy: "judge" } }],
    pending: [{ id: "p-1", kind: "routine.create", scopeKey: "discord/G1/C1", status: "approved", createdAt: "2026-02-08T19:23:10.000Z" }],
  });
  ok(dump.includes("scopeKey=discord/G1/C1") && dump.includes("kind=routine.create"), "the dump names the scope and kind the wait was about");
  ok(dump.includes("ALL actions in the window for this scope: 1"), "the dump counts the scope's rows across EVERY action");
  ok(dump.includes("action=approval.autoapproved") && dump.includes("seq=4207"), "…and prints the row the turn actually wrote, with its seq");
  ok(dump.includes("pending rows for (scopeKey, kind): 1"), "the dump counts the pending rows for the scope and kind");
  ok(
    dump.includes("id=p-1") && dump.includes("status=approved") && dump.includes("createdAt=2026-02-08T19:23:10.000Z"),
    "…with each pending row's id, status and createdAt — the three fields that say which failure this is",
  );
  ok(dump.includes("scopeKey=discord/G1/C1"), "…and the scope each pending row sits on, which is the answer when the wait named only a kind");

  const bare = formatAuditTimeoutDump({
    ...ANCHOR,
    actions: ["approval.chain"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [],
    scopeKey: "discord/G1/C1",
    scopeRows: [],
    pending: [],
  });
  ok(bare.includes("nothing at all was audited in the window"), "an empty scope window states what it means");
  ok(bare.includes("no pending row was ever minted"), "an empty pending list states what it means");
  ok(bare.includes("kind=<none>"), "a wait that named no kind says so rather than printing an empty value");

  const broken = formatAuditTimeoutDump({
    ...ANCHOR,
    actions: ["approval.chain"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [],
    scopeKey: "discord/G1/C1",
    scopeError: "audit re-read returned 503",
    pendingError: "store closed",
  });
  ok(broken.includes("all-actions re-read UNAVAILABLE: audit re-read returned 503"), "a failed scope re-read says it failed, never that the scope was empty");
  ok(broken.includes("pending rows UNAVAILABLE: store closed"), "a failed pending read says it failed, never that there was no pending row");
  ok(!broken.includes("nothing at all was audited"), "…and makes no emptiness claim it did not earn");

  const kindOnly = formatAuditTimeoutDump({
    ...ANCHOR,
    actions: ["approval.chain"],
    sinceIso: SINCE,
    limit: AUDIT_DUMP_LIMIT,
    rows: [],
    kind: "routine.create",
    scopeRows: [{ seq: 4207, ts: "2026-02-08T19:24:00.000Z", org: "acme", action: "approval.autoapproved" }],
    pending: [{ id: "p-2", kind: "routine.create", scopeKey: "discord/G9/C9", status: "pending", createdAt: "2026-02-08T19:23:11.000Z" }],
  });
  ok(kindOnly.includes("kind=routine.create"), "a kind-only wait still gets the scope section");
  ok(kindOnly.includes("action=approval.autoapproved"), "…with every action in the window");
  ok(kindOnly.includes("id=p-2") && kindOnly.includes("scopeKey=discord/G9/C9"), "…and the pending rows, each naming its own scope");
  ok(kindOnly.includes("<none named"), "…and it says the reads were not narrowed to a scope, rather than implying they were");

  const noScope = formatAuditTimeoutDump({ ...ANCHOR, actions: ["a"], sinceIso: SINCE, limit: AUDIT_DUMP_LIMIT, rows: [] });
  ok(!noScope.includes("scopeKey="), "a wait that named neither a scope nor a kind gets no scope section");
  ok(!noScope.includes("pending rows"), "…and no pending section either");
}

console.log(`✓ audit-timeout-dump: ${passed} assertions passed`);
