import { postArm } from "../channels/post-arms.js";
import { GRANT_MODE_WORDS, grantModeIsBroader, type GrantApproveGate } from "./credential-grant-card.js";
import { postReply, type ReplyTarget } from "../channels/reply-post.js";
import { credentialGrantDisclosureLine, type CredentialGrantAskRow, type CredentialGrantMode, type CredentialGrantRow } from "../operational/credential-grant-rows.js";

function log(line: string): void {
  console.log(`[open-everywhere:grant] ${line}`);
}

export type GrantResolution =
  | { readonly kind: "approved"; readonly grant: CredentialGrantRow; readonly askedMode: CredentialGrantMode }
  | { readonly kind: "declined" }
  | { readonly kind: "expired" }
  | { readonly kind: "refused"; readonly gate: GrantApproveGate };

export function parseGrantRequesterTarget(raw: string | undefined): ReplyTarget | undefined {
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

export function grantResolutionText(ask: CredentialGrantAskRow, resolution: GrantResolution): string {
  const what = `\`${ask.verb}\` on \`${ask.resource}\``;
  switch (resolution.kind) {
    case "approved": {
      const toolName = resolution.grant.toolName;
      if (toolName === undefined) {
        return [
          `${ask.ownerSlug} approved the credential grant for ${what} (${GRANT_MODE_WORDS[resolution.grant.mode]}).`,
          ...breadthLines(ask, resolution.grant, resolution.askedMode),
          credentialGrantDisclosureLine(resolution.grant),
        ].join("\n");
      }
      return [
        `${ask.ownerSlug} approved the credential grant for ${what}.`,
        `This conversation now holds the tool \`${toolName}\` (${GRANT_MODE_WORDS[resolution.grant.mode]}), and it expires ${resolution.grant.expiresAt}.`,
        ...breadthLines(ask, resolution.grant, resolution.askedMode),
        credentialGrantDisclosureLine(resolution.grant),
      ].join("\n");
    }
    case "declined":
      return `${ask.ownerSlug} declined the credential grant for ${what}. Nothing was granted and no tool is mounted. Do not ask again for the same thing — find another way, or ask the room.`;
    case "expired":
      return [
        `The credential grant request for ${what} expired with no answer from ${ask.ownerSlug}.`,
        `Nothing was granted and no tool is mounted. ${ask.ownerSlug} did not decline — the request simply timed out.`,
        "You can ask again if it is still needed.",
      ].join("\n");
    case "refused":
      return [
        `${ask.ownerSlug} approved the credential grant for ${what}, but it could not be minted.`,
        resolution.gate === "tool_absent"
          ? `Their ${ask.connector} connection publishes no tool by that name, so there was nothing to lend.`
          : `The ${ask.connector} tool does not take the arguments the request fixed, so the grant could never have been spent.`,
        "Nothing was granted and no tool is mounted. Check the tool name and the arguments against the connection, then ask again.",
      ].join("\n");
  }
}

function breadthLines(ask: CredentialGrantAskRow, grant: CredentialGrantRow, askedMode: CredentialGrantMode): readonly string[] {
  if (!grantModeIsBroader(grant.mode, askedMode)) return [];
  return [
    `${ask.ownerSlug} granted MORE than was asked: the request was for ${GRANT_MODE_WORDS[askedMode]}, and the grant is for ${GRANT_MODE_WORDS[grant.mode]}.`,
  ];
}

export type GrantNoticeOutcome = "sent" | "no_target" | "failed";

export async function postGrantResolution(ask: CredentialGrantAskRow, resolution: GrantResolution): Promise<GrantNoticeOutcome> {
  const target = parseGrantRequesterTarget(ask.requesterTarget);
  if (target === undefined) return "no_target";
  try {
    await postReply(target, grantResolutionText(ask, resolution));
    return "sent";
  } catch (err) {
    log(`resolution notice for ask ${ask.id} could not be posted: ${String(err)}`);
    return "failed";
  }
}
