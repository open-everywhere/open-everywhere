import { expect, test } from "vitest";
import {
  bootAgent,
  disposeLater,
  registerScript,
  slackDmWake,
  slackTs,
  SLACK_TEAM_ID,
  waitFor,
  type RecordedRequest,
} from "../harness";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { denyLinkChallenge, issueLinkChallenge } from "@open-everywhere/core/agent/identity/link-store.js";

const CLAIMANT_ID = "U0EXOWNER";

const INITIATOR_ID = "U0OPE1959INIT";

const DM_CHANNEL_ID = "D0OPE1959CLAIM";

const REFUSAL_MARK = "the link you just claimed is still open";

function resultById(requests: readonly RecordedRequest[], id: string): { readonly isError: boolean; readonly output: unknown } | undefined {
  for (const r of requests) {
    const hit = r.toolResults.find((t) => t.id === id);
    if (hit) return { isError: hit.isError, output: hit.output };
  }
  return undefined;
}

test("a turn that just claimed a link cannot start another one, and the control proves the tool was reachable", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();

  const issued = await issueLinkChallenge({
    org,
    platform: "slack",
    tenant: SLACK_TEAM_ID,
    nativeId: INITIATOR_ID,
    surfaceKey: `slack/${SLACK_TEAM_ID}/D0OPE1959INIT`,
  });
  expect(issued.code, "fixture: the code transport minted a claimable code").toBeTruthy();
  expect(
    (await store.listLinkChallenges(org)).length,
    "fixture: the store starts this file with exactly the one challenge the initiator just opened",
  ).toBe(1);

  const refusedRun = registerScript({
    parent: [{ calls: [{ tool: "link_identity", input: {}, id: "ope1959-start-after-claim" }] }, { say: "ope1959 leg one done" }],
  });
  const claimTs = slackTs(Date.now(), 195_901);
  const claimWake = await slackDmWake({
    channelId: DM_CHANNEL_ID,
    userId: CLAIMANT_ID,
    text: `link ${issued.code!}`,
    ts: claimTs,
    eventId: `EvOPE1959A${claimTs.replace(".", "")}`,
  });
  expect(claimWake.status, `the claim DM wake was not accepted: ${claimWake.body.slice(0, 200)}`).toBe(200);

  const refused = await waitFor(
    () => resultById(refusedRun.requests, "ope1959-start-after-claim"),
    "the claimant turn's own `link_identity` result",
  );

  const afterClaim = await store.listLinkChallenges(org);
  expect(afterClaim.length, "the refused start minted NOTHING — the store still holds exactly the initiator's one challenge").toBe(1);
  expect(afterClaim[0]!.status, "fixture: the pre-model hook CLAIMED the challenge on this wake").toBe("claimed");
  expect(afterClaim[0]!.claimedNativeId, "fixture: the claim was stamped with the wake's own captured author").toBe(CLAIMANT_ID);

  expect(refused.isError, "🔴 `link_identity` is REFUSED while this account's own claim is still open").toBe(true);
  const refusalText = JSON.stringify(refused.output);
  expect(refusalText, "🔴 …and the refusal is the open-claim line, not one of the tool's five other throws").toContain(REFUSAL_MARK);
  if (afterClaim[0]!.backNonceHash !== undefined) {
    expect(refusalText, "🔴 …and it points at the pending code-back this DM already carries").toContain("the code I posted you in this conversation");
  }

  refusedRun.dispose();

  expect(await denyLinkChallenge({ org, challengeId: issued.challenge.id }), "control setup: the initiator's deny decided the claimed challenge").toBe(true);

  const allowedRun = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "link_identity", input: {}, id: "ope1959-start-clean" }] }, { say: "ope1959 leg two done" }],
    }),
  );
  const cleanTs = slackTs(Date.now(), 195_902);
  const cleanWake = await slackDmWake({
    channelId: DM_CHANNEL_ID,
    userId: CLAIMANT_ID,
    text: "ope1959 please link another one of my accounts",
    ts: cleanTs,
    eventId: `EvOPE1959B${cleanTs.replace(".", "")}`,
  });
  expect(cleanWake.status, `the control DM wake was not accepted: ${cleanWake.body.slice(0, 200)}`).toBe(200);

  const allowed = await waitFor(() => resultById(allowedRun.requests, "ope1959-start-clean"), "the control turn's own `link_identity` result");
  expect(
    allowed.isError,
    `🔴 THE CONTROL: with no open claim the SAME call from the SAME account SUCCEEDS — so leg ① measured the open claim and not a trust gate, a missing mount or a DM-only throw. Got: ${JSON.stringify(allowed.output).slice(0, 400)}`,
  ).toBe(false);
  expect(
    (await store.listLinkChallenges(org, { initiatingNativeId: CLAIMANT_ID })).length,
    "🔴 …and it really minted this account's own challenge, which is the write leg ① refused",
  ).toBe(1);
}, 360_000);
