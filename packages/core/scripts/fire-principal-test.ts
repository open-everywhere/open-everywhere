import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { MemoryPlan } from "../agent/memory/resolve.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function refuses(fn: () => unknown, needle: RegExp, label: string): Promise<void> {
  let msg: string | null = null;
  try {
    await fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg !== null && needle.test(msg), `${label} (got: ${msg ?? "no throw"})`);
}

const dir = mkdtempSync(join(tmpdir(), "oe-fire-principal-"));
process.env.OE_SQLITE_PATH = join(dir, "store.db");
delete process.env.OE_TRUST;

const { registerSlackFixtureMapper, registerSlackTestBridge } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
const slackChannel = { kind: "slack-fake" };
registerSlackTestBridge({ channel: slackChannel as never });

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { defineMemorySilo } = await import("../agent/memory/silo.js");
const { actingPrincipalId, bindFrom, FIRE_PRINCIPAL_ATTR, FIRE_PRINCIPAL_TRUST_ATTR } = await import("../agent/identity/binding.js");
const { actingPrincipalIdOf, buildResolveRequest, principalIdOf } = await import("../agent/access/request.js");
const { adminControlRoles, roleForBinding } = await import("../agent/access/roles.js");
const { resolveMemoryPlan } = await import("../agent/memory/resolve.js");
const { resolvePartition } = await import("../agent/memory/partition.js");
const { resolveAccess } = await import("../agent/access/resolver.js");
const { routineFireAttributes } = await import("../agent/routines/fire-auth.js");
const { recheckFireCreator } = await import("../agent/routines/fire-creator.js");
const dispatch = await import("../agent/schedules/dispatch.js");
const store = await import("../agent/routines/store.js");

const ORG = "default";
const CREATOR = "U_CREATOR";
const TEAM = "T1";

const orgSilo = defineMemorySilo({ name: "org-brain", provider: "sqlite" });
const engSilo = defineMemorySilo({ name: "eng-silo", provider: "sqlite" });
const domains = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: [CREATOR] }),
  defineDomain({ name: "dm", match: "dm", includeOrg: "readonly" }),
  defineDomain({ name: "eng", channels: [`slack/${TEAM}/C_ENG`], memory: "eng-silo" }),
];
const silos = [orgSilo, engSilo];
const memCfg = { domains, silos };
const bundles = [{ name: "personal", connectors: ["personal-notion"] }] as never;
const bindings = [{ scope: { level: "principal" as const, principal: CREATOR }, bundle: "personal" }] as never;
registerConfig({
  loadBundles: () => bundles,
  loadBindings: () => bindings,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => silos,
  domainsForSurface: () => [],
});

type Attrs = Record<string, string>;
function fireCtx(attributes: Attrs): never {
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes } } },
  } as never;
}
function liveCtx(over: Attrs = {}): never {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: TEAM, channel_id: "D_CREATOR", channel_type: "im", user_id: CREATOR, dm_partner_trust: "internal", ...over },
          principalId: CREATOR,
          principalType: "slack-user",
        },
      },
    },
  } as never;
}
const partitionFor = (surfaceKey: string) => {
  const [platform = "", workspace = "", ...rest] = surfaceKey.split("/");
  return { org: ORG, platform, workspace, surface: rest.join("/"), workspaceKey: `${platform}/${workspace}`, surfaceKey, key: surfaceKey } as never;
};
const planShape = (p: MemoryPlan): string =>
  JSON.stringify({
    reads: p.reads.map((r) => `${r.silo.name}@${r.tier}${r.readOnly ? ":ro" : ":rw"}`),
    writes: p.writes.map((w) => w.silo.name),
  });

