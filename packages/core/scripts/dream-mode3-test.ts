import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "../agent/operational/store.js";
import {
  bucketFailures,
  exampleLine,
  facetPrompt,
  parseFailureFacet,
  facetJudgeFromCompletion,
  buildMode3Report,
  formatMode3Report,
  registerFailureFacetJudge,
  isFailureAction,
  type FailureFacetJudge,
  type FailureCluster,
} from "../agent/memory/dream/mode3.js";
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

function row(action: string, ts: string, detail?: Record<string, unknown>): AuditEntry {
  return { ts, org: "acme", platform: "slack", workspace: "T1", surface: "C1", action, detail };
}

{
  ok(isFailureAction("surface.quiet_fail"), "isFailureAction: recognises surface.quiet_fail");
  ok(isFailureAction("turn.bare_stop"), "isFailureAction: recognises turn.bare_stop");
  ok(isFailureAction("webhook.rejected"), "isFailureAction: recognises webhook.rejected");
  ok(isFailureAction("spend.cap_bypassed"), "isFailureAction: recognises spend.cap_bypassed");
  ok(isFailureAction("approval.failed"), "isFailureAction: recognises approval.failed");
  ok(isFailureAction("unified.supervisor_turn_failed"), "isFailureAction: recognises unified.supervisor_turn_failed");
  ok(isFailureAction("unified.supervisor_session_failed"), "isFailureAction: recognises unified.supervisor_session_failed");
  ok(!isFailureAction("memory.write"), "isFailureAction: a non-failure action is NOT one");
  ok(!isFailureAction("approval.approved"), "isFailureAction: a SUCCESS-shaped action is NOT one");
}

{
  const l1 = exampleLine(row("surface.quiet_fail", "t", { event: "turn.failed", message: "model exploded" }));
  ok(l1.includes("turn.failed") && l1.includes("model exploded") && l1.includes("T1/C1"), "exampleLine: surface.quiet_fail carries event + message + where");
  const l2 = exampleLine(row("turn.bare_stop", "t", { threadTs: "123.456" }));
  ok(l2.includes("no reply") && l2.includes("123.456"), "exampleLine: turn.bare_stop names the missing judgment + thread");
  const l3 = exampleLine(row("webhook.rejected", "t", { hookId: "e2e-smoke", status: 401, reason: "bad signature" }));
  ok(l3.includes("e2e-smoke") && l3.includes("401") && l3.includes("bad signature"), "exampleLine: webhook.rejected carries hook id + status + reason");
  const l4 = exampleLine(row("spend.cap_bypassed", "t", { standing: "admin", reason: "urgent release" }));
  ok(l4.includes("admin") && l4.includes("urgent release"), "exampleLine: spend.cap_bypassed carries standing + reason");
  const l5 = exampleLine(row("approval.failed", "t", { kind: "access.request", error: "GitHub 500" }));
  ok(l5.includes("access.request") && l5.includes("GitHub 500"), "exampleLine: approval.failed carries kind + error");
  const l6 = exampleLine(row("spend.cap_bypassed", "t", { standing: "admin" }));
  ok(!l6.includes("undefined"), "exampleLine: an absent optional field never leaks 'undefined' into the line");
  const l7 = exampleLine(
    row("unified.supervisor_turn_failed", "t", {
      message: "The model did not return a response.",
      code: "EmptyModelResponse",
      statusCode: "502",
      gatewayType: "vercel-ai-gateway",
      upstreamType: "anthropic",
    }),
  );
  ok(
    l7.includes("supervisor turn failed") &&
      l7.includes("The model did not return a response.") &&
      l7.includes("code=EmptyModelResponse") &&
      l7.includes("statusCode=502") &&
      l7.includes("gatewayType=vercel-ai-gateway") &&
      l7.includes("upstreamType=anthropic") &&
      l7.includes("T1/C1"),
    "exampleLine: unified.supervisor_turn_failed surfaces failureDiag fields, not just the message",
  );
  const l8 = exampleLine(row("unified.supervisor_session_failed", "t", { message: "session died" }));
  ok(l8.includes("supervisor session failed") && l8.includes("session died") && !l8.includes("[]"), "exampleLine: unified.supervisor_session_failed with no diag fields present renders cleanly (no empty bracket)");
  ok(l1.startsWith("slack "), "exampleLine: the platform always leads — a bare Slack 'T…' team id reads as Microsoft Teams to a human");
  const l9 = exampleLine(row("webhook.rejected", "t", { hookId: "h", status: 401, reason: "r" }), () => "#e2e-smoke");
  ok(l9.includes("slack #e2e-smoke (C1)") && !l9.includes("T1/C1"), "exampleLine: a resolved surface name replaces workspace/surface, keeping the id in parens as the grounding handle");
  const l10 = exampleLine(row("webhook.rejected", "t", { hookId: "h", status: 401, reason: "r" }), () => undefined);
  ok(l10.includes("slack T1/C1"), "exampleLine: a namer that abstains falls back to the raw platform-prefixed ids");
}

