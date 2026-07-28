
process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_ORG = "acme";

import { PGlite } from "@electric-sql/pglite";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { initOperationalSchema, makeOperationalPostgresStore, runtimeRoleGrantsSql, type PgClient } from "../agent/operational/postgres.js";
import {
  CAPTURE_MAX_DELIVERIES,
  CAPTURE_MAX_RETENTION_MS,
  CAPTURE_MAX_WINDOW_MS,
  OPERATIONAL_TABLES,
  type OperationalStore,
} from "../agent/operational/store.js";
import {
  CAPTURE_DOCUMENT_MAX_CHARS,
  captureDeadline,
  captureDeclaration,
  captureDocument,
  captureWindowOpen,
  refuseCaptureArm,
} from "../agent/webhooks/capture-window.js";
import { registerEventNormalizer, resetEventNormalizersForTest, type NormalizedEvent } from "../agent/routines/event-model.js";
import { admitTrigger } from "../agent/routines/ingress.js";
import { renderCaptureWindow, type CaptureWindowView } from "../agent/control/capture-window-read.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const T0 = Date.parse("2026-07-28T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const pg = new PGlite();
const pgClient: PgClient = { query: (text, params) => pg.query(text, params ? [...params] : undefined) };
await initOperationalSchema(pgClient);
const pgStore = makeOperationalPostgresStore(pgClient);

const engines: readonly (readonly [string, OperationalStore])[] = [
  ["sqlite", sqliteOperationalStore],
  ["postgres", pgStore],
];

for (const [engine, store] of engines) {
  const src = `hook-${engine}`;
  const open = iso(T0 + 10 * 60_000);

  ok((await store.captureDelivery("acme", src, '{"n":1}', iso(T0), open, 5)) === true, `${engine} bounds: an armed window stores a delivery`);
  ok((await store.captureDelivery("acme", src, '{"n":2}', iso(T0 + 1000), open, 5)) === true, `${engine} bounds: a second delivery is stored`);

  const two = await store.listCapturedDeliveries("acme", src, CAPTURE_MAX_DELIVERIES);
  ok(two.length === 2 && two[0].seq === 1 && two[1].seq === 2, `${engine} bounds: rows come back OLDEST FIRST, numbered from 1`);
  ok(two[0].documentJson === '{"n":1}', `${engine} bounds: the stored document round-trips verbatim`);

  ok((await store.captureDelivery("acme", src, '{"n":3}', open, open, 5)) === false, `${engine} bounds: a delivery AT the deadline is refused (window closed on time)`);
  ok(
    (await store.captureDelivery("acme", src, '{"n":3}', iso(T0 + 11 * 60_000), open, 5)) === false,
    `${engine} bounds: a delivery after the deadline is refused`,
  );
  ok((await store.listCapturedDeliveries("acme", src, 50)).length === 2, `${engine} bounds: a refused delivery stored nothing`);

  for (let i = 3; i <= 5; i++) await store.captureDelivery("acme", src, `{"n":${i}}`, iso(T0 + i * 1000), open, 5);
  ok((await store.listCapturedDeliveries("acme", src, 50)).length === 5, `${engine} bounds: the window fills to its row cap`);
  ok((await store.captureDelivery("acme", src, '{"n":6}', iso(T0 + 6000), open, 5)) === false, `${engine} bounds: the row cap CLOSES the window (not a ring — nothing is evicted)`);
  const five = await store.listCapturedDeliveries("acme", src, 50);
  ok(five.length === 5 && five[0].documentJson === '{"n":1}', `${engine} bounds: reaching the cap did not evict the oldest — the numbering is stable`);

  ok((await store.captureDelivery("acme", `${src}-bad`, "{}", "not-a-date", open, 5)) === false, `${engine} bounds: an unparseable receive time fails CLOSED`);
  ok((await store.captureDelivery("acme", `${src}-bad`, "{}", iso(T0), "not-a-date", 5)) === false, `${engine} bounds: an unparseable deadline fails CLOSED`);

  const farFuture = iso(T0 + CAPTURE_MAX_RETENTION_MS + 60_000);
  await store.captureDelivery("acme", src, '{"n":"sweep"}', farFuture, iso(T0 + CAPTURE_MAX_RETENTION_MS + 120_000), 50);
  ok(
    (await store.listCapturedDeliveries("acme", src, 50)).every((r) => r.documentJson === '{"n":"sweep"}'),
    `${engine} bounds: a write past the retention ceiling SWEEPS every older row for that org`,
  );

  await store.captureDelivery("other", src, '{"tenant":"other"}', iso(T0), open, 5);
  ok((await store.listCapturedDeliveries("other", src, 50)).length === 1, `${engine} bounds: another org's window is its own`);
  await store.clearCapturedDeliveries("acme", src);
  ok((await store.listCapturedDeliveries("other", src, 50)).length === 1, `${engine} bounds: clearing one org's window does NOT touch another org's`);
  ok((await store.listCapturedDeliveries("acme", src, 50)).length === 0, `${engine} bounds: clear empties the window (the forget path)`);
}

