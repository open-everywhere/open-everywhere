import { postArm } from "../channels/post-arms.js";
import { GRANT_MODE_WORDS, grantBorrowPhrase, grantModeIsBroader, grantModePhrase, type GrantApproveGate } from "./credential-grant-card.js";
import { connectorDisplayName, grantExpiryPhrase, grantOwnerPhrase, grantRevokedRoomText } from "./credential-grant-copy.js";
import { postReply, type ReplyTarget } from "../channels/reply-post.js";
import { credentialGrantDisclosureLine, type CredentialGrantAskRow, type CredentialGrantMode, type CredentialGrantRow } from "../operational/credential-grant-rows.js";

function log(line: string): void {
  console.log(`[open-everywhere:grant] ${line}`);
}

export type GrantResolution =
  | { readonly kind: "approved"; readonly grant: CredentialGrantRow; readonly askedMode: CredentialGrantMode }
  | { readonly kind: "declined" }
  | { readonly kind: "expired" }
  | { readonly kind: "refused"; readonly gate: GrantApproveGate }
  | { readonly kind: "revoked" };

function parseGrantRequesterTarget(raw: string | undefined): ReplyTarget | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const platform = (parsed as Record<string, unknown>).platform;
  if (typeof platform !== "string" || platform.length === 0) return undefined;
  if (postArm(platform)?.dispatchReply === undefined) return undefined;
  return parsed as ReplyTarget;
}

export function grantResolutionText(ask: CredentialGrantAskRow, resolution: GrantResolution, nowMs: number): string {
  const owner = grantOwnerPhrase(ask.ownerSlug);
  const ownerLead = sentenceLead(owner);
  const what = grantBorrowPhrase(ask);
  switch (resolution.kind) {
    case "approved": {
      const mounts = resolution.grant.toolName !== undefined;
      return [
        `${ownerLead} approved the credential grant — ${what}.`,
        `The grant is ${grantModePhrase(resolution.grant.mode)}, ${grantExpiryPhrase(resolution.grant.expiresAt, nowMs)}.`,
        ...(mounts ? ["The tool is in this conversation's tool list from the next turn."] : []),
        ...breadthLines(resolution.grant, resolution.askedMode, owner),
        credentialGrantDisclosureLine(resolution.grant),
      ].join("\n");
    }
    case "declined":
      return `${ownerLead} declined the credential grant — ${what}. Nothing was granted and no tool is mounted. Do not ask again for the same thing — find another way, or ask the room.`;
    case "expired":
      return [
        `The credential grant request — ${what} — expired with no answer from ${owner}.`,
        `Nothing was granted and no tool is mounted. ${ownerLead} did not decline — the request simply timed out.`,
        "You can ask again if it is still needed.",
      ].join("\n");
    case "revoked":
      return grantRevokedRoomText(ask.connector, ask.mcpTool);
    case "refused":
      return [
        `${ownerLead} approved the credential grant — ${what} — but it could not be minted.`,
        resolution.gate === "tool_absent"
          ? `Their ${connectorDisplayName(ask.connector)} connection publishes no tool by that name, so there was nothing to lend.`
          : `The ${connectorDisplayName(ask.connector)} tool does not take the arguments the request fixed, so the grant could never have been spent.`,
        "Nothing was granted and no tool is mounted. Check the tool name and the arguments against the connection, then ask again.",
      ].join("\n");
  }
}

function sentenceLead(owner: string): string {
  return owner === "the owner" ? "The owner" : owner;
}

function breadthLines(grant: CredentialGrantRow, askedMode: CredentialGrantMode, owner: string): readonly string[] {
  if (!grantModeIsBroader(grant.mode, askedMode)) return [];
  return [
    `${sentenceLead(owner)} granted MORE than was asked: the request was for ${GRANT_MODE_WORDS[askedMode]}, and the grant is for ${GRANT_MODE_WORDS[grant.mode]}.`,
  ];
}

export type GrantNoticeOutcome = "sent" | "no_target" | "failed";

export async function postGrantResolution(ask: CredentialGrantAskRow, resolution: GrantResolution, nowMs: number): Promise<GrantNoticeOutcome> {
  const target = parseGrantRequesterTarget(ask.requesterTarget);
  if (target === undefined) return "no_target";
  try {
    await postReply(target, grantResolutionText(ask, resolution, nowMs));
    return "sent";
  } catch (err) {
    log(`resolution notice for ask ${ask.id} could not be posted: ${String(err)}`);
    return "failed";
  }
}
