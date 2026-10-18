process.env.OE_SQLITE_PATH = ":memory:";
delete process.env.VERCEL_DEPLOYMENT_ID;

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readAudit } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import type { OperationalStore } from "../agent/operational/store.js";
import { EVENT_DEDUPE_MAX_RETENTION_MS } from "../agent/operational/store.js";
import {
  claimRuntimeRotation,
  EVE_RUNTIME_VERSION,
  RUNTIME_CODE_FINGERPRINT,
  RUNTIME_DEPLOYMENT_ID,
  RUNTIME_ROTATION_AUDIT_ACTION,
  RUNTIME_ROTATION_PRINCIPAL,
} from "../agent/channels/runtime-rotation.js";
import { RUNTIME_CODE_FINGERPRINT_SOURCE } from "../agent/channels/runtime-code-fingerprint.generated.js";
import { canonicalJson, domainFingerprint, domainFingerprintForSeat, NO_DOMAIN_FINGERPRINT } from "../agent/channels/domain-fingerprint.js";
import { computeRuntimeCodeFingerprint, runtimeCodeFiles, writeRuntimeCodeFingerprint } from "./runtime-code-fingerprint-generate.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import { rotationTrigger, shouldRotate } from "../agent/channels/turn-delivery.js";
import { getOrCreateDmSeat } from "../agent/channels/dm-seat.js";
import { dmWindowRegistryKey } from "../agent/channels/unified-supervisor.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const RUNTIME_CODE_FINGERPRINT_MODULE = join(REPO_ROOT, "packages/core/agent/channels/runtime-code-fingerprint.generated.ts");

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

const liveDomains: Domain[] = [
  defineDomain({ name: "payments", reach: ["slack/T1/C1"], ambientSupervisor: true }),
  defineDomain({ name: "sundries", reach: ["slack/T1/C2"] }),
];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => liveDomains,
  loadSilos: () => [],
  domainsForSurface: () => [],
});

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
  ok(RUNTIME_CODE_FINGERPRINT.startsWith(`${EVE_RUNTIME_VERSION}:`), "🔴 the running fingerprint carries the eve version — half of the heal trigger");
  ok(RUNTIME_CODE_FINGERPRINT.endsWith(RUNTIME_CODE_FINGERPRINT_SOURCE), "…and the build-time hash of the runtime source — the half that fires on a code ship");
  ok(/^[0-9a-f]{16}$/.test(RUNTIME_CODE_FINGERPRINT_SOURCE), "…and that hash is a real 16-hex digest, not an empty placeholder");

  {
    const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const hook = rootPkg.scripts?.["prebuild:packages"];
    ok(hook !== undefined, "🔴 `prebuild:packages` exists — npm's lifecycle hook is what regenerates the fingerprint before every compile");
    ok(
      (hook ?? "").includes("runtime-code-fingerprint-generate"),
      "🔴 …and it runs the fingerprint generator. Without this the committed build never refreshes the constant and every comparison is against a fossil",
    );
    ok(rootPkg.scripts?.["build:packages"] !== undefined, "control: the `build:packages` script the hook attaches to still exists, so the hook is not orphaned");
  }

  eq(process.env.VERCEL_DEPLOYMENT_ID, undefined, "precondition: the suite pinned VERCEL_DEPLOYMENT_ID unset before the imports…");
  eq(RUNTIME_DEPLOYMENT_ID, "local", "…so the deployment identity reads `local` — never empty, which would silently collapse two segments into one in the audit row");

  const asDeployment = async (id: string, tag: string): Promise<{ code: string; deployment: string }> => {
    const before = process.env.VERCEL_DEPLOYMENT_ID;
    process.env.VERCEL_DEPLOYMENT_ID = id;
    try {
      const mod = (await import(`../agent/channels/runtime-rotation.js?deployment=${tag}`)) as {
        RUNTIME_CODE_FINGERPRINT: string;
        RUNTIME_DEPLOYMENT_ID: string;
      };
      return { code: mod.RUNTIME_CODE_FINGERPRINT, deployment: mod.RUNTIME_DEPLOYMENT_ID };
    } finally {
      if (before === undefined) delete process.env.VERCEL_DEPLOYMENT_ID;
      else process.env.VERCEL_DEPLOYMENT_ID = before;
    }
  };
  const onOldDeploy = await asDeployment("dpl_OLDBUILD", "old");
  const onNewDeploy = await asDeployment("dpl_NEWBUILD", "new");
  eq(onOldDeploy.deployment, "dpl_OLDBUILD", "control: a bundle serving dpl_OLDBUILD really reads it (the re-import took)");
  eq(onNewDeploy.deployment, "dpl_NEWBUILD", "control: …and the second instance really reads the second id");
  ok(!onOldDeploy.code.includes("dpl_OLDBUILD"), "🔴 OPE-1821: the running fingerprint does not carry the deployment id it was served under…");
  ok(!onNewDeploy.code.includes("dpl_NEWBUILD"), "…and the same holds for the second deployment id — neither instance folded its id into the fingerprint");
  eq(
    onOldDeploy.code,
    onNewDeploy.code,
    "🔴 OPE-1821 THE FIX: the SAME tree under TWO deployment ids yields ONE code fingerprint — so a redeploy of identical code, and an alias move between two such deployments, cost no seat its working memory",
  );
}

