import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-wake-rate-limit-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { divertToUnifiedWindow } from "../agent/channels/unified.js";
import { formatWindowToken } from "../agent/channels/window-key.js";
import { readAudit } from "../agent/audit/audit.js";
import { deploymentOrg } from "../agent/identity/binding.js";
import { RateLimitExhaustedError } from "../agent/channels/rate-limit-retry.js";
import { WAKE_RETRY_ACTION, WAKE_DISPATCH_RETRY_POLICY } from "../agent/channels/wake-timing.js";
import { dispatchNativeWakeWithRetry } from "../agent/channels/native-wake-retry.js";
import { registerSlackFixtureMapper, registerSlackFixtureCodec } from "./_slack-test-stubs.js";
import type { RouteHandlerArgs } from "eve/channels";

registerSlackFixtureMapper();
registerSlackFixtureCodec();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("wake-rate-limit:");

function queueRefusal(): Error {
  const err = new Error("Too many requests — please retry later");
  err.name = "TooManyRequestsError";
  return err;
}

function immediateQueueRefusal(): Error {
  return Object.assign(queueRefusal(), { retryAfter: 0 });
}

const DOMAIN = "payments";
const TOKEN = formatWindowToken({ domain: DOMAIN, windowId: DOMAIN, generation: 1 });
const SURFACE_KEY = "slack/T1/C1";

function scriptedReceive(script: ReadonlyArray<Error | "delivered">): { to: RouteHandlerArgs["to"]; calls: () => number } {
  let calls = 0;
  const to = ((_channel: unknown, _target: unknown) => ({
    async send(): Promise<void> {
      const next = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (next instanceof Error) throw next;
    },
  })) as unknown as RouteHandlerArgs["to"];
  return { to, calls: () => calls };
}

async function wake(wakeId: string, to: RouteHandlerArgs["to"]): Promise<unknown> {
  try {
    await divertToUnifiedWindow(to, {
      message: "<wake>the payout cutoff, please</wake>",
      token: TOKEN,
      window: { wakeId, origin: { platform: "slack", channelId: "C1" }, addressing: "direct-mention" },
      surfaceKey: SURFACE_KEY,
      auth: { attributes: { team_id: "T1", channel_id: "C1" } },
    });
    return undefined;
  } catch (err) {
    return err;
  }
}

async function retryRows(wakeId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await readAudit({ org: deploymentOrg(), action: WAKE_RETRY_ACTION });
  return rows
    .map((r) => r.detail as Record<string, unknown>)
    .filter((d) => d["wakeId"] === wakeId)
    .sort((a, b) => Number(a["attempt"]) - Number(b["attempt"]));
}

{
  const require = createRequire(import.meta.url);
  const evePkg = require.resolve("eve/package.json");
  const world = `${dirname(evePkg)}/dist/src/compiled/@workflow/world-vercel/index.js`;
  const haystack = readFileSync(world, "utf8");
  ok(
    haystack.includes("TooManyRequestsError"),
    "🔴 §1 pin: eve still names its 429 error class TooManyRequestsError — if this is RED, eve renamed it and isRateLimitThrow no longer matches a rate-limited wake",
  );
  ok(
    haystack.includes("`send message`"),
    "🔴 §1 pin: eve's queue client still names the `send message` operation this road wraps — if this is RED the queue client was reshaped and the premise needs re-reading (this checks the literal, not the call graph)",
  );
}

