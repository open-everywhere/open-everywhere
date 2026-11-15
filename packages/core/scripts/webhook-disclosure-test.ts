// proves: webhook.fired
// proves: ROUT-83

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { normalizeFenceNonce } from "../agent/access/untrusted.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const dir = join(tmpdir(), `open-everywhere-webhook-disclosure-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerSlackTestBridge } = await import("./_slack-test-stubs.js");
registerSlackTestBridge();

const { defineWebhook } = await import("../agent/webhooks/config.js");
const { fireWebhook, renderWebhookMessage, WEBHOOK_AUDIENCE_FLOOR_REASON } = await import("../agent/webhooks/dispatch.js");
const { registerGovernanceMemberSupplier, _resetGovernanceMemberSupplierForTest, _resetAudienceFloorCacheForTest } = await import(
  "../agent/access/audience-floor.js"
);
type RoomRoster = import("../agent/access/audience-floor.js").RoomRoster;
type WebhookHook = import("../agent/webhooks/config.js").WebhookHook;
type FusedWebhookHook = import("../agent/webhooks/config.js").FusedWebhookHook;

const PAYLOAD = JSON.stringify({ note: "deploy 42 finished", who: "ci" });

interface SlackFacts {
  readonly trustChecked: boolean;
  readonly isExternal: boolean;
  readonly members: "one-page" | "multi-page" | "failed";
  readonly isPrivate: boolean;
}

function rosterFrom(f: SlackFacts): RoomRoster {
  if (!f.trustChecked || f.members === "failed") return { humanMemberIds: [], resolved: false, isPrivate: false, hasGuest: false };
  if (f.members === "multi-page") {
    return f.isExternal
      ? { humanMemberIds: [], resolved: true, isPrivate: f.isPrivate, hasGuest: true }
      : { humanMemberIds: [], resolved: false, isPrivate: false, hasGuest: false };
  }
  return { humanMemberIds: ["U1", "U2"], resolved: true, isPrivate: f.isPrivate, hasGuest: f.isExternal };
}

function internalFrom(f: SlackFacts): boolean {
  return f.trustChecked && !f.isExternal;
}

const INTERNAL: SlackFacts = { trustChecked: true, isExternal: false, members: "one-page", isPrivate: false };
const INTERNAL_PRIVATE: SlackFacts = { trustChecked: true, isExternal: false, members: "one-page", isPrivate: true };
const OBSERVED_EXTERNAL: SlackFacts = { trustChecked: true, isExternal: true, members: "one-page", isPrivate: true };
const BIG_EXTERNAL_CHANNEL: SlackFacts = { trustChecked: true, isExternal: true, members: "multi-page", isPrivate: false };
const UNOBSERVABLE: SlackFacts = { trustChecked: false, isExternal: false, members: "failed", isPrivate: false };
const BIG_INTERNAL_CHANNEL: SlackFacts = { trustChecked: true, isExternal: false, members: "multi-page", isPrivate: false };

function arm(facts: SlackFacts | "no-supplier" | "throws"): void {
  _resetGovernanceMemberSupplierForTest();
  _resetAudienceFloorCacheForTest();
  if (facts === "no-supplier") return;
  if (facts === "throws") {
    registerGovernanceMemberSupplier(async () => {
      throw new Error("slack conversations.info exploded");
    });
    return;
  }
  registerGovernanceMemberSupplier(async () => rosterFrom(facts));
}

interface Captured {
  readonly message: string;
  readonly target?: { readonly channelId?: string };
}
function captureReceive(): { calls: Captured[]; to: never } {
  const calls: Captured[] = [];
  const to = (_channel: unknown, target: unknown) => ({
    send: (message: unknown, opts: unknown) => {
      calls.push({ target, message, ...(opts as object) } as Captured);
      return Promise.resolve();
    },
  });
  return { calls, to: to as never };
}

