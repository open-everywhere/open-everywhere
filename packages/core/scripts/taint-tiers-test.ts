import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  classifyIngestion,
  INGESTION_KINDS,
  type IngestionKind,
  type IngestionSource,
} from "../agent/access/taint-tiers.js";
import {
  beginTaintVerdictTurn,
  decideIngestion,
  noteIngestionVerdict,
  registerTaintVerdictSink,
  currentTaintVerdictSink,
  taintTierMode,
  type TaintVerdictRow,
} from "../agent/access/taint-enforcement.js";
import { ingestUntrusted, UNTRUSTED_OPEN } from "../agent/access/untrusted.js";
import { untrustedIngestedThisTurn } from "../agent/access/taint-signal.js";
import { openTaintTurn } from "../agent/hooks/spawn-taint.js";
import { renderWakeEnvelope } from "../agent/channels/wake-envelope.js";
import { renderContext } from "../agent/channels/context-render.js";
import { formatTaskResultDelta } from "../agent/access/task-result-delta.js";
import { subscribePrPrompt } from "../agent/tools/subscribe_pr.js";
import { renderPrFeedbackForModel } from "../agent/scm/pr-feedback.js";
import { declaredWorkspaceTrust, defineSurface, registerSurfaces, _resetSurfacesForTest } from "../agent/identity/trust.js";
import { resolveAccess } from "../agent/access/resolver.js";
import type { Binding, Bundle } from "../agent/access/bundle.js";
import { setConnectorContentOrigin, declaredContentOriginForConnection, declaredContentOriginForToolName } from "../agent/access/connector-content-origin-state.js";

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

eq(tier({ kind: "connector", grantContentOrigin: "internal" }), "trusted", "connector: the GRANT declares `contentOrigin: internal` in reviewed bundle config");
eq(tier({ kind: "connector", grantContentOrigin: "external" }), "untrusted", "connector: the grant declares `contentOrigin: external`");
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
  eq(img.tier, "untrusted", "image-description: always untrusted regardless of who posted the image (the ratified exception to the instance-binary rule)");
  ok(!img.reason.includes("FLAGGED") && !img.reason.includes("pending"), "image-description: the pending-review flag is GONE — the row is ratified, not provisional");
  ok(img.reason.includes("ratified"), "image-description: the reason SAYS ratified, so a LOG ROW shows the exception is deliberate without reading the table");

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
    classifyIngestion({ kind: "aws", workspaceTrust: "internal", repoPrivate: true, grantContentOrigin: "internal" }).tier,
    "untrusted",
    "aws: NO metadata branch — no field declared for another row can flip it (a per-service or per-account branch OE cannot decide correctly would be false precision)",
  );
}

{
  const handoff = classifyIngestion({ kind: "handoff" });
  eq(handoff.tier, "trusted", "handoff: the same governed seat's own distilled prose (previous generation) is TRUSTED — taint, if any, was marked at original ingestion (ratified 2026-08-08, OPE-340)");
  eq(handoff.assumed, false, "handoff: a POSITIVE ruling — no metadata is needed to decide the seat's own shift note");
}

{
  const skill = classifyIngestion({ kind: "skill-declared", label: "support-desk" });
  eq(skill.tier, "untrusted", "skill-declared: a sandbox script's self-declared external fetch is unconditionally untrusted");
  eq(skill.assumed, false, "🔴 skill-declared: a POSITIVE ruling, never `assumed` — no metadata is consulted, so none can be absent");
  eq(
    classifyIngestion({ kind: "skill-declared", workspaceTrust: "internal", repoPrivate: true, grantContentOrigin: "internal" }).tier,
    "untrusted",
    "🔴 skill-declared: NO metadata branch — setting every trusting field another row reads does NOT make a sandbox-emitted envelope trusted (the whole add-taint-only property)",
  );
}

for (const kind of INGESTION_KINDS) {
  const v = classifyIngestion({ kind: kind as IngestionKind });
  ok(v.tier === "trusted" || v.tier === "untrusted", `every kind resolves to a tier — "${kind}"`);
  ok(typeof v.reason === "string" && v.reason.length > 0, `every kind carries prose reasoning — "${kind}"`);
}
eq(INGESTION_KINDS.length, 14, "the table has exactly the 14 ruled kinds (a 15th means a design decision, not a drive-by add — the 12th `aws` was OPE-305; the 13th `handoff` OPE-340; the 14th `skill-declared` OPE-361)");