{
  const before = (await retryRows("w-accept")).length;
  eq(before, 0, "§2 precondition: this wake has no retry rows yet, so the green below cannot be vacuous");

  const { to, calls } = scriptedReceive([queueRefusal(), "delivered"]);
  const threw = await wake("w-accept", to);

  ok(threw === undefined, "🔴 §2: a wake refused ONCE is NOT dropped — the divert resolves, so the turn starts");
  eq(calls(), 2, "🔴 §2: the dispatch was repeated exactly once — the refusal, then the delivery");

  const rows = await retryRows("w-accept");
  eq(rows.length, 1, "🔴 §2: the refusal left exactly one `surface.wake_retry` row — a retried wake is tellable apart from a clean one");
  eq(rows[0]?.["attempt"], 1, "§2: the row names WHICH attempt was refused");
  eq(rows[0]?.["outcome"], "retrying", "§2: …and that it was retried rather than given up on");
  eq(rows[0]?.["refusalStatus"], 429, "§2: …and the status the vendor refused with");
  eq(rows[0]?.["surfaceKey"], SURFACE_KEY, "§2: …partitioned to the surface whose member is waiting");
  eq(rows[0]?.["delayMs"], WAKE_DISPATCH_RETRY_POLICY.fallbackMs, "🔴 §2: the wait is the wake policy's own fallback — eve's queue error names no Retry-After, so the fallback IS this road's normal wait");
  ok(typeof rows[0]?.["deliveryId"] === "string", "§2: the row carries the delivery nonce, so it joins to the ingress row");
  ok(!Object.keys(rows[0] ?? {}).some((k) => JSON.stringify(rows[0]?.[k]).includes("payout")), "🔴 §2: the row carries NO part of the member's message");
}

{
  const { to, calls } = scriptedReceive([new Error("socket hang up"), "delivered"]);
  const threw = await wake("w-transport", to);
  ok(threw instanceof Error && threw.message === "socket hang up", "🔴 §3: a transport throw propagates unchanged on the FIRST attempt");
  eq(calls(), 1, "🔴 §3: …and is never repeated");
  eq((await retryRows("w-transport")).length, 0, "🔴 §3: …and writes no retry row");
}
{
  const denied = Object.assign(new Error("not_in_channel"), { status: 403 });
  const { to, calls } = scriptedReceive([denied, "delivered"]);
  const threw = await wake("w-denied", to);
  ok(threw === denied, "🔴 §3: a permission denial propagates as the SAME error object");
  eq(calls(), 1, "🔴 §3: …on one attempt");
  eq((await retryRows("w-denied")).length, 0, "🔴 §3: …and writes no retry row");
}
{
  const { to, calls } = scriptedReceive(["delivered"]);
  const threw = await wake("w-clean", to);
  ok(threw === undefined, "§3: a wake nothing refuses is delivered");
  eq(calls(), 1, "§3: …on one attempt");
  eq((await retryRows("w-clean")).length, 0, "🔴 §3 (negative control): …and writes NO retry row — a clean wake must not look like a retried one");
}

{
  const { to, calls } = scriptedReceive([queueRefusal()]);
  const threw = await wake("w-exhausted", to);

  ok(threw instanceof RateLimitExhaustedError, "🔴 §4: a queue that never lets up ends in the NAMED failure, not an unexplained drop");
  eq(calls(), WAKE_DISPATCH_RETRY_POLICY.maxAttempts, "🔴 §4: the attempt bound is real — the dispatch is tried exactly maxAttempts times");
  ok(
    String((threw as Error).message).includes(`${WAKE_DISPATCH_RETRY_POLICY.maxAttempts} attempts`),
    "🔴 §4: the message NAMES the attempts — this string is what the surface's own `surface.wake_failed` row carries",
  );

  const rows = await retryRows("w-exhausted");
  eq(rows.length, WAKE_DISPATCH_RETRY_POLICY.maxAttempts, "🔴 §4: every refusal left a row, the last one included");
  eq(rows.map((r) => r["outcome"]), [...Array(WAKE_DISPATCH_RETRY_POLICY.maxAttempts - 1).fill("retrying"), "exhausted"], "🔴 §4: the rows read `retrying` until the last, which reads `exhausted` — the shape an operator greps for before a wake_failed");
  eq(rows[rows.length - 1]?.["delayMs"], 0, "§4: the exhausted row waits nothing, and says so");
}