{
  const base = defineDomain({ name: "payments", reach: ["slack/T1/C1"], ambientSupervisor: true });
  const reordered = { ambientSupervisor: true, reach: ["slack/T1/C1"], name: "payments" } as unknown as Domain;
  eq(
    domainFingerprint(base),
    domainFingerprint(reordered),
    "🔴 the hash is CANONICAL — a declaration whose fields were only reordered rotates nobody, or every unrelated edit to the config file would cost real conversations their context",
  );
  ok(
    domainFingerprint(base) !== domainFingerprint(defineDomain({ name: "payments", reach: ["slack/T1/C1"], ambientSupervisor: false })),
    "🔴 …and it MOVES when a declared field moves — a flag flip is a behaviour change the seat must pick up",
  );
  ok(
    domainFingerprint(base) !== domainFingerprint(defineDomain({ name: "payments", reach: ["slack/T1/C1", "slack/T1/C7"], ambientSupervisor: true })),
    "…including a widened reach, which changes what the seat can see");
  ok(domainFingerprint(base) !== domainFingerprint(defineDomain({ name: "sundries", reach: ["slack/T1/C2"] })), "two domains give two fingerprints");
  eq(domainFingerprint(undefined), NO_DOMAIN_FINGERPRINT, "a surface in NO domain reads the literal, never a hash of nothing");
  ok(/^[0-9a-f]{16}$/.test(domainFingerprint(base)), "…and a real declaration hashes to a 16-hex digest");

  eq(domainFingerprintForSeat(undefined, "slack/T1/C1"), domainFingerprint(liveDomains[0]!), "🔴 a per-container seat (no grain name) hashes the domain that OWNS the woken surface");
  eq(domainFingerprintForSeat(undefined, "slack/T1/C2"), domainFingerprint(liveDomains[1]!), "…and a surface in the other domain resolves to the other domain's hash");
  eq(domainFingerprintForSeat(undefined, "slack/T1/D0UNDECLARED"), NO_DOMAIN_FINGERPRINT, "…and an undeclared surface resolves to the no-domain literal");

  eq(
    domainFingerprintForSeat("payments", "slack/T1/C1"),
    domainFingerprintForSeat("payments", "slack/T1/A-THREAD-THE-DOMAIN-DOES-NOT-LIST"),
    "🔴 two wakes on ONE window seat hash the SAME declaration, even when one arrives on a surface the domain never lists — otherwise the seat rotates itself away on every message",
  );
  eq(domainFingerprintForSeat("payments", "slack/T1/C1"), domainFingerprint(liveDomains[0]!), "…and it is that domain's own declaration, not a hash of its name");
  ok(
    domainFingerprintForSeat("sundries", "slack/T1/C1") !== domainFingerprintForSeat("payments", "slack/T1/C1"),
    "NEGATIVE CONTROL: two grains still give two fingerprints — the surface key is ignored, not the grain",
  );
  eq(
    domainFingerprintForSeat("a-domain-the-config-does-not-declare", "slack/T1/C1"),
    undefined,
    "🔴 a grain naming a domain the config does not carry is UNRESOLVABLE, never `no-domain` — a config inconsistency is not evidence that the code changed, and hashing around it would rotate the seat on every wake",
  );

  const poisoned = { name: "poisoned", reach: ["slack/T1/CPOISON"], admission: () => true } as unknown as Domain;
  liveDomains.push(poisoned);
  try {
    eq(domainFingerprintForSeat(undefined, "slack/T1/CPOISON"), undefined, "🔴 a declaration holding a function is REFUSED — an un-hashable field must never be silently skipped");
    assert.throws(() => canonicalJson(poisoned), /function/, "…and the pure canonicaliser says why");
  } finally {
    liveDomains.pop();
  }
}