console.log("2. the enforced seam:");

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

const rows: TaintVerdictRow[] = [];
const restore = currentTaintVerdictSink();
registerTaintVerdictSink((r) => rows.push(r));

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  const out = ingestUntrusted("hello from a colleague", { source: "read_channel:slack", ingestion: { kind: "chat-message", label: "read_channel:slack" } });
  ok(untrustedIngestedThisTurn() === false, "🔴 THE TABLE DECIDES (OPE-324): ingestUntrusted over a source the table calls TRUSTED does NOT taint the turn");
  ok(out.includes("hello from a colleague"), "…and STILL fences the content — the wrap half is unconditional, only the mark is the table's call");
  ok(out.includes(UNTRUSTED_OPEN), "…inside the real envelope, not a weakened one");
  eq(rows.length, 1, "one over-taint row");
  eq(rows[0].divergence, "over-taint", "…classified as over-taint (enforcement RELAXED here)");
  eq(rows[0].mode, "enforced", "…in `enforced` mode — the row says which world wrote it, so the kill switch is queryable");
  eq(rows[0].applied, true, "🔴 …and `applied: true`, which is what distinguishes 'the mark was dropped' from 'the table merely disagreed'");
  eq(rows[0].taintsToday, true, "row records what the SITE's own pre-flip call did");
  eq(rows[0].tableTier, "trusted", "row records what the TABLE says");
  eq(rows[0].label, "read_channel:slack", "row carries the site's taint-clean label");
  ok(!JSON.stringify(rows[0]).includes("hello from a colleague"), "🔴 the row carries NO ingested content — names, tiers and reasons only");

  for (let i = 0; i < 40; i++) ingestUntrusted(`msg ${i}`, { ingestion: { kind: "chat-message" } });
  eq(rows.length, 1, "40 further reads of the same kind in one turn add NO rows (per-turn dedupe on (kind, divergence))");
  ok(untrustedIngestedThisTurn() === false, "🔴 …and the 40 deduped reads did not taint either — the dedupe suppresses ROWS, never DECISIONS");

  ingestUntrusted("some page", { ingestion: { kind: "notion", label: "read_notion_page" } });
  eq(rows.length, 2, "a different kind in the same turn logs its own row");
  eq(rows[1].divergence, "assumed", "notion with no declared workspace tier: site and table AGREE (both untrusted) but only via the fail-closed default — logged as `assumed`");
  ok(rows[1].assumed, "…and the row says so explicitly");
  ok(untrustedIngestedThisTurn() === true, "🔴 …and the `assumed` verdict DECIDES: an unvouched Notion workspace still taints — fail-closed survived the flip");
});

