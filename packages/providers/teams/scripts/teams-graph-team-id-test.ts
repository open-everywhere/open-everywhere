import {
  teamsGraphTeamId,
  _resetTeamsGraphTeamIdCache,
  type TeamsGraphTeamIdDeps,
  type TeamsTeamDetailsResponse,
} from "../agent/channels/teams-graph-team-id.js";

let failures = 0;
function ok(cond: boolean, what: string): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${what}`);
  } else console.log(`ok: ${what}`);
}

const CONNECTOR_TEAM = "19:aBcDeF0123456789@thread.tacv2";
const GROUP_ID = "7e5a0000-0000-4000-8000-000000000001";
const SERVICE_URL = "https://smba.trafficmanager.net/uk/";

function connector(res: TeamsTeamDetailsResponse): { deps: TeamsGraphTeamIdDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      request: async ({ serviceUrl, path }) => {
        calls.push(`${serviceUrl}${path}`);
        return res;
      },
    },
  };
}

const okWith = (body: unknown): TeamsTeamDetailsResponse => ({ ok: true, body });

{
  _resetTeamsGraphTeamIdCache();
  const c = connector(okWith({ id: CONNECTOR_TEAM, name: "Open Everywhere", aadGroupId: GROUP_ID }));
  const resolved = await teamsGraphTeamId(CONNECTOR_TEAM, SERVICE_URL, c.deps);
  ok(resolved === GROUP_ID, "a Connector team id resolves to the team's Entra GROUP id — the id every Graph `/teams/{id}` URL takes");
  ok(
    resolved !== undefined && !resolved.startsWith("19:"),
    "🔴 …and NEVER passes the activity's own `19:…@thread.tacv2` through: that string addresses no Graph team, and the catch-up's 404 reads back as an empty window",
  );
  ok(c.calls.length === 1 && c.calls[0] === `${SERVICE_URL}/v3/teams/${encodeURIComponent(CONNECTOR_TEAM)}`, "…asked the Connector for THIS team's details, on the activity's own regional serviceUrl");
}

{
  _resetTeamsGraphTeamIdCache();
  const c = connector(okWith({ aadGroupId: GROUP_ID }));
  ok((await teamsGraphTeamId(CONNECTOR_TEAM, SERVICE_URL, c.deps)) === GROUP_ID, "cache: the first wake resolves");
  ok((await teamsGraphTeamId(CONNECTOR_TEAM, SERVICE_URL, c.deps)) === GROUP_ID, "cache: the second wake resolves to the same id");
  ok(c.calls.length === 1, "cache: …having asked the Connector ONCE — a team's group id does not change, and a wake must not pay a round trip for it");
}

{
  _resetTeamsGraphTeamIdCache();
  const c = connector(okWith({ aadGroupId: GROUP_ID }));
  ok((await teamsGraphTeamId(GROUP_ID, SERVICE_URL, c.deps)) === GROUP_ID, "an activity that already carries a group id passes straight through");
  ok(c.calls.length === 0, "…with no Connector call: there is nothing to resolve");
}

{
  _resetTeamsGraphTeamIdCache();
  const c = connector(okWith({ aadGroupId: GROUP_ID }));
  ok((await teamsGraphTeamId(undefined, SERVICE_URL, c.deps)) === undefined, "no team on the activity (a personal or group chat) resolves to nothing");
  ok((await teamsGraphTeamId(CONNECTOR_TEAM, undefined, c.deps)) === undefined, "no serviceUrl resolves to nothing — the Connector call has no endpoint to go to");
  ok(c.calls.length === 0, "…and neither shape called the Connector");

  _resetTeamsGraphTeamIdCache();
  const noField = connector(okWith({ id: CONNECTOR_TEAM, name: "Open Everywhere" }));
  ok(
    (await teamsGraphTeamId(CONNECTOR_TEAM, SERVICE_URL, noField.deps)) === undefined,
    "a 200 with NO `aadGroupId` resolves to nothing — the fail-closed arm, so a non-address never reaches a Graph URL",
  );

  _resetTeamsGraphTeamIdCache();
  const refused = connector({ ok: false, body: { error: { code: "NotFound" } } });
  ok(
    (await teamsGraphTeamId(CONNECTOR_TEAM, SERVICE_URL, refused.deps)) === undefined,
    "🔴 a NON-OK Connector answer resolves to nothing — the Connector reports a refusal as a status, never as a throw, so reading only the body would take a 404's error object for a team",
  );
  ok(refused.calls.length === 1, "…having actually made the call it refused");

  _resetTeamsGraphTeamIdCache();
  const notAnId = connector(okWith({ aadGroupId: CONNECTOR_TEAM }));
  ok((await teamsGraphTeamId(CONNECTOR_TEAM, SERVICE_URL, notAnId.deps)) === undefined, "an `aadGroupId` that is not a group id resolves to nothing");

  _resetTeamsGraphTeamIdCache();
  const thrown: TeamsGraphTeamIdDeps = { request: async () => { throw new Error("connector down"); } };
  ok((await teamsGraphTeamId(CONNECTOR_TEAM, SERVICE_URL, thrown)) === undefined, "a throwing Connector call resolves to nothing rather than failing the wake");
}

{
  _resetTeamsGraphTeamIdCache();
  let attempt = 0;
  const flaky: TeamsGraphTeamIdDeps = {
    request: async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient");
      return okWith({ aadGroupId: GROUP_ID });
    },
  };
  ok((await teamsGraphTeamId(CONNECTOR_TEAM, SERVICE_URL, flaky)) === undefined, "a failed resolution answers nothing");
  ok(
    (await teamsGraphTeamId(CONNECTOR_TEAM, SERVICE_URL, flaky)) === GROUP_ID,
    "🔴 …and is NOT cached: the next wake asks again and succeeds, so one network blip never freezes a surface as permanently unreadable",
  );
}

console.log(failures === 0 ? "\nteams-graph-team-id: all checks passed" : `\nteams-graph-team-id: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