const hook: FusedWebhookHook = defineWebhook({
  id: "deploy-status",
  source: "oe-standard-webhook",
  secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",
  broker: "env",
  target: "slack/T1/C1",
  readableBy: [{ level: "domain", domain: "eng" }],
  instruction: "A deploy just finished. Summarise it.",
});

const FIRE_NOW = new Date("2026-09-23T12:00:00.000Z");

async function fire(h: FusedWebhookHook, facts: SlackFacts | "no-supplier" | "throws"): Promise<{ fired: boolean; reason?: string; calls: Captured[] }> {
  arm(facts);
  const { calls, to } = captureReceive();
  const internal = typeof facts === "string" ? false : internalFrom(facts);
  const result = await fireWebhook(h, PAYLOAD, { to, confirmInternal: async () => internal, now: FIRE_NOW });
  return { ...result, calls };
}

{
  const r = await fire(hook, OBSERVED_EXTERNAL);
  ok(r.fired === false, "🔴 refuse: a POSITIVELY externally-shared target does not fire — a config hook must not push sender-controlled payload content into a room outside the org");
  ok(r.calls.length === 0, "🔴 refuse: `receive` is never called — no session starts, so no model output can reach the room either");
  ok(r.reason === WEBHOOK_AUDIENCE_FLOOR_REASON, "refuse: the decline carries the audience-floor reason verbatim (the string that lands in `webhook.declined`)");
  ok(/audience floor/i.test(r.reason ?? "") && /internal channel/i.test(r.reason ?? ""), "refuse: the reason names the CONDITION and the FIX, so the audit row is actionable");
  ok((r.reason ?? "").includes(PAYLOAD) === false && (r.reason ?? "").includes("deploy 42") === false, "refuse: the reason copies NO payload bytes into the hash-chained audit table");
  const big = await fire(hook, BIG_EXTERNAL_CHANNEL);
  ok(big.fired === false && big.calls.length === 0, "🔴 refuse: a shared target with MORE THAN ONE PAGE of members does not fire either (OPE-2311)");
}

{
  const expected = renderWebhookMessage(hook, PAYLOAD, {}, FIRE_NOW);
  for (const [label, facts] of [
    ["an internal public channel", INTERNAL],
    ["an internal private channel", INTERNAL_PRIVATE],
    ["an UNOBSERVABLE room (conversations.info could not answer)", UNOBSERVABLE],
    ["an ORDINARY INTERNAL channel with >1 page of members", BIG_INTERNAL_CHANNEL],
    ["a deployment with NO member supplier registered at all", "no-supplier"],
    ["a THROWING member supplier (a live platform blip)", "throws"],
  ] as const) {
    const r = await fire(hook, facts);
    ok(r.fired === true, `fire: ${label} still fires`);
    ok(r.calls.length === 1, `fire: ${label} calls receive exactly once`);
    ok(normalizeFenceNonce(r.calls[0]!.message) === normalizeFenceNonce(expected), `🔴 fire: ${label} hands the room the BYTE-IDENTICAL rendered message — the outcome reaches the room, not just a passing check`);
    ok(r.calls[0]!.target?.channelId === "C1", `fire: ${label} still targets the hook's configured channel`);
  }
}

