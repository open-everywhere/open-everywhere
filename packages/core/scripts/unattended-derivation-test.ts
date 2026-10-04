import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "oe-unattended-derivation-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
delete process.env.OE_TRUST;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}
async function throwsWith(fn: () => unknown, needle: RegExp, label: string): Promise<void> {
  let msg: string | null = null;
  try {
    await fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg !== null && needle.test(msg), `${label} (got: ${msg ?? "no throw"})`);
}

const { registerConfig } = await import("../agent/access/config.js");
const { requestApproval } = await import("../agent/approvals/flow.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { principalIdOf, actingPrincipalIdOf, unattendedOf } = await import("../agent/access/request.js");
const { bridgedContext } = await import("../agent/identity/binding-bridge.js");
const { routineFireAttributes, webhookFireAttributes, serviceTokenFireAttributes } = await import("../agent/routines/fire-auth.js");

const ORG = "test-org";
const TEAM = "T1";
const CREATOR = "U_CREATOR";
const HUMAN = "U_HUMAN";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [{ name: "plain", reach: [`slack/${TEAM}/C_PLAIN`] }],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

type Attrs = Record<string, string>;
function fireCtx(attributes: Attrs, principalId = "eve:app"): never {
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { authenticator: "app", principalId, principalType: "runtime", attributes } } },
  } as never;
}
function liveCtx(): never {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: TEAM, channel_id: "C_PLAIN", channel_type: "channel", user_id: HUMAN, is_ext_shared: "false", trust_checked: "true" },
          principalId: HUMAN,
          principalType: "slack-user",
        },
      },
    },
  } as never;
}

const destAttrs = { team_id: TEAM, channel_id: "C_PLAIN", channel_type: "channel" };
const routine = { id: "r1", org: ORG, surfaceKey: `slack/${TEAM}/C_PLAIN`, createdBy: CREATOR, promptGeneration: 1 } as never;
const orphanRoutine = { id: "r2", org: ORG, surfaceKey: `slack/${TEAM}/C_PLAIN`, promptGeneration: 1 } as never;

const routineBag = routineFireAttributes(routine, destAttrs, "channel", true, true);
const orphanBag = routineFireAttributes(orphanRoutine, destAttrs, "channel", true);
const webhookBag = webhookFireAttributes("inbound", TEAM, "C_PLAIN", false, true);
const routineFire = fireCtx(routineBag);
const orphanFire = fireCtx(orphanBag);
const webhookFire = fireCtx(webhookBag, "webhook:inbound");
const human = liveCtx();
{
  ok(unattendedOf(routineFire) === true, "derive: a ROUTINE fire's real attribute bag derives unattended: true");
  ok(unattendedOf(orphanFire) === true, "derive: a CREATOR-LESS routine fire derives true too — the marker is stamped unconditionally, so a fire with nobody to name still says it is a fire");
  ok(unattendedOf(webhookFire) === true, "derive: a WEBHOOK fire derives true — the family that used to bind `webhook:<hookId>` and satisfy every presence gate");
  ok(unattendedOf(human) === false, "derive: 🔴 a LIVE HUMAN turn on the same channel derives EXACTLY false — the control has to distinguish, not just refuse");
  ok(actingPrincipalIdOf(human) === HUMAN, "derive: …and that human's acting principal is really there, so the false is earned and not an empty bag reading as attended");
}

{
  const SVC = "svc:e2e-harness";
  const doorCtx = (attributes: Attrs, principalId = SVC): never =>
    ({
      channel: { kind: "slack" },
      session: { auth: { current: { authenticator: "oe-service-token", principalId, principalType: "service", attributes } } },
    }) as never;

  const readDoor = doorCtx(serviceTokenFireAttributes("read"));
  const injectDoor = doorCtx(serviceTokenFireAttributes("inject"), "svc:eval-inject");
  ok(unattendedOf(readDoor) === true, "door: the READ door's real bag derives unattended: true");
  ok(unattendedOf(injectDoor) === true, "door: the WAKE-INJECTION family value derives true too — one builder, so the marker does not depend on which family verified the caller");
  ok(principalIdOf(readDoor) === SVC, "door: the BOUND principal is still the service id — the audit trail's answer to WHICH service called is untouched");
  ok(actingPrincipalIdOf(readDoor) === undefined, "door: 🔴 …and the ACTING principal is gone, so every `if (!actingPrincipalIdOf(ctx)) throw` presence gate refuses a token caller");

  const unmarked = doorCtx({ oe_token_family: "read" });
  ok(unattendedOf(unmarked) === false, "door: 🔴 the marker-LESS bag derives false — the assertion above is earned by the marker, not by `principalType: \"service\"`");
  ok(actingPrincipalIdOf(unmarked) === SVC, "door: 🔴 …and it answers presence with the service id, which is exactly the hole OPE-278 measured one fire family over");
}

