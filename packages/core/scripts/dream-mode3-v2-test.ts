import type { AuditEntry, AuditInput } from "../agent/operational/store.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clusterFailures,
  failureSignature,
  normaliseErrorClass,
  signatureKey,
  surfaceKey,
  type SignatureCluster,
} from "../agent/memory/dream/mode3-cluster.js";
import { buildMode3Report, formatMode3Report, registerFailureFacetJudge, FACET_LABEL_MAX, FACET_SKETCH_MAX, type Mode3Report } from "../agent/memory/dream/mode3.js";
import {
  assertHeadIsNotBase,
  headBranchFor,
  isPlainFileName,
  lastMileDedupeKey,
  lastMileLine,
  registerMode3LastMileApproval,
  registerMode3Repro,
  runLastMile,
  MODE3_LAST_MILE,
  type LastMileOutcome,
  type Mode3LastMileConfig,
} from "../agent/memory/dream/mode3-last-mile.js";
import type { ConfigPrProvider } from "../agent/credentials/config-pr.js";
import { makeGitHubConfigPrProvider } from "../agent/credentials/config-pr-github.js";

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
  ok(text.includes("_Discovery only — no PR opened this run. A human picks which fix sketch, if any, to act on._"), "formatMode3Report: the default footer is still the discovery-only contract");
  ok(text.includes("Could not reproduce") === false, "formatMode3Report: no last-mile claim appears unless one is passed");
  ok(formatMode3Report(report, "_custom footer_").endsWith("_custom footer_"), "formatMode3Report: an injected footer replaces the default");
}

const armReport = await signatureReport([
  row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C1" }),
  row("approval.failed", "2026-07-06T01:00:00Z", { kind: "pr.open", error: "github 503" }, { surface: "C1" }),
]);

const ON: Mode3LastMileConfig = { enabled: true, repo: "acme/web", base: "main", reproDir: "repros/dream-mode3" };

function fakeProvider(): { provider: ConfigPrProvider; calls: { op: string; branch?: string; head?: string; base?: string; draft?: boolean; path?: string }[] } {
  const calls: { op: string; branch?: string; head?: string; base?: string; draft?: boolean; path?: string }[] = [];
  const provider: ConfigPrProvider = {
    async resolveWriteToken() {
      calls.push({ op: "resolveWriteToken" });
      return "t0k3n";
    },
    committer: () => ({ name: "open-everywhere[bot]", email: "bot@example.invalid" }),
    async getBranchSha(a) {
      calls.push({ op: "getBranchSha", branch: a.branch });
      return "basesha";
    },
    async ensureBranch(a) {
      calls.push({ op: "ensureBranch", branch: a.branch });
    },
    async getFile(a) {
      calls.push({ op: "getFile", branch: a.branch, path: a.path });
      return null;
    },
    async putFile(a) {
      calls.push({ op: "putFile", branch: a.branch, path: a.path });
    },
    async openOrReopenPr(a) {
      calls.push({ op: "openOrReopenPr", head: a.head, base: a.base, draft: a.draft });
      return { url: "https://github.com/acme/web/pull/7", number: 7, updated: false, reopened: false };
    },
  };
  return { provider, calls };
}

const reproduced = async () => ({ reproduced: true, note: "Reproduced on a clean checkout.", file: { name: "r.md", content: "# repro" } });
const approved = async () => true;

{
  eq(MODE3_LAST_MILE.enabled, false, "🔴 MODE3_LAST_MILE: the tracked literal SHIPS OFF");
  eq(MODE3_LAST_MILE.repo, null, "🔴 MODE3_LAST_MILE: the tracked literal declares NO repository");

  let touched = 0;
  const out = await runLastMile(armReport, { repro: async () => (touched++, { reproduced: false, note: "n" }), approve: async () => (touched++, true) });
  eq(out, { kind: "disabled" }, "🔴 last mile: the shipped default refuses as `disabled`");
  eq(touched, 0, "🔴 last mile: a disabled arm calls NEITHER the repro transport NOR the approval gate");
  ok(lastMileLine(out).includes("is off on this deployment"), "lastMileLine: a disabled arm says so plainly in the digest");
}

