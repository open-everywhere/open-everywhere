import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  classifyIngestion,
  INGESTION_KINDS,
  type IngestionKind,
  type IngestionSource,
} from "../agent/access/taint-tiers.js";
import {
  beginTaintDryRunTurn,
  noteIngestionDryRun,
  registerTaintDryRunSink,
  currentTaintDryRunSink,
  type TaintDryRunRow,
} from "../agent/access/taint-dryrun.js";
import { ingestUntrusted } from "../agent/access/untrusted.js";
import { untrustedIngestedThisTurn } from "../agent/access/taint-signal.js";
import { openTaintTurn } from "../agent/hooks/spawn-taint.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const tier = (src: IngestionSource) => classifyIngestion(src).tier;

console.log("1. the tier table, row by row:");

eq(tier({ kind: "chat-message" }), "trusted", "chat: a member-authored chat body never integrity-taints (external surfaces are classified by SURFACE trust one layer up, not here)");

for (const kind of ["notion", "linear"] as const) {
  eq(tier({ kind, workspaceTrust: "internal" }), "trusted", `${kind}: an INTERNAL bound workspace is org property — same trust basis as a private channel`);
  eq(tier({ kind, workspaceTrust: "public" }), "untrusted", `${kind}: a PUBLIC bound workspace is a stranger's typing surface`);
  ok(classifyIngestion({ kind }).assumed, `${kind}: an UNDECLARED workspace tier falls to the fail-closed default AND is marked assumed`);
  eq(tier({ kind }), "untrusted", `${kind}: …and that default is untrusted`);
}

eq(tier({ kind: "github", repoPrivate: true }), "trusted", "github: a PRIVATE org repo — issues, reviews and diffs are org-authored");
eq(tier({ kind: "github", repoPrivate: false }), "untrusted", "github: a PUBLIC repo takes PR bodies/reviews/diffs from anyone with a fork");
ok(classifyIngestion({ kind: "github" }).assumed, "github: an unreadable `private` flag is fail-closed AND marked assumed");

eq(tier({ kind: "connector", grantTrust: "internal" }), "trusted", "connector: the GRANT declares `trust: internal` in reviewed bundle config");
eq(tier({ kind: "connector", grantTrust: "public" }), "untrusted", "connector: the grant declares `trust: public`");
{
  const silent = classifyIngestion({ kind: "connector" });
  eq(silent.tier, "untrusted", "connector: a grant that declares NOTHING defaults public/untrusted (the ruled default)");
  ok(silent.assumed, "connector: …and the default is MARKED assumed — silence in config must never read as an assurance");
}

eq(tier({ kind: "web" }), "untrusted", "web: no bound instance, no membership, nothing that could make it internal");
eq(tier({ kind: "webhook" }), "untrusted", "webhook: authored by whoever can reach the endpoint");
eq(tier({ kind: "routine-event" }), "untrusted", "routine-event: the hydrated entity an outside party's action produced");
eq(tier({ kind: "delegation-result" }), "untrusted", "delegation-result: the table DEFERS to the OPE-298 return stamp and does not try to out-guess a worker about what it read");

{
  const img = classifyIngestion({ kind: "image-description" });
  eq(img.tier, "untrusted", "image-description: always untrusted regardless of who posted the image (⚠ the flagged exception)");
  ok(img.reason.includes("FLAGGED"), "image-description: the reason carries the pending-review flag, so a LOG ROW shows it without reading the table");

  const upload = classifyIngestion({ kind: "file-upload" });
  eq(upload.tier, "untrusted", "file-upload: ALWAYS untrusted (the maintainer's ruling: authorship ≠ provenance — the author rule that trusted member uploads is superseded)");
  eq(upload.assumed, false, "file-upload: a POSITIVE metadata-free ruling, never `assumed` — no uploader identity is needed, so the read_file_upload seam's verdicts are exact");
  ok(!upload.reason.includes("FLAGGED"), "file-upload: the pending-review flag is GONE — the row is ruled, not provisional");
}

{
  const aws = classifyIngestion({ kind: "aws", label: "aws" });
  eq(aws.tier, "untrusted", "aws: the `aws` CLI's own output is untrusted — an AWS account is a SUBSTRATE, not an authoring surface, so org ownership says nothing about who wrote the log line");
  eq(aws.assumed, false, "🔴 aws: …and that is a POSITIVE ruling, not the fail-closed default wearing a row's clothes — nothing absent could have decided it otherwise");
  eq(
    classifyIngestion({ kind: "aws", workspaceTrust: "internal", repoPrivate: true, grantTrust: "internal" }).tier,
    "untrusted",
    "aws: NO metadata branch — no field declared for another row can flip it (a per-service or per-account branch OE cannot decide correctly would be false precision)",
  );
}

for (const kind of INGESTION_KINDS) {
  const v = classifyIngestion({ kind: kind as IngestionKind });
  ok(v.tier === "trusted" || v.tier === "untrusted", `every kind resolves to a tier — "${kind}"`);
  ok(typeof v.reason === "string" && v.reason.length > 0, `every kind carries prose reasoning — "${kind}"`);
}
eq(INGESTION_KINDS.length, 12, "the table has exactly the 12 ruled kinds (a 13th means a design decision, not a drive-by add — the 12th, `aws`, was one: OPE-305)");

console.log("2. the dry run:");

class FakeSession {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}
function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