{
  const store = getOperationalStore();
  const at = "2026-08-15T12:00:00.000Z";
  const F1 = "eve:CODE-ONE";
  const F2 = "eve:CODE-TWO";
  const D1 = "domain-one";
  const D2 = "domain-two";
  const seat = async (registryKey: string, token: string): Promise<void> => {
    await store.rotateChannelSession(ORG, registryKey, token, at);
  };
  const wake = (registryKey: string, code: string, domain: string, atIso = at): Promise<boolean> =>
    claimRuntimeRotation({ org: ORG, registryKey, surfaceKey: "slack/T1/C1", atIso }, { codeFingerprint: code, domainFingerprint: domain });

  eq(await wake("oe-domain::never-seated", F1, D1), false, "🔴 a registry key with NO row rotates nothing — a seat that does not exist cannot be running stale code");

  await seat("oe-domain::fresh", "t-fresh");
  eq(await wake("oe-domain::fresh", F1, D1), false, "🔴 a row carrying NO pair is ADOPTED — the generation was minted by this same bundle, so rotating it would be amnesia at generation 1");
  eq((await store.getChannelSession(ORG, "oe-domain::fresh"))!.servedCodeFingerprint, F1, "…and the adopt WRITES the pair, so the comparison has something to compare next time");
  eq((await store.getChannelSession(ORG, "oe-domain::fresh"))!.servedDomainFingerprint, D1, "…both halves of it");

  eq(await wake("oe-domain::fresh", F1, D1), false, "🔴 an unchanged pair rotates nothing — this is every wake between two ships, and it must cost no context");
  eq(await wake("oe-domain::fresh", F1, D1, "2026-08-15T12:00:05.000Z"), false, "…and still nothing on the wake after that");

  eq(await wake("oe-domain::fresh", F2, D1), true, "🔴 THE FIX: a CODE change rotates the seat on its next wake");
  eq(await wake("oe-domain::fresh", F2, D1), false, "🔴 NEGATIVE CONTROL: and only once — the wake after it resumes, because the pair now matches");

  eq(await wake("oe-domain::fresh", F1, D1), true, "🔴 OPE-1821: a ROLLBACK to code that already served ROTATES — a comparison asks `different from what this seat ran`, never `never seen before`");
  eq((await store.getChannelSession(ORG, "oe-domain::fresh"))!.servedCodeFingerprint, F1, "…and the row now records the rolled-back-to code");

  await seat("oe-domain::alpha", "t-alpha");
  await seat("oe-domain::beta", "t-beta");
  eq(await wake("oe-domain::alpha", F1, D1), false, "precondition: alpha adopts its pair");
  eq(await wake("oe-domain::beta", F1, D2), false, "precondition: beta adopts its own, on the same code");
  eq(await wake("oe-domain::alpha", F1, "domain-one-edited"), true, "🔴 THE SURGICAL HALF: editing ONE domain's declaration rotates that domain's seat");
  eq(await wake("oe-domain::beta", F1, D2), false, "🔴 …and leaves every OTHER domain's seat alone — the defect that made a config edit cost 100 seats their memory");

  eq(await wake("oe-domain::alpha", F2, "domain-one-edited"), true, "a code ship rotates alpha…");
  eq(await wake("oe-domain::beta", F2, D2), true, "…and beta too — every seat, on its own next wake, never in a herd");

  await seat("oe-domain::race", "t-race");
  eq(await wake("oe-domain::race", F1, D1), false, "precondition: the racing seat adopts its pair first");
  const raced = await Promise.all([wake("oe-domain::race", F2, D1), wake("oe-domain::race", F2, D1)]);
  eq(raced.filter((r) => r).length, 1, "🔴 EXACTLY ONE of two concurrent wakes on the same stale seat rotates it — the comparison and the write are one statement");
  eq(raced.filter((r) => !r).length, 1, "…and the other resumes the generation the winner just minted");

  const rows = await readAudit({ org: ORG, action: RUNTIME_ROTATION_AUDIT_ACTION });
  const alphaRows = rows.filter((r) => r.detail?.registryKey === "oe-domain::alpha");
  eq(alphaRows.length, 2, "🔴 exactly one audit row per ROTATION — an adopt, a no-op and a racing loser all write nothing");
  const domainRow = alphaRows.find((r) => r.detail?.changed === "domain");
  ok(domainRow !== undefined, "🔴 …and the row says WHICH half moved, so an operator can tell a config edit from a ship");
  eq(domainRow?.detail?.previousDomainFingerprint, D1, "…naming the pair the seat was actually running");
  eq(domainRow?.detail?.domainFingerprint, "domain-one-edited", "…and the one it moves to");
  eq(domainRow?.detail?.eveVersion, EVE_RUNTIME_VERSION, "…the eve build…");
  eq(
    domainRow?.detail?.deploymentId,
    RUNTIME_DEPLOYMENT_ID,
    "🔴 …and the DEPLOYMENT that was serving. It is a FACT on the row and no part of the identity: an operator reading an incident still has to know which build the retired generation was running",
  );
  eq(rows.find((r) => r.detail?.registryKey === "oe-domain::fresh" && r.detail?.changed === "code")?.detail?.changed, "code", "…and a pure code ship is labelled `code`");
  eq(domainRow?.principalId, RUNTIME_ROTATION_PRINCIPAL, "…stamped with the synthetic service principal (no human acted)");
  eq(domainRow?.platform, "slack", "…partitioned by the woken surface's platform…");
  eq(domainRow?.workspace, "T1", "…workspace…");
  eq(domainRow?.surface, "C1", "…and surface, so an operator can find it from the channel");
  ok(
    typeof domainRow?.detail?.note === "string" && (domainRow.detail.note as string).includes("in-context state"),
    "…and the row SAYS the generation's in-context state was dropped — the rotation is a real cost, stated",
  );

  const before = (await readAudit({ org: ORG, action: RUNTIME_ROTATION_AUDIT_ACTION })).length;
  const throwing = {
    async stampChannelSessionRuntime(): Promise<never> {
      throw new Error("store blip");
    },
  } as unknown as Pick<OperationalStore, "stampChannelSessionRuntime">;
  const soft = await claimRuntimeRotation({ org: ORG, registryKey: "oe-domain::blip", surfaceKey: "slack/T1/C1", atIso: at }, { store: throwing, codeFingerprint: F1, domainFingerprint: D1 });
  eq(soft, false, "🔴 a store error FAILS SOFT to false — a blip must cost a delay, never a healthy generation's context");
  eq((await readAudit({ org: ORG, action: RUNTIME_ROTATION_AUDIT_ACTION })).length, before, "…and writes no audit row: nothing was retired");

  let reached = false;
  const refusing = {
    async stampChannelSessionRuntime(): Promise<never> {
      reached = true;
      throw new Error("the store must not be reached when the domain half is unresolved");
    },
  } as unknown as Pick<OperationalStore, "stampChannelSessionRuntime">;
  const poisoned = { name: "poisoned-3", reach: ["slack/T1/CPOISON3"], admission: () => true } as unknown as Domain;
  liveDomains.push(poisoned);
  try {
    const unresolved = await claimRuntimeRotation({ org: ORG, registryKey: "oe-domain::unresolved", surfaceKey: "slack/T1/CPOISON3", atIso: at }, { store: refusing, codeFingerprint: F1 });
    eq(unresolved, false, "🔴 an unresolvable DOMAIN half fails soft too — an unreadable declaration proves no change");
    ok(!reached, "…and SHORT-CIRCUITS: the store is never reached, so an unreadable config cannot even stamp a half-pair onto the row");
  } finally {
    liveDomains.pop();
  }
}

