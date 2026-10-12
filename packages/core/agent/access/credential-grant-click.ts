import { appendAudit } from "../audit/audit.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { deploymentOrg } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { getOperationalStore } from "../operational/provider.js";
import { approveCredentialGrant, declineCredentialGrant, type ApproveGrantOutcome, type GrantAuditStamps } from "./credential-grant-flow.js";
import { GRANT_MODE_WORDS, grantModePhrase, parseGrantCardActionId, type GrantCardAnswer } from "./credential-grant-card.js";
import { connectorDisplayName, grantActionPhrase, grantExpiryPhrase } from "./credential-grant-copy.js";
import { type CredentialGrantMode, type CredentialGrantRow } from "../operational/credential-grant-rows.js";

export const GRANT_CARD_CLICK_ACTION = "grant.card_click";

export interface GrantClicker {
  readonly platform: string;
  readonly tenant?: string;
  readonly nativeId: string;
}

export interface GrantClickResult {
  readonly outcome: "approved" | "declined" | "not-yours" | "gone" | "failed";
  readonly text: string;
}

export interface GrantClickInput extends GrantAuditStamps {
  readonly askId: string;
  readonly answer: GrantCardAnswer;
  readonly clicker: GrantClicker;
  readonly nowMs: number;
}

export async function resolveGrantCardClick(input: GrantClickInput): Promise<GrantClickResult> {
  let noted = false;
  const note = async (outcome: GrantClickResult["outcome"], failure?: GrantClickFailure): Promise<void> => {
    if (noted) return;
    noted = true;
    await noteClick(input, outcome, failure);
  };
  try {
    const store = getOperationalStore();
    const ask = await store.getCredentialGrantAsk(input.org, input.askId);
    const clickerKey = tryPrincipalKey(input.clicker.platform, input.clicker.tenant, input.clicker.nativeId);
    if (ask === null || clickerKey === undefined || ask.ownerPrincipalId !== clickerKey) {
      await note("not-yours");
      return { outcome: "not-yours", text: "That request is not yours to answer, or it is no longer open." };
    }

    if (input.answer === "decline") {
      const declined = await declineCredentialGrant(input, ask.id, clickerKey, input.nowMs);
      await note(declined ? "declined" : "gone");
      return declined
        ? { outcome: "declined", text: "Declined. Nothing was granted, and the conversation that asked has been told." }
        : { outcome: "gone", text: "That request is no longer open — it was already answered, or it expired." };
    }

    const mode: CredentialGrantMode = input.answer;
    const approved = await approveCredentialGrant(input, ask.id, mode, clickerKey, input.nowMs);
    if (!approved.approved) {
      if (approved.reason === "not_pending_or_expired") {
        await note("gone");
        return { outcome: "gone", text: "That request is no longer open — it was already answered, or it expired." };
      }
      const prompted = approved.prompted === true;
      await note("failed", approved.reason === "consent_required" ? { linkDelivered: prompted, reason: approved.reason } : { reason: approved.reason });
      return { outcome: "failed", text: grantApproveFailureText(approved.reason, prompted) };
    }
    await note("approved");
    return { outcome: "approved", text: grantApprovedClickText(approved.grant, input.nowMs) };
  } catch (err) {
    console.log(`[open-everywhere:grant] card click for ask ${input.askId} did not resolve: ${String(err)}`);
    await note("failed", { reason: "click_threw" });
    return { outcome: "failed", text: "That could not be answered right now. Nothing changed, and nothing was granted. Try the button again." };
  }
}

export type GrantClickFailureReason = Exclude<GrantApproveFailure["reason"], "not_pending_or_expired"> | "click_threw";

interface GrantClickFailure {
  readonly reason: GrantClickFailureReason;
  readonly linkDelivered?: boolean;
}

export function grantApprovedClickText(grant: Pick<CredentialGrantRow, "connector" | "mcpTool" | "expiresAt">, nowMs: number): string {
  const action = grantActionPhrase(grant.connector, grant.mcpTool);
  return (
    `Approved. That conversation can ${action} with your ${connectorDisplayName(grant.connector)} account ${grantExpiryPhrase(grant.expiresAt, nowMs)}. ` +
    "Nothing else is granted. I will tell you the first time it is used."
  );
}

type GrantApproveFailure = Extract<ApproveGrantOutcome, { approved: false }>;

