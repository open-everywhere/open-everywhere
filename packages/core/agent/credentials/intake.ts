import { randomUUID } from "node:crypto";
import { slackForm } from "../channels/slack-events.js";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { storeDbSecret } from "./db-broker.js";

type PostFn = (method: string, body: string) => Promise<Record<string, unknown> | undefined>;

export const OE_SETKEY_ACTION_PREFIX = "oe_setkey:";
export const OE_SETKEY_MODAL_CALLBACK = "oe_setkey_modal";
export const SETKEY_INPUT_BLOCK = "oe_setkey_secret_block";
export const SETKEY_INPUT_ACTION = "oe_setkey_secret_input";

export const CREDENTIAL_INTAKE_TTL_MS = 15 * 60 * 1000;

export interface RequestCredentialIntakeInput {
  readonly org: string;
  readonly provider: string;
  readonly domain?: string;
  readonly ref: string;
  readonly requestedBy: string;
  readonly channelId: string;
  readonly threadTs?: string;
  readonly teamId?: string;
}

export interface CredentialIntakeDeps {
  readonly post?: PostFn;
  readonly now?: () => Date;
  readonly mintId?: () => string;
}

function intakeWhere(org: string, teamId: string | undefined, channelId: string): { org: string; platform: string; workspace: string; surface: string } {
  return { org, platform: "slack", workspace: teamId || "unknown", surface: channelId };
}

export async function requestCredentialIntake(
  input: RequestCredentialIntakeInput,
  deps: CredentialIntakeDeps = {},
): Promise<{ id: string; messageTs?: string }> {
  const post = deps.post ?? slackForm;
  const now = (deps.now ?? (() => new Date()))();
  const id = (deps.mintId ?? randomUUID)();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CREDENTIAL_INTAKE_TTL_MS).toISOString();

  await getOperationalStore().addCredentialIntake({
    org: input.org,
    id,
    ref: input.ref,
    provider: input.provider,
    ...(input.domain ? { domain: input.domain } : {}),
    requestedBy: input.requestedBy,
    channelId: input.channelId,
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    createdAt,
    expiresAt,
  });

  const forWhom = input.domain ? `*${input.provider}* key for *${input.domain}*` : `*${input.provider}* key`;
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `🔐 A ${forWhom} is needed. Only <@${input.requestedBy}> can enter it — it's stored encrypted and the agent never sees it.` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: `${OE_SETKEY_ACTION_PREFIX}${id}`,
          value: input.org,
          style: "primary",
          text: { type: "plain_text", text: "Set API key" },
        },
      ],
    },
  ];
  const body = new URLSearchParams();
  body.set("channel", input.channelId);
  if (input.threadTs) body.set("thread_ts", input.threadTs);
  body.set("text", "A credential is needed — click “Set API key” to enter it securely.");
  body.set("blocks", JSON.stringify(blocks));
  const res = await post("chat.postMessage", body.toString());
  const messageTs = res?.ok === true && typeof res.ts === "string" ? res.ts : undefined;

  await appendAudit({
    ...intakeWhere(input.org, input.teamId, input.channelId),
    principalId: input.requestedBy,
    action: "credential.intake_requested",
    detail: { id, ref: input.ref, provider: input.provider, ...(input.domain ? { domain: input.domain } : {}) },
  });

  return { id, ...(messageTs ? { messageTs } : {}) };
}

interface SetKeyClickPayload {
  readonly trigger_id?: unknown;
  readonly actions?: readonly { readonly action_id?: unknown; readonly value?: unknown }[];
  readonly user?: { readonly id?: unknown };
  readonly channel?: { readonly id?: unknown };
}

async function ephemeral(post: PostFn, channelId: string, userId: string, text: string): Promise<void> {
  const body = new URLSearchParams();
  body.set("channel", channelId);
  body.set("user", userId);
  body.set("text", text);
  await post("chat.postEphemeral", body.toString());
}