{
  const rows: AuditEntry[] = [
    row("surface.quiet_fail", "t1", { event: "turn.failed", message: "a" }),
    row("surface.quiet_fail", "t2", { event: "turn.failed", message: "b" }),
    row("surface.quiet_fail", "t3", { event: "turn.failed", message: "c" }),
    row("turn.bare_stop", "t4", { threadTs: "1" }),
    row("memory.write", "t5"),
    row("webhook.rejected", "t6", { hookId: "h", status: 401, reason: "x" }),
  ];
  const clusters = bucketFailures(rows);
  eq(clusters.map((c) => c.action), ["surface.quiet_fail", "turn.bare_stop", "webhook.rejected"], "bucketFailures: ranked by count desc, non-failure rows dropped");
  eq(clusters[0].count, 3, "bucketFailures: count reflects every matching row");
  eq(clusters[0].examples.length, 3, "bucketFailures: default maxExamplesPerCluster keeps all 3 when under the cap");

  const capped = bucketFailures(rows, { maxClusters: 1, maxExamplesPerCluster: 2 });
  eq(capped.length, 1, "bucketFailures: maxClusters caps the returned clusters");
  eq(capped[0].examples.length, 2, "bucketFailures: maxExamplesPerCluster caps examples per cluster");

  eq(bucketFailures([]), [], "bucketFailures: no rows → no clusters");
  eq(bucketFailures([row("memory.write", "t")]), [], "bucketFailures: ONLY non-failure rows → no clusters");

  const many: AuditEntry[] = [
    row("spend.cap_bypassed", "a"),
    row("spend.cap_bypassed", "b"),
    row("approval.failed", "c", { kind: "k", error: "e" }),
    row("approval.failed", "d", { kind: "k", error: "e" }),
    row("webhook.rejected", "e", { hookId: "h", status: 401, reason: "r" }),
    row("turn.bare_stop", "f", { threadTs: "1" }),
  ];
  eq(bucketFailures(many).length, 3, "bucketFailures: default top-3 cap holds even with 4 distinct failure actions present");
}

{
  const cluster: FailureCluster = { action: "surface.quiet_fail", count: 5, examples: ["a", "b"] };
  ok(facetPrompt(cluster).includes("surface.quiet_fail") && facetPrompt(cluster).includes("STRICT JSON"), "facetPrompt: names the action + strict-JSON instruction");

  const good = parseFailureFacet('{"label": "Gateway hiccups", "fixSketch": "Add retry with backoff."}');
  eq(good, { label: "Gateway hiccups", fixSketch: "Add retry with backoff." }, "parseFailureFacet: strict JSON accepted");
  const fenced = parseFailureFacet('Sure!\n```json\n{"label": "X", "fixSketch": "Y"}\n```');
  eq(fenced, { label: "X", fixSketch: "Y" }, "parseFailureFacet: fenced/prose-wrapped JSON accepted");
  eq(parseFailureFacet("no json here"), null, "parseFailureFacet: garbage → null");
  eq(parseFailureFacet('{"label": ""}'), null, "parseFailureFacet: blank label → null");
  eq(parseFailureFacet('{"label": "X"}'), null, "parseFailureFacet: missing fixSketch → null");
  const long = parseFailureFacet(`{"label": "${"x".repeat(200)}", "fixSketch": "${"y".repeat(400)}"}`);
  ok(long !== null && long.label.length === 120 && long.fixSketch.length === 300, "parseFailureFacet: label/fixSketch clamped to 120/300 chars");
}

