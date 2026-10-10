import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-webhook-replay-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const {
  firstSightingOfWebhookDelivery,
  webhookReplayNonceTtlMs,
  webhookReplayStoreKey,
  resetWebhookReplayWarnLatchForTest,
  WEBHOOK_REPLAY_KEY_PREFIX,
} = await import("../agent/webhooks/replay-dedupe.js");
const { standardWebhookVerifier, standardWebhookSignature, standardWebhookReplayKey, SW_ID_HEADER, SW_SIGNATURE_HEADER, SW_TIMESTAMP_HEADER } =
  await import("../agent/webhooks/oe-standard-webhook.js");
const { registerWebhookVerifier, resetWebhookVerifiersForTest } = await import("../agent/webhooks/verifier.js");
const { gateWebhookDelivery, webhookMaxSkewSeconds } = await import("../agent/webhooks/gate.js");
const { defineWebhook } = await import("../agent/webhooks/config.js");

type Verifier = import("../agent/webhooks/verifier.js").WebhookVerifier;
type Verdict = import("../agent/webhooks/verifier.js").WebhookVerdict;

const ORG = "acme";
const SECRET = "s3cr3t";
const NOW_MS = Date.parse("2026-03-30T11:30:00.000Z");
const NOW_TS = String(Math.floor(NOW_MS / 1000));

{
  const firstSeen = await firstSightingOfWebhookDelivery(ORG, "hook-a", "key-1", { now: () => new Date(NOW_MS) });
  ok(firstSeen === true, "A: a fresh (hook, replayKey) pair is a first sighting");

  const replay = await firstSightingOfWebhookDelivery(ORG, "hook-a", "key-1", { now: () => new Date(NOW_MS + 1_000) });
  ok(replay === false, "B: the SAME (hook, replayKey) pair, presented again inside the window, is refused as a replay");

  const distinct = await firstSightingOfWebhookDelivery(ORG, "hook-a", "key-2", { now: () => new Date(NOW_MS + 1_000) });
  ok(distinct === true, "D: a DIFFERENT replayKey in the same window is never treated as a duplicate");

  const ttlMs = webhookReplayNonceTtlMs();
  const afterExpiry = await firstSightingOfWebhookDelivery(ORG, "hook-a", "key-1", { now: () => new Date(NOW_MS + ttlMs + 1_000) });
  ok(afterExpiry === true, "C: past the nonce's TTL, the identical pair is a first sighting again (re-acceptance after expiry)");

  ok(
    webhookReplayStoreKey("hook-a", "key-1") === `${WEBHOOK_REPLAY_KEY_PREFIX}hook-a:key-1`,
    "the store key is namespaced by hook id, then the opaque replayKey",
  );
}

{
  const sharedKey = "shared-secret-collision";
  const hookAFirst = await firstSightingOfWebhookDelivery(ORG, "hook-shared-a", sharedKey, { now: () => new Date(NOW_MS + 50_000) });
  ok(hookAFirst === true, "G: hook A's first delivery under a shared replayKey is a first sighting");
  const hookBFirst = await firstSightingOfWebhookDelivery(ORG, "hook-shared-b", sharedKey, { now: () => new Date(NOW_MS + 50_000) });
  ok(hookBFirst === true, "G: hook B's first delivery under the SAME replayKey is ALSO a first sighting — two hooks that happen to share a secret (config.ts places no cross-hook uniqueness on secretRef) do not collide");
  const hookAReplay = await firstSightingOfWebhookDelivery(ORG, "hook-shared-a", sharedKey, { now: () => new Date(NOW_MS + 50_000) });
  ok(hookAReplay === false, "G: …but hook A's OWN second delivery is still correctly refused");
}

{
  resetWebhookReplayWarnLatchForTest();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  try {
    const throwingMarkSeen = async (): Promise<boolean> => {
      throw new Error("operational store unreachable");
    };
    const secretLookingReplayKey = "deadbeef".repeat(8);
    const first = await firstSightingOfWebhookDelivery(ORG, "hook-f", secretLookingReplayKey, { markSeen: throwingMarkSeen });
    ok(first === true, "F: a throwing store FAILS OPEN — treated as first-seen rather than blocking the delivery");
    const second = await firstSightingOfWebhookDelivery(ORG, "hook-f", secretLookingReplayKey, { markSeen: throwingMarkSeen });
    ok(second === true, "F: a SECOND call against the still-broken store also fails open (an outage never turns into a silent single-fire cliff)");
  } finally {
    console.warn = originalWarn;
  }
  ok(warnings.length === 1, "F: two consecutive store failures produce exactly ONE warning — visibility without a log flood (the warn-once latch)");
  ok(!warnings[0]!.includes("deadbeef"), "F: the warning never includes the replayKey itself — a store-outage log line carries no key material, hashed or not");
}