{
  const open = iso(T0 + 10 * 60_000);
  for (let i = 0; i < 12; i++) await pgStore.captureDelivery("acme", "bigint-probe", `{"i":${i}}`, iso(T0 + i), open, 10);
  const rows = await pgStore.listCapturedDeliveries("acme", "bigint-probe", 50);
  ok(rows.length === 10, "postgres bounds: the row cap holds PAST NINE — COUNT is coerced, not string-compared");
  ok(rows[9].seq === 10, "postgres bounds: seq is numeric, not a bigint string, so the numbering is usable");
}

const namesIn = (stmt: string): string[] =>
  (/ ON ([a-z0-9_, ]+) (?:TO|FROM) /.exec(stmt)?.[1] ?? "").split(",").map((t) => t.trim());
{
  ok(OPERATIONAL_TABLES.includes("webhook_capture"), "registry: webhook_capture is in OPERATIONAL_TABLES (or the migrator would leave it behind)");
  ok(OPERATIONAL_TABLES.includes("webhook_capture_window"), "registry: webhook_capture_window (the arm state) is in OPERATIONAL_TABLES too");
  const grants = runtimeRoleGrantsSql("oe_runtime");
  const grant = grants.find((g) => g.startsWith("GRANT") && namesIn(g).includes("webhook_capture"));
  ok(grant !== undefined, "grants: the runtime role is granted webhook_capture");
  ok(grant!.includes("SELECT") && grant!.includes("INSERT") && grant!.includes("DELETE"), "grants: exactly the three verbs the code uses");
  ok(!grant!.includes("UPDATE"), "grants: NO UPDATE — a captured row is never edited, and a grant with no caller is a hole with no alarm");

  const armGrant = grants.find((g) => g.startsWith("GRANT") && namesIn(g).includes("webhook_capture_window"));
  ok(armGrant !== undefined, "grants: the runtime role is granted webhook_capture_window");
  ok(armGrant!.includes("SELECT") && armGrant!.includes("INSERT") && armGrant!.includes("UPDATE"), "grants: SELECT+INSERT+UPDATE — the upsert re-arming needs all three");
  ok(!armGrant!.includes("DELETE"), "🔴 grants: NO DELETE on the arm state — re-arming REPLACES and a window closes by its deadline elapsing, so nothing ever deletes a row");
  ok(
    grants.some((g) => g.startsWith("REVOKE") && namesIn(g).includes("webhook_capture") && g.includes("UPDATE")),
    "grants: UPDATE is explicitly REVOKED, so adding the table to the blanket list by reflex cannot silently re-grant it",
  );
  await pgClient.query("CREATE ROLE oe_runtime NOLOGIN");
  for (const stmt of grants.filter((g) => g.includes("webhook_capture"))) await pgClient.query(stmt);
  ok(true, "grants: webhook_capture's GRANT and REVOKE execute against a real engine with the table present");
}