{
  ok(principalIdOf(routineFire) === CREATOR, "trap: the routine fire's BOUND principal is the creator — a real person's id, non-empty");
  ok(principalIdOf(webhookFire) === "webhook:inbound", "trap: the webhook fire's BOUND principal is its hook's service id — also non-empty");
  const boundSpelling = (ctx: never): boolean => principalIdOf(ctx) === undefined;
  ok(boundSpelling(routineFire) === false, "trap: 🔴 the BOUND spelling answers `false` for a routine fire — that is the substitution that would card every fire into an empty room, and it type-checks");
  ok(boundSpelling(webhookFire) === false, "trap: 🔴 …and `false` for a webhook fire too");
  ok(boundSpelling(human) === false && unattendedOf(human) === false, "trap: …while BOTH spellings answer false on a live human, which is exactly why no test that used a human ever caught it");
}

{
  const carried = bridgedContext({ platform: "slack", principalId: "webhook:inbound", principalType: "service", attributes: webhookBag });
  ok(unattendedOf(carried) === true, "bridge: a tool context reconstituted through identity/binding-bridge.ts still derives true — the bag rides verbatim");
  const carriedHuman = bridgedContext({ platform: "slack", principalId: HUMAN, principalType: "slack-user", attributes: { team_id: TEAM, channel_id: "C_PLAIN", channel_type: "channel", user_id: HUMAN } });
  ok(unattendedOf(carriedHuman) === false, "bridge: …and a human's bridged context still derives false");
}

const postCard = async (): Promise<string> => `ts-${Math.random().toString(36).slice(2)}`;
let carded = 0;
const countingPostCard = async (): Promise<string> => {
  carded += 1;
  return postCard();
};
const baseInput = {
  org: ORG,
  kind: "skill.delete",
  args: { org: ORG, domain: "plain", name: "ghost-skill", requestedBy: CREATOR },
  scopeKey: `slack/${TEAM}/C_PLAIN`,
  domain: "plain",
  channelId: "C_PLAIN",
  requestedBy: CREATOR,
  threadTs: null,
};
{
  const before = (await getOperationalStore().listPendingActions(ORG)).length;
  await throwsWith(
    () => requestApproval({ ...baseInput, chain: { unattended: unattendedOf(routineFire) } }, { postCard: countingPostCard }),
    /DENIED by the approver chain.*ask-unattended/s,
    "join: 🔴 the value DERIVED from a real fire denies the propose with reason ask-unattended",
  );
  ok(carded === 0, "join: …no card was posted — a card in an empty room is the thing the transform exists to stop");
  ok((await getOperationalStore().listPendingActions(ORG)).length === before, "join: …and no pending row was minted, so nothing is left behind to expire");
}
{
  ok(unattendedOf(human) === false, "join: the human context feeding the next propose derives exactly false");
  carded = 0;
  const res = await requestApproval({ ...baseInput, requestedBy: HUMAN, chain: { unattended: unattendedOf(human) } }, { postCard: countingPostCard });
  ok(res.autoApproved === undefined && typeof res.id === "string", "join: 🔴 the value derived from a LIVE HUMAN turn cards normally — the same verb, denied a moment ago");
  ok(carded === 1, "join: …exactly one card was posted");
  const row = (await getOperationalStore().listPendingActions(ORG)).find((r) => r.id === res.id);
  ok(row !== undefined && row.status === "pending", "join: …and its pending row awaits the click");
}

{
  carded = 0;
  await throwsWith(
    () => requestApproval({ ...baseInput, args: { ...baseInput.args, name: "ghost-skill-2" }, requestedBy: HUMAN }, { postCard: countingPostCard }),
    /DENIED by the approver chain.*ask-unattended/s,
    "default: 🔴 a propose with NO chain bag denies — absence of the signal means nobody is watching",
  );
  ok(carded === 0, "default: …and mints no card, so a forgotten line fails loudly instead of silently carding an autonomous run");
}

