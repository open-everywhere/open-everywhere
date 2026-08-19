process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAudit } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import type { OperationalStore } from "../agent/operational/store.js";
import { EVENT_DEDUPE_MAX_RETENTION_MS } from "../agent/operational/store.js";
import {
  claimRuntimeRotation,
  runtimeRotationClaimKey,
  EVE_RUNTIME_VERSION,
  RUNTIME_ROTATION_AUDIT_ACTION,
  RUNTIME_ROTATION_PRINCIPAL,
} from "../agent/channels/runtime-rotation.js";
import { rotationTrigger, shouldRotate } from "../agent/channels/turn-delivery.js";
import { getOrCreateDmSeat } from "../agent/channels/dm-seat.js";
import { dmWindowRegistryKey } from "../agent/channels/unified-supervisor.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "acme";

{
  const installed = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules/eve/package.json"), "utf8")) as { version?: unknown };
  eq(
    EVE_RUNTIME_VERSION,
    installed.version,
    "🔴 EVE_RUNTIME_VERSION equals the INSTALLED eve version — a stale constant leaves every standing session stranded after a bump, silently and with no audit row",
  );
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  eq(EVE_RUNTIME_VERSION, root.dependencies?.eve, "…and the version the root package.json pins");
  ok(/^\d+\.\d+\.\d+/.test(EVE_RUNTIME_VERSION), "…and it is a real version string, not an empty placeholder");
}

{
  const key = runtimeRotationClaimKey("oe-domain::payments");
  ok(key.includes(EVE_RUNTIME_VERSION), "🔴 the claim key carries the eve version — this is the entire heal trigger");
  ok(key.includes("oe-domain::payments"), "…and the seat's registry key, so the claim is per-window");
  eq(key, `oe-runtime-rotation:${EVE_RUNTIME_VERSION}:oe-domain::payments`, "…in the exact documented shape");
  ok(
    runtimeRotationClaimKey("oe-domain::a") !== runtimeRotationClaimKey("oe-domain::b"),
    "two seats get two keys — one window's heal must never consume another's",
  );
  ok(
    !runtimeRotationClaimKey("oe-domain::payments").startsWith("silent:"),
    "…and it is namespaced away from the `notice_claim` table's other tenant (the external-room silent notices)",
  );
}

{
  const REG = "oe-domain::e2e-window";
  const at = "2026-08-15T12:00:00.000Z";
  const scope = { org: ORG, registryKey: REG, surfaceKey: "slack/T1/C1", atIso: at };

  const first = await claimRuntimeRotation(scope);
  ok(first, "🔴 the FIRST wake to a seat under this eve build WINS the claim — the caller must rotate");

  const second = await claimRuntimeRotation({ ...scope, atIso: "2026-08-15T12:00:01.000Z" });
  eq(second, false, "🔴 the SECOND wake LOSES it — one rotation per window per bump, not a rotation per wake");

  const other = await claimRuntimeRotation({ ...scope, registryKey: "oe-domain::other-window" });
  ok(other, "a DIFFERENT window still wins its own claim — the claim is per-seat, not per-deployment");

  const rows = await readAudit({ org: ORG, action: RUNTIME_ROTATION_AUDIT_ACTION });
  eq(rows.length, 2, "🔴 exactly one audit row per WON claim — the loser writes nothing");
  const row = rows.find((r) => r.detail?.registryKey === REG);
  ok(row !== undefined, "…and the winner's row names the seat it retired");
  eq(row?.detail?.eveVersion, EVE_RUNTIME_VERSION, "…and the eve build that caused it");
  eq(row?.principalId, RUNTIME_ROTATION_PRINCIPAL, "…stamped with the synthetic service principal (no human acted)");
  eq(row?.platform, "slack", "…partitioned by the woken surface's platform…");
  eq(row?.workspace, "T1", "…workspace…");
  eq(row?.surface, "C1", "…and surface, so an operator can find it from the channel");
  ok(
    typeof row?.detail?.note === "string" && (row.detail.note as string).includes("in-context state"),
    "…and the row SAYS the generation's in-context state was dropped — the rotation is a real cost, stated",
  );

  const throwing = {
    async claimNotice(): Promise<boolean> {
      throw new Error("store blip");
    },
  } as unknown as Pick<OperationalStore, "claimNotice">;
  const soft = await claimRuntimeRotation({ ...scope, registryKey: "oe-domain::blip" }, { store: throwing });
  eq(soft, false, "🔴 a store error FAILS SOFT to false — a blip must cost a delay, never a healthy generation's context");
  const afterBlip = await readAudit({ org: ORG, action: RUNTIME_ROTATION_AUDIT_ACTION });
  eq(afterBlip.length, 2, "…and writes no audit row: nothing was retired");
}

