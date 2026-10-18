import { defineChannel, POST } from "eve/channels";
import { verifySlackSignature } from "./slack-front.js";
import { slackSigningSecret } from "../setup/credentials.js";
import {
  commandFailureText,
  bindFrom,
  runOeCommand,
  oeSlash,
  parseSlackCommandText,
  resolvePartition,
  auditSurfaceModeFrom,
  getOperationalStore,
  admittedTenantsFromConfig,
  unadmittedTenantLog,
  UNADMITTED_TENANT_DROP_REASON,
  type BindableContext,
  type SurfaceBinding,
} from "@open-everywhere/core/agent/adapter-api.js";
import { slackTenantAdmission } from "./slack-tenant-fence.js";
import { slackAuthorIsMember, slackChannelFactsFor } from "./slack-events.js";
import { slackMode } from "./slack-identity.js";

function log(msg: string): void {
  console.log(`[open-everywhere:slack-commands] ${msg}`);
}

export const SLACK_COMMANDS_ROUTE = "/eve/v1/slack/commands";

function formField(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  return v && v.length > 0 ? v : undefined;
}

export interface SlashTrustFacts {
  readonly dmPartnerTrust?: "internal" | "external";
  readonly room?: { readonly extShared: boolean };
  readonly invokerMember?: true;
}

export type SlashTrustLeg = "person" | "room";

export function bindableForSlashCommand(params: URLSearchParams, invoker?: SlashTrustFacts, leg: SlashTrustLeg = "person"): BindableContext {
  const enterpriseId = formField(params, "enterprise_id");
  const room = invoker?.room && (leg === "room" || invoker.invokerMember === true) ? invoker.room : undefined;
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: {
            team_id: formField(params, "team_id") ?? "",
            channel_id: formField(params, "channel_id") ?? "",
            ...(enterpriseId ? { enterprise_id: enterpriseId } : {}),
            ...(invoker?.dmPartnerTrust ? { dm_partner_trust: invoker.dmPartnerTrust } : {}),
            ...(room ? { is_ext_shared: String(room.extShared), trust_checked: "true" } : {}),
          },
          principalId: formField(params, "user_id") ?? "",
          principalType: "slack-user",
        },
      },
    },
  };
}

const INVOKER_PROBE_MS = 1_500;

export async function slashInvokerDmTrust(
  params: URLSearchParams,
  probe: (userId: string, teamId: string | undefined) => Promise<boolean | undefined> = slackAuthorIsMember,
): Promise<{ readonly dmPartnerTrust?: "internal" | "external" }> {
  const userId = formField(params, "user_id");
  if (!userId || slackMode(undefined, formField(params, "channel_id")) !== "dm") return {};
  const member = await withinAckBudget(probe(userId, formField(params, "team_id")));
  return member === undefined ? {} : { dmPartnerTrust: member ? "internal" : "external" };
}

export type SlashRoomFacts = (channelId: string) => Promise<{ readonly channelType?: string; readonly extShared?: boolean; readonly trustChecked?: boolean }>;

export async function slashRoomVerdict(
  params: URLSearchParams,
  roomFacts: SlashRoomFacts = slackChannelFactsFor,
  probe: (userId: string, teamId: string | undefined) => Promise<boolean | undefined> = slackAuthorIsMember,
): Promise<SlashTrustFacts> {
  const channelId = formField(params, "channel_id");
  if (!channelId || slackMode(undefined, channelId) === "dm") return {};
  const userId = formField(params, "user_id");
  const [facts, member] = await Promise.all([
    withinAckBudget(roomFacts(channelId)),
    userId ? withinAckBudget(probe(userId, formField(params, "team_id"))) : Promise.resolve(undefined),
  ]);
  if (!facts || facts.trustChecked !== true || typeof facts.extShared !== "boolean") return {};
  if (facts.channelType !== "channel" && facts.channelType !== "group") return {};
  return { room: { extShared: facts.extShared }, ...(member === true ? { invokerMember: true as const } : {}) };
}

export async function slashTrustFacts(params: URLSearchParams): Promise<SlashTrustFacts> {
  return slackMode(undefined, formField(params, "channel_id")) === "dm" ? slashInvokerDmTrust(params) : slashRoomVerdict(params);
}

export function bindSlashCommand(params: URLSearchParams, facts: SlashTrustFacts): SurfaceBinding {
  const person = bindFrom(bindableForSlashCommand(params, facts, "person"));
  const room = bindFrom(bindableForSlashCommand(params, facts, "room"));
  return { ...person, roomTrust: room.trust };
}

async function withinAckBudget<T>(p: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), INVOKER_PROBE_MS);
  });
  try {
    return await Promise.race([p.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function auditCommandDropped(teamId: string | undefined, channelId: string | undefined, reason: string, enterpriseId?: string): Promise<void> {
  try {
    const bindable = {
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: teamId ?? "", channel_id: channelId ?? "" }, principalId: "", principalType: "slack-user" } } },
    } as BindableContext;
    const p = resolvePartition(bindable);
    await getOperationalStore().appendAudit({
      ts: new Date().toISOString(),
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      ...auditSurfaceModeFrom(bindable),
      action: "surface.wake_dropped",
      detail: { reason, door: "slash-command", channel: channelId ?? null, team: teamId ?? null, enterprise: enterpriseId ?? null },
    });
  } catch {
  }
}

function ephemeralResponse(text: string): Response {
  if (text.length === 0) return new Response(null, { status: 200 });
  return new Response(JSON.stringify({ response_type: "ephemeral", text }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export default defineChannel({
  routes: [
    POST(SLACK_COMMANDS_ROUTE, async (req, { attachSession, waitUntil }) => {
      const rawBody = await req.text();
      if (!verifySlackSignature(rawBody, req.headers, await slackSigningSecret())) {
        return new Response("unauthorized", { status: 401 });
      }

      const params = new URLSearchParams(rawBody);
      const teamId = formField(params, "team_id");

      const enterpriseId = formField(params, "enterprise_id");
      if (slackTenantAdmission(teamId, enterpriseId) === "unadmitted") {
        console.log(unadmittedTenantLog("slack", teamId, admittedTenantsFromConfig("slack"), enterpriseId));
        waitUntil(auditCommandDropped(teamId, formField(params, "channel_id"), UNADMITTED_TENANT_DROP_REASON, enterpriseId));
        return new Response(null, { status: 200 });
      }

      const command = formField(params, "command");
      const expected = oeSlash();
      if (command !== expected) {
        log(`unexpected slash command "${command ?? "?"}" hit the ${expected} route — check the Slack app's Slash Command config`);
        return ephemeralResponse(`This endpoint only handles "${expected}" — check your Slack app's Slash Command configuration.`);
      }

      const cmd = parseSlackCommandText(formField(params, "text"));
      const binding = bindSlashCommand(params, await slashTrustFacts(params));
      try {
        const reply = await runOeCommand(cmd, binding, { attachSession });
        return ephemeralResponse(reply);
      } catch (err) {
        log(`"${expected}" command failed softly: ${String(err)}`);
        return ephemeralResponse(commandFailureText(err));
      }
    }),
  ],
});