{
  const good = facetJudgeFromCompletion(async () => '{"label": "L", "fixSketch": "F"}');
  const cluster: FailureCluster = { action: "turn.bare_stop", count: 1, examples: [] };
  eq(await good.facet("acme", cluster), { label: "L", fixSketch: "F" }, "facetJudgeFromCompletion: completion → parsed facet");
  const thrower = facetJudgeFromCompletion(async () => {
    throw new Error("gateway down");
  });
  eq(await thrower.facet("acme", cluster), null, "facetJudgeFromCompletion: completion throws → null (fail quiet)");
  const garbage = facetJudgeFromCompletion(async () => "sorry, I can't help");
  eq(await garbage.facet("acme", cluster), null, "facetJudgeFromCompletion: unparseable completion → null");
}

{
  const rows: AuditEntry[] = [
    row("surface.quiet_fail", "2026-07-01T00:00:00Z", { event: "turn.failed", message: "boom" }),
    row("turn.bare_stop", "2026-07-02T00:00:00Z", { threadTs: "1" }),
  ];

  registerFailureFacetJudge(null as unknown as FailureFacetJudge);
  const noJudgeReport = await buildMode3Report("acme", rows, "2026-06-25T00:00:00Z", "2026-07-08T00:00:00Z");
  ok(noJudgeReport !== null, "buildMode3Report: non-empty rows → a report");
  ok(noJudgeReport!.clusters.every((c) => c.judged === false), "buildMode3Report: no judge registered → every cluster is the static fallback");
  ok(
    noJudgeReport!.clusters.every((c) => c.label.length > 0 && c.fixSketch.length > 0),
    "buildMode3Report: static fallback always carries a non-empty label + fix sketch",
  );
  eq(noJudgeReport!.totalFailures, 2, "buildMode3Report: totalFailures counts every failure-shaped row, not just kept clusters");

  eq(await buildMode3Report("acme", [], "2026-06-25T00:00:00Z", "2026-07-08T00:00:00Z"), null, "buildMode3Report: empty rows → null (no-op)");
  eq(await buildMode3Report("acme", [row("memory.write", "t")], "s", "e"), null, "buildMode3Report: only non-failure rows → null (no-op)");

  const mixedJudge: FailureFacetJudge = {
    async facet(_scope, cluster) {
      if (cluster.action === "surface.quiet_fail") return { label: "Gateway flakiness", fixSketch: "Add retry/backoff." };
      throw new Error("model unavailable");
    },
  };
  registerFailureFacetJudge(mixedJudge);
  const mixedReport = await buildMode3Report("acme", rows, "2026-06-25T00:00:00Z", "2026-07-08T00:00:00Z");
  const quiet = mixedReport!.clusters.find((c) => c.action === "surface.quiet_fail")!;
  const bare = mixedReport!.clusters.find((c) => c.action === "turn.bare_stop")!;
  ok(quiet.judged === true && quiet.label === "Gateway flakiness", "buildMode3Report: judge-confirmed cluster uses the model's facet");
  ok(bare.judged === false && bare.label.length > 0, "buildMode3Report: a THROWING judge on one cluster falls back to ITS static facet only");

  registerFailureFacetJudge(null as unknown as FailureFacetJudge);
}

{
  const rows: AuditEntry[] = [row("webhook.rejected", "t", { hookId: "h", status: 401, reason: "bad sig" })];
  const report = await buildMode3Report("acme", rows, "2026-06-25T00:00:00Z", "2026-07-08T00:00:00Z");
  const text = formatMode3Report(report!);
  ok(text.includes("Weekly failure digest"), "formatMode3Report: carries the digest header");
  ok(text.includes("2026-06-25") && text.includes("2026-07-08"), "formatMode3Report: carries the window dates");
  ok(text.includes("webhook.rejected"), "formatMode3Report: names the action");
  ok(text.includes(report!.clusters[0].fixSketch), "formatMode3Report: includes the fix sketch");
  ok(/discovery only/i.test(text), "formatMode3Report: says discovery-only (v1 has no auto-PR)");
}