await eveContextStorage().run(new FakeSession(), async () => {
  ingestUntrusted("a page", { ingestion: { kind: "notion", workspaceTrust: "internal" } });
  ok(untrustedIngestedThisTurn() === false, "a VOUCHED-internal Notion workspace read does not taint (ratified 2026-08-09)");
});
await eveContextStorage().run(new FakeSession(), async () => {
  ingestUntrusted("an issue", { ingestion: { kind: "linear", workspaceTrust: "internal" } });
  ok(untrustedIngestedThisTurn() === false, "a VOUCHED-internal Linear workspace read does not taint (ratified 2026-08-09)");
});
await eveContextStorage().run(new FakeSession(), async () => {
  ingestUntrusted("a review body", { ingestion: { kind: "github", repoPrivate: true } });
  ok(untrustedIngestedThisTurn() === false, "a PRIVATE org repo's PR feedback does not taint — org-authored bytes");
});
await eveContextStorage().run(new FakeSession(), async () => {
  ingestUntrusted("a connector result", { ingestion: { kind: "connector", grantContentOrigin: "internal" } });
  ok(untrustedIngestedThisTurn() === false, "a connector whose GRANT declares `contentOrigin: internal` does not taint — the reviewed-config branch, now with teeth");
});
for (const [label, src] of [
  ["a PUBLIC repo", { kind: "github", repoPrivate: false }],
  ["a PUBLIC notion workspace", { kind: "notion", workspaceTrust: "public" }],
  ["an UNDECLARED connector", { kind: "connector" }],
  ["the open web", { kind: "web" }],
  ["a webhook payload", { kind: "webhook" }],
  ["a file upload", { kind: "file-upload" }],
  ["an image description", { kind: "image-description" }],
  ["aws CLI output", { kind: "aws" }],
] as const satisfies readonly (readonly [string, IngestionSource])[]) {
  await eveContextStorage().run(new FakeSession(), async () => {
    ingestUntrusted("content", { ingestion: src });
    ok(untrustedIngestedThisTurn() === true, `${label} STILL taints — enforcement only ever relaxes, and these rows say untrusted`);
  });
}

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  noteIngestionVerdict({ kind: "github", repoPrivate: false, label: "walk_pr" }, false);
  eq(rows.length, 1, "a fence-only site over a PUBLIC repo logs a row");
  eq(rows[0].divergence, "under-taint", "…classified as under-taint — enforcement WOULD tighten here and deliberately does not");
  eq(rows[0].taintsToday, false, "row records that the site does NOT taint");
  eq(rows[0].applied, false, "🔴 …and `applied: false` — the table OBSERVED this site, it did not decide it. That field is the whole difference from an over-taint row");
  ok(untrustedIngestedThisTurn() === false, "…and noting it does NOT taint the turn — an observation never marks");
});

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  ingestUntrusted("a page", { ingestion: { kind: "notion", workspaceTrust: "public" } });
  ingestUntrusted("a page", { ingestion: { kind: "web" } });
  noteIngestionVerdict({ kind: "chat-message" }, false);
  eq(rows.length, 0, "site and table agreeing on REAL metadata writes nothing (in either direction)");
});

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  ingestUntrusted("anything", { source: "not wired yet" });
  eq(rows.length, 0, "an un-wired site logs nothing (absent descriptor ⇒ absent from the table)");
  ok(untrustedIngestedThisTurn() === true, "🔴 …and STILL taints unconditionally — an undeclared site is UNGOVERNED, never quietly trusted");
});

await eveContextStorage().run(new FakeSession(), async () => {
  registerTaintVerdictSink(() => {
    throw new Error("sink exploded");
  });
  const out = ingestUntrusted("content", { ingestion: { kind: "chat-message" } });
  ok(out.includes("content"), "a THROWING sink never propagates — the ingestion returns normally");
  ok(untrustedIngestedThisTurn() === false, "🔴 …and the table's TRUSTED verdict still held: an exploding LOG cannot resurrect a mark the table dropped");
});
await eveContextStorage().run(new FakeSession(), async () => {
  registerTaintVerdictSink(() => {
    throw new Error("sink exploded");
  });
  ingestUntrusted("content", { ingestion: { kind: "web" } });
  ok(untrustedIngestedThisTurn() === true, "…and an exploding log cannot drop a mark the table REQUIRED either");
});
registerTaintVerdictSink((r) => rows.push(r));

{
  const shapes: readonly IngestionSource[] = [
    ...INGESTION_KINDS.map((kind) => ({ kind }) as IngestionSource),
    { kind: "github", repoPrivate: true },
    { kind: "github", repoPrivate: false },
    { kind: "notion", workspaceTrust: "internal" },
    { kind: "notion", workspaceTrust: "public" },
    { kind: "linear", workspaceTrust: "internal" },
    { kind: "linear", workspaceTrust: "public" },
    { kind: "connector", grantContentOrigin: "internal" },
    { kind: "connector", grantContentOrigin: "external" },
  ];
  const tightened = shapes.filter((s) => decideIngestion(s, false));
  eq(tightened, [], "🔴 NO SHAPE TIGHTENS: decideIngestion(src, false) is false for every kind and every metadata branch — enforcement can only ever REMOVE a mark the site would have set");
  const relaxedWhenTrusted = shapes.filter((s) => classifyIngestion(s).tier === "trusted" && decideIngestion(s, true));
  eq(relaxedWhenTrusted, [], "every TRUSTED verdict drops the mark at a tainting site");
  const keptWhenUntrusted = shapes.filter((s) => classifyIngestion(s).tier === "untrusted" && !decideIngestion(s, true));
  eq(keptWhenUntrusted, [], "every UNTRUSTED verdict keeps it");
}

