import assert from "node:assert/strict";
import { teamsRoomMembershipViaGraph, teamsAccountActiveViaGraph } from "../agent/channels/teams-fire-eligibility.js";
import { _resetTeamsGraphTeamIdCache, _seedTeamsGraphTeamIdForTest } from "../agent/channels/teams-graph-team-id.js";
import type { TeamsGraphRequester } from "../agent/channels/teams-read.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const TEAM = "19:team1@thread.tacv2";
const GRAPH_TEAM = "2b8f1c40-9d3a-4f6e-8a11-5c7d0e2f3a4b";
const CHAN = "19:abc@thread.tacv2";
const CREATOR = "aad-0001-creator";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";

_resetTeamsGraphTeamIdCache();
_seedTeamsGraphTeamIdForTest(TEAM, GRAPH_TEAM);

{
  const foundPage1: TeamsGraphRequester = async () => ({ value: [{ userId: "someone-else" }, { userId: CREATOR }] });
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, SERVICE_URL, foundPage1)).member === true, "membership: found on the first (only) page ⇒ true");

  let calls = 0;
  const foundPage2: TeamsGraphRequester = async () => {
    calls++;
    if (calls === 1) return { value: [{ userId: "someone-else" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" };
    return { value: [{ userId: CREATOR }] };
  };
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, SERVICE_URL, foundPage2)).member === true, "membership: found on a LATER page ⇒ pagination is actually followed, not just page 1 read");
  ok(calls === 2, "membership: …exactly two requests, one per page — no over-fetch once found");

  const fullyEnumeratedNoMatch: TeamsGraphRequester = async () => ({ value: [{ userId: "a" }, { userId: "b" }] });
  ok(
    (await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, SERVICE_URL, fullyEnumeratedNoMatch)).member === false,
    "membership: the FULL roster was seen and did not include the creator ⇒ CONFIRMED false, which is the answer that now SKIPS a fire (OPE-1810)",
  );

  const alwaysMore: TeamsGraphRequester = async () => ({ value: [{ userId: "not-the-creator" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/more" });
  ok(
    (await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, SERVICE_URL, alwaysMore)).member === undefined,
    "membership: 🔴 hitting the page bound with roster STILL UNSEEN degrades to UNRESOLVED, never a manufactured 'removed' — unlike core's Slack probe on the same shape",
  );

  const malformed: TeamsGraphRequester = async () => ({ notValue: [] });
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, SERVICE_URL, malformed)).member === undefined, "membership: a response with no `value` array ⇒ unresolvable, never a fabricated false");

  const throws: TeamsGraphRequester = async () => {
    throw new Error("Graph 403");
  };
  ok(
    (await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, SERVICE_URL, throws)).member === undefined,
    "membership: a THROWING requester (token mint failure / non-ok Graph response) degrades to unresolved, never a crash",
  );

  const neverCalled: TeamsGraphRequester = async () => {
    throw new Error("must never be called — an empty id argument means nothing to ask");
  };
  ok((await teamsRoomMembershipViaGraph("", CHAN, CREATOR, SERVICE_URL, neverCalled)).member === undefined, "membership: an empty teamId ⇒ unresolvable, and the requester is never even called");
  ok((await teamsRoomMembershipViaGraph(TEAM, "", CREATOR, SERVICE_URL, neverCalled)).member === undefined, "membership: an empty channelId ⇒ unresolvable, never called");
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, "", SERVICE_URL, neverCalled)).member === undefined, "membership: an empty aadObjectId ⇒ unresolvable, never called");
}

