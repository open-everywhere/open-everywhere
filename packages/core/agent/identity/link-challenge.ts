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

const CLAIM_RE = new RegExp(String.raw`\blink[\s:]+([${LINK_CODE_ALPHABET}]{${LINK_CODE_LENGTH}})\b`, "i");

export function detectLinkClaim(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = CLAIM_RE.exec(text);
  return m ? m[1]!.toUpperCase() : undefined;
}

export function linkClaimInstructions(code: string, ttlMinutes: number): string {
  return (
    `Post this exact line from your OTHER account, on any surface I can read (a GitHub or Linear ` +
    `comment, a Slack/Discord message — it does not have to be a DM):\n\n    link ${code}\n\n` +
    `It is single-use and expires in ${ttlMinutes} minutes. When it lands I will come back HERE, ` +
    `in this DM, and name the account that claimed it — the link is only written once you confirm ` +
    `that in this conversation. If a name you do not recognise comes back, deny it.`
  );
}