{
  const prior = process.env.OE_TAINT_TIERS;
  const withMode = async (v: string | undefined, fn: () => Promise<void> | void) => {
    if (v === undefined) delete process.env.OE_TAINT_TIERS;
    else process.env.OE_TAINT_TIERS = v;
    await fn();
  };

  await withMode(undefined, () => eq(taintTierMode(), "enforced", "UNSET ⇒ enforced — the flip's default is the absence of configuration"));
  await withMode("enforce", () => eq(taintTierMode(), "enforced", "`enforce` ⇒ enforced"));
  await withMode("ENFORCED", () => eq(taintTierMode(), "enforced", "`ENFORCED` ⇒ enforced (case-insensitive, and both spellings accepted so a plausible variant cannot silently disarm the flip)"));
  await withMode("dryrun", () => eq(taintTierMode(), "dryrun", "`dryrun` ⇒ dryrun — the documented revert"));
  await withMode("1", () => eq(taintTierMode(), "dryrun", "🔴 an UNRECOGNISED value ⇒ dryrun — the OLD, over-tainting behaviour. A typo may only ever fail toward more marking"));
  await withMode("  ", () => eq(taintTierMode(), "enforced", "whitespace-only reads as unset, not as a value"));

  await withMode("dryrun", async () => {
    await eveContextStorage().run(new FakeSession(), async () => {
      rows.length = 0;
      ingestUntrusted("hello", { source: "read_channel:slack", ingestion: { kind: "chat-message", label: "read_channel:slack" } });
      ok(untrustedIngestedThisTurn() === true, "🔴 KILL SWITCH: with OE_TAINT_TIERS=dryrun a chat read TAINTS AGAIN — the pre-flip site behaviour, restored without a redeploy");
      eq(rows.length, 1, "…and the row still lands, so the log does not go dark when the switch is thrown");
      eq(rows[0].mode, "dryrun", "…stamped `mode: dryrun`, which is how an audit reader tells a disarmed deployment from an enforcing one");
      eq(rows[0].applied, false, "…and `applied: false`: in dryrun the table never decides");
    });
    eq(INGESTION_KINDS.filter((kind) => decideIngestion({ kind }, false)), [], "dryrun cannot tighten either: a fence-only site still does not taint");
  });

  if (prior === undefined) delete process.env.OE_TAINT_TIERS;
  else process.env.OE_TAINT_TIERS = prior;
  eq(taintTierMode(), "enforced", "the switch is restored to the enforcing default for the rest of the suite");
}

console.log("3. per-TURN, not per-session:");

registerTaintVerdictSink((r) => rows.push(r));

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
  beginTaintVerdictTurn("t1");
  noteIngestionVerdict({ kind: "github", repoPrivate: false, label: "walk_pr" }, false);
  noteIngestionVerdict({ kind: "github", repoPrivate: false, label: "walk_pr" }, false);
  eq(rows.length, 1, "under-taint rows dedupe within a turn too");
  beginTaintVerdictTurn("t2");
  noteIngestionVerdict({ kind: "github", repoPrivate: false, label: "walk_pr" }, false);
  eq(rows.length, 2, "…and a new turn re-opens them (beginTaintVerdictTurn is the whole boundary)");
});

beginTaintVerdictTurn("no-context");
ok(true, "beginTaintVerdictTurn outside a session context is a silent no-op, never a throw");

console.log("4. the declared sites:");

registerTaintVerdictSink((r) => rows.push(r));

const wakeFixture = {
  reason: "mention",
  currentTime: "2026-08-08T10:00:00Z",
  sourcePlatform: "slack",
  channel: { id: "C1", type: "channel" },
  messages: [
    { from: "human", author: "Ada", id: "1", sentAt: "2026-08-08T09:59:00Z", trust: "peer", body: "earlier chatter" },
    { from: "human", author: "Ada", id: "2", sentAt: "2026-08-08T10:00:00Z", trust: "peer", trigger: true, body: "hey agent" },
  ],
} as const satisfies Parameters<typeof renderWakeEnvelope>[0];

