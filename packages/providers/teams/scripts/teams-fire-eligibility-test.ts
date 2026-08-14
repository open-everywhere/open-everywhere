import assert from "node:assert/strict";
import { teamsRoomMembershipViaGraph, teamsAccountActiveViaGraph } from "../agent/channels/teams-fire-eligibility.js";
import type { TeamsGraphRequester } from "../agent/channels/teams-read.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const TEAM = "T1";
const CHAN = "19:abc@thread.tacv2";
const CREATOR = "aad-0001-creator";

{
  const foundPage1: TeamsGraphRequester = async () => ({ value: [{ userId: "someone-else" }, { userId: CREATOR }] });
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, foundPage1)) === true, "membership: found on the first (only) page ⇒ true");

  let calls = 0;
  const foundPage2: TeamsGraphRequester = async () => {
    calls++;
    if (calls === 1) return { value: [{ userId: "someone-else" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" };
    return { value: [{ userId: CREATOR }] };
  };
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, foundPage2)) === true, "membership: found on a LATER page ⇒ pagination is actually followed, not just page 1 read");
  ok(calls === 2, "membership: …exactly two requests, one per page — no over-fetch once found");

  const fullyEnumeratedNoMatch: TeamsGraphRequester = async () => ({ value: [{ userId: "a" }, { userId: "b" }] });
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, fullyEnumeratedNoMatch)) === false, "membership: the FULL roster was seen and did not include the creator ⇒ CONFIRMED false");

  const alwaysMore: TeamsGraphRequester = async () => ({ value: [{ userId: "not-the-creator" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/more" });
  ok(
    (await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, alwaysMore)) === undefined,
    "membership: 🔴 hitting the page bound with roster STILL UNSEEN degrades to UNRESOLVED, never a manufactured 'removed' — unlike core's Slack probe on the same shape",
  );

  const malformed: TeamsGraphRequester = async () => ({ notValue: [] });
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, malformed)) === undefined, "membership: a response with no `value` array ⇒ unresolvable, never a fabricated false");

  const throws: TeamsGraphRequester = async () => {
    throw new Error("Graph 403");
  };
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, CREATOR, throws)) === undefined, "membership: a THROWING requester (token mint failure / non-ok Graph response) degrades to unresolved, never a crash");

  const neverCalled: TeamsGraphRequester = async () => {
    throw new Error("must never be called — an empty id argument means nothing to ask");
  };
  ok((await teamsRoomMembershipViaGraph("", CHAN, CREATOR, neverCalled)) === undefined, "membership: an empty teamId ⇒ unresolvable, and the requester is never even called");
  ok((await teamsRoomMembershipViaGraph(TEAM, "", CREATOR, neverCalled)) === undefined, "membership: an empty channelId ⇒ unresolvable, never called");
  ok((await teamsRoomMembershipViaGraph(TEAM, CHAN, "", neverCalled)) === undefined, "membership: an empty aadObjectId ⇒ unresolvable, never called");
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
