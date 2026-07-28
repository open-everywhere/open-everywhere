
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readGrantReach, grantDomainsExist, webhookReach, mergeReach } from "../agent/webhooks/achievability.js";
import { defineWebhook, assertWebhooksValid } from "../agent/webhooks/config.js";
import { scopeGrantsRead, type ReadableBy } from "../agent/access/read-grant.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const throwsWith = (fn: () => unknown, match: RegExp, label: string) => {
  try {
    fn();
  } catch (err) {
    assert.match(String(err instanceof Error ? err.message : err), match, label);
    n++;
    return;
  }
  assert.fail(`${label} — expected a throw, got none`);
};

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"] }),
  defineDomain({ name: "payments", channels: ["slack/T1/C_PAY"] }),
];

const HOOK = defineWebhook({
  id: "deploy-status",
  source: "oe-standard-webhook",
  secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",
  broker: "env",
  target: "slack/T1/C_ENG",
  readableBy: [{ level: "domain", domain: "eng" }],
  instruction: "Summarise the deploy.",
});

{
  console.log("\n1. undecidable ⇒ INERT:");
  const noRegistry = readGrantReach("slack/T1/C_ENG", HOOK.readableBy, undefined);
  ok(noRegistry.undecidable !== undefined, "no domain registry ⇒ undecidable (assertWebhooksValid runs at module import, where the config seam may not be armed)");
  eq([...noRegistry.impossible, ...noRegistry.unreachable], [], "🔴 …and BOTH defect lists are empty — an unanswerable question reports NOTHING, it does not report a problem");

  const noGrant = readGrantReach("slack/T1/C_ENG", undefined, DOMAINS);
  ok(noGrant.undecidable !== undefined, "an ingress with NO declared grant is undecidable — a vendor ingress is authorized per-delivery by its scheme's own adapter, off a payload nobody has yet");
  eq([...noGrant.impossible, ...noGrant.unreachable], [], "…and reports nothing, so the native GitHub fan-out is never refused by a check that cannot see its authorization at all");

  eq(grantDomainsExist(HOOK.readableBy, undefined).undecidable !== undefined, true, "the domain-existence arm is undecidable without a registry too");

  ok(
    (() => {
      try {
        assertWebhooksValid([{ ...HOOK, readableBy: [{ level: "domain", domain: "does-not-exist" }] }]);
        return true;
      } catch {
        return false;
      }
    })(),
    "🔴 assertWebhooksValid WITHOUT `domains` accepts a grant naming an unknown domain — byte-identical to pre-OPE-215, because a validator that cannot ask must not refuse",
  );
}

{
  console.log("\n2. impossible ⇒ refuse:");
  const typo = grantDomainsExist([{ level: "domain", domain: "engg" }], DOMAINS);
  eq(typo.unreachable, [], "a typo'd domain is not a warning");
  ok(typo.impossible.length === 1, "…it is IMPOSSIBLE — a non-empty registry proves the loader ran, so a name not in it can never match, by any surface, ever");
  ok(typo.impossible[0]!.includes("eng, payments"), "the refusal NAMES the declared domains — the one fact that makes a typo fixable without reading another file");

  throwsWith(
    () => assertWebhooksValid([{ ...HOOK, readableBy: [{ level: "domain", domain: "engg" }] }], { domains: DOMAINS, warn: () => {} }),
    /can never happen/,
    "🔴 assertWebhooksValid THROWS on an impossible grant — the boot-time half of doctrine 6, and the state that used to be accepted then silent forever",
  );

  const midSetup = grantDomainsExist([{ level: "domain", domain: "eng" }], []);
  eq(midSetup.impossible, [], "🔴 an EMPTY domain registry does NOT make a grant impossible — mid-setup is legitimate, and a boot failure over it is the outage this whole module's rule 2 exists to prevent");
  ok(midSetup.unreachable.length === 1, "…it warns instead: the same fact, stated, without taking the deployment down");

  eq(grantDomainsExist([{ level: "org" }], DOMAINS).impossible, [], "an org-level grant is never refused — there is no registry of legal orgs to check it against");
  eq(grantDomainsExist([{ level: "tenant", tenant: "slack/T_UNKNOWN" }], DOMAINS).impossible, [], "a tenant grant is never refused — a workspace exists because Slack says so, not because this repo declares it");
}

