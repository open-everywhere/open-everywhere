import { createHash, randomInt } from "node:crypto";

export const LINK_CODE_ALPHABET = "23456789ACDEFGHJKLMNPQRSTUVWXYZ";

export const LINK_CODE_LENGTH = 8;

export const LINK_CHALLENGE_TTL_MS = 10 * 60_000;

export function mintLinkCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) out += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  return out;
}

export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase(), "utf8").digest("hex");
}

const CLAIM_RE = new RegExp(String.raw`^link[\s:]+([${LINK_CODE_ALPHABET}]{${LINK_CODE_LENGTH}})$`, "i");

export function detectLinkClaim(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = CLAIM_RE.exec(text.trim());
  return m ? m[1]!.toUpperCase() : undefined;
}

export function linkClaimInstructions(code: string, ttlMinutes: number): string {
  return (
    `From your OTHER account, send me a message whose ENTIRE text is exactly this line and nothing ` +
    `else — @mention me or DM me from that account so the message is addressed to me (a bare, ` +
    `unaddressed line buried in a busy channel will not count):\n\n    link ${code}\n\n` +
    `It is single-use and expires in ${ttlMinutes} minutes. When it lands I will come back HERE, ` +
    `in this DM, and name the account that claimed it — the link is only written once you confirm ` +
    `that in this conversation. If a name you do not recognise comes back, deny it.`
  );
}
