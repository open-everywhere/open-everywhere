process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildFrontHandler, classifyEnvelope, ThreadFifo } from "../agent/channels/slack-front.js";
import { confirmSlackDeactivation, parseSlackUserDeactivation, type SlackUserDeactivation } from "../agent/channels/slack-offboarding.js";
import type { SlackEventEnvelope } from "../agent/channels/slack-events.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const SECRET = "shhh-signing-secret";
const NOW_MS = 1768685440000;
const OUR = "T0ACME";
const PARTNER = "T0PARTNER";

function envelope(user: Record<string, unknown>, extra: Record<string, unknown> = {}): SlackEventEnvelope {
  return { type: "event_callback", team_id: OUR, event_id: `Ev_${String(user["id"])}`, event: { type: "user_change", user }, ...extra } as SlackEventEnvelope;
}

{
  ok(classifyEnvelope(JSON.stringify(envelope({ id: "U1" })), "application/json").kind === "user-change", "classify: a user_change event is ours, never forwarded to eve");
  const d = parseSlackUserDeactivation(envelope({ id: "U0HAZEL", team_id: OUR, deleted: true }));
  ok(d?.userId === "U0HAZEL" && d.deliveringTeamId === OUR && d.userTeamId === OUR, "parse: a deleted user is a deactivation report, with the delivering and the account workspace");
  ok(parseSlackUserDeactivation(envelope({ id: "U0HAZEL", team_id: OUR, deleted: false, profile: { title: "New title" } })) === undefined, "parse: a profile edit is NOT a deactivation");
  const partner = parseSlackUserDeactivation(envelope({ id: "U0EXT", team_id: PARTNER, deleted: true }));
  ok(partner?.deliveringTeamId === OUR && partner.userTeamId === PARTNER, "parse: a Slack-Connect partner's user keeps ITS OWN workspace — core's same-workspace gate then refuses it");
  ok(parseSlackUserDeactivation({ type: "event_callback", event: { type: "user_change", user: { id: "U1", deleted: true } } } as SlackEventEnvelope) === undefined, "parse: an envelope that names no delivering workspace is not a report");
}

{
  const info = (body: Record<string, unknown>) => async () => body;
  const yes = await confirmSlackDeactivation("U0HAZEL", OUR, info({ ok: true, user: { id: "U0HAZEL", team_id: OUR, deleted: true } }));
  ok(yes.deactivated, "confirm: Slack says deleted, in our workspace → confirmed");
  const guest = await confirmSlackDeactivation("U0GUEST", OUR, info({ ok: true, user: { id: "U0GUEST", team_id: OUR, deleted: true, is_restricted: true, is_ultra_restricted: true } }));
  ok(guest.deactivated, "🔴 confirm: a deactivated GUEST of our workspace is confirmed exactly like a member — never spared");
  const active = await confirmSlackDeactivation("U0HAZEL", OUR, info({ ok: true, user: { id: "U0HAZEL", team_id: OUR, deleted: false } }));
  ok(!active.deactivated && active.reason.includes("active"), "confirm: Slack says active (a reactivation, or a forged report) → not confirmed");
  const elsewhere = await confirmSlackDeactivation("U0HAZEL", OUR, info({ ok: true, user: { id: "U0HAZEL", team_id: PARTNER, deleted: true } }));
  ok(!elsewhere.deactivated && elsewhere.reason.includes(PARTNER), "confirm: an account Slack places in ANOTHER workspace → not confirmed");
  const scope = await confirmSlackDeactivation("U0HAZEL", OUR, info({ ok: false, error: "missing_scope" }));
  ok(!scope.deactivated && scope.reason.includes("users:read"), "confirm: a missing scope refuses and names the scope to grant");
  const none = await confirmSlackDeactivation("U0HAZEL", OUR, async () => undefined);
  ok(!none.deactivated, "confirm: no answer is not a yes");
}

function mkReq(body: string, signed = true): Request {
  const ts = String(Math.floor(NOW_MS / 1000));
  const sig = signed ? `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}` : "v0=deadbeef";
  return new Request("https://oe.test/eve/v1/slack", {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

async function drive(env: SlackEventEnvelope, signed = true): Promise<{ status: number; routed: SlackUserDeactivation[]; forwarded: number }> {
  const routed: SlackUserDeactivation[] = [];
  let forwarded = 0;
  const pending: Promise<unknown>[] = [];
  const handler = buildFrontHandler(
    () => {
      forwarded++;
      return Promise.resolve(new Response("inner"));
    },
    {
      signingSecret: SECRET,
      now: () => NOW_MS,
      markEventSeen: async () => true,
      getBotIdentity: async () => ({ userId: "UBOT", botId: "B_OE_SELF" }),
      fifo: new ThreadFifo(() => {}),
      routeUserDeactivation: async (d) => {
        routed.push(d);
        return { kind: "refused", reason: "test" };
      },
    },
  );
  const res = await handler(mkReq(JSON.stringify(env), signed), {
    from: () => ({ send: async () => ({}) }),
    to: () => ({ send: async () => ({}) }),
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
  } as never);
  await Promise.all(pending);
  return { status: res.status, routed, forwarded };
}

{
  const deleted = await drive(envelope({ id: "U0HAZEL", team_id: OUR, deleted: true }));
  ok(deleted.status === 200, `route: a signed user_change is acked 200 (got ${deleted.status})`);
  ok(deleted.routed.length === 1 && deleted.routed[0]!.userId === "U0HAZEL" && deleted.routed[0]!.deliveringTeamId === OUR, "🔴 route: a deleted user reaches the offboarding lever, with the signed envelope's workspace");
  ok(deleted.forwarded === 0, "route: the event is ours — not forwarded to eve");

  const edit = await drive(envelope({ id: "U0HAZEL", team_id: OUR, deleted: false }));
  ok(edit.status === 200 && edit.routed.length === 0, "route: a profile edit is acked and reaches nothing");

  const forged = await drive(envelope({ id: "U0HAZEL", team_id: OUR, deleted: true }), false);
  ok(forged.status === 401 && forged.routed.length === 0, "🔴 route: an UNSIGNED deactivation is refused 401 and reaches nothing");
}

console.log(`✓ slack-offboarding: ${n} assertions passed`);
