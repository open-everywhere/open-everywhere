import assert from "node:assert/strict";
// proves: TOOL-upgrade_self
import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("upgrade-self");
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();
import { registerConfig, type AccessRequestsConfig } from "../agent/access/config.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import { defineBinding, defineBundle } from "../agent/access/bundle.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { readAudit } from "../agent/audit/audit.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { PersonFacingError } from "../agent/channels/person-text.js";
import { recordRequesterIdentity } from "../agent/access/requester-identity.js";
import { outboundKey } from "../agent/operational/post-once.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";
import {
  compareReleaseVersions,
  parseReleaseVersion,
  readLatestPublishedVersion,
  REGISTRY_LATEST_URL,
  selfUpgradeBranch,
  selfUpgradeSteps,
  upgradeOfferText,
} from "../agent/status/self-upgrade.js";
import upgradeSelfTool, { NOT_AN_ADMIN_TEXT, runUpgradeSelf, UPGRADE_SELF_REFUSED, UPGRADE_SELF_STARTED } from "../agent/tools/upgrade_self.js";
import upgradeOfferSchedule, { UPGRADE_OFFERED, UPGRADE_OFFER_TICK, upgradeOfferMetaKey, upgradeOfferTick } from "../agent/schedules/upgrade-offer.js";
import { TOOL_CONSEQUENCE } from "../agent/access/consequence.js";
import { WINDOW_UNGATED_TOOLS, JOB_WAKE_TOOLS } from "../agent/access/window-gate-manifest.js";
import { LEAN_SEAT_TOOLS } from "../agent/access/lean-seat.js";
import { CONTRIBUTIONS } from "../agent/contributions.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

async function rejection(p: Promise<unknown>, label: string): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  assert.fail(`${label}: expected a refusal, and it resolved`);
}