const delivered: { attributes: Attrs }[] = [];
{
  const receive = ((_channel: unknown, args: { auth: { attributes: Attrs } }) => {
    delivered.push({ attributes: args.auth.attributes });
    return Promise.resolve();
  }) as never;
  const pending: Promise<unknown>[] = [];
  const tick = (now: Date, creatorInternal: boolean) =>
    dispatch.dispatchTick({
      now,
      receive,
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      appAuth: { attributes: {} } as never,
      confirmInternal: () => Promise.resolve(false),
      confirmCreatorInternal: async () => creatorInternal,
    } as never);
  const settle = async () => void (await Promise.allSettled(pending.splice(0)));

  const dmRoutine = (id: string, channelId: string) => ({
    id,
    org: ORG,
    surfaceKey: `slack/${TEAM}/${channelId}`,
    target: { channelId },
    trigger: { kind: "once" as const, at: "2026-07-20T00:00:00.000Z" },
    prompt: "brief me",
    createdBy: CREATOR,
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active" as const,
    nextRunAt: "2026-07-20T00:00:00.000Z",
    consecutiveFailures: 0,
  });

  await store.addRoutine(partitionFor(`slack/${TEAM}/D_CREATOR`), dmRoutine("r-dm-ok", "D_CREATOR") as never);
  await tick(new Date("2026-07-20T01:00:00.000Z"), true);
  await settle();
  ok(delivered.length === 1, "stamp: the DM routine actually FIRED (a stamp assertion on a fire that never happened proves nothing)");
  const vouchedBag = delivered[0]!.attributes;
  ok(vouchedBag[FIRE_PRINCIPAL_ATTR] === CREATOR, "stamp: the fire carries its routine's STORED creator — the id comes off the row, never invented");
  ok(vouchedBag[FIRE_PRINCIPAL_TRUST_ATTR] === "internal", "stamp: 🔴 …and the LIVE verdict the dispatcher actually obtained this fire");

  await store.addRoutine(partitionFor(`slack/${TEAM}/D_LEAVER`), dmRoutine("r-dm-gone", "D_LEAVER") as never);
  await tick(new Date("2026-07-20T02:00:00.000Z"), false);
  await settle();
  ok(delivered.length === 2, "stamp: the second DM routine fired too");
  const staleBag = delivered[1]!.attributes;
  ok(staleBag[FIRE_PRINCIPAL_ATTR] === CREATOR, "stamp: a de-vouched creator is still NAMED — provenance survives a standing change, because who armed it is a fact");
  ok(staleBag[FIRE_PRINCIPAL_TRUST_ATTR] === undefined, "stamp: …but no trust stamp. Positive-only: the absence of a verdict IS the fail-closed answer");
}
const vouchedBag = delivered[0]!.attributes;
const staleBag = delivered[1]!.attributes;

{
  const floated = routineFireAttributes(
    { id: "r", org: ORG, surfaceKey: `slack/${TEAM}/D1`, trigger: { kind: "once", at: "x" }, prompt: "p", createdBy: CREATOR, createdAt: "x", status: "active", consecutiveFailures: 0 } as never,
    { team_id: TEAM, channel_id: "D1", channel_type: "im" },
    "dm",
    false,
    Promise.resolve(true) as unknown as boolean,
  );
  ok(floated[FIRE_PRINCIPAL_TRUST_ATTR] === undefined, "await: 🔴 an UN-AWAITED recheck (a truthy Promise) stamps nothing — a dropped await degrades to fail-closed, never to 'internal'");
  ok(floated[FIRE_PRINCIPAL_ATTR] === CREATOR, "await: …while the id, which needs no await, is unaffected — the two halves fail independently");
  ok(vouchedBag[FIRE_PRINCIPAL_TRUST_ATTR] === "internal", "await: the DISPATCHER awaits its async recheck (this is §stamp's assertion restated as the await proof)");
}

