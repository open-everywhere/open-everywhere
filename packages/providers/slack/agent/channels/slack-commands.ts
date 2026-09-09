import { defineChannel, POST } from "eve/channels";
import { verifySlackSignature } from "./slack-front.js";
import {
  bindFrom,
  runOeCommand,
  parseSlackCommandText,
  resolvePartition,
  getOperationalStore,
  admittedTenantsFromConfig,
  unadmittedTenantLog,
  UNADMITTED_TENANT_DROP_REASON,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";
import { slackTenantAdmission } from "./slack-tenant-fence.js";

function log(msg: string): void {
  console.log(`[open-everywhere:slack-commands] ${msg}`);
}

export const SLACK_COMMANDS_ROUTE = "/eve/v1/slack/commands";

function formField(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  return v && v.length > 0 ? v : undefined;
}

export function bindableForSlashCommand(params: URLSearchParams): BindableContext {
  const enterpriseId = formField(params, "enterprise_id");
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: {
            team_id: formField(params, "team_id") ?? "",
            channel_id: formField(params, "channel_id") ?? "",
            ...(enterpriseId ? { enterprise_id: enterpriseId } : {}),
          },
          principalId: formField(params, "user_id") ?? "",
          principalType: "slack-user",
        },
      },
    },
  };
}

async function auditCommandDropped(teamId: string | undefined, channelId: string | undefined, reason: string): Promise<void> {
  try {
    const p = resolvePartition({
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: teamId ?? "", channel_id: channelId ?? "" }, principalId: "", principalType: "slack-user" } } },
    } as BindableContext);
    await getOperationalStore().appendAudit({
      ts: new Date().toISOString(),
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      action: "surface.wake_dropped",
      detail: { reason, door: "slash-command", channel: channelId ?? null, team: teamId ?? null },
    });
  } catch {
  }
}

function ephemeralResponse(text: string): Response {
  return new Response(JSON.stringify({ response_type: "ephemeral", text }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export default defineChannel({
  routes: [
    POST(SLACK_COMMANDS_ROUTE, async (req, { attachSession, waitUntil }) => {
      const rawBody = await req.text();
      if (!verifySlackSignature(rawBody, req.headers, process.env.SLACK_SIGNING_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }

      const params = new URLSearchParams(rawBody);
      const teamId = formField(params, "team_id");

      if (slackTenantAdmission(teamId) === "unadmitted") {
        console.log(unadmittedTenantLog("slack", teamId!, admittedTenantsFromConfig("slack")));
        waitUntil(auditCommandDropped(teamId, formField(params, "channel_id"), UNADMITTED_TENANT_DROP_REASON));
        return new Response(null, { status: 200 });
      }

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
