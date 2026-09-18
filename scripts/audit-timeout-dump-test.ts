import { AUDIT_DUMP_BANNER, AUDIT_DUMP_LIMIT, AUDIT_DUMP_LOOKBACK_MS, formatAuditTimeoutDump } from "../tests/integration/audit-timeout-dump.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SINCE = "2026-02-08T19:20:00.000Z";
const UNTIL = "2026-09-18T01:10:00.000Z";

{
  const dump = formatAuditTimeoutDump({
    actions: ["approval.chain", "approval.requested"],
    sinceIso: SINCE,
    untilIso: UNTIL,
    limit: AUDIT_DUMP_LIMIT,
    rows: [
      { ts: "2026-02-08T19:25:00.000Z", org: "acme", action: "approval.chain", detail: { tool: "create_routine", verdict: "deny" } },
      { ts: "2026-02-08T19:24:00.000Z", org: "acme", action: "approval.requested", detail: { kind: "routine.create" } },
    ],
    capped: false,
    scanTruncated: false,
  });

  ok(dump.includes(AUDIT_DUMP_BANNER), "the dump opens with the banner a log grep finds it by");
  ok(dump.includes(`since=${SINCE}`) && dump.includes(`until=${UNTIL}`), "the dump states the WINDOW it re-read — the whole question is whether the wait's window was too narrow");
  ok(dump.includes(`limit=${AUDIT_DUMP_LIMIT}`), "the dump states the row ceiling it asked for");
  ok(dump.includes("approval.chain,approval.requested"), "the dump names the actions the timed-out wait wanted");

  ok(dump.includes("ts=2026-02-08T19:25:00.000Z"), "the dump prints each row's ts — the value the `ts >= since` predicate compares");
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
    actions: ["approval.chain"],
    sinceIso: SINCE,
    untilIso: UNTIL,
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
}

{
  const dump = formatAuditTimeoutDump({ actions: [], sinceIso: SINCE, untilIso: UNTIL, limit: AUDIT_DUMP_LIMIT, rows: [] });
  ok(dump.includes("scanTruncated=undefined"), "a flag the response omitted prints as undefined, never as a false the route did not claim");
  ok(dump.includes("scanned=<absent>"), "an absent scan count says absent rather than 0");
  ok(dump.includes("wanted actions: <none>"), "an empty action list is named, not rendered as an empty string");
}

{
  const cyclic: Record<string, unknown> = { tool: "create_routine" };
  cyclic["self"] = cyclic;
  const dump = formatAuditTimeoutDump({
    actions: ["approval.chain"],
    sinceIso: SINCE,
    untilIso: UNTIL,
    limit: AUDIT_DUMP_LIMIT,
    rows: [{ ts: SINCE, org: "acme", action: "approval.chain", detail: cyclic }],
  });
  ok(dump.includes("detail.tool=create_routine"), "a row with an unserialisable detail still prints the field the wait joins on");
  ok(dump.includes("not serialisable"), "…and says why the rest of that bag is missing");
}

{
  const dump = formatAuditTimeoutDump({
    actions: ["a"],
    sinceIso: SINCE,
    untilIso: UNTIL,
    limit: AUDIT_DUMP_LIMIT,
    rows: [{ ts: SINCE, org: "acme", action: "a", detail: { tool: "t", blob: "x".repeat(5000) } }],
  });
  ok(dump.length < 1000, `a huge detail bag is bounded before it reaches the log — got ${dump.length} chars`);
  ok(dump.includes("chars)"), "…and the dump says how much it dropped rather than truncating silently");
  ok(dump.includes("detail.tool=t"), "…while the join key still survives the bound");
}

{
  ok(AUDIT_DUMP_LOOKBACK_MS === 600_000, "the widened window looks back 10 minutes");
  ok(AUDIT_DUMP_LIMIT === 1000, "the widened re-read asks for the route's full 1000-row page");
}

console.log(`✓ audit-timeout-dump: ${passed} assertions passed`);
