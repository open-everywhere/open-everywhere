import assert from "node:assert/strict";
import { teamsBotDisplayNameViaGraph, teamsBotDisplayName, _resetTeamsBotDisplayNameForTest } from "../agent/channels/teams-bot-name.js";
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

console.log(`teams-bot-name-test: ${n} assertions passed`);