{
  console.log("\n3. unreachable ⇒ warn:");
  eq(readGrantReach("slack/T1/C_ENG", HOOK.readableBy, DOMAINS), { impossible: [], unreachable: [] }, "the happy path is decided CLEAN — a positive verdict, not merely an absence of findings");

  const wrongDomain = readGrantReach("slack/T1/C_PAY", HOOK.readableBy, DOMAINS);
  ok(wrongDomain.unreachable.length === 1 && wrongDomain.impossible.length === 0, "a target in a domain the grant does not name is UNREACHABLE, not impossible — the hook still fires its own declared instruction");
  ok(wrongDomain.unreachable[0]!.includes('domain "payments"'), "the warning names the domain the channel is actually in");
  ok(wrongDomain.unreachable[0]!.includes("never fire"), "…and states the consequence, which is the whole point of a create-time message");

  const zeroDomain = readGrantReach("slack/T1/C_NOWHERE", HOOK.readableBy, DOMAINS);
  ok(zeroDomain.unreachable.length === 1, "🔴 a target channel in NO domain is reported — the zero-domain shape, caught where a human is reading a diff instead of as silence at every fire");
  ok(zeroDomain.unreachable[0]!.includes("no memory domain"), "…and says so in those words");

  for (const [label, grant] of [
    ["org", [{ level: "org" as const }]],
    ["tenant", [{ level: "tenant" as const, tenant: "slack/T1" }]],
    ["surface", [{ level: "surface" as const, surface: "slack/T1/C_NOWHERE" }]],
  ] as const) {
    const reach = readGrantReach("slack/T1/C_NOWHERE", grant, DOMAINS);
    const fireTime = scopeGrantsRead(grant, { tenantKey: "slack/T1", surfaceKey: "slack/T1/C_NOWHERE", domains: [] });
    ok(fireTime, `a ${label}-level grant DOES grant at fire time on a domainless surface (the premise — if this flips, the case below is vacuous)`);
    eq(reach, { impossible: [], unreachable: [] }, `🔴 …so the diagnostic must report it CLEAN: a ${label}-level grant needs no domain, and refusing it would refuse something that works`);
  }

  const warnings: string[] = [];
  assertWebhooksValid([{ ...HOOK, target: "slack/T1/C_PAY" }], { domains: DOMAINS, warn: (m) => warnings.push(m) });
  ok(warnings.length === 1 && warnings[0]!.includes("deploy-status"), "🔴 an unreachable finding WARNS and validation PASSES — a probably is not worth a boot failure, and the warning names the hook");

  const clean: string[] = [];
  assertWebhooksValid([HOOK], { domains: DOMAINS, warn: (m) => clean.push(m) });
  eq(clean, [], "a reachable hook warns about nothing (so the assertion above means something)");
}

{
  console.log("\n4. one rule, two callers:");
  const cases: { surface: string; grant: ReadableBy }[] = [
    { surface: "slack/T1/C_ENG", grant: [{ level: "domain", domain: "eng" }] },
    { surface: "slack/T1/C_PAY", grant: [{ level: "domain", domain: "eng" }] },
    { surface: "slack/T1/C_ENG", grant: [{ level: "org" }] },
    { surface: "slack/T1/C_ENG", grant: [{ level: "tenant", tenant: "slack/T1" }] },
    { surface: "slack/T1/C_ENG", grant: [{ level: "tenant", tenant: "slack/T_OTHER" }] },
    { surface: "slack/T1/C_ENG", grant: [{ level: "surface", surface: "slack/T1/C_ENG" }] },
    { surface: "slack/T1/C_ENG", grant: [{ level: "surface", surface: "slack/T1/C_PAY" }] },
  ];
  for (const c of cases) {
    const reach = readGrantReach(c.surface, c.grant, DOMAINS);
    const fireTime = scopeGrantsRead(c.grant, { tenantKey: "slack/T1", surfaceKey: c.surface, domains: ["eng", "payments"].filter((d) => (c.surface === "slack/T1/C_ENG" ? d === "eng" : d === "payments")) });
    eq(reach.unreachable.length === 0, fireTime, `🔴 create-time agrees with fire-time for ${c.grant[0]!.level} @ ${c.surface} — one rule, asked twice, never two rules`);
  }
  ok(readGrantReach("slack/T1/C_ENG", [{ level: "principal", principal: "U1" }], DOMAINS).unreachable.length === 1, "a principal-only grant is reported unreachable — matching scopeGrantsRead's structural refusal of the DM universe");
}

{
  console.log("\n5. merge semantics:");
  const merged = mergeReach({ impossible: [], unreachable: [], undecidable: "no registry" }, { impossible: ["boom"], unreachable: [] });
  eq(merged.undecidable, undefined, "🔴 one arm being unable to ask does not silence an arm that COULD — undecidable is not contagious");
  eq(merged.impossible, ["boom"], "…and the decided arm's findings survive the merge");
  ok(mergeReach({ impossible: [], unreachable: [], undecidable: "a" }, { impossible: [], unreachable: [], undecidable: "b" }).undecidable !== undefined, "ALL arms undecidable ⇒ the whole verdict is, which is the honest reading of 'we learned nothing'");

  const both = webhookReach({ id: "h", target: "slack/T1/C_NOWHERE", readableBy: [{ level: "domain", domain: "nope" }] }, DOMAINS);
  ok(both.impossible.length === 1 && both.unreachable.length === 1, "webhookReach reports the unknown domain AND the un-domained target — a declaration with two problems should not have to be fixed twice to see the second");
}

{
  console.log("\n6. the callers:");
  const createRoutine = readFileSync(new URL("../agent/tools/create_routine.ts", import.meta.url), "utf8");
  ok(createRoutine.includes("readGrantReach("), "🔴 create_routine still asks the reach question — `checkEventReadGrant` having exactly one caller, and this not being it, IS the defect (routines/ingress.ts says so in as many words)");
  ok(
    /reach\.impossible[\s\S]{0,80}reach\.unreachable/.test(createRoutine),
    "🔴 …and it refuses on BOTH categories, unlike assertWebhooksValid — a subscription that can never read is a pure no-op, where a hook with an unreadable target still fires its own instruction",
  );
  ok(/catch\s*\{[\s\S]{0,120}domains = undefined/.test(createRoutine), "🔴 …and its config reads are wrapped, so 'we could not ask' stays INERT rather than refusing a subscription that is probably fine");

  const config = readFileSync(new URL("../agent/webhooks/config.ts", import.meta.url), "utf8");
  ok(config.includes("webhookReach("), "assertWebhooksValid runs the sweep");
  ok(/deps\.domains/.test(config), "…off an OPTIONAL registry, which is what keeps module-import-time validation inert rather than dependent on a seam that may not be armed");
}

console.log(`\n✓ webhook-achievability (OPE-215): ${n} assertions passed`);
