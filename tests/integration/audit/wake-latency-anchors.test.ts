import { afterAll, expect, test } from "vitest";
import {
  bootAgent,
  installSlackWebApiStub,
  readAuditRows,
  registerScript,
  slackMentionWake,
  slackTs,
  SLACK_TEAM_ID,
  waitFor,
  type SlackWebApiStub,
} from "../harness";

const SLACK_WINDOW_CHANNEL_ID = "C0EXCHAN003";

const BOT_USER_ID = "U0BOTSELF01";
const BOT_ID = "B0BOTSELF01";
const MEMBER_USER_ID = "U0MEMBER001";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

let stub: SlackWebApiStub | undefined;
let tsCounter = 700;

function userInfo(id: string, name: string): Record<string, unknown> {
  return { ok: true, user: { id, name, team_id: SLACK_TEAM_ID, real_name: name, profile: { display_name: name, real_name: name } } };
}

async function armSeams(): Promise<void> {
  await bootAgent();
  const { loadDomains } = await import("../../../agent/memory/config/domains");
  const key = `slack/${SLACK_TEAM_ID}/${SLACK_WINDOW_CHANNEL_ID}`;
  const home = loadDomains().find((d) => (d.reach ?? []).includes(key));
  expect(home, `${key} is in no domain — a mention there cannot reach a window seat`).toBeDefined();
  expect(home?.mode, `${home?.name} is not the cross-surface window domain this file was written against — the fixture moved`).toBe("unified");

  if (stub) return;
  const installed = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: SLACK_TEAM_ID };
      case "users.info": {
        const user = params.get("user") ?? "";
        return user === BOT_USER_ID ? userInfo(BOT_USER_ID, "open-everywhere") : userInfo(user, "member");
      }
      case "conversations.info":
        return {
          ok: true,
          channel: {
            id: params.get("channel"),
            name: "it-ope1716",
            is_channel: true,
            is_private: false,
            is_ext_shared: false,
            is_org_shared: false,
            is_shared: false,
            is_pending_ext_shared: false,
            num_members: 9,
          },
        };
      case "conversations.history":
        return { ok: true, messages: [] };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      default:
        return undefined;
    }
  });
  stub = installed;
  cleanups.push(() => installed.uninstall());
}

function detailOf(row: { detail?: unknown } | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

test("a real Slack mention writes the ingress anchor and the turn-start anchor, and they bracket the reply", async () => {
  await armSeams();
  const sinceIso = new Date(Date.now() - 5_000).toISOString();
  const vendorMs = Date.now() - 4_000;
  const ts = slackTs(vendorMs, (tsCounter += 1));
  registerScript({ parent: [{ say: "the anchors are in place" }, { say: "ack" }] });

  const res = await slackMentionWake({
    channelId: SLACK_WINDOW_CHANNEL_ID,
    userId: MEMBER_USER_ID,
    text: `<@${BOT_USER_ID}> ope1716 anchors`,
    ts,
    eventId: `EvAnch1716${ts.replace(".", "")}`,
  });
  expect(res.status, `the Slack front refused the mention: ${res.body.slice(0, 200)}`).toBe(200);

  const ingress = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["wake.ingress"], sinceIso });
    return rows.find((r) => detailOf(r).surfaceKey === `slack/${SLACK_TEAM_ID}/${SLACK_WINDOW_CHANNEL_ID}`);
  }, "a wake.ingress audit row for the driven mention");
  const ingressDetail = detailOf(ingress);
  const wakeId = ingressDetail.wakeId as string;
  expect(typeof wakeId, "the ingress row carries the wake id it must be joined on").toBe("string");
  expect(ingressDetail.vendorTsSource, "the Slack front door read the VENDOR's clock, not its own").toBe("slack-ts");
  const drivenSecondMs = Math.floor(vendorMs / 1000) * 1000;
  const anchorMs = Date.parse(ingressDetail.vendorTs as string);
  expect(anchorMs, "the vendor anchor is not EARLIER than the ts we drove").toBeGreaterThanOrEqual(drivenSecondMs);
  expect(anchorMs, "the vendor anchor is the TRIGGER's own ts, not a clock read at ingress ~4 s later").toBeLessThan(drivenSecondMs + 1_000);
  expect(ingressDetail.vendorToIngressMs, "the vendor→ingress gap is derived from the driven ts, so it is at least the 4 s we backdated").toBeGreaterThanOrEqual(3_500);
  expect(JSON.stringify(ingress), "the ingress row carries ids and timestamps only — never the message text").not.toContain("ope1716 anchors");

  const turnStart = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["wake.turn_start"], sinceIso });
    return rows.find((r) => detailOf(r).wakeId === wakeId);
  }, `a wake.turn_start audit row joined to wake ${wakeId}`);
  const startDetail = detailOf(turnStart);
  expect(typeof startDetail.turnId, "the turn-start row names the turn it anchors").toBe("string");
  expect(typeof startDetail.sessionId, "the turn-start row names the session").toBe("string");

  const vendorAt = Date.parse(ingressDetail.vendorTs as string);
  const ingressAt = Date.parse(ingressDetail.ingressTs as string);
  const turnStartAt = Date.parse(startDetail.turnStartTs as string);
  expect(vendorAt, "vendor event ≤ ingress receipt").toBeLessThanOrEqual(ingressAt);
  expect(ingressAt, "ingress receipt ≤ turn start").toBeLessThanOrEqual(turnStartAt);
  expect(Date.parse(ingress.ts), "the ingress row's `ts` is its ingress instant").toBe(ingressAt);
  expect(Date.parse(turnStart.ts), "the turn-start row's `ts` is its turn-start instant").toBe(turnStartAt);
});
