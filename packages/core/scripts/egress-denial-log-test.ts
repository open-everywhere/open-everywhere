import {
  isDenialTag,
  normaliseDenialHost,
  planTailRead,
  reduceDenialLog,
} from "../agent/access/egress-denial-log.js";
import {
  MAX_HOSTS_PER_PASS,
  MIN_POLL_MS,
  DEFAULT_POLL_MS,
  egressDenialLogPath,
  egressDenialPollMs,
  pollEgressDenials,
  currentEgressAttribution,
  rememberEgressAttribution,
  resetEgressAttribution,
  type DenialPollDeps,
  type EgressAttribution,
} from "../agent/access/egress-denial-poller.js";
import type { AuditInput } from "../agent/audit/audit.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SECRET = "SEEDED-EGRESS-TOKEN-9f3a";

{
  const chunk = [
    "1754654400.123 TCP_DENIED/403 registry.example.com",
    "1754654401.004 TCP_DENIED/403 registry.example.com",
    "1754654402.900 TCP_TUNNEL/200 api.acme.test",
    "1754654403.110 TCP_DENIED/403 pastebin.test",
  ].join("\n");
  const scan = reduceDenialLog(chunk);
  ok(scan.linesRead === 4, "every non-empty line is considered");
  ok(scan.denials === 3, "only the _DENIED lines count as denials");
  ok(scan.unparsed === 0, "…and each of them yielded a host");
  ok(scan.hosts.length === 2, "hosts are clustered, not listed per line");
  ok(scan.hosts[0]!.host === "registry.example.com" && scan.hosts[0]!.count === 2, "the busiest denied host leads, with its count");
  ok(scan.hosts[1]!.host === "pastebin.test" && scan.hosts[1]!.count === 1, "…then the rest, count-desc then host-asc");
  ok(!scan.hosts.some((h) => h.host === "api.acme.test"), "🔴 an ALLOWED request (TCP_TUNNEL/200) is never evidence that a grant is too narrow");
}

{
  const chunk = [
    `1754654400.123    0 172.18.0.3 TCP_DENIED/403 3856 CONNECT registry.example.com:443 - HIER_NONE/- text/html`,
    `1754654401.500    2 172.18.0.3 TCP_TUNNEL/200 1024 CONNECT api.acme.test:443 - HIER_DIRECT/93.184.216.34 -`,
  ].join("\n");
  const scan = reduceDenialLog(chunk);
  ok(scan.denials === 1 && scan.hosts.length === 1, "the same parser reads the conventional format without being told which it is");
  ok(scan.hosts[0]!.host === "registry.example.com", "…and the port is stripped, so both formats cluster on the same key");
  ok(scan.unparsed === 0, "the byte count and the method are rejected as hosts rather than counted as failures to parse");
}

{
  const nasty =
    `1754654400.123    0 10.1.2.3 TCP_DENIED/403 512 POST ` +
    `https://svc:${SECRET}@internal.example.com:8443/v1/customers/42/export?api_key=${SECRET}&email=a.person%40acme.test ` +
    `alice HIER_NONE/- application/json`;
  const scan = reduceDenialLog(nasty);
  const blob = JSON.stringify(scan);
  ok(scan.hosts.length === 1 && scan.hosts[0]!.host === "internal.example.com", "a full decrypted URL reduces to its HOST — port, path and query all gone");
  ok(!blob.includes(SECRET), "🔴 no URL-embedded credential and no api_key query value survives the reduction");
  ok(!blob.includes("/v1/customers"), "🔴 no path survives");
  ok(!blob.includes("export") && !blob.includes("api_key"), "🔴 no query string survives");
  ok(!blob.includes("a.person"), "🔴 no query-string email survives");
  ok(!blob.includes("POST"), "no method survives — the reducer never reads one");
  ok(!blob.includes("10.1.2.3"), "no client address survives");
  ok(!blob.includes("alice"), "no proxy username survives");

  ok(normaliseDenialHost(`https://u:${SECRET}@h.example.com/p?q=${SECRET}`) === "h.example.com", "normaliseDenialHost cuts path/query FIRST, then userinfo, then port");
  ok(normaliseDenialHost("HOST.Example.COM:443") === "host.example.com", "…and lowercases, so one host is one cluster key");
  ok(normaliseDenialHost("[2001:db8::1]:443") === "[2001:db8::1]", "…and keeps a bracketed IPv6 literal intact");
  ok(normaliseDenialHost("1.2.3.4:443") === "1.2.3.4", "…and accepts an IPv4 literal");
}