{
  const store = getOperationalStore();
  const REG = "oe-domain::permanence";
  const t0 = Date.parse("2026-08-15T12:00:00.000Z");
  const scope = { org: ORG, registryKey: REG, surfaceKey: "slack/T1/C9" };
  const pair = { codeFingerprint: "eve:STEADY", domainFingerprint: "steady-domain" };

  await store.rotateChannelSession(ORG, REG, "t-permanence", new Date(t0).toISOString());
  eq(await claimRuntimeRotation({ ...scope, atIso: new Date(t0).toISOString() }, pair), false, "the seat adopts its pair on its first wake");

  const wayLater = new Date(t0 + EVENT_DEDUPE_MAX_RETENTION_MS * 40).toISOString();
  eq(
    await claimRuntimeRotation({ ...scope, atIso: wayLater }, pair),
    false,
    `🔴 the seat STILL does not rotate ${EVENT_DEDUPE_MAX_RETENTION_MS * 40}ms later — the comparison reads code, never a clock. A TTL'd primitive here rotates every window each time the event_dedupe ceiling passes, forever (OPE-345 violation)`,
  );
  eq(
    await claimRuntimeRotation({ ...scope, atIso: wayLater }, { ...pair, codeFingerprint: "eve:SHIPPED" }),
    true,
    "NEGATIVE CONTROL: …while a real code change at that same instant DOES rotate it, so the case above measures the absent clock and not an absent mechanism",
  );
}