{
  let touched = 0;
  const out = await runLastMile(armReport, {
    config: { ...ON, repo: null },
    repro: async () => (touched++, { reproduced: true, note: "n", file: { name: "r.md", content: "x" } }),
    approve: async () => (touched++, true),
  });
  eq(out, { kind: "no-repo" }, "🔴 last mile: REFUSES without a declared repo, even when enabled");
  eq(touched, 0, "🔴 last mile: no declared repo means nothing is cloned and nothing is approved");
  ok(lastMileLine(out).includes("no repository is declared"), "lastMileLine: the no-repo refusal names its reason");
}

{
  let cloned = 0;
  const noGate = await runLastMile(armReport, { config: ON, repro: async () => (cloned++, { reproduced: true, note: "n", file: { name: "r.md", content: "x" } }) });
  eq(noGate.kind, "refused", "🔴 last mile: REFUSES when no approval gate is registered — fail-closed");
  ok(noGate.kind === "refused" && noGate.reason.includes("fail-closed"), "last mile: …and names fail-closed as the reason");
  eq(cloned, 0, "🔴 last mile: an unapproved run never reaches the repro transport");

  const { provider, calls } = fakeProvider();
  const declined = await runLastMile(armReport, { config: ON, provider, approve: async () => false, repro: async () => (cloned++, { reproduced: true, note: "n", file: { name: "r.md", content: "x" } }) });
  eq(declined.kind, "refused", "🔴 last mile: REFUSES when the approval plane says no");
  eq(cloned, 0, "🔴 last mile: a declined run never clones");
  eq(calls.length, 0, "🔴 last mile: a declined run never touches the config-PR provider at all");
  ok(lastMileLine(declined).includes("did not approve"), "lastMileLine: a declined run says the approval plane refused");
}

{
  const top = armReport.clusters[0] as unknown as SignatureCluster;
  const head = headBranchFor(top);
  ok(head.startsWith("oe/dream-mode3/"), "headBranchFor: the head is a deterministic oe/dream-mode3/<digest> branch");
  eq(
    headBranchFor({ ...top, count: 99, days: 7, examples: ["totally different example line"] }),
    head,
    "🔴 headBranchFor: the head survives a changed count, spread and example set — so next week's re-run UPDATES one PR instead of opening a second",
  );
  ok(
    headBranchFor({ ...top, signature: { ...top.signature, surface: "slack/T1/C2" } }) !== head,
    "🔴 headBranchFor: a DIFFERENT signature yields a different head — two defects never collide on one branch",
  );

  let threw = false;
  try {
    assertHeadIsNotBase(head, head);
  } catch {
    threw = true;
  }
  ok(threw, "🔴 assertHeadIsNotBase: throws when the head IS the base");

  const { provider, calls } = fakeProvider();
  const out = await runLastMile(armReport, { config: { ...ON, base: head }, provider, approve: approved, repro: reproduced });
  eq(out.kind, "refused", "🔴 last mile: REFUSES when the configured base equals the computed head");
  eq(calls.length, 0, "🔴 last mile: …and writes nothing at all on that refusal");
}

{
  const { provider, calls } = fakeProvider();
  const out = await runLastMile(armReport, {
    config: ON,
    provider,
    approve: approved,
    repro: async () => ({ reproduced: false, note: "The failing gateway call now succeeds on a clean checkout." }),
  });
  eq(out, { kind: "not-reproduced", note: "The failing gateway call now succeeds on a clean checkout." }, "🔴 last mile: a failed repro returns `not-reproduced`, carrying the transport's plain sentence");
  eq(calls.length, 0, "🔴 last mile: a failed repro OPENS NOTHING — the provider is never called");
  ok(lastMileLine(out).startsWith(":mag: *Could not reproduce*"), "🔴 last mile: the digest says 'Could not reproduce' in plain words");
  ok(lastMileLine(out).includes("no pull request was opened"), "last mile: …and says nothing was opened");

  const { provider: p2, calls: c2 } = fakeProvider();
  const empty = await runLastMile(armReport, { config: ON, provider: p2, approve: approved, repro: async () => ({ reproduced: true, note: "claimed, but produced nothing" }) });
  eq(empty.kind, "not-reproduced", "🔴 last mile: `reproduced: true` with no file is treated as NOT reproduced");
  eq(c2.length, 0, "last mile: …and opens nothing");
}