{
  ok(parseReleaseVersion("0.9.1")?.join(".") === "0.9.1", "§1 a release version parses");
  for (const bad of ["0.9", "0.9.1-rc.1", "v0.9.1", "01.2.3", "0.9.1+build", "", "latest"]) {
    ok(parseReleaseVersion(bad) === undefined, `§1 "${bad}" is not a release version`);
  }
  ok(compareReleaseVersions("0.10.0", "0.9.9")! > 0, "§1 the compare is numeric per part, never a string compare");
  ok(compareReleaseVersions("0.9.1", "0.9.1") === 0, "§1 equal releases compare equal");
  ok(compareReleaseVersions("0.9.0", "0.9.1")! < 0, "§1 an older release compares older");
  ok(compareReleaseVersions("0.9.2-rc.1", "0.9.1") === undefined, "§1 a prerelease is never compared as newer");

  const fetchAnswering = (respond: () => Response | Promise<Response>): { readonly fn: typeof fetch; readonly urls: string[] } => {
    const urls: string[] = [];
    const fn = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return respond();
    }) as typeof fetch;
    return { fn, urls };
  };
  const good = fetchAnswering(() => new Response(JSON.stringify({ name: "@open-everywhere/core", version: "0.9.2" }), { status: 200 }));
  ok((await readLatestPublishedVersion(good.fn)) === "0.9.2", "§1 the registry's latest release is read");
  ok(good.urls.length === 1 && good.urls[0] === REGISTRY_LATEST_URL, "§1 the read asks the registry's latest dist-tag, and nothing else");
  ok((await readLatestPublishedVersion(fetchAnswering(() => new Response("nope", { status: 404 })).fn)) === undefined, "§1 a 404 reads as unknown");
  ok((await readLatestPublishedVersion(fetchAnswering(() => new Response(JSON.stringify({ version: "1.0.0-beta.1" }))).fn)) === undefined, "§1 a prerelease on latest reads as unknown");
  ok((await readLatestPublishedVersion(fetchAnswering(() => new Response("{not json")).fn)) === undefined, "§1 a broken body reads as unknown");
  ok(
    (await readLatestPublishedVersion((async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch)) === undefined,
    "§1 a network error reads as unknown, never a throw",
  );

  ok(selfUpgradeBranch("0.9.2") === "oe-upgrade/0.9.2", "§1 one branch per target");
  const steps = selfUpgradeSteps({ from: "0.9.1", to: "0.9.2", repo: "acme/agent", base: "main" });
  const all = steps.join("\n");
  ok(/checkout_repo with repo "acme\/agent"/.test(steps[0]!), "§1 step 1 clones the deployment's own repo with checkout_repo");
  ok(/not granted the repository, stop and tell the admin/.test(steps[0]!), "§1 step 1 says what to do when checkout_repo refuses an ungranted room");
  ok(/\.claude\/skills\/upgrade-open-everywhere\/SKILL\.md/.test(all) && /npx oe upgrade --to 0\.9\.2 --plan/.test(all) && /npx oe upgrade --to 0\.9\.2`/.test(all), "§1 the steps run the template skill, the plan first");
  ok(/open_pull_request with repo "acme\/agent", head "oe-upgrade\/0\.9\.2" and base "main"/.test(all), "§1 the pull request goes through open_pull_request, on the one branch");
  ok(/Never run `git push`/.test(all) && !/\bthen `git push`|run `git push`\./.test(all), "§1 the steps never tell the worker to push");
  ok(/Never merge/.test(all) && /\/eve\/v1\/oe\/status/.test(all) && /version\.core field must read 0\.9\.2/.test(all), "§1 the worker never merges, and the post-deploy check reads the status route");
  ok(/BREAKING, ENV, MANUAL and DEFAULT/.test(all) && /Do not decide it/.test(all), "§1 the skill's stop-and-ask lines go to the admin");

  const offer = upgradeOfferText({ installed: "0.9.1", latest: "0.9.2", repo: "acme/agent" });
  ok(/0\.9\.2/.test(offer) && /0\.9\.1/.test(offer) && /"upgrade yourself"/.test(offer) && /acme\/agent/.test(offer), "§1 the offer names both releases, the words to say and the repo");
  ok(/until someone merges/.test(offer) && /once for each release/.test(offer), "§1 the offer says nothing changes before a merge, and that it is said once");
}

const domains: Domain[] = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/T1/U_ORG_ADMIN"] }),
  defineDomain({ name: "ops", title: "ops", reach: ["slack/T1/C_OPS"], admins: ["slack/T1/U_OPS_ADMIN"] }),
];
const NO_BASE = { baseBundles: () => [], baseBindings: () => [] };
let accessRequests: AccessRequestsConfig = { ...NO_BASE, configRepo: "acme/agent", adminChannel: "C_ADMIN" };
registerConfig({
  loadBundles: () => [defineBundle({ name: "self-upgrade", repos: ["acme/agent"] })],
  loadBindings: () => [defineBinding({ bundle: "self-upgrade", scope: { level: "surface", surface: "slack/T1/C_OPS" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadAccessRequests: () => accessRequests,
});

const ctxFor = (principalId: string, channelId = "C_OPS"): BindableContext => ({
  channel: { kind: "slack" },
  session: {
    auth: {
      current: {
        principalId,
        principalType: "slack-user",
        attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel", is_private: "false" },
      },
    },
  },
});
const ORG = (await import("../agent/identity/binding.js")).deploymentOrg();
const rowsOf = async (action: string) => readAudit({ org: ORG, action, limit: 50 });
const latest = async () => "0.9.2";
const deps = { latest, installed: () => "0.9.1" };

{
  const r = await runUpgradeSelf({}, ctxFor("U_ORG_ADMIN"), deps);
  ok(r.status === "ready" && r.from === "0.9.1" && r.to === "0.9.2", `§2 an org admin gets a ready plan from the installed to the latest release (saw: ${r.status} ${r.from}→${r.to})`);
  ok(r.repo === "acme/agent" && r.base === "main" && r.branch === "oe-upgrade/0.9.2", "§2 the plan names the config repo, its base and the branch");
  ok(r.steps.length > 0 && r.steps.some((s) => /open_pull_request/.test(s)), "§2 the plan carries the steps");
  const started = await rowsOf(UPGRADE_SELF_STARTED);
  const d = started[0]?.detail as Record<string, unknown> | undefined;
  ok(started.length === 1 && started[0]!.principalId === "U_ORG_ADMIN", "§2 the start writes ONE audit row, attributed to the admin");
  ok(d?.from === "0.9.1" && d?.to === "0.9.2" && d?.repo === "acme/agent" && d?.base === "main" && d?.branch === "oe-upgrade/0.9.2", "§2 the start row carries the versions, the repo, the base and the branch");
}
{
  const err = await rejection(runUpgradeSelf({}, ctxFor("U_MEMBER"), deps), "§2 member");
  ok(err instanceof PersonFacingError && err.message === NOT_AN_ADMIN_TEXT, `§2 a member is refused plainly (saw: ${err.message})`);
  ok(!/slack\/|Domain\.admins|domains\.ts|principal key/u.test(err.message), "§2 the refusal names no roster, key or file");
  const refused = await rowsOf(UPGRADE_SELF_REFUSED);
  ok(refused.some((r) => r.principalId === "U_MEMBER" && (r.detail as { reason?: unknown }).reason === "not-org-admin"), "§2 the refusal writes an upgrade.self.refused row with its reason");
  ok((await rowsOf(UPGRADE_SELF_STARTED)).length === 1, "§2 a refusal writes no start row");
}
{
  const err = await rejection(runUpgradeSelf({}, ctxFor("U_OPS_ADMIN"), deps), "§2 domain admin");
  ok(err.message === NOT_AN_ADMIN_TEXT, "§2 a domain admin is not enough: upgrading changes the whole deployment");
}
{
  const unverified: BindableContext = { channel: { kind: "slack" }, session: { auth: { current: { principalType: "slack-user", attributes: { team_id: "T1", channel_id: "C_OPS", channel_type: "channel", is_private: "false" } } } } };
  const err = await rejection(runUpgradeSelf({}, unverified, deps), "§2 unverified");
  ok(err instanceof PersonFacingError && err.message !== NOT_AN_ADMIN_TEXT && /verified/i.test(err.message), `§2 an asker the gate cannot name reads the gate's own sentence, not "you are not one" (saw: ${err.message})`);
  ok((await rowsOf(UPGRADE_SELF_REFUSED)).some((r) => (r.detail as { reason?: unknown }).reason === "unverified-asker"), "§2 that refusal is recorded as unverified-asker");
}
{
  accessRequests = { ...NO_BASE, adminChannel: "C_ADMIN" };
  const err = await rejection(runUpgradeSelf({}, ctxFor("U_ORG_ADMIN"), deps), "§2 no config repo");
  ok(/names no repository of its own/.test(err.message) && /accessRequests\.configRepo/.test(err.message), "§2 no config repo refuses with the setting that fixes it");
  accessRequests = { ...NO_BASE, configRepo: "acme/agent", adminChannel: "C_ADMIN", configBase: "release" };
  const r = await runUpgradeSelf({}, ctxFor("U_ORG_ADMIN"), deps);
  ok(r.base === "release", "§2 the base is accessRequests.configBase when set");
}
{
  const refusedLatest = await rejection(runUpgradeSelf({}, ctxFor("U_ORG_ADMIN"), { latest: async () => undefined, installed: () => "0.9.1" }), "§2 registry unreadable");
  ok(/could not read the newest release/.test(refusedLatest.message), "§2 an unreadable registry refuses, and names the version form to ask with");
  const reasons = async () => (await rowsOf(UPGRADE_SELF_REFUSED)).map((r) => (r.detail as { reason?: unknown }).reason);
  const named = await runUpgradeSelf({ to: "v0.10.0" }, ctxFor("U_ORG_ADMIN"), { latest: async () => assert.fail("a named target never reads the registry"), installed: () => "0.9.1" });
  ok(named.status === "ready" && named.to === "0.10.0", "§2 a named target is taken as asked, with a leading v dropped");
  const bad = await rejection(runUpgradeSelf({ to: "next" }, ctxFor("U_ORG_ADMIN"), deps), "§2 bad target");
  ok(/not a release version/.test(bad.message), "§2 a target that is not X.Y.Z refuses");
  const older = await rejection(runUpgradeSelf({ to: "0.9.0" }, ctxFor("U_ORG_ADMIN"), deps), "§2 older target");
  ok(/is older/.test(older.message) && /revert/.test(older.message), "§2 a downgrade refuses, and names the revert");
  const unknownInstalled = await rejection(runUpgradeSelf({ to: "0.9.2" }, ctxFor("U_ORG_ADMIN"), { latest, installed: () => "0.9.2-dev.3" }), "§2 installed not a release");
  ok(/not a release version, so I cannot tell/.test(unknownInstalled.message), "§2 an installed build that is not a release refuses: newer cannot be checked");
  const seen = await reasons();
  for (const reason of ["registry-unreadable", "bad-target", "older-target", "installed-unknown"]) {
    ok(seen.includes(reason), `§2 🔴 every refusal writes a row: "${reason}" is recorded (saw: ${seen.join(", ")})`);
  }
  const before = (await rowsOf(UPGRADE_SELF_STARTED)).length;
  const current = await runUpgradeSelf({ to: "0.9.1" }, ctxFor("U_ORG_ADMIN"), deps);
  ok(current.status === "current" && current.steps.length === 0, "§2 the installed release answers current, with no steps");
  ok((await rowsOf(UPGRADE_SELF_STARTED)).length === before, "§2 a current answer starts nothing and writes no start row");
}

{
  const windowCtx = (): BindableContext =>
    ({
      channel: { kind: "slack" },
      session: {
        auth: {
          current: {
            principalId: "U_ORG_ADMIN",
            principalType: "slack-user",
            attributes: { team_id: "T1", channel_id: "C_OPS", channel_type: "channel", is_private: "false", oe_grain: "standing", oe_window_token: "oe-dom:d:win:slack_T1_C_OPS:oe-sup:g1" },
          },
        },
      },
    }) as unknown as BindableContext;
  const askedBy = (who: string) => `<message trigger="true" from="human" author-id="${who}">upgrade yourself</message>`;
  const err = await inEveContext(new FakeEveContext(), async () => {
    const ctx = windowCtx();
    recordRequesterIdentity(ctx, undefined, askedBy("U_MEMBER"));
    return await rejection(runUpgradeSelf({}, ctx, deps), "§2 member under an admin's auth");
  });
  ok(err.message === NOT_AN_ADMIN_TEXT, `§2 🔴 a member's ask on a turn that carries an admin's auth is refused (saw: ${err.message})`);
  const row = (await rowsOf(UPGRADE_SELF_REFUSED))[0]!;
  ok(row.principalId === "U_MEMBER", `§2 🔴 the refusal row names the person who asked, not the turn's auth (saw: ${row.principalId})`);
  ok((row.detail as { boundPrincipal?: unknown }).boundPrincipal === "U_ORG_ADMIN", "§2 …and records the turn's own principal beside it");
  const ctl = await inEveContext(new FakeEveContext(), async () => {
    const ctx = windowCtx();
    recordRequesterIdentity(ctx, undefined, askedBy("U_ORG_ADMIN"));
    try {
      return (await runUpgradeSelf({}, ctx, deps)).status;
    } catch (e) {
      return (e as Error).message;
    }
  });
  ok(ctl === "ready", `§2 NEGATIVE CONTROL: the same seat with the admin as the asker gets a ready plan (saw: ${ctl})`);
  const unnamed = await inEveContext(new FakeEveContext(), async () => await rejection(runUpgradeSelf({}, windowCtx(), deps), "§2 no requester record"));
  ok(unnamed instanceof PersonFacingError && unnamed.message !== NOT_AN_ADMIN_TEXT, "§2 a window seat with no record of who asked refuses as unverified");
  const unnamedRow = (await rowsOf(UPGRADE_SELF_REFUSED))[0]!;
  const ud = unnamedRow.detail as { reason?: unknown; boundPrincipal?: unknown };
  ok(unnamedRow.principalId === undefined || unnamedRow.principalId === null, `§2 🔴 that row names NO principal — never the turn's auth (saw: ${unnamedRow.principalId})`);
  ok(ud.reason === "unverified-asker" && ud.boundPrincipal === "U_ORG_ADMIN", "§2 …it says unverified-asker, and records the turn's own principal as boundPrincipal");
}

{
  const store = getOperationalStore();
  const posts: Array<{ method: string; body: URLSearchParams }> = [];
  const post = async (method: string, body: string) => {
    posts.push({ method, body: new URLSearchParams(body) });
    return { ok: true };
  };
  const orgs = [ORG];
  const target = { channel: "C_ADMIN", repo: "acme/agent" };
  const ticksBefore = (await rowsOf(UPGRADE_OFFER_TICK)).length;

  const t1 = await upgradeOfferTick({ orgs, installed: "0.9.1", latest, post, target, store });
  ok(t1.posted && t1.outcome === "offered", `§3 a newer release is offered (saw: ${t1.outcome})`);
  ok(posts.length === 1 && posts[0]!.method === "chat.postMessage" && posts[0]!.body.get("channel") === "C_ADMIN", "§3 the offer posts once, in the admin channel");
  ok(/0\.9\.2/.test(posts[0]!.body.get("text") ?? "") && /"upgrade yourself"/.test(posts[0]!.body.get("text") ?? ""), "§3 the post carries the offer's words");
  ok((await store.getMeta(upgradeOfferMetaKey("0.9.2"))) !== null, "§3 the once is recorded in the deployment meta");
  const offered = await rowsOf(UPGRADE_OFFERED);
  ok(offered.length === 1 && (offered[0]!.detail as { version?: unknown }).version === "0.9.2", "§3 the offer writes an upgrade.offered row with the version");

  const t2 = await upgradeOfferTick({ orgs, installed: "0.9.1", latest, post, target, store });
  ok(!t2.posted && t2.outcome === "no-op: already offered" && posts.length === 1, "§3 🔴 a second tick says nothing: once per release, not once per week");

  const t3 = await upgradeOfferTick({ orgs, installed: "0.9.1", latest: async () => "0.9.3", post, target, store });
  ok(t3.posted && posts.length === 2 && /0\.9\.3/.test(posts[1]!.body.get("text") ?? ""), "§3 the next release is offered once in its turn");

  const t4 = await upgradeOfferTick({ orgs, installed: "0.9.3", latest: async () => "0.9.3", post, target, store });
  ok(!t4.posted && t4.outcome === "no-op: current", "§3 a current deployment hears nothing");
  const t5 = await upgradeOfferTick({ orgs, installed: "0.9.1", latest: async () => undefined, post, target, store });
  ok(!t5.posted && t5.outcome === "no-op: registry unreadable", "§3 an unreadable registry says nothing");
  const t6 = await upgradeOfferTick({ orgs, installed: "0.9.1", latest: async () => "0.9.4", post, target: { repo: "acme/agent" }, store });
  ok(!t6.posted && t6.outcome === "skipped: no admin channel configured", "§3 no admin channel: no post");
  ok((await store.getMeta(upgradeOfferMetaKey("0.9.4"))) === null, "§3 a skipped offer records no once, so it is still offered when the channel is set");
  const failing = async () => ({ ok: false });
  const t7 = await upgradeOfferTick({ orgs, installed: "0.9.1", latest: async () => "0.9.5", post: failing, target, store });
  ok(!t7.posted && /did not confirm ok/.test(t7.outcome) && (await store.getMeta(upgradeOfferMetaKey("0.9.5"))) === null, "§3 a failed post records no once");
  const brokenStore = {
    getMeta: async (): Promise<string | null> => {
      throw new Error("db down");
    },
    setMeta: async () => undefined,
  };
  const t8 = await upgradeOfferTick({ orgs, installed: "0.9.1", latest: async () => "0.9.6", post, target, store: brokenStore });
  ok(!t8.posted && t8.outcome === "no-op: already offered", "§3 a store that cannot answer never re-posts");

  await store.markEventSeen(ORG, outboundKey({ surface: "system", channel: "C_ADMIN", action: "upgrade.offer", payload: "0.9.7" }), new Date().toISOString(), 60_000);
  const before9 = posts.length;
  const t9 = await upgradeOfferTick({ orgs, installed: "0.9.1", latest: async () => "0.9.7", post, target, store });
  ok(t9.posted && t9.outcome === "offered" && posts.length === before9, `§3 🔴 a resumed tick does not post twice, and still reports the offer (saw: ${t9.outcome})`);
  ok((await store.getMeta(upgradeOfferMetaKey("0.9.7"))) !== null, "§3 🔴 …and it writes the once, so next week stays quiet");

  const t10 = await upgradeOfferTick({ orgs, installed: "0.9.1", latest: async () => "0.9.8", post, target: { channel: "C_ADMIN" }, store });
  ok(!t10.posted && t10.outcome === "skipped: no config repo configured" && (await store.getMeta(upgradeOfferMetaKey("0.9.8"))) === null, "§3 no config repo: no offer the tool would refuse, and no once recorded");

  const before11 = posts.length;
  const offeredB = async () => (await readAudit({ org: "org-b", action: UPGRADE_OFFERED, limit: 50 })).length;
  const ticksB = async () => (await readAudit({ org: "org-b", action: UPGRADE_OFFER_TICK, limit: 50 })).length;
  const t11 = await upgradeOfferTick({ orgs: [ORG, "org-b"], installed: "0.9.1", latest: async () => "0.9.9", post, target, store });
  ok(t11.posted && posts.length === before11 + 1, "§3 🔴 two swept orgs share one admin channel: ONE post, not one per org");
  ok((await offeredB()) === 1 && (await ticksB()) === 1, "§3 …and each org gets its own offered row and heartbeat row");

  const ticks = (await rowsOf(UPGRADE_OFFER_TICK)).length - ticksBefore;
  ok(ticks === 11, `§3 every tick writes one heartbeat row per swept org, whatever happened (saw: ${ticks})`);
}

{
  const row = TOOL_CONSEQUENCE.upgrade_self;
  ok(row?.tier === "gate:admin" && row.via.kind === "admin-roles", "§4 the tool is declared gate:admin through admin standing");
  ok(WINDOW_UNGATED_TOOLS.has("upgrade_self") && !JOB_WAKE_TOOLS.has("upgrade_self"), "§4 the tool carries a posture, and an unattended fire never holds it");
  ok(!LEAN_SEAT_TOOLS.has("upgrade_self"), "§4 the seat stays lean: the tool is worker-only");
  ok(typeof (upgradeSelfTool as { execute?: unknown }).execute === "function", "§4 the tool module exports an eve tool");
  const kinds = CONTRIBUTIONS.contributions.map((c) => `${c.kind}/${c.name}`);
  ok(kinds.includes("tool/upgrade_self") && kinds.includes("schedule/upgrade-offer"), "§4 both are in the contribution manifest");
  ok((upgradeOfferSchedule as { cron?: string }).cron === "0 6 * * 1", "§4 the offer runs weekly, Monday 06:00 UTC");
}

console.log(`✓ upgrade-self: ${n} assertions passed`);
