import type { AuditEntry } from "../agent/operational/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clusterFailures,
  failureSignature,
  normaliseErrorClass,
  signatureKey,
  surfaceKey,
} from "../agent/memory/dream/mode3-cluster.js";
import { buildMode3Report, formatMode3Report, registerFailureFacetJudge, type Mode3Report } from "../agent/memory/dream/mode3.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), label);

function row(action: string, ts: string, detail?: Record<string, unknown>, where?: { workspace?: string; surface?: string; platform?: string }): AuditEntry {
  return {
    ts,
    org: "acme",
    platform: where?.platform ?? "slack",
    workspace: where?.workspace ?? "T1",
    surface: where?.surface ?? "C1",
    action,
    detail,
  };
}

{
  eq(normaliseErrorClass("timeout after 30000ms"), "timeout after <n>ms", "normaliseErrorClass: a digit run becomes <n>");
  eq(
    normaliseErrorClass("fetch https://api.example.com/v1/x/9 failed"),
    "fetch <url> failed",
    "normaliseErrorClass: a url collapses whole, before its own digits could",
  );
  eq(normaliseErrorClass('channel "C0A1B2" not found'), "channel <q> not found", "normaliseErrorClass: a quoted span becomes <q>");
  eq(normaliseErrorClass("session deadbeef1234 died"), "session <id> died", "normaliseErrorClass: a long hex id becomes <id>");
  eq(normaliseErrorClass("  spaced   out \n text "), "spaced out text", "normaliseErrorClass: whitespace collapses and trims");
  eq(
    normaliseErrorClass("upstream 502 for generation ab12cd34ef56"),
    normaliseErrorClass("upstream 503 for generation ff99aa88bb77"),
    "normaliseErrorClass: two messages differing only by id + number land on ONE class",
  );
  ok(
    normaliseErrorClass("upstream 502 for generation ab12cd34ef56") !== normaliseErrorClass("no such channel ab12cd34ef56"),
    "normaliseErrorClass: NEGATIVE CONTROL — genuinely different messages stay different classes",
  );
  eq(normaliseErrorClass("ECONNRESET while reading T01ABCDEF"), "econnreset while reading <id>", "🔴 normaliseErrorClass: an errno name SURVIVES while a Slack id beside it is flattened");
  eq(normaliseErrorClass(""), "", "normaliseErrorClass: an empty string stays empty (an absent error is not a class)");
  const prefix = "gateway request failed while calling the upstream provider for this workspace, cause: ".padEnd(95, "-");
  ok(
    normaliseErrorClass(`${prefix} connection reset by peer`) !== normaliseErrorClass(`${prefix} model unavailable in region`),
    "🔴 normaliseErrorClass: two messages sharing a long prefix but differing in the TAIL stay different classes",
  );
  eq(
    normaliseErrorClass(`${prefix} connection reset by peer`),
    normaliseErrorClass(`${prefix} connection reset by peer`),
    "normaliseErrorClass: …and identical long messages still land on one class",
  );
  ok(normaliseErrorClass("x".repeat(400)).length === 87, "normaliseErrorClass: a truncated class is 80 chars plus a '#' and a 6-hex digest");
  ok(normaliseErrorClass("x".repeat(60)).length === 60, "normaliseErrorClass: a class that fits carries NO digest suffix");

  const started = Date.now();
  normaliseErrorClass("a.b+".repeat(50_000));
  const elapsed = Date.now() - started;
  ok(elapsed < 500, `🔴 normaliseErrorClass: a 200 KB error text is bounded work (took ${elapsed} ms)`);
}