{
  let seenUrl = "";
  const capture: TeamsGraphRequester = async (url) => {
    seenUrl = url;
    return { value: [{ userId: CREATOR }] };
  };
  const res = await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, SERVICE_URL, capture);
  ok(res.member === true, "graph team id: the read succeeds once the id is resolved");
  ok(
    seenUrl.includes(`/teams/${GRAPH_TEAM}/`),
    `graph team id: 🔴 THE OPE-1810 CLAIM — the Graph URL carries the MICROSOFT 365 GROUP id (got: ${seenUrl})`,
  );
  ok(
    !seenUrl.includes(encodeURIComponent(TEAM)) && !seenUrl.includes(TEAM),
    `graph team id: 🔴 …and NEVER the Bot Connector id it was handed. That spelling addresses nothing, so Graph 404s and the creator check silently stops enforcing (got: ${seenUrl})`,
  );

  const neverCalled: TeamsGraphRequester = async () => {
    throw new Error("must never be called — an unresolvable team id means there is no Graph address to read");
  };
  const unresolvable = await teamsRoomMembershipViaGraph("19:unmapped@thread.tacv2", CHAN, CREATOR, undefined, neverCalled);
  ok(unresolvable.member === undefined, "graph team id: an unresolvable team id ⇒ unresolvable, and the requester is never called");
  ok(
    unresolvable.member === undefined && unresolvable.unresolved === "team_id_unresolved",
    "graph team id: …reported as `team_id_unresolved`, distinct from a Graph read that failed — different problems, different remedies",
  );

  seenUrl = "";
  const direct = await teamsRoomMembershipViaGraph(GRAPH_TEAM, CHAN, CREATOR, undefined, capture);
  ok(direct.member === true && seenUrl.includes(`/teams/${GRAPH_TEAM}/`), "graph team id: an id that is already a group id passes straight through, with no Connector call");
}

{
  const cases: readonly (readonly [string, TeamsGraphRequester, string])[] = [
    [
      "read_error",
      async () => {
        throw new Error("Graph 403 — ChannelMember.Read.Group not consented");
      },
      "a Graph read that failed (network / 5xx / a permission the install lacks)",
    ],
    ["malformed_response", async () => ({ notValue: [] }), "Graph answered with something that is not a member page"],
    [
      "roster_incomplete",
      async () => ({ value: [{ userId: "not-the-creator" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/more" }),
      "the page bound was reached with roster left unseen",
    ],
  ];
  for (const [cause, req, why] of cases) {
    const res = await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, SERVICE_URL, req);
    ok(res.member === undefined && res.unresolved === cause, `unresolved cause: \`${cause}\` — ${why}`);
  }

  const neverCalled: TeamsGraphRequester = async () => {
    throw new Error("must never be called");
  };
  const empty = await teamsRoomMembershipViaGraph("", CHAN, CREATOR, SERVICE_URL, neverCalled);
  ok(empty.member === undefined && empty.unresolved === "missing_ids", "unresolved cause: `missing_ids` — an empty id argument, reported as its own cause rather than folded into a read failure");
}

{
  const active: TeamsGraphRequester = async () => ({ accountEnabled: true });
  ok((await teamsAccountActiveViaGraph(CREATOR, active)) === true, "active: accountEnabled:true ⇒ true");

  const inactive: TeamsGraphRequester = async () => ({ accountEnabled: false });
  ok((await teamsAccountActiveViaGraph(CREATOR, inactive)) === false, "active: accountEnabled:false ⇒ CONFIRMED false");

  const missingField: TeamsGraphRequester = async () => ({});
  ok((await teamsAccountActiveViaGraph(CREATOR, missingField)) === undefined, "active: a response with no accountEnabled field ⇒ unresolvable, never a fabricated verdict");

  const wrongType: TeamsGraphRequester = async () => ({ accountEnabled: "yes" });
  ok((await teamsAccountActiveViaGraph(CREATOR, wrongType)) === undefined, "active: a non-boolean accountEnabled ⇒ unresolvable, not coerced to truthy");

  const throws: TeamsGraphRequester = async () => {
    throw new Error("Graph 404 — user not found");
  };
  ok((await teamsAccountActiveViaGraph(CREATOR, throws)) === undefined, "active: a THROWING requester (404 / auth / transport) degrades to unresolved, never a crash and never a fabricated 'inactive'");

  const neverCalled: TeamsGraphRequester = async () => {
    throw new Error("must never be called — an empty id argument means nothing to ask");
  };
  ok((await teamsAccountActiveViaGraph("", neverCalled)) === undefined, "active: an empty aadObjectId ⇒ unresolvable, and the requester is never even called");
}

console.log(`✓ ${n} teams fire-eligibility assertions passed`);