{
  rows.length = 0;
  const envelope = renderWakeEnvelope(wakeFixture);
  ok(envelope.includes("hey agent"), "the wake envelope still renders its message bodies");
  ok(envelope.includes(UNTRUSTED_OPEN), "…still inside the untrusted fence (the wrap half is untouched)");
  const ctxBlock = renderContext([{ senderType: "user", senderId: "U1", ts: "1", text: "what's the status?" }], "slack");
  ok(ctxBlock !== null && ctxBlock.includes("what's the status?"), "renderContext still renders + fences the backscroll");
  eq(rows.length, 0, "🔴 a render with NO session context (the ingress shape) writes NO rows — the taint mark does not land, so the site agrees with the trusted chat-message row");
}

{
  rows.length = 0;
  const envelope = renderWakeEnvelope({ ...wakeFixture, handoff: { note: "OPEN: deploy sign-off pending (U3)", fromGeneration: 4 } });
  ok(envelope.includes("OPEN: deploy sign-off pending (U3)"), "the handoff note renders in the envelope");
  ok(envelope.includes('<handoff-note from-generation="4">'), "…inside its provenance-labelled element");
  const noteBlock = envelope.slice(envelope.indexOf("<handoff-note"), envelope.indexOf("</handoff-note>"));
  ok(!noteBlock.includes(UNTRUSTED_OPEN), "🔴 the note is NOT untrusted-fenced — the seat's own shift note is not a stranger's typing (the pre-OPE-340 wrap is gone)");
  eq(rows.filter((r) => r.label === "wake-envelope:handoff").length, 0, "no session context: site doesn't taint, row is trusted — agreement, no row");
}
await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  renderWakeEnvelope({ ...wakeFixture, handoff: { note: "OPEN: deploy sign-off pending (U3)", fromGeneration: 4 } });
  eq(rows.filter((r) => r.label === "wake-envelope:handoff").length, 0, "…and IN a session context the handoff site still writes no row — it genuinely does not taint, unlike the message renders beside it");
});

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  renderWakeEnvelope(wakeFixture);
  ok(untrustedIngestedThisTurn() === true, "given a session context, the render's taint half DOES land — the 'ingress only' comment is a claim about the caller, not a property of the code");
  eq(rows.length, 1, "…and the declaration REPORTS it rather than restating the comment");
  eq(rows[0].divergence, "over-taint", "…as an over-taint row: the site tainted, the table calls chat-message trusted");
  eq(rows[0].label, "wake-envelope:slack", "…labelled by site");
});

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  const block = formatTaskResultDelta([{ taskId: "t-1", resultJson: JSON.stringify({ summary: "worker prose" }), createdAt: "2026-08-08T09:00:00Z" }], 0);
  ok(block !== null && block.includes("worker prose"), "the recovery reminder still carries the worker's snippet");
  ok(block !== null && block.includes(UNTRUSTED_OPEN), "…still fenced");
  eq(rows.length, 0, "delegation-result agrees with the table (both untrusted) ⇒ silent");
});

await eveContextStorage().run(new FakeSession(), async () => {
  rows.length = 0;
  const prompt = subscribePrPrompt({
    repo: "org/repo",
    number: 7,
    url: "https://github.com/org/repo/pull/7",
    baseline: "open",
    title: "fix: a title",
    fingerprint: "fp",
    intervalMinutes: 15,
    checksRemaining: 3,
  });
  ok(prompt.includes("fix: a title"), "the armed prompt still carries the fenced title");
  ok(prompt.includes(UNTRUSTED_OPEN), "…still fenced (wrapUntrusted, unchanged)");
  eq(rows.length, 1, "subscribe_pr's title logs ONE row");
  eq(rows[0].divergence, "under-taint", "…an UNDER-TAINT: the site fences without tainting and the table says untrusted — a real gap, not quiet agreement like the render sites");
  ok(rows[0].assumed, "…reached via the fail-closed default, because no `repoPrivate` is available at this pure prompt-builder seam");
  eq(rows[0].label, "subscribe_pr:title", "…labelled by SITE, not by repo — the row is names only");
  ok(untrustedIngestedThisTurn() === false, "🔴 …and noting it did NOT start tainting the arming turn");
});