{
  ok(normaliseDenialHost("CONNECT") === undefined, "a bare method token is not a host (no dot ⇒ dropped)");
  ok(normaliseDenialHost("3856") === undefined, "a byte count is not a host");
  ok(normaliseDenialHost("-") === undefined, "Squid's empty-field placeholder is not a host");
  ok(normaliseDenialHost("HIER_NONE/-") === undefined, "a hierarchy code is not a host (the `/` cut leaves an underscore-bearing label)");
  ok(normaliseDenialHost("") === undefined && normaliseDenialHost("   ") === undefined, "empty input yields nothing");
  ok(normaliseDenialHost(`${"a".repeat(300)}.example.com`) === undefined, "an over-long value is dropped rather than truncated into a different host");

  ok(isDenialTag("TCP_DENIED") && isDenialTag("TCP_TUNNEL_DENIED"), "every *_DENIED spelling counts");
  ok(!isDenialTag("TCP_TUNNEL") && !isDenialTag("TCP_MISS") && !isDenialTag("TAG_NONE"), "🔴 an outage tag is NOT a policy denial — a DNS failure must never read as 'this grant is too narrow'");

  const originForbidden = reduceDenialLog("1754654400.123    9 10.0.0.2 TCP_MISS/403 88 GET https://api.acme.test/v1/x - HIER_DIRECT/1.2.3.4 application/json");
  ok(originForbidden.denials === 0 && originForbidden.hosts.length === 0, "🔴 an origin's own 403 under Tier B is not an egress denial");

  const noise = reduceDenialLog(["", "   ", "2026/08/08 12:00:00| kid1: Beginning Validation Procedure", "not a log line at all"].join("\n"));
  ok(noise.denials === 0 && noise.unparsed === 0, "cache_log noise interleaved into the file is skipped silently, not reported as a parse failure");

  const bad = reduceDenialLog("1754654400.123 TCP_DENIED/403 -");
  ok(bad.denials === 1 && bad.unparsed === 1 && bad.hosts.length === 0, "🔴 a denial with no recoverable host is COUNTED as unparsed and recorded as nothing");
}

{
  const cold = planTailRead(9000, undefined);
  ok(cold.from === 9000 && cold.to === 9000 && !cold.rotated, "🔴 a cold start seeks to the END — a restart must not replay history the previous process already recorded");
  const grew = planTailRead(9500, 9000);
  ok(grew.from === 9000 && grew.to === 9500 && !grew.rotated, "a grown file is read from where the last pass stopped");
  const rotated = planTailRead(120, 9000);
  ok(rotated.from === 0 && rotated.to === 120 && rotated.rotated, "a SHRUNK file is a rotation: restart at 0 rather than read forever from a stale offset");
  const idle = planTailRead(9000, 9000);
  ok(idle.from === 9000 && idle.to === 9000, "an unchanged file plans a zero-length read");
}