{
  ok(webhookReplayNonceTtlMs() === (300 * 2 + 60) * 1000, "H: retention is 2×300s skew + 60s slack = 660 000ms");
  ok(webhookReplayNonceTtlMs() === (webhookMaxSkewSeconds() * 2 + 60) * 1000, "H: retention is derived from the gate's skew constant, not a second copy of it");
}

{
  const rawBody = JSON.stringify({ deploy: "ok" });
  const MSG = "msg_replay_dedupe";
  const sig = standardWebhookSignature(SECRET, MSG, NOW_TS, rawBody);
  const replayKeyA = standardWebhookReplayKey(MSG);
  const replayKeyB = standardWebhookReplayKey(MSG);
  ok(replayKeyA === replayKeyB, "I: replaying the IDENTICAL delivery id always derives the identical replayKey — the property the dedupe store depends on");

  ok(standardWebhookReplayKey(MSG + "-other") !== replayKeyA, "I: a different delivery id derives a DIFFERENT replayKey");

  ok(
    standardWebhookReplayKey("msg_same_second_a") !== standardWebhookReplayKey("msg_same_second_b"),
    "🔴 I: two identical payloads sent in the same second under DIFFERENT delivery ids are DIFFERENT deliveries, not a collision",
  );
  ok(standardWebhookReplayKey(MSG) === replayKeyA, "🔴 I: a re-signer cannot walk around the mark by re-stamping — the timestamp is NOT part of the key");

  const resolved = await standardWebhookVerifier.verify({
    rawBody,
    headers: new Headers({ [SW_ID_HEADER]: MSG, [SW_TIMESTAMP_HEADER]: NOW_TS, [SW_SIGNATURE_HEADER]: sig }),
    keys: [SECRET],
    nowMs: NOW_MS,
  });
  ok(resolved.ok && resolved.replayKey === replayKeyA, "I: the LIVE verifier's accepted verdict carries the same replayKey the standalone function derives");
}

{
  resetWebhookVerifiersForTest();
  const untimestamped: Verifier = {
    source: "untimestamped-vendor",
    keyKind: "shared-secret",
    keyOrigin: "vendor-issued",
    signedTimestamp: false,
    verify(): Verdict {
      return { ok: true, keyIndex: 0, replayKey: "should-never-surface" };
    },
  };
  registerWebhookVerifier(untimestamped);
  registerWebhookVerifier(standardWebhookVerifier);

  const hook = defineWebhook({
    id: "vendor-hook",
    source: "untimestamped-vendor",
    secretRef: "VENDOR_HOOK_SECRET",
    broker: "env",
    target: "slack/T1/C1",
    readableBy: [{ level: "domain", domain: "eng" }],
    instruction: "handle it",
  });
  const args = {
    hook,
    secretValues: [SECRET],
    rawBody: JSON.stringify({ ok: true }),
    bodyBytes: 100,
    headers: new Headers(),
    nowMs: NOW_MS,
    allowUnverified: false,
    maxBodyBytes: 1024,
  };
  const outcome = await gateWebhookDelivery(args);
  ok(outcome.ok === true, "E: the untimestamped-vendor delivery verifies");
  ok(outcome.ok && outcome.replayKey === undefined, "E: …but the GATE strips replayKey for a signedTimestamp:false verifier, even though the verdict tried to set one — no arbitrary-bounded dedupe masquerading as protection");

  const secondOutcome = await gateWebhookDelivery(args);
  ok(secondOutcome.ok === true && secondOutcome.ok && secondOutcome.replayKey === undefined, "E: a second, identical delivery to the same untimestamped source ALSO verifies with no replayKey — replay against it is genuinely unbounded, not silently patched over");

  resetWebhookVerifiersForTest();
}

console.log(`✓ webhook-replay-dedupe: ${passed} assertions passed`);
