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

export function detectAddressedLinkClaim(text: string | undefined, addressTokens: readonly string[] = []): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const bare = detectLinkClaim(trimmed);
  if (bare) return bare;
  const rest = stripLeadingAddress(trimmed, addressTokens);
  return rest === undefined ? undefined : detectLinkClaim(rest);
}

const ADDRESS_SEP = String.raw`[\s,:]+`;

function stripLeadingAddress(text: string, addressTokens: readonly string[]): string | undefined {
  const mention = new RegExp(String.raw`^(?:<@[!&]?[^>\s]+>|@[\p{L}\p{N}][\p{L}\p{N}_.-]*)${ADDRESS_SEP}`, "u");
  const m = mention.exec(text);
  if (m) return text.slice(m[0].length);
  for (const tok of addressTokens) {
    const t = tok.trim();
    if (t.length < 2) continue;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s*");
    const re = new RegExp(String.raw`^${escaped}(?=$|[^\p{L}\p{N}_])${ADDRESS_SEP}`, "iu");
    const mm = re.exec(text);
    if (mm) return text.slice(mm[0].length);
  }
  return undefined;
}

export function linkClaimInstructions(code: string, ttlMinutes: number): string {
  return (
    `From your OTHER account, send me a message whose ENTIRE text is exactly this line and nothing ` +
    `else:\n\n    link ${code}\n\n` +
    `DM it to me if that account can DM me — a code is a secret, so I only take it in a one-to-one ` +
    `conversation where I have one. Where I have no DMs at all, @mention me or name-drop me in a ` +
    `comment instead; a bare, unaddressed line will not count. If you send it somewhere I cannot ` +
    `accept it, I will say so and the code stays good.\n\n` +
    `It is single-use and expires in ${ttlMinutes} minutes. When it lands I will answer that account ` +
    `with a SECOND code and come back HERE naming the account that claimed the first one. Give me the ` +
    `second code in this conversation to finish — that is what proves one person reads both. If a ` +
    `name you do not recognise comes back, deny it.`
  );
}