{
  const fire = bindFrom(fireCtx(vouchedBag));
  const live = bindFrom(liveCtx());
  ok(fire.mode === "dm", "plan: the fire binds as a DM (the mode the whole shared-layer question hangs off)");
  ok(fire.principalId === CREATOR, "plan: the fire binds as its creator, not as eve's `eve:app` runtime principal");
  ok(fire.principalAttested === true, "plan: …and says so — the identity and the 'this is attested, not acting' fact travel together");
  ok(live.principalAttested === undefined, "plan: a live human turn carries no attestation flag — its binding is byte-identical to before this ticket");

  const firePlan = resolveMemoryPlan(fire, resolvePartition(fireCtx(vouchedBag)), memCfg);
  const livePlan = resolveMemoryPlan(live, resolvePartition(liveCtx()), memCfg);
  ok(planShape(firePlan) === planShape(livePlan), `plan: 🔴 a fire by a currently-vouched creator resolves the SAME memory plan as that creator's live DM (fire=${planShape(firePlan)} live=${planShape(livePlan)})`);
  ok(firePlan.reads.some((r) => r.silo.name === "org-brain"), "plan: …and that plan really does include the org brain — otherwise 'the same plan' could be 'the same nothing'");
  ok(firePlan.writes.every((w) => w.silo.name === "@personal"), "plan: the shared layer stays READ-ONLY — a fire reads the org brain, it never writes into it");
}

{
  const stale = bindFrom(fireCtx(staleBag));
  ok(stale.trust === "external", "stale: a creator who is no longer a vouched member fails the fire closed");
  ok(stale.principalId === CREATOR && stale.principalAttested === true, "stale: …while still being attributable — losing standing is not losing identity");
  const stalePlan = resolveMemoryPlan(stale, resolvePartition(fireCtx(staleBag)), memCfg);
  ok(!stalePlan.reads.some((r) => r.silo.name === "org-brain"), "stale: 🔴 …and the org reads DROP. This is the property the original 'trust is a live per-fire recheck' comment promised");
  ok(stalePlan.reads.some((r) => r.silo.name === "@personal"), "stale: the personal silo is unaffected — it was never the thing at stake");
  ok((await recheckFireCreator({ createdBy: CREATOR, platform: "slack", mode: "dm", check: async () => true })) === true, "stale: the recheck reports a current member");
  ok((await recheckFireCreator({ createdBy: CREATOR, platform: "slack", mode: "dm", check: async () => false })) === false, "stale: …and reports a departed one, off the same stored row — nothing about standing is stored");
  ok((await recheckFireCreator({ createdBy: CREATOR, platform: "telegram", mode: "dm", check: async () => true })) === undefined, "stale: a platform with no membership-verification gate is never asked — 'cannot check' is a real answer, not a default of yes");
  ok((await recheckFireCreator({ createdBy: undefined, platform: "slack", mode: "dm", check: async () => true })) === undefined, "stale: a row with no creator has no question to ask");
}

{
  const fire = bindFrom(fireCtx(vouchedBag));
  const live = bindFrom(liveCtx());

  ok(roleForBinding(live, domains).isOrgAdmin === true, "fence: the creator really IS an org admin when they act (the differential's other half — without it the fence proves nothing)");
  ok(roleForBinding(fire, domains).isOrgAdmin === false, "fence: 🔴 …and their routine's fire holds NONE of that standing. Arming one routine must not hand every later fire the arming admin's toolset");
  ok(roleForBinding(fire, domains).isDomainAdmin === false, "fence: …nor domain-admin standing, which an org admin holds everywhere");
  ok(actingPrincipalId(fire) === undefined, "fence: the fence itself — there is no ACTING principal on a fire, whoever it is attributable to");
  ok(actingPrincipalId(live) === CREATOR, "fence: …and a live turn is untouched by it");

  ok(adminControlRoles(actingPrincipalId(live), domains).join(",") === "admin", "fence: the cross-domain role scan (memory_admin_*, the governance DM arm) sees a live admin");
  ok(adminControlRoles(actingPrincipalId(fire), domains).length === 0, "fence: 🔴 …and sees nothing for a fire — no unattended read of every silo the creator administers");

  const liveAccess = resolveAccess(buildResolveRequest(liveCtx()), bundles, bindings, {});
  const fireAccess = resolveAccess(buildResolveRequest(fireCtx(vouchedBag)), bundles, bindings, {});
  ok(liveAccess.connectors.includes("personal-notion"), "fence: the creator's own DM resolves their personal connector");
  ok(!fireAccess.connectors.includes("personal-notion"), "fence: 🔴 …and their routine's fire does NOT — trust moved, credentials did not");
  ok(!fireAccess.scopeKey.startsWith("dm:"), `fence: …because the fire never claims a personal scope key at all (got ${fireAccess.scopeKey})`);

  ok(principalIdOf(fireCtx(vouchedBag)) === CREATOR, "fence: WHO is still answerable — audit rows, the ledger's principal dimension and a card's 'asked by' line name the creator");
  ok(actingPrincipalIdOf(fireCtx(vouchedBag)) === undefined, "fence: …through a DIFFERENT accessor from the one authority gates use, which is what keeps the two questions apart");
  ok(actingPrincipalIdOf(liveCtx()) === CREATOR, "fence: …and the two agree on a live turn");

  const runNow = (await import("../agent/tools/run_routine_now.js")).default;
  await refuses(
    () => (runNow as { execute: (i: unknown, c: unknown) => unknown }).execute({ id: "r-dm-ok" }, fireCtx(vouchedBag)),
    /verified sender/,
    "fence: 🔴 a fired turn cannot reach run_routine_now — the loop guard fires on the ACTING principal, so it is no longer satisfied by the fire's own attributed identity",
  );
}

