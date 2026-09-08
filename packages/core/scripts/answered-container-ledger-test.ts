
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

const dir = join(tmpdir(), `open-everywhere-answered-container-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerSlackFixtureCodec } = await import("./_slack-test-stubs.js");
registerSlackFixtureCodec();

const { recordContainerAnswered, containerAnsweredSince, answeredContainerKey, ANSWERED_CONTAINER_KEY_PREFIX, ANSWERED_CONTAINER_TTL_MS } = await import(
  "../agent/channels/answered-container-ledger.js"
);

type UnifiedWakeOrigin = import("../agent/channels/unified-window.js").UnifiedWakeOrigin;

const ORG = "acme";
const answeringWake: UnifiedWakeOrigin = { platform: "slack", channelId: "C_SOAK" };
const siblingWake: UnifiedWakeOrigin = { platform: "slack", channelId: "C_SOAK", threadTs: "111.2" };
const otherRoom: UnifiedWakeOrigin = { platform: "slack", channelId: "C_OTHER" };

const iso = (ms: number): string => new Date(ms).toISOString();

{
  const T0 = Date.now() - 30_000;
  const T1 = T0 + 15_000;
  const T2 = T1 + 3_000;

  ok(
    (await containerAnsweredSince(ORG, siblingWake, iso(T0), { now: () => T2 })) === false,
    "§1 pre-state: with NO answer on record the container reads FALSE — the close carries OPE-884's silence line",
  );

  await recordContainerAnswered(ORG, answeringWake, { now: () => T1 });

  ok(
    (await containerAnsweredSince(ORG, siblingWake, iso(T0), { now: () => T2 })) === true,
    "🔴 §1 THE DEFECT: an answer recorded in an EARLIER turn is still readable from a SIBLING wake's origin — the per-turn record could not do this",
  );
  ok(
    (await containerAnsweredSince(ORG, answeringWake, iso(T0), { now: () => T2 })) === true,
    "§1 the ledger is keyed on the CONTAINER, so either wake's origin resolves the same room",
  );
}

{
  const ANSWERED_AT = Date.now() - 120_000;
  const WROTE_AT = ANSWERED_AT + 60_000;
  const NOW = WROTE_AT + 5_000;
  const room: UnifiedWakeOrigin = { platform: "slack", channelId: "C_STALE" };

  await recordContainerAnswered(ORG, room, { now: () => ANSWERED_AT });

  ok(
    (await containerAnsweredSince(ORG, room, iso(WROTE_AT), { now: () => NOW })) === false,
    "🔴 §2 NEGATIVE CONTROL: an answer that landed BEFORE this wake arrived reads FALSE — a stale answer never speaks for a new ask",
  );
  ok(
    (await containerAnsweredSince(ORG, room, iso(ANSWERED_AT - 1_000), { now: () => NOW })) === true,
    "§2 the SAME row reads TRUE for a wake that arrived before the answer — the arrival stamp is the only difference",
  );
}

{
  const T0 = Date.now() - 20_000;
  const NOW = Date.now();
  await recordContainerAnswered(ORG, answeringWake, { now: () => NOW - 5_000 });

  ok(
    (await containerAnsweredSince(ORG, otherRoom, iso(T0), { now: () => NOW })) === false,
    "🔴 §3 NEGATIVE CONTROL: another CONTAINER reads false — the answer is not visible in that room",
  );
  ok(
    (await containerAnsweredSince("other-org", answeringWake, iso(T0), { now: () => NOW })) === false,
    "🔴 §3 NEGATIVE CONTROL: another ORG reads false — the ledger row is org-partitioned",
  );
}

{
  const room: UnifiedWakeOrigin = { platform: "slack", channelId: "C_REFRESH" };
  const FIRST = Date.now() - 300_000;
  const WROTE_AT = FIRST + 120_000;
  const SECOND = WROTE_AT + 30_000;
  const NOW = SECOND + 5_000;

  await recordContainerAnswered(ORG, room, { now: () => FIRST });
  ok(
    (await containerAnsweredSince(ORG, room, iso(WROTE_AT), { now: () => NOW })) === false,
    "§4 setup: after the FIRST answer only, a wake that arrived later reads false",
  );

  await recordContainerAnswered(ORG, room, { now: () => SECOND });
  ok(
    (await containerAnsweredSince(ORG, room, iso(WROTE_AT), { now: () => NOW })) === true,
    "🔴 §4 THE FORGET IS LOAD-BEARING: the SECOND answer moves the stamp forward — a plain markEventSeen would keep the first and read false",
  );
}

{
  const NOW = Date.now();
  const SINCE = iso(NOW - 10_000);
  await recordContainerAnswered(ORG, answeringWake, { now: () => NOW - 5_000 });

  ok((await containerAnsweredSince(undefined, answeringWake, SINCE, { now: () => NOW })) === false, "§5 fail-soft: no org reads false");
  ok((await containerAnsweredSince(ORG, answeringWake, undefined, { now: () => NOW })) === false, "§5 fail-soft: no wake stamp reads false");
  ok((await containerAnsweredSince(ORG, answeringWake, "not-a-date", { now: () => NOW })) === false, "§5 fail-soft: a malformed wake stamp reads false");
  ok(
    (await containerAnsweredSince(ORG, answeringWake, iso(NOW + 60_000), { now: () => NOW })) === false,
    "🔴 §5 fail-soft: a wake stamped in the FUTURE reads false — a clock skew must never manufacture an answer",
  );
  ok(
    (await containerAnsweredSince(ORG, answeringWake, SINCE, {
      now: () => NOW,
      hasEventSeen: async () => {
        throw new Error("store down");
      },
    })) === false,
    "🔴 §5 fail-soft: a THROWING store reads false — an unreadable ledger renders the pre-OPE-922 line, never a claimed answer",
  );
  let threw = false;
  await recordContainerAnswered(ORG, answeringWake, {
    now: () => NOW,
    forgetEventSeen: async () => {
      throw new Error("store down");
    },
    markEventSeen: async () => {
      throw new Error("store down");
    },
  }).catch(() => {
    threw = true;
  });
  ok(threw === false, "🔴 §5 fail-soft: recordContainerAnswered NEVER throws — the reply has already landed, a ledger miss must not become a tool error");
  ok((await recordContainerAnswered(undefined, answeringWake, { now: () => NOW })) === undefined, "§5 a blank org records nothing and returns cleanly");
}

{
  const room: UnifiedWakeOrigin = { platform: "slack", channelId: "C_CEILING" };
  const NOW = Date.now();
  await recordContainerAnswered(ORG, room, { now: () => NOW - (ANSWERED_CONTAINER_TTL_MS - 60_000) });
  ok(
    (await containerAnsweredSince(ORG, room, iso(NOW - 10 * ANSWERED_CONTAINER_TTL_MS), { now: () => NOW })) === true,
    "§6 setup: an answer INSIDE the ceiling is readable, and it answers for a wake older than itself",
  );

  const stale: UnifiedWakeOrigin = { platform: "slack", channelId: "C_CEILING_STALE" };
  await recordContainerAnswered(ORG, stale, { now: () => NOW - (ANSWERED_CONTAINER_TTL_MS + 300_000) });
  ok(
    (await containerAnsweredSince(ORG, stale, iso(NOW - 10 * ANSWERED_CONTAINER_TTL_MS), { now: () => NOW })) === false,
    "🔴 §6 the read window is CLAMPED to ANSWERED_CONTAINER_TTL_MS — an answer past the ceiling is invisible however old the wake asking is",
  );
  ok(
    (await containerAnsweredSince(ORG, stale, iso(NOW - 10 * ANSWERED_CONTAINER_TTL_MS), { now: () => NOW - ANSWERED_CONTAINER_TTL_MS })) === true,
    "🔴 §6 the SAME row reads TRUE when `now` sits inside its window — the bound is the clock at read time, not an eviction",
  );
}

{
  ok((answeredContainerKey(answeringWake) ?? "").startsWith(`${ANSWERED_CONTAINER_KEY_PREFIX}slack:`), "§7 the key is namespaced and names its platform in the clear");
  ok(answeredContainerKey(answeringWake) !== answeredContainerKey(otherRoom), "§7 a different container is a different key");
  ok(
    answeredContainerKey(siblingWake) === answeredContainerKey(answeringWake),
    "🔴 §7 the key is the CONTAINER, not the thread — a threaded reply and a top-level one answer the same room",
  );
  ok(answeredContainerKey({ platform: "nosuch" } as unknown as UnifiedWakeOrigin) === null, "§7 an UNREGISTERED platform has NO key — the derivation answers null instead of inventing one");
  ok(
    (await containerAnsweredSince(ORG, { platform: "nosuch" } as unknown as UnifiedWakeOrigin, iso(Date.now() - 5_000))) === false,
    "🔴 §7 fail-soft: an unregistered platform reads FALSE rather than throwing out of the close gate",
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ answered-container-ledger: ${passed} assertions passed`);
