import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

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
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";

const { registerSlackTestBridge } = await import("./_slack-test-stubs.js");
registerSlackTestBridge();

const { defineWebhook } = await import("../agent/webhooks/config.js");
const { fireWebhook, renderWebhookMessage, WEBHOOK_AUDIENCE_FLOOR_REASON } = await import("../agent/webhooks/dispatch.js");
const { registerGovernanceMemberSupplier, _resetGovernanceMemberSupplierForTest, _resetAudienceFloorCacheForTest } = await import(
  "../agent/access/audience-floor.js"
);
type RoomRoster = import("../agent/access/audience-floor.js").RoomRoster;
type WebhookHook = import("../agent/webhooks/config.js").WebhookHook;

const PAYLOAD = JSON.stringify({ note: "deploy 42 finished", who: "ci" });

interface SlackFacts {
  readonly trustChecked: boolean;
  readonly isExternal: boolean;
  readonly membersOk: boolean;
  readonly isPrivate: boolean;
}

function rosterFrom(f: SlackFacts): RoomRoster {
  if (!f.trustChecked || !f.membersOk) return { humanMemberIds: [], resolved: false, isPrivate: false, hasGuest: false };
  return { humanMemberIds: ["U1", "U2"], resolved: true, isPrivate: f.isPrivate, hasGuest: f.isExternal };
}

function internalFrom(f: SlackFacts): boolean {
  return f.trustChecked && !f.isExternal;
}

const INTERNAL: SlackFacts = { trustChecked: true, isExternal: false, membersOk: true, isPrivate: false };
const INTERNAL_PRIVATE: SlackFacts = { trustChecked: true, isExternal: false, membersOk: true, isPrivate: true };
const OBSERVED_EXTERNAL: SlackFacts = { trustChecked: true, isExternal: true, membersOk: true, isPrivate: true };
const UNOBSERVABLE: SlackFacts = { trustChecked: false, isExternal: false, membersOk: false, isPrivate: false };
const BIG_INTERNAL_CHANNEL: SlackFacts = { trustChecked: true, isExternal: false, membersOk: false, isPrivate: false };

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
function captureReceive(): { calls: Captured[]; receive: never } {
  const calls: Captured[] = [];
  const receive = (_channel: unknown, opts: unknown) => {
    calls.push(opts as Captured);
    return Promise.resolve();
  };
  return { calls, receive: receive as never };
}

const hook: WebhookHook = defineWebhook({
  id: "deploy-status",
  source: "oe-standard-webhook",
  secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",
  broker: "env",
  target: "slack/T1/C1",
  instruction: "A deploy just finished. Summarise it.",
});

async function fire(h: WebhookHook, facts: SlackFacts | "no-supplier" | "throws"): Promise<{ fired: boolean; reason?: string; calls: Captured[] }> {
  arm(facts);
  const { calls, receive } = captureReceive();
  const internal = typeof facts === "string" ? false : internalFrom(facts);
  const result = await fireWebhook(h, PAYLOAD, { receive, confirmInternal: async () => internal });
  return { ...result, calls };
}

{
  const r = await fire(hook, OBSERVED_EXTERNAL);
  ok(r.fired === false, "🔴 refuse: a POSITIVELY externally-shared target does not fire — a config hook must not push sender-controlled payload content into a room outside the org");
  ok(r.calls.length === 0, "🔴 refuse: `receive` is never called — no session starts, so no model output can reach the room either");
  ok(r.reason === WEBHOOK_AUDIENCE_FLOOR_REASON, "refuse: the decline carries the audience-floor reason verbatim (the string that lands in `webhook.declined`)");
  ok(/audience floor/i.test(r.reason ?? "") && /internal channel/i.test(r.reason ?? ""), "refuse: the reason names the CONDITION and the FIX, so the audit row is actionable");
  ok((r.reason ?? "").includes(PAYLOAD) === false && (r.reason ?? "").includes("deploy 42") === false, "refuse: the reason copies NO payload bytes into the hash-chained audit table");
}

{
  const expected = renderWebhookMessage(hook, PAYLOAD);
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
    ok(r.calls[0]!.message === expected, `🔴 fire: ${label} hands the room the BYTE-IDENTICAL rendered message — the outcome reaches the room, not just a passing check`);
    ok(r.calls[0]!.target?.channelId === "C1", `fire: ${label} still targets the hook's configured channel`);
  }
}

{
  const routeSrc = readFileSync(join(REPO, "packages/core/agent/channels/webhooks.ts"), "utf8");
  const dispatchSrc = readFileSync(join(REPO, "packages/core/agent/webhooks/dispatch.ts"), "utf8");

  ok(
    /action:\s*result\.fired\s*\?\s*"webhook\.fired"\s*:\s*"webhook\.declined"/.test(routeSrc),
    "vocabulary: the route still maps `fired === false` onto the EXISTING `webhook.declined` action",
  );
  ok(/result\.reason\s*\?\s*\{\s*reason:\s*result\.reason\s*\}/.test(routeSrc), "vocabulary: …and still carries the decline's reason into that row's detail");

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
      for (const membersOk of [false, true]) {
        const facts: SlackFacts = { trustChecked, isExternal, membersOk, isPrivate: false };
        const r = await fire(hook, facts);
        if (internalFrom(facts)) {
          internals++;
          ok(r.fired === true, `🔴 blast radius: a target Slack POSITIVELY confirms internal always fires (trustChecked=${trustChecked}, isExternal=${isExternal}, membersOk=${membersOk})`);
        }
        if (!r.fired) {
          refusals++;
          ok(trustChecked && membersOk && isExternal, `blast radius: the ONLY refusing shape is a fully-observed externally-shared channel (got trustChecked=${trustChecked}, isExternal=${isExternal}, membersOk=${membersOk})`);
        }
      }
    }
  }
  ok(internals === 2, `blast radius: the implication is not vacuous — ${internals} of the 8 fact combinations confirm internal (trustChecked ∧ ¬isExternal, either membersOk)`);
  ok(refusals === 1, `blast radius: exactly ONE of the 8 combinations refuses (got ${refusals}) — so the gate is neither dead nor broad`);

  const slackSrc = readFileSync(join(REPO, "packages/providers/slack/agent/channels/slack-events.ts"), "utf8");
  ok(/resolved:\s*facts\.trustChecked === true/.test(slackSrc), "pin: the live supplier really derives `resolved` from conversations.info's trustChecked");
  ok(/hasGuest:\s*facts\.isExternal === true/.test(slackSrc), "pin: …and `hasGuest` from the SAME call's external-sharing bit — which is why the two conditions are disjoint");
  ok(
    /const internal = facts\.trustChecked === true && facts\.isExternal === false/.test(slackSrc),
    "pin: …and the fire's own confirmInternal is the complement of the guest bit, off the same call",
  );
  ok(
    /if \(cursor && cursor\.length > 0\)[\s\S]{0,600}?resolved: false/.test(slackSrc),
    "🔴 pin: a channel with MORE THAN ONE PAGE of members really does report `resolved: false` — this is why fail-open here is load-bearing and not an inherited default",
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
    const real: WebhookHook = defineWebhook({ ...hook, id: h.id, target: h.target });
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

_resetGovernanceMemberSupplierForTest();
_resetAudienceFloorCacheForTest();
rmSync(dir, { recursive: true, force: true });
console.log(`✓ webhook-disclosure: ${passed} assertions passed`);