{
  const routeSrc = readFileSync(join(REPO, "packages/core/agent/channels/webhooks.ts"), "utf8");
  const dispatchSrc = readFileSync(join(REPO, "packages/core/agent/webhooks/dispatch.ts"), "utf8");

  ok(
    /action:\s*fired\s*\?\s*"webhook\.fired"\s*:\s*"webhook\.declined"/.test(routeSrc),
    "vocabulary: the route still maps a non-fire onto the EXISTING `webhook.declined` action and a fire onto `webhook.fired`",
  );
  ok(/result\?\.reason\s*\?\s*\{\s*reason:\s*result\.reason\s*\}/.test(routeSrc), "vocabulary: …and still carries the decline's reason into that row's detail");
  ok(/result\?\.wakeId\s*\?\s*\{\s*wakeId:\s*result\.wakeId\s*\}/.test(routeSrc), "join: the fired/declined row carries the FIRE's wake id — the handle `reply.post` is joined on (OPE-460)");

  const actions = new Set(
    [routeSrc, dispatchSrc, readFileSync(join(REPO, "packages/core/agent/webhooks/reject-audit.ts"), "utf8")].flatMap((s) =>
      [...s.matchAll(/"(webhook\.[a-z_]+)"/g)].map((m) => m[1]!),
    ),
  );
  const expectedActions = ["webhook.declined", "webhook.fired", "webhook.rejected"];
  ok(
    [...actions].sort().join(",") === expectedActions.join(","),
    `vocabulary: the webhook surface's audit actions are EXACTLY the three that pre-date OPE-183 (found: ${[...actions].sort().join(", ")})`,
  );

  ok(dispatchSrc.includes("appendAudit") === false, "vocabulary: the fire path writes NO audit row of its own — the route's single fired/declined row stays the one record");
  ok(
    dispatchSrc.includes("postUnifiedReply") === false && dispatchSrc.includes("announceFireWithheld") === false,
    "🔴 no room post: unlike the event leg, a refused hook posts NOTHING into the room — this path has no per-(routine, reason) throttle, so a notice would let one secret-holder drive channel spam at request rate",
  );
  const outcomes = new Set([...dispatchSrc.matchAll(/"oe\.outcome":\s*"([a-z]+)"/g)].map((m) => m[1]!));
  ok(
    outcomes.size === 2 && outcomes.has("ok") && outcomes.has("failed"),
    `vocabulary: no new telemetry outcome either — "did not fire" is one bucket and the reason lives in the audit row (found: ${[...outcomes].sort().join(", ")})`,
  );
}

{
  const dispatchSrc = readFileSync(join(REPO, "packages/core/agent/webhooks/dispatch.ts"), "utf8");
  ok(/from "\.\.\/routines\/fire-disclosure\.js"/.test(dispatchSrc), "single-source: the config-hook leg imports the SHARED trigger-fire classifier");
  ok(/export function classifyFireDisclosure\b/.test(dispatchSrc) === false, "single-source: …and does not re-roll it (cron/event/webhook fires are one concept with three mechanisms)");
  ok(/from "\.\.\/access\/audience-floor\.js"/.test(dispatchSrc) === false, "single-source: it does not reach past fire-disclosure.ts to the primitive either — one policy, one door");
}