{
  const rows: AuditEntry[] = [
    row("unified.supervisor_turn_failed", "2026-07-01T00:00:00Z", {
      message: "The model did not return a response.",
      code: "EmptyModelResponse",
      statusCode: "502",
      gatewayType: "vercel-ai-gateway",
      upstreamType: "anthropic",
    }),
  ];
  const report = await buildMode3Report("acme", rows, "2026-06-25T00:00:00Z", "2026-07-08T00:00:00Z");
  ok(report !== null, "buildMode3Report: a unified.supervisor_turn_failed row produces a report (not silently dropped)");
  const cluster = report?.clusters.find((c) => c.action === "unified.supervisor_turn_failed");
  ok(cluster !== undefined, "buildMode3Report: unified.supervisor_turn_failed is bucketed as a failure cluster");
  const text = formatMode3Report(report!);
  ok(
    text.includes("code=EmptyModelResponse") &&
      text.includes("statusCode=502") &&
      text.includes("gatewayType=vercel-ai-gateway") &&
      text.includes("upstreamType=anthropic"),
    "formatMode3Report: failureDiag's whitelisted fields reach the RENDERED digest text, not just the raw audit row",
  );
}

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-dream-mode3-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { appendAudit, readAudit } = await import("../agent/audit/audit.js");
const { mode3Tick } = await import("../agent/schedules/dream-mode3.js");
const mode3Schedule = await import("../agent/schedules/dream-mode3.js");

const NOW = new Date("2026-07-08T12:00:00Z");
const IN_WINDOW = "2026-07-05T00:00:00.000Z";
const OUT_OF_WINDOW = "2026-06-01T00:00:00.000Z";

function baseConfig(adminChannel: string | undefined) {
  return {
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadAccessRequests: adminChannel ? () => ({ adminChannel, configRepo: "acme/config", baseBundles: () => [], baseBindings: () => [] }) : () => null,
  } as never;
}

{
  registerConfig(baseConfig("C0ADMIN"));
  await appendAudit({ org: "widgetco", platform: "slack", workspace: "T1", surface: "C1", action: "surface.quiet_fail", ts: IN_WINDOW, detail: { event: "turn.failed", message: "in window" } });
  await appendAudit({ org: "widgetco", platform: "slack", workspace: "T1", surface: "C1", action: "surface.quiet_fail", ts: IN_WINDOW, detail: { event: "turn.failed", message: "in window 2" } });
  await appendAudit({ org: "widgetco", platform: "slack", workspace: "T1", surface: "C1", action: "surface.quiet_fail", ts: OUT_OF_WINDOW, detail: { event: "turn.failed", message: "stale — must not count" } });
  await appendAudit({ org: "widgetco", platform: "slack", workspace: "T1", surface: "C1", action: "memory.write", ts: IN_WINDOW });

  const posts: { channel: string; text: string }[] = [];
  const infoLookups: string[] = [];
  const fakePost = async (method: string, body: string) => {
    const params = new URLSearchParams(body);
    if (method === "conversations.info") {
      infoLookups.push(params.get("channel") ?? "");
      return { ok: true, channel: { name: "e2e-smoke" } };
    }
    posts.push({ channel: params.get("channel") ?? "", text: params.get("text") ?? "" });
    return { ok: true };
  };

  const report = await mode3Tick({ now: NOW, orgs: ["widgetco"], post: fakePost });
  eq(report, { orgs: 1, reports: 1, posted: 1 }, "mode3Tick: one org, one digest built, one post");
  eq(posts.length, 1, "mode3Tick: exactly one admin-channel post");
  eq(posts[0].channel, "C0ADMIN", "mode3Tick: posts to the SAME admin channel access-request.ts uses");
  ok(posts[0].text.includes("surface.quiet_fail"), "mode3Tick: post text names the failing action");
  ok(!posts[0].text.includes("stale — must not count"), "mode3Tick: the out-of-window row's example never surfaces");
  eq(infoLookups, ["C1"], "mode3Tick: the one distinct failure-row channel gets exactly one conversations.info lookup");
  ok(posts[0].text.includes("slack #e2e-smoke (C1)"), "mode3Tick: a resolved name renders as 'slack #name (Cid)' — ids never stand alone in the digest");

  const auditRows = await readAudit({ org: "widgetco", action: "dream.mode3_report" });
  eq(auditRows.length, 1, "mode3Tick: exactly one dream.mode3_report audit row recorded");
  eq(auditRows[0].detail?.["totalFailures"], 2, "mode3Tick: the audit row's totalFailures reflects only the in-window failure rows");

  const heartbeats = await readAudit({ org: "widgetco", action: "dream.mode3_tick" });
  eq(heartbeats.length, 1, "🔴 OPE-635: mode3Tick writes exactly one dream.mode3_tick heartbeat row per org per tick");
  eq(heartbeats[0]!.detail?.["outcome"], "reported: posted", "🔴 OPE-635: a reported+posted week's heartbeat names that outcome");
}