{
  eq(tier({ kind: "web", label: "web_fetch" }), "untrusted", "web_fetch declares `web` — untrusted, agreeing with what the tool already does");
  eq(classifyIngestion({ kind: "web" }).assumed, false, "…and NOT assumed: the open web needs no metadata to decide");
  eq(tier({ kind: "webhook", label: "list_recent_events" }), "untrusted", "list_recent_events declares `webhook` — a stored delivery is still a delivery");
  eq(tier({ kind: "webhook", label: "read_webhook_history" }), "untrusted", "read_webhook_history declares `webhook` — same kind as the live dispatch path");
  eq(tier({ kind: "routine-event", label: "read_routine_transcript" }), "untrusted", "read_routine_transcript declares `routine-event` — the loosest fit in the sweep, and every candidate kind agrees on the verdict");
  eq(tier({ kind: "delegation-result", label: "task_result" }), "untrusted", "task_result declares `delegation-result` — the row that was dead code before this");
  eq(tier({ kind: "chat-message", label: "wake-envelope:slack" }), "trusted", "the render-time chat sites declare `chat-message` — TRUSTED, which is why `taintsToday: false` is silence and not a divergence");
}

console.log("5. the plumbed metadata:");

{
  const digest = (repoPrivate?: boolean) => ({
    repo: "org/repo",
    number: 7,
    reviews: [{ author: "ada", state: "CHANGES_REQUESTED", body: "please fix the fence" }],
    reviewComments: [],
    issueComments: [],
    checks: [],
    checksSummary: { total: 0, byConclusion: {}, failing: [], failingTruncated: false, pending: 0 },
    truncation: { truncated: false, reviewsDropped: 0, reviewCommentsDropped: 0, issueCommentsDropped: 0, checksDropped: 0, bodiesClipped: 0, maxBodyChars: 4000 },
    ...(repoPrivate !== undefined ? { repoPrivate } : {}),
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    rows.length = 0;
    const text = renderPrFeedbackForModel(digest(true));
    ok(text.includes("please fix the fence"), "the digest still renders + fences every third-party body");
    eq(rows.length, 1, "a private repo logs one row");
    eq(rows[0].divergence, "over-taint", "…OVER-taint: the table calls a private org repo trusted while get_pr_feedback's pre-flip call tainted");
    eq(rows[0].assumed, false, "🔴 …and it is NOT `assumed` any more — `base.repo.private` rides the PR object fetchPrFeedback already GETs, so the old 'that would need an extra API call' premise was simply wrong");
    eq(rows[0].applied, true, "…and the table DECIDED here (OPE-324): this is an in-turn read tool, not a render-time observer");
    ok(untrustedIngestedThisTurn() === false, "🔴 …so reading a PRIVATE repo's review bodies no longer taints the turn — the plumbed fact is what makes that verdict real rather than assumed");
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    rows.length = 0;
    renderPrFeedbackForModel(digest(false));
    eq(rows.length, 0, "a PUBLIC repo agrees with the site (both untrusted) on REAL metadata ⇒ silent — before the plumbing this same read logged an `assumed` row");
    ok(untrustedIngestedThisTurn() === true, "…and it still TAINTS: a public repo's review bodies can be authored by anyone with a fork, and the flip changed nothing there");
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    rows.length = 0;
    renderPrFeedbackForModel(digest(undefined));
    eq(rows.length, 1, "an ABSENT visibility still logs");
    ok(rows[0].assumed, "…and is still marked `assumed` — the fail-closed default is untouched, it is just no longer the ONLY answer this seam can give");
    ok(untrustedIngestedThisTurn() === true, "🔴 …and the fail-closed verdict DECIDES: unreadable visibility ⇒ the read taints. `assumed` never resolves upward");
  });
}

{
  _resetSurfacesForTest();
  eq(declaredWorkspaceTrust("notion/ws1"), undefined, "unvouched ⇒ undefined, so the table stays fail-closed AND marked `assumed`");
  registerSurfaces([defineSurface({ key: "notion/ws1", trust: "internal" })]);
  eq(declaredWorkspaceTrust("notion/ws1"), "internal", "a WORKSPACE vouch declares the bound workspace internal");
  _resetSurfacesForTest();
  registerSurfaces([defineSurface({ key: "notion/ws1/page-a", trust: "internal" })]);
  eq(
    declaredWorkspaceTrust("notion/ws1"),
    undefined,
    "🔴 a SURFACE-level vouch does NOT make the workspace internal — the table asks about the bound WORKSPACE, and a read tool routinely reads a different page from the one the session sits on, so borrowing a surface vouch would answer about the wrong instance",
  );
  _resetSurfacesForTest();
  eq(tier({ kind: "notion", workspaceTrust: declaredWorkspaceTrust("notion/ws1") }), "untrusted", "…and an undefined tier flows into the table as the fail-closed answer, unchanged");
}