{
  let refusals = 0;
  let internals = 0;
  for (const trustChecked of [false, true]) {
    for (const isExternal of [false, true]) {
      for (const members of ["failed", "multi-page", "one-page"] as const) {
        const facts: SlackFacts = { trustChecked, isExternal, members, isPrivate: false };
        const r = await fire(hook, facts);
        if (internalFrom(facts)) {
          internals++;
          ok(r.fired === true, `🔴 blast radius: a target Slack POSITIVELY confirms internal always fires (trustChecked=${trustChecked}, isExternal=${isExternal}, members=${members})`);
        }
        if (!r.fired) {
          refusals++;
          ok(trustChecked && members !== "failed" && isExternal, `blast radius: the ONLY refusing shape is an externally-shared channel whose members read answered (got trustChecked=${trustChecked}, isExternal=${isExternal}, members=${members})`);
        }
      }
    }
  }
  ok(internals === 3, `blast radius: the implication is not vacuous — ${internals} of the 12 fact combinations confirm internal (trustChecked ∧ ¬isExternal, any members answer)`);
  ok(refusals === 2, `blast radius: exactly TWO of the 12 combinations refuse (got ${refusals}): a shared channel with one members page or more — so the gate is neither dead nor broad`);

  const slackSrc = readFileSync(join(REPO, "packages/providers/slack/agent/channels/slack-events.ts"), "utf8");
  ok(/resolved:\s*facts\.trustChecked === true/.test(slackSrc), "pin: the live supplier really derives `resolved` from conversations.info's trustChecked");
  ok(/hasGuest:\s*facts\.isExternal === true/.test(slackSrc), "pin: …and `hasGuest` from the SAME call's external-sharing bit — which is why the two conditions are disjoint");
  ok(
    /const internal = facts\.trustChecked === true && facts\.isExternal === false/.test(slackSrc),
    "pin: …and the fire's own confirmInternal is the complement of the guest bit, off the same call",
  );
  const pagedBranch = /if \(cursor && cursor\.length > 0\) \{([\s\S]*?)\n    \}\n/.exec(slackSrc)?.[1] ?? "";
  ok(
    /if \(facts\.trustChecked === true && facts\.isExternal === true\) \{\s*return \{[^}]*resolved: true[^}]*hasGuest: true/.test(pagedBranch),
    "pin: a SHARED channel with MORE THAN ONE PAGE of members resolves with hasGuest — the mirror above refuses it (OPE-2311)",
  );
  ok(
    /return \{[^}]*resolved: false, unresolvedState: "unobservable"[^}]*hasGuest: false/.test(pagedBranch),
    "🔴 pin: a NON-SHARED channel with MORE THAN ONE PAGE of members really does report `resolved: false` — this is why fail-open here is load-bearing and not an inherited default",
  );
}

{
  const hooksSrc = readFileSync(join(REPO, "agent/webhooks/hooks.ts"), "utf8");
  const active = hooksSrc
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const shipped = [...active.matchAll(/defineWebhook\(\{([\s\S]*?)\}\)/g)]
    .map((m) => ({ id: /id:\s*"([^"]+)"/.exec(m[1]!)?.[1], target: /target:\s*"([^"]+)"/.exec(m[1]!)?.[1] }))
    .filter((h): h is { id: string; target: string } => Boolean(h.id && h.target));

  ok(shipped.length > 0, `shipped: found ${shipped.length} live hook declaration(s) — a zero here means the parse broke, not that the deployment ships none`);
  ok(shipped.some((h) => h.id === "e2e-smoke"), "shipped: the e2e pack's own hook is still declared (scripts/e2e/env.ts defaults it BY NAME — S20 dies without it)");
  ok(
    shipped.every((h) => /^slack\/[^/]+\/[^/]+$/.test(h.target)),
    "shipped: every declared target is a slack/TEAM/CHANNEL triple — the construction that makes this gate reachable on 100% of the surfaces it can fire into",
  );

  for (const h of shipped) {
    const real: FusedWebhookHook = defineWebhook({ ...hook, id: h.id, target: h.target });
    for (const [label, facts] of [
      ["internal", INTERNAL],
      ["internal + private", INTERNAL_PRIVATE],
      ["unobservable", UNOBSERVABLE],
      [">1 page of members", BIG_INTERNAL_CHANNEL],
      ["no supplier", "no-supplier"],
    ] as const) {
      const r = await fire(real, facts);
      ok(r.fired === true && r.calls.length === 1, `🔴 shipped: "${h.id}" (${h.target}) still fires when its room is ${label}`);
    }
    const refused = await fire(real, OBSERVED_EXTERNAL);
    ok(
      refused.fired === false && refused.calls.length === 0,
      `shipped: "${h.id}" is refused ONLY if Slack positively reports ${h.target} externally shared — the one live fact this offline test cannot read`,
    );
  }
}