{
  const sig = failureSignature(row("approval.failed", "2026-07-05T00:00:00Z", { kind: "pr.open", error: "GitHub 502 on repo acme/web" }));
  eq(sig.action, "approval.failed", "failureSignature: the action rides the signature (so a cluster is a subset of one action bucket)");
  eq(sig.tool, "pr.open", "failureSignature: approval.failed blames its ActionKind — the literal tool");
  eq(sig.errorClass, "github <n> on repo acme/web", "failureSignature: the error text is normalised into a class");
  eq(sig.surface, "slack/T1/C1", "failureSignature: the surface is platform/workspace/surface");

  const bare = failureSignature(row("turn.bare_stop", "2026-07-05T00:00:00Z", { threadTs: "1720000000.1" }));
  eq(bare.tool, "", "failureSignature: turn.bare_stop names no machinery — tool is empty, never the thread id");
  eq(bare.errorClass, "", "failureSignature: turn.bare_stop carries no error text — class is empty, never invented");

  const gw = failureSignature(row("unified.supervisor_turn_failed", "2026-07-05T00:00:00Z", { gatewayName: "vercel", code: "EmptyModelResponse", message: "no content" }));
  eq(gw.tool, "vercel", "failureSignature: a supervisor failure blames the gateway");
  eq(gw.errorClass, "emptymodelresponse", "failureSignature: the error CODE beats the free-text message as the class");

  eq(surfaceKey({ ...row("turn.bare_stop", "2026-07-05T00:00:00Z"), surface: undefined }), "slack/T1", "surfaceKey: a surface-less row drops the third segment rather than rendering 'undefined'");
  ok(signatureKey(sig) !== signatureKey(bare), "signatureKey: distinct signatures produce distinct keys");
}

{
  const same = [
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502 for generation aa11bb22cc33" }),
    row("approval.failed", "2026-07-05T02:00:00Z", { kind: "pr.open", error: "github 503 for generation dd44ee55ff66" }),
  ];
  const grouped = clusterFailures(same);
  eq(grouped.length, 1, "🔴 clusterFailures: two traces with the SAME signature cluster together");
  eq(grouped[0]!.count, 2, "clusterFailures: …and the cluster counts both");

  const differentTool = clusterFailures([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502" }),
    row("approval.failed", "2026-07-05T02:00:00Z", { kind: "ticket.create", error: "github 502" }),
  ]);
  eq(differentTool.length, 2, "🔴 clusterFailures: a DIFFERENT tool does not cluster together");

  const differentClass = clusterFailures([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502" }),
    row("approval.failed", "2026-07-05T02:00:00Z", { kind: "pr.open", error: "stale frozen arg" }),
  ]);
  eq(differentClass.length, 2, "🔴 clusterFailures: a DIFFERENT error class does not cluster together");

  const differentSurface = clusterFailures([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C1" }),
    row("approval.failed", "2026-07-05T02:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C2" }),
  ]);
  eq(differentSurface.length, 2, "🔴 clusterFailures: a DIFFERENT surface does not cluster together — one cluster is one room");

  eq(new Set([...differentTool, ...differentClass, ...differentSurface].map((c) => c.action)).size, 1, "clusterFailures: all six rows share ONE action — the split is the signature's work, not the action's");

  eq(clusterFailures([row("memory.write", "2026-07-05T01:00:00Z")]).length, 0, "clusterFailures: a non-failure action is ignored");
}

{
  const rows: AuditEntry[] = [
    row("turn.bare_stop", "2026-07-01T01:00:00Z", {}, { surface: "CC" }),
    row("turn.bare_stop", "2026-07-01T02:00:00Z", {}, { surface: "CC" }),
    row("turn.bare_stop", "2026-07-02T01:00:00Z", {}, { surface: "CA" }),
    row("turn.bare_stop", "2026-07-04T01:00:00Z", {}, { surface: "CA" }),
    row("turn.bare_stop", "2026-07-03T01:00:00Z", {}, { surface: "CB" }),
    row("turn.bare_stop", "2026-07-03T02:00:00Z", {}, { surface: "CB" }),
    row("turn.bare_stop", "2026-07-03T03:00:00Z", {}, { surface: "CB" }),
  ];
  const ranked = clusterFailures(rows, { maxClusters: 3 });
  eq(ranked.map((c) => c.signature.surface), ["slack/T1/CB", "slack/T1/CA", "slack/T1/CC"], "🔴 clusterFailures: recurrence ranks first, then SPREAD (the cost proxy) — the 2-day cluster beats the 1-day cluster it ties on count AND saw first");
  eq(ranked.map((c) => c.days), [1, 2, 1], "clusterFailures: `days` counts DISTINCT UTC days, not rows");
  eq(clusterFailures(rows.slice(0, 4), { maxClusters: 2 }).map((c) => c.signature.surface), ["slack/T1/CA", "slack/T1/CC"], "🔴 clusterFailures: with the recurrence tie removed, spread alone decides — and it overrides first-seen");
  eq(clusterFailures(rows, { maxClusters: 2 }).length, 2, "clusterFailures: maxClusters caps the kept clusters");

  const unparseable = clusterFailures([{ ...row("turn.bare_stop", "not-a-date"), surface: "CZ" }]);
  eq(unparseable[0]!.days, 0, "clusterFailures: an unparseable ts contributes NO day — spread is never inflated by a bad timestamp");
}