{
  const REG = "oe-domain::permanence";
  const t0 = Date.parse("2026-08-15T12:00:00.000Z");
  const scope = { org: ORG, registryKey: REG, surfaceKey: "slack/T1/C9" };

  ok(await claimRuntimeRotation({ ...scope, atIso: new Date(t0).toISOString() }), "the seat wins its first claim");

  const wayLater = new Date(t0 + EVENT_DEDUPE_MAX_RETENTION_MS * 40).toISOString();
  const again = await claimRuntimeRotation({ ...scope, atIso: wayLater });
  eq(
    again,
    false,
    `🔴 the claim is still held ${EVENT_DEDUPE_MAX_RETENTION_MS * 40}ms later — it must NOT expire. A TTL'd primitive here rotates every window every 24 h forever (OPE-345 violation)`,
  );

  const store = getOperationalStore();
  const dedupeKey = "runtime-rotation-permanence-probe";
  ok(await store.markEventSeen(ORG, dedupeKey, new Date(t0).toISOString(), 60_000), "control: markEventSeen marks a fresh key");
  ok(
    await store.markEventSeen(ORG, dedupeKey, wayLater, 60_000),
    "🔴 control: the SAME key marks TRUE again past the 24 h ceiling — proof that markEventSeen cannot express this feature's 'once'",
  );
}

{
  const healthy = { createdAt: "2026-08-15T12:00:00.000Z", lastWakeAt: "2026-08-15T12:00:00.000Z", turnCount: 0, inputTokensTotal: 0 };
  const now = "2026-08-15T12:00:01.000Z";
  eq(rotationTrigger(healthy, now, { runtimeChanged: true }), "runtime-changed", "🔴 the flag rotates a row that trips no other rung, and NAMES why");
  eq(rotationTrigger(healthy, now, { runtimeChanged: false }), null, "🔴 NEGATIVE CONTROL: false resumes the SAME row — the flag is the only difference");
  eq(rotationTrigger(healthy, now, {}), null, "…and absent is byte-identical to the pre-OPE-599 chain");
  eq(shouldRotate(healthy, now, { runtimeChanged: true }), true, "the boolean face agrees…");
  eq(shouldRotate(healthy, now, { runtimeChanged: false }), false, "…in both directions");
  const nullCounter = { ...healthy, inputTokensTotal: null };
  eq(rotationTrigger(nullCounter, now, { runtimeChanged: true }), "runtime-changed", "the runtime rung is FIRST — it outranks the NULL-counter fail-safe");

  const SURFACE = "slack/T1/D0RUNTIME";
  const store = getOperationalStore();
  const REG = dmWindowRegistryKey(SURFACE);
  const at = "2026-08-15T12:00:00.000Z";
  await store.rotateChannelSession(ORG, REG, "seed-token-g1", at);
  ok(!shouldRotate((await store.getChannelSession(ORG, REG))!, at), "precondition: the seeded generation trips NO ordinary rotation trigger");

  const healed = await getOrCreateDmSeat(ORG, { surfaceKey: SURFACE }, at);
  eq(healed.generation, 2, "🔴 THE FIX: the first wake after the eve build changed ROTATES the seat, so the wake lands in a session the runtime can read");
  ok(healed.token !== "seed-token-g1", "…on a genuinely new continuation token (a new eve session), not the stranded one");
  eq(healed.freshGeneration, true, "…flagged fresh, so the wake re-carries context");

  const resumed = await getOrCreateDmSeat(ORG, { surfaceKey: SURFACE }, "2026-08-15T12:00:02.000Z");
  eq(resumed.generation, 2, "🔴 NEGATIVE CONTROL: the SECOND wake RESUMES — the heal is one-shot, not a rotation on every wake");
  eq(resumed.token, healed.token, "…on the same token the heal minted");

  const FRESH = "slack/T1/D0FRESHSEAT";
  const minted = await getOrCreateDmSeat(ORG, { surfaceKey: FRESH }, at);
  eq(minted.generation, 1, "a seat with no row mints generation 1");
  const next = await getOrCreateDmSeat(ORG, { surfaceKey: FRESH }, "2026-08-15T12:00:02.000Z");
  eq(next.generation, 1, "🔴 …and its NEXT wake resumes it: the mint arm consumed the claim, so a new seat is never healed away");
}