export function grantApproveFailureText(reason: GrantApproveFailure["reason"], prompted: boolean): string {
  switch (reason) {
    case "consent_required":
      return prompted
        ? "Not yet — I have just sent you the link to connect your account. Nothing has been granted."
        :
          "Your own account is not connected yet, and I couldn't send you the link to connect it. Nothing has been granted. " +
          "If you asked me to stop sending you direct messages, say here that I may message you again and press Approve once more. Otherwise ask your admin to check the setup.";
    case "catalogue_unreachable":
      return "Your account could not be reached just now, so nothing was granted and nothing was spent. Press Approve again in a moment.";
    case "tool_absent":
      return "Your account does not offer what they asked for, so there was nothing to lend. Nothing was granted, this request is closed, and the person who asked has been told.";
    case "frozen_args_unknown":
      return "That request pins values the tool does not take, so the grant could never have been spent. Nothing was granted, this request is closed, and the person who asked has been told.";
    case "owner_unresolvable":
      return "I can't find your account for this, so nothing was granted. Your admin needs to fix this; another tap won't help.";
    case "standing_unavailable":
      return (
        `A grant for ${GRANT_MODE_WORDS.standing} has to belong to a room, and this request did not come from one — ` +
        "so it would stop working the moment that conversation ends. Nothing was granted and nothing was spent. " +
        `Approve ${grantModePhrase("once")} or ${grantModePhrase("session")} on the same card instead.`
      );
    case "not_pending_or_expired":
    case "mint_refused":
      return "That could not be granted. Nothing changed, and nothing was granted. Ask them to raise it again.";
  }
}

interface SlackGrantClickPayload {
  readonly actions?: readonly { readonly action_id?: unknown }[];
  readonly user?: { readonly id?: unknown };
  readonly channel?: { readonly id?: unknown };
  readonly team?: { readonly id?: unknown };
}

export type GrantClickEphemeral = (channelId: string, userId: string, text: string) => Promise<void>;

async function bridgeEphemeral(channelId: string, userId: string, text: string): Promise<void> {
  const body = new URLSearchParams({ channel: channelId, text, user: userId });
  await bridgeSlackForm("chat.postEphemeral", body.toString());
}

export async function handleGrantCardClick(payload: unknown, deps: { readonly ephemeral?: GrantClickEphemeral } = {}): Promise<boolean> {
  const p = payload as SlackGrantClickPayload | null | undefined;
  const first = p?.actions?.[0];
  const actionId = typeof first?.action_id === "string" ? first.action_id : undefined;
  const parsed = parseGrantCardActionId(actionId);
  if (parsed === undefined) return false;
  const answer = deps.ephemeral ?? bridgeEphemeral;
  try {
    const clickerId = typeof p?.user?.id === "string" ? p.user.id : undefined;
    const channelId = typeof p?.channel?.id === "string" ? p.channel.id : undefined;
    const teamId = typeof p?.team?.id === "string" ? p.team.id : undefined;
    if (clickerId === undefined || channelId === undefined) {
      console.error(`[open-everywhere:grant] malformed grant click "${String(actionId)}" — no user or channel; ignoring`);
      return true;
    }
    const result = await resolveGrantCardClick({
      answer: parsed.answer,
      askId: parsed.askId,
      clicker: { nativeId: clickerId, platform: "slack", ...(teamId === undefined ? {} : { tenant: teamId }) },
      nowMs: Date.now(),
      org: deploymentOrg(),
      platform: "slack",
      surface: channelId,
      workspace: teamId ?? "unknown",
    });
    await answer(channelId, clickerId, result.text).catch((err: unknown) => {
      console.error(`[open-everywhere:grant] grant click answer failed to post: ${String(err)}`);
    });
    return true;
  } catch (err) {
    console.error(`[open-everywhere:grant] grant click "${String(actionId)}" did not resolve: ${String(err)}`);
    return true;
  }
}

async function noteClick(input: GrantClickInput, outcome: GrantClickResult["outcome"], failure?: GrantClickFailure): Promise<void> {
  try {
    await appendAudit({
      action: GRANT_CARD_CLICK_ACTION,
      detail: {
        answer: input.answer,
        askId: input.askId,
        clicker: input.clicker.nativeId,
        outcome,
        ...(failure === undefined ? {} : { reason: failure.reason }),
        ...(failure?.linkDelivered === undefined ? {} : { linkDelivered: failure.linkDelivered }),
      },
      org: input.org,
      platform: input.platform,
      workspace: input.workspace,
      ...(input.surface === undefined ? {} : { surface: input.surface }),
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] ${GRANT_CARD_CLICK_ACTION} row was not written: ${String(err)}`);
  }
}