export async function handleSetKeyClick(payload: unknown, deps: CredentialIntakeDeps = {}): Promise<boolean> {
  const p = payload as SetKeyClickPayload | null | undefined;
  const action = p?.actions?.[0];
  const actionId = typeof action?.action_id === "string" ? action.action_id : undefined;
  if (actionId === undefined || !actionId.startsWith(OE_SETKEY_ACTION_PREFIX)) return false;

  const post = deps.post ?? slackForm;
  try {
    const now = (deps.now ?? (() => new Date()))();
    const id = actionId.slice(OE_SETKEY_ACTION_PREFIX.length);
    const org = typeof action?.value === "string" ? action.value : undefined;
    const clickerId = typeof p?.user?.id === "string" ? p.user.id : undefined;
    const channelId = typeof p?.channel?.id === "string" ? p.channel.id : undefined;
    const triggerId = typeof p?.trigger_id === "string" ? p.trigger_id : undefined;

    if (!org || !clickerId || !channelId || !triggerId || !id) {
      console.error(`[open-everywhere:credentials] malformed oe_setkey click "${actionId}" — missing org/user/channel/trigger; ignoring`);
      return true;
    }

    const intake = await getOperationalStore().getCredentialIntake(org, id);
    if (!intake) {
      await ephemeral(post, channelId, clickerId, "This credential request is no longer available (it may have been used or aged out).");
      return true;
    }
    if (intake.usedAt) {
      await ephemeral(post, channelId, clickerId, "This credential request has already been used.");
      return true;
    }
    if (Date.parse(intake.expiresAt) <= now.getTime()) {
      await ephemeral(post, channelId, clickerId, "This credential request has expired — please ask for a new one.");
      return true;
    }
    if (clickerId !== intake.requestedBy) {
      await ephemeral(post, channelId, clickerId, "This credential request isn’t yours to complete.");
      return true;
    }

    const title = `Set ${intake.provider} key`.slice(0, 24);
    const view = {
      type: "modal",
      callback_id: OE_SETKEY_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ org, id, channelId }),
      title: { type: "plain_text", text: title },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: intake.domain ? `*${intake.provider}* key for *${intake.domain}*. Stored encrypted; the agent never sees it.` : `*${intake.provider}* key. Stored encrypted; the agent never sees it.` },
        },
        {
          type: "input",
          block_id: SETKEY_INPUT_BLOCK,
          label: { type: "plain_text", text: "API key" },
          element: { type: "plain_text_input", action_id: SETKEY_INPUT_ACTION, multiline: false },
        },
      ],
    };
    const body = new URLSearchParams();
    body.set("trigger_id", triggerId);
    body.set("view", JSON.stringify(view));
    const res = await post("views.open", body.toString());
    if (res?.ok !== true) {
      console.error(`[open-everywhere:credentials] views.open failed for intake ${id} (trigger may have expired)`);
    }
    return true;
  } catch (err) {
    console.error(`[open-everywhere:credentials] handleSetKeyClick failed softly for "${actionId}": ${String(err)}`);
    return true;
  }
}

interface SetKeyViewPayload {
  readonly type?: unknown;
  readonly user?: { readonly id?: unknown };
  readonly team?: { readonly id?: unknown };
  readonly view?: {
    readonly callback_id?: unknown;
    readonly private_metadata?: unknown;
    readonly state?: { readonly values?: Record<string, Record<string, { readonly value?: unknown }>> };
  };
}

export type SetKeyViewResult =
  | { readonly handled: false }
  | { readonly handled: true; readonly response?: Record<string, unknown> };

function inputError(message: string): { handled: true; response: Record<string, unknown> } {
  return { handled: true, response: { response_action: "errors", errors: { [SETKEY_INPUT_BLOCK]: message } } };
}

export async function handleSetKeyViewSubmission(payload: unknown, deps: CredentialIntakeDeps = {}): Promise<SetKeyViewResult> {
  const p = payload as SetKeyViewPayload | null | undefined;
  if (p?.type !== "view_submission") return { handled: false };
  const view = p.view;
  if (!view || view.callback_id !== OE_SETKEY_MODAL_CALLBACK) return { handled: false };

  const post = deps.post ?? slackForm;
  try {
    const now = (deps.now ?? (() => new Date()))();

    let meta: { org?: unknown; id?: unknown; channelId?: unknown };
    try {
      meta = JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : "{}");
    } catch {
      return inputError("This request could not be read — please start again.");
    }
    const org = typeof meta.org === "string" ? meta.org : undefined;
    const id = typeof meta.id === "string" ? meta.id : undefined;
    const channelId = typeof meta.channelId === "string" ? meta.channelId : undefined;
    const clickerId = typeof p.user?.id === "string" ? p.user.id : undefined;
    const teamId = typeof p.team?.id === "string" ? p.team.id : undefined;
    if (!org || !id || !clickerId) return inputError("This request is missing its identity — please start again.");

    const rawValue = view.state?.values?.[SETKEY_INPUT_BLOCK]?.[SETKEY_INPUT_ACTION]?.value;
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) return inputError("Enter the API key.");

    const store = getOperationalStore();
    const intake = await store.getCredentialIntake(org, id);
    if (!intake) return inputError("This credential request is no longer available.");
    if (clickerId !== intake.requestedBy) return inputError("This credential request isn’t yours to complete.");
    if (Date.parse(intake.expiresAt) <= now.getTime()) return inputError("This credential request has expired — please ask for a new one.");

    if (!(await store.consumeCredentialIntake(org, id, now.toISOString()))) {
      return inputError("This credential request was already used.");
    }

    try {
      await storeDbSecret({
        org,
        ref: intake.ref,
        plaintext: value,
        provider: intake.provider,
        ...(intake.domain ? { domain: intake.domain } : {}),
        createdBy: clickerId,
      });
    } catch (err) {
      console.error(`[open-everywhere:credentials] failed to store credential for ref "${intake.ref}": ${String(err)}`);
      return inputError("Could not store the credential — the server encryption key is missing or invalid. Ask an operator.");
    }

    await appendAudit({
      ...intakeWhere(org, teamId, channelId ?? intake.channelId),
      principalId: clickerId,
      action: "credential.stored",
      detail: { id, ref: intake.ref, provider: intake.provider, ...(intake.domain ? { domain: intake.domain } : {}) },
    });

    const confirmChannel = channelId ?? intake.channelId;
    const forWhom = intake.domain ? `*${intake.provider}* key for *${intake.domain}*` : `*${intake.provider}* key`;
    await ephemeral(post, confirmChannel, clickerId, `✅ Your ${forWhom} was stored securely. The agent never saw the value.`).catch(() => undefined);

    return { handled: true };
  } catch (err) {
    console.error(`[open-everywhere:credentials] handleSetKeyViewSubmission failed softly: ${String(err)}`);
    return inputError("Something went wrong storing the credential — please try again.");
  }
}