{
  console.log("\n7. behavioural: the real route stamps detail.wakeId (OPE-460/482):");
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  const { overrideSettingsForTest, resetSettingsForTest } = await import("../agent/settings/settings.js");
  const { readAudit } = await import("../agent/audit/audit.js");
  const { registerSlackFixtureCodec, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
  const sw = await import("../agent/webhooks/oe-standard-webhook.js");

  registerSlackTestBridge({ confirmChannelInternal: async () => true });
  registerSlackFixtureCodec();
  registerSlackFixtureMapper();
  arm(INTERNAL);

  const wakeSecret = `wh-${Math.random().toString(36).slice(2)}`;
  process.env["WAKEID_PROOF_WEBHOOK_SECRET"] = wakeSecret;
  const wakeHook: FusedWebhookHook = defineWebhook({
    id: "wakeid-proof",
    source: "oe-standard-webhook",
    secretRef: "WAKEID_PROOF_WEBHOOK_SECRET",
    broker: "env",
    target: "slack/T1/C1",
    readableBy: [{ level: "domain", domain: "eng" }],
    instruction: "Prove the wake id lands on the row.",
  });

  const winDomain = defineDomain({ name: "eng", reach: ["slack/T1/C1"], ambientSupervisor: true, mode: "unified" });
  registerConfig({
    loadWebhooks: () => [wakeHook],
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [winDomain],
    loadSilos: () => [],
    domainsForSurface: ({ surface }) => (surface === "C1" ? ["eng"] : []),
  });

  const { default: webhooksChannel } = await import("../agent/channels/webhooks.js");
  const route = webhooksChannel.routes[0] as { handler: (req: Request, args: unknown) => Promise<Response> };

  async function postSigned(deliveryId: string, body: string, armed: boolean): Promise<void> {
    overrideSettingsForTest({ delegation: { oneshotAgent: armed }, window: { topology: true } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sw.standardWebhookSignature(wakeSecret, deliveryId, ts, body);
    const req = new Request("http://localhost/webhooks/wakeid-proof", {
      method: "POST",
      headers: { "webhook-id": deliveryId, "webhook-timestamp": ts, "webhook-signature": sig, "content-type": "application/json" },
      body,
    });
    const pending: Promise<unknown>[] = [];
    const res = await route.handler(req, {
      to: captureReceive().to,
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      params: { id: "wakeid-proof" },
    } as never);
    const text = await res.text();
    ok(res.status === 200, `postSigned(armed=${armed}): the signed delivery is accepted (200, got ${res.status}: ${text.slice(0, 160)})`);
    await Promise.all(pending);
  }

  const rowsFor = async (deliveryId: string): Promise<{ wakeId?: string } | undefined> => {
    const rows = await readAudit({ org: "acme", action: "webhook.fired", limit: 200 });
    const row = rows.find((r) => (r.detail as { hookId?: string; deliveryId?: string } | undefined)?.deliveryId === deliveryId);
    return row?.detail as { wakeId?: string } | undefined;
  };

  await postSigned("msg_wakeid_on", JSON.stringify({ note: "wakeid on" }), true);
  const onDetail = await rowsFor("msg_wakeid_on");
  ok(onDetail !== undefined, "wakeId/positive: a webhook.fired row exists for the armed delivery, joined on the delivery id");
  ok(typeof onDetail?.wakeId === "string" && onDetail.wakeId.length > 0, "🔴 wakeId/positive: the REAL route's `deliver()` stamped a non-empty `detail.wakeId` on the `webhook.fired` row");

  await postSigned("msg_wakeid_off", JSON.stringify({ note: "wakeid off" }), false);
  const offDetail = await rowsFor("msg_wakeid_off");
  ok(offDetail !== undefined, "wakeId/negative control: a webhook.fired row exists for the disarmed delivery too");
  ok(offDetail?.wakeId === undefined, "wakeId/negative control: the disarmed (native) fire's row carries NO wakeId — the stamp is conditional on the real divert, never a constant");

  resetSettingsForTest();
}

_resetGovernanceMemberSupplierForTest();
_resetAudienceFloorCacheForTest();
await removeTempDir(dir);
console.log(`✓ webhook-disclosure: ${passed} assertions passed`);