{
  const multi = await signatureReport([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "ticket.create", error: "github 502" }, { surface: "C9" }),
    row("approval.failed", "2026-07-05T02:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C1" }),
    row("approval.failed", "2026-07-06T01:00:00Z", { kind: "pr.open", error: "github 503" }, { surface: "C1" }),
    row("approval.failed", "2026-07-07T01:00:00Z", { kind: "pr.open", error: "github 504" }, { surface: "C1" }),
    row("approval.failed", "2026-07-05T03:00:00Z", { kind: "pr.open", error: "stale frozen arg" }, { surface: "C1" }),
    row("approval.failed", "2026-07-06T03:00:00Z", { kind: "pr.open", error: "stale frozen arg" }, { surface: "C1" }),
  ]);
  eq(multi.clusters.length, 3, "last mile fixture: the report really does carry three clusters");
  eq(multi.clusters.map((c) => c.count), [3, 2, 1], "last mile fixture: …ranked by recurrence, so clusters[0] is unambiguous");

  const { provider, calls } = fakeProvider();
  const out = await runLastMile(multi, { config: ON, provider, approve: approved, repro: reproduced });
  eq(out, { kind: "opened", url: "https://github.com/acme/web/pull/7", number: 7, updated: false }, "last mile: a reproduced top cluster opens the pull request");

  const opens = calls.filter((c) => c.op === "openOrReopenPr");
  eq(opens.length, 1, "🔴 last mile: opens AT MOST ONE pull request per digest, from a THREE-cluster report");
  eq(opens[0]!.draft, true, "🔴 last mile: the pull request is opened as a DRAFT");
  const head = headBranchFor(multi.clusters[0] as unknown as SignatureCluster);
  eq(opens[0]!.head, head, "🔴 last mile: the head belongs to clusters[0] — the TOP cluster, not an arbitrary one");
  ok(multi.clusters.slice(1).every((c) => headBranchFor(c as unknown as SignatureCluster) !== opens[0]!.head), "🔴 last mile: …and to none of the other two clusters");
  eq(opens[0]!.base, "main", "last mile: the PR targets the declared base");

  eq(calls.filter((c) => c.op === "getBranchSha").map((c) => c.branch), ["main"], "last mile: the base is READ exactly once, for the sha to cut the head from");
  const written = calls.filter((c) => c.op === "ensureBranch" || c.op === "putFile").map((c) => c.branch);
  eq(new Set(written).size, 1, "🔴 last mile: every write names ONE branch");
  eq(written[0], head, "🔴 last mile: …and that branch is the HEAD — the base is never written");
  eq(calls.find((c) => c.op === "putFile")?.path, `${ON.reproDir}/r.md`, "last mile: the repro file lands under the declared reproDir");
  ok(lastMileLine(out).includes("DRAFT proposal"), "lastMileLine: the digest says the PR is a draft a human merges");

  const shipped = makeGitHubConfigPrProvider();
  ok(!Object.keys(shipped).some((k) => k.toLowerCase().includes("merge")), "🔴 last mile: the SHIPPED ConfigPrProvider carries no merge method");
  const armSource = readFileSync(new URL("../agent/memory/dream/mode3-last-mile.ts", import.meta.url), "utf8");
  ok(!/\.\s*merge/i.test(armSource) && !/merge[A-Za-z]*\s*\(/.test(armSource), "🔴 last mile: the arm's own source calls nothing named merge");

  const v1Report = (await buildMode3Report("acme", [row("turn.bare_stop", "2026-07-05T01:00:00Z")], "2026-07-01T00:00:00Z", "2026-07-08T00:00:00Z"))!;
  const { provider: p3, calls: c3 } = fakeProvider();
  const refused = await runLastMile(v1Report, { config: ON, provider: p3, approve: approved, repro: reproduced });
  eq(refused.kind, "refused", "🔴 last mile: REFUSES a report built without signature clustering rather than inventing a head");
  eq(c3.length, 0, "last mile: …and writes nothing");
}