{
  const store = getOperationalStore();
  const rotation = readFileSync(join(REPO_ROOT, "packages/core/agent/channels/runtime-rotation.ts"), "utf8");
  ok(!rotation.includes("claimNotice"), "🔴 the rotation no longer claims a `notice_claim` key at all — a lifetime claim cannot answer a rollback, which is the whole of OPE-1821");
  ok(!rotation.includes("sweepPrefix"), "…so it asks for no housekeeping sweep either");

  for (const rel of ["packages/core/agent/operational/store.ts", "packages/core/agent/operational/sqlite.ts", "packages/core/agent/operational/postgres.ts"]) {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    ok(!src.includes("NoticeClaimPrune"), `🔴 ${rel} carries no notice-claim prune — the ONE delete path on that table is retired with its only caller`);
    ok(!/DELETE FROM notice_claim/.test(src), `🔴 ${rel} has no DELETE on notice_claim — dropping a claim lets the thing it records happen a second time`);
  }
  const pg = readFileSync(join(REPO_ROOT, "packages/core/agent/operational/postgres.ts"), "utf8");
  ok(
    /notice_claim: \["SELECT", "INSERT"\]/.test(pg),
    "🔴 the runtime role's grant on notice_claim is back to SELECT + INSERT — a standing DELETE grant is reach nothing needs",
  );

  const ANCIENT = "silent:slack/T1/C-ANCIENT:join";
  ok(await store.claimNotice(ORG, ANCIENT, "2020-01-01T00:00:00.000Z"), "seeded: a five-year-old claim from the table's other tenant");
  await store.rotateChannelSession(ORG, "oe-domain::sweepless", "t-sweepless", "2026-08-15T12:00:00.000Z");
  for (const code of ["eve:S1", "eve:S2", "eve:S3"]) {
    await claimRuntimeRotation({ org: ORG, registryKey: "oe-domain::sweepless", surfaceKey: "slack/T1/C1", atIso: "2026-08-15T12:00:00.000Z" }, { codeFingerprint: code, domainFingerprint: "d" });
  }
  eq(await store.noticeClaimed(ORG, ANCIENT), true, "🔴 …and it SURVIVES three rotations — the rotation path touches `notice_claim` not at all now");
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
  eq(
    (await store.stampChannelSessionRuntime(ORG, REG, "eve:AN-OLDER-BUILD", NO_DOMAIN_FINGERPRINT)).outcome,
    "adopted",
    "precondition: the seeded generation records the code an older deployment served it with",
  );
  ok(!shouldRotate((await store.getChannelSession(ORG, REG))!, at), "precondition: the seeded generation trips NO ordinary rotation trigger");

  const healed = await getOrCreateDmSeat(ORG, { surfaceKey: SURFACE }, at);
  eq(healed.generation, 2, "🔴 THE FIX: the first wake after the code changed ROTATES the seat, so the wake lands in a session the runtime can read");
  ok(healed.token !== "seed-token-g1", "…on a genuinely new continuation token (a new eve session), not the stranded one");
  eq(healed.freshGeneration, true, "…flagged fresh, so the wake re-carries context");

  const resumed = await getOrCreateDmSeat(ORG, { surfaceKey: SURFACE }, "2026-08-15T12:00:02.000Z");
  eq(resumed.generation, 2, "🔴 NEGATIVE CONTROL: the SECOND wake RESUMES — the heal is one-shot, not a rotation on every wake");
  eq(resumed.token, healed.token, "…on the same token the heal minted");

  const FRESH = "slack/T1/D0FRESHSEAT";
  const minted = await getOrCreateDmSeat(ORG, { surfaceKey: FRESH }, at);
  eq(minted.generation, 1, "a seat with no row mints generation 1");
  eq(
    (await store.getChannelSession(ORG, dmWindowRegistryKey(FRESH)))!.servedCodeFingerprint,
    RUNTIME_CODE_FINGERPRINT,
    "🔴 OPE-1821: the MINT ARM STAMPS the running pair onto the row it just wrote — the row is never left NULL for this build to guess at later",
  );
  const next = await getOrCreateDmSeat(ORG, { surfaceKey: FRESH }, "2026-08-15T12:00:02.000Z");
  eq(next.generation, 1, "🔴 …and its NEXT wake resumes it: the row already carries the running pair, so the comparison reads `current` and retires nothing");

  const CROSSED = "slack/T1/D0CROSSDEPLOY";
  await getOrCreateDmSeat(ORG, { surfaceKey: CROSSED }, at);
  const crossedScope = { org: ORG, registryKey: dmWindowRegistryKey(CROSSED), surfaceKey: CROSSED, atIso: at };
  const liveDomain = domainFingerprintForSeat(undefined, CROSSED)!;
  eq(
    await claimRuntimeRotation(crossedScope, { codeFingerprint: "eve:SHIPPED-AFTER-THE-MINT", domainFingerprint: liveDomain }),
    true,
    "🔴 OPE-1821 THE MINT STAMP: a seat whose SECOND wake crosses a deploy ROTATES — without the stamp at mint this row reads NULL, ADOPTS, and the seat is stranded on the bundle that minted it",
  );

  const STEADY = "slack/T1/D0SAMEDEPLOY";
  await getOrCreateDmSeat(ORG, { surfaceKey: STEADY }, at);
  eq(
    await claimRuntimeRotation(
      { org: ORG, registryKey: dmWindowRegistryKey(STEADY), surfaceKey: STEADY, atIso: at },
      { codeFingerprint: RUNTIME_CODE_FINGERPRINT, domainFingerprint: domainFingerprintForSeat(undefined, STEADY)! },
    ),
    false,
    "NEGATIVE CONTROL: a wake on the SAME pair the mint stamped rotates nothing — the comparison reads `current`, so the case above measures a real difference",
  );
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
    ok(src.includes("claimRuntimeRotation"), `🔴 ${rel} runs the OPE-599/OPE-1821 runtime comparison — without it this seat stays stranded after every eve bump and every ship, silently`);
    ok(claimAt >= 0, `🔴 ${rel} resolves the verdict into a \`runtimeChanged\` binding`);
    ok(/shouldRotate\(.*runtimeChanged/.test(src), `🔴 ${rel} passes that verdict into the rotation chain (a claim whose boolean is dropped heals nothing)`);
    ok(readAt >= 0 && claimAt < readAt, `🔴 ${rel} claims BEFORE it reads the registry row — a claim made after it leaves the mint arm unconsumed (§5c)`);
    ok(
      rel.endsWith("dm-seat.ts") || /domainName: grain\.domainName/.test(src),
      `🔴 ${rel} passes the SEAT's grain (\`domainName: grain.domainName\`) — resolving the domain from the woken surface gives one window row two fingerprints, and its wakes then rotate each other's generation away on every message`,
    );
    ok(
      src.includes("stampMintedRuntime"),
      `🔴 ${rel} stamps the running pair onto the row its MINT arm just wrote — without it, a seat minted here never rotates for the deploy its second wake crosses`,
    );
    ok(src.lastIndexOf("stampMintedRuntime") > readAt, `🔴 ${rel} stamps AFTER the row exists — a stamp before the mint has no row to write to and is silently lost`);
  }
}

