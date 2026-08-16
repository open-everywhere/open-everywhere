import assert from "node:assert/strict";
import {
  teamsBotDisplayNameViaGraph,
  teamsCatalogDisplayNameViaGraph,
  resolveTeamsBotDisplayNameViaGraph,
  teamsBotDisplayName,
  _resetTeamsBotDisplayNameForTest,
} from "../agent/channels/teams-bot-name.js";
import type { TeamsGraphRequester } from "../agent/channels/teams-read.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const APP_ID = "11111111-2222-3333-4444-555555555555";

function spy(answer: unknown): { req: TeamsGraphRequester; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    req: async (url) => {
      urls.push(url);
      return answer;
    },
  };
}

{
  const { req, urls } = spy({ displayName: "open-everywhere" });
  const name = await teamsBotDisplayNameViaGraph(APP_ID, req);
  eq(name, "open-everywhere", "🔴 the arm answers with the app's own Graph display name");
  eq(urls.length, 1, "…from exactly ONE Graph call");
  ok(
    urls[0] === `https://graph.microsoft.com/v1.0/servicePrincipals(appId='${APP_ID}')?$select=displayName`,
    `🔴 …and it reads the app's own SERVICE PRINCIPAL (the object that exists in every tenant that consented), selected down to displayName — got ${urls[0]}`,
  );
}

{
  eq(await teamsBotDisplayNameViaGraph(APP_ID, spy({ displayName: "  Open Everywhere  " }).req), "Open Everywhere", "a padded display name is trimmed");
  eq(await teamsBotDisplayNameViaGraph(APP_ID, spy({ displayName: "   " }).req), undefined, "🔴 NEGATIVE CONTROL: a whitespace-only displayName reads undefined, never a blank identity line");
  eq(await teamsBotDisplayNameViaGraph(APP_ID, spy({ displayName: "" }).req), undefined, "an empty displayName reads undefined");
  eq(await teamsBotDisplayNameViaGraph(APP_ID, spy({ displayName: 42 }).req), undefined, "🔴 a NON-STRING displayName reads undefined — the arm never renders a coerced value");
  eq(await teamsBotDisplayNameViaGraph(APP_ID, spy({ id: "sp-1" }).req), undefined, "a response with no displayName field reads undefined");
  eq(await teamsBotDisplayNameViaGraph(APP_ID, spy(null).req), undefined, "a null body reads undefined");
  eq(await teamsBotDisplayNameViaGraph(APP_ID, spy("not json").req), undefined, "a non-object body reads undefined");
}

{
  const boom: TeamsGraphRequester = async () => {
    throw new Error("read: Teams Graph GET failed (HTTP 403)");
  };
  eq(await teamsBotDisplayNameViaGraph(APP_ID, boom), undefined, "🔴 a THROWING Graph request reads undefined — a name lookup can never fail instruction assembly");
}

{
  const { req, urls } = spy({ displayName: "should not be reached" });
  eq(await teamsBotDisplayNameViaGraph("", req), undefined, "an empty app id reads undefined");
  eq(urls.length, 0, "…and issues NO Graph call — an unconfigured deployment never probes");
}

{
  delete process.env.MICROSOFT_APP_ID;
  delete process.env.TEAMS_APP_ID;
  _resetTeamsBotDisplayNameForTest();

  const first = teamsBotDisplayName();
  const second = teamsBotDisplayName();
  ok(first === second, "🔴 the live arm returns the SAME memoised promise on a second call — one resolution per instance, not one per turn");
  eq(await first, undefined, "…and an unconfigured deployment resolves undefined, never a throw into instruction assembly");

  _resetTeamsBotDisplayNameForTest();
  ok(teamsBotDisplayName() !== first, "_resetTeamsBotDisplayNameForTest drops the memo, so one test cannot inherit another's");
}

{
  const { req, urls } = spy({ value: [{ displayName: "Open Everywhere" }] });
  const name = await teamsCatalogDisplayNameViaGraph(APP_ID, req);
  eq(name, "Open Everywhere", "🔴 the catalog leg answers with the teamsApps catalog entry's displayName");
  eq(urls.length, 1, "…from exactly ONE Graph call");
  ok(
    urls[0] === `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps?$filter=externalId eq '${APP_ID}'&$expand=appDefinitions`,
    `🔴 …and it reads the app-catalog teamsApps entry filtered by externalId — got ${urls[0]}`,
  );
}

{
  const name = await teamsCatalogDisplayNameViaGraph(APP_ID, spy({ value: [{ appDefinitions: [{ displayName: "Open Everywhere (def)" }] }] }).req);
  eq(name, "Open Everywhere (def)", "a response shape with only appDefinitions[0].displayName still answers");
}

{
  eq(await teamsCatalogDisplayNameViaGraph(APP_ID, spy({ value: [] }).req), undefined, "🔴 NEGATIVE CONTROL: no catalog entry for this appId reads undefined, never a throw");
  eq(await teamsCatalogDisplayNameViaGraph(APP_ID, spy({ value: [{ displayName: "   " }] }).req), undefined, "a whitespace-only catalog displayName reads undefined");
  eq(await teamsCatalogDisplayNameViaGraph(APP_ID, spy(null).req), undefined, "a null body reads undefined");
  const forbidden: TeamsGraphRequester = async () => {
    throw new Error("read: Teams Graph GET failed (HTTP 403) — Missing role permissions AppCatalog.Read.All");
  };
  eq(await teamsCatalogDisplayNameViaGraph(APP_ID, forbidden), undefined, "🔴 an unconsented AppCatalog.Read.All (403) reads undefined, not a throw");
  eq(await teamsCatalogDisplayNameViaGraph("", spy({ value: [{ displayName: "should not be reached" }] }).req), undefined, "an empty app id makes no call");
}

{
  const urls: string[] = [];
  const req: TeamsGraphRequester = async (url) => {
    urls.push(url);
    if (url.includes("appCatalogs")) return { value: [{ displayName: "Open Everywhere" }] };
    throw new Error("the service-principal leg must not be reached when the catalog leg already answered");
  };
  const name = await resolveTeamsBotDisplayNameViaGraph(APP_ID, req);
  eq(name, "Open Everywhere", "🔴 the catalog name wins when Graph can answer it");
  eq(urls.length, 1, "🔴 …and the service-principal leg is never called once the catalog leg has an answer");
}
{
  const urls: string[] = [];
  const req: TeamsGraphRequester = async (url) => {
    urls.push(url);
    if (url.includes("appCatalogs")) throw new Error("read: Teams Graph GET failed (HTTP 403)");
    if (url.includes("servicePrincipals")) return { displayName: "open-everywhere" };
    throw new Error(`unexpected URL: ${url}`);
  };
  const name = await resolveTeamsBotDisplayNameViaGraph(APP_ID, req);
  eq(name, "open-everywhere", "🔴 an unconsented catalog leg falls back to the service-principal name — the pre-OPE-609 behaviour");
  eq(urls.length, 2, "…having tried the catalog leg first, then the fallback");
  ok(urls[0].includes("appCatalogs"), "the catalog leg is tried BEFORE the service-principal leg");
}
{
  const bothFail: TeamsGraphRequester = async () => {
    throw new Error("read: Teams Graph GET failed (HTTP 403)");
  };
  eq(await resolveTeamsBotDisplayNameViaGraph(APP_ID, bothFail), undefined, "🔴 NEGATIVE CONTROL: both legs failing reads undefined, never a fabricated name");
}

console.log(`teams-bot-name-test: ${n} assertions passed`);