{
  ok(isPlainFileName("repro-2026-07-05.md"), "isPlainFileName: an ordinary name passes");
  ok(!isPlainFileName("sub/dir/x.md"), "🔴 isPlainFileName: a path separator is refused — a plain subdirectory already escapes reproDir");
  ok(!isPlainFileName("../../.github/workflows/x.yml"), "🔴 isPlainFileName: traversal is refused");
  ok(!isPlainFileName(".hidden"), "🔴 isPlainFileName: a leading dot is refused");
  ok(!isPlainFileName(".."), "🔴 isPlainFileName: `..` alone is refused");
  ok(!isPlainFileName(""), "isPlainFileName: an empty name is refused");
  ok(!isPlainFileName(`${"x".repeat(121)}.md`), "isPlainFileName: an overlong name is refused");

  const { provider, calls } = fakeProvider();
  const out = await runLastMile(armReport, {
    config: ON,
    provider,
    approve: approved,
    repro: async () => ({ reproduced: true, note: "n", file: { name: "../../.github/workflows/pwn.yml", content: "x" } }),
  });
  eq(out.kind, "refused", "🔴 last mile: a transport that names a file outside reproDir is REFUSED");
  eq(calls.length, 0, "🔴 last mile: …and nothing is written — the refusal lands before any provider call");
}

{
  const { provider, calls } = fakeProvider();
  const failing: ConfigPrProvider = {
    ...provider,
    async openOrReopenPr(a) {
      calls.push({ op: "openOrReopenPr", head: a.head, base: a.base, draft: a.draft });
      throw new Error("github: 500 server error\nstack that must not ride along");
    },
  };
  const out = await runLastMile(armReport, { config: ON, provider: failing, approve: approved, repro: reproduced });
  const head = headBranchFor(armReport.clusters[0] as unknown as SignatureCluster);
  eq(out, { kind: "failed-after-write", reason: "github: 500 server error", head }, "🔴 last mile: a PR-open failure AFTER the commit reports `failed-after-write`, naming the branch that exists");
  ok(calls.some((c) => c.op === "ensureBranch"), "last mile: …and the branch really was written before the failure");
  ok(lastMileLine(out).includes("needs a human"), "🔴 lastMileLine: the digest says the branch exists and needs a human, NOT 'discovery only'");
  ok(!lastMileLine(out).includes("Discovery only"), "🔴 lastMileLine: …and never claims nothing was written");
  ok(lastMileLine({ kind: "refused", reason: "x" }).includes("before it wrote anything"), "lastMileLine: a refusal, by contrast, states that nothing was written");
}

{
  const httpBody = `github binding PR create failed: 422 {\n  "message": "Validation Failed",\n  "errors": [${'{"resource":"PullRequest","field":"body"},'.repeat(2000)}]\n}`;
  ok(httpBody.length > 65536, "body fixture: the audited error really is larger than GitHub's 65536-char body limit");

  const big = await signatureReport([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: httpBody }, { surface: "C1" }),
    row("approval.failed", "2026-07-06T01:00:00Z", { kind: "pr.open", error: httpBody }, { surface: "C1" }),
  ]);
  const { provider, calls } = fakeProvider();
  let body = "";
  const capturing: ConfigPrProvider = {
    ...provider,
    async openOrReopenPr(a) {
      body = a.body;
      return provider.openOrReopenPr(a);
    },
  };
  const out = await runLastMile(big, {
    config: ON,
    provider: capturing,
    approve: approved,
    repro: async () => ({ reproduced: true, note: httpBody, file: { name: "r.md", content: "x" } }),
  });
  eq(out.kind, "opened", "body bound: the oversized cluster still opens (the arm does not simply refuse)");
  ok(body.length < 65536, `🔴 body bound: the pull-request body stays under GitHub's 65536-char limit (was ${body.length})`);
  ok(body.length < 4000, `🔴 body bound: …and is small, not merely under the limit (was ${body.length})`);
  ok(!body.includes('{"resource":"PullRequest","field":"body"},'.repeat(10)), "🔴 body bound: the raw HTTP response body does not ride into the pull request");
  ok(body.includes("… ("), "body bound: a clamped line says how much was dropped rather than truncating silently");
  eq(body.split("\n").length, 12, "🔴 body bound: audited text is FLATTENED — the body is exactly its own 12 lines, not reshaped by embedded newlines");
  ok(!/422 \{\n/.test(body), "🔴 body bound: …so the raw multi-line HTTP body never lands as markdown structure");
  ok(calls.some((c) => c.op === "putFile"), "body bound: the repro file is still committed");

  const emoji = `${"a".repeat(299)}${"\u{1F534}".repeat(20)}`;
  const clamped = await signatureReport([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: emoji }, { surface: "C1" }),
    row("approval.failed", "2026-07-06T01:00:00Z", { kind: "pr.open", error: emoji }, { surface: "C1" }),
  ]);
  let emojiBody = "";
  const capturing2: ConfigPrProvider = { ...provider, async openOrReopenPr(a) { emojiBody = a.body; return provider.openOrReopenPr(a); } };
  await runLastMile(clamped, { config: ON, provider: capturing2, approve: approved, repro: async () => ({ reproduced: true, note: emoji, file: { name: "r.md", content: "x" } }) });
  ok(!/[\uD800-\uDFFF]/.test(emojiBody.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), "🔴 body bound: clamping cuts by CODE POINT — no lone surrogate reaches the pull-request body");
}