{
  ok(egressDenialLogPath({} as NodeJS.ProcessEnv) === undefined, "no OE_EGRESS_DENIAL_LOG ⇒ no poller (every Vercel deployment, and any self-host run without the volume)");
  ok(egressDenialLogPath({ OE_EGRESS_DENIAL_LOG: "  " } as NodeJS.ProcessEnv) === undefined, "a blank value is unset, not a path");
  ok(egressDenialLogPath({ OE_EGRESS_DENIAL_LOG: "/var/log/oe-egress/denied.log" } as NodeJS.ProcessEnv) === "/var/log/oe-egress/denied.log", "…and a real path is taken");
  ok(egressDenialPollMs({} as NodeJS.ProcessEnv) === DEFAULT_POLL_MS, "the poll interval defaults");
  ok(egressDenialPollMs({ OE_EGRESS_DENIAL_POLL_MS: "10" } as NodeJS.ProcessEnv) === MIN_POLL_MS, "…and is floored, so a mistyped env cannot spin against a shared volume");
  ok(egressDenialPollMs({ OE_EGRESS_DENIAL_POLL_MS: "nonsense" } as NodeJS.ProcessEnv) === DEFAULT_POLL_MS, "…and an unparseable value falls back rather than becoming NaN");
}

const SCOPE: EgressAttribution = {
  org: "acme",
  platform: "slack",
  workspace: "T123",
  surface: "C999",
  policyFingerprint: "c".repeat(64),
};

interface Harness {
  readonly deps: DenialPollDeps;
  readonly rows: AuditInput[];
  readonly warnings: string[];
}