async function signatureReport(rows: readonly AuditEntry[]): Promise<Mode3Report> {
  const report = await buildMode3Report("acme", rows, "2026-07-01T00:00:00Z", "2026-07-08T00:00:00Z", { cluster: clusterFailures });
  ok(report !== null, "buildMode3Report: the signature clusterer produces a report");
  return report!;
}
{
  const report = await signatureReport([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C1" }),
    row("approval.failed", "2026-07-05T02:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C1" }),
    row("approval.failed", "2026-07-06T01:00:00Z", { kind: "ticket.create", error: "github 502" }, { surface: "C1" }),
  ]);
  eq(report.clusters.length, 2, "buildMode3Report: the injected clusterer's split reaches the report (v1's bucketing would give 1)");
  eq(report.totalFailures, 3, "buildMode3Report: totalFailures still counts every failure row, not just the top clusters");
  const text = formatMode3Report(report);
  ok(text.endsWith("_Discovery only — the digest opens no PR. A human picks which fix sketch, if any, to act on._"), "formatMode3Report: the footer is the discovery-only contract");
}

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-dream-mode3-v2-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { appendAudit, readAudit } = await import("../agent/audit/audit.js");
const { mode3Tick } = await import("../agent/schedules/dream-mode3.js");

const NOW = new Date("2026-07-08T12:00:00Z");
const IN_WINDOW = "2026-07-05T00:00:00.000Z";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadAccessRequests: () => ({ adminChannel: "C0ADMIN", configRepo: "acme/config", baseBundles: () => [], baseBindings: () => [] }),
} as never);

let facetCalls = 0;
let posts = 0;
registerFailureFacetJudge({
  async facet() {
    facetCalls++;
    return { label: "judged label", fixSketch: "f" };
  },
});

{
  await appendAudit({ org: "quietco", platform: "slack", workspace: "T1", surface: "C1", action: "memory.write", ts: IN_WINDOW });
  await appendAudit({ org: "quietco", platform: "slack", workspace: "T2", surface: "C2", action: "pr.open", ts: IN_WINDOW, detail: { repo: "acme/web" } });

  const tick = await mode3Tick({ now: NOW, orgs: ["quietco"], post: async () => (posts++, { ok: true }) as never });
  eq(tick, { orgs: 1, reports: 0, posted: 0 }, "🔴 loop: a week with rows but NO failure traces builds no report");
  eq(facetCalls, 0, "🔴 loop: an empty week spends NOTHING on the facet model");
  eq(posts, 0, "🔴 loop: an empty week posts nothing");
  eq((await readAudit({ org: "quietco", action: "dream.mode3_report" })).length, 0, "loop: an empty week writes no digest row");
}

{
  await appendAudit({ org: "busyco", platform: "slack", workspace: "T1", surface: "C1", action: "approval.failed", ts: IN_WINDOW, detail: { kind: "pr.open", error: "github 502" } });
  const tick = await mode3Tick({ now: NOW, orgs: ["busyco"], post: async () => (posts++, { ok: true }) as never });
  eq(tick, { orgs: 1, reports: 1, posted: 1 }, "loop: NEGATIVE CONTROL — a week with one trace builds and posts a digest");
  ok(facetCalls > 0, "loop: NEGATIVE CONTROL — a non-empty week DOES call the facet model");
  ok(posts > 0, "loop: NEGATIVE CONTROL — a non-empty week DOES post");

  const rows = await readAudit({ org: "busyco", action: "dream.mode3_report" });
  eq(rows.length, 1, "loop: the digest row is written");
  ok(rows[0]!.detail?.["lastMile"] === undefined, "loop: the digest row carries no last-mile field — the arm is deleted (OPE-2410)");
}

await removeTempDir(tmp);
console.log(`✓ dream-mode3-v2: ${passed} assertions passed`);