const rows: TaintDryRunRow[] = [];
const restore = currentTaintDryRunSink();
registerTaintDryRunSink((r) => rows.push(r));

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  const out = ingestUntrusted("hello from a colleague", { source: "read_channel:slack", ingestion: { kind: "chat-message", label: "read_channel:slack" } });
  ok(untrustedIngestedThisTurn() === true, "🔴 THE DRY RUN CHANGES NOTHING: ingestUntrusted STILL taints over a source the table calls trusted");
  ok(out.includes("hello from a colleague"), "…and still fences the content (the funnel is untouched)");
  eq(rows.length, 1, "one over-taint row");
  eq(rows[0].divergence, "over-taint", "…classified as over-taint (enforcement would RELAX here)");
  eq(rows[0].taintsToday, true, "row records what the SITE does today");
  eq(rows[0].tableTier, "trusted", "row records what the TABLE would do");
  eq(rows[0].label, "read_channel:slack", "row carries the site's taint-clean label");
  ok(!JSON.stringify(rows[0]).includes("hello from a colleague"), "🔴 the row carries NO ingested content — names, tiers and reasons only");

  for (let i = 0; i < 40; i++) ingestUntrusted(`msg ${i}`, { ingestion: { kind: "chat-message" } });
  eq(rows.length, 1, "40 further reads of the same kind in one turn add NO rows (per-turn dedupe on (kind, divergence))");

  ingestUntrusted("some page", { ingestion: { kind: "notion", label: "read_notion_page" } });
  eq(rows.length, 2, "a different kind in the same turn logs its own row");
  eq(rows[1].divergence, "assumed", "notion with no declared workspace tier: site and table AGREE (both untrusted) but only via the fail-closed default — logged as `assumed`");
  ok(rows[1].assumed, "…and the row says so explicitly");
});

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  noteIngestionDryRun({ kind: "github", repoPrivate: false, label: "walk_pr" }, false);
  eq(rows.length, 1, "a fence-only site over a PUBLIC repo logs a row");
  eq(rows[0].divergence, "under-taint", "…classified as under-taint (enforcement would TIGHTEN here — a live gap until it does)");
  eq(rows[0].taintsToday, false, "row records that the site does NOT taint today");
  ok(untrustedIngestedThisTurn() === false, "…and noting it does NOT taint the turn — the dry run only observes");
});

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  ingestUntrusted("a page", { ingestion: { kind: "notion", workspaceTrust: "public" } });
  ingestUntrusted("a page", { ingestion: { kind: "web" } });
  noteIngestionDryRun({ kind: "chat-message" }, false);
  eq(rows.length, 0, "site and table agreeing on REAL metadata writes nothing (in either direction)");
});

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  ingestUntrusted("anything", { source: "not wired yet" });
  eq(rows.length, 0, "an un-wired site logs nothing (absent descriptor ⇒ absent from the dry run)");
  ok(untrustedIngestedThisTurn() === true, "…and still taints exactly as before");
});

await eveContextStorage().run(new FakeSession(), async () => {
  registerTaintDryRunSink(() => {
    throw new Error("sink exploded");
  });
  const out = ingestUntrusted("content", { ingestion: { kind: "chat-message" } });
  ok(out.includes("content"), "a THROWING sink never propagates — the ingestion returns normally");
  ok(untrustedIngestedThisTurn() === true, "…and the taint still landed");
});

console.log("3. per-TURN, not per-session:");

registerTaintDryRunSink((r) => rows.push(r));

const boundary = (turnId: string | undefined) =>
  openTaintTurn({ session: { turn: { id: turnId }, auth: { current: { attributes: {} } } } } as unknown as Parameters<typeof openTaintTurn>[0]);

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;

  boundary("turn-1");
  ingestUntrusted("a colleague's message", { ingestion: { kind: "chat-message", label: "read_channel:slack" } });
  ingestUntrusted("another one", { ingestion: { kind: "chat-message", label: "read_channel:slack" } });
  eq(rows.length, 1, "turn 1: two reads of the same kind write ONE row (the dedupe still dedupes)");

  boundary("turn-2");
  ingestUntrusted("a message in the next turn", { ingestion: { kind: "chat-message", label: "read_channel:slack" } });
  eq(rows.length, 2, "🔴 THE HEADLINE: the SAME (kind, divergence) in the NEXT turn of the SAME session logs AGAIN — the memo is per turn, not per session (OPE-331)");
  eq(rows[1].divergence, "over-taint", "…and it is the same divergence, not a different row shape");

  boundary("turn-2");
  ingestUntrusted("yet another", { ingestion: { kind: "chat-message" } });
  eq(rows.length, 2, "the SAME turn id seen twice does NOT re-open the memo — the reset is keyed, not unconditional");

  boundary(undefined);
  ingestUntrusted("after an unreadable boundary", { ingestion: { kind: "chat-message" } });
  eq(rows.length, 3, "an UNREADABLE turn id CLEARS the memo — the observer's safe failure is to write the row, the opposite arm from the taint signal's");
});

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  beginTaintDryRunTurn("t1");
  noteIngestionDryRun({ kind: "github", repoPrivate: false, label: "walk_pr" }, false);
  noteIngestionDryRun({ kind: "github", repoPrivate: false, label: "walk_pr" }, false);
  eq(rows.length, 1, "under-taint rows dedupe within a turn too");
  beginTaintDryRunTurn("t2");
  noteIngestionDryRun({ kind: "github", repoPrivate: false, label: "walk_pr" }, false);
  eq(rows.length, 2, "…and a new turn re-opens them (beginTaintDryRunTurn is the whole boundary)");
});

beginTaintDryRunTurn("no-context");
ok(true, "beginTaintDryRunTurn outside a session context is a silent no-op, never a throw");

registerTaintDryRunSink(restore);
ok(currentTaintDryRunSink() === restore, "the sink is restorable (test seam behaves)");

console.log(`✓ taint-tiers: ${n} assertions passed`);