{
  const sites = [
    "packages/core/agent/channels/dm-seat.ts",
    "packages/providers/slack/agent/channels/slack-events.ts",
    "packages/providers/github/agent/channels/github.ts",
    "packages/providers/linear/agent/channels/linear.ts",
    "packages/providers/notion/agent/channels/notion.ts",
    "packages/providers/teams/agent/channels/teams-front.ts",
    "packages/providers/discord/agent/channels/discord-gateway.ts",
  ];
  for (const rel of sites) {
    let src: string;
    try {
      src = readFileSync(join(REPO_ROOT, rel), "utf8");
    } catch {
      ok(false, `${rel} no longer exists — re-point this list at the module that resolves that standing seat, or drop the entry with a reason`);
      continue;
    }
    const claimAt = src.indexOf("const runtimeChanged");
    const readAt = src.indexOf("getChannelSession(");
    ok(src.includes("claimRuntimeRotation"), `🔴 ${rel} claims the OPE-599 runtime rotation — without it this seat stays stranded after every eve bump, silently`);
    ok(claimAt >= 0, `🔴 ${rel} resolves the verdict into a \`runtimeChanged\` binding`);
    ok(/shouldRotate\(.*runtimeChanged/.test(src), `🔴 ${rel} passes that verdict into the rotation chain (a claim whose boolean is dropped heals nothing)`);
    ok(readAt >= 0 && claimAt < readAt, `🔴 ${rel} claims BEFORE it reads the registry row — a claim made after it leaves the mint arm unconsumed (§5c)`);
  }
}

{
  const rel = "packages/core/agent/routines/fire-window.ts";
  const src = readFileSync(join(REPO_ROOT, rel), "utf8");
  const claimAt = src.indexOf("const runtimeChanged");
  const healAt = src.indexOf("const healed");
  const planAt = src.indexOf("const plan = planFor(");
  ok(src.includes("claimRuntimeRotation"), `🔴 ${rel} claims the runtime rotation — without it a cron fire after an eve bump dies in a stranded session, silently`);
  ok(claimAt >= 0 && healAt > claimAt, `🔴 ${rel} resolves the verdict into a \`runtimeChanged\` binding and consumes it (a claim whose boolean is dropped heals nothing)`);
  ok(planAt > healAt, `🔴 ${rel} heals BEFORE it mints the fire's token — a heal after that mint cannot change the session the fire is dispatched into`);
  ok(/planFor\(healed \?\?/.test(src), `🔴 ${rel} builds the token from the HEALED generation, so the fire cannot ride back onto the generation it is healing away from`);
}

{
  const lint = readFileSync(join(REPO_ROOT, "scripts/eve-patch-lint.ts"), "utf8");
  ok(lint.includes("EVE_RUNTIME_VERSION"), "🔴 lint:eve-patch still pins EVE_RUNTIME_VERSION — it is the only gate that catches a stale constant");
  ok(lint.includes("runtime-rotation.ts"), "…and still names the module the constant lives in");
}

console.log(`✓ runtime-rotation: ${n} assertions passed (OPE-599 pre-dispatch heal: claim, permanence, chain rung, eight live call sites)`);