{
  const measuredProdBag: Attrs = {
    channel_id: "C_PLAIN",
    channel_type: "channel",
    is_ext_shared: "false",
    open_everywhere_routine_id: "r1",
    open_everywhere_routine_org: ORG,
    open_everywhere_routine_surface: `slack/${TEAM}/C_PLAIN`,
    team_id: TEAM,
    trust_checked: "true",
  };
  ok(
    measuredProdBag["oe_fire_unattended"] === undefined && measuredProdBag["oe_fire_principal"] === undefined,
    "fail-closed/prod: the measured bag really is missing BOTH stamps — otherwise the leg below would pass on the old arm",
  );
  const prodShapeFire = fireCtx(measuredProdBag);
  ok(unattendedOf(prodShapeFire) === true, "fail-closed/prod: 🔴 the shape the deployment measured derives true — the routine marker alone says nobody is acting");
  ok(actingPrincipalIdOf(prodShapeFire) === undefined, "fail-closed/prod: …and its presence fence closes, so a propose tool refuses it instead of carding into an empty room");
  ok(principalIdOf(prodShapeFire) === "eve:app", "fail-closed/prod: …while WHO stays honestly answerable — the floor removes authority, never attribution");

  const bareScheduleFire = fireCtx({});
  ok(unattendedOf(bareScheduleFire) === true, "fail-closed/bare: 🔴 a schedule-started session with NO attributes at all still derives true — the arm that survives losing the whole bag");
  ok(actingPrincipalIdOf(bareScheduleFire) === undefined, "fail-closed/bare: …and its fence closes too");

  ok(
    unattendedOf({ channel: { kind: "slack" }, session: { auth: { current: { authenticator: "app", principalId: "eve:app", principalType: "slack-user", attributes: {} } } } } as never) === false,
    "fail-closed/human: a slot with the WRONG principalType is not a schedule fire — the predicate reads all three fields",
  );
  ok(
    unattendedOf({ channel: { kind: "slack" }, session: { auth: { current: { principalId: "eve:app", principalType: "runtime", attributes: {} } } } } as never) === false,
    "fail-closed/human: …and a slot with NO authenticator is not one either",
  );
  ok(unattendedOf(human) === false, "fail-closed/human: 🔴 a LIVE HUMAN turn still derives EXACTLY false — the floor did not swallow the true/false distinction");
  ok(actingPrincipalIdOf(human) === HUMAN, "fail-closed/human: …and that human still has an acting principal, so their proposes still card");
}
{
  carded = 0;
  const before = (await getOperationalStore().listPendingActions(ORG)).length;
  await throwsWith(
    () =>
      requestApproval(
        { ...baseInput, args: { ...baseInput.args, name: "ghost-skill-3" }, chain: { unattended: unattendedOf(fireCtx({})) } },
        { postCard: countingPostCard },
      ),
    /DENIED by the approver chain.*ask-unattended/s,
    "fail-closed/join: 🔴 the value derived from a BAGLESS schedule fire denies — end to end, not only at the predicate",
  );
  ok(carded === 0, "fail-closed/join: …and posts no card");
  ok((await getOperationalStore().listPendingActions(ORG)).length === before, "fail-closed/join: …and mints no pending row");
}
{
  const bridgedProdShape = bridgedContext({
    platform: "slack",
    principalId: "eve:app",
    principalType: "runtime",
    authenticator: "app",
    attributes: { team_id: TEAM, channel_id: "C_PLAIN", channel_type: "channel" },
  });
  ok(unattendedOf(bridgedProdShape) === true, "fail-closed/bridge: 🔴 a bagless fire reconstituted through the identity bridge still derives true");
  const bridgedHuman = bridgedContext({
    platform: "slack",
    principalId: HUMAN,
    principalType: "slack-user",
    attributes: { team_id: TEAM, channel_id: "C_PLAIN", channel_type: "channel", user_id: HUMAN },
  });
  ok(unattendedOf(bridgedHuman) === false, "fail-closed/bridge: …and a bridged human still derives false");
}

await removeTempDir(tmp);
console.log(`✓ unattended-derivation: ${passed} assertions passed`);
