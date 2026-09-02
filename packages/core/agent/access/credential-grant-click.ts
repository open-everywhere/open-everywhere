import { appendAudit } from "../audit/audit.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { deploymentOrg } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { getOperationalStore } from "../operational/provider.js";
import { approveCredentialGrant, declineCredentialGrant, type ApproveGrantOutcome, type GrantAuditStamps } from "./credential-grant-flow.js";
import { parseGrantCardActionId, type GrantCardAnswer } from "./credential-grant-card.js";
import { type CredentialGrantMode } from "../operational/credential-grant-rows.js";

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
  try {
    const store = getOperationalStore();
    const ask = await store.getCredentialGrantAsk(input.org, input.askId);
    const clickerKey = tryPrincipalKey(input.clicker.platform, input.clicker.tenant, input.clicker.nativeId);
    if (ask === null || clickerKey === undefined || ask.ownerPrincipalId !== clickerKey) {
      await noteClick(input, "not-yours");
      return { outcome: "not-yours", text: "That request is not yours to answer, or it is no longer open." };
    }

    if (input.answer === "decline") {
      const declined = await declineCredentialGrant(input, ask.id, clickerKey, input.nowMs);
      await noteClick(input, declined ? "declined" : "gone");
      return declined
        ? { outcome: "declined", text: "Declined. Nothing was granted, and the conversation that asked has been told." }
        : { outcome: "gone", text: "That request is no longer open — it was already answered, or it expired." };
    }

    const mode: CredentialGrantMode = input.answer;
    const approved = await approveCredentialGrant(input, ask.id, mode, clickerKey, input.nowMs);
    if (!approved.approved) {
      await noteClick(input, approved.reason === "not_pending_or_expired" ? "gone" : "failed");
      if (approved.reason === "not_pending_or_expired") {
        return { outcome: "gone", text: "That request is no longer open — it was already answered, or it expired." };
      }
      return { outcome: "failed", text: approveFailureText(approved.reason, approved.prompted === true) };
    }
    await noteClick(input, "approved");
    const named = approved.grant.toolName === undefined ? "the granted tool" : `\`${approved.grant.toolName}\``;
    return {
      outcome: "approved",
      text:
        `Approved. That conversation can now run ${named} on \`${approved.grant.resource}\` with your credential, ` +
        `until ${approved.grant.expiresAt}. It grants nothing else. You get a message the first time it is used.`,
    };
  } catch (err) {
    console.log(`[open-everywhere:grant] card click for ask ${input.askId} did not resolve: ${String(err)}`);
    return { outcome: "failed", text: "That could not be answered right now. Nothing changed, and nothing was granted. Try the button again." };
  }
}

type GrantApproveFailure = Extract<ApproveGrantOutcome, { approved: false }>;

function approveFailureText(reason: GrantApproveFailure["reason"], prompted: boolean): string {
  switch (reason) {
    case "consent_required":
      return prompted
        ? "Connect your own account first — I have sent you the link in a separate message. Open it, then press Approve here again. Nothing has been granted and nothing has been spent."
        : "Your own account is not connected yet, and this deployment could not send you the link to connect it. Nothing has been granted. Ask an operator to check the connector setup.";
    case "catalogue_unreachable":
      return "Your account could not be reached just now, so nothing was granted and nothing was spent. Press Approve again in a moment.";
    case "tool_absent":
      return "Your connection publishes no tool by that name, so there was nothing to lend. Nothing was granted, this request is closed, and the person who asked has been told.";
    case "frozen_args_unknown":
      return "That request fixes arguments the tool does not take, so the grant could never have been spent. Nothing was granted, this request is closed, and the person who asked has been told.";
    case "owner_unresolvable":
      return "This deployment cannot resolve your account for that connector, so nothing could ever be spent under the grant. Nothing was granted. An operator fixes this, not another tap.";
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

async function noteClick(input: GrantClickInput, outcome: string): Promise<void> {
  try {
    await appendAudit({
      action: GRANT_CARD_CLICK_ACTION,
      detail: { answer: input.answer, askId: input.askId, clicker: input.clicker.nativeId, outcome },
      org: input.org,
      platform: input.platform,
      workspace: input.workspace,
      ...(input.surface === undefined ? {} : { surface: input.surface }),
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] ${GRANT_CARD_CLICK_ACTION} row was not written: ${String(err)}`);
  }
}