{
  const surfaceKey = "discord/G_NATIVE/C_NATIVE";
  let calls = 0;
  await dispatchNativeWakeWithRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw immediateQueueRefusal();
      return "delivered";
    },
    { platform: "discord", workspace: "G_NATIVE", surfaceKey },
  );
  eq(calls, 2, "🔴 §5 native: a refused queue launch is repeated exactly once, then settles");
  const nativeRows = (await readAudit({ org: deploymentOrg(), action: WAKE_RETRY_ACTION }))
    .map((r) => r.detail as Record<string, unknown>)
    .filter((d) => d["surfaceKey"] === surfaceKey);
  eq(nativeRows.length, 1, "🔴 §5 native: the refusal leaves one retry row under the real native surface");
  ok(typeof nativeRows[0]?.["deliveryId"] === "string", "🔴 §5 native: the row carries a host-minted deliveryId for this dispatch");
  ok(!("wakeId" in (nativeRows[0] ?? {})), "🔴 §5 native: the row omits wakeId — this road has no ingress/turn join to claim");
}
{
  const transport = new Error("socket hang up");
  let calls = 0;
  let threw: unknown;
  try {
    await dispatchNativeWakeWithRetry(
      async () => {
        calls += 1;
        throw transport;
      },
      { platform: "notion", workspace: "W_NATIVE", surfaceKey: "notion/W_NATIVE/P_NATIVE" },
    );
  } catch (err) {
    threw = err;
  }
  ok(threw === transport, "🔴 §5 native: an ambiguous transport throw propagates unchanged");
  eq(calls, 1, "🔴 §5 native: an ambiguous transport throw gets exactly one attempt");
}
{
  let calls = 0;
  let threw: unknown;
  try {
    await dispatchNativeWakeWithRetry(
      async () => {
        calls += 1;
        throw immediateQueueRefusal();
      },
      { platform: "github", workspace: "acme", surfaceKey: "github/acme/native" },
    );
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof RateLimitExhaustedError, "🔴 §5 native: exhaustion is an explicit named failure");
  eq(calls, WAKE_DISPATCH_RETRY_POLICY.maxAttempts, "🔴 §5 native: exhaustion stops at the shared wake attempt bound");
  const rows = (await readAudit({ org: deploymentOrg(), action: WAKE_RETRY_ACTION }))
    .map((r) => r.detail as Record<string, unknown>)
    .filter((d) => d["surfaceKey"] === "github/acme/native");
  eq(new Set(rows.map((r) => r["deliveryId"])).size, 1, "🔴 §5 native: every refused attempt shares one stable deliveryId");
  eq(rows.filter((r) => r["outcome"] === "exhausted").length, 1, "🔴 §5 native: the final row states exhaustion explicitly");
}

{
  const src = readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8");
  ok(
    /withRetryAfterThrown\(\s*\(\)\s*=>\s*receive\(channel, target\)\.send\(/.test(src),
    "🔴 §5: the ONE cross-surface dispatch still goes through the shared road — unwrap it and every surface silently loses its wake backoff",
  );
  const dispatchAt = src.indexOf("const deliveredAuth = auth;");
  ok(dispatchAt > 0, "§5: the slice anchor `const deliveredAuth = auth;` is still in unified.ts — without it the check below reads nothing and passes vacuously");
  ok(
    !/setTimeout\(|new Promise\(\s*\(resolve\)\s*=>/.test(src.slice(dispatchAt)),
    "🔴 §5: …and the dispatch grew no backoff of its own beside it — one road, not two",
  );

  const receiveBody = src.slice(src.indexOf("async receive(input, { from })"), src.indexOf("  events: {", src.indexOf("async receive(input, { from })")));
  ok(receiveBody.length > 1000 && receiveBody.includes("from(t.token).send("), "§5: the slice is the real `receive` body, ending at its one send");
  ok(
    !/\bcatch\b/.test(receiveBody.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")),
    "🔴 §5: the unified `receive` holds no `catch` (OPE-2389 deleted the answer leg's) — nothing inside it can swallow a rate-limit refusal",
  );

}

console.log(`✓ wake-rate-limit: ${n} assertions passed (eve live pin, windowed and native retries, negative controls, bounded exhaustion, the one road)`);
