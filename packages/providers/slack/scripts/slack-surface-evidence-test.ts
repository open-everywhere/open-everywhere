import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.OE_SQLITE_PATH = ":memory:";
delete process.env.DATABASE_URL;
delete process.env.OE_OPERATIONAL_PROVIDER;
process.env.OE_TELEMETRY = "off";

const { _resetSurfaceEventStampMemoForTest, getOperationalStore, surfaceEventVerifiedAt, deploymentOrg } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);
const { buildFrontHandler } = await import("../agent/channels/slack-front.js");
const { slackSurfaceStatus } = await import("../agent/status.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const SECRET = "surface-evidence-signing-secret";
const NOW_MS = 1_784_764_600_000;
const JSON_CT = "application/json";

const signed = (body: string, contentType = JSON_CT, signature?: string): Request => {
  const ts = String(Math.floor(NOW_MS / 1000));
  const sig = signature ?? `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("https://oe.test/eve/v1/slack", {
    method: "POST",
    headers: { "content-type": contentType, "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
};

const waits: Promise<unknown>[] = [];
const fakeArgs = { from: () => ({ send: async () => ({}) }), waitUntil: (p: Promise<unknown>) => void waits.push(p) };
type Args = Parameters<ReturnType<typeof buildFrontHandler>>[1];
const args = fakeArgs as unknown as Args;

const URL_VERIFICATION = JSON.stringify({ type: "url_verification", challenge: "c-1", token: "t" });
const REACTION = JSON.stringify({
  type: "event_callback",
  team_id: "T1",
  event_id: "EvSE1",
  event: { type: "reaction_added", user: "UHUMAN", reaction: "thumbsup", item_user: "UOTHER", item: { type: "message", channel: "C1", ts: "9.9" } },
});

{
  let stamps = 0;
  const handler = buildFrontHandler(async () => new Response("inner"), {
    signingSecret: SECRET,
    now: () => NOW_MS,
    getBotIdentity: async () => ({ userId: "UBOT" }),
    stampEventVerified: async () => void stamps++,
  });

  const forged = await handler(signed(URL_VERIFICATION, JSON_CT, "v0=deadbeef"), args);
  ok(forged.status === 401 && stamps === 0, "§1 🔴 a forged signature is refused (401) and writes NO stamp");
  const unsigned = await handler(
    new Request("https://oe.test/eve/v1/slack", { method: "POST", headers: { "content-type": JSON_CT }, body: URL_VERIFICATION }),
    args,
  );
  ok(unsigned.status === 401 && stamps === 0, "§1 🔴 an unsigned request is refused (401) and writes NO stamp");

  const challenge = await handler(signed(URL_VERIFICATION), args);
  ok(challenge.status === 200 && stamps === 1, "§1 a signed url_verification (the install-time handshake) stamps once");
  const reaction = await handler(signed(REACTION), args);
  await Promise.all(waits);
  ok(reaction.status === 200 && stamps === 2, "§1 a signed event_callback stamps too — the stamp sits before classification, so no envelope kind skips it");
}

{
  let stampDone = false;
  let stampDoneWhenInnerRan: boolean | undefined;
  const handler = buildFrontHandler(
    async () => {
      stampDoneWhenInnerRan = stampDone;
      return new Response("inner");
    },
    {
      signingSecret: SECRET,
      now: () => NOW_MS,
      stampEventVerified: async () => {
        await new Promise((r) => setTimeout(r, 30));
        stampDone = true;
      },
    },
  );
  const res = await handler(signed(URL_VERIFICATION), args);
  ok(res.status === 200 && stampDoneWhenInnerRan === true, "§1b 🔴 the url_verification forward reaches eve only AFTER the stamp write has landed");
}

{
  _resetSurfaceEventStampMemoForTest();
  ok((await surfaceEventVerifiedAt("slack")) === null, "§2 a fresh store holds no Slack evidence");
  const handler = buildFrontHandler(async () => new Response("inner"), { signingSecret: SECRET, now: () => NOW_MS });
  const res = await handler(signed(URL_VERIFICATION), args);
  ok(res.status === 200, "§2 the signed delivery is accepted");
  let at: string | null = null;
  for (let i = 0; i < 50 && at === null; i++) {
    await new Promise((r) => setTimeout(r, 10));
    at = await surfaceEventVerifiedAt("slack");
  }
  ok(at !== null, "§2 with no injection, the front's verified delivery wrote the durable stamp to the operational store");
}

{
  const env = { SLACK_BOT_TOKEN: "xoxb-placeholder", SLACK_SIGNING_SECRET: "placeholder" } as NodeJS.ProcessEnv;
  const store = getOperationalStore();
  ok((await store.listChannelSessions(deploymentOrg())).length === 0, "§3 precondition: NO channel_session row exists — the legacy evidence cannot answer");
  ok((await slackSurfaceStatus(env)).eventsVerified === "yes", "§3 🔴 eventsVerified reads yes from the stamp alone, whatever the domain topology");

  await store.setMeta("surface_event_verified:slack", "cleared-by-test");
  ok((await slackSurfaceStatus(env)).eventsVerified === "unknown", "§3 with no evidence it reads unknown — never no");
}

_resetSurfaceEventStampMemoForTest();
console.log(`✓ slack-surface-evidence: ${n} assertions passed`);
