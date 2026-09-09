import { defineChannel, POST } from "eve/channels";
import { verifySlackSignature } from "./slack-front.js";
import { bindFrom, runOeCommand, parseSlackCommandText, type BindableContext } from "@open-everywhere/core/agent/adapter-api.js";

function log(msg: string): void {
  console.log(`[open-everywhere:slack-commands] ${msg}`);
}

export const SLACK_COMMANDS_ROUTE = "/eve/v1/slack/commands";

function formField(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  return v && v.length > 0 ? v : undefined;
}

function bindableForSlashCommand(params: URLSearchParams): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: {
            team_id: formField(params, "team_id") ?? "",
            channel_id: formField(params, "channel_id") ?? "",
          },
          principalId: formField(params, "user_id") ?? "",
          principalType: "slack-user",
        },
      },
    },
  };
}

function ephemeralResponse(text: string): Response {
  return new Response(JSON.stringify({ response_type: "ephemeral", text }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export default defineChannel({
  routes: [
    POST(SLACK_COMMANDS_ROUTE, async (req, { attachSession }) => {
      const rawBody = await req.text();
      if (!verifySlackSignature(rawBody, req.headers, process.env.SLACK_SIGNING_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }

      const params = new URLSearchParams(rawBody);
      const command = formField(params, "command");
      if (command !== "/oe") {
        log(`unexpected slash command "${command ?? "?"}" hit the /oe route — check the Slack app's Slash Command config`);
        return ephemeralResponse('This endpoint only handles "/oe" — check your Slack app\'s Slash Command configuration.');
      }

      const cmd = parseSlackCommandText(formField(params, "text"));
      const binding = bindFrom(bindableForSlashCommand(params));
      try {
        const reply = await runOeCommand(cmd, binding, { attachSession });
        return ephemeralResponse(reply);
      } catch (err) {
        log(`"/oe" command failed softly: ${String(err)}`);
        return ephemeralResponse(`Couldn't complete that: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  ],
});