{
  registerConfig(baseConfig(undefined));
  await appendAudit({ org: "noadminco", platform: "slack", workspace: "T1", surface: "C1", action: "turn.bare_stop", ts: IN_WINDOW, detail: { threadTs: "1" } });
  const posts: unknown[] = [];
  const report = await mode3Tick({ now: NOW, orgs: ["noadminco"], post: async () => (posts.push(1), { ok: true }) as never });
  eq(report, { orgs: 1, reports: 1, posted: 0 }, "mode3Tick: no admin channel → report still built+audited, but posted stays 0");
  eq(posts.length, 0, "mode3Tick: the poster is never called without a configured admin channel");
  const auditRows = await readAudit({ org: "noadminco", action: "dream.mode3_report" });
  eq(auditRows.length, 1, "mode3Tick: the digest is still audited even when nothing could be posted");

  const heartbeats = await readAudit({ org: "noadminco", action: "dream.mode3_tick" });
  eq(heartbeats.length, 1, "OPE-635: a reported-but-not-posted week still writes its heartbeat");
  eq(heartbeats[0]!.detail?.["outcome"], "reported: no admin channel configured — skipped post", "OPE-635: …naming exactly why nothing posted");
}

{
  registerConfig(baseConfig("C0ADMIN"));
  const posts: unknown[] = [];
  const report = await mode3Tick({ now: NOW, orgs: ["emptyco"], post: async () => (posts.push(1), { ok: true }) as never });
  eq(report, { orgs: 1, reports: 0, posted: 0 }, "mode3Tick: an org with zero failure rows this week → 0 reports, 0 posted");
  eq(posts.length, 0, "mode3Tick: empty week never calls the poster");
  const auditRows = await readAudit({ org: "emptyco", action: "dream.mode3_report" });
  eq(auditRows.length, 0, "mode3Tick: empty week never writes a digest audit row");

  const heartbeats = await readAudit({ org: "emptyco", action: "dream.mode3_tick" });
  eq(heartbeats.length, 1, "🔴 OPE-635: an EMPTY WEEK still writes its heartbeat row — the ticket's exact concrete failure");
  eq(heartbeats[0]!.detail?.["outcome"], "no-op: empty week", "🔴 OPE-635: …and names the no-op explicitly");
  ok(heartbeats[0]!.detail?.["totalFailures"] === undefined, "OPE-635: an empty-week heartbeat carries no totalFailures field (nothing to report)");
}

{
  registerConfig(baseConfig("C0ADMIN"));
  await appendAudit({ org: "flakyco", platform: "slack", workspace: "T1", surface: "C1", action: "approval.failed", ts: IN_WINDOW, detail: { kind: "k", error: "e" } });
  const throwingPost = async () => {
    throw new Error("Slack is down");
  };
  const report = await mode3Tick({ now: NOW, orgs: ["flakyco"], post: throwingPost });
  eq(report, { orgs: 1, reports: 1, posted: 0 }, "mode3Tick: a throwing poster is caught — report still counted, posted stays 0, tick doesn't throw");

  const heartbeats = await readAudit({ org: "flakyco", action: "dream.mode3_tick" });
  eq(heartbeats.length, 1, "OPE-635: a throwing poster's tick still writes its heartbeat");
  ok(
    typeof heartbeats[0]!.detail?.["outcome"] === "string" && (heartbeats[0]!.detail!["outcome"] as string).startsWith("reported: post failed") && (heartbeats[0]!.detail!["outcome"] as string).includes("Slack is down"),
    "OPE-635: …and names the post failure, not just a silent skip",
  );
}

{
  eq(mode3Schedule.default.cron, "0 5 * * 1", "schedule: weekly Monday 05:00 UTC cron (an hour after the daily tidy)");
  ok(typeof mode3Schedule.default.run === "function", "schedule: default export has a run handler");
  ok(mode3Schedule.default.cron !== (await import("../agent/schedules/tidy.js")).default.cron, "schedule: mode3's cron is distinct from tidy's daily cron");
}

await removeTempDir(tmp);
console.log(`✓ dream-mode3: ${passed} assertions passed`);