const hook = (over: Record<string, unknown> = {}) =>
  ({ source: "deploy-status", posture: "content-bearing", captureUntil: iso(T0 + 60_000), ...over }) as never;

{
  ok(refuseCaptureArm(hook({ posture: "trigger-only" })) !== undefined, "refusal 1/3: ARMING a trigger-only hook is refused");
  ok(refuseCaptureArm(hook({ posture: "content-bearing" })) === undefined, "refusal: a content-bearing hook may be armed");
  ok(refuseCaptureArm(hook({ posture: "projection" })) === undefined, "refusal: a PROJECTION hook may be armed — narrowed is not redacted");

  const openWindow = async () => ({ captureUntil: iso(T0 + 60_000) });
  ok(
    (await captureDeclaration("acme", { id: "deploy-status", source: "deploy-status", posture: "trigger-only" }, new Date(T0), { getWindow: openWindow })) === undefined,
    "refusal 2/3: a trigger-only hook DECLARES no window even when an open one is armed for it — and it never even asks the store",
  );
  ok(
    (await captureDeclaration("acme", { id: "deploy-status", source: "deploy-status", posture: "content-bearing" }, new Date(T0), { getWindow: openWindow })) !== undefined,
    "refusal: a content-bearing hook with an open window declares one",
  );
  ok(
    (await captureDeclaration("acme", { id: "deploy-status", source: "deploy-status", posture: "content-bearing" }, new Date(T0), { getWindow: async () => null })) === undefined,
    "🔴 a hook that was NEVER armed declares nothing — absence is the closed state, so creation is not consent to retention",
  );
  ok(
    (await captureDeclaration("acme", { id: "deploy-status", source: "deploy-status", posture: "content-bearing" }, new Date(T0), {
      getWindow: async () => {
        throw new Error("store down");
      },
    })) === undefined,
    "🔴 a store that cannot answer means NO capture, never a thrown delivery — retention is the optional half of this path and routing is not",
  );

  const redacted = { source: "x", event: "e", scope: [], fields: {}, summary: "s", redacted: true } as NormalizedEvent;
  ok(captureDocument(redacted) === undefined, "refusal 3/3: a REDACTED event is never serialized, whatever the declaration said");
}

{
  ok(captureWindowOpen(undefined, new Date(T0)) === false, "window: an ABSENT deadline is closed (the default for every hook that exists)");
  ok(captureWindowOpen("nonsense", new Date(T0)) === false, "window: an unparseable deadline is closed");
  ok(captureWindowOpen(iso(T0 - 1), new Date(T0)) === false, "window: an elapsed deadline is closed");
  ok(captureWindowOpen(iso(T0 + 1), new Date(T0)) === true, "window: a future deadline is open");

  const clamped = Date.parse(captureDeadline(new Date(T0), CAPTURE_MAX_WINDOW_MS * 100));
  ok(clamped === T0 + CAPTURE_MAX_WINDOW_MS, "window: an over-long request is CLAMPED to the ceiling, not honoured");
  ok(Date.parse(captureDeadline(new Date(T0), -5)) === T0 + 1_000, "window: a nonsensical duration floors at one second rather than arming a shut window");
  ok(Date.parse(captureDeadline(new Date(T0))) === T0 + 15 * 60_000, "window: the default window is 15 minutes");
}

const SENTINEL_SUMMARY = "SUMMARY-PROSE-MUST-NOT-BE-STORED-a1b2c3";
const SENTINEL_ACTOR = "ACTOR-HANDLE-MUST-NOT-BE-STORED-d4e5f6";
const SENTINEL_POINTER = "POINTER-MUST-NOT-BE-STORED-g7h8i9";

