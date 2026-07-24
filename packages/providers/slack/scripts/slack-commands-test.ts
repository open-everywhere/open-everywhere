import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { RouteHandlerArgs } from "eve/channels";

let n = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  n++;
}

{
  const { default: slackCommandsChannel } = await import("../agent/channels/slack-commands.js");
  const routeDef = (
    slackCommandsChannel as unknown as {
      routes: readonly { method: string; path: string; handler: (req: Request, args: RouteHandlerArgs) => Promise<Response> }[];
    }
  ).routes[0];
  ok(routeDef.method === "POST" && routeDef.path === "/eve/v1/slack/commands", "slack-commands mounts POST /eve/v1/slack/commands");

  const call = (req: Request) => routeDef.handler(req, {} as RouteHandlerArgs);

  function slackSignature(secret: string, timestamp: string, body: string): string {
    return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  }
  function slackRequest(body: string, opts: { timestamp?: string; signature?: string; noHeaders?: boolean } = {}): Request {
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    if (!opts.noHeaders) {
      const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
      headers.set("x-slack-request-timestamp", timestamp);
      headers.set("x-slack-signature", opts.signature ?? "v0=0000000000000000000000000000000000000000000000000000000000000000");
    }
    return new Request("https://example.test/eve/v1/slack/commands", { method: "POST", headers, body });
  }

  const helpBody = "command=%2Foe&text=help&team_id=T1&channel_id=C1&user_id=U1";
  const secret = "test-signing-secret";

  const prevSecret = process.env.SLACK_SIGNING_SECRET;
  delete process.env.SLACK_SIGNING_SECRET;

  {
    const res = await call(slackRequest(helpBody, { timestamp: String(Math.floor(Date.now() / 1000)) }));
    ok(res.status === 401, "no SLACK_SIGNING_SECRET configured -> 401 (fail-closed)");
  }

  process.env.SLACK_SIGNING_SECRET = secret;

  {
    const res = await call(slackRequest(helpBody, { noHeaders: true }));
    ok(res.status === 401, "missing signature headers -> 401");
  }
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await call(slackRequest(helpBody, { timestamp, signature: "v0=not-a-real-signature" }));
    ok(res.status === 401, "a bad signature -> 401");
  }
  {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const sig = slackSignature(secret, staleTimestamp, helpBody);
    const res = await call(slackRequest(helpBody, { timestamp: staleTimestamp, signature: sig }));
    ok(res.status === 401, "a stale (>5min) timestamp -> 401 even with a correctly-computed signature");
  }
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, helpBody);
    const tampered = helpBody.replace("help", "clear");
    const res = await call(slackRequest(tampered, { timestamp, signature: sig }));
    ok(res.status === 401, "a body tampered with after signing -> 401");
  }
  {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, helpBody);
    const res = await call(slackRequest(helpBody, { timestamp, signature: sig }));
    ok(res.status === 200, "a validly-signed /oe help request succeeds");
    const json = (await res.json()) as { response_type: string; text: string };
    ok(json.response_type === "ephemeral", 'response_type is "ephemeral" — only the invoker sees it');
    ok(json.text.includes("/oe help"), "the ephemeral text is the rendered help");
  }
  {
    const statusBody = "command=%2Foe&text=status&team_id=T1&channel_id=C1&user_id=U1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, statusBody);
    const res = await call(slackRequest(statusBody, { timestamp, signature: sig }));
    const json = (await res.json()) as { text: string };
    ok(json.text.includes("Open Everywhere"), "a validly-signed /oe status request answers with deploy info");
  }
  {
    const otherBody = "command=%2Fother&text=&team_id=T1&channel_id=C1&user_id=U1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = slackSignature(secret, timestamp, otherBody);
    const res = await call(slackRequest(otherBody, { timestamp, signature: sig }));
    ok(res.status === 200, "a differently-named slash command still gets a clean 200 (not a crash)");
    const json = (await res.json()) as { text: string };
    ok(json.text.includes("/oe"), "the response explains this endpoint only handles /oe");
  }

  if (prevSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = prevSecret;
}


console.log(`\n✓ slack-commands: ${n} assertions passed (mount path + signature gate matrix + signed /oe responses)`);