{
  const chanAttrs = routineFireAttributes(
    { id: "r-c", org: ORG, surfaceKey: `slack/${TEAM}/C_ENG`, trigger: { kind: "cron", expr: "0 9 * * *" }, prompt: "p", createdBy: CREATOR, createdAt: "x", status: "active", consecutiveFailures: 0 } as never,
    { team_id: TEAM, channel_id: "C_ENG", channel_type: "channel" },
    "channel",
    true,
  );
  const withoutCreator = routineFireAttributes(
    { id: "r-c", org: ORG, surfaceKey: `slack/${TEAM}/C_ENG`, trigger: { kind: "cron", expr: "0 9 * * *" }, prompt: "p", createdAt: "x", status: "active", consecutiveFailures: 0 } as never,
    { team_id: TEAM, channel_id: "C_ENG", channel_type: "channel" },
    "channel",
    true,
  );
  const delta = Object.keys(chanAttrs).filter((k) => chanAttrs[k] !== withoutCreator[k]);
  ok(delta.length === 1 && delta[0] === FIRE_PRINCIPAL_ATTR, `channel: a channel fire's bag gains the creator stamp and NOTHING else (delta: ${delta.join(",") || "none"})`);

  const chan = bindFrom(fireCtx(chanAttrs));
  ok(chan.mode === "channel" && chan.trust === "internal", "channel: a confirmed channel still binds internal — its own live conversations.info verdict wins on the left, so the creator recheck cannot move it");
  const chanPlan = resolveMemoryPlan(chan, partitionFor(`slack/${TEAM}/C_ENG`), memCfg);
  ok(chanPlan.reads.some((r) => r.silo.name === "eng-silo") && chanPlan.writes.some((w) => w.silo.name === "eng-silo"), "channel: …and resolves its domain's brain, writable, exactly as before");
  let asked = false;
  await recheckFireCreator({ createdBy: CREATOR, platform: "slack", mode: "channel", check: async () => ((asked = true), true) });
  ok(!asked, "channel: the creator recheck is never asked on a channel fire — its trust is already settled by the channel's own recheck");
}

{
  const viaAuthSlot = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: TEAM, channel_id: "D_CREATOR", channel_type: "im" }, principalId: CREATOR, principalType: "slack-user" } } },
  } as never;
  const b = bindFrom(viaAuthSlot);
  ok(b.principalId === CREATOR && b.principalAttested === undefined, "vehicle: an identity arriving via the AUTH SLOT reads as a human acting — which is correct for a human, and exactly why a fire must not use that channel");
  ok(roleForBinding(b, domains).isOrgAdmin === true, "vehicle: 🔴 …it would have carried full admin standing. The attribute pairing is what makes the fence unforgettable rather than a rule to remember");
  ok(bindFrom(fireCtx(vouchedBag)).principalAttested === true, "vehicle: the fire's own bag, by contrast, cannot express the identity without the attestation");
}

console.log(`✓ fire-principal: ${passed} assertions passed`);