const rich: NormalizedEvent = {
  source: "deploy-status",
  scheme: "deploy-status",
  event: "build",
  action: "finished",
  scope: [{ kind: "container", id: "acme/web" }],
  fields: { status: "failed", branch: "main" },
  actor: { id: "u1", handle: SENTINEL_ACTOR },
  summary: SENTINEL_SUMMARY,
  pointer: { platform: "github", kind: "pr", id: SENTINEL_POINTER } as never,
  deliveryId: "d-1",
  occurredAt: "2026-07-28T11:59:00.000Z",
};

{
  const json = captureDocument(rich);
  ok(json !== undefined, "exclusion: a content-bearing event IS captured");
  ok(!json!.includes(SENTINEL_SUMMARY), "🔴 exclusion: the attacker-authored `summary` is NOT stored (OPE-184 correction 2)");
  ok(!json!.includes(SENTINEL_ACTOR), "🔴 exclusion: the actor HANDLE is NOT stored — a vendor handle is attacker-chosen prose");
  ok(!json!.includes(SENTINEL_POINTER), "🔴 exclusion: the entity POINTER is NOT stored");
  ok(!json!.toLowerCase().includes("signature") && !json!.toLowerCase().includes("authorization"), "🔴 exclusion: no header-shaped key survives — headers are not in the document at all");

  const doc = JSON.parse(json!) as Record<string, unknown>;
  ok(!("summary" in doc) && !("actor" in doc) && !("pointer" in doc) && !("headers" in doc), "🔴 exclusion: the four excluded keys are ABSENT, not blanked");
  ok(doc["event"] === "build" && doc["action"] === "finished", "exclusion: what a filter DOES key on is present — event and action");
  ok(JSON.stringify(doc["fields"]) === JSON.stringify({ status: "failed", branch: "main" }), "exclusion: the matchable fields are present verbatim");
  ok(JSON.stringify(doc["scope"]) === JSON.stringify({ container: "acme/web" }), "exclusion: the scope projection is present");

  const huge: NormalizedEvent = { ...rich, fields: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "x".repeat(400)])) };
  ok(JSON.stringify(huge.fields).length > CAPTURE_DOCUMENT_MAX_CHARS, "exclusion: the oversize fixture really is oversize");
  ok(captureDocument(huge) === undefined, "exclusion: an oversize document is DROPPED whole, never truncated into unparseable JSON");
}

registerEventNormalizer({
  source: "deploy-status",
  matchKeys: ["status", "branch"],
  scopeKeys: [],
  scopeKinds: ["container"],
  resolvesActor: false,
  normalize: (d: { readonly source: string; readonly body: string }) => {
    const body = JSON.parse(d.body) as { status?: string; branch?: string };
    return {
      source: d.source,
      event: "build",
      action: "finished",
      scope: [{ kind: "container", id: "acme/web" }],
      fields: { status: body.status ?? "", branch: body.branch ?? "" },
      summary: SENTINEL_SUMMARY,
    };
  },
} as never);