console.log("6. connector grantContentOrigin, end to end:");
{
  const bundles: Bundle[] = [
    { name: "vouched", connectors: [{ name: "notion", contentOrigin: "internal" }] },
    { name: "silent", connectors: ["linear-mcp"] },
    { name: "declared-external", connectors: [{ name: "acme-forms", contentOrigin: "external" }] },
  ];
  const bindings: Binding[] = [
    { bundle: "vouched", scope: { level: "domain", domain: "d" } },
    { bundle: "silent", scope: { level: "domain", domain: "d" } },
    { bundle: "declared-external", scope: { level: "domain", domain: "d" } },
  ];
  const access = resolveAccess(
    { mode: "channel", platform: "slack", workspace: "T1", channel: "C1", domains: ["d"] },
    bundles,
    bindings,
  );

  eq(declaredContentOriginForConnection("notion"), undefined, "with NOTHING stamped (no eve context) the declaration is undefined — fail-closed, and setConnectorContentOrigin below is what changes that");

  await eveContextStorage().run(new FakeSession(), async () => {
    setConnectorContentOrigin(access.connectorContentOrigin);

    eq(declaredContentOriginForConnection("notion"), "internal", "the resolved declaration reaches the seam through the session stamp");
    eq(declaredContentOriginForToolName("notion__search"), "internal", "…and resolves from the eve-mounted `<connection>__<tool>` name the projection seam actually holds");
    const declared = classifyIngestion({ kind: "connector", label: "notion__search", grantContentOrigin: declaredContentOriginForToolName("notion__search") });
    eq(declared.tier, "trusted", "🔴 a connector whose grant declares `contentOrigin: internal` classifies TRUSTED — the row's config branch is reachable for the first time");
    eq(declared.assumed, false, "…and NOT `assumed`: the verdict came from a declaration, not from the fail-closed default");

    eq(declaredContentOriginForToolName("linear-mcp__issues"), undefined, "a BARE grant declares nothing — the stamp has no key for it");
    const silent = classifyIngestion({ kind: "connector", label: "linear-mcp__issues", grantContentOrigin: declaredContentOriginForToolName("linear-mcp__issues") });
    eq(silent.tier, "untrusted", "…so it still falls to the ruled default (external/untrusted), unchanged");
    ok(silent.assumed, "…and is still MARKED assumed — which is what lets the log say 'this deployment never declared' rather than 'this deployment declared external'");

    const externalDecl = classifyIngestion({ kind: "connector", label: "acme-forms__submit", grantContentOrigin: declaredContentOriginForToolName("acme-forms__submit") });
    eq(externalDecl.tier, "untrusted", "a declared `contentOrigin: external` connector is untrusted");
    eq(externalDecl.assumed, false, "🔴 …but NOT assumed — same tier as silence, different claim, and only the log can tell them apart");

    eq(declaredContentOriginForToolName("acme-forms__submit"), "external", "each connector answers with its OWN bundle's declaration");
    eq(declaredContentOriginForConnection("something-ungranted"), undefined, "an unknown connection name is undefined, never the map's first/any value");
    eq(declaredContentOriginForToolName("connection_search"), undefined, "🔴 `connection_search` matches NO declaration — its result aggregates several connections, so no single grant may speak for it");
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    eq(declaredContentOriginForConnection("notion"), undefined, "a SECOND session carries no declaration from the first — the carriage is a per-session slot, not a module global");
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    setConnectorContentOrigin({ acme: "internal", "acme__search": "external" });
    eq(declaredContentOriginForToolName("acme__search__query"), "external", "🔴 LONGEST declared prefix wins — a plugin connector named `acme__search` keeps its own declaration instead of inheriting `acme`'s");
    eq(declaredContentOriginForToolName("acme__list"), "internal", "…and a tool that really does belong to `acme` still resolves `acme`'s declaration");
    eq(declaredContentOriginForToolName("acmelike__x"), undefined, "the match requires the `__` separator — a name that merely starts with the same letters is not the same connection");
  });
}