{
  registerFailureFacetJudge({ async facet() { return { label: "L".repeat(5000), fixSketch: "F".repeat(5000) }; } });
  const wide = await signatureReport([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C1" }),
    row("approval.failed", "2026-07-06T01:00:00Z", { kind: "pr.open", error: "github 503" }, { surface: "C1" }),
  ]);
  eq(wide.clusters[0]!.label.length, FACET_LABEL_MAX, "🔴 buildMode3Report: a registered judge's oversized LABEL is clamped at the one point every consumer reads");
  eq(wide.clusters[0]!.fixSketch.length, FACET_SKETCH_MAX, "🔴 buildMode3Report: …and so is its fix sketch");

  const { provider } = fakeProvider();
  let title = "";
  const capturing: ConfigPrProvider = { ...provider, async openOrReopenPr(a) { title = a.title; return provider.openOrReopenPr(a); } };
  const out = await runLastMile(wide, { config: ON, provider: capturing, approve: approved, repro: reproduced });
  eq(out.kind, "opened", "title bound: the oversized-label cluster still opens");
  ok(title.length <= 256, `🔴 title bound: the pull-request title stays within GitHub's 256-char limit (was ${title.length})`);

  registerFailureFacetJudge({
    async facet() {
      return { label: "first line\n\n## Injected heading\n- and a bullet", fixSketch: "sketch line one\nsketch line two" };
    },
  });
  const shaped = await signatureReport([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C1" }),
    row("approval.failed", "2026-07-06T01:00:00Z", { kind: "pr.open", error: "github 503" }, { surface: "C1" }),
  ]);
  ok(shaped.clusters[0]!.label.includes("\n"), "🔴 newline label/CONTROL: the cluster really carries the newline — the clamp upstream does not strip it");
  let shapedTitle = "";
  let shapedBody = "";
  const capturing3: ConfigPrProvider = {
    ...provider,
    async openOrReopenPr(a) {
      shapedTitle = a.title;
      shapedBody = a.body;
      return provider.openOrReopenPr(a);
    },
  };
  eq((await runLastMile(shaped, { config: ON, provider: capturing3, approve: approved, repro: reproduced })).kind, "opened", "newline label: the cluster still opens");
  ok(!shapedTitle.includes("\n"), `🔴 newline label: the pull-request TITLE is one line — a title that splits is a title GitHub truncates at the break (was ${JSON.stringify(shapedTitle)})`);
  ok(/\*\*Label:\*\* first line ## Injected heading - and a bullet/.test(shapedBody), "🔴 newline label: …and the body's Label line is flattened onto ONE line, so the judge's text cannot become markdown structure");
  ok(/\*\*Fix sketch:\*\* sketch line one sketch line two/.test(shapedBody), "🔴 newline label: the fix sketch is flattened by the same helper");
  ok(!/^## Injected heading$/m.test(shapedBody), "🔴 newline label: 🔴 and no line of the body is the injected heading — the assertion that says the flatten is real");

  registerFailureFacetJudge({ async facet() { return null; } });
}

{
  const a = await signatureReport([row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C1" })]);
  const b = await signatureReport([
    row("approval.failed", "2026-07-05T01:00:00Z", { kind: "pr.open", error: "github 502" }, { surface: "C1" }),
    row("approval.failed", "2026-07-06T01:00:00Z", { kind: "pr.open", error: "github 503" }, { surface: "C1" }),
  ]);
  eq(lastMileDedupeKey(a), lastMileDedupeKey(b), "🔴 lastMileDedupeKey: a slid window that changes the COUNT does not change the key");
  const relabelled = { ...a, clusters: [{ ...a.clusters[0]!, label: "a different label from a re-judged tick", fixSketch: "different" }] };
  eq(lastMileDedupeKey(relabelled), lastMileDedupeKey(a), "🔴 lastMileDedupeKey: a re-judged LABEL does not change the key — the facet judge must not steer the guard");
  const other = await signatureReport([row("approval.failed", "2026-07-05T01:00:00Z", { kind: "ticket.create", error: "github 502" }, { surface: "C1" })]);
  ok(lastMileDedupeKey(other) !== lastMileDedupeKey(a), "🔴 lastMileDedupeKey: a genuinely DIFFERENT top cluster is a different key — the guard never mutes a new defect");
  const v1 = (await buildMode3Report("acme", [row("turn.bare_stop", "2026-07-05T01:00:00Z")], "2026-07-01T00:00:00Z", "2026-07-08T00:00:00Z"))!;
  eq(lastMileDedupeKey(v1), null, "lastMileDedupeKey: a report with no signature cluster has no key");
}

{
  const rows: AuditInput[] = [];
  const { provider } = fakeProvider();
  const out = await runLastMile(armReport, { config: ON, provider, approve: approved, repro: reproduced, audit: async (r) => (rows.push(r), undefined) });
  const armHead = headBranchFor(armReport.clusters[0] as unknown as SignatureCluster);
  eq(out.kind, "opened", "self-audit: the happy path still opens");
  eq(rows.length, 2, "🔴 self-audit: a writing run leaves TWO rows — the branch it cut, then the outcome");
  eq(rows[0]!.action, "dream.mode3_last_mile", "self-audit: …under its own action");
  eq((rows[0]!.detail as Record<string, unknown>)["outcome"], "branch-cut", "🔴 self-audit: the FIRST row is the branch cut, recorded before anything else is written");
  eq((rows[0]!.detail as Record<string, unknown>)["head"], armHead, "🔴 self-audit: …and it names the branch, which is the only thing a reader can act on");
  eq((rows[1]!.detail as Record<string, unknown>)["number"], 7, "self-audit: the SECOND row is the outcome, naming the pull request that now exists");

  const rowsOrder: AuditInput[] = [];
  let seenAtPrCall = -1;
  const watching: ConfigPrProvider = {
    ...provider,
    async openOrReopenPr(a) {
      seenAtPrCall = rowsOrder.length;
      return provider.openOrReopenPr(a);
    },
  };
  await runLastMile(armReport, { config: ON, provider: watching, approve: approved, repro: reproduced, audit: async (r) => (rowsOrder.push(r), undefined) });
  eq(seenAtPrCall, 1, "🔴 self-audit: the branch-cut row is ALREADY written when the pull-request call runs — record-before-write, not record-after");

  const failing: ConfigPrProvider = { ...provider, async openOrReopenPr() { throw new Error("github: 500"); } };
  const rows2: AuditInput[] = [];
  const bad = await runLastMile(armReport, { config: ON, provider: failing, approve: approved, repro: reproduced, audit: async (r) => (rows2.push(r), undefined) });
  eq(bad.kind, "failed-after-write", "self-audit: a post-write failure is still its own outcome");
  eq(rows2.length, 2, "🔴 self-audit: …and it too leaves the branch-cut row plus a durable outcome row");
  eq((rows2[1]!.detail as Record<string, unknown>)["head"], armHead, "self-audit: …with the branch name in it");

  const rows3: AuditInput[] = [];
  await runLastMile(armReport, { config: ON, provider, approve: async () => false, repro: reproduced, audit: async (r) => (rows3.push(r), undefined) });
  eq(rows3.length, 0, "🔴 self-audit: a refusal wrote nothing, so it writes no write-row either");

  const stillOpened = await runLastMile(armReport, {
    config: ON,
    provider,
    approve: approved,
    repro: reproduced,
    audit: async () => {
      throw new Error("audit store down");
    },
  });
  eq(stillOpened.kind, "opened", "🔴 self-audit: a THROWING audit leaves the outcome alone — it must not mis-report a real pull request as refused");
}

{
  let used = 0;
  registerMode3Repro(async () => (used++, { reproduced: false, note: "from the registered transport" }));
  registerMode3LastMileApproval(async () => true);
  const out = await runLastMile(armReport, { config: ON });
  eq(out, { kind: "not-reproduced", note: "from the registered transport" }, "🔴 last mile: with no injected deps it uses the REGISTERED transport and approval gate");
  eq(used, 1, "last mile: …and calls the registered transport exactly once");
}

{
  const out: LastMileOutcome = await runLastMile(armReport, {
    config: ON,
    approve: approved,
    repro: async () => {
      throw new Error("clone failed: no disk space\nstack line that must not ride along");
    },
  });
  eq(out.kind, "refused", "last mile: a throwing transport becomes a `refused` outcome, never an exception");
  ok(out.kind === "refused" && out.reason === "clone failed: no disk space", "last mile: the refusal reason is the FIRST line only — no stack trace reaches the digest or the audit row");
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
let lastMileCalls = 0;
let posts = 0;
registerFailureFacetJudge({
  async facet() {
    facetCalls++;
    return { label: `label from judge call ${facetCalls}`, fixSketch: "f" };
  },
});
const spendingDeps = {
  config: ON,
  approve: async () => (lastMileCalls++, true),
  repro: async () => (lastMileCalls++, { reproduced: false as const, note: "n" }),
};

{
  await appendAudit({ org: "quietco", platform: "slack", workspace: "T1", surface: "C1", action: "memory.write", ts: IN_WINDOW });
  await appendAudit({ org: "quietco", platform: "slack", workspace: "T2", surface: "C2", action: "pr.open", ts: IN_WINDOW, detail: { repo: "acme/web" } });

  const tick = await mode3Tick({ now: NOW, orgs: ["quietco"], post: async () => (posts++, { ok: true }) as never, lastMile: spendingDeps });
  eq(tick, { orgs: 1, reports: 0, posted: 0 }, "🔴 loop: a week with rows but NO failure traces builds no report");
  eq(facetCalls, 0, "🔴 loop: an empty week spends NOTHING on the facet model");
  eq(lastMileCalls, 0, "🔴 loop: an empty week never runs the last-mile arm");
  eq(posts, 0, "🔴 loop: an empty week posts nothing");
  eq((await readAudit({ org: "quietco", action: "dream.mode3_report" })).length, 0, "loop: an empty week writes no digest row");
}

{
  await appendAudit({ org: "busyco", platform: "slack", workspace: "T1", surface: "C1", action: "approval.failed", ts: IN_WINDOW, detail: { kind: "pr.open", error: "github 502" } });
  const tick = await mode3Tick({ now: NOW, orgs: ["busyco"], post: async () => (posts++, { ok: true }) as never, lastMile: spendingDeps });
  eq(tick, { orgs: 1, reports: 1, posted: 1 }, "loop: NEGATIVE CONTROL — a week with one trace builds and posts a digest");
  ok(facetCalls > 0, "loop: NEGATIVE CONTROL — a non-empty week DOES call the facet model");
  ok(lastMileCalls > 0, "loop: NEGATIVE CONTROL — a non-empty week DOES run the last-mile arm");
  ok(posts > 0, "loop: NEGATIVE CONTROL — a non-empty week DOES post");

  const rows = await readAudit({ org: "busyco", action: "dream.mode3_report" });
  eq(rows.length, 1, "loop: the digest row is written");
  eq((rows[0]!.detail?.["lastMile"] as Record<string, unknown>)["kind"], "not-reproduced", "🔴 loop: the digest audit row records the last-mile OUTCOME, so a 'could not reproduce' is durable, not just posted");

  const armCallsBefore = lastMileCalls;
  await mode3Tick({ now: NOW, orgs: ["busyco"], post: async () => (posts++, { ok: true }) as never, lastMile: spendingDeps });
  eq(lastMileCalls, armCallsBefore, "🔴 loop: a resumed tick does NOT re-run the last-mile arm — the once-guard holds");
  const resumed = await readAudit({ org: "busyco", action: "dream.mode3_report" });
  const kinds = resumed.map((r) => (r.detail?.["lastMile"] as Record<string, unknown> | undefined)?.["kind"]);
  eq(resumed.length, 2, "loop: the resumed tick writes its own digest row");
  eq([...kinds].sort(), ["not-reproduced", "skipped-resume"], "🔴 loop: …and the skipped resume is reported as its OWN outcome, never as a second fresh attempt");
  const skipLine = lastMileLine({ kind: "skipped-resume" });
  ok(!skipLine.includes("before it wrote anything"), "🔴 loop: the skipped-resume line NEVER claims nothing was written");
  ok(skipLine.includes("dream.mode3_last_mile"), "loop: …and points the reader at the audit rows that say what the earlier attempt did");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ dream-mode3-v2: ${passed} assertions passed`);