function harness(options: {
  size?: number | undefined;
  sizeThrows?: boolean;
  text?: string;
  readThrows?: boolean;
  attribution?: EgressAttribution | undefined;
  auditThrows?: boolean;
}): Harness {
  const rows: AuditInput[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  return {
    rows,
    warnings,
    deps: {
      size: async () => {
        if (options.sizeThrows) throw new Error("EACCES");
        return options.size;
      },
      read: async (from, to) => {
        if (options.readThrows) throw new Error("EIO");
        return (options.text ?? "").slice(from, to);
      },
      attribution: () => options.attribution,
      audit: async (entry) => {
        if (options.auditThrows) throw new Error("store down");
        rows.push(entry);
      },
      warnOnce: (reason, message) => {
        if (seen.has(reason)) return;
        seen.add(reason);
        warnings.push(message);
      },
      windowMs: 60_000,
    },
  };
}

{
  const text = [
    "1754654400.123 TCP_DENIED/403 registry.example.com",
    "1754654401.004 TCP_DENIED/403 registry.example.com",
    "1754654401.900 TCP_DENIED/403 registry.example.com",
    "1754654402.100 TCP_DENIED/403 pastebin.test",
    "",
  ].join("\n");
  const h = harness({ size: text.length, text, attribution: SCOPE });
  const r = await pollEgressDenials(h.deps, 0);
  ok(r.rowsWritten === 2 && h.rows.length === 2, "🔴 ONE row per HOST per pass — three denials to one host are one row, not three");
  const first = h.rows[0]!;
  ok(first.action === "egress.denied", "the row's action is the one permission-evidence reads");
  ok(first.org === "acme" && first.platform === "slack" && first.workspace === "T123" && first.surface === "C999", "…stamped with the scope of the policy generation in force");
  ok(first.detail!.host === "registry.example.com" && first.detail!.count === 3, "…carrying the host and the aggregated count");
  ok(first.detail!.policyFingerprint === SCOPE.policyFingerprint, "…and the generation that denied it, which is what joins it to the egress.policy row");
  ok(Object.keys(first.detail!).sort().join(",") === "count,host,policyFingerprint,windowMs", "🔴 the row detail carries EXACTLY host + count + fingerprint + window — nothing else may be added here");
  ok(h.rows.every((row) => row.principalId === undefined), "no principal is stamped — this loop is about grants, and a principal would take it off the unattended path");
  ok(r.offset === text.length, "the offset advances to the end of what was read");
}

{
  const lines: string[] = [];
  for (let i = 0; i < MAX_HOSTS_PER_PASS + 7; i++) lines.push(`1754654400.00${i} TCP_DENIED/403 h${i}.example.com`);
  const text = lines.join("\n");
  const h = harness({ size: text.length, text, attribution: SCOPE });
  const r = await pollEgressDenials(h.deps, 0);
  ok(r.rowsWritten === MAX_HOSTS_PER_PASS, "🔴 the per-pass distinct-host cap holds — a scan cannot flood the audit table");
  ok(h.rows.every((row) => row.detail!.distinctHostsDropped === 7), "…and every written row says how many were dropped, so the cap is never silent");
}

{
  const h = harness({ size: undefined, attribution: SCOPE });
  const r = await pollEgressDenials(h.deps, undefined);
  ok(r.skipped === "no-file" && r.rowsWritten === 0, "a missing log degrades to nothing");
  ok(r.offset === undefined, "…leaving the offset untouched, so a file that appears later cold-starts at its end like any other");
  ok(h.warnings.length === 1 && h.warnings[0]!.includes("not readable"), "…and says so ONCE");
  const again = await pollEgressDenials(h.deps, undefined);
  ok(again.skipped === "no-file" && h.warnings.length === 1, "🔴 …exactly once: a permanently-absent file must not warn every minute forever");
}

{
  const h = harness({ sizeThrows: true, attribution: SCOPE });
  const r = await pollEgressDenials(h.deps, 4);
  ok(r.skipped === "no-file" && r.rowsWritten === 0, "a stat that THROWS is the same fail-quiet path, not an exception the app has to catch");
}

{
  const h = harness({ size: 500, readThrows: true, attribution: SCOPE });
  const r = await pollEgressDenials(h.deps, 0);
  ok(r.skipped === "unreadable" && r.rowsWritten === 0, "a failed read degrades to nothing");
  ok(r.offset === 500, "…and still advances, or a permanent read failure at one offset would block every later pass forever");
  ok(h.warnings.some((w) => w.includes("read failed")), "…and says so once");
}

{
  const text = "1754654400.123 TCP_DENIED/403 registry.example.com\n";
  const h = harness({ size: text.length, text, attribution: undefined });
  const r = await pollEgressDenials(h.deps, 0);
  ok(r.skipped === "no-attribution" && h.rows.length === 0, "🔴 denials seen before any policy was applied are DROPPED — no org may be invented to satisfy the schema");
  ok(r.offset === text.length, "…and the offset still advances, because replaying them later would attribute them to a generation that was not in force");
  ok(h.warnings.some((w) => w.includes("before any policy")), "…and the drop is stated once rather than being silent");
}

{
  const text = "1754654400.900 TCP_TUNNEL/200 api.acme.test\n";
  const h = harness({ size: text.length, text, attribution: SCOPE });
  const r = await pollEgressDenials(h.deps, 0);
  ok(r.skipped === "no-denials" && h.rows.length === 0, "a window with only successful requests writes nothing");
}

{
  const text = "1754654400.123 TCP_DENIED/403 registry.example.com\n";
  const h = harness({ size: text.length, text, attribution: SCOPE, auditThrows: true });
  const r = await pollEgressDenials(h.deps, 0);
  ok(r.rowsWritten === 0, "an audit write that throws costs the row");
  ok(r.scan !== undefined, "…and the pass still completes and reports what it saw, rather than throwing into the interval");
}

{
  const h = harness({ size: 10, text: "x".repeat(10), attribution: SCOPE });
  const r = await pollEgressDenials(h.deps, 10);
  ok(r.skipped === "no-growth" && h.rows.length === 0, "an unchanged file reads nothing and writes nothing — the steady-state cost is a stat");
}

{
  resetEgressAttribution();
  ok(currentEgressAttribution() === undefined, "the registry starts empty — a process that has applied no policy can attribute nothing");
  rememberEgressAttribution(SCOPE);
  ok(currentEgressAttribution()?.policyFingerprint === SCOPE.policyFingerprint, "…and takes the scope + generation the egress hook hands it");
  const later: EgressAttribution = { ...SCOPE, policyFingerprint: "d".repeat(64) };
  rememberEgressAttribution(later);
  ok(currentEgressAttribution()?.policyFingerprint === later.policyFingerprint, "a later generation replaces the earlier one — denials are attributed to what is in force NOW");
  resetEgressAttribution();
}

console.log(`✓ egress denial log/poller (OPE-314): ${passed} assertions passed`);