console.log("6b. per-tool content-origin overrides:");
{
  await eveContextStorage().run(new FakeSession(), async () => {
    setConnectorContentOrigin({ helpdesk: "internal" });
    eq(declaredContentOriginForToolName("helpdesk__anything"), "internal", "(a) a SCALAR `internal` answers for every tool on the connection, unchanged");
    eq(classifyIngestion({ kind: "connector", grantContentOrigin: declaredContentOriginForToolName("helpdesk__anything") }).tier, "trusted", "…and still classifies trusted through the table");
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    setConnectorContentOrigin({ helpdesk: { default: "internal", except: { search_tickets: "external" } } });
    eq(declaredContentOriginForToolName("helpdesk__search_tickets"), "external", "(b) the EXCEPTED tool takes the override — a support-desk search returns bytes strangers typed");
    const tainting = classifyIngestion({ kind: "connector", label: "helpdesk__search_tickets", grantContentOrigin: declaredContentOriginForToolName("helpdesk__search_tickets") });
    eq(tainting.tier, "untrusted", "…so it MARKS the turn");
    eq(tainting.assumed, false, "…and exactly, not by assumption — the operator declared this");
    eq(declaredContentOriginForToolName("helpdesk__list_queues"), "internal", "…while every SIBLING tool keeps `default` — the ninety-nine are not taxed for the one");
    eq(classifyIngestion({ kind: "connector", grantContentOrigin: declaredContentOriginForToolName("helpdesk__list_queues") }).tier, "trusted", "…and classifies trusted");
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    setConnectorContentOrigin({ forum: { default: "external", except: { our_runbook: "internal" } } });
    eq(declaredContentOriginForToolName("forum__threads"), "external", "(c) `default: external` answers for the unlisted tools");
    eq(declaredContentOriginForToolName("forum__our_runbook"), "internal", "…and the exception relaxes exactly the one tool named");
    eq(classifyIngestion({ kind: "connector", grantContentOrigin: declaredContentOriginForToolName("forum__our_runbook") }).tier, "trusted", "…which reaches the table as a trusted verdict");
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    setConnectorContentOrigin({
      helpdesk: { default: "internal", except: { search: "external" } },
      wiki: "internal",
      "wiki__mirror": { default: "internal", except: { fetch: "external" } },
    });
    eq(declaredContentOriginForToolName("helpdesk__search"), "external", "(d) the excepting connection's own tool takes the override");
    eq(declaredContentOriginForToolName("wiki__search"), "internal", "🔴 …and a SAME-NAMED tool on another connection does NOT — an `except` entry can only ever speak for its own connection");
    eq(declaredContentOriginForToolName("wiki__mirror__fetch"), "external", "…longest-prefix and per-tool compose: the `wiki__mirror` connection's own exception wins over `wiki`'s scalar");
    eq(declaredContentOriginForToolName("wiki__fetch"), "internal", "…and `wiki`'s own `fetch` is untouched by the exception that lives on `wiki__mirror`");
  });

  await eveContextStorage().run(new FakeSession(), async () => {
    setConnectorContentOrigin({ helpdesk: { default: "internal", except: { search: "external" } } });
    eq(declaredContentOriginForToolName("other__search"), undefined, "(e) an UNDECLARED connection is undefined however richly its neighbours are declared");
    const assumed = classifyIngestion({ kind: "connector", label: "other__search", grantContentOrigin: declaredContentOriginForToolName("other__search") });
    eq(assumed.tier, "untrusted", "…so the table falls closed");
    ok(assumed.assumed, "…and marks the verdict `assumed` — silence never reads as an assurance, at any grain");
    eq(declaredContentOriginForToolName("connection_search"), undefined, "…and `connection_search` still matches nothing — the aggregate has no single grant to speak for it");
    eq(declaredContentOriginForToolName("helpdesk__constructor"), "internal", "…and a tool named `constructor` resolves the DECLARED default, never a prototype member");
  });
}

registerTaintVerdictSink(restore);
ok(currentTaintVerdictSink() === restore, "the sink is restorable (test seam behaves)");

console.log(`✓ taint-tiers: ${n} assertions passed`);