{
  const relW = "packages/core/agent/channels/work-generation.ts";
  const w = readFileSync(join(REPO_ROOT, relW), "utf8");
  ok(w.includes("claimRuntimeRotation"), `🔴 ${relW} claims the runtime rotation — without it a fire after an eve bump dies in a stranded work session, silently`);
  ok(/return claimRuntimeRotationOutcome\(scope, \{ store, rotateUnstamped: /.test(w) && /const claimed = await \(deps\.claimRuntime \?\? liveClaim\)\(\)/.test(w), `🔴 ${relW} claims with the outcome-naming claim, and a served W row with no recorded code rotates (OPE-2377)`);
  ok(/const runtimeChanged = runtimeOutcome === "rotate"/.test(w) && /runtimeChanged \? "runtime-changed"/.test(w), `🔴 ${relW} turns the verdict into the \`runtime-changed\` rung (a claim whose verdict is dropped heals nothing)`);
  const relF = "packages/core/agent/routines/fire-work.ts";
  const f = readFileSync(join(REPO_ROOT, relF), "utf8");
  ok(/resolveWork: \(input\) => resolveWorkGeneration\(input\)/.test(f), `🔴 ${relF}'s live deps resolve W's generation through resolveWorkGeneration — the fire reaches the heal above`);
  ok(/const generation = await deps\.resolveWork\(/.test(f) && f.indexOf("const generation = await deps.resolveWork(") < f.indexOf("token: generation.token"), `🔴 ${relF} resolves W's generation BEFORE it addresses the forward, so the fire is delivered to the healed generation`);
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

{
  const files = runtimeCodeFiles(REPO_ROOT);
  ok(files.length > 500, `the walk really reads the runtime trees (${files.length} source files)`);
  ok(files.includes("packages/core/agent/channels/runtime-rotation.ts"), "🔴 runtime code is IN — the module whose change must rotate every seat");
  ok(files.includes("agent/settings/settings.ts"), "🔴 …and so is the behaviour settings schema: no per-seat fingerprint covers it, so a settings edit must reach every seat through the CODE half");
  ok(files.some((f) => f.startsWith("packages/providers/slack/agent/")), "…and every provider's own runtime source");
  for (const overlay of [
    "agent/access/grants.generated.ts",
    "agent/access/credential-bindings.generated.ts",
    "agent/identity/groups.generated.ts",
    "agent/memory/config/agents.generated.ts",
    "agent/webhooks/hooks.generated.ts",
  ]) {
    ok(files.includes(overlay), `🔴 ${overlay} is IN — it is machine-WRITTEN but AUTHORITATIVE, and a revoked grant must reach every standing seat`);
  }
  for (const extra of ["roster.config.ts", "roster.lock.json", "agent/instructions.md"]) {
    ok(files.includes(extra), `🔴 ${extra} is IN — it changes what the seat runs, and nothing else in either fingerprint covers it`);
  }
  ok(
    files.some((f) => f.startsWith("patches/") && f.endsWith(".patch")),
    "🔴 patches/ is IN — patch-package rewrites the bytes a seat runs, and a patch edit that moved no fingerprint would strand every standing seat on the unpatched runtime",
  );
  ok(!files.some((f) => f.startsWith("agent/memory/config/domains/")), "🔴 the per-domain declarations are OUT — they are the domain fingerprint's job, and leaving them in rotates 100 seats for one domain's edit");
  ok(!files.some((f) => f.endsWith("-test.ts") || f.endsWith(".test.ts") || f.endsWith(".spec.ts")), "…tests are OUT: a test never ships, so editing one must cost no conversation its context");
  ok(!files.includes("packages/core/agent/channels/runtime-code-fingerprint.generated.ts"), "🔴 …and so is this step's OWN output — a fingerprint that hashed its own output could never settle");
  ok(!files.some((f) => f.includes("/node_modules/") || f.includes("/dist/")), "…and neither installed packages nor build output are reachable from the walk");

  {
    const tracked = new Set(
      execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
        .toString("utf8")
        .split("\0")
        .filter((line) => line.length > 0),
    );
    ok(tracked.size > 1000, `control: git really listed the tracked tree (${tracked.size} files) — an empty list would make the next assertion pass for free`);
    const untracked = files.filter((f) => !tracked.has(f));
    eq(
      untracked,
      [],
      `🔴 every hashed path is TRACKED — an untracked one is \`oe build\` output, and hashing it gives one commit two fingerprints (found: ${untracked.slice(0, 5).join(", ") || "none"})`,
    );
  }

  eq([...files], [...files].sort(), "🔴 the walk returns its paths SORTED — directory order is a filesystem property, and an unsorted hash would move between two builds of one tree");

  {
    const scratch = join(REPO_ROOT, "node_modules", ".oe-scratch", "fingerprint-out");
    mkdirSync(scratch, { recursive: true });
    const outFile = join(scratch, "runtime-code-fingerprint.generated.ts");
    const before = statSync(RUNTIME_CODE_FINGERPRINT_MODULE).mtimeMs;
    const first = writeRuntimeCodeFingerprint(outFile, REPO_ROOT);
    eq(first.wrote, true, "control: the first write into an empty scratch path really writes, so the no-op below is not a skipped call");
    const stampAfterFirst = statSync(outFile).mtimeMs;
    const second = writeRuntimeCodeFingerprint(outFile, REPO_ROOT);
    eq(second.wrote, false, "🔴 a regeneration over an UNCHANGED tree writes nothing — an unconditional write makes packages/core/dist read as stale on every build");
    eq(second.fingerprint, first.fingerprint, "control: …and it is the same fingerprint, so the no-op is a no-op and not a skipped computation");
    eq(statSync(outFile).mtimeMs, stampAfterFirst, "🔴 …and the file's mtime is untouched, which is the property the dist-freshness guard actually reads");
    eq(statSync(RUNTIME_CODE_FINGERPRINT_MODULE).mtimeMs, before, "🔴 …and this case never touched the REPOSITORY's own copy — a suite that did would red every leg scheduled after it");
    rmSync(scratch, { recursive: true, force: true });
  }

  const tmp = join(REPO_ROOT, "node_modules", ".oe-scratch", "fingerprint-tree");
  const write = (rel: string, body: string): void => {
    const abs = join(tmp, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };
  mkdirSync(tmp, { recursive: true });
  write("agent/thing.ts", "export const a = 1;\n");
  write("packages/core/agent/other.ts", "export const b = 2;\n");
  write("agent/memory/config/domains/payments.ts", "export const d = 1;\n");
  write("agent/thing-test.ts", "export const t = 1;\n");
  write("patches/thing+1.0.0.patch", "diff --git a\n");
  const baseline = computeRuntimeCodeFingerprint(tmp);
  ok(/^[0-9a-f]{16}$/.test(baseline), "control: the synthetic tree hashes to a real digest");

  {
    const tmp2 = join(REPO_ROOT, "node_modules", ".oe-scratch", "fingerprint-tree-reordered");
    mkdirSync(tmp2, { recursive: true });
    const write2 = (rel: string, body: string): void => {
      const abs = join(tmp2, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
    };
    write2("packages/core/agent/other.ts", "export const b = 2;\n");
    write2("patches/thing+1.0.0.patch", "diff --git a\n");
    write2("agent/memory/config/domains/payments.ts", "export const d = 1;\n");
    write2("agent/thing-test.ts", "export const t = 1;\n");
    write2("agent/thing.ts", "export const a = 1;\n");
    eq(computeRuntimeCodeFingerprint(tmp2), baseline, "🔴 the SAME file set written in a different order hashes the SAME — two builds of one tree must never disagree, or every seat rotates on a deploy that changed nothing");
    rmSync(tmp2, { recursive: true, force: true });
  }

  write("packages/core/agent/other.ts", "export const b = 3;\n");
  ok(computeRuntimeCodeFingerprint(tmp) !== baseline, "🔴 a one-character RUNTIME CODE change moves the fingerprint — this is the ship case");
  write("packages/core/agent/other.ts", "export const b = 2;\n");
  eq(computeRuntimeCodeFingerprint(tmp), baseline, "🔴 …and restoring it moves the fingerprint BACK, which is what makes a rollback rotate: the old code's fingerprint is the old value, not a new one");

  write("agent/memory/config/domains/payments.ts", "export const d = 99;\n");
  eq(computeRuntimeCodeFingerprint(tmp), baseline, "🔴 THE SURGICAL HALF: editing ONE domain's declaration leaves the code fingerprint alone — otherwise every seat in the instance rotates for one domain's edit");
  write("agent/memory/config/domains/sundries.ts", "export const e = 1;\n");
  eq(computeRuntimeCodeFingerprint(tmp), baseline, "…and so does ADDING a domain");

  write("agent/thing-test.ts", "export const t = 2;\n");
  eq(computeRuntimeCodeFingerprint(tmp), baseline, "…and editing a test leaves it alone too");

  write("patches/thing+1.0.0.patch", "diff --git b\n");
  ok(computeRuntimeCodeFingerprint(tmp) !== baseline, "🔴 editing a PATCH moves the fingerprint — the bytes a seat runs changed with no .ts file and no version pin touched");
  write("patches/thing+1.0.0.patch", "diff --git a\n");
  eq(computeRuntimeCodeFingerprint(tmp), baseline, "control: restoring the patch bytes moves the fingerprint BACK, so the case above measured the edit and not the write");
  write("patches/thing+1.1.0.patch", "diff --git a\n");
  unlinkSync(join(tmp, "patches/thing+1.0.0.patch"));
  ok(computeRuntimeCodeFingerprint(tmp) !== baseline, "🔴 a patch VERSION RENAME with identical bytes moves it too — the path is hashed, so a re-rolled patch cannot land silently");
  write("patches/thing+1.0.0.patch", "diff --git a\n");
  unlinkSync(join(tmp, "patches/thing+1.1.0.patch"));
  eq(computeRuntimeCodeFingerprint(tmp), baseline, "control: the rename is undone, so the tree is back at the baseline for the cases below");

  write("agent/renamed.ts", "export const a = 1;\n");
  unlinkSync(join(tmp, "agent/thing.ts"));
  ok(computeRuntimeCodeFingerprint(tmp) !== baseline, "🔴 a pure RENAME moves the fingerprint — the path is hashed as well as the bytes");

  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  `✓ runtime-rotation: ${n} assertions passed (OPE-599 pre-dispatch heal: the chain rung and eight live call sites; ` +
    `OPE-1821: a PER-SEAT comparison of the running (code, domain) fingerprint pair against the seat's own registry row — ` +
    `a rollback rotates, an identical redeploy does not, one domain's edit touches one domain's seats, and two concurrent wakes rotate once; ` +
    `OPE-627: rotation retires the outgoing generation, and eve 0.48.0's terminal emit stays unreachable from the seats it retires)`,
);
