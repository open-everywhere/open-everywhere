process.env.OE_SQLITE_PATH = ":memory:";
delete process.env.VERCEL_DEPLOYMENT_ID;

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAudit } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import type { OperationalStore } from "../agent/operational/store.js";
import { EVENT_DEDUPE_MAX_RETENTION_MS } from "../agent/operational/store.js";
import {
  claimRuntimeRotation,
  runtimeRotationClaimKey,
  EVE_RUNTIME_VERSION,
  RUNTIME_DEPLOYMENT_ID,
  RUNTIME_ROTATION_AUDIT_ACTION,
  RUNTIME_ROTATION_CLAIM_RETENTION_MS,
  RUNTIME_ROTATION_GENERATION_PREFIX,
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
  ok(key.includes(EVE_RUNTIME_VERSION), "🔴 the claim key carries the eve version — half of the heal trigger");
  ok(key.includes(RUNTIME_DEPLOYMENT_ID), "🔴 OPE-1751: …and the DEPLOYMENT id — the half that fires on every ship");
  ok(key.includes("oe-domain::payments"), "…and the seat's registry key, so the claim is per-window");
  eq(key, `oe-runtime-rotation:${EVE_RUNTIME_VERSION}:${RUNTIME_DEPLOYMENT_ID}:oe-domain::payments`, "…in the exact documented shape");
  eq(key.startsWith(RUNTIME_ROTATION_GENERATION_PREFIX), true, "…and it is inside the running generation's prefix, which is what the housekeeping sweep protects (§4b)");
  ok(
    runtimeRotationClaimKey("oe-domain::a") !== runtimeRotationClaimKey("oe-domain::b"),
    "two seats get two keys — one window's heal must never consume another's",
  );
  ok(
    !runtimeRotationClaimKey("oe-domain::payments").startsWith("silent:"),
    "…and it is namespaced away from the `notice_claim` table's other tenant (the external-room silent notices)",
  );

  eq(process.env.VERCEL_DEPLOYMENT_ID, undefined, "precondition: the suite pinned VERCEL_DEPLOYMENT_ID unset before the imports…");
  eq(RUNTIME_DEPLOYMENT_ID, "local", "…so the deployment identity reads `local` — never empty, which would silently collapse two segments into one");

  const asDeployment = async (id: string, tag: string): Promise<string> => {
    const before = process.env.VERCEL_DEPLOYMENT_ID;
    process.env.VERCEL_DEPLOYMENT_ID = id;
    try {
      const mod = (await import(`../agent/channels/runtime-rotation.js?deployment=${tag}`)) as { runtimeRotationClaimKey: (k: string) => string };
      return mod.runtimeRotationClaimKey("oe-domain::payments");
    } finally {
      if (before === undefined) delete process.env.VERCEL_DEPLOYMENT_ID;
      else process.env.VERCEL_DEPLOYMENT_ID = before;
    }
  };
  const onOldDeploy = await asDeployment("dpl_OLDBUILD", "old");
  const onNewDeploy = await asDeployment("dpl_NEWBUILD", "new");
  ok(onOldDeploy.includes("dpl_OLDBUILD"), "control: a bundle serving dpl_OLDBUILD really keys on it (the re-import took)");
  ok(onNewDeploy.includes("dpl_NEWBUILD"), "control: …and the second instance really reads the second id");
  ok(
    onOldDeploy !== onNewDeploy,
    "🔴 OPE-1751 THE FIX: the SAME seat under TWO deployments yields TWO claim keys — so the first wake after a ship wins a fresh claim and rotates the seat onto the code that was just shipped",
  );
  eq(
    onOldDeploy.replace("dpl_OLDBUILD", "dpl_NEWBUILD"),
    onNewDeploy,
    "…and the deployment id is the ONLY difference between them — the eve version and the registry key are untouched",
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
  eq(
    row?.detail?.deploymentId,
    RUNTIME_DEPLOYMENT_ID,
    "🔴 OPE-1751: …and the DEPLOYMENT that caused it — without this an operator reading the row cannot tell a ship's rotation from an eve bump's, and cannot tell which build the retired generation was running",
  );
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
  const store = getOperationalStore();
  const now = "2026-08-15T12:00:00.000Z";
  const ancient = new Date(Date.parse(now) - RUNTIME_ROTATION_CLAIM_RETENTION_MS - 60_000).toISOString();
  const fresh = new Date(Date.parse(now) - 60_000).toISOString();

  const RETIRED_OLD = "oe-runtime-rotation:0.1.0:dpl_RETIRED:oe-domain::sweep";
  const RETIRED_RECENT = "oe-runtime-rotation:0.1.0:dpl_RECENT:oe-domain::sweep";
  const CURRENT_OLD = runtimeRotationClaimKey("oe-domain::sweep-current");
  const OTHER_FAMILY = "silent:slack/T1/C-SWEEP:join";
  ok(await store.claimNotice(ORG, RETIRED_OLD, ancient), "seeded: a claim from a RETIRED deployment, older than the retention");
  ok(await store.claimNotice(ORG, RETIRED_RECENT, fresh), "seeded: a claim from another retired deployment, INSIDE the retention");
  ok(await store.claimNotice(ORG, CURRENT_OLD, ancient), "seeded: a claim from the RUNNING generation, older than the retention");
  ok(await store.claimNotice(ORG, OTHER_FAMILY, ancient), "seeded: an ancient claim belonging to a DIFFERENT key family");

  ok(
    await claimRuntimeRotation({ org: ORG, registryKey: "oe-domain::sweep-trigger", surfaceKey: "slack/T1/C-SWEEP", atIso: now }),
    "precondition: the trigger wins its claim — the sweep runs behind a WON claim only, never on every wake",
  );

  eq(await store.noticeClaimed(ORG, RETIRED_OLD), false, "🔴 the sweep DROPS a retired generation's expired claim — this is the bound on the key space");
  eq(
    await store.noticeClaimed(ORG, CURRENT_OLD),
    true,
    "🔴 …and KEEPS the running generation's claim at the same age. Without this a deployment that serves longer than the retention rotates its own seats a second time, for nothing",
  );
  eq(await store.noticeClaimed(ORG, RETIRED_RECENT), true, "🔴 …and keeps a retired generation's claim that is still inside the retention — the age bound is real, not decorative");
  eq(await store.noticeClaimed(ORG, OTHER_FAMILY), true, "🔴 …and never reaches another key family: the silent-notice claims share this table and are permanent");

  const FOREIGN = "oe-runtime-rotation:0.1.0:dpl_RETIRED:oe-domain::foreign";
  ok(await store.claimNotice("globex", FOREIGN, ancient), "seeded: another ORG holds an equally expired retired-generation claim");
  ok(
    await claimRuntimeRotation({ org: ORG, registryKey: "oe-domain::sweep-trigger-2", surfaceKey: "slack/T1/C-SWEEP", atIso: now }),
    "…and a second winning claim in the first org fires the sweep again",
  );
  eq(await store.noticeClaimed("globex", FOREIGN), true, "🔴 the other org's row survives — the sweep is org-scoped, like event_dedupe's");

  {
    const KEEP = "oe-esc:a_b:seat";
    const WILDCARD_TWIN = "oe-esc:aXb:seat";
    const UNRELATED = "oe-esc:zzz:seat";
    ok(await store.claimNotice(ORG, KEEP, ancient), "seeded: an expired claim under the LIVE prefix `oe-esc:a_b:`");
    ok(await store.claimNotice(ORG, WILDCARD_TWIN, ancient), "seeded: an expired claim under `oe-esc:aXb:` — a RETIRED generation the wildcard would match");
    ok(await store.claimNotice(ORG, UNRELATED, ancient), "seeded: an expired claim under an unrelated retired prefix");
    await store.claimNotice(ORG, "oe-esc:a_b:trigger", now, { sweepPrefix: "oe-esc:", keepPrefix: "oe-esc:a_b:", olderThanMs: RUNTIME_ROTATION_CLAIM_RETENTION_MS });
    eq(await store.noticeClaimed(ORG, KEEP), true, "the literal keep-prefix protects its own rows");
    eq(
      await store.noticeClaimed(ORG, WILDCARD_TWIN),
      false,
      "🔴 `_` in the keep-prefix is ESCAPED — `oe-esc:aXb:` is swept. Unescaped it would survive, and a foreign `dpl_…` generation would keep its rows forever",
    );
    eq(await store.noticeClaimed(ORG, UNRELATED), false, "control: the sweep did run over the family, so the assertion above measures the escaping and not an absent delete");
  }
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

{
  const retirementVerb = /\.reset\(/;
  const RETIREMENT_CALL_SITES = ["packages/core/agent/channels/generation-retirement.ts"];
  const CREDENTIAL_CACHE_RESETS = ["teamsGraphToken", "installationToken", "linearAppActorToken"] as const;
  const sourceRoots = [
    "agent",
    "packages/core/agent",
    "packages/adapters/agent",
    ...["discord", "github", "linear", "notion", "slack", "teams"].map((p) => `packages/providers/${p}/agent`),
  ];
  let scanned = 0;
  const scanFile = (abs: string): boolean => {
    const src = readFileSync(abs, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(new RegExp(`\\b(?:${CREDENTIAL_CACHE_RESETS.join("|")})\\.reset\\(`, "g"), "");
    return retirementVerb.test(code);
  };
  const walk = (dir: string, into: string[]): void => {
    for (const e of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "docs" && e.name !== "node_modules") walk(rel, into);
        continue;
      }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".d.ts")) continue;
      scanned++;
      if (scanFile(join(REPO_ROOT, rel))) into.push(rel);
    }
  };
  const offenders: string[] = [];
  for (const root of sourceRoots) walk(root, offenders);
  eq(
    offenders.sort(),
    RETIREMENT_CALL_SITES,
    `🔴 exactly ONE OE source calls eve's session retirement verb, and it is the generation-retirement drain (found: ${offenders.join(", ") || "none"})`,
  );
  const retirement = readFileSync(join(REPO_ROOT, RETIREMENT_CALL_SITES[0]!), "utf8");
  ok(
    /if \(!isUnifiedSupervisorToken\(token\)\) return;/.test(retirement),
    "🔴 the retirement drain still refuses a non-window token — only `unified` seats are ever retired",
  );

  ok(scanned > 200, `NEGATIVE CONTROL: the walk actually read the trees (${scanned} source files scanned)`);
  for (const root of sourceRoots) {
    ok(
      existsSync(join(REPO_ROOT, root)),
      `NEGATIVE CONTROL: the scanned root \`${root}\` exists — a renamed tree must red here, not vanish from the scan`,
    );
  }
  {
    const scratchDir = join(REPO_ROOT, "node_modules", ".oe-scratch");
    mkdirSync(scratchDir, { recursive: true });

    const probeAbs = join(scratchDir, "retirement-probe.ts");
    writeFileSync(
      probeAbs,
      ['// a comment mentioning .reset() must NOT count', 'export async function p(s: { reset: (o: { reason: string }) => Promise<void> }): Promise<void> {', '  await s.reset({ reason: "rotate" });', "}", ""].join("\n"),
    );
    try {
      ok(scanFile(probeAbs), "NEGATIVE CONTROL: a planted `.reset({…})` IS seen through the real comment-stripper");
    } finally {
      unlinkSync(probeAbs);
    }
    const commentOnlyAbs = join(scratchDir, "retirement-probe-comment.ts");
    writeFileSync(commentOnlyAbs, ["// this file only mentions .reset() in a comment", "export const q = 1;", ""].join("\n"));
    try {
      ok(!scanFile(commentOnlyAbs), "NEGATIVE CONTROL: …while a comment-only mention is not — the scan reads code, not prose");
    } finally {
      unlinkSync(commentOnlyAbs);
    }
  }
  const rawSources: string[] = [];
  const collect = (dir: string): void => {
    for (const e of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "docs" && e.name !== "node_modules") collect(rel);
        continue;
      }
      if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) rawSources.push(readFileSync(join(REPO_ROOT, rel), "utf8"));
    }
  };
  for (const root of sourceRoots) collect(root);
  for (const name of CREDENTIAL_CACHE_RESETS) {
    ok(
      rawSources.some((s) => s.includes(`${name}.reset(`)),
      `NEGATIVE CONTROL: \`${name}.reset()\` still exists in the tree — a dead exclusion silently widens this tripwire`,
    );
  }

  const unified = readFileSync(join(REPO_ROOT, "packages/core/agent/channels/unified.ts"), "utf8");
  const slack = readFileSync(join(REPO_ROOT, "packages/providers/slack/agent/channels/slack.ts"), "utf8");
  ok(
    !/^\s*(?:async )?"session\.completed"/m.test(unified),
    "🔴 the `unified` channel declares NO `session.completed` adapter handler — a retired unified seat runs nothing",
  );
  ok(
    /^\s*"session\.completed":/m.test(slack),
    "NEGATIVE CONTROL: the `slack` channel DOES declare one (👀 removal + syncPinnedStatus) — the check above measures a real asymmetry",
  );
}

console.log(
  `✓ runtime-rotation: ${n} assertions passed (OPE-599 pre-dispatch heal: claim, permanence, chain rung, eight live call sites; ` +
    `OPE-1751: the claim keys on the DEPLOYMENT as well as the eve build, and its housekeeping sweep reaches retired generations only; ` +
    `OPE-627: rotation retires the outgoing generation, and eve 0.48.0's terminal emit stays unreachable from the seats it retires)`,
);