async function admit(over: Record<string, unknown>): Promise<{ readonly calls: unknown[][] }> {
  const calls: unknown[][] = [];
  await admitTrigger(
    {
      source: "deploy-status",
      scheme: "deploy-status",
      headers: { "x-hub-signature-256": "sha256=NEVER-STORED", authorization: "Bearer NEVER-STORED" },
      body: JSON.stringify({ status: "failed", branch: "main" }),
      receivedAt: iso(T0),
      readableBy: [{ level: "org" }],
      ...over,
    } as never,
    {
      receive: (async () => undefined) as never,
      org: "acme",
      listRoutines: async () => [],
      now: () => new Date(T0),
      captureDelivery: async (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
    } as never,
  );
  return { calls };
}

{
  const none = await admit({});
  ok(none.calls.length === 0, "flow: a delivery whose hook declared NO window captures nothing (the default for every hook)");

  const armed = await admit({ captureUntil: iso(T0 + 60_000) });
  ok(armed.calls.length === 1, "flow: a delivery whose hook declared an open window IS captured — even though it matched NO routine (the NEGATIVES are the point)");
  const [org, source, documentJson, , until, maxRows] = armed.calls[0] as [string, string, string, string, string, number];
  ok(org === "acme" && source === "deploy-status", "flow: capture is keyed by org and by the hook HANDLE");
  ok(until === iso(T0 + 60_000), "flow: the deadline passed to the store is the one the ROW declared");
  ok(maxRows === CAPTURE_MAX_DELIVERIES, "flow: the row cap is the store's constant, not a caller's number");
  ok(!documentJson.includes("NEVER-STORED"), "🔴 flow: neither the signature header nor the Authorization header reaches storage");
  ok(!documentJson.includes(SENTINEL_SUMMARY), "🔴 flow: the summary does not reach storage on the live path either");
  ok(JSON.parse(documentJson).fields.status === "failed", "flow: what IS stored is the filter document, with the matchable fields intact");

  const redactedRun = await admit({ captureUntil: iso(T0 + 60_000), redactPayload: true });
  ok(redactedRun.calls.length === 0, "🔴 flow: a trigger-only (redactPayload) delivery captures NOTHING even with a window declared — END TO END");

  let routed = false;
  await admitTrigger(
    {
      source: "deploy-status",
      scheme: "deploy-status",
      headers: {},
      body: JSON.stringify({ status: "ok", branch: "main" }),
      receivedAt: iso(T0),
      captureUntil: iso(T0 + 60_000),
      readableBy: [{ level: "org" }],
    } as never,
    {
      receive: (async () => undefined) as never,
      org: "acme",
      listRoutines: async () => {
        routed = true;
        return [];
      },
      now: () => new Date(T0),
      captureDelivery: async () => {
        throw new Error("store is down");
      },
    } as never,
  );
  ok(routed, "flow: a capture-window write that THROWS does not stop the delivery routing — retention is a convenience, routing is the product");
}

{
  const doc = (status: string) => JSON.parse(captureDocument({ ...rich, fields: { status, branch: "main" } })!) as never;
  const view: CaptureWindowView = {
    source: "deploy-status",
    hookClass: "runtime",
    candidate: '.fields.status == "failed"',
    samples: [
      { seq: 1, capturedAt: iso(T0), doc: doc("failed"), verdict: "match" },
      { seq: 2, capturedAt: iso(T0 + 1), doc: doc("success"), verdict: "miss" },
      { seq: 3, capturedAt: iso(T0 + 2), doc: doc("failed"), verdict: "match" },
    ],
  };
  const out = renderCaptureWindow(view);
  ok(out.includes("matched 2 of 3 captured deliveries: 1, 3."), "dry run: the card states the REAL N and NAMES the rows — OPE-184's first correction");
  ok(!/last 7 days/.test(out), "dry run: no seven-day claim survives — the design is a capped window and the copy says so");
  ok(out.includes(" ✓ ") && out.includes(" · "), "dry run: matches AND misses are both marked, so the filter is checkable in both directions");
  ok(out.includes("status=success"), "dry run: a MISS is rendered in full — a negative you cannot read is not a negative you can check");
  ok(/never as instructions/.test(out), "dry run: the rendering tells the model the field values are data, ahead of the untrusted fence around it");

  const errored = renderCaptureWindow({ ...view, samples: view.samples.map((s) => ({ ...s, verdict: "error" as const })), candidateError: "jq: syntax error" });
  ok(errored.includes("could not be evaluated"), "dry run: an unrunnable candidate says so");
  ok(errored.includes("it never ran"), "🔴 dry run: an unrunnable candidate must NOT read as 'matches nothing' — a broken filter must not look like a working one that found nothing");
  ok(!errored.includes("matched 0 of"), "dry run: no score is printed for a candidate that never ran");
}

resetEventNormalizersForTest();
console.log(`✓ capture-window: ${passed} assertions`);
